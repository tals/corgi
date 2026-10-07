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
        .fork_args = .{ "--resume", "--fork-session" },
        .fork_session_flag = "--session-id",
        .name_flag = "--name",
        .config_env = "CLAUDE_CONFIG_DIR",
        .config_dir = ".claude",
        .hooks_file = "settings.json",
        .account_file = ".claude.json",
        .account_home = ".",
        .credential_env = &.{ "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN" },
        .oauth_env = "CLAUDE_CODE_OAUTH_TOKEN",
        .endpoint_env = &.{"ANTHROPIC_BASE_URL"},
        .provider_env = &.{ "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD", "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_GATEWAY" },
        .model_env = "ANTHROPIC_MODEL",
        .profile_flags = &.{"--profile"},
        .settings_flags = &.{"--settings"},
        .yolo_flag = "--dangerously-skip-permissions",
        .summary_model = "claude-haiku-4-5-20251001",
        .limits = .{ .windows = .{ "five_hour", "seven_day" }, .used = "utilization", .minutes = .{ 300, 10080 }, .reset = .iso8601 },
        .prompt_turns = true,
        .children_at_stop = true,
        .screen = .{ .idle_title = "✳ " },
    };

    pub const hook_events = &.{ "SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "PermissionRequest", "Stop", "SessionEnd", "PreCompact", "Notification", "PostToolUseFailure" };

    pub const ControlMethod = enum { initialize, get_usage };
    pub const AuthMethod = enum { @"claude.ai", api_key, api_key_helper, oauth_token, third_party, none };
    /// Claude's stream-json envelope kind (the `type` field).
    pub const MessageType = enum { assistant, user, result, control_request, control_response };
    /// A message's content block kind (the block's `type` field).
    pub const BlockType = enum { text, tool_use, tool_result };
    /// The kinds of in-flight work a Stop hook's `background_tasks` lists
    /// that Corgi reads (the entry's `type` field).
    pub const TaskType = enum { shell, subagent };
    /// How a background task ended, as its notification says.
    pub const TaskStatus = enum { completed, failed, killed, stopped };
    /// A transcript JSONL line's `type`. The dashed kinds name the
    /// conversation or the session it continued in; a queue operation
    /// records a message queued for the conversation, a task's notice among them.
    pub const TranscriptLine = enum { assistant, user, system, attachment, @"agent-name", @"custom-title", @"ai-title", @"continued-in", @"queue-operation" };
    /// A task's notice in Claude's `<task-notification>` envelope: which task,
    /// and how it ended, for the notice that says so.
    pub const TaskNotice = struct {
        id: []const u8,
        status: ?TaskStatus,

        pub fn decode(content: []const u8) ?TaskNotice {
            if (!std.mem.startsWith(u8, std.mem.trimStart(u8, content, " \t\r\n"), "<task-notification>")) return null;
            // The fields come before the summary and the task's own output,
            // which may print anything.
            const end = std.mem.indexOf(u8, content, "<summary>") orelse std.mem.indexOf(u8, content, "<event>") orelse content.len;
            const fields = content[0..end];
            const status = element(fields, "status");
            return .{
                .id = element(fields, "task-id") orelse return null,
                .status = if (status) |word| std.meta.stringToEnum(TaskStatus, word) else null,
            };
        }
        fn element(text: []const u8, comptime name: []const u8) ?[]const u8 {
            const open = "<" ++ name ++ ">";
            const start = (std.mem.indexOf(u8, text, open) orelse return null) + open.len;
            const len = std.mem.indexOf(u8, text[start..], "</" ++ name ++ ">") orelse return null;
            return text[start..][0..len];
        }
    };
    /// A transcript line's envelope; field names are the wire keys.
    pub const Line = struct {
        type: ?TranscriptLine = null,
        subtype: []const u8 = "",
        sessionId: []const u8 = "",
        /// The subagent a sidechain line belongs to.
        agentId: []const u8 = "",
        timestamp: []const u8 = "",
        isSidechain: bool = false,
        message: std.json.Value = .null,

        /// Null for a subagent's line: it belongs to the subagent, never to
        /// the session.
        pub fn decode(v: std.json.Value) ?Line {
            const line = json.decode(Line, v);
            return if (line.isSidechain) null else line;
        }
        /// The line if it belongs to `conversation`: a session's own line, or
        /// a subagent's, whose conversation is its agent id.
        pub fn of(v: std.json.Value, conversation: []const u8) ?Line {
            const line = json.decode(Line, v);
            const owner = if (line.isSidechain) line.agentId else line.sessionId;
            return if (std.mem.eql(u8, owner, conversation)) line else null;
        }
    };
    /// What a live Claude process records in `<config>/sessions/<pid>.json`;
    /// field names are the wire keys.
    pub const SessionRecord = struct {
        pid: c_int = 0,
        sessionId: []const u8 = "",
        kind: ?SessionKind = null,
        /// The background job's short id, which `claude attach` takes.
        jobId: []const u8 = "",
        /// The session's messaging socket, which Claude's own agent view
        /// renames it through; `peerProtocol` is its version.
        messagingSocketPath: []const u8 = "",
        peerProtocol: u32 = 0,
    };
    /// Who runs a live session: a terminal, or Claude's background daemon.
    pub const SessionKind = enum { interactive, bg };
    /// A subagent's own transcript, kept beside its session's in a folder
    /// named for the session.
    pub fn subagentTranscript(buf: []u8, transcript: []const u8, session: []const u8, agent: []const u8) ?[]const u8 {
        const dir = std.fs.path.dirname(transcript) orelse return null;
        return std.fmt.bufPrint(buf, "{s}/{s}/subagents/agent-{s}.jsonl", .{ dir, session, agent }) catch null;
    }

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
    /// The plan from its kind ("max", "claude_max") and its rate limit tier
    /// ("default_claude_max_5x"), which is shown only when it refines the kind.
    pub fn plan(kind: []const u8, tier: []const u8) common.Plan {
        const named = common.planLabel(planCode(kind));
        const refined = common.planLabel(planCode(tier));
        return if (named.len > 0 and std.mem.startsWith(u8, refined.text(), named.text())) refined else named;
    }
    /// "default_claude_max_5x" is "max_5x".
    fn planCode(code: []const u8) []const u8 {
        var rest = code;
        for ([_][]const u8{ "default_", "claude_" }) |prefix| {
            if (std.mem.startsWith(u8, rest, prefix)) rest = rest[prefix.len..];
        }
        return rest;
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

test "a subagent's lines belong to the subagent, in the file beside its session's" {
    const alloc = std.testing.allocator;
    const own = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","sessionId":"s"}
    , .{});
    defer own.deinit();
    const subagent = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","sessionId":"s","isSidechain":true,"agentId":"a1"}
    , .{});
    defer subagent.deinit();
    try std.testing.expect(Claude.Line.of(own.value, "s") != null);
    try std.testing.expect(Claude.Line.of(own.value, "a1") == null);
    try std.testing.expect(Claude.Line.of(subagent.value, "a1") != null);
    try std.testing.expect(Claude.Line.of(subagent.value, "s") == null);
    var buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings("/p/s/subagents/agent-a1.jsonl", Claude.subagentTranscript(&buf, "/p/s.jsonl", "s", "a1").?);
}

test "task notices name their task, and how it ended once it has" {
    const cases = .{
        .{ "<task-notification>\n<task-id>bepm4nu57</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Monitor \"probe\" stream ended</summary>\n<event>done</event>\n</task-notification>", "bepm4nu57", Claude.TaskStatus.completed },
        .{ "<task-notification>\n<task-id>b8eldxmdy</task-id>\n<status>killed</status>\n<summary>Task \"probe\" was stopped by the user</summary>\n</task-notification>", "b8eldxmdy", Claude.TaskStatus.killed },
        // An event of a Monitor that runs on, though its output prints a status.
        .{ "<task-notification>\n<task-id>bu7xsz0ou</task-id>\n<summary>Monitor event: \"ci\"</summary>\n<event><status>killed</status></event>\n</task-notification>", "bu7xsz0ou", null },
    };
    inline for (cases) |case| {
        const notice = Claude.TaskNotice.decode(case[0]).?;
        try std.testing.expectEqualStrings(case[1], notice.id);
        try std.testing.expectEqual(@as(?Claude.TaskStatus, case[2]), notice.status);
    }
    try std.testing.expect(Claude.TaskNotice.decode("check CI again") == null);
    try std.testing.expect(Claude.TaskNotice.decode("<task-notification><summary>no id</summary></task-notification>") == null);
}

test "plans read as Claude's tier refines its kind" {
    const cases = [_][3][]const u8{
        .{ "max", "default_claude_max_5x", "Max 5x" },
        .{ "claude_max", "default_claude_max_20x", "Max 20x" },
        .{ "pro", "default_claude_ai", "Pro" },
        .{ "claude_team", "default_raven", "Team" },
        .{ "", "default_claude_ai", "" },
    };
    for (cases) |case| try std.testing.expectEqualStrings(case[2], Claude.plan(case[0], case[1]).text());
}
