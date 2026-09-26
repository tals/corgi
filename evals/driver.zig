//! JSONL bridge to the production inference layer. Invoked by run.ts.
const std = @import("std");
const backend = @import("backend");
const contract = backend.contract;
const a = std.heap.c_allocator;
const Step = struct { id: []const u8, evidence: []const u8, turn: []const u8 };
const Scenario = struct { id: []const u8, steps: []const Step };
var stopping: std.atomic.Value(bool) = .init(false);

fn stop(_: c_int) callconv(.c) void {
    stopping.store(true, .release);
}
fn emit(value: anytype) !void {
    const text = try std.json.Stringify.valueAlloc(a, value, .{});
    defer a.free(text);
    const stdout: std.fs.File = .{ .handle = std.posix.STDOUT_FILENO };
    try stdout.writeAll(text);
    try stdout.writeAll("\n");
}
pub fn main() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    if (args.len != 4) return error.Usage; // provider model plan.json
    var impl: backend.Backend = .{};
    impl.pool.config.provider = std.meta.stringToEnum(@TypeOf(impl.pool.config.provider), args[1]) orelse return error.InvalidProvider;
    impl.pool.config.model = args[2];
    impl.pool.config.timeout_ms = 60000;
    const override = std.process.getEnvVarOwned(a, "CORGI_EVAL_HARNESS") catch null;
    defer if (override) |path| a.free(path);
    impl.pool.config.executable = override;
    defer impl.deinit();
    const action: std.posix.Sigaction = .{ .handler = .{ .handler = stop }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.INT, &action, null);
    std.posix.sigaction(std.posix.SIG.TERM, &action, null);
    const bytes = try std.fs.cwd().readFileAlloc(a, args[3], 4 * 1024 * 1024);
    defer a.free(bytes);
    const plan = try std.json.parseFromSlice([]const Scenario, a, bytes, .{});
    defer plan.deinit();
    for (plan.value) |scenario| {
        var context: contract.Context = .{};
        for (scenario.steps) |step| {
            if (stopping.load(.acquire)) return error.Cancelled;
            // Match the production evidence bound; never silently evaluate more context.
            if (step.evidence.len > 2048) return error.EvidenceTooLong;
            var history: [4][]const u8 = undefined;
            for (context.recent[0..context.len], 0..) |*entry, i| history[i] = entry.text();
            const input: backend.Input = .{ .provider = args[1], .evidence = step.evidence, .previous = context.previous.text(), .turn = step.turn, .history = history[0..context.len] };
            const json = try std.json.Stringify.valueAlloc(a, input, .{});
            defer a.free(json);
            const started = std.time.milliTimestamp();
            const response = impl.pool.infer(.{ .instructions = contract.instructions, .schema = contract.schema, .content = json, .conversation = scenario.id }, &stopping) catch |err| {
                try emit(.{ .id = step.id, .status = "error", .err = @errorName(err), .raw = @as(?[]const u8, null), .label = @as(?[]const u8, null), .elapsed_ms = std.time.milliTimestamp() - started, .input = input });
                continue;
            };
            const decision = contract.parse(a, response.text()) catch |err| {
                try emit(.{ .id = step.id, .status = "invalid", .err = @errorName(err), .raw = response.text(), .label = @as(?[]const u8, null), .elapsed_ms = std.time.milliTimestamp() - started, .input = input });
                continue;
            };
            try emit(.{ .id = step.id, .status = if (decision.label == null) "abstained" else "label", .err = @as(?[]const u8, null), .raw = response.text(), .label = if (decision.label) |label| label.text() else null, .elapsed_ms = std.time.milliTimestamp() - started, .input = input });
            if (decision.label) |label| context.remember(step.turn, step.evidence, label);
        }
    }
}
