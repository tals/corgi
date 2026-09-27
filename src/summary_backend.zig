//! Activity-summary task over the shared persistent inference module.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const layout = @import("layout.zig");
const inference = @import("inference.zig");
pub const contract = @import("activity_prompt.zig");
const setup = @import("inference_setup.zig");
const a = @import("os.zig").allocator;
pub const Input = contract.Input;
pub const Source = struct { actor: ActorId, panes: []const layout.PaneId, agent_name: []const u8, session: []const u8 };

// JSON encoding preserves exact strings while keeping terminal escapes and
// embedded newlines from masquerading as additional log records.
fn log(value: anytype) void {
    const json = std.json.Stringify.valueAlloc(a, value, .{}) catch {
        std.log.scoped(.activity_summary).warn("could not encode summary diagnostic", .{});
        return;
    };
    defer a.free(json);
    std.log.scoped(.activity_summary).info("{s}", .{json});
}
pub const Backend = struct {
    pool: inference.Pool = .{ .config = .{} },
    next_request: u64 = 0,
    /// Replace the harness provider (null disables), stopping retained processes.
    pub fn use(b: *Backend, provider: ?inference.Provider) void {
        b.pool.deinit();
        b.pool.started = false;
        b.pool.config.disabled = provider == null;
        if (provider) |value| b.pool.config.provider = value;
        const model = setup.model(provider);
        b.pool.config.model = if (model.len > 0) model else null;
        b.pool.config.executable = @import("os.zig").env("CORGI_INFERENCE_BIN");
    }
    pub fn deinit(b: *Backend) void {
        b.pool.deinit();
    }
    pub fn infer(b: *Backend, input: Input, conversation: []const u8, source: Source, stopping: *const std.atomic.Value(bool)) ?contract.Decision {
        const json = std.json.Stringify.valueAlloc(a, input, .{}) catch return null;
        defer a.free(json);
        b.next_request += 1;
        const request_id = b.next_request;
        const started = std.time.milliTimestamp();
        const context = .{ .pid = @import("os.zig").c.getpid(), .request = request_id, .source = source, .turn = input.turn, .conversation = conversation };
        log(.{ .event = "request", .at = started, .context = context, .provider = @tagName(b.pool.config.provider), .model = b.pool.config.model, .instructions = contract.instructions, .schema = contract.schema, .input = json });
        const response = b.pool.infer(.{
            .instructions = contract.instructions,
            .schema = contract.schema,
            .content = json,
            .conversation = conversation,
        }, stopping) catch |err| {
            log(.{ .event = "result", .at = std.time.milliTimestamp(), .context = context, .status = "inference_error", .err = @errorName(err), .output = @as(?[]const u8, null) });
            return null;
        };
        const decision = contract.parse(a, response.text()) catch |err| {
            log(.{ .event = "result", .at = std.time.milliTimestamp(), .context = context, .status = "rejected", .err = @errorName(err), .output = response.text() });
            return null;
        };
        log(.{ .event = "result", .at = std.time.milliTimestamp(), .context = context, .status = if (decision.label == null) "abstained" else "validated", .output = response.text(), .label = if (decision.label) |label| label.text() else null });
        return decision;
    }
};
