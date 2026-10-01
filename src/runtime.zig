//! Session resources and operations, independent of any viewer's presentation.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
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
    cwd: []const u8,
    resume_hint: ResumeHint = .{},

    pub fn agent(p: *const Pane) *agents.Agent {
        return p.attachment.agent();
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

pub const ClosedPane = struct {
    label: pane_label.Label = .{},
    terminal: *Terminal,
    cwd: []const u8,
    tab: layout.Tab,
    workspace_id: WorkspaceId,
    pub fn deinit(p: ClosedPane) void {
        p.terminal.destroy();
        a.free(p.cwd);
    }
};

pub const Runtime = struct {
    workspaces: workspace.Store = .{},
    panes: std.ArrayList(Pane) = .empty,
    closed: std.ArrayList(ClosedPane) = .empty,
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
    revision: u64 = 1,
    git_push: git_push.Manager = .{},
    git_status: git_status.Tracker = .{},
    ports: ports.Tracker = .{},
    resources: resources.Tracker = .{},
    link_labels: link_labels.Cache = .{},

    pub fn changed(r: *Runtime) void {
        r.revision +%= 1;
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
        for (r.panes.items) |p| {
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
        const previous = owner.model.tabs[owner.model.tabForPane(id).?];
        try r.closed.ensureUnusedCapacity(a, 1);
        try r.stopped.ensureUnusedCapacity(a, 1);
        try owner.model.close(id);
        owner.model.revision +%= 1;
        for (r.panes.items, 0..) |*p, i| if (p.id == id) {
            p.refreshCwd();
            _ = p.terminal.read();
            _ = p.terminal.reap();
            r.stopShell(p.terminal);
            if (r.closed.items.len == 8) r.closed.orderedRemove(0).deinit();
            r.closed.appendAssumeCapacity(.{ .label = p.label, .terminal = p.terminal, .cwd = p.cwd, .tab = previous, .workspace_id = owner.id });
            _ = r.panes.orderedRemove(i);
            break;
        };
        r.changed();
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

    pub fn restore(r: *Runtime, fallback: Create) !layout.PaneId {
        if (r.closed.items.len == 0) return error.NoClosedPane;
        const saved = r.closed.items[r.closed.items.len - 1];
        const content = try saved.terminal.snapshot();
        defer a.free(content);
        var opts = fallback;
        if (r.workspaces.get(saved.workspace_id) != null) opts.workspace = saved.workspace_id;
        opts.cwd = saved.cwd;
        opts.title = saved.tab.title.text();
        const id = try r.create(opts);
        const p = r.pane(id).?;
        p.label = saved.label;
        p.terminal.feed(content);
        p.terminal.feed("\x1b[0m\r\n[Corgi: restored output; new shell]\r\n");
        _ = r.closed.pop();
        saved.deinit();
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
        try r.closed.ensureUnusedCapacity(a, @min(r.panes.items.len, 8));
        while (ws.model.count > 0) try r.close(ws.model.firstPane(ws.model.tabs[0].root));
        var i: usize = 0;
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
