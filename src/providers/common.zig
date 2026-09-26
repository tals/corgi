//! Borrowed, normalized provider facts. Parsing never mutates conversation state.
const std = @import("std");
pub const Outcome = @import("../observation.zig").Outcome;

pub const SessionRef = union(enum) {
    id: []const u8,
    path: []const u8,

    pub fn text(ref: SessionRef) []const u8 {
        return switch (ref) {
            inline else => |value| value,
        };
    }
    pub fn valid(ref: SessionRef) bool {
        const value = ref.text();
        if (value.len == 0 or value.len > std.fs.max_path_bytes) return false;
        for (value) |ch| if (ch < 32 or ch == 127) return false;
        return ref != .path or std.fs.path.isAbsolute(value);
    }
};

pub const Hook = struct {
    kind: enum { session_start, prompt, tool_start, tool_finish, tool_failure, permission, notification, compact_start, compact_end, stop, interrupt, session_end },
    session: []const u8,
    turn: []const u8 = "",
    // Claude's per-prompt id. It keys activity labels, never lifecycle.
    prompt: []const u8 = "",
    transcript: []const u8 = "",
    cwd: []const u8 = "",
    // The model the session runs now, which follows mid-session switches.
    model: []const u8 = "",
    tool: []const u8 = "",
    description: []const u8 = "",
    background_tasks: std.json.Value = .null,
    // The tool's main argument, for a readable label when there is no description.
    target: []const u8 = "",
    asking: bool = false,
    permission_notification: bool = false,
};

/// Claude and Codex currently share this hook envelope, not lifecycle state.
pub const Hooks = struct {
    pub fn decode(_: Hooks, value: std.json.Value) ?Hook {
        if (value != .object or str(value, "agent_id").len != 0) return null;
        const event = str(value, "hook_event_name");
        const tool = str(value, "tool_name");
        const kind: @FieldType(Hook, "kind") = if (eq(event, "SessionStart")) .session_start else if (eq(event, "UserPromptSubmit")) .prompt else if (eq(event, "PreToolUse")) .tool_start else if (eq(event, "PostToolUse")) .tool_finish else if (eq(event, "PostToolUseFailure")) .tool_failure else if (eq(event, "PermissionRequest")) .permission else if (eq(event, "PreCompact")) .compact_start else if (eq(event, "PostCompact")) .compact_end else if (eq(event, "Stop")) .stop else if (eq(event, "Interrupt")) .interrupt else if (eq(event, "SessionEnd")) .session_end else if (eq(event, "Notification")) blk: {
            const notification = str(value, "notification_type");
            // idle_prompt follows every finished turn after a minute ("waiting
            // for your input"); Stop already made the agent idle, not blocked.
            if (eq(notification, "permission_prompt") or eq(notification, "elicitation_dialog")) break :blk .notification;
            return null;
        } else return null;
        return .{
            .kind = kind,
            .session = str(value, "session_id"),
            .turn = str(value, "turn_id"),
            .prompt = str(value, "prompt_id"),
            .transcript = str(value, "transcript_path"),
            .cwd = str(value, "cwd"),
            .model = str(value, "model"),
            .tool = tool,
            .description = str(field(value, "tool_input"), "description"),
            .background_tasks = field(value, "background_tasks"),
            .target = target(field(value, "tool_input")),
            .asking = kind == .tool_start and (eq(tool, "AskUserQuestion") or eq(tool, "request_user_input")),
            .permission_notification = kind == .notification and eq(str(value, "notification_type"), "permission_prompt"),
        };
    }
};

fn target(input: std.json.Value) []const u8 {
    for ([_][]const u8{ "file_path", "notebook_path", "pattern", "query", "url", "command", "skill" }) |key| {
        const value = str(input, key);
        if (value.len > 0) return value;
    }
    return "";
}

pub const NativeEvent = struct {
    session: []const u8 = "",
    thread: []const u8 = "",
    turn: []const u8 = "",
    phase: enum { none, working, completed } = .none,
    outcome: Outcome = .completed,
    request_id: ?std.json.Value = null,
    response_id: ?std.json.Value = null,
    initialize: bool = false,
    initialization_failed: bool = false,
    tool_request: bool = false,
};

pub fn field(v: std.json.Value, key: []const u8) std.json.Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
pub fn str(v: std.json.Value, key: []const u8) []const u8 {
    const value = field(v, key);
    return if (value == .string) value.string else "";
}
pub fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

test "idle notifications do not mark a finished agent as needing input" {
    const alloc = std.testing.allocator;
    const idle = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"hook_event_name":"Notification","session_id":"a","notification_type":"idle_prompt"}
    , .{});
    defer idle.deinit();
    const permission = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"hook_event_name":"Notification","session_id":"a","notification_type":"permission_prompt"}
    , .{});
    defer permission.deinit();
    const hooks: Hooks = .{};
    try std.testing.expect(hooks.decode(idle.value) == null);
    try std.testing.expectEqual(.notification, hooks.decode(permission.value).?.kind);
}

test "hooks carry the session's current model" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"UserPromptSubmit","session_id":"a","model":"gpt-6-astra"}
    , .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("gpt-6-astra", (Hooks{}).decode(parsed.value).?.model);
}
