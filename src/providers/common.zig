//! Borrowed, normalized provider facts. Parsing never mutates conversation state.
const std = @import("std");
pub const Outcome = @import("../observation.zig").Outcome;
const BoundedText = @import("../bounded_text.zig").BoundedText;
const json = @import("../json.zig");

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

/// Static facts about an agent's CLI and files.
pub const Info = struct {
    /// Product name for launcher rows.
    label: []const u8,
    /// Short name for compact menus and sentences.
    name: []const u8,
    /// Launcher key that starts this agent.
    launcher_key: u8,

    // Process identification.
    /// Executable basenames. The first is the command Corgi runs.
    executables: []const []const u8,
    /// Path fragments of versioned installs that run without a known basename.
    install_markers: []const []const u8 = &.{},
    /// Script paths run by node/bun, matched as suffixes.
    scripts: []const []const u8 = &.{},
    /// Package runners (`bunx`, `bun x`) name this package, optionally `@version`.
    package: []const u8,

    // Discovery.
    /// Environment variable naming the executable to use.
    binary_env: [:0]const u8,
    /// Install locations relative to $HOME, then absolute ones.
    home_paths: []const []const u8,
    system_paths: []const []const u8,
    /// macOS app bundles that embed the CLI at Contents/Resources/<command>.
    app_bundles: []const []const u8 = &.{},
    /// `--version` output prefix that proves a candidate works. Without one,
    /// discovery leaves the lookup to PATH at exec time.
    version_prefix: ?[]const u8 = null,

    // Configuration and accounts.
    /// Environment variable overriding the configuration directory, and its
    /// default under $HOME.
    config_env: [:0]const u8,
    config_dir: []const u8,
    /// Hook settings file inside the configuration directory.
    hooks_file: []const u8,
    /// File naming the signed-in account, and the directory holding it when
    /// only HOME is overridden.
    account_file: []const u8,
    account_home: []const u8,
    /// Environment variables that replace the default account's credentials.
    credential_env: []const []const u8,
    /// Environment variable holding an explicit OAuth token.
    oauth_env: ?[]const u8 = null,
    /// Environment variables (or `PREFIX_*` patterns) that change the endpoint
    /// or backing provider.
    endpoint_env: []const []const u8,
    /// Environment variable selecting the model.
    model_env: ?[]const u8 = null,
    /// Flags selecting a named profile (taking a value) or custom settings.
    profile_flags: []const []const u8,
    settings_flags: []const []const u8,
    /// Flag that skips permission prompts.
    yolo_flag: []const u8,
    /// Model Corgi uses for activity summaries on the user's login.
    summary_model: []const u8,

    // Lifecycle evidence.
    /// Hooks and transcripts carry no turn id or commentary: prompt ids key
    /// turns, and the current tool is the activity.
    prompt_turns: bool = false,
    screen: Screen = .{},
};

/// A session id, or the truncated prefix of one, shown in a terminal title.
pub const SessionPrefix = BoundedText(36);

/// Terminal UI signals, used only when no hook or protocol evidence is current.
pub const Screen = struct {
    /// Title text shown while waiting for approval.
    blocked_title: ?[]const u8 = null,
    /// Title prefix shown while idle.
    idle_title: ?[]const u8 = null,
    /// A row starting with this composer marker means the agent is idle.
    idle_prompt: ?[]const u8 = null,
    /// The status row counts running background terminals.
    background_status: bool = false,
    /// Protocol state has no compaction flag; the status row supplies it.
    compaction_status: bool = false,
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

/// `hook_event_name` values Claude's and Codex's hook payloads carry.
pub const HookEvent = enum { SessionStart, UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, PreCompact, PostCompact, Stop, Interrupt, SessionEnd, Notification };
/// `notification_type` values that surface as a hook, versus ones ignored
/// (e.g. `idle_prompt`, which follows every finished turn after a minute).
pub const NotificationType = enum { permission_prompt, elicitation_dialog };

/// Claude and Codex currently share this hook envelope, not lifecycle state.
pub const Hooks = struct {
    pub fn decode(_: Hooks, value: std.json.Value) ?Hook {
        if (value != .object or str(value, "agent_id").len != 0) return null;
        const event = std.meta.stringToEnum(HookEvent, str(value, "hook_event_name")) orelse return null;
        const notification = std.meta.stringToEnum(NotificationType, str(value, "notification_type"));
        const tool = str(value, "tool_name");
        const kind: @FieldType(Hook, "kind") = switch (event) {
            .SessionStart => .session_start,
            .UserPromptSubmit => .prompt,
            .PreToolUse => .tool_start,
            .PostToolUse => .tool_finish,
            .PostToolUseFailure => .tool_failure,
            .PermissionRequest => .permission,
            .PreCompact => .compact_start,
            .PostCompact => .compact_end,
            .Stop => .stop,
            .Interrupt => .interrupt,
            .SessionEnd => .session_end,
            // Stop already made the agent idle, not blocked; only a real
            // permission or elicitation notification reopens it.
            .Notification => if (notification != null) .notification else return null,
        };
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
            .asking = kind == .tool_start and (std.mem.eql(u8, tool, "AskUserQuestion") or std.mem.eql(u8, tool, "request_user_input")),
            .permission_notification = kind == .notification and notification == .permission_prompt,
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

pub const field = json.field;
pub const str = json.str;
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
