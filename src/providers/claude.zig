const std = @import("std");
const common = @import("common.zig");
const eq = common.eq;
const str = common.str;
const field = common.field;

pub const Claude = struct {
    hooks: common.Hooks = .{},

    pub const info: common.Info = .{
        .label = "Claude Code",
        .name = "Claude",
        .launcher_key = 'l',
        .executables = &.{ "claude", "claude-code" },
        // Claude's daemon launches the versioned native binary directly.
        .install_markers = &.{"/claude/versions/"},
        .scripts = &.{"/@anthropic-ai/claude-code/cli.js"},
        .package = "@anthropic-ai/claude-code",
        .binary_env = "CORGI_CLAUDE_BIN",
        .home_paths = &.{ ".claude/local/claude", ".local/bin/claude", ".bun/bin/claude", ".npm-global/bin/claude", ".volta/bin/claude" },
        .system_paths = &.{ "/opt/homebrew/bin/claude", "/usr/local/bin/claude", "/usr/bin/claude" },
        .config_env = "CLAUDE_CONFIG_DIR",
        .config_dir = ".claude",
        .hooks_file = "settings.json",
        .account_file = ".claude.json",
        .account_home = ".",
        .credential_env = &.{ "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN" },
        .oauth_env = "CLAUDE_CODE_OAUTH_TOKEN",
        .endpoint_env = &.{ "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_*" },
        .model_env = "ANTHROPIC_MODEL",
        .profile_flags = &.{"--profile"},
        .settings_flags = &.{"--settings"},
        .yolo_flag = "--dangerously-skip-permissions",
        .summary_model = "claude-haiku-4-5-20251001",
        .prompt_turns = true,
        .screen = .{ .idle_title = "✳ " },
    };

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
    pub fn titleSession(_: []const u8) ?common.SessionPrefix {
        return null;
    }
    pub fn resumeArgs(_: Claude, ref: common.SessionRef) ![3][]const u8 {
        if (ref != .id or !ref.valid()) return error.InvalidSessionRef;
        return .{ "claude", "--resume", ref.id };
    }
};
