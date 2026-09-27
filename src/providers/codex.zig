const std = @import("std");
const common = @import("common.zig");
const eq = common.eq;
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
            var p: common.SessionPrefix = .{ .len = n };
            @memcpy(p.bytes[0..n], word[0..n]);
            found = p;
        }
        return found;
    }
    pub fn resumeArgs(_: Codex, ref: common.SessionRef) ![3][]const u8 {
        if (ref != .id or !ref.valid()) return error.InvalidSessionRef;
        return .{ "codex", "resume", ref.id };
    }
};
