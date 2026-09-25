//! Versioned runtime data. No viewer focus, menus, or screen coordinates belong
//! in a session snapshot. Clients keep selection by the stable IDs below.
const std = @import("std");
const layout = @import("layout.zig");
const runtime = @import("runtime.zig");
const agents = @import("agents.zig");

pub const version: u32 = 1;
pub const capabilities = [_][]const u8{
    "session.command",
    "session.locate",
    "session.list",
    "session.snapshot",
    "session.subscribe",
    "viewer.open",
    "viewer.sync",
    "viewer.search",
    "pane.acknowledge",
    "conversation.list",
    "conversation.acknowledge",
    "pane.surface",
    "server.reload",
    "recovery.save",
    "inference.configure",
};

pub fn require(v: std.json.Value, negotiated: ?u32) !void {
    const requested = v.object.get("protocol");
    const selected = if (requested) |value| blk: {
        if (value != .integer) return error.UnsupportedProtocol;
        break :blk std.math.cast(u32, value.integer) orelse return error.UnsupportedProtocol;
    } else negotiated orelse return error.ProtocolRequired;
    if (selected != version) return error.UnsupportedProtocol;
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
    id: u32,
    name: []const u8,
    custom_name: []const u8,
    cwd: []const u8,
    model: layout.Model,
    git_commits: []const GitCommit = &.{},
    git_ahead: ?u64 = null,
    stats: @import("usage.zig").Counts = .{},
};
pub const Agent = struct {
    conversation: u32 = 0,
    subagents: agents.Subagents = .{},
    name: []const u8 = "",
    observation: agents.observation.State = .{},
    recent_activity: []const u8 = "",
    changed_at: i64 = 0,
    provider: agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    session: []const u8,
    activity: []const u8,
    cwd: []const u8,
    tool_active: bool,
    compacting: bool = false,
    step: []const u8 = "",
    step_status: agents.StepStatus = .none,
};
pub const Pane = struct {
    binding: u64 = 0,
    name: []const u8 = "",
    id: u32,
    workspace: u32,
    tab: u32,
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
    id: u32,
    workspace: u32,
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
    pub const ActivityPoint = struct { at: i64, activity: []const u8, usage: @import("live_usage.zig").View, steps: u32 = 0 };
    pub const Timeline = struct { points: []const ActivityPoint = &.{}, pending: @import("live_usage.zig").View = .{} };
    background_tasks: @import("background_tasks.zig").View = .{},
    id: u32,
    timeline: Timeline = .{},
    model: []const u8 = "",
    parent: ?u32 = null,
    workspace: u32 = 0,
    observed_at: i64 = 0,
    attachments: u32 = 0,
    role: []const u8 = "",
    usage: @import("live_usage.zig").View = .{},
    children_observed_at: i64 = 0,
    agent: Agent,
};
pub const Snapshot = struct {
    system_model: []const u8 = "",
    inference: @import("inference_setup.zig").Status = .{},
    system_working: bool = false,
    system_usage: @import("live_usage.zig").View = .{},
    last_agent: @import("agent_launcher.zig").Provider = .codex,
    agent_yolo: [2]bool = .{ false, false },
    conversations: []const Conversation = &.{},
    ports: @import("ports.zig").Snapshot = .{},
    type: []const u8 = "session",
    protocol: u32 = version,
    server_pid: i32,
    revision: u64,
    workspaces: []Workspace,
    panes: []const Pane,
    native_sessions: []const Native,
    closed_panes: usize,
};

fn agentView(state: *const agents.Agent, conversation: u32) Agent {
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
        .step = state.stepLabel(),
        .step_status = state.step_status,
    };
}

/// Allocate containers in a request arena; strings borrow the runtime until
/// serialization completes. Process resources remain in the runtime.
pub fn snapshot(allocator: std.mem.Allocator, r: *runtime.Runtime) !Snapshot {
    const workspaces = try allocator.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*ws, *out| {
        const commits = try allocator.alloc(GitCommit, ws.git_commits.len);
        for (ws.git_commits.items[0..ws.git_commits.len], commits) |*commit, *dest| {
            dest.* = .{ .timestamp = commit.timestamp, .hash = commit.hash[0..commit.hash_len], .subject = commit.subject[0..commit.subject_len], .author = commit.author[0..commit.author_len], .date = commit.date[0..commit.date_len] };
        }
        out.* = .{ .git_commits = commits, .id = ws.id, .name = ws.name(), .cwd = ws.cwd, .custom_name = ws.customName(), .git_ahead = ws.git_ahead, .stats = ws.away.counts, .model = ws.model };
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
            .agent = agentView(p.agent(), if (p.attachment.actor) |actor| actor.id else 0),
        };
    }
    const sessions = try allocator.alloc(Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*session, *out| out.* = .{
        .agent = agentView(session.attachment.agent(), if (session.attachment.actor) |actor| actor.id else 0),
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
            dst.* = .{ .at = point.at, .activity = point.label.text(), .usage = point.usage, .steps = point.steps };
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
            .role = actor.role[0..actor.role_len],
            .background_tasks = try actor.background_tasks.view(allocator),
            .model = actor.model.bytes[0..actor.model.len],
            .usage = current_usage,
            .timeline = .{ .points = points, .pending = actor.activity_timeline.pending(current_usage) },
            .children_observed_at = actor.children_observed_at,
            .agent = agentView(&actor.state, actor.id),
        };
    }
    return .{
        .conversations = conversations,
        .system_model = r.system_model,
        .inference = r.inference,
        .system_usage = r.system_usage,
        .system_working = r.system_working,
        .server_pid = @import("os.zig").c.getpid(),
        .ports = try r.link_labels.snapshot(allocator, r.ports.current),
        .revision = r.revision,
        .last_agent = r.last_agent,
        .agent_yolo = r.agent_yolo,
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
