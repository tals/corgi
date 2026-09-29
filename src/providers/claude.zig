const std = @import("std");
const common = @import("common.zig");
const json = @import("../json.zig");
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
        .native_args = &.{ "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio" },
        // The harness has no tools, MCP servers or saved sessions.
        .inference_args = &.{ "--safe-mode", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--tools", "", "--no-session-persistence" },
        .resume_args = .{ "claude", "--resume" },
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
        .limits = .{ .windows = .{ "five_hour", "seven_day" }, .used = "utilization", .minutes = .{ 300, 10080 }, .reset = .iso8601 },
        .prompt_turns = true,
        .screen = .{ .idle_title = "✳ " },
    };

    pub const hook_events = &.{ "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd", "PreCompact", "Notification", "PostToolUseFailure" };

    /// Claude's stream-json envelope kind (the `type` field).
    pub const MessageType = enum { assistant, user, result, control_request, control_response };
    /// A message's content block kind (the block's `type` field).
    pub const BlockType = enum { text, tool_use, tool_result };
    /// A transcript JSONL line's `type`. The dashed kinds name the
    /// conversation or the session it continued in.
    pub const TranscriptLine = enum { assistant, user, system, attachment, @"agent-name", @"custom-title", @"ai-title", @"continued-in" };
    /// A transcript line's envelope; field names are the wire keys.
    pub const Line = struct {
        type: ?TranscriptLine = null,
        subtype: []const u8 = "",
        sessionId: []const u8 = "",
        timestamp: []const u8 = "",
        isSidechain: bool = false,
        message: std.json.Value = .null,

        /// Null for a subagent's line: it belongs to the subagent, never to
        /// the session.
        pub fn decode(v: std.json.Value) ?Line {
            const line = json.decode(Line, v);
            return if (line.isSidechain) null else line;
        }
    };

    pub fn hook(provider: Claude, value: std.json.Value) ?common.Hook {
        return provider.hooks.decode(value);
    }
    pub fn nativeEvent(_: Claude, value: std.json.Value) common.NativeEvent {
        const kind = std.meta.stringToEnum(MessageType, str(value, "type"));
        const request = field(value, "request");
        const response = field(value, "response");
        const failed = field(value, "is_error");
        return .{
            .session = str(value, "session_id"),
            .phase = if (kind == .assistant) .working else if (kind == .result) .completed else .none,
            .outcome = if (failed == .bool and failed.bool) .failed else .completed,
            .request_id = if (kind == .control_request and value == .object) value.object.get("request_id") else null,
            .response_id = if (kind == .control_response and response == .object) response.object.get("request_id") else null,
            .tool_request = kind == .control_request and std.mem.eql(u8, str(request, "subtype"), "can_use_tool"),
        };
    }
    pub fn titleSession(_: []const u8) ?common.SessionPrefix {
        return null;
    }
    /// Model families Claude Code runs with a 1M window without a `[1m]` suffix.
    const native_1m = [_][]const u8{ "claude-opus-4-7", "claude-opus-4-8", "claude-opus-5", "claude-sonnet-5", "claude-fable-5", "claude-mythos-5" };
    /// The context window Claude Code gives a transcript's model id. Zero for
    /// anything else, such as the `<synthetic>` model of error records.
    pub fn contextWindow(model: []const u8) u64 {
        if (!std.mem.startsWith(u8, model, "claude-")) return 0;
        if (std.mem.endsWith(u8, model, "[1m]")) return 1_000_000;
        for (native_1m) |family| {
            if (!std.mem.startsWith(u8, model, family)) continue;
            // "claude-opus-5" must not claim a future "claude-opus-55".
            if (model.len > family.len and std.ascii.isDigit(model[family.len])) continue;
            return 1_000_000;
        }
        return 200_000;
    }
};

test "transcript lines decode their envelope and drop subagent lines" {
    const alloc = std.testing.allocator;
    const own = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","sessionId":"s","timestamp":"t","message":{"model":"m"}}
    , .{});
    defer own.deinit();
    const line = Claude.Line.decode(own.value).?;
    try std.testing.expectEqual(Claude.TranscriptLine.assistant, line.type.?);
    try std.testing.expectEqualStrings("s", line.sessionId);
    try std.testing.expectEqualStrings("t", line.timestamp);
    try std.testing.expectEqualStrings("m", str(line.message, "model"));
    const other = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"file-history-snapshot","isSidechain":false}
    , .{});
    defer other.deinit();
    try std.testing.expectEqual(null, Claude.Line.decode(other.value).?.type);
    const subagent = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","sessionId":"s","isSidechain":true}
    , .{});
    defer subagent.deinit();
    try std.testing.expect(Claude.Line.decode(subagent.value) == null);
}
