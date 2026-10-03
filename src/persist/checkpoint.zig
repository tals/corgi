//! Versioned runtime state shared by live handoff and disk recovery. Live state
//! uses compact VT snapshots and application redraw.
const std = @import("std");
const ActorId = @import("../conversations.zig").Actor.Id;
const os = @import("../os.zig");
const a = os.allocator;
const runtime = @import("../runtime.zig");
const workspace = @import("../workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const layout = @import("../layout.zig");
const agents = @import("../agents.zig");
const providers = @import("../providers.zig");
const native = @import("../native.zig");
const NativeId = native.Session.Id;
const conversations = @import("../conversations.zig");
const Terminal = @import("../pane.zig").Terminal;
const binary = @import("../base64.zig");
const pane_label = @import("../pane.zig").label;
const detection = @import("../detection.zig");
const tokens = @import("../usage.zig").tokens;
const agent_order = @import("../agent_order.zig");
const activity_summary = @import("../activity.zig").summary;
const link_labels = @import("../trackers.zig").link_labels;
const launch_command = @import("../launch.zig").command;
const state_migrations = @import("migrations.zig");
const ResumeHint = @import("../resume_hint.zig").ResumeHint;
pub const Screen = struct {
    cols: u16,
    rows: u16,
    data: []const u8,
    pid: i32 = -1,
    fd: i32 = -1,
    exited: bool = true,
    exit_status: i32 = 0,
    initial_input: ?[]const u8 = null,
    pub fn capture(alloc: std.mem.Allocator, t: *Terminal, live: bool) !Screen {
        // Transfer retained terminal state, not every byte ever emitted. Repaint
        // only after the candidate has committed ownership of the live PTY.
        const history = if (live) try t.liveSnapshot() else try t.snapshot();
        defer a.free(history);
        return .{
            .cols = t.vt.cols,
            .rows = t.vt.rows,
            .data = try binary.encode(alloc, history),
            .pid = if (live) t.pid else -1,
            .fd = if (live) t.fd else -1,
            .exited = t.exited,
            .exit_status = t.exit_status,
            .initial_input = if (live) t.initial_input else null,
        };
    }
    pub fn restore(screen: Screen, live: bool) !*Terminal {
        if (screen.cols == 0 or screen.cols > 500 or screen.rows == 0 or screen.rows > 200) return error.InvalidCheckpoint;
        const bytes = try binary.decode(a, screen.data);
        defer a.free(bytes);
        const t = try Terminal.create(screen.cols, screen.rows);
        // Snapshot queries must not reach the still-owned PTY during preparation.
        t.restoring = true;
        defer t.restoring = false;
        t.feed(bytes);
        if (live) {
            if (screen.initial_input) |command| try t.prefill(command);
            t.fd = screen.fd;
            t.pid = screen.pid;
            t.owner = .candidate;
            t.exited = screen.exited;
            t.exit_status = screen.exit_status;
            t.imported = true;
            t.redraw_pending = true;
            if (t.fd >= 0) os.cloexec(t.fd);
        }
        return t;
    }
};
pub const Pane = struct {
    binding: Binding,
    label: pane_label.Label = .{},
    id: layout.PaneId,
    cwd: []const u8,
    screen: Screen,
    detection: detection.Tracker = .{},
    resume_hint: ResumeHint = .{},
    launch: ?runtime.Launch = null,
};
/// A closed agent. Older builds also kept closed shells, which have no
/// resume hint; restore drops those.
pub const Closed = struct {
    label: pane_label.Label = .{},
    cwd: []const u8,
    screen: Screen,
    tab: layout.Tab,
    workspace_id: WorkspaceId,
    resume_hint: ResumeHint = .{},
    launch: ?runtime.Launch = null,
    pane: layout.PaneId = .none,
    tab_index: ?u8 = null,
};
pub const Workspace = struct {
    away: tokens.Window = .{},
    id: WorkspaceId,
    name: []const u8,
    cwd: []const u8,
    model: layout.Model,
    agent_order: []const agent_order.Target = &.{},
    last_agent: ?agents.Provider = null,
};
pub const NativeTurn = struct { thread: []const u8, turn: []const u8 };
pub const Native = struct {
    binding: Binding,
    members: []const ActorId = &.{},
    approval_actors: []const ActorId = &.{},
    usage_tracker: tokens.Tracker = .{},
    observation: agents.observation.State = .{},
    turns: []const NativeTurn = &.{},
    id: NativeId,
    provider: agents.Provider,
    cwd: []const u8,
    workspace_id: WorkspaceId,
    pid: i32,
    stdin: i32,
    stdout: i32,
    ready: bool,
    exited: bool,
    state: agents.State,
    attention: agents.Attention,
    input: []const u8,
    output: []const u8,
    deferred: []const u8,
    events: []const native.Event,
    approvals: []const []const u8,
    tools: []const native.Tool,
    next_seq: u64,
    journal_bytes: usize,
    resume_hint: ResumeHint,
};
pub const Conversation = struct {
    status_inference: activity_summary.Conversation = .{},
    id: ActorId,
    agent: agents.Agent,
    screen_compacting: ?bool = null,
    parent: ?ActorId = null,
    workspace: WorkspaceId = .none,
    observed_at: i64 = 0,
};
pub const Binding = struct {
    actor: ActorId = .none,
    generation: u64 = 1,
    selection_hash: u64 = 0,
    hook_seq: i64 = 0,
    known: []const ActorId = &.{},
    provisional: agents.Agent = .{},
};
pub const State = struct {
    link_labels: link_labels.Cache = .{},
    last_agent: agents.Provider = .codex,
    agent_yolo: providers.Each(bool, false) = .{},
    agent_hidden: providers.Each(bool, false) = .{},
    agent_commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    version: u32 = state_migrations.checkpoint_version,
    conversations: []const Conversation = &.{},
    next_conversation: ActorId = .first,
    live: bool,
    saved_at: i64,
    next_workspace: WorkspaceId,
    next_pane: layout.PaneId,
    next_session: NativeId,
    revision: u64,
    workspaces: []const Workspace,
    panes: []const Pane,
    closed: []const Closed,
    sessions: []const Native,
};
fn historicalAgent(agent: agents.Agent) agents.Agent {
    var result = agent;
    // Losing the transport is not evidence that the conversation ended.
    result.state = if (agent.state == .done) .done else .unknown;
    result.attention = if (result.observation.unread()) .finished else .none;
    // Identity survives even when all receipts have been read.
    result.last_seq = 0;
    result.metadata_protocol_at = 0;
    result.metadata_at = 0;
    result.tool_active = false;
    result.compacting = false;
    result.permission_review = null;
    result.subagents = .{};
    result.observation.pending_stop = false;
    result.transcript = .{};
    return result;
}
pub fn capture(alloc: std.mem.Allocator, r: *runtime.Runtime, live: bool) !State {
    const workspaces = try alloc.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*w, *out| {
        out.* = .{
            .agent_order = try alloc.dupe(agent_order.Target, w.agent_order.slice()),
            .last_agent = w.last_agent,
            .id = w.id,
            .away = w.away,
            .name = w.customName(),
            .cwd = w.cwd,
            .model = w.model,
        };
    }
    const panes = try alloc.alloc(Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        p.refreshCwd();
        p.resume_hint.observe(p.agent());
        out.* = .{
            .id = p.id,
            .label = p.label,
            .cwd = p.cwd,
            .screen = try Screen.capture(alloc, p.terminal, live),
            .binding = try captureBinding(alloc, &p.attachment, live),
            .detection = if (live) p.detection else .{},
            .resume_hint = p.resume_hint,
            .launch = p.launch,
        };
    }
    const closed = try alloc.alloc(Closed, r.closed.items.len);
    for (r.closed.items, closed) |p, *out| out.* = .{
        .label = p.label,
        .cwd = p.cwd,
        .screen = try Screen.capture(alloc, p.terminal, false),
        .tab = p.tab,
        .workspace_id = p.workspace_id,
        .resume_hint = p.resume_hint,
        .launch = p.launch,
        .pane = p.pane,
        .tab_index = p.tab_index,
    };
    const sessions = try alloc.alloc(Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*s, *out| {
        var it = s.active_threads.iterator();
        const turns = try alloc.alloc(NativeTurn, s.active_threads.count());
        for (turns) |*turn| {
            const entry = it.next().?;
            turn.* = .{ .thread = entry.key_ptr.*, .turn = entry.value_ptr.* };
        }
        const members = try alloc.alloc(ActorId, s.members.items.len);
        for (s.members.items, members) |actor, *id| id.* = actor.id;
        const approval_actors = try alloc.alloc(ActorId, s.approvals.items.len);
        for (s.approvals.items, approval_actors) |request, *id| id.* = if (request.actor) |actor| actor.id else .none;
        out.* = .{
            .binding = try captureBinding(alloc, &s.attachment, live),
            .members = members,
            .approval_actors = approval_actors,
            .usage_tracker = s.usage_tracker,
            .id = s.id,
            .provider = s.provider,
            .cwd = s.cwd,
            .workspace_id = s.workspace_id,
            .pid = if (live) s.child.id orelse -1 else -1,
            .stdin = if (live and s.child.stdin != null) s.child.stdin.?.handle else -1,
            .stdout = if (live and s.child.stdout != null) s.child.stdout.?.handle else -1,
            .ready = s.ready,
            .exited = s.exited,
            .state = s.status(),
            .attention = s.attention(),
            .input = try binary.encode(alloc, if (live) s.input.items else ""),
            .output = try binary.encode(alloc, if (live) s.output.items else ""),
            .deferred = try binary.encode(alloc, if (live) s.deferred.items else ""),
            .events = s.events.items,
            .approvals = try s.approvalLines(alloc),
            .turns = turns,
            .observation = s.observation(),
            .tools = s.active_tools.items,
            .next_seq = s.next_seq,
            .journal_bytes = s.journal_bytes,
            .resume_hint = s.resume_hint,
        };
    }
    const actors = try alloc.alloc(Conversation, r.conversations.items.items.len);
    for (r.conversations.items.items, actors) |actor, *out| out.* = .{
        .status_inference = if (live) actor.status_inference else .{},
        .id = actor.id,
        .agent = if (live) actor.state else historicalAgent(actor.state),
        .screen_compacting = live and actor.screen_compacting,
        .parent = actor.parent,
        .workspace = actor.workspace,
        .observed_at = if (live) actor.observed_at else 0,
    };
    return .{
        .link_labels = if (live) r.link_labels else .{},
        .last_agent = r.last_agent,
        .agent_yolo = r.agent_yolo,
        .agent_hidden = r.agent_hidden,
        .agent_commands = r.agent_commands,
        .conversations = actors,
        .next_conversation = r.conversations.next_id,
        .live = live,
        .saved_at = os.timestamp(),
        .next_workspace = r.workspaces.next_id,
        .next_pane = r.workspaces.next_pane_id,
        .next_session = r.next_session,
        .revision = r.revision,
        .workspaces = workspaces,
        .panes = panes,
        .closed = closed,
        .sessions = sessions,
    };
}
// Callers own a staging runtime. Live import errors exit the candidate without
// calling destructors: inherited descriptors are still owned by the old daemon.
pub fn restore(r: *runtime.Runtime, state: State, live: bool, socket: []const u8, executable: []const u8) !void {
    if (state.version != state_migrations.checkpoint_version or state.conversations.len > conversations.max_actors or state.live != live or state.workspaces.len == 0 or
        state.workspaces.len > workspace.max_workspaces or state.panes.len > layout.max_panes or state.closed.len > runtime.closed_per_workspace * workspace.max_workspaces or state.sessions.len > 16) return error.InvalidCheckpoint;
    r.link_labels = if (live) try link_labels.Cache.restore(state.link_labels) else .{};
    for (state.workspaces) |w| {
        if (w.id == WorkspaceId.none or @intFromEnum(w.id) >= @intFromEnum(state.next_workspace) or r.workspaces.index(w.id) != null or !std.fs.path.isAbsolute(w.cwd)) return error.InvalidCheckpoint;
        var item: workspace.Workspace = .{ .agent_order = try agent_order.Order.restore(w.agent_order), .last_agent = w.last_agent, .id = w.id, .away = w.away, .cwd = try a.dupe(u8, w.cwd) };
        item.name_len = agents.clean(&item.name_buf, w.name);
        item.model = w.model;
        for (item.model.tabs[0..item.model.count]) |tab| if (@intFromEnum(tab.id) >= @intFromEnum(state.next_pane)) return error.InvalidCheckpoint;
        item.model.next_id = state.next_pane;
        try r.workspaces.items.append(a, item);
    }
    r.workspaces.next_id = state.next_workspace;
    r.workspaces.next_pane_id = state.next_pane;
    r.next_session = state.next_session;
    r.revision = state.revision +% 1;
    r.last_agent = state.last_agent;
    r.agent_yolo = state.agent_yolo;
    r.agent_hidden = state.agent_hidden;
    r.agent_commands = state.agent_commands;
    for (state.conversations) |saved| {
        if (saved.id == ActorId.none or @intFromEnum(saved.id) >= @intFromEnum(state.next_conversation) or r.conversations.byId(saved.id) != null or
            !validAgent(saved.agent) or saved.agent.session.len == 0) return error.InvalidCheckpoint;
        const provider = saved.agent.provider orelse return error.InvalidCheckpoint;
        if (r.conversations.find(provider, saved.agent.sessionId()) != null) return error.InvalidCheckpoint;
        const actor = try r.conversations.get(provider, saved.agent.sessionId());
        if (saved.status_inference.len > saved.status_inference.recent.len) return error.InvalidCheckpoint;
        actor.status_inference = if (live) saved.status_inference else .{};
        actor.id = saved.id;
        actor.state = if (live) saved.agent else historicalAgent(saved.agent);
        if (live) actor.restoreCompaction(saved.screen_compacting, os.microTimestamp());
        actor.parent = saved.parent;
        actor.workspace = if (r.workspaces.index(saved.workspace) != null) saved.workspace else .none;
        actor.observed_at = if (live) saved.observed_at else 0;
    }
    r.conversations.next_id = state.next_conversation;
    for (r.conversations.items.items) |actor| if (actor.parent) |parent| {
        if (parent == actor.id or r.conversations.byId(parent) == null) return error.InvalidCheckpoint;
    };
    for (state.panes) |p| {
        if (p.id == layout.PaneId.none or @intFromEnum(p.id) >= @intFromEnum(state.next_pane) or r.pane(p.id) != null or r.workspaces.owner(p.id) == null or
            !std.fs.path.isAbsolute(p.cwd)) return error.InvalidCheckpoint;
        const t = try p.screen.restore(live);
        try r.panes.append(a, .{
            .id = p.id,
            .label = p.label,
            .terminal = t,
            .cwd = try a.dupe(u8, p.cwd),
            .attachment = try restoreBinding(&r.conversations, p.binding, live),
            .detection = p.detection,
            .resume_hint = p.resume_hint,
            .launch = p.launch,
        });
    }
    for (r.workspaces.items.items) |w| for (w.model.nodes) |maybe| if (maybe) |n| if (n == .pane and r.pane(n.pane) == null) return error.InvalidCheckpoint;
    for (state.closed) |p| {
        if (p.resume_hint.args() == null or r.workspaces.index(p.workspace_id) == null) continue;
        try r.closed.append(a, .{
            .label = p.label,
            .terminal = try p.screen.restore(false),
            .cwd = try a.dupe(u8, p.cwd),
            .tab = p.tab,
            .workspace_id = p.workspace_id,
            .resume_hint = p.resume_hint,
            .launch = p.launch,
            .pane = p.pane,
            .tab_index = p.tab_index,
        });
    }
    for (state.sessions) |n| {
        if (n.usage_tracker.next_sample >= n.usage_tracker.samples.len or n.usage_tracker.next_tool >= n.usage_tracker.tools.len or
            r.workspaces.index(n.workspace_id) == null) return error.InvalidCheckpoint;
        var s: native.Session = .{
            .usage_tracker = if (live) n.usage_tracker else .{},
            .id = n.id,
            .provider = n.provider,
            .cwd = try a.dupe(u8, n.cwd),
            .workspace_id = n.workspace_id,
            .ready = n.ready,
            .exited = if (live) n.exited else true,
            .attachment = try restoreBinding(&r.conversations, n.binding, live),
            .next_seq = n.next_seq,
            .journal_bytes = n.journal_bytes,
            .resume_hint = n.resume_hint,
            .imported = live,
        };
        if (n.members.len > 256 or (n.approval_actors.len != 0 and n.approval_actors.len != n.approvals.len)) return error.InvalidCheckpoint;
        for (n.members) |id| {
            const actor = r.conversations.byId(id) orelse return error.InvalidCheckpoint;
            if (actor.state.provider != n.provider) return error.InvalidCheckpoint;
            for (s.members.items) |member| if (member == actor) return error.InvalidCheckpoint;
            try s.members.append(a, actor);
        }
        if (n.members.len == 0) if (s.attachment.actor) |actor| try s.members.append(a, actor);
        s.requests_released = s.exited;
        s.child.id = n.pid;
        if (live) s.owner = .candidate;
        if (live and n.stdin >= 0) {
            s.child.stdin = .{ .handle = n.stdin, .flags = .{ .nonblocking = true } };
            os.cloexec(n.stdin);
        }
        if (live and n.stdout >= 0) {
            s.child.stdout = .{ .handle = n.stdout, .flags = .{ .nonblocking = true } };
            os.cloexec(n.stdout);
        }
        s.input = .fromOwnedSlice(try binary.decode(a, n.input));
        s.output = .fromOwnedSlice(try binary.decode(a, n.output));
        s.deferred = .fromOwnedSlice(try binary.decode(a, n.deferred));
        for (n.events) |event| try s.events.append(a, .{ .seq = event.seq, .line = try a.dupe(u8, event.line) });
        if (live) {
            // Join legacy wire arrays once; live requests keep their binding.
            for (n.approvals, 0..) |line, i| {
                const id = if (n.approval_actors.len > 0) n.approval_actors[i] else if (s.attachment.actor) |actor| actor.id else ActorId.none;
                const actor = if (id != ActorId.none) r.conversations.byId(id) orelse return error.InvalidCheckpoint else null;
                try s.approvals.append(a, try .init(n.provider, line, actor));
                if (!s.exited) if (actor) |owner| {
                    owner.pending_native_requests += 1;
                };
            }
            for (n.turns) |turn| {
                try s.active_threads.put(a, try a.dupe(u8, turn.thread), try a.dupe(u8, turn.turn));
            }
            for (n.tools) |tool| try s.active_tools.append(a, .{ .id = try a.dupe(u8, tool.id), .thread = try a.dupe(u8, tool.thread), .turn = try a.dupe(u8, tool.turn) });
        }
        try r.sessions.append(a, s);
    }
    if (!live) {
        for (r.panes.items) |*p| try recoverPane(p, socket, executable, state.saved_at);
        // A native transport has no terminal. Give its saved journal and resume
        // command a shell tab on cold recovery, without auto-starting the agent.
        for (state.sessions) |n| {
            if (n.exited or r.panes.items.len >= layout.max_panes) continue;
            const owner = try r.getWorkspace(n.workspace_id);
            if (owner.model.count == layout.max_tabs) continue;
            const dir = workspace.Store.directory(n.cwd) catch try workspace.Store.directory(os.env("HOME") orelse "/");
            defer a.free(dir);
            const id = try r.create(.{
                .workspace = n.workspace_id,
                .cwd = dir,
                .title = "Recovered native session",
                .cols = 100,
                .rows = 30,
                .theme = .{},
                .socket = socket,
                .executable = executable,
            });
            const pane = r.pane(id).?;
            pane.resume_hint = n.resume_hint;
            pane.attachment = try restoreBinding(&r.conversations, n.binding, false);
            const command = try pane.resume_hint.command(a);
            defer a.free(command);
            for (n.events) |event| {
                // JSON is displayed as text, never replayed as terminal controls.
                const text = try a.dupe(u8, event.line);
                defer a.free(text);
                for (text) |*ch| if (ch.* < 32 or ch.* == 127) {
                    ch.* = ' ';
                };
                pane.terminal.feed(text);
                pane.terminal.feed("\r\n");
            }
            const banner = try pane.resume_hint.banner(a, os.timestamp());
            defer a.free(banner);
            pane.terminal.feed(banner);
            try pane.terminal.prefill(command);
        }
    }
}
fn recoverPane(p: *runtime.Pane, socket: []const u8, executable: []const u8, saved_at: i64) !void {
    const command = try p.resume_hint.command(a);
    defer a.free(command);
    // A missing project directory must not discard its saved contents.
    const dir = workspace.Store.directory(p.cwd) catch try workspace.Store.directory(os.env("HOME") orelse "/");
    defer a.free(dir);
    _ = saved_at;
    const banner = if (command.len > 0) try p.resume_hint.banner(a, os.timestamp()) else try a.dupe(u8, "\x1b[0m\r\n\r\n# Recovered saved output; new shell.\r\n");
    defer a.free(banner);
    p.terminal.feed(banner);
    try p.terminal.spawn(dir, socket, p.id, executable, null, false);
    try p.terminal.prefill(command);
    a.free(p.cwd);
    p.cwd = try a.dupe(u8, dir);
}

fn captureBinding(alloc: std.mem.Allocator, binding: *const conversations.Attachment, live: bool) !Binding {
    return .{
        .actor = if (binding.actor) |actor| actor.id else .none,
        .generation = binding.generation,
        .selection_hash = if (live) binding.selection_hash else 0,
        .hook_seq = if (live) binding.hook_seq else 0,
        .known = if (live) try alloc.dupe(ActorId, binding.known[0..binding.known_len]) else &.{},
        .provisional = if (live) binding.provisional else historicalAgent(binding.provisional),
    };
}
fn validAgent(agent: agents.Agent) bool {
    return agent.observation.read <= agent.observation.completed;
}
fn restoreBinding(registry: *conversations.Registry, value: Binding, live: bool) !conversations.Attachment {
    var binding: conversations.Attachment = .{};
    if (!validAgent(value.provisional) or value.known.len > binding.known.len) return error.InvalidCheckpoint;
    binding.provisional = value.provisional;
    binding.generation = value.generation +% @intFromBool(!live);
    binding.selection_hash = if (live) value.selection_hash else 0;
    binding.hook_seq = if (live) value.hook_seq else 0;
    if (value.actor != ActorId.none) binding.actor = registry.byId(value.actor) orelse return error.InvalidCheckpoint;
    if (live) for (value.known) |id| {
        if (registry.byId(id) == null) return error.InvalidCheckpoint;
        binding.known[binding.known_len] = id;
        binding.known_len += 1;
    };
    return binding;
}
