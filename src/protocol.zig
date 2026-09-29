//! Versioned runtime data. No viewer focus, menus, or screen coordinates belong
//! in a session snapshot. Clients keep selection by the stable IDs below.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const layout = @import("layout.zig");
const surface = @import("surface.zig");
const agents = @import("agents.zig");
const providers = @import("providers.zig");
const native = @import("native.zig");
const NativeId = native.Session.Id;
const agent_order = @import("agent_order.zig");
const git_push = @import("git_push.zig");
const usage = @import("usage.zig");
const live_usage = @import("live_usage.zig");
const context_window = @import("context_window.zig");
const background_tasks = @import("background_tasks.zig");
const inference_setup = @import("inference_setup.zig");
const launch_command = @import("launch_command.zig");
const ports = @import("ports.zig");
const resources = @import("resources.zig");

pub const version: u32 = 1;

/// Error names in a reply's `err` that clients branch on. Other names are
/// shown to the user as they are. Renaming one of these is a protocol change.
pub const Rejection = enum {
    StaleLayout,
    NoPane,
    UnsupportedViewerProtocol,
    UnsupportedProtocol,
    ProtocolRequired,
    AmbiguousViewer,
    GitPreviewChanged,
    GitPushInProgress,
};

/// Every op the server accepts as the wire `"op"` field. Tag names are the
/// exact wire strings (`@tagName` round-trips through `parse`).
pub const Op = enum {
    hello,
    @"session.command",
    @"session.locate",
    @"session.list",
    @"session.snapshot",
    @"session.subscribe",
    @"agent.subscribe",
    @"viewer.open",
    @"viewer.sync",
    @"viewer.search",
    @"pane.acknowledge",
    @"conversation.list",
    @"conversation.acknowledge",
    @"pane.surface",
    @"server.reload",
    @"recovery.save",
    @"inference.configure",
    @"git.push",
    @"onboarding.status",
    @"onboarding.handoff",
    @"onboarding.copy",
    @"agent.command.preview",
    @"agent.preview",
    @"agent.track_usage",
    @"viewer.list",
    action,
    focus,
    @"workspace.switch",
    @"native.start",
    @"native.list",
    @"native.stop",
    @"native.send",
    @"native.events",
    theme,
    hook,
    ping,
    shutdown,
    @"test.settle",
    @"test.advance",
};
pub fn parse(v: std.json.Value) ?Op {
    return std.meta.stringToEnum(Op, agents.str(v, "op"));
}
pub const capabilities = [_]Op{
    .@"session.command",
    .@"session.locate",
    .@"session.list",
    .@"session.snapshot",
    .@"session.subscribe",
    .@"agent.subscribe",
    .@"viewer.open",
    .@"viewer.sync",
    .@"viewer.search",
    .@"pane.acknowledge",
    .@"conversation.list",
    .@"conversation.acknowledge",
    .@"pane.surface",
    .@"server.reload",
    .@"recovery.save",
    .@"inference.configure",
};

pub fn require(v: std.json.Value, negotiated: ?u32) !void {
    const requested = v.object.get("protocol");
    const selected = if (requested) |value| blk: {
        if (value != .integer) return error.UnsupportedProtocol;
        break :blk std.math.cast(u32, value.integer) orelse return error.UnsupportedProtocol;
    } else negotiated orelse return error.ProtocolRequired;
    if (selected != version) return error.UnsupportedProtocol;
}

/// A nonzero wire id as one of the typed ids (`Actor.Id`, `Workspace.Id`, ...).
pub fn typedId(comptime T: type, v: std.json.Value, field: []const u8) !T {
    return @enumFromInt(try id(v, field));
}
pub fn id(v: std.json.Value, field: []const u8) !u32 {
    const value = v.object.get(field) orelse return error.MissingTarget;
    if (value != .integer) return error.InvalidTarget;
    const n = std.math.cast(u32, value.integer) orelse return error.InvalidTarget;
    if (n == 0) return error.InvalidTarget;
    return n;
}

pub const GitCommit = struct { timestamp: i64 = 0, hash: []const u8, subject: []const u8, author: []const u8, date: []const u8 };
pub const Workspace = struct {
    id: WorkspaceId,
    name: []const u8,
    custom_name: []const u8,
    cwd: []const u8,
    model: layout.Model,
    agent_order: []const agent_order.Target = &.{},
    git_commits: []const GitCommit = &.{},
    git_ahead: ?u64 = null,
    git_ref: git_push.RefView = .{},
    git_push: git_push.View = .{},
    stats: usage.Counts = .{},
};
pub const Agent = struct {
    conversation: ActorId = .none,
    subagents: agents.Subagents = .{},
    name: []const u8 = "",
    observation: agents.observation.State = .{},
    recent_activity: []const u8 = "",
    changed_at: i64 = 0,
    /// Null when the pane is not running a known agent.
    provider: ?agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    session: []const u8,
    activity: []const u8,
    cwd: []const u8,
    tool_active: bool,
    compacting: bool = false,

    pub fn providerName(agent: Agent) []const u8 {
        return if (agent.provider) |provider| @tagName(provider) else "agent";
    }
};
pub const Pane = struct {
    binding: u64 = 0,
    name: []const u8 = "",
    id: layout.PaneId,
    workspace: WorkspaceId,
    tab: layout.TabId,
    cwd: []const u8,
    pid: i32,
    cols: u16,
    rows: u16,
    exited: bool,
    agent: Agent,
};
pub const Native = struct {
    agent: ?Agent = null,
    observation: agents.observation.State = .{},
    id: NativeId,
    workspace: WorkspaceId,
    provider: agents.Provider,
    cwd: []const u8,
    ready: bool,
    exited: bool,
    state: agents.State,
    attention: agents.Attention,
    tool_active: bool,
    compacting: bool = false,
};
pub const Conversation = struct {
    pub const ActivityPoint = struct { at: i64, activity: []const u8, usage: live_usage.View };
    pub const Timeline = struct { points: []const ActivityPoint = &.{}, pending: live_usage.View = .{} };
    background_tasks: background_tasks.View = .{},
    id: ActorId,
    timeline: Timeline = .{},
    model: []const u8 = "",
    parent: ?ActorId = null,
    workspace: WorkspaceId = .none,
    observed_at: i64 = 0,
    attachments: u32 = 0,
    role: []const u8 = "",
    usage: live_usage.View = .{},
    context: context_window.View = .{},
    children_observed_at: i64 = 0,
    agent: Agent,
};
pub const Snapshot = struct {
    release_version: []const u8 = "",
    release_commit: []const u8 = "",
    staged_version: []const u8 = "",
    system_model: []const u8 = "",
    inference: inference_setup.Status = .{},
    system_working: bool = false,
    system_usage: live_usage.View = .{},
    last_agent: agents.Provider = .codex,
    agent_yolo: providers.Each(bool, false) = .{},
    agent_hidden: providers.Each(bool, false) = .{},
    agent_commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    conversations: []const Conversation = &.{},
    ports: ports.Snapshot = .{},
    resources: resources.Snapshot = .{},
    type: []const u8 = "session",
    protocol: u32 = version,
    server_pid: i32,
    revision: u64,
    workspaces: []Workspace,
    panes: []const Pane,
    native_sessions: []const Native,
    closed_panes: usize,
};
/// The `onboarding.status` reply. `phase` stays a string because it is also displayed.
pub const OnboardingProgress = struct { phase: []const u8 = "idle", completed: usize = 0, total: usize = 0, workspace: ?WorkspaceId = null, message: []const u8 = "" };
/// A pane a viewer shows, at its size. The daemon sizes each pane for the
/// most recently used viewer showing it.
pub const Interest = struct { pane: layout.PaneId, cols: u16, rows: u16, offset: ?usize = null, known: ?surface.Stamp = null };
/// A request queued for one viewer, delivered in `viewer.sync` until acknowledged by `seq`.
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
const PaneTarget = struct { target: layout.PaneId };
const TabTarget = struct { target: layout.TabId };
const PaneRename = struct { target: layout.PaneId, name: []const u8 };
const TabRename = struct { target: layout.TabId, name: []const u8 };
pub const Beside = struct { other: layout.PaneId, direction: layout.Direction = .right };
pub const Destination = union(enum) { before: layout.TabId, after: layout.TabId, workspace: WorkspaceId };
/// The `session.command` request: one edit to shared session state.
pub const Command = union(enum) {
    @"agent.move": struct { workspace: WorkspaceId, target: agent_order.Target, before: ?agent_order.Target = null },
    @"agent.command": struct {
        index: usize,
        command: []const u8,
        hidden: bool = false,
        name: ?[]const u8 = null,
        original: ?[]const u8 = null,
        semantics: ?launch_command.Semantics = null,
        resolve: bool = true,
        cwd: ?[]const u8 = null,
    },
    @"agent.command.create": struct { workspace: WorkspaceId, cwd: []const u8 = "", index: usize },
    @"agent.visibility": struct { hidden: providers.Each(bool, false) },
    @"agent.yolo": struct { provider: providers.Provider, enabled: bool },
    @"agent.create": struct { workspace: WorkspaceId, cwd: []const u8 = "", provider: ?providers.Provider = null },
    @"pane.create": struct {
        workspace: WorkspaceId,
        from: ?layout.PaneId = null,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.split": struct {
        target: layout.PaneId,
        direction: layout.Direction = .right,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.close": PaneTarget,
    @"tab.close": TabTarget,
    @"pane.restore": struct { workspace: WorkspaceId },
    @"workspace.create": struct { name: []const u8 = "", cwd: []const u8 },
    @"workspace.edit": struct {
        target: WorkspaceId,
        name: ?[]const u8 = null,
        cwd: ?[]const u8 = null,
    },
    @"workspace.close": struct { target: WorkspaceId, close_contents: bool = false },
    @"workspace.move": struct { target: WorkspaceId, before: WorkspaceId },
    @"pane.rename": PaneRename,
    @"tab.rename": TabRename,
    @"pane.swap": struct { target: layout.PaneId, other: layout.PaneId },
    @"pane.resize": struct {
        target: layout.PaneId,
        axis: layout.Axis,
        ratio: u16,
    },
    @"split.resize": struct { target: layout.PaneId, direction: layout.Direction },
    @"split.ratio": struct {
        target: layout.PaneId,
        other: layout.PaneId,
        ratio: u16,
        expected: u64,
    },
    @"pane.move": struct {
        target: layout.PaneId,
        destination: union(enum) { beside: Beside, new_tab: []const u8 },
    },
    @"tab.move": struct { target: layout.TabId, destination: Destination },
    @"tab.merge": struct {
        target: layout.TabId,
        other: layout.PaneId,
        direction: layout.Direction = .right,
    },
    @"pane.read": struct {
        target: layout.PaneId,
        lines: usize = 100,
        view: enum { history, screen } = .history,
    },
    @"pane.send": struct {
        target: layout.PaneId,
        text: []const u8,
        enter: bool = false,
    },
    @"pane.keys": struct { target: layout.PaneId, text: []const u8 },
    @"pane.input": struct { target: layout.PaneId, data: []const u8 },
};
/// The `session.command` reply: where the edit landed.
pub const Result = struct {
    pane: layout.PaneId = .none,
    tab: layout.TabId = .none,
    workspace: WorkspaceId = .none,
    text: ?[]const u8 = null,
    closed_panes: []const layout.PaneId = &.{},
};

/// Freshness stamps in a viewer's snapshot are rounded down to this.
pub const stamp_bucket = 5 * std.time.us_per_s;

test "shared arrangement round trip is independent of viewer selection" {
    var original: layout.Model = .{};
    const first = try original.newTab("first");
    const split = try original.split(first, .horizontal);
    _ = try original.newTab("second");
    var selection: layout.Selection = .{};
    selection.reconcile(&original);
    try selection.focus(&original, first);
    selection.tab().zoom = true;
    original.moveTab(original.tabs[1].id, 0);
    try original.close(split);
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const encoded = try std.json.Stringify.valueAlloc(arena.allocator(), original, .{});
    const parsed = try std.json.parseFromSlice(layout.Model, arena.allocator(), encoded, .{});
    const restored = parsed.value;
    selection.reconcile(&restored);
    try std.testing.expectEqual(first, selection.tab().focus);
    try std.testing.expectEqual(@as(usize, 1), selection.active);
    try std.testing.expect(selection.tab().zoom);
}
