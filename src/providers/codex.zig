const std = @import("std");
const common = @import("common.zig");
const eq = common.eq;
const str = common.str;
const field = common.field;

pub const Codex = struct {
    hooks: common.Hooks = .{},

    pub const hook_events = &.{ "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd", "PreCompact", "Interrupt", "PostCompact" };
    pub const native_args: []const []const u8 = &.{ "app-server", "--listen", "stdio://" };

    pub fn hook(provider: Codex, value: std.json.Value) ?common.Hook {
        return provider.hooks.decode(value);
    }
    pub fn nativeEvent(_: Codex, value: std.json.Value) common.NativeEvent {
        const method = str(value, "method");
        const params = field(value, "params");
        const thread = str(params, "threadId");
        const turn = field(params, "turn");
        const result = if (value == .object) value.object.get("result") orelse params else .null;
        const status = str(turn, "status");
        return .{
            .session = if (thread.len > 0) thread else str(field(result, "thread"), "id"),
            .thread = thread,
            .turn = str(turn, "id"),
            .phase = if (eq(method, "turn/started")) .working else if (eq(method, "turn/completed")) .completed else .none,
            .outcome = if (eq(status, "interrupted")) .interrupted else if (eq(status, "failed")) .failed else .completed,
            .request_id = if (method.len > 0 and value == .object) value.object.get("id") else null,
            .response_id = if (value == .object and (value.object.contains("result") or value.object.contains("error"))) value.object.get("id") else null,
            .initialize = eq(str(value, "id"), "__corgi_init"),
            .initialization_failed = value == .object and value.object.contains("error"),
            .tool_request = eq(method, "item/commandExecution/requestApproval") or eq(method, "item/fileChange/requestApproval") or eq(method, "item/tool/call") or eq(method, "item/tool/requestUserInput"),
        };
    }
    pub fn resumeArgs(_: Codex, ref: common.SessionRef) ![3][]const u8 {
        if (ref != .id or !ref.valid()) return error.InvalidSessionRef;
        return .{ "codex", "resume", ref.id };
    }
};
