//! Concrete integrations compose shared codecs; actors own lifecycle state.
const std = @import("std");
pub const Provider = enum { claude, codex, other };
pub const Claude = @import("providers/claude.zig").Claude;
pub const Codex = @import("providers/codex.zig").Codex;
const common = @import("providers/common.zig");
pub const SessionRef = common.SessionRef;
pub const Hook = common.Hook;
pub const NativeEvent = common.NativeEvent;

pub const Backend = union(Provider) {
    claude: Claude,
    codex: Codex,
    other: void,

    pub fn init(provider: Provider) Backend {
        return switch (provider) {
            .claude => .{ .claude = .{} },
            .codex => .{ .codex = .{} },
            .other => .other,
        };
    }
    pub fn hook(backend: Backend, value: std.json.Value) ?Hook {
        return switch (backend) {
            .other => null,
            inline else => |provider| provider.hook(value),
        };
    }
    pub fn nativeEvent(backend: Backend, value: std.json.Value) NativeEvent {
        return switch (backend) {
            .other => .{},
            inline else => |provider| provider.nativeEvent(value),
        };
    }
    pub fn requestId(backend: Backend, value: std.json.Value) ?std.json.Value {
        return backend.nativeEvent(value).request_id;
    }
    pub fn responseId(backend: Backend, value: std.json.Value) ?std.json.Value {
        return backend.nativeEvent(value).response_id;
    }
    pub fn nativeArgs(backend: Backend) ![]const []const u8 {
        return switch (backend) {
            .other => error.BadProvider,
            inline else => |provider| @TypeOf(provider).native_args,
        };
    }
    pub fn hookEvents(backend: Backend) ![]const []const u8 {
        return switch (backend) {
            .other => error.BadProvider,
            inline else => |provider| @TypeOf(provider).hook_events,
        };
    }
    pub fn resumeArgs(backend: Backend, ref: SessionRef) ![3][]const u8 {
        return switch (backend) {
            .other => error.BadProvider,
            inline else => |provider| provider.resumeArgs(ref),
        };
    }
};

test "native adapters keep provider envelopes separate and identify concrete conversations" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"method":"turn/completed","params":{"threadId":"a","turn":{"id":"t","status":"interrupted"}}}
    , .{});
    defer parsed.deinit();
    const codex = Backend.init(.codex).nativeEvent(parsed.value);
    try std.testing.expectEqualStrings("a", codex.session);
    try std.testing.expectEqualStrings("t", codex.turn);
    try std.testing.expectEqual(.completed, codex.phase);
    try std.testing.expectEqual(.interrupted, codex.outcome);
    try std.testing.expectEqual(.none, Backend.init(.claude).nativeEvent(parsed.value).phase);
}

test "native request matching preserves string and integer identifiers" {
    const alloc = std.testing.allocator;
    const request = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"id":42,"method":"item/tool/requestUserInput","params":{"threadId":"a"}}
    , .{});
    defer request.deinit();
    const reply = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"control_response","response":{"request_id":"request-a"}}
    , .{});
    defer reply.deinit();
    try std.testing.expectEqual(@as(i64, 42), Backend.init(.codex).requestId(request.value).?.integer);
    try std.testing.expectEqualStrings("request-a", Backend.init(.claude).responseId(reply.value).?.string);
    try std.testing.expect(Backend.init(.codex).responseId(reply.value) == null);
    try std.testing.expect(Backend.init(.claude).requestId(.null) == null);
}

test "resume plans are typed argv and reject invalid or unsupported session references" {
    const args = try Backend.init(.claude).resumeArgs(.{ .id = "id'with quote" });
    try std.testing.expectEqualStrings("id'with quote", args[2]);
    try std.testing.expectError(error.InvalidSessionRef, Backend.init(.claude).resumeArgs(.{ .path = "/tmp/session.jsonl" }));
    try std.testing.expectError(error.InvalidSessionRef, Backend.init(.codex).resumeArgs(.{ .id = "a\nb" }));
    try std.testing.expectError(error.BadProvider, Backend.init(.other).nativeArgs());
}

test "shared hook codec preserves permission context and rejects child observations" {
    const alloc = std.testing.allocator;
    const permission = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"hook_event_name":"PreToolUse","session_id":"a","tool_name":"AskUserQuestion","tool_input":{"description":"Pick a branch"}}
    , .{});
    defer permission.deinit();
    const child = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"hook_event_name":"Stop","session_id":"a","agent_id":"child"}
    , .{});
    defer child.deinit();
    for ([_]Provider{ .claude, .codex }) |provider| {
        const backend = Backend.init(provider);
        const hook = backend.hook(permission.value).?;
        try std.testing.expect(hook.asking);
        try std.testing.expectEqualStrings("Pick a branch", hook.description);
        try std.testing.expect(backend.hook(child.value) == null);
        try std.testing.expect(backend.hook(.null) == null);
    }
}
