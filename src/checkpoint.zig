//! Versioned runtime state shared by live handoff and disk recovery. Live state
//! uses compact VT snapshots and application redraw; old replay imports remain supported.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const runtime = @import("runtime.zig");
const workspace = @import("workspace.zig");
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const agents = @import("agents.zig");
const native = @import("native.zig");
const Terminal = @import("terminal.zig").Terminal;
const binary = @import("replay.zig");
pub const Resume = struct {
    provider: agents.Provider = .other,
    session: [160]u8 = .{0} ** 160,
    len: usize = 0,
    pub fn observe(r: *Resume, agent: *const agents.Agent) void {
        if (agent.provider == .other) return;
        if (agent.session_len > 0) {
            r.provider = agent.provider;
            r.session = agent.session;
            r.len = agent.session_len;
        } else if (r.provider == .other) r.provider = agent.provider;
    }
    pub fn command(r: Resume, alloc: std.mem.Allocator) ![]const u8 {
        if (r.provider == .other) return alloc.dupe(u8, "");
        const prefix: []const u8 = if (r.provider == .codex) "codex resume" else "claude --resume";
        if (r.len == 0) return alloc.dupe(u8, prefix);
        var out: std.Io.Writer.Allocating = .init(alloc);
        try out.writer.print("{s} '", .{prefix});
        for (r.session[0..r.len]) |ch| {
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
    synchronized_since: ?i64 = null,
    approximate: bool = false,
    redraw_pending: bool = false,
    pub fn capture(alloc: std.mem.Allocator, t: *Terminal, live: bool) !Screen {
        // Transfer retained terminal state, not every byte ever emitted. Repaint
        // only after the candidate has committed ownership of the live PTY.
        const history = if (live) try t.liveSnapshot() else try t.snapshot();
        defer a.free(history);
        return .{ .cols = t.vt.cols, .rows = t.vt.rows, .data = try binary.encode(alloc, history), .pid = if (live) t.pid else -1, .fd = if (live) t.fd else -1, .exited = t.exited, .exit_status = t.exit_status, .synchronized_since = null, .approximate = live, .redraw_pending = live };
    }
    pub fn restore(screen: Screen, live: bool) !*Terminal {
        if (screen.cols == 0 or screen.cols > 500 or screen.rows == 0 or screen.rows > 200) return error.InvalidCheckpoint;
        const bytes = try binary.decode(a, screen.data);
        defer a.free(bytes);
        const t = if (live and !screen.approximate) try Terminal.replay(screen.cols, screen.rows, bytes) else try Terminal.create(screen.cols, screen.rows);
        if (!live or screen.approximate) {
            t.record();
            // A snapshot can contain terminal queries. Never send replies to
            // the still-owned PTY during the handoff's preparation phase.
            t.replaying = true;
            t.feed(bytes);
            t.replaying = false;
        }
        if (live) {
            t.fd = screen.fd;
            t.pid = screen.pid;
            t.exited = screen.exited;
            t.exit_status = screen.exit_status;
            t.synchronized_since = screen.synchronized_since;
            t.imported = true;
            t.redraw_pending = screen.redraw_pending or screen.approximate;
            if (t.fd >= 0) os.cloexec(t.fd);
        }
        return t;
    }
};
pub const Pane = struct { label: @import("pane_label.zig").Label = .{}, id: u32, cwd: []const u8, screen: Screen, agent: agents.Agent = .{}, detection: @import("detection.zig").Tracker = .{}, resume_hint: Resume = .{} };
pub const Closed = struct { label: @import("pane_label.zig").Label = .{}, cwd: []const u8, screen: Screen, tab: layout.Tab, workspace_id: u32 };
pub const Workspace = struct { away: @import("usage.zig").Window = .{}, id: u32, name: []const u8, cwd: []const u8, tabs: []const protocol.Tab, active: usize, custom_name: ?[]const u8 = null, focus: []const u32, zoom: []const bool };
pub const NativeTurn = struct { thread: []const u8, turn: []const u8 };
pub const Native = struct {
    usage_tracker: @import("usage.zig").Tracker = .{},
    observation: agents.observation.State = .{},
    turns: []const NativeTurn = &.{},
    id: u32,
    provider: agents.Provider,
    cwd: []const u8,
    workspace_id: u32,
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
    threads: []const []const u8,
    tools: []const native.Tool,
    next_seq: u64,
    journal_bytes: usize,
    resume_hint: Resume,
};
pub const State = struct {
    version: u32 = 1,
    live: bool,
    saved_at: i64,
    active: usize,
    next_workspace: u32,
    next_pane: u32,
    next_session: u32,
    revision: u64,
    workspaces: []const Workspace,
    panes: []const Pane,
    closed: []const Closed,
    sessions: []const Native,
};
fn historicalAgent(agent: agents.Agent) agents.Agent {
    var result = agent;
    result.state = if (result.observation.unread()) .done else .unknown;
    if (!result.observation.unread()) result.provider = .other;
    result.last_seq = 0;
    result.tool_active = false;
    result.observation.pending_stop = false;
    result.transcript_len = 0;
    return result;
}
pub fn capture(alloc: std.mem.Allocator, r: *runtime.Runtime, live: bool) !State {
    const workspaces = try alloc.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*w, *out| {
        const focus = try alloc.alloc(u32, w.model.count);
        const zoom = try alloc.alloc(bool, w.model.count);
        for (w.model.tabs[0..w.model.count], focus, zoom) |tab, *f, *z| {
            f.* = tab.focus;
            z.* = tab.zoom;
        }
        out.* = .{ .id = w.id, .away = w.away, .name = w.name(), .cwd = w.cwd, .tabs = try protocol.encodeTabs(alloc, &w.model), .active = w.model.active, .custom_name = w.customName(), .focus = focus, .zoom = zoom };
    }
    const panes = try alloc.alloc(Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        p.refreshCwd();
        p.resume_hint.observe(&p.agent);
        out.* = .{ .id = p.id, .label = p.label, .cwd = p.cwd, .screen = try Screen.capture(alloc, p.terminal, live), .agent = if (live) p.agent else historicalAgent(p.agent), .detection = if (live) p.detection else .{}, .resume_hint = p.resume_hint };
    }
    const closed = try alloc.alloc(Closed, r.closed.items.len);
    for (r.closed.items, closed) |p, *out| out.* = .{ .label = p.label, .cwd = p.cwd, .screen = try Screen.capture(alloc, p.terminal, false), .tab = p.tab, .workspace_id = p.workspace_id };
    const sessions = try alloc.alloc(Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*s, *out| {
        const threads = try alloc.alloc([]const u8, s.active_threads.count());
        var it = s.active_threads.iterator();
        const turns = try alloc.alloc(NativeTurn, s.active_threads.count());
        for (threads, turns) |*thread, *turn| {
            const entry = it.next().?;
            thread.* = entry.key_ptr.*;
            turn.* = .{ .thread = entry.key_ptr.*, .turn = entry.value_ptr.* };
        }
        out.* = .{ .usage_tracker = s.usage_tracker, .id = s.id, .provider = s.provider, .cwd = s.cwd, .workspace_id = s.workspace_id, .pid = if (live) s.child.id else -1, .stdin = if (live and s.child.stdin != null) s.child.stdin.?.handle else -1, .stdout = if (live and s.child.stdout != null) s.child.stdout.?.handle else -1, .ready = s.ready, .exited = s.exited, .state = s.state, .attention = s.attention, .input = try binary.encode(alloc, if (live) s.input.items else ""), .output = try binary.encode(alloc, if (live) s.output.items else ""), .deferred = try binary.encode(alloc, if (live) s.deferred.items else ""), .events = s.events.items, .approvals = s.approvals.items, .threads = threads, .turns = turns, .observation = s.observation, .tools = s.active_tools.items, .next_seq = s.next_seq, .journal_bytes = s.journal_bytes, .resume_hint = s.resume_hint };
    }
    return .{ .live = live, .saved_at = std.time.timestamp(), .active = r.workspaces.active, .next_workspace = r.workspaces.next_id, .next_pane = r.workspaces.next_pane_id, .next_session = r.next_session, .revision = r.revision, .workspaces = workspaces, .panes = panes, .closed = closed, .sessions = sessions };
}
// Callers own a staging runtime. Live import errors exit the candidate without
// calling destructors: inherited descriptors are still owned by the old daemon.
pub fn restore(r: *runtime.Runtime, state: State, live: bool, socket: []const u8, executable: []const u8) !void {
    if (state.version != 1 or state.live != live or state.workspaces.len == 0 or state.workspaces.len > workspace.max_workspaces or
        state.panes.len > layout.max_panes or state.closed.len > 8 or state.sessions.len > 16 or state.active >= state.workspaces.len) return error.InvalidCheckpoint;
    for (state.workspaces) |w| {
        if (w.id == 0 or w.id >= state.next_workspace or r.workspaces.index(w.id) != null or !std.fs.path.isAbsolute(w.cwd)) return error.InvalidCheckpoint;
        var item: workspace.Workspace = .{ .id = w.id, .away = w.away, .cwd = try a.dupe(u8, w.cwd) };
        item.name_len = agents.clean(&item.name_buf, w.custom_name orelse w.name);
        item.model = try protocol.modelFromTabs(w.tabs, &.{});
        if (w.focus.len != w.tabs.len or w.zoom.len != w.tabs.len or (w.tabs.len > 0 and w.active >= w.tabs.len)) return error.InvalidCheckpoint;
        for (item.model.tabs[0..item.model.count], 0..) |*tab, i| {
            if (tab.id >= state.next_pane or item.model.tabForPane(w.focus[i]) != i) return error.InvalidCheckpoint;
            tab.focus = w.focus[i];
            tab.zoom = w.zoom[i];
        }
        item.model.active = w.active;
        item.model.next_id = state.next_pane;
        try r.workspaces.items.append(a, item);
    }
    r.workspaces.active = state.active;
    r.workspaces.next_id = state.next_workspace;
    r.workspaces.next_pane_id = state.next_pane;
    r.next_session = state.next_session;
    r.revision = state.revision +% 1;
    for (state.panes) |p| {
        if (p.label.len > p.label.bytes.len or p.id == 0 or p.id >= state.next_pane or r.pane(p.id) != null or r.workspaces.owner(p.id) == null or
            !std.fs.path.isAbsolute(p.cwd) or p.resume_hint.len > p.resume_hint.session.len or p.agent.session_len > 160 or p.agent.cwd_len > p.agent.cwd.len or
            p.agent.transcript_len > p.agent.transcript.len or p.agent.turn_len > 160 or
            p.agent.last_finished_turn_len > 160 or p.agent.recent_len > 160 or p.agent.observation.read > p.agent.observation.completed) return error.InvalidCheckpoint;
        const t = try p.screen.restore(live);
        try r.panes.append(a, .{ .id = p.id, .label = p.label, .terminal = t, .cwd = try a.dupe(u8, p.cwd), .agent = p.agent, .detection = p.detection, .resume_hint = p.resume_hint });
    }
    for (r.workspaces.items.items) |w| for (w.model.nodes) |maybe| if (maybe) |n| if (n == .pane and r.pane(n.pane) == null) return error.InvalidCheckpoint;
    for (state.closed) |p| {
        if (p.label.len > p.label.bytes.len) return error.InvalidCheckpoint;
        try r.closed.append(a, .{ .label = p.label, .terminal = try p.screen.restore(false), .cwd = try a.dupe(u8, p.cwd), .tab = p.tab, .workspace_id = p.workspace_id });
    }
    for (state.sessions) |n| {
        if (n.resume_hint.len > 160 or n.usage_tracker.next_sample >= n.usage_tracker.samples.len or n.usage_tracker.next_tool >= n.usage_tracker.tools.len or r.workspaces.index(n.workspace_id) == null) return error.InvalidCheckpoint;
        var s: native.Session = .{ .usage_tracker = if (live) n.usage_tracker else .{}, .id = n.id, .provider = n.provider, .cwd = try a.dupe(u8, n.cwd), .workspace_id = n.workspace_id, .child = std.process.Child.init(&.{}, a), .ready = n.ready, .exited = if (live) n.exited else true, .state = if (live) n.state else .done, .attention = if (live) n.attention else .none, .observation = n.observation, .next_seq = n.next_seq, .journal_bytes = n.journal_bytes, .resume_hint = n.resume_hint, .imported = live };
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
            for (n.approvals) |line| try s.approvals.append(a, try a.dupe(u8, line));
            for (n.threads) |thread| {
                var turn_id: []const u8 = "";
                for (n.turns) |turn| if (std.mem.eql(u8, thread, turn.thread)) {
                    turn_id = turn.turn;
                    break;
                };
                try s.active_threads.put(a, try a.dupe(u8, thread), try a.dupe(u8, turn_id));
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
            pane.agent = .{ .provider = n.provider, .state = .done, .observation = n.observation, .session = n.resume_hint.session, .session_len = n.resume_hint.len, .attention = if (n.observation.unread()) .finished else .none };
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
            const banner = try std.fmt.allocPrint(a, "\r\n[Corgi recovered native session {d}; new shell; previous process not reattached]\r\nResume when ready: {s}\r\n", .{ n.id, command });
            defer a.free(banner);
            pane.terminal.feed(banner);
        }
    }
}
fn recoverPane(p: *runtime.Pane, socket: []const u8, executable: []const u8, saved_at: i64) !void {
    const command = try p.resume_hint.command(a);
    defer a.free(command);
    // A missing project directory must not discard its saved contents.
    const dir = workspace.Store.directory(p.cwd) catch try workspace.Store.directory(os.env("HOME") orelse "/");
    defer a.free(dir);
    const banner = try std.fmt.allocPrint(a, "\x1b[0m\r\n\r\n[Corgi recovered saved output from {d}; new shell; previous process not reattached]\r\nSaved directory: {s}\r\n{s}{s}\r\n", .{ saved_at, p.cwd, if (command.len > 0) "Resume when ready: " else "No agent session was recorded.", command });
    defer a.free(banner);
    p.terminal.feed(banner);
    try p.terminal.spawn(dir, socket, p.id, executable, null);
    a.free(p.cwd);
    p.cwd = try a.dupe(u8, dir);
}
