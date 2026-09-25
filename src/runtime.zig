//! Session resources and operations, independent of any viewer's presentation.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const agents = @import("agents.zig");
const Terminal = @import("terminal.zig").Terminal;
const native = @import("native.zig");
const Theme = @import("theme.zig").Theme;

pub const Pane = struct {
    label: @import("pane_label.zig").Label = .{},
    id: layout.Id,
    terminal: *Terminal,
    attachment: @import("conversations.zig").Attachment = .{},

    detection: @import("detection.zig").Tracker = .{},
    cwd: []const u8,
    resume_hint: @import("checkpoint.zig").Resume = .{},

    pub fn agent(p: *const Pane) *agents.Agent {
        return p.attachment.agent();
    }

    pub fn refreshCwd(p: *Pane) void {
        if (p.terminal.exited) return;
        if ((if (p.detection.pid > 0) os.processCwd(p.detection.pid) else null) orelse (if (os.c.tcgetpgrp(p.terminal.fd) > 0) os.processCwd(os.c.tcgetpgrp(p.terminal.fd)) else null) orelse os.processCwd(p.terminal.pid)) |cwd| {
            a.free(p.cwd);
            p.cwd = cwd;
        }
    }
};

pub const ClosedPane = struct {
    label: @import("pane_label.zig").Label = .{},
    terminal: *Terminal,
    cwd: []const u8,
    tab: layout.Tab,
    workspace_id: u32,
    pub fn deinit(p: ClosedPane) void {
        p.terminal.destroy();
        a.free(p.cwd);
    }
};

pub const Runtime = struct {
    workspaces: workspace.Store = .{},
    panes: std.ArrayList(Pane) = .empty,
    closed: std.ArrayList(ClosedPane) = .empty,
    sessions: std.ArrayList(native.Session) = .empty,
    next_session: u32 = 1,
    conversations: @import("conversations.zig").Registry = .{},
    revision: u64 = 1,
    git_status: @import("git_status.zig").Tracker = .{},
    ports: @import("ports.zig").Tracker = .{},
    link_labels: @import("link_labels.zig").Cache = .{},

    pub fn changed(r: *Runtime) void {
        r.revision +%= 1;
    }

    pub fn deinit(r: *Runtime) void {
        r.ports.deinit();
        r.git_status.deinit();
        for (r.panes.items) |p| {
            p.terminal.destroy();
            a.free(p.cwd);
        }
        r.panes.deinit(a);
        for (r.closed.items) |p| p.deinit();
        r.closed.deinit(a);
        for (r.sessions.items) |*session| session.destroy();
        r.sessions.deinit(a);
        r.workspaces.deinit();
        r.conversations.deinit();
    }

    pub fn pane(r: *Runtime, id: layout.Id) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }

    pub fn getWorkspace(r: *Runtime, id: u32) !*workspace.Workspace {
        return r.workspaces.get(id) orelse error.NoWorkspace;
    }

    pub const Create = struct {
        workspace: u32,
        split: ?struct { pane: layout.Id, axis: layout.Axis, before: bool = false } = null,
        cwd: []const u8,
        command: ?[]const u8 = null,
        title: []const u8 = "",
        cols: u16,
        rows: u16,
        theme: Theme,
        socket: []const u8,
        executable: []const u8,
    };

    /// Changes the shared arrangement without selecting the result in a viewer.
    pub fn create(r: *Runtime, opts: Create) !layout.Id {
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
        try t.spawn(dir, opts.socket, id, opts.executable, opts.command);
        r.panes.appendAssumeCapacity(.{ .id = id, .terminal = t, .cwd = dir });
        ws.model = next;
        r.workspaces.next_pane_id = next.next_id;
        r.changed();
        return id;
    }

    pub fn close(r: *Runtime, id: layout.Id) !void {
        const owner = r.workspaces.owner(id) orelse return error.NoPane;
        const previous = owner.model.tabs[owner.model.tabForPane(id).?];
        try r.closed.ensureUnusedCapacity(a, 1);
        try owner.model.close(id);
        owner.model.revision +%= 1;
        for (r.panes.items, 0..) |*p, i| if (p.id == id) {
            p.refreshCwd();
            _ = p.terminal.read();
            p.terminal.stop();
            if (r.closed.items.len == 8) r.closed.orderedRemove(0).deinit();
            r.closed.appendAssumeCapacity(.{ .label = p.label, .terminal = p.terminal, .cwd = p.cwd, .tab = previous, .workspace_id = owner.id });
            _ = r.panes.orderedRemove(i);
            break;
        };
        r.changed();
    }

    pub fn restore(r: *Runtime, fallback: Create) !layout.Id {
        if (r.closed.items.len == 0) return error.NoClosedPane;
        const saved = r.closed.items[r.closed.items.len - 1];
        const content = try saved.terminal.snapshot();
        defer a.free(content);
        var opts = fallback;
        if (r.workspaces.get(saved.workspace_id) != null) opts.workspace = saved.workspace_id;
        opts.cwd = saved.cwd;
        opts.title = saved.tab.title();
        const id = try r.create(opts);
        const p = r.pane(id).?;
        p.label = saved.label;
        p.terminal.feed(content);
        p.terminal.feed("\x1b[0m\r\n[Corgi: restored output; new shell]\r\n");
        _ = r.closed.pop();
        saved.deinit();
        return id;
    }
    pub fn createWorkspace(r: *Runtime, name: []const u8, opts: Create) !u32 {
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
    pub fn closeWorkspace(r: *Runtime, id: u32, close_contents: bool) !void {
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
