//! Session resources and operations, independent of any viewer's presentation.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const log = std.log.scoped(.runtime);
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const agents = @import("agents.zig");
const providers = @import("providers.zig");
const Terminal = @import("pane.zig").Terminal;
const native = @import("native.zig");
const NativeId = native.Session.Id;
const Theme = @import("theme.zig").Theme;
const pane_label = @import("pane.zig").label;
const conversations = @import("conversations.zig");
const detection = @import("detection.zig");
const ResumeHint = @import("resume_hint.zig").ResumeHint;
const agent_order = @import("agent_order.zig");
const launch_command = @import("launch.zig").command;
const inference_setup = @import("inference.zig").setup;
const live_usage = @import("usage.zig").live;
const git_push = @import("trackers.zig").git_push;
const git_status = @import("trackers.zig").git_status;
const ports = @import("trackers.zig").ports;
const resources = @import("trackers.zig").resources;
const link_labels = @import("trackers.zig").link_labels;

pub const Pane = struct {
    label: pane_label.Label = .{},
    id: layout.PaneId,
    terminal: *Terminal,
    attachment: conversations.Attachment = .{},

    detection: detection.Tracker = .{},
    /// The output and time of the pane's last detection pass.
    detected: struct { output: u64 = 0, at: i64 = 0 } = .{},
    cwd: []const u8,
    resume_hint: ResumeHint = .{},
    /// How Corgi started the pane's agent, so a reopened one starts the same way.
    launch: ?Launch = null,
    /// A resumed agent's old screen, shown until the agent catches up.
    ghost: ?Ghost = null,

    /// How often detection reads a quiet pane: one that printed nothing
    /// since its last pass, with no agent mid-turn and nothing to confirm.
    /// Starting or ending a program prints, so this only catches silent ones.
    pub const quiet_detection_ms = 2000;

    pub fn agent(p: *const Pane) *agents.Agent {
        return p.attachment.agent();
    }

    pub fn detectionDue(p: *const Pane, now: i64) bool {
        if (p.terminal.surface_revision != p.detected.output or now - p.detected.at >= quiet_detection_ms) return true;
        const shown = p.agent();
        // The screen state machine confirms over consecutive passes.
        if (p.detection.missing > 0 or (shown.last_seq == 0 and p.detection.candidate != null and p.detection.candidate != shown.state)) return true;
        return switch (shown.state) {
            .working, .blocked, .initializing => true,
            else => shown.permission_review != null,
        };
    }

    /// The terminal viewers see.
    pub fn displayed(p: *const Pane) *Terminal {
        return if (p.ghost) |g| g.terminal else p.terminal;
    }
    /// Follows the agent drawing under its ghost. Returns whether the
    /// ghost just went: the agent's screen reads as the old one did, held
    /// still for `Ghost.quiet_ms`, or `Ghost.longest_ms` passed.
    pub fn watchGhost(p: *Pane, now: i64) bool {
        const g = if (p.ghost) |*ghost| ghost else return false;
        if (g.revision != p.terminal.surface_revision) {
            g.revision = p.terminal.surface_revision;
            const text = screenHash(p.terminal);
            if (text != g.text) {
                g.text = text;
                g.changed_at = now;
                if (g.drawn_at == null) g.drawn_at = now;
                if (g.old_screen and text != null and text == screenHash(g.terminal)) {
                    p.dropGhost();
                    return true;
                }
            }
        }
        if (now < g.due() orelse return false) return false;
        p.dropGhost();
        return true;
    }
    fn dropGhost(p: *Pane) void {
        if (p.ghost) |g| g.terminal.destroy();
        p.ghost = null;
    }
    pub fn resize(p: *Pane, cols: u16, rows: u16) !void {
        try p.terminal.resize(cols, rows);
        const g = if (p.ghost) |*ghost| ghost else return;
        try g.terminal.resize(cols, rows);
        // Rewrapping the old screen is not the agent drawing.
        if (g.drawn_at == null) {
            g.revision = p.terminal.surface_revision;
            g.text = screenHash(p.terminal);
        }
    }
    /// The command a resumed agent runs, shown while its ghost is up.
    pub fn restoring(p: *const Pane, alloc: std.mem.Allocator) ![]const u8 {
        if (p.ghost == null) return "";
        const launch = p.launch orelse return "";
        return launch.typed(alloc, p.resume_hint.args());
    }

    pub fn refreshCwd(p: *Pane) void {
        if (p.terminal.exited) return;
        const pgid = os.c.tcgetpgrp(p.terminal.fd);
        const found = (if (p.detection.pid > 0) os.processCwd(p.detection.pid) else null) orelse
            (if (pgid > 0) os.processCwd(pgid) else null) orelse
            os.processCwd(p.terminal.pid);
        if (found) |cwd| {
            a.free(p.cwd);
            p.cwd = cwd;
        }
    }
};

/// A resumed agent's old screen, faded, or a blank one when Corgi kept none.
/// Viewers see it in place of the pane until the agent has drawn its own and
/// stopped changing it, so the agent's first redraws don't flicker.
pub const Ghost = struct {
    /// How long the agent's screen holds still before it shows.
    pub const quiet_ms = 300;
    /// The longest the ghost stays once the agent draws.
    pub const longest_ms = 2000;

    terminal: *Terminal,
    /// Whether it holds an old screen, which the agent drawing the same
    /// ends early. A blank one waits for the agent to hold still.
    old_screen: bool = true,
    /// The agent's screen when last looked at: its output and its text.
    revision: u64,
    text: ?u64,
    /// When the agent first drew, and when its screen last changed.
    drawn_at: ?i64 = null,
    changed_at: i64 = 0,

    /// When the ghost goes if the agent's screen holds still; null until
    /// the agent draws.
    pub fn due(g: Ghost) ?i64 {
        const drawn = g.drawn_at orelse return null;
        return @min(g.changed_at + quiet_ms, drawn + longest_ms);
    }
};
fn screenHash(t: *Terminal) ?u64 {
    const text = t.liveText() catch return null;
    defer a.free(text);
    return std.hash.Wyhash.hash(0, text);
}

/// An agent whose pane closed while it ran. `reopenClosed` resumes it,
/// showing this screen faded until the agent catches up.
pub const ClosedAgent = struct {
    label: pane_label.Label = .{},
    terminal: *Terminal,
    cwd: []const u8,
    tab: layout.Tab,
    workspace_id: WorkspaceId,
    resume_hint: ResumeHint,
    launch: ?Launch = null,
    /// The pane it was, which a saved agent order may still name.
    pane: layout.PaneId = .none,
    /// Where its tab goes back: its old place, or after its old tab when
    /// that tab is still open. Null appends it.
    tab_index: ?u8 = null,
    pub fn deinit(p: ClosedAgent) void {
        p.terminal.destroy();
        a.free(p.cwd);
    }
};
/// How many closed agents each workspace keeps.
pub const closed_per_workspace = 8;

/// How Corgi started an agent. A reopened agent starts the same way, so it
/// keeps its account, settings and flags.
pub const Launch = union(enum) {
    /// The launcher's row for a provider.
    agent: struct { provider: agents.Provider, yolo: bool = false },
    /// A saved launcher command, run as typed into an interactive shell.
    command: launch_command.Command,

    /// The command as a person would type it, resuming the session
    /// `resuming` names when set.
    pub fn typed(l: Launch, alloc: std.mem.Allocator, resuming: ?[3][]const u8) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        switch (l) {
            .agent => |agent| {
                try out.writer.print("{t}", .{agent.provider});
                if (agent.yolo) try out.writer.print(" {s}", .{agent.provider.info().yolo_flag});
            },
            .command => |command| try out.writer.writeAll(command.text()),
        }
        if (resuming) |argv| {
            const session = try os.shellQuote(a, argv[2]);
            defer a.free(session);
            try out.writer.print(" {s} {s}", .{ argv[1], session });
        }
        return out.toOwnedSlice();
    }
    /// What a pane runs for `typed`. A provider runs through `corgi agent`,
    /// which finds its binary and clears Claude's nesting markers.
    pub fn paneCommand(l: Launch, alloc: std.mem.Allocator, executable: []const u8, typed_command: []const u8) ![]const u8 {
        if (l == .command) return alloc.dupe(u8, typed_command);
        const quoted = try os.shellQuote(a, executable);
        defer a.free(quoted);
        return std.fmt.allocPrint(alloc, "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT {s} agent {s}", .{ quoted, typed_command });
    }
};

pub const Runtime = struct {
    workspaces: workspace.Store = .{},
    panes: std.ArrayList(Pane) = .empty,
    /// Oldest first, from every workspace.
    closed: std.ArrayList(ClosedAgent) = .empty,
    /// Shells `stopShell` signalled that are not yet collected.
    stopped: std.ArrayList(c_int) = .empty,
    sessions: std.ArrayList(native.Session) = .empty,
    next_session: NativeId = .first,
    last_agent: agents.Provider = .codex,
    agent_yolo: providers.Each(bool, false) = .{},
    agent_hidden: providers.Each(bool, false) = .{},
    agent_commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    conversations: conversations.Registry = .{},
    system_model: []const u8 = "",
    staged_version: []const u8 = "",
    inference: inference_setup.Status = .{},
    system_working: bool = false,
    system_usage: live_usage.View = .{ .known = true },
    /// Bumped by every change a snapshot shows.
    revision: u64 = 1,
    /// Bumped by the changes a checkpoint records. Readings and git status,
    /// which snapshots show but checkpoints leave out, do not bump it.
    durable: u64 = 1,
    /// Bumped by the changes a viewer's session shows. Pane output, which
    /// viewers receive as surfaces, does not bump it.
    shown: u64 = 1,
    git_push: git_push.Manager = .{},
    git_status: git_status.Tracker = .{},
    ports: ports.Tracker = .{},
    resources: resources.Tracker = .{},
    link_labels: link_labels.Cache = .{},

    pub fn changed(r: *Runtime) void {
        r.revision +%= 1;
        r.durable +%= 1;
        r.shown +%= 1;
    }
    pub fn refreshed(r: *Runtime) void {
        r.revision +%= 1;
        r.shown +%= 1;
    }
    pub fn wrote(r: *Runtime) void {
        r.revision +%= 1;
        r.durable +%= 1;
    }

    /// The handoff committed: inherited processes are ours to stop.
    pub fn adopt(r: *Runtime) void {
        for (r.panes.items) |p| p.terminal.owner = .runtime;
        for (r.closed.items) |p| p.terminal.owner = .runtime;
        for (r.sessions.items) |*s| s.owner = .runtime;
    }

    pub fn deinit(r: *Runtime) void {
        r.resources.deinit();
        r.ports.deinit();
        r.git_push.deinit();
        r.git_status.deinit();
        for (r.panes.items) |*p| {
            p.dropGhost();
            p.terminal.destroy();
            a.free(p.cwd);
        }
        r.panes.deinit(a);
        for (r.closed.items) |p| p.deinit();
        r.closed.deinit(a);
        r.stopped.deinit(a);
        for (r.sessions.items) |*session| session.destroy();
        r.sessions.deinit(a);
        r.workspaces.deinit();
        r.conversations.deinit();
    }

    pub fn pane(r: *Runtime, id: layout.PaneId) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }

    /// Live panes and native sessions showing `actor`.
    pub fn attachments(r: *const Runtime, actor: *const conversations.Actor) u32 {
        var count: u32 = 0;
        for (r.panes.items) |p| if (!p.terminal.exited and p.attachment.actor == actor) {
            count += 1;
        };
        for (r.sessions.items) |session| if (!session.exited) {
            for (session.members.items) |member| if (member == actor) {
                count += 1;
                break;
            };
        };
        return count;
    }

    /// Attached somewhere, or a subagent of a conversation that is. Workers
    /// observe only these; a detached conversation waits to be attached again.
    pub fn followed(r: *const Runtime, actor: *const conversations.Actor) bool {
        var current: ?*const conversations.Actor = actor;
        for (0..conversations.max_actors) |_| {
            const each = current orelse return false;
            if (r.attachments(each) > 0) return true;
            current = if (each.parent) |id| r.conversations.byId(id) else null;
        }
        return false;
    }

    pub fn getWorkspace(r: *Runtime, id: WorkspaceId) !*workspace.Workspace {
        return r.workspaces.get(id) orelse error.NoWorkspace;
    }

    /// The agent `New` repeats in `ws`: its own, else the last one anywhere.
    pub fn lastAgent(r: *const Runtime, ws: *const workspace.Workspace) agents.Provider {
        return ws.last_agent orelse r.last_agent;
    }
    /// An agent started in pane `id`; `New` repeats it in that workspace.
    pub fn rememberAgent(r: *Runtime, id: layout.PaneId, provider: agents.Provider) void {
        r.last_agent = provider;
        if (r.workspaces.owner(id)) |ws| ws.last_agent = provider;
    }

    pub const Create = struct {
        workspace: WorkspaceId,
        split: ?struct { pane: layout.PaneId, axis: layout.Axis, before: bool = false } = null,
        cwd: []const u8,
        command: ?[]const u8 = null,
        interactive_command: bool = false,
        title: []const u8 = "",
        cols: u16,
        rows: u16,
        theme: Theme,
        socket: []const u8,
        executable: []const u8,
    };

    /// Changes the shared arrangement without selecting the result in a viewer.
    pub fn create(r: *Runtime, opts: Create) !layout.PaneId {
        if (r.panes.items.len >= layout.max_panes) return error.TooManyPanes;
        const ws = try r.getWorkspace(opts.workspace);
        var next = ws.model;
        next.next_id = r.workspaces.next_pane_id;
        const id = if (opts.split) |split| try next.split(split.pane, split.axis) else try next.newTab(opts.title);
        if (opts.split) |split| if (split.before) try next.swap(id, split.pane);
        next.revision +%= 1;
        const dir = try workspace.Store.directory(opts.cwd);
        errdefer a.free(dir);
        const t = try Terminal.create(opts.cols, opts.rows);
        errdefer t.destroy();
        t.applyTheme(opts.theme);
        try r.panes.ensureUnusedCapacity(a, 1);
        try t.spawn(dir, opts.socket, id, opts.executable, opts.command, opts.interactive_command);
        r.panes.appendAssumeCapacity(.{ .id = id, .terminal = t, .cwd = dir });
        ws.model = next;
        r.workspaces.next_pane_id = next.next_id;
        r.changed();
        return id;
    }

    pub fn close(r: *Runtime, id: layout.PaneId) !void {
        const owner = r.workspaces.owner(id) orelse return error.NoPane;
        const tab = owner.model.tabForPane(id).?;
        const previous = owner.model.tabs[tab];
        try r.closed.ensureUnusedCapacity(a, 1);
        try r.stopped.ensureUnusedCapacity(a, 1);
        try owner.model.close(id);
        owner.model.revision +%= 1;
        const tab_index: u8 = @intCast(tab + @intFromBool(owner.model.tabIndex(previous.id) != null));
        for (r.panes.items, 0..) |*p, i| if (p.id == id) {
            p.dropGhost();
            p.refreshCwd();
            _ = p.terminal.read();
            _ = p.terminal.reap();
            p.resume_hint.observe(p.agent());
            // An agent that quit on its own was closed on purpose.
            const running = !p.terminal.exited and p.attachment.actor != null;
            r.stopShell(p.terminal);
            if (running and p.resume_hint.args() != null) {
                if (r.closedCount(owner.id) == closed_per_workspace) r.closed.orderedRemove(r.closedIndex(owner.id, .oldest).?).deinit();
                r.closed.appendAssumeCapacity(.{
                    .label = p.label,
                    .terminal = p.terminal,
                    .cwd = p.cwd,
                    .tab = previous,
                    .workspace_id = owner.id,
                    .resume_hint = p.resume_hint,
                    .launch = p.launch,
                    .pane = p.id,
                    .tab_index = tab_index,
                });
            } else {
                p.terminal.destroy();
                a.free(p.cwd);
            }
            _ = r.panes.orderedRemove(i);
            break;
        };
        r.changed();
    }

    /// Agents `reopen` can resume in `ws`.
    pub fn closedCount(r: *const Runtime, ws: WorkspaceId) usize {
        var count: usize = 0;
        for (r.closed.items) |p| {
            if (p.workspace_id == ws) count += 1;
        }
        return count;
    }
    fn closedIndex(r: *const Runtime, ws: WorkspaceId, which: enum { oldest, newest }) ?usize {
        var found: ?usize = null;
        for (r.closed.items, 0..) |p, i| if (p.workspace_id == ws) {
            found = i;
            if (which == .oldest) break;
        };
        return found;
    }

    /// Signal a pane's shell, keeping its pid until `reapStopped` collects it.
    pub fn stopShell(r: *Runtime, t: *Terminal) void {
        if (t.owner == .runtime and !t.imported and !t.exited and t.pid > 0)
            r.stopped.append(a, t.pid) catch {};
        t.stop();
    }

    /// Collect stopped shells without blocking. ECHILD means it is already gone.
    pub fn reapStopped(r: *Runtime) void {
        var i: usize = 0;
        while (i < r.stopped.items.len) {
            if (os.c.waitpid(r.stopped.items[i], null, os.c.WNOHANG) == 0) {
                i += 1;
            } else _ = r.stopped.swapRemove(i);
        }
    }

    /// Resumes the agent closed last in `opts.workspace`, as `reopenClosed` does.
    pub fn reopen(r: *Runtime, opts: Create) !layout.PaneId {
        return r.reopenClosed(r.closedIndex(opts.workspace, .newest) orelse return error.NoClosedAgent, opts);
    }
    /// The newest closed agent that ran `session`.
    pub fn closedConversation(r: *const Runtime, provider: agents.Provider, session: []const u8) ?usize {
        var i = r.closed.items.len;
        while (i > 0) {
            i -= 1;
            const hint = r.closed.items[i].resume_hint;
            if (hint.provider == provider and std.mem.eql(u8, hint.session.text(), session)) return i;
        }
        return null;
    }
    /// Resumes closed agent `index` in a new tab in `opts.workspace`, with
    /// the command that started it and its old screen faded. When it closed
    /// in that workspace, its tab goes back to its old place.
    pub fn reopenClosed(r: *Runtime, index: usize, opts: Create) !layout.PaneId {
        const saved = r.closed.items[index];
        const ghost = try saved.terminal.fadedSnapshot();
        defer a.free(ghost);
        // An agent Corgi did not start resumes as its provider's launcher row would.
        const launch = saved.launch orelse Launch{ .agent = .{ .provider = saved.resume_hint.provider.? } };
        var resumed = opts;
        resumed.cwd = saved.cwd;
        resumed.title = saved.tab.title.text();
        // Its old size lays the ghost out as it was, and the agent's first
        // drawing over it lines up.
        resumed.cols = saved.terminal.vt.cols;
        resumed.rows = saved.terminal.vt.rows;
        const id = try r.resumeAgent(resumed, launch, saved.resume_hint, ghost);
        const ws = r.workspaces.get(opts.workspace).?;
        if (saved.workspace_id == opts.workspace) {
            if (saved.tab_index) |place| {
                ws.model.moveTab(ws.model.tabs[ws.model.count - 1].id, @min(place, ws.model.count - 1));
                ws.model.revision +%= 1;
            }
            for (ws.agent_order.items[0..ws.agent_order.len]) |*target| {
                if (std.meta.eql(target.*, agent_order.Target{ .pane = saved.pane })) target.* = .{ .pane = id };
            }
        }
        r.pane(id).?.label = saved.label;
        _ = r.closed.orderedRemove(index);
        saved.deinit();
        return id;
    }
    /// Resumes `hint`'s session in a new tab, started the way `launch`
    /// starts it. Its conversation shows at once, asleep, and viewers see
    /// `old`, a faded screen, or a blank one until the agent has drawn its own.
    pub fn resumeAgent(r: *Runtime, opts: Create, launch: Launch, hint: ResumeHint, old: ?[]const u8) !layout.PaneId {
        const provider = hint.provider orelse return error.InvalidSession;
        const typed = try launch.typed(a, hint.args() orelse return error.InvalidSession);
        defer a.free(typed);
        const command = try launch.paneCommand(a, opts.executable, typed);
        defer a.free(command);
        const frozen = try Terminal.create(opts.cols, opts.rows);
        errdefer frozen.destroy();
        frozen.applyTheme(opts.theme);
        if (old) |screen| frozen.feed(screen);
        var resumed = opts;
        resumed.command = command;
        resumed.interactive_command = launch == .command;
        const id = try r.create(resumed);
        const p = r.pane(id).?;
        p.resume_hint = hint;
        p.launch = launch;
        // Its conversation shows at once, by name, before the agent reports in.
        if (r.conversations.get(provider, hint.session.text())) |actor| {
            actor.state.reopened(std.time.microTimestamp());
            if (actor.state.name.len == 0) actor.state.name = hint.name;
            if (actor.workspace == WorkspaceId.none) actor.workspace = opts.workspace;
            p.attachment.select(actor);
        } else |err| log.warn("attaching a resumed agent: {}", .{err});
        if (old) |screen| p.terminal.feed(screen);
        p.ghost = .{ .terminal = frozen, .revision = p.terminal.surface_revision, .text = screenHash(p.terminal), .old_screen = old != null };
        return id;
    }
    pub fn createWorkspace(r: *Runtime, name: []const u8, opts: Create) !WorkspaceId {
        const id = try r.workspaces.add(name, opts.cwd);
        errdefer {
            const removed = r.workspaces.items.pop().?;
            a.free(removed.cwd);
        }
        var shell = opts;
        shell.workspace = id;
        _ = try r.create(shell);
        return id;
    }
    pub fn closeWorkspace(r: *Runtime, id: WorkspaceId, close_contents: bool) !void {
        const index = r.workspaces.index(id) orelse return error.NoWorkspace;
        if (r.workspaces.items.items.len == 1) return error.LastWorkspace;
        const ws = &r.workspaces.items.items[index];
        if (!close_contents) {
            if (ws.model.count > 0) return error.WorkspaceNotEmpty;
            for (r.sessions.items) |session| if (session.workspace_id == id) return error.WorkspaceNotEmpty;
        }
        try r.closed.ensureUnusedCapacity(a, @min(r.panes.items.len, closed_per_workspace));
        while (ws.model.count > 0) try r.close(ws.model.firstPane(ws.model.tabs[0].root));
        // Its closed agents could only reopen here.
        var i: usize = 0;
        while (i < r.closed.items.len) {
            if (r.closed.items[i].workspace_id == id) r.closed.orderedRemove(i).deinit() else i += 1;
        }
        i = 0;
        while (i < r.sessions.items.len) {
            if (r.sessions.items[i].workspace_id == id) {
                r.sessions.items[i].destroy();
                _ = r.sessions.orderedRemove(i);
            } else i += 1;
        }
        const removed = r.workspaces.items.orderedRemove(index);
        a.free(removed.cwd);
        r.changed();
    }
};

test "reapStopped collects exited shells and forgets processes that are not ours" {
    var r: Runtime = .{};
    defer r.stopped.deinit(a);
    const exited = os.c.fork();
    if (exited < 0) return error.ForkFailed;
    if (exited == 0) os.c._exit(0);
    const running = os.c.fork();
    if (running < 0) return error.ForkFailed;
    if (running == 0) {
        while (true) _ = os.c.pause();
    }
    defer _ = os.c.waitpid(running, null, 0);
    defer _ = os.c.kill(running, os.c.SIGKILL);
    var info: os.c.siginfo_t = undefined;
    // Wait for the exit without collecting it.
    try std.testing.expectEqual(@as(c_int, 0), os.c.waitid(os.c.P_PID, @intCast(exited), &info, os.c.WEXITED | os.c.WNOWAIT));
    // Pid 1 is never our child.
    try r.stopped.appendSlice(a, &.{ exited, 1, running });
    r.reapStopped();
    try std.testing.expectEqualSlices(c_int, &.{running}, r.stopped.items);
    try std.testing.expect(os.c.waitpid(exited, null, os.c.WNOHANG) < 0);
}

test "only attached conversations and their subagents are followed" {
    var r: Runtime = .{};
    defer r.deinit();
    const ws = r.workspaces.get(try r.workspaces.add("follow", "/tmp")).?;
    const attached = try r.conversations.get(.codex, "attached");
    const child = try r.conversations.get(.codex, "child");
    const detached = try r.conversations.get(.codex, "detached");
    const orphan = try r.conversations.get(.codex, "orphan");
    child.parent = attached.id;
    orphan.parent = detached.id;
    var binding: conversations.Attachment = .{};
    binding.select(attached);
    try r.panes.append(a, .{ .id = try ws.model.newTab(""), .terminal = try Terminal.create(20, 4), .cwd = try a.dupe(u8, "/tmp"), .attachment = binding });
    try std.testing.expect(r.followed(attached));
    try std.testing.expect(r.followed(child));
    try std.testing.expect(!r.followed(detached));
    try std.testing.expect(!r.followed(orphan));
    // A pane whose program exited no longer holds its conversation.
    r.panes.items[0].terminal.exited = true;
    try std.testing.expect(!r.followed(attached));
    try std.testing.expect(!r.followed(child));
}

test "output and readings bump only the revisions that hold them" {
    var r: Runtime = .{};
    defer r.deinit();
    r.wrote();
    try std.testing.expectEqual([3]u64{ 2, 2, 1 }, [3]u64{ r.revision, r.durable, r.shown });
    r.refreshed();
    try std.testing.expectEqual([3]u64{ 3, 2, 2 }, [3]u64{ r.revision, r.durable, r.shown });
    r.changed();
    try std.testing.expectEqual([3]u64{ 4, 3, 3 }, [3]u64{ r.revision, r.durable, r.shown });
}

test "detection reads a quiet pane only every few seconds" {
    var p: Pane = .{ .id = @enumFromInt(1), .terminal = try Terminal.create(20, 4), .cwd = "" };
    defer p.terminal.destroy();
    p.detected = .{ .output = p.terminal.surface_revision, .at = 10_000 };
    try std.testing.expect(!p.detectionDue(10_250));
    try std.testing.expect(p.detectionDue(10_000 + Pane.quiet_detection_ms));
    p.terminal.feed("$ ");
    try std.testing.expect(p.detectionDue(10_250));
    p.detected.output = p.terminal.surface_revision;
    p.agent().state = .working;
    try std.testing.expect(p.detectionDue(10_250));
    p.agent().state = .idle;
    p.detection.candidate = .working;
    try std.testing.expect(p.detectionDue(10_250));
}

/// A pane with no process in a new tab, running `session` when set.
fn testPane(r: *Runtime, ws: WorkspaceId, session: ?[]const u8) !*Pane {
    const owner = try r.getWorkspace(ws);
    owner.model.next_id = r.workspaces.next_pane_id;
    const id = try owner.model.newTab("");
    r.workspaces.next_pane_id = owner.model.next_id;
    var binding: conversations.Attachment = .{};
    if (session) |name| binding.select(try r.conversations.get(.claude, name));
    try r.panes.append(a, .{ .id = id, .terminal = try Terminal.create(20, 4), .cwd = try a.dupe(u8, "/tmp"), .attachment = binding });
    return &r.panes.items[r.panes.items.len - 1];
}

test "closing a running agent keeps it for its own workspace; shells and agents that quit are not kept" {
    var r: Runtime = .{};
    defer r.deinit();
    const first = try r.workspaces.add("first", "/tmp");
    const second = try r.workspaces.add("second", "/tmp");
    const agent = try testPane(&r, first, "running");
    agent.launch = .{ .command = try launch_command.Command.init("CLAUDE_CONFIG_DIR=~/.work claude") };
    const agent_id = agent.id;
    const shell = (try testPane(&r, first, null)).id;
    const quit = try testPane(&r, first, "quit");
    quit.terminal.exited = true;
    const quit_id = quit.id;
    const elsewhere = (try testPane(&r, second, "elsewhere")).id;
    for ([_]layout.PaneId{ agent_id, shell, quit_id, elsewhere }) |id| try r.close(id);
    try std.testing.expectEqual(@as(usize, 1), r.closedCount(first));
    try std.testing.expectEqual(@as(usize, 1), r.closedCount(second));
    const kept = r.closed.items[r.closedIndex(first, .newest).?];
    try std.testing.expectEqualStrings("running", kept.resume_hint.session.text());
    try std.testing.expectEqualStrings("CLAUDE_CONFIG_DIR=~/.work claude", kept.launch.?.command.text());
    try std.testing.expectEqual(agent_id, kept.pane);
    try std.testing.expectEqual(@as(?u8, 0), kept.tab_index);
}

test "a closed split's tab goes back after the tab it shared" {
    var r: Runtime = .{};
    defer r.deinit();
    const ws = try r.workspaces.add("splits", "/tmp");
    _ = try testPane(&r, ws, null);
    const left = (try testPane(&r, ws, null)).id;
    const owner = r.workspaces.get(ws).?;
    owner.model.next_id = r.workspaces.next_pane_id;
    const right = try owner.model.split(left, .horizontal);
    r.workspaces.next_pane_id = owner.model.next_id;
    var binding: conversations.Attachment = .{};
    binding.select(try r.conversations.get(.claude, "split"));
    try r.panes.append(a, .{ .id = right, .terminal = try Terminal.create(20, 4), .cwd = try a.dupe(u8, "/tmp"), .attachment = binding });
    try r.close(right);
    try std.testing.expectEqual(@as(?u8, 2), r.closed.items[0].tab_index);
}

test "each workspace keeps its newest closed agents, and closing it drops them" {
    var r: Runtime = .{};
    defer r.deinit();
    const busy = try r.workspaces.add("busy", "/tmp");
    const quiet = try r.workspaces.add("quiet", "/tmp");
    try r.close((try testPane(&r, quiet, "quiet")).id);
    var name: [8]u8 = undefined;
    for (0..closed_per_workspace + 1) |i| try r.close((try testPane(&r, busy, try std.fmt.bufPrint(&name, "s{d}", .{i}))).id);
    try std.testing.expectEqual(closed_per_workspace, r.closedCount(busy));
    try std.testing.expectEqualStrings("s1", r.closed.items[r.closedIndex(busy, .oldest).?].resume_hint.session.text());
    try std.testing.expectEqualStrings("s8", r.closed.items[r.closedIndex(busy, .newest).?].resume_hint.session.text());
    try std.testing.expectEqual(@as(usize, 1), r.closedCount(quiet));
    try r.closeWorkspace(busy, true);
    try std.testing.expectEqual(@as(usize, 1), r.closed.items.len);
    try std.testing.expectEqual(error.NoClosedAgent, r.reopen(.{ .workspace = busy, .cwd = "/tmp", .cols = 20, .rows = 4, .theme = .{}, .socket = "", .executable = "" }));
}

test "resuming a conversation finds the newest agent closed with it, in any workspace" {
    var r: Runtime = .{};
    defer r.deinit();
    const first = try r.workspaces.add("first", "/tmp");
    const second = try r.workspaces.add("second", "/tmp");
    try r.close((try testPane(&r, first, "twice")).id);
    try r.close((try testPane(&r, first, "once")).id);
    try r.close((try testPane(&r, second, "twice")).id);
    try std.testing.expectEqual(@as(?usize, 2), r.closedConversation(.claude, "twice"));
    try std.testing.expectEqual(@as(?usize, 1), r.closedConversation(.claude, "once"));
    try std.testing.expectEqual(null, r.closedConversation(.codex, "once"));
    try std.testing.expectEqual(null, r.closedConversation(.claude, "never"));
}

test "a launch resumes the way it started, with the session quoted" {
    const alloc = std.testing.allocator;
    const claude = try agents.Provider.claude.info().resumeArgs(.{ .id = "it's" });
    const Case = struct { launch: Launch, resuming: ?[3][]const u8, typed: []const u8, runs: []const u8 };
    for ([_]Case{
        .{ .launch = .{ .agent = .{ .provider = .claude } }, .resuming = null, .typed = "claude", .runs = "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT '/opt/corgi' agent claude" },
        .{
            .launch = .{ .agent = .{ .provider = .claude, .yolo = true } },
            .resuming = claude,
            .typed = "claude --dangerously-skip-permissions --resume 'it'\\''s'",
            .runs = "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT '/opt/corgi' agent claude --dangerously-skip-permissions --resume 'it'\\''s'",
        },
        .{
            .launch = .{ .agent = .{ .provider = .codex } },
            .resuming = try agents.Provider.codex.info().resumeArgs(.{ .id = "thread" }),
            .typed = "codex resume 'thread'",
            .runs = "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT '/opt/corgi' agent codex resume 'thread'",
        },
        // A saved command keeps its account and settings exactly.
        .{
            .launch = .{ .command = try launch_command.Command.init("CLAUDE_CONFIG_DIR=~/.work claude --model opus") },
            .resuming = claude,
            .typed = "CLAUDE_CONFIG_DIR=~/.work claude --model opus --resume 'it'\\''s'",
            .runs = "CLAUDE_CONFIG_DIR=~/.work claude --model opus --resume 'it'\\''s'",
        },
    }) |case| {
        const typed = try case.launch.typed(alloc, case.resuming);
        defer alloc.free(typed);
        try std.testing.expectEqualStrings(case.typed, typed);
        const runs = try case.launch.paneCommand(alloc, "/opt/corgi", typed);
        defer alloc.free(runs);
        try std.testing.expectEqualStrings(case.runs, runs);
    }
}

/// `p` as `reopen` leaves it: the same faded screen in it and in its ghost.
fn testGhost(p: *Pane, screen: []const u8) !void {
    const frozen = try Terminal.create(p.terminal.vt.cols, p.terminal.vt.rows);
    frozen.feed(screen);
    p.terminal.feed(screen);
    p.ghost = .{ .terminal = frozen, .revision = p.terminal.surface_revision, .text = screenHash(p.terminal) };
}

test "a reopened agent's ghost shows until the agent draws and holds still" {
    var r: Runtime = .{};
    defer r.deinit();
    const p = try testPane(&r, try r.workspaces.add("ghost", "/tmp"), null);
    try testGhost(p, "\x1b[2mOLD SCREEN THAT WRAPS\x1b[0m");
    try std.testing.expect(p.displayed() == p.ghost.?.terminal);
    // Modes and rewrapping are not the agent drawing.
    p.terminal.feed("\x1b[?25l\x1b[?2004h\x1b[>1u");
    try std.testing.expect(!p.watchGhost(0));
    try p.resize(8, 6);
    try std.testing.expect(!p.watchGhost(10_000));
    try std.testing.expectEqual(null, p.ghost.?.drawn_at);
    p.terminal.feed("\x1b[2J\x1b[Hfirst");
    try std.testing.expect(!p.watchGhost(100));
    p.terminal.feed("\x1b[2J\x1b[Hsecond");
    try std.testing.expect(!p.watchGhost(350));
    try std.testing.expect(!p.watchGhost(350 + Ghost.quiet_ms - 1));
    try std.testing.expect(p.watchGhost(350 + Ghost.quiet_ms));
    try std.testing.expect(p.displayed() == p.terminal);
    try std.testing.expect(!p.watchGhost(10_000));
}

test "a ghost goes as soon as the agent's screen reads as the old one, or after the longest wait" {
    var r: Runtime = .{};
    defer r.deinit();
    const ws = try r.workspaces.add("ghost", "/tmp");
    const caught_up = try testPane(&r, ws, null);
    try testGhost(caught_up, "\x1b[2mOLD\x1b[0m");
    caught_up.terminal.feed("\x1b[2J");
    try std.testing.expect(!caught_up.watchGhost(100));
    caught_up.terminal.feed("\x1b[HOLD");
    try std.testing.expect(caught_up.watchGhost(150));
    const busy = try testPane(&r, ws, null);
    try testGhost(busy, "\x1b[2mOLD\x1b[0m");
    var now: i64 = 0;
    while (busy.ghost != null) : (now += 100) {
        busy.terminal.feed(if (@mod(now, 200) == 0) "\x1b[Htick" else "\x1b[Htock");
        _ = busy.watchGhost(now);
    }
    try std.testing.expectEqual(Ghost.longest_ms + 100, now);
    // A pane closed under its ghost frees it.
    const closing = try testPane(&r, ws, null);
    try testGhost(closing, "OLD");
    try r.close(closing.id);
}

test "a blank ghost waits for the agent to hold still, even on a cleared screen" {
    var r: Runtime = .{};
    defer r.deinit();
    const p = try testPane(&r, try r.workspaces.add("ghost", "/tmp"), null);
    p.ghost = .{ .terminal = try Terminal.create(p.terminal.vt.cols, p.terminal.vt.rows), .old_screen = false, .revision = p.terminal.surface_revision, .text = screenHash(p.terminal) };
    p.terminal.feed("history");
    try std.testing.expect(!p.watchGhost(100));
    // Clearing to draw again is not catching up to a blank screen.
    p.terminal.feed("\x1b[2J");
    try std.testing.expect(!p.watchGhost(200));
    try std.testing.expect(p.watchGhost(200 + Ghost.quiet_ms));
}
