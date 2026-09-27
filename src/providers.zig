//! Concrete integrations compose shared codecs; actors own lifecycle state.
const std = @import("std");
/// An agent CLI Corgi integrates with. A pane running anything else has no
/// provider (`null`). Order is launcher order.
pub const Provider = enum {
    codex,
    claude,

    pub const all = std.enums.values(Provider);
    /// The provider an executable basename refers to.
    pub fn named(name: []const u8) ?Provider {
        for (all) |provider| {
            for (provider.info().executables) |executable| if (std.mem.eql(u8, name, executable)) return provider;
        }
        return null;
    }
    pub fn backend(provider: Provider) Backend {
        return Backend.init(provider);
    }
    pub fn info(provider: Provider) *const Info {
        return switch (provider) {
            inline else => |known| &@FieldType(Backend, @tagName(known)).info,
        };
    }
};
/// One `T` per provider, serialized as an object keyed by provider name.
pub fn Each(comptime T: type, comptime default: T) type {
    return std.enums.EnumFieldStruct(Provider, T, default);
}
/// The value of an `Each` that belongs to `provider`.
pub fn get(each: anytype, provider: Provider) @typeInfo(@TypeOf(each)).@"struct".fields[0].type {
    return switch (provider) {
        inline else => |known| @field(each, @tagName(known)),
    };
}
pub const Claude = @import("providers/claude.zig").Claude;
pub const Codex = @import("providers/codex.zig").Codex;
const common = @import("providers/common.zig");
pub const SessionRef = common.SessionRef;
pub const Hook = common.Hook;
pub const NativeEvent = common.NativeEvent;
pub const Info = common.Info;
pub const SessionPrefix = common.SessionPrefix;

pub const Backend = union(Provider) {
    codex: Codex,
    claude: Claude,

    pub fn init(provider: Provider) Backend {
        return switch (provider) {
            inline else => |known| @unionInit(Backend, @tagName(known), .{}),
        };
    }
    pub fn hook(backend: Backend, value: std.json.Value) ?Hook {
        return switch (backend) {
            inline else => |provider| provider.hook(value),
        };
    }
    pub fn nativeEvent(backend: Backend, value: std.json.Value) NativeEvent {
        return switch (backend) {
            inline else => |provider| provider.nativeEvent(value),
        };
    }
    pub fn requestId(backend: Backend, value: std.json.Value) ?std.json.Value {
        return backend.nativeEvent(value).request_id;
    }
    pub fn responseId(backend: Backend, value: std.json.Value) ?std.json.Value {
        return backend.nativeEvent(value).response_id;
    }
    pub fn nativeArgs(backend: Backend) []const []const u8 {
        return switch (backend) {
            inline else => |provider| @TypeOf(provider).native_args,
        };
    }
    pub fn hookEvents(backend: Backend) []const []const u8 {
        return switch (backend) {
            inline else => |provider| @TypeOf(provider).hook_events,
        };
    }
    /// Only providers with `title_identity` name sessions in their titles.
    pub fn titleSession(backend: Backend, title: []const u8) ?SessionPrefix {
        return switch (backend) {
            inline else => |provider| @TypeOf(provider).titleSession(title),
        };
    }
    pub fn resumeArgs(backend: Backend, ref: SessionRef) ![3][]const u8 {
        return switch (backend) {
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
