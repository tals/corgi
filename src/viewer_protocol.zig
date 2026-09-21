//! Runtime operations for viewer-owned presentation. No menus, key bindings,
//! screen coordinates, or composed UI frames are produced by this interface.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const agents = @import("agents.zig");
const surface = @import("surface.zig");
const workspace = @import("workspace.zig");
const eq = std.mem.eql;

pub fn handle(s: anytype, cl: anytype, v: std.json.Value) anyerror!bool {
    const op = agents.str(v, "op");
    const known = for ([_][]const u8{ "viewer.open", "viewer.sync", "viewer.search", "layout.apply", "pane.transfer", "pane.restore", "pane.acknowledge", "workspace.create", "pane.rename", "workspace.move" }) |name| {
        if (eq(u8, op, name)) break true;
    } else false;
    if (!known) return false;
    try protocol.require(v, cl.protocol_version);
    if (eq(u8, op, "pane.rename")) {
        const p = s.runtime.pane(try protocol.id(v, "pane")) orelse return error.NoPane;
        p.label.set(agents.str(v, "name"));
        s.runtime.changed();
        s.dirty = true;
        try cl.queue(.{ .ok = true });
    } else if (eq(u8, op, "workspace.move")) {
        const id = try protocol.id(v, "workspace");
        const before = try protocol.id(v, "before");
        try s.runtime.workspaces.moveBefore(id, before);
        s.runtime.changed();
        s.saveWorkspaces();
        s.dirty = true;
        try cl.queue(.{ .ok = true });
    } else if (eq(u8, op, "viewer.open")) {
        if (cl.attached or cl.subscribed or cl.viewer) return error.AlreadyAttached;
        if (s.runtime.panes.items.len == 0 and s.runtime.workspaces.current().model.count == 0) {
            const cwd = agents.str(v, "cwd");
            if (s.default_folder_pending and cwd.len > 0) {
                try s.runtime.workspaces.edit(s.runtime.workspaces.current().id, s.runtime.workspaces.current().customName(), cwd);
                s.default_folder_pending = false;
                s.saveWorkspaces();
            }
            _ = try s.runtime.create(.{ .workspace = s.runtime.workspaces.current().id, .cwd = s.runtime.workspaces.current().cwd, .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
        }
        const first = for (s.clients.items) |other| {
            if ((other.viewer or other.attached) and !other.dead) break false;
        } else true;
        cl.can_relaunch = if (v.object.get("can_relaunch")) |flag| flag == .bool and flag.bool else false;
        cl.viewer = true;
        cl.viewer_id = s.next_viewer;
        s.next_viewer += 1;
        cl.view_workspace = s.runtime.workspaces.current().id;
        cl.protocol_version = 1;
        if (first) s.updateTheme(v);
        try cl.queue(.{ .ok = true, .bell_seq = s.bell_seq });
    } else if (eq(u8, op, "viewer.sync")) {
        if (!cl.viewer) return error.NotAttached;
        const Request = struct { interests: []const @import("controller.zig").Interest, focus: ?u32 = null, watched: bool = true, workspace: u32 = 0, ack: u64 = 0 };
        const parsed = try std.json.parseFromValue(Request, a, v, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const req = parsed.value;
        if (req.interests.len > layout.max_panes) return error.TooManyPanes;
        for (req.interests, 0..) |interest, i| {
            if (interest.cols == 0 or interest.cols > 500 or interest.rows == 0 or interest.rows > 200) return error.InvalidSize;
            for (req.interests[0..i]) |other| if (other.pane == interest.pane) return error.InvalidTarget;
        }
        if (req.ack >= cl.next_control or req.ack < cl.last_control) return error.InvalidAcknowledgement;
        while (cl.controls.items.len > 0 and cl.controls.items[0].seq <= req.ack) {
            const done = cl.controls.orderedRemove(0);
            if (done.kind == .action) {
                a.free(done.name);
                a.free(done.value);
            }
        }
        cl.last_control = req.ack;
        cl.interest_count = 0;
        for (req.interests) |interest| if (s.runtime.pane(interest.pane) != null) {
            cl.interests[cl.interest_count] = interest;
            cl.interest_count += 1;
        };
        cl.view_focus = null;
        for (cl.interests[0..cl.interest_count]) |interest| if (req.focus == interest.pane) {
            cl.view_focus = req.focus;
        };
        cl.watched = req.watched;
        if (s.runtime.workspaces.index(req.workspace) != null) cl.view_workspace = req.workspace;
        if (cl.watched) s.visitWorkspace(cl.view_workspace);
        try resize(s);
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const allocator = arena.allocator();
        const frames = try allocator.alloc(surface.View, cl.interest_count);
        for (cl.interests[0..cl.interest_count], frames) |interest, *out| {
            out.* = try surface.captureView(allocator, interest.pane, s.runtime.pane(interest.pane).?.terminal, interest.offset);
        }
        try cl.queue(.{ .type = "view", .session = try protocol.snapshot(allocator, &s.runtime), .surfaces = frames, .bell_seq = s.bell_seq, .bell_kind = s.last_bell_kind, .controls = cl.controls.items, .viewer = cl.viewer_id, .detach = s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.items.len == 1 });
    } else if (eq(u8, op, "viewer.search")) {
        const p = s.runtime.pane(try protocol.id(v, "pane")) orelse return error.NoPane;
        const Request = struct { needle: []const u8, skip: usize = 0 };
        const parsed = try std.json.parseFromValue(Request, a, v, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const screen = p.terminal.vt.screens.active;
        var offset: ?usize = null;
        var match: ?struct { x: u16, y: u16, end_x: u16, end_y: u16 } = null;
        if (parsed.value.needle.len > 0) {
            var finder = try @import("terminal.zig").vt.search.PageList.init(a, parsed.value.needle, &screen.pages, screen.pages.pages.last orelse return error.EmptyScreen);
            defer finder.deinit();
            var index: usize = 0;
            outer: while (true) {
                while (finder.next()) |sel| {
                    if (index == parsed.value.skip) {
                        const point = screen.pages.pointFromPin(.screen, sel.startPin());
                        if (point) |pnt| {
                            offset = @min(pnt.screen.y, screen.pages.total_rows -| p.terminal.vt.rows);
                            const end = screen.pages.pointFromPin(.screen, sel.endPin()) orelse pnt;
                            match = .{ .x = pnt.screen.x, .y = @intCast(pnt.screen.y - offset.?), .end_x = end.screen.x, .end_y = @intCast(@min(end.screen.y - offset.?, p.terminal.vt.rows - 1)) };
                        }
                        break :outer;
                    }
                    index += 1;
                }
                if (!try finder.feed()) break;
            }
        }
        try cl.queue(.{ .ok = true, .offset = offset, .match = match });
    } else if (eq(u8, op, "layout.apply")) {
        const Request = struct { workspace: u32, token: u64, tabs: []const protocol.Tab };
        const parsed = try std.json.parseFromValue(Request, a, v, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const req = parsed.value;
        const ws = try s.runtime.getWorkspace(req.workspace);
        if (req.token != try protocol.layoutToken(&ws.model)) return error.StaleLayout;
        const next = try protocol.modelFromTabs(req.tabs, &ws.model);
        // Reorder, rename, ratios, and swaps cannot introduce/remove identities.
        if (next.count != ws.model.count) return error.InvalidLayout;
        for (ws.model.tabs[0..ws.model.count]) |tab| {
            const found = for (next.tabs[0..next.count]) |other| {
                if (tab.id == other.id) break true;
            } else false;
            if (!found) return error.InvalidLayout;
        }
        for (next.nodes) |maybe| if (maybe) |node| if (node == .pane and ws.model.tabForPane(node.pane) == null) return error.InvalidLayout;
        for (ws.model.nodes) |maybe| if (maybe) |node| if (node == .pane and next.tabForPane(node.pane) == null) return error.InvalidLayout;
        ws.model = next;
        try s.resizePanes();
        try resize(s);
        s.runtime.changed();
        s.dirty = true;
        try cl.queue(.{ .ok = true });
    } else if (eq(u8, op, "pane.acknowledge")) {
        const p = s.runtime.pane(try protocol.id(v, "pane")) orelse return error.NoPane;
        const through = if (v.object.get("through")) |value| if (value == .integer and value.integer >= 0) @as(u64, @intCast(value.integer)) else return error.InvalidAcknowledgement else 0;
        if (!eq(u8, agents.str(v, "session"), p.agent.sessionId())) return error.StaleAcknowledgement;
        if (p.agent.attention != .none or p.agent.observation.unread()) {
            if (v.object.get("attention_at")) |stamp| {
                if (stamp == .integer and stamp.integer == p.agent.changed_at) p.agent.attention = .none;
            }
            p.agent.readThrough(through);
            s.runtime.changed();
            s.dirty = true;
        }
        try cl.queue(.{ .ok = true });
    } else if (eq(u8, op, "pane.transfer")) {
        const id = try protocol.id(v, "pane");
        const ws = s.runtime.workspaces.owner(id) orelse return error.NoPane;
        const dest_value = v.object.get("tab") orelse return error.MissingTarget;
        if (dest_value != .integer or dest_value.integer < 0 or dest_value.integer > std.math.maxInt(u32)) return error.InvalidTarget;
        const dest: u32 = @intCast(dest_value.integer);
        var next = ws.model;
        next.next_id = s.runtime.workspaces.next_pane_id;
        try next.focus(id);
        if (dest == 0) try next.breakPane() else {
            const index = for (next.tabs[0..next.count], 0..) |tab, i| {
                if (tab.id == dest) break i;
            } else return error.NoTab;
            try next.joinPane(index);
        }
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        var restored = try protocol.modelFromTabs(try protocol.encodeTabs(arena.allocator(), &next), &ws.model);
        restored.next_id = next.next_id;
        ws.model = restored;
        try s.resizePanes();
        try resize(s);
        s.runtime.workspaces.next_pane_id = next.next_id;
        s.runtime.changed();
        s.dirty = true;
        try cl.queue(.{ .ok = true });
    } else if (eq(u8, op, "pane.restore")) {
        if (s.runtime.closed.items.len == 0) return error.NoClosedPane;
        const saved = s.runtime.closed.items[s.runtime.closed.items.len - 1];
        const ws = try s.runtime.getWorkspace(if (s.runtime.workspaces.index(saved.workspace_id) != null) saved.workspace_id else try protocol.id(v, "workspace"));
        const content = try saved.terminal.snapshot();
        defer a.free(content);
        const id = try s.runtime.create(.{ .workspace = ws.id, .cwd = saved.cwd, .title = saved.tab.title(), .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
        s.runtime.pane(id).?.label = saved.label;
        const term = s.runtime.pane(id).?.terminal;
        term.feed(content);
        term.feed("\x1b[0m\r\n[Corgi: restored output; new shell]\r\n");
        _ = s.runtime.closed.pop();
        saved.deinit();
        s.dirty = true;
        try cl.queue(.{ .ok = true, .pane = id });
    } else if (eq(u8, op, "workspace.create")) {
        const id = try s.runtime.workspaces.add(agents.str(v, "name"), agents.str(v, "cwd"));
        errdefer {
            const removed = s.runtime.workspaces.items.pop().?;
            a.free(removed.cwd);
        }
        const ws = try s.runtime.getWorkspace(id);
        _ = try s.runtime.create(.{ .workspace = id, .cwd = ws.cwd, .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
        s.saveWorkspaces();
        s.dirty = true;
        try cl.queue(.{ .ok = true, .workspace = id });
    }
    return true;
}

/// A pane is constrained only by viewers actually displaying it. Hidden panes
/// retain their last size; detaching a smaller viewer lets surviving views grow.
pub fn resize(s: anytype) !void {
    for (s.runtime.panes.items) |p| {
        var cols: u16 = 500;
        var rows: u16 = 200;
        var found = false;
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead) {
            for (cl.interests[0..cl.interest_count]) |interest| if (interest.pane == p.id) {
                cols = @min(cols, interest.cols);
                rows = @min(rows, interest.rows);
                found = true;
            };
        };
        const legacy = for (s.clients.items) |cl| {
            if (cl.attached and !cl.dead) break true;
        } else false;
        if (found and legacy) {
            var places: [layout.max_panes]layout.Placement = undefined;
            for (s.runtime.workspaces.current().model.placements(s.area(), &places)) |place| if (place.id == p.id) {
                cols = @min(cols, @max(1, place.rect.w));
                rows = @min(rows, @max(1, place.rect.h));
            };
        }
        if (found and (p.terminal.vt.cols != cols or p.terminal.vt.rows != rows)) {
            try p.terminal.resize(cols, rows);
            s.runtime.changed();
            s.dirty = true;
        }
    }
}

pub fn clearControls(cl: anytype) void {
    for (cl.controls.items) |control| if (control.kind == .action) {
        a.free(control.name);
        a.free(control.value);
    };
    cl.controls.clearRetainingCapacity();
}
fn targetViewer(s: anytype, v: std.json.Value) !?*@import("controller.zig").Client {
    if (eq(u8, agents.str(v, "name"), "relaunch")) {
        const pane = try protocol.id(v, "pane");
        var target: ?*@import("controller.zig").Client = null;
        for (s.clients.items) |*view| if (view.viewer and !view.dead and view.view_focus == pane) {
            if (target != null) return error.AmbiguousViewer;
            target = view;
        };
        const view = target orelse return error.NoViewer;
        if (!view.can_relaunch) return error.DetachAndReattachViewerOnce;
        if (!std.fs.path.isAbsolute(agents.str(v, "value"))) return error.InvalidExecutable;
        return view;
    }
    if (v.object.get("viewer")) |_| {
        const id = try protocol.id(v, "viewer");
        for (s.clients.items) |*cl| if (cl.viewer and !cl.dead and cl.viewer_id == id) return cl;
        return error.NoViewer;
    }
    // Keep old socket clients' legacy controls. Otherwise a CLI command targets
    // the oldest live viewer; an explicit ID always selects exactly one viewer.
    for (s.clients.items) |cl| if (cl.attached and !cl.dead) return null;
    for (s.clients.items) |*cl| if (cl.viewer and !cl.dead) return cl;
    return null;
}
pub fn routeControl(s: anytype, cl: anytype, v: std.json.Value) anyerror!bool {
    const op = agents.str(v, "op");
    if (eq(u8, op, "viewer.list")) {
        const Info = struct { id: u32, workspace: u32, pane: ?u32, watched: bool };
        var info: [32]Info = undefined;
        var count: usize = 0;
        for (s.clients.items) |view| if (view.viewer and !view.dead) {
            info[count] = .{ .id = view.viewer_id, .workspace = view.view_workspace, .pane = view.view_focus, .watched = view.watched };
            count += 1;
        };
        try cl.queue(.{ .ok = true, .viewers = info[0..count] });
        return true;
    }
    if (!eq(u8, op, "action") and !eq(u8, op, "focus") and !eq(u8, op, "workspace.switch") and !eq(u8, op, "new") and !eq(u8, op, "split")) return false;
    const target = try targetViewer(s, v) orelse return false;
    if (target.controls.items.len >= 64) return error.ViewerBusy;
    if (eq(u8, op, "new") or eq(u8, op, "split")) {
        const split = eq(u8, op, "split");
        // Controls remain pending until the viewer acknowledges applying them.
        // This also covers a split arriving after delivery but before the next sync.
        var focused = target.view_focus;
        var workspace_id = target.view_workspace;
        var unresolved = false;
        for (target.controls.items) |control| switch (control.kind) {
            .focus => {
                focused = control.id;
                workspace_id = (s.runtime.workspaces.owner(control.id) orelse return error.NoPane).id;
                unresolved = false;
            },
            .workspace => {
                workspace_id = control.id;
                focused = null;
                unresolved = split;
            },
            .action => unresolved = true,
        };
        if (unresolved) return error.ViewerBusy;
        const pane = if (split) focused orelse return error.NoPane else 0;
        const ws = if (split) s.runtime.workspaces.owner(pane) orelse return error.NoPane else try s.runtime.getWorkspace(workspace_id);
        const cwd = agents.str(v, "cwd");
        const command = agents.str(v, "command");
        const id = try s.runtime.create(.{ .workspace = ws.id, .split = if (split) .{ .pane = pane, .axis = if (eq(u8, agents.str(v, "axis"), "down")) .vertical else .horizontal } else null, .cwd = if (cwd.len > 0) cwd else s.inheritedCwd(ws, focused), .command = if (command.len > 0) command else null, .title = agents.str(v, "title"), .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
        try enqueue(target, .{ .kind = .focus, .id = id });
        s.dirty = true;
        try cl.queue(.{ .ok = true, .pane = id, .viewer = target.viewer_id });
    } else {
        if (eq(u8, op, "action")) {
            const name = try a.dupe(u8, agents.str(v, "name"));
            errdefer a.free(name);
            const value = try a.dupe(u8, agents.str(v, "value"));
            errdefer a.free(value);
            try enqueue(target, .{ .kind = .action, .name = name, .value = value });
        } else if (eq(u8, op, "focus")) {
            const id = try protocol.id(v, "pane");
            if (s.runtime.pane(id) == null) return error.NoPane;
            try enqueue(target, .{ .kind = .focus, .id = id });
        } else {
            const id = try protocol.id(v, "workspace");
            _ = try s.runtime.getWorkspace(id);
            try enqueue(target, .{ .kind = .workspace, .id = id });
        }
        try cl.queue(.{ .ok = true, .viewer = target.viewer_id, .queued = true });
    }
    return true;
}

fn enqueue(cl: anytype, value: @import("controller.zig").Control) !void {
    var control = value;
    control.seq = cl.next_control;
    try cl.controls.append(a, control);
    cl.next_control += 1;
}
