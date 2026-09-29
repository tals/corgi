const std = @import("std");
const common = @import("common.zig");
const json = @import("../json.zig");
const str = common.str;
const field = common.field;

pub const Codex = struct {
    hooks: common.Hooks = .{},

    pub const info: common.Info = .{
        .label = "Codex",
        .name = "Codex",
        .launcher_key = 'c',
        .executables = &.{"codex"},
        .scripts = &.{"/@openai/codex/bin/codex.js"},
        .package = "@openai/codex",
        .binary_env = "CORGI_CODEX_BIN",
        .home_paths = &.{ ".local/bin/codex", ".bun/bin/codex", ".npm-global/bin/codex", ".volta/bin/codex", ".cargo/bin/codex" },
        .system_paths = &.{ "/opt/homebrew/bin/codex", "/usr/local/bin/codex", "/usr/bin/codex" },
        .app_bundles = &.{ "Codex.app", "ChatGPT.app" },
        // Package wrappers stay executable when their native binary is missing.
        .version_prefix = "codex-cli ",
        .config_env = "CODEX_HOME",
        .config_dir = ".codex",
        .hooks_file = "hooks.json",
        .account_file = "auth.json",
        .account_home = ".codex",
        .credential_env = &.{"OPENAI_API_KEY"},
        .endpoint_env = &.{"OPENAI_BASE_URL"},
        .profile_flags = &.{ "--profile", "-p" },
        .settings_flags = &.{ "--settings", "-c", "--config" },
        .yolo_flag = "--dangerously-bypass-approvals-and-sandbox",
        .summary_model = "gpt-6-luna",
        .screen = .{
            .blocked_title = "Action Required",
            .idle_prompt = "›",
            // Unified exec keeps the status at "Working" while commands run.
            .background_status = true,
            .compaction_status = true,
        },
    };

    pub const hook_events = &.{ "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd", "PreCompact", "Interrupt", "PostCompact" };
    pub const native_args: []const []const u8 = &.{ "app-server", "--listen", "stdio://" };

    /// JSON-RPC method names Codex's app-server protocol sends.
    pub const Method = enum {
        @"turn/started",
        @"turn/completed",
        @"thread/started",
        @"thread/tokenUsage/updated",
        @"item/started",
        @"item/completed",
        @"item/commandExecution/requestApproval",
        @"item/fileChange/requestApproval",
        @"item/tool/call",
        @"item/tool/requestUserInput",
    };
    /// `item.type` values that occupy a thread until the item completes.
    pub const ItemType = enum { commandExecution, fileChange, mcpToolCall, dynamicToolCall, collabAgentToolCall, webSearch, imageView, imageGeneration };
    /// Rollout JSONL record kinds (top-level `type`).
    pub const RolloutKind = enum { session_meta, turn_context, event_msg, response_item };
    /// `payload.type` values seen on `event_msg` and `response_item` records.
    pub const EventKind = enum {
        task_started,
        task_complete,
        turn_complete,
        turn_aborted,
        token_count,
        message,
        function_call,
        function_call_output,
        custom_tool_call,
        custom_tool_call_output,
        local_shell_call,
        web_search_call,
    };
    /// A rollout line's envelope; field names are the wire keys.
    pub const Rollout = struct {
        type: ?RolloutKind = null,
        timestamp: []const u8 = "",
        payload: std.json.Value = .null,

        pub fn decode(v: std.json.Value) Rollout {
            return json.decode(Rollout, v);
        }
        /// The kind of an `event_msg` or `response_item` payload.
        pub fn payloadType(r: Rollout) ?EventKind {
            return std.meta.stringToEnum(EventKind, str(r.payload, "type"));
        }
    };

    pub fn hook(provider: Codex, value: std.json.Value) ?common.Hook {
        return provider.hooks.decode(value);
    }
    pub fn nativeEvent(_: Codex, value: std.json.Value) common.NativeEvent {
        const method_str = str(value, "method");
        const method = std.meta.stringToEnum(Method, method_str);
        const params = field(value, "params");
        const thread = str(params, "threadId");
        const turn = field(params, "turn");
        const result = if (value == .object) value.object.get("result") orelse params else .null;
        return .{
            .session = if (thread.len > 0) thread else str(field(result, "thread"), "id"),
            .thread = thread,
            .turn = str(turn, "id"),
            .phase = if (method == .@"turn/started") .working else if (method == .@"turn/completed") .completed else .none,
            .outcome = std.meta.stringToEnum(common.Outcome, str(turn, "status")) orelse .completed,
            // Any recognized-or-not method with an id is a request; unlike the
            // dispatch above, this must not miss a future method.
            .request_id = if (method_str.len > 0 and value == .object) value.object.get("id") else null,
            .response_id = if (value == .object and (value.object.contains("result") or value.object.contains("error"))) value.object.get("id") else null,
            .initialize = std.mem.eql(u8, str(value, "id"), "__corgi_init"),
            .initialization_failed = value == .object and value.object.contains("error"),
            .tool_request = method == .@"item/commandExecution/requestApproval" or method == .@"item/fileChange/requestApproval" or method == .@"item/tool/call" or method == .@"item/tool/requestUserInput",
        };
    }
    // Codex's 32-character title field contains 29 UUID characters plus "...".
    // Accept only a complete UUID or that exact truncated form, not arbitrary text.
    pub fn titleSession(title: []const u8) ?common.SessionPrefix {
        var words = std.mem.tokenizeAny(u8, title, " |\t");
        var found: ?common.SessionPrefix = null;
        while (words.next()) |word| {
            const n: usize = if (word.len == 36) 36 else if (word.len == 32 and std.mem.endsWith(u8, word, "...")) 29 else continue;
            var valid = true;
            for (word[0..n], 0..) |ch, i| {
                if (i == 8 or i == 13 or i == 18 or i == 23) {
                    if (ch != '-') valid = false;
                } else if (!std.ascii.isHex(ch)) valid = false;
            }
            if (!valid) continue;
            if (found != null) return null;
            found = .initTruncated(word[0..n]);
        }
        return found;
    }
    pub fn resumeArgs(_: Codex, ref: common.SessionRef) ![3][]const u8 {
        if (ref != .id or !ref.valid()) return error.InvalidSessionRef;
        return .{ "codex", "resume", ref.id };
    }
};

test "rollout lines decode their envelope and payload kind" {
    const alloc = std.testing.allocator;
    const event = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"event_msg","timestamp":"t","payload":{"type":"token_count"}}
    , .{});
    defer event.deinit();
    const rollout = Codex.Rollout.decode(event.value);
    try std.testing.expectEqual(Codex.RolloutKind.event_msg, rollout.type.?);
    try std.testing.expectEqualStrings("t", rollout.timestamp);
    try std.testing.expectEqual(Codex.EventKind.token_count, rollout.payloadType().?);
    const other = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"compacted","payload":"summary"}
    , .{});
    defer other.deinit();
    try std.testing.expectEqual(null, Codex.Rollout.decode(other.value).type);
    try std.testing.expectEqual(null, Codex.Rollout.decode(other.value).payloadType());
}
