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
    const known = for ([_][]const u8{ "viewer.open", "viewer.sync", "viewer.search", "pane.acknowledge" }) |name| {
        if (eq(u8, op, name)) break true;
    } else false;
    if (!known) return false;
    try protocol.require(v, cl.protocol_version);
    if (eq(u8, op, "viewer.open")) {
        if (cl.subscribed or cl.viewer) return error.AlreadyAttached;
        if (s.runtime.panes.items.len == 0 and s.initialWorkspace().model.count == 0) {
            const cwd = agents.str(v, "cwd");
            if (s.default_folder_pending and cwd.len > 0) {
                try s.runtime.workspaces.edit(s.initialWorkspace().id, s.initialWorkspace().customName(), cwd);
                s.default_folder_pending = false;
                s.saveWorkspaces();
            }
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            _ = try s.execute(.{ .@"pane.create" = .{ .workspace = s.initialWorkspace().id } }, arena.allocator());
        }
        const first = for (s.clients.items) |other| {
            if (other.viewer and !other.dead) break false;
        } else true;
        cl.viewer = true;
        cl.viewer_id = s.next_viewer;
        s.next_viewer += 1;
        cl.view_workspace = s.initialWorkspace().id;
        cl.protocol_version = 1;
        if (first) s.updateTheme(v);
        try cl.queue(.{ .ok = true, .bell_seq = s.bell_seq, .workspace = s.initialWorkspace().id });
    } else if (eq(u8, op, "viewer.sync")) {
        if (!cl.viewer) return error.NotAttached;
        const Request = struct { interests: []const @import("peer.zig").Interest, focus: ?u32 = null, watched: bool = true, workspace: u32 = 0, ack: u64 = 0 };
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
        if (cl.watched) {
            s.visitWorkspace(cl.view_workspace);
            if (s.preferred_workspace != cl.view_workspace) {
                s.preferred_workspace = cl.view_workspace;
                s.saveWorkspaces();
            }
        }
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
        const result = try p.terminal.search(parsed.value.needle, parsed.value.skip);
        try cl.queue(.{ .ok = true, .offset = result.offset, .match = result.match });
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
fn targetViewer(s: anytype, v: std.json.Value) !?*@import("peer.zig").Client {
    if (eq(u8, agents.str(v, "name"), "relaunch")) {
        const pane = try protocol.id(v, "pane");
        var target: ?*@import("peer.zig").Client = null;
        for (s.clients.items) |*view| if (view.viewer and !view.dead and view.view_focus == pane) {
            if (target != null) return error.AmbiguousViewer;
            target = view;
        };
        const view = target orelse return error.NoViewer;
        if (!std.fs.path.isAbsolute(agents.str(v, "value"))) return error.InvalidExecutable;
        return view;
    }
    if (v.object.get("viewer")) |_| {
        const id = try protocol.id(v, "viewer");
        for (s.clients.items) |*cl| if (cl.viewer and !cl.dead and cl.viewer_id == id) return cl;
        return error.NoViewer;
    }
    // An unqualified CLI command targets the oldest live viewer.
    for (s.clients.items) |*cl| if (cl.viewer and !cl.dead) return cl;
    return null;
}
pub fn routeControl(s: anytype, cl: anytype, v: std.json.Value) anyerror!bool {
    const op = agents.str(v, "op");
    if (eq(u8, op, "viewer.list")) {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        try cl.queue(.{ .ok = true, .viewers = try viewers(s, arena.allocator()) });
        return true;
    }
    if (!eq(u8, op, "action") and !eq(u8, op, "focus") and !eq(u8, op, "workspace.switch")) return false;
    const target = try targetViewer(s, v) orelse return error.NoViewer;
    if (target.controls.items.len >= 64) return error.ViewerBusy;
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
    return true;
}

fn enqueue(cl: anytype, value: @import("peer.zig").Control) !void {
    var control = value;
    control.seq = cl.next_control;
    try cl.controls.append(a, control);
    cl.next_control += 1;
}

const ViewerInfo = struct { id: u32, workspace: u32, pane: ?u32, watched: bool };
pub fn viewers(s: anytype, alloc: std.mem.Allocator) ![]const ViewerInfo {
    var result: std.ArrayList(ViewerInfo) = .empty;
    for (s.clients.items) |view| if (view.viewer and !view.dead) try result.append(alloc, .{ .id = view.viewer_id, .workspace = view.view_workspace, .pane = view.view_focus, .watched = view.watched });
    return result.toOwnedSlice(alloc);
}
