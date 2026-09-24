const std = @import("std");
const common = @import("common.zig");
const eq = common.eq;
const str = common.str;
const field = common.field;

pub const Claude = struct {
    hooks: common.Hooks = .{},

    pub const hook_events = &.{ "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd", "PreCompact", "Notification", "PostToolUseFailure" };
    pub const native_args: []const []const u8 = &.{ "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio" };

    pub fn hook(provider: Claude, value: std.json.Value) ?common.Hook {
        return provider.hooks.decode(value);
    }
    pub fn nativeEvent(_: Claude, value: std.json.Value) common.NativeEvent {
        const kind = str(value, "type");
        const request = field(value, "request");
        const response = field(value, "response");
        const failed = field(value, "is_error");
        return .{
            .session = str(value, "session_id"),
            .phase = if (eq(kind, "assistant")) .working else if (eq(kind, "result")) .completed else .none,
            .outcome = if (failed == .bool and failed.bool) .failed else .completed,
            .request_id = if (eq(kind, "control_request") and value == .object) value.object.get("request_id") else null,
            .response_id = if (eq(kind, "control_response") and response == .object) response.object.get("request_id") else null,
            .tool_request = eq(kind, "control_request") and eq(str(request, "subtype"), "can_use_tool"),
        };
    }
    pub fn resumeArgs(_: Claude, ref: common.SessionRef) ![3][]const u8 {
        if (ref != .id or !ref.valid()) return error.InvalidSessionRef;
        return .{ "claude", "--resume", ref.id };
    }
};
