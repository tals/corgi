//! Versioned runtime data. No viewer focus, menus, or screen coordinates belong
//! in a session snapshot. Clients keep selection by the stable IDs below.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const layout = @import("layout.zig");
const runtime = @import("runtime.zig");
const agents = @import("agents.zig");
const native = @import("native.zig");
const NativeId = native.Session.Id;
const os = @import("os.zig");
const options = @import("corgi_options");
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
    agent_yolo: [2]bool = .{ false, false },
    agent_hidden: [2]bool = .{ false, false },
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

fn agentView(state: *const agents.Agent, conversation: ActorId) Agent {
    return .{
        .conversation = conversation,
        .subagents = state.subagents,
        .changed_at = state.changed_at,
        .provider = state.provider,
        .state = state.state,
        .attention = state.attention,
        .observation = state.observation,
        .recent_activity = state.recentLabel(),
        .name = state.displayName(),
        .session = state.sessionId(),
        .activity = state.activity[0..state.activity_len],
        .cwd = state.directory(),
        .tool_active = state.tool_active,
        .compacting = state.compacting,
    };
}

/// Allocate containers in a request arena; strings borrow the runtime until
/// serialization completes. Process resources remain in the runtime.
pub fn snapshot(allocator: std.mem.Allocator, r: *runtime.Runtime) !Snapshot {
    return build(allocator, r, false);
}
/// A viewer syncs every 30 ms and gets a new session only when this copy's
/// hash changes. It leaves out what moves while nothing shown changes: the
/// revision, which every PTY read bumps, and freshness stamps finer than
/// `stamp_bucket`, which the viewer only compares against a window.
pub fn viewerSnapshot(allocator: std.mem.Allocator, r: *runtime.Runtime) !Snapshot {
    return build(allocator, r, true);
}
pub const stamp_bucket = 5 * std.time.us_per_s;
fn coarse(stamp: i64) i64 {
    return if (stamp <= 0) stamp else @divFloor(stamp, stamp_bucket) * stamp_bucket;
}
fn build(allocator: std.mem.Allocator, r: *runtime.Runtime, viewer: bool) !Snapshot {
    const workspaces = try allocator.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*ws, *out| {
        const commits = try allocator.alloc(GitCommit, ws.git_commits.len);
        for (ws.git_commits.items[0..ws.git_commits.len], commits) |*commit, *dest| {
            dest.* = .{
                .timestamp = commit.timestamp,
                .hash = commit.hash.text(),
                .subject = commit.subject.text(),
                .author = commit.author.text(),
                .date = commit.date.text(),
            };
        }
        out.* = .{
            .agent_order = ws.agent_order.slice(),
            .git_commits = commits,
            .id = ws.id,
            .name = ws.name(),
            .cwd = ws.cwd,
            .custom_name = ws.customName(),
            .git_ahead = ws.git_ahead,
            .git_ref = ws.git_ref.view(),
            .git_push = ws.git_push.view(),
            .stats = ws.away.counts,
            .model = ws.model,
        };
    }
    const panes = try allocator.alloc(Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        const owner = r.workspaces.owner(p.id) orelse return error.NoWorkspace;
        const tab = owner.model.tabForPane(p.id) orelse return error.NoTab;
        out.* = .{
            .id = p.id,
            .binding = p.attachment.generation,
            .name = p.label.text(),
            .workspace = owner.id,
            .tab = owner.model.tabs[tab].id,
            .cwd = p.cwd,
            .pid = p.terminal.pid,
            .cols = p.terminal.vt.cols,
            .rows = p.terminal.vt.rows,
            .exited = p.terminal.exited,
            .agent = agentView(p.agent(), if (p.attachment.actor) |actor| actor.id else .none),
        };
    }
    const sessions = try allocator.alloc(Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*session, *out| out.* = .{
        .agent = agentView(session.attachment.agent(), if (session.attachment.actor) |actor| actor.id else .none),
        .id = session.id,
        .workspace = session.workspace_id,
        .provider = session.provider,
        .cwd = session.cwd,
        .ready = session.ready,
        .exited = session.exited,
        .state = session.status(),
        .attention = session.attention(),
        .observation = session.observation(),
        .tool_active = session.toolActive(),
    };
    const conversations = try allocator.alloc(Conversation, r.conversations.items.items.len);
    for (r.conversations.items.items, conversations) |actor, *out| {
        const current_usage = actor.usageView(std.time.milliTimestamp());
        const points = try allocator.alloc(Conversation.ActivityPoint, actor.activity_timeline.len);
        for (actor.activity_timeline.points[0..actor.activity_timeline.len], points) |*point, *dst| {
            dst.* = .{ .at = point.at, .activity = point.label.text(), .usage = point.usage };
        }
        var attachments: u32 = 0;
        for (r.panes.items) |p| if (!p.terminal.exited and p.attachment.actor == actor) {
            attachments += 1;
        };
        for (r.sessions.items) |native_session| if (!native_session.exited) {
            for (native_session.members.items) |member| if (member == actor) {
                attachments += 1;
                break;
            };
        };
        out.* = .{
            .id = actor.id,
            .parent = actor.parent,
            .workspace = actor.workspace,
            .observed_at = actor.observed_at,
            .attachments = attachments,
            .role = actor.role.text(),
            .background_tasks = try actor.background_tasks.view(allocator),
            .model = actor.model.text(),
            .usage = current_usage,
            .context = actor.context.view(&r.conversations.compaction_points),
            .timeline = .{ .points = points, .pending = actor.activity_timeline.pending(current_usage) },
            .children_observed_at = actor.children_observed_at,
            .agent = agentView(&actor.state, actor.id),
        };
        if (viewer) {
            out.observed_at = coarse(out.observed_at);
            out.children_observed_at = coarse(out.children_observed_at);
            out.background_tasks.observed_at = coarse(out.background_tasks.observed_at);
        }
    }
    return .{
        .conversations = conversations,
        .release_version = options.release_version,
        .release_commit = options.release_commit,
        .staged_version = r.staged_version,
        .system_model = r.system_model,
        .inference = r.inference,
        .system_usage = r.system_usage,
        .system_working = r.system_working,
        .server_pid = os.c.getpid(),
        .ports = try r.link_labels.snapshot(allocator, r.ports.current),
        .resources = r.resources.current,
        .revision = if (viewer) 0 else r.revision,
        .last_agent = r.last_agent,
        .agent_yolo = r.agent_yolo,
        .agent_hidden = r.agent_hidden,
        .agent_commands = r.agent_commands,
        .workspaces = workspaces,
        .panes = panes,
        .native_sessions = sessions,
        .closed_panes = r.closed.items.len,
    };
}

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

test "a viewer's snapshot stays byte-stable while only output and stamps move" {
    var r: runtime.Runtime = .{};
    defer r.deinit();
    _ = try r.workspaces.add("stable", "/tmp");
    const actor = try r.conversations.get(.codex, "stable");
    actor.observed_at = 10 * std.time.us_per_s + 1;
    actor.children_observed_at = actor.observed_at;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const before = try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{});
    // A PTY read bumps the revision; a later observation lands in the same bucket.
    r.changed();
    actor.observed_at += std.time.us_per_s;
    actor.children_observed_at = actor.observed_at;
    try std.testing.expectEqualStrings(before, try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{}));
    try std.testing.expect(!std.mem.eql(u8, before, try std.json.Stringify.valueAlloc(alloc, try snapshot(alloc, &r), .{})));
    actor.observed_at += stamp_bucket;
    try std.testing.expect(!std.mem.eql(u8, before, try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{})));
}
