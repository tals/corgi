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
    agent: agents.Agent = .{},
    detection: @import("detection.zig").Tracker = .{},
    cwd: []const u8,
    resume_hint: @import("checkpoint.zig").Resume = .{},

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
    revision: u64 = 1,
    git_status: @import("git_status.zig").Tracker = .{},
    ports: @import("ports.zig").Tracker = .{},

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
    }

    pub fn pane(r: *Runtime, id: layout.Id) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }

    pub fn getWorkspace(r: *Runtime, id: u32) !*workspace.Workspace {
        return &r.workspaces.items.items[r.workspaces.index(id) orelse return error.NoWorkspace];
    }

    pub const Create = struct {
        workspace: u32,
        split: ?struct { pane: layout.Id, axis: layout.Axis } = null,
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
    /// The legacy UI selects the returned ID itself until milestone 2.
    pub fn create(r: *Runtime, opts: Create) !layout.Id {
        if (r.panes.items.len >= layout.max_panes) return error.TooManyPanes;
        const ws = try r.getWorkspace(opts.workspace);
        var next = ws.model;
        next.next_id = r.workspaces.next_pane_id;
        if (opts.split) |split| try next.focus(split.pane);
        const id = if (opts.split) |split| try next.split(split.axis) else try next.newTab(opts.title);
        retainSelection(&next, &ws.model);
        const dir = try workspace.Store.directory(opts.cwd);
        errdefer a.free(dir);
        const t = try Terminal.create(opts.cols, opts.rows);
        errdefer t.destroy();
        t.record();
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
        var previous = owner.model;
        try previous.focus(id);
        try r.closed.ensureUnusedCapacity(a, 1);
        try owner.model.close(id);
        for (r.panes.items, 0..) |*p, i| if (p.id == id) {
            p.refreshCwd();
            _ = p.terminal.read();
            p.terminal.stop();
            if (r.closed.items.len == 8) r.closed.orderedRemove(0).deinit();
            r.closed.appendAssumeCapacity(.{ .label = p.label, .terminal = p.terminal, .cwd = p.cwd, .tab = previous.tab().*, .workspace_id = owner.id });
            _ = r.panes.orderedRemove(i);
            break;
        };
        r.changed();
    }

    pub fn resizeSplit(r: *Runtime, id: layout.Id, direction: layout.Direction) !void {
        const owner = r.workspaces.owner(id) orelse return error.NoPane;
        var next = owner.model;
        try next.focus(id);
        next.resize(direction);
        retainSelection(&next, &owner.model);
        owner.model = next;
        r.changed();
    }

    pub fn renameTab(r: *Runtime, id: layout.Id, title: []const u8) !void {
        for (r.workspaces.items.items) |*ws| {
            for (ws.model.tabs[0..ws.model.count]) |*tab| if (tab.id == id) {
                tab.rename(title);
                r.changed();
                return;
            };
        }
        return error.NoTab;
    }
};

fn retainSelection(next: *layout.Model, previous: *const layout.Model) void {
    for (previous.tabs[0..previous.count], 0..) |old, i| {
        // Create/split/resize preserve the order and IDs of all existing tabs.
        next.tabs[i].focus = old.focus;
        next.tabs[i].zoom = old.zoom;
    }
    next.active = previous.active;
}

test "targeted layout edits retain the legacy selection" {
    var runtime: Runtime = .{};
    defer runtime.deinit();
    _ = try runtime.workspaces.add("one", ".");
    const model = &runtime.workspaces.current().model;
    const first = try model.newTab("first");
    _ = try model.split(.horizontal);
    const second = try model.newTab("second");
    const before = model.*;
    try runtime.resizeSplit(first, .right);
    try std.testing.expectEqual(second, model.tab().focus);
    try std.testing.expectEqual(before.active, model.active);
    try std.testing.expectEqual(before.tabs[0].focus, model.tabs[0].focus);
    try std.testing.expect(!std.meta.eql(before.nodes, model.nodes));
}
