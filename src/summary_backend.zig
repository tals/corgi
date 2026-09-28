//! Activity-summary task over the shared persistent inference module.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const layout = @import("layout.zig");
const inference = @import("inference.zig");
pub const contract = @import("activity_prompt.zig");
const setup = @import("inference_setup.zig");
const os = @import("os.zig");
const a = os.allocator;
pub const Input = contract.Input;
/// `tools_since_last` counts tool calls completed since this agent's previous attempt.
pub const Source = struct { actor: ActorId, panes: []const layout.PaneId, agent_name: []const u8, session: []const u8, tools_since_last: u64 = 0 };

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
/// Why a validated decision never reached the agent.
pub const Discard = enum { not_working, session_changed, turn_changed, evidence_changed, superseded };
/// Follow-up record for `request`: whether its decision was shown. Request 0
/// (tests and hand-built results) is never logged.
pub fn outcome(request: u64, discard: ?Discard) void {
    if (request == 0) return;
    log(.{
        .event = "outcome",
        .at = std.time.milliTimestamp(),
        .context = .{ .pid = os.c.getpid(), .request = request },
        .status = if (discard == null) "applied" else "discarded",
        .reason = if (discard) |reason| @tagName(reason) else null,
    });
}
/// `request` numbers this attempt's log records; `decision` is null on failure.
pub const Attempt = struct { request: u64, decision: ?contract.Decision };
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
        b.pool.config.executable = os.env("CORGI_INFERENCE_BIN");
    }
    pub fn deinit(b: *Backend) void {
        b.pool.deinit();
    }
    /// `input.history` is sent only if the native conversation has to be
    /// created; `turn` is the provider's turn ID for the log.
    pub fn infer(b: *Backend, input: Input, turn: []const u8, conversation: []const u8, source: Source, stopping: *const std.atomic.Value(bool)) Attempt {
        b.next_request += 1;
        const request_id = b.next_request;
        const failed: Attempt = .{ .request = request_id, .decision = null };
        var live = input;
        live.history = null;
        const json = contract.content(a, live) catch |err| {
            std.log.scoped(.activity_summary).warn("could not encode summary request: {}", .{err});
            return failed;
        };
        defer a.free(json);
        const has_history = if (input.history) |history| history.len > 0 else false;
        const fresh_json = if (has_history) contract.content(a, input) catch |err| {
            std.log.scoped(.activity_summary).warn("could not encode summary request: {}", .{err});
            return failed;
        } else null;
        defer if (fresh_json) |value| a.free(value);
        const started = std.time.milliTimestamp();
        const context = .{ .pid = os.c.getpid(), .request = request_id, .source = source, .turn = turn, .conversation = conversation };
        log(.{
            .event = "request",
            .at = started,
            .context = context,
            .provider = @tagName(b.pool.config.provider),
            .model = b.pool.config.model,
            .instructions = contract.instructions,
            .schema = contract.schema,
            .input = json,
            .fresh_input = fresh_json,
        });
        const response = b.pool.infer(.{
            .instructions = contract.instructions,
            .schema = contract.schema,
            .content = json,
            .fresh_content = fresh_json,
            .conversation = conversation,
        }, stopping) catch |err| {
            log(.{ .event = "result", .at = std.time.milliTimestamp(), .context = context, .status = "inference_error", .err = @errorName(err), .output = @as(?[]const u8, null) });
            return failed;
        };
        const decision = contract.parse(a, response.text()) catch |err| {
            log(.{ .event = "result", .at = std.time.milliTimestamp(), .context = context, .status = "rejected", .err = @errorName(err), .output = response.text(), .fresh_conversation = response.fresh, .usage = response.usage });
            return failed;
        };
        log(.{
            .event = "result",
            .at = std.time.milliTimestamp(),
            .context = context,
            .status = if (decision.label == null) "abstained" else "validated",
            .output = response.text(),
            .label = if (decision.label) |label| label.text() else null,
            .fresh_conversation = response.fresh,
            .usage = response.usage,
        });
        return .{ .request = request_id, .decision = decision };
    }
};
