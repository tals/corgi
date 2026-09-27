//! Versioned runtime state shared by live handoff and disk recovery. Live state
//! uses compact VT snapshots and application redraw.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const os = @import("os.zig");
const a = os.allocator;
const runtime = @import("runtime.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const native = @import("native.zig");
const NativeId = native.Session.Id;
const conversations = @import("conversations.zig");
const Terminal = @import("terminal.zig").Terminal;
const binary = @import("base64.zig");
pub const Resume = struct {
    name: [160]u8 = @splat(0),
    name_len: usize = 0,
    touched_at: i64 = 0,
    provider: ?agents.Provider = null,
    session: [160]u8 = .{0} ** 160,
    len: usize = 0,
    pub fn observe(r: *Resume, agent: *const agents.Agent) void {
        const provider = agent.provider orelse return;
        if (agent.session_len > 0) {
            if (r.provider != provider or !std.mem.eql(u8, r.session[0..r.len], agent.sessionId())) {
                r.name_len = 0;
                r.touched_at = 0;
            }
            if (agent.name_len > 0) {
                r.name = agent.name;
                r.name_len = agent.name_len;
            }
            r.touched_at = @max(r.touched_at, @max(agent.updated_at, @divTrunc(agent.changed_at, std.time.us_per_s)));
            r.provider = provider;
            r.session = agent.session;
            r.len = agent.session_len;
        } else if (r.provider == null) r.provider = provider;
    }
    pub fn banner(r: Resume, alloc: std.mem.Allocator, now: i64) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try out.writer.writeAll("\x1b[0m\r\n\r\n");
        if (r.name_len > 0 and r.name_len <= r.name.len) {
            try out.writer.writeAll("# ");
            for (r.name[0..r.name_len]) |ch| try out.writer.writeByte(if (ch < 32 or ch == 127) ' ' else ch);
            try out.writer.writeAll("\r\n");
        }
        if (r.touched_at > 0) {
            const seconds = @max(0, now - r.touched_at);
            try out.writer.writeAll("\x1b[2m# Last active ");
            if (seconds < 60) try out.writer.writeAll("just now") else {
                const unit: i64 = if (seconds < 3600) 60 else if (seconds < 86400) 3600 else 86400;
                const label: []const u8 = if (unit == 60) "minute" else if (unit == 3600) "hour" else "day";
                const count = @divTrunc(seconds, unit);
                try out.writer.print("{d} {s}{s} ago", .{ count, label, if (count == 1) "" else "s" });
            }
            try out.writer.writeAll("\x1b[0m\r\n");
        }
        return out.toOwnedSlice();
    }
    pub fn command(r: Resume, alloc: std.mem.Allocator) ![]const u8 {
        const provider = r.provider orelse return alloc.dupe(u8, "");
        if (r.len == 0 or r.len > r.session.len) return alloc.dupe(u8, "");
        for (r.session[0..r.len]) |ch| if (ch < 32 or ch == 127) return alloc.dupe(u8, "");
        const argv = try provider.backend().resumeArgs(.{ .id = r.session[0..r.len] });
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try out.writer.print("{s} {s} '", .{ argv[0], argv[1] });
        for (argv[2]) |ch| {
            if (ch == '\'') try out.writer.writeAll("'\\''") else try out.writer.writeByte(ch);
        }
        try out.writer.writeByte('\'');
        return out.toOwnedSlice();
    }
};
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
        return .{ .cols = t.vt.cols, .rows = t.vt.rows, .data = try binary.encode(alloc, history), .pid = if (live) t.pid else -1, .fd = if (live) t.fd else -1, .exited = t.exited, .exit_status = t.exit_status, .initial_input = if (live) t.initial_input else null };
    }
    pub fn restore(screen: Screen, live: bool) !*Terminal {
        if (screen.cols == 0 or screen.cols > 500 or screen.rows == 0 or screen.rows > 200) return error.InvalidCheckpoint;
        const bytes = try binary.decode(a, screen.data);
        defer a.free(bytes);
        const t = try Terminal.create(screen.cols, screen.rows);
        // Snapshot queries must not reach the still-owned PTY during preparation.
        t.restoring = true;
        t.feed(bytes);
        t.restoring = false;
        if (live) {
            if (screen.initial_input) |command| try t.prefill(command);
            t.fd = screen.fd;
            t.pid = screen.pid;
            t.exited = screen.exited;
            t.exit_status = screen.exit_status;
            t.imported = true;
            t.redraw_pending = true;
            if (t.fd >= 0) os.cloexec(t.fd);
        }
        return t;
    }
};
pub const Pane = struct { binding: Binding, label: @import("pane_label.zig").Label = .{}, id: layout.PaneId, cwd: []const u8, screen: Screen, agent: agents.Agent = .{}, detection: @import("detection.zig").Tracker = .{}, resume_hint: Resume = .{} };
pub const Closed = struct { label: @import("pane_label.zig").Label = .{}, cwd: []const u8, screen: Screen, tab: layout.Tab, workspace_id: WorkspaceId };
pub const Workspace = struct {
    away: @import("usage.zig").Window = .{},
    id: WorkspaceId,
    name: []const u8,
    cwd: []const u8,
    model: layout.Model,
    agent_order: []const @import("agent_order.zig").Target = &.{},
};
pub const NativeTurn = struct { thread: []const u8, turn: []const u8 };
pub const Native = struct {
    binding: Binding,
    members: []const ActorId = &.{},
    approval_actors: []const ActorId = &.{},
    usage_tracker: @import("usage.zig").Tracker = .{},
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
    resume_hint: Resume,
};
pub const Conversation = struct {
    status_inference: @import("activity_summary.zig").Conversation = .{},
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
    link_labels: @import("link_labels.zig").Cache = .{},
    last_agent: agents.Provider = .codex,
    agent_yolo: [2]bool = .{ false, false },
    agent_hidden: [2]bool = .{ false, false },
    agent_commands: [@import("launch_command.zig").capacity]@import("launch_command.zig").Entry = @splat(.{}),
    version: u32 = @import("state_migrations.zig").checkpoint_version,
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
    result.tool_active = false;
    result.compacting = false;
    result.permission_review = null;
    result.subagents = .{};
    result.observation.pending_stop = false;
    result.transcript_len = 0;
    return result;
}
pub fn capture(alloc: std.mem.Allocator, r: *runtime.Runtime, live: bool) !State {
    const workspaces = try alloc.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*w, *out| {
        out.* = .{ .agent_order = try alloc.dupe(@import("agent_order.zig").Target, w.agent_order.slice()), .id = w.id, .away = w.away, .name = w.customName(), .cwd = w.cwd, .model = w.model };
    }
    const panes = try alloc.alloc(Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        p.refreshCwd();
        p.resume_hint.observe(p.agent());
        out.* = .{ .id = p.id, .label = p.label, .cwd = p.cwd, .screen = try Screen.capture(alloc, p.terminal, live), .binding = try captureBinding(alloc, &p.attachment, live), .agent = if (live) p.agent().* else historicalAgent(p.agent().*), .detection = if (live) p.detection else .{}, .resume_hint = p.resume_hint };
    }
    const closed = try alloc.alloc(Closed, r.closed.items.len);
    for (r.closed.items, closed) |p, *out| out.* = .{ .label = p.label, .cwd = p.cwd, .screen = try Screen.capture(alloc, p.terminal, false), .tab = p.tab, .workspace_id = p.workspace_id };
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
        out.* = .{ .binding = try captureBinding(alloc, &s.attachment, live), .members = members, .approval_actors = approval_actors, .usage_tracker = s.usage_tracker, .id = s.id, .provider = s.provider, .cwd = s.cwd, .workspace_id = s.workspace_id, .pid = if (live) s.child.id else -1, .stdin = if (live and s.child.stdin != null) s.child.stdin.?.handle else -1, .stdout = if (live and s.child.stdout != null) s.child.stdout.?.handle else -1, .ready = s.ready, .exited = s.exited, .state = s.status(), .attention = s.attention(), .input = try binary.encode(alloc, if (live) s.input.items else ""), .output = try binary.encode(alloc, if (live) s.output.items else ""), .deferred = try binary.encode(alloc, if (live) s.deferred.items else ""), .events = s.events.items, .approvals = try s.approvalLines(alloc), .turns = turns, .observation = s.observation(), .tools = s.active_tools.items, .next_seq = s.next_seq, .journal_bytes = s.journal_bytes, .resume_hint = s.resume_hint };
    }
    const actors = try alloc.alloc(Conversation, r.conversations.items.items.len);
    for (r.conversations.items.items, actors) |actor, *out| out.* = .{ .status_inference = if (live) actor.status_inference else .{}, .id = actor.id, .agent = if (live) actor.state else historicalAgent(actor.state), .screen_compacting = live and actor.screen_compacting, .parent = actor.parent, .workspace = actor.workspace, .observed_at = if (live) actor.observed_at else 0 };
    return .{ .link_labels = if (live) r.link_labels else .{}, .last_agent = r.last_agent, .agent_yolo = r.agent_yolo, .agent_hidden = r.agent_hidden, .agent_commands = r.agent_commands, .conversations = actors, .next_conversation = r.conversations.next_id, .live = live, .saved_at = std.time.timestamp(), .next_workspace = r.workspaces.next_id, .next_pane = r.workspaces.next_pane_id, .next_session = r.next_session, .revision = r.revision, .workspaces = workspaces, .panes = panes, .closed = closed, .sessions = sessions };
}
// Callers own a staging runtime. Live import errors exit the candidate without
// calling destructors: inherited descriptors are still owned by the old daemon.
pub fn restore(r: *runtime.Runtime, state: State, live: bool, socket: []const u8, executable: []const u8) !void {
    if (state.version != @import("state_migrations.zig").checkpoint_version or state.conversations.len > conversations.max_actors or state.live != live or state.workspaces.len == 0 or state.workspaces.len > workspace.max_workspaces or
        state.panes.len > layout.max_panes or state.closed.len > 8 or state.sessions.len > 16) return error.InvalidCheckpoint;
    r.link_labels = if (live) try @import("link_labels.zig").Cache.restore(state.link_labels) else .{};
    for (state.workspaces) |w| {
        if (w.id == WorkspaceId.none or @intFromEnum(w.id) >= @intFromEnum(state.next_workspace) or r.workspaces.index(w.id) != null or !std.fs.path.isAbsolute(w.cwd)) return error.InvalidCheckpoint;
        var item: workspace.Workspace = .{ .agent_order = try @import("agent_order.zig").Order.restore(w.agent_order), .id = w.id, .away = w.away, .cwd = try a.dupe(u8, w.cwd) };
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
        if (saved.id == ActorId.none or @intFromEnum(saved.id) >= @intFromEnum(state.next_conversation) or r.conversations.byId(saved.id) != null or !validAgent(saved.agent) or saved.agent.session_len == 0) return error.InvalidCheckpoint;
        const provider = saved.agent.provider orelse return error.InvalidCheckpoint;
        if (r.conversations.find(provider, saved.agent.sessionId()) != null) return error.InvalidCheckpoint;
        const actor = try r.conversations.get(provider, saved.agent.sessionId());
        if (saved.status_inference.len > saved.status_inference.recent.len or saved.status_inference.previous.len > saved.status_inference.previous.bytes.len) return error.InvalidCheckpoint;
        for (saved.status_inference.recent) |entry| if (entry.len > entry.bytes.len) return error.InvalidCheckpoint;
        actor.status_inference = if (live) saved.status_inference else .{};
        actor.id = saved.id;
        actor.state = if (live) saved.agent else historicalAgent(saved.agent);
        if (live) actor.restoreCompaction(saved.screen_compacting, std.time.microTimestamp());
        actor.parent = saved.parent;
        actor.workspace = if (r.workspaces.index(saved.workspace) != null) saved.workspace else .none;
        actor.observed_at = if (live) saved.observed_at else 0;
    }
    r.conversations.next_id = state.next_conversation;
    for (r.conversations.items.items) |actor| if (actor.parent) |parent| {
        if (parent == actor.id or r.conversations.byId(parent) == null) return error.InvalidCheckpoint;
    };
    for (state.panes) |p| {
        if (p.label.len > p.label.bytes.len or p.id == layout.PaneId.none or @intFromEnum(p.id) >= @intFromEnum(state.next_pane) or r.pane(p.id) != null or r.workspaces.owner(p.id) == null or
            !std.fs.path.isAbsolute(p.cwd) or p.resume_hint.len > p.resume_hint.session.len or p.agent.session_len > 160 or p.agent.cwd_len > p.agent.cwd.len or
            p.agent.transcript_len > p.agent.transcript.len or p.agent.turn_len > 160 or
            p.agent.last_finished_turn_len > 160 or p.agent.recent_len > 160 or p.agent.observation.read > p.agent.observation.completed) return error.InvalidCheckpoint;
        const t = try p.screen.restore(live);
        try r.panes.append(a, .{ .id = p.id, .label = p.label, .terminal = t, .cwd = try a.dupe(u8, p.cwd), .attachment = try restoreBinding(&r.conversations, p.binding, live), .detection = p.detection, .resume_hint = p.resume_hint });
    }
    for (r.workspaces.items.items) |w| for (w.model.nodes) |maybe| if (maybe) |n| if (n == .pane and r.pane(n.pane) == null) return error.InvalidCheckpoint;
    for (state.closed) |p| {
        if (p.label.len > p.label.bytes.len) return error.InvalidCheckpoint;
        try r.closed.append(a, .{ .label = p.label, .terminal = try p.screen.restore(false), .cwd = try a.dupe(u8, p.cwd), .tab = p.tab, .workspace_id = p.workspace_id });
    }
    for (state.sessions) |n| {
        if (n.resume_hint.len > 160 or n.usage_tracker.next_sample >= n.usage_tracker.samples.len or n.usage_tracker.next_tool >= n.usage_tracker.tools.len or r.workspaces.index(n.workspace_id) == null) return error.InvalidCheckpoint;
        var s: native.Session = .{ .usage_tracker = if (live) n.usage_tracker else .{}, .id = n.id, .provider = n.provider, .cwd = try a.dupe(u8, n.cwd), .workspace_id = n.workspace_id, .child = std.process.Child.init(&.{}, a), .ready = n.ready, .exited = if (live) n.exited else true, .attachment = try restoreBinding(&r.conversations, n.binding, live), .next_seq = n.next_seq, .journal_bytes = n.journal_bytes, .resume_hint = n.resume_hint, .imported = live };
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
        if (live and n.stdin >= 0) {
            s.child.stdin = .{ .handle = n.stdin };
            os.cloexec(n.stdin);
        }
        if (live and n.stdout >= 0) {
            s.child.stdout = .{ .handle = n.stdout };
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
                try s.approvals.append(a, .{ .line = try a.dupe(u8, line), .actor = actor });
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
            const id = try r.create(.{ .workspace = n.workspace_id, .cwd = dir, .title = "Recovered native session", .cols = 100, .rows = 30, .theme = .{}, .socket = socket, .executable = executable });
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
            const banner = try pane.resume_hint.banner(a, std.time.timestamp());
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
    const banner = if (command.len > 0) try p.resume_hint.banner(a, std.time.timestamp()) else try a.dupe(u8, "\x1b[0m\r\n\r\n# Recovered saved output; new shell.\r\n");
    defer a.free(banner);
    p.terminal.feed(banner);
    try p.terminal.spawn(dir, socket, p.id, executable, null, false);
    try p.terminal.prefill(command);
    a.free(p.cwd);
    p.cwd = try a.dupe(u8, dir);
}

fn captureBinding(alloc: std.mem.Allocator, binding: *const conversations.Attachment, live: bool) !Binding {
    return .{ .actor = if (binding.actor) |actor| actor.id else .none, .generation = binding.generation, .selection_hash = if (live) binding.selection_hash else 0, .hook_seq = if (live) binding.hook_seq else 0, .known = if (live) try alloc.dupe(ActorId, binding.known[0..binding.known_len]) else &.{}, .provisional = if (live) binding.provisional else historicalAgent(binding.provisional) };
}
fn validAgent(agent: agents.Agent) bool {
    return agent.session_len <= agent.session.len and agent.name_len <= agent.name.len and agent.cwd_len <= agent.cwd.len and
        agent.transcript_len <= agent.transcript.len and agent.turn_len <= agent.turn.len and agent.last_finished_turn_len <= agent.last_finished_turn.len and
        agent.activity_len <= agent.activity.len and agent.tool_len <= agent.tool.len and agent.recent_len <= agent.recent.len and agent.observation.read <= agent.observation.completed;
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
