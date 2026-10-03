//! JSONL bridge to the production inference layer. Invoked by run.ts.
const std = @import("std");
const backend = @import("backend");
const contract = backend.contract;
const a = std.heap.c_allocator;
const Step = struct { id: []const u8, evidence: []const u8, turn: []const u8 };
const Scenario = struct { id: []const u8, steps: []const Step };
var stopping: std.atomic.Value(bool) = .init(false);

fn stop(_: std.posix.SIG) callconv(.c) void {
    stopping.store(true, .release);
}
fn emit(io: std.Io, value: anytype) !void {
    const text = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(text);
    try std.Io.File.stdout().writeStreamingAll(io, text);
    try std.Io.File.stdout().writeStreamingAll(io, "\n");
}
fn milliTimestamp(io: std.Io) i64 {
    return std.Io.Timestamp.now(io, .real).toMilliseconds();
}
pub fn main(init: std.process.Init) !void {
    backend.initIo(init.minimal);
    const io = init.io;
    const args = try init.minimal.args.toSlice(init.arena.allocator());
    if (args.len != 4) return error.Usage; // provider model plan.json
    var impl: backend.Backend = .{};
    impl.pool.config.provider = std.meta.stringToEnum(@TypeOf(impl.pool.config.provider), args[1]) orelse return error.InvalidProvider;
    impl.pool.config.model = args[2];
    impl.pool.config.timeout_ms = 60000;
    impl.pool.config.executable = init.environ_map.get("CORGI_EVAL_HARNESS");
    defer impl.deinit();
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = stop }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(.INT, &action, null);
    std.posix.sigaction(.TERM, &action, null);
    const bytes = try std.Io.Dir.cwd().readFileAlloc(io, args[3], a, .limited(4 * 1024 * 1024));
    defer a.free(bytes);
    const plan = try std.json.parseFromSlice([]const Scenario, a, bytes, .{});
    defer plan.deinit();
    for (plan.value) |scenario| {
        var context: contract.Context = .{};
        for (scenario.steps) |step| {
            if (stopping.load(.acquire)) return error.Cancelled;
            // Match the production evidence bound; never silently evaluate more context.
            if (step.evidence.len > 2048) return error.EvidenceTooLong;
            // As in production, history accompanies only a newly created conversation.
            var history: [4][]const u8 = undefined;
            for (context.recent[0..context.len], 0..) |*entry, i| history[i] = entry.text();
            const tag = contract.turnTag(step.turn);
            const live: backend.Input = .{ .provider = args[1], .turn = &tag, .evidence = step.evidence };
            var fresh = live;
            fresh.history = history[0..context.len];
            const json = try contract.content(a, live);
            defer a.free(json);
            const fresh_json = if (context.len > 0) try contract.content(a, fresh) else null;
            defer if (fresh_json) |value| a.free(value);
            const started = milliTimestamp(io);
            const response = impl.pool.infer(.{ .instructions = contract.instructions, .schema = contract.schema, .content = json, .fresh_content = fresh_json, .conversation = scenario.id }, &stopping) catch |err| {
                try emit(io, .{ .id = step.id, .status = "error", .err = @errorName(err), .raw = @as(?[]const u8, null), .label = @as(?[]const u8, null), .elapsed_ms = milliTimestamp(io) - started, .input = live });
                continue;
            };
            const input = if (response.fresh and fresh_json != null) fresh else live;
            const decision = contract.parse(a, response.text()) catch |err| {
                try emit(io, .{ .id = step.id, .status = "invalid", .err = @errorName(err), .raw = response.text(), .label = @as(?[]const u8, null), .elapsed_ms = milliTimestamp(io) - started, .input = input });
                continue;
            };
            try emit(io, .{ .id = step.id, .status = if (decision.label == null) "abstained" else "label", .err = @as(?[]const u8, null), .raw = response.text(), .label = if (decision.label) |label| label.text() else null, .elapsed_ms = milliTimestamp(io) - started, .input = input });
            if (decision.label) |label| context.remember(step.turn, step.evidence, label);
        }
    }
}
