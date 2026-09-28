//! Runtime operations for viewer-owned presentation. No menus, key bindings,
//! screen coordinates, or composed UI frames are produced by this interface.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const viewer_version = @import("viewer_version.zig");
const agents = @import("agents.zig");
const surface = @import("surface.zig");
const workspace = @import("workspace.zig");
const peer = @import("peer.zig");
const Client = peer.Client;
const Server = @import("server.zig").Server;
const WorkspaceId = workspace.Workspace.Id;
const Op = protocol.Op;

pub fn handle(s: *Server, cl: *Client, v: std.json.Value, op: Op) !void {
    if ((op == .@"viewer.open" or op == .@"viewer.sync") and !viewer_version.compatible(v)) {
        cl.queue(.{ .err = "UnsupportedViewerProtocol", .viewer_protocol = viewer_version.version });
        return;
    }
    try protocol.require(v, cl.protocol_version);
    if (op == .@"viewer.open") {
        if (cl.subscribed or cl.launch_preview != null or cl.viewer) return error.AlreadyAttached;
        if (s.runtime.panes.items.len == 0 and s.initialWorkspace().model.count == 0) {
            const cwd = agents.str(v, "cwd");
            if (s.default_folder_pending and cwd.len > 0) {
                try s.runtime.workspaces.edit(s.initialWorkspace().id, s.initialWorkspace().customName(), cwd);
                s.default_folder_pending = false;
                s.saveWorkspaces();
            }
            // The wizard may import live work. Leave its starter workspace
            // empty until the user chooses to launch something instead.
            const onboarding = if (v.object.get("onboarding")) |value| value == .bool and value.bool else false;
            if (!onboarding) {
                var arena = std.heap.ArenaAllocator.init(a);
                defer arena.deinit();
                _ = try s.execute(.{ .@"pane.create" = .{ .workspace = s.initialWorkspace().id } }, arena.allocator());
            }
        }
        const first = for (s.clients.items) |other| {
            if (other.viewer and !other.dead) break false;
        } else true;
        cl.viewer = true;
        cl.viewer_id = s.next_viewer;
        s.next_viewer += 1;
        s.next_active += 1;
        cl.active_seq = s.next_active;
        cl.view_workspace = s.initialWorkspace().id;
        cl.protocol_version = 1;
        if (first) s.updateTheme(v);
        cl.queue(.{ .ok = true, .viewer_protocol = viewer_version.version, .bell_seq = s.bell_seq, .workspace = s.initialWorkspace().id });
    } else if (op == .@"viewer.sync") {
        if (!cl.viewer) return error.NotAttached;
        const Request = struct {
            interests: []const peer.Interest,
            session_hash: ?u64 = null,
            focus: ?layout.PaneId = null,
            watched: bool = true,
            workspace: WorkspaceId = .none,
            ack: u64 = 0,
            active: bool = false,
            resource_detail: ?WorkspaceId = null,
            resources: bool = true,
            resources_hash: ?u64 = null,
        };
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
        cl.resources = req.resources;
        cl.resource_detail = if (req.resource_detail) |id| if (s.runtime.workspaces.get(id) != null) id else null else null;
        if (req.active) {
            s.next_active += 1;
            cl.active_seq = s.next_active;
        }
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
        var frames: std.ArrayList(surface.View) = .empty;
        for (cl.interests[0..cl.interest_count]) |interest| {
            const terminal = s.runtime.pane(interest.pane).?.terminal;
            if (interest.known) |receipt| if (std.meta.eql(receipt, surface.stamp(terminal, interest.offset))) continue;
            try frames.append(allocator, try surface.captureView(allocator, interest.pane, terminal, interest.offset));
        }
        // Snapshot fields include time-dependent usage and metadata updated by
        // independent workers. Compare the actual payload, not just layout revision.
        const session = try std.json.Stringify.valueAlloc(allocator, try protocol.viewerSnapshot(allocator, &s.runtime), .{});
        const session_hash = std.hash.Wyhash.hash(0, session);
        // Readings change every few seconds while the session stays put, and
        // each viewer asks for its own detail, so they have their own hash.
        const usage = try s.runtime.resources.current.forViewer(allocator, cl.resource_detail);
        const readings = try std.json.Stringify.valueAlloc(allocator, usage, .{});
        const resources_hash = std.hash.Wyhash.hash(0, readings);
        cl.queue(.{
            .type = "view",
            .viewer_protocol = viewer_version.version,
            .session = if (req.session_hash == session_hash) @as(?RawJson, null) else RawJson{ .bytes = session },
            .session_hash = session_hash,
            .resources = if (req.resources_hash == resources_hash) @as(?RawJson, null) else RawJson{ .bytes = readings },
            .resources_hash = resources_hash,
            .surfaces = frames.items,
            .bell_seq = s.bell_seq,
            .bell_kind = s.last_bell_kind,
            .controls = cl.controls.items,
            .viewer = cl.viewer_id,
            .detach = s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.items.len == 1,
        });
    } else if (op == .@"viewer.search") {
        const p = s.runtime.pane(try protocol.typedId(layout.PaneId, v, "pane")) orelse return error.NoPane;
        const Request = struct { needle: []const u8, skip: usize = 0 };
        const parsed = try std.json.parseFromValue(Request, a, v, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const result = try p.terminal.search(parsed.value.needle, parsed.value.skip);
        cl.queue(.{ .ok = true, .offset = result.offset, .match = result.match });
    } else if (op == .@"pane.acknowledge") {
        const p = s.runtime.pane(try protocol.typedId(layout.PaneId, v, "pane")) orelse return error.NoPane;
        const through = if (v.object.get("through")) |value| if (value == .integer and value.integer >= 0) @as(u64, @intCast(value.integer)) else return error.InvalidAcknowledgement else 0;
        if (!std.mem.eql(u8, agents.str(v, "session"), p.agent().sessionId())) return error.StaleAcknowledgement;
        if (v.object.get("binding")) |value| if (value != .integer or value.integer != p.attachment.generation) return error.StaleAcknowledgement;
        if (v.object.get("conversation")) |value| if (value != .integer or value.integer != @intFromEnum(if (p.attachment.actor) |actor| actor.id else ActorId.none)) return error.StaleAcknowledgement;
        if (p.agent().attention != .none or p.agent().observation.unread()) {
            const stamp: ?i64 = if (v.object.get("attention_at")) |value| (if (value == .integer) value.integer else null) else null;
            if (p.attachment.actor) |actor| {
                actor.acknowledge(through, stamp);
            } else {
                if (stamp == p.agent().changed_at) p.agent().attention = .none;
                p.agent().readThrough(through);
            }
            s.runtime.changed();
            s.dirty = true;
        }
        cl.queue(.{ .ok = true });
    }
}

const RawJson = struct {
    bytes: []const u8,
    pub fn jsonStringify(self: RawJson, writer: *std.json.Stringify) !void {
        try writer.beginWriteRaw();
        try writer.writer.writeAll(self.bytes);
        writer.endWriteRaw();
    }
};

/// A pane takes the size shown by the most recently used viewer displaying it;
/// other viewers clip or pad. Hidden panes retain their last size.
pub fn resize(s: *Server) !void {
    for (s.runtime.panes.items) |p| {
        var chosen: ?peer.Interest = null;
        var latest: u64 = 0;
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead and (chosen == null or cl.active_seq > latest)) {
            for (cl.interests[0..cl.interest_count]) |interest| if (interest.pane == p.id) {
                chosen = interest;
                latest = cl.active_seq;
            };
        };
        const size = chosen orelse continue;
        if (p.terminal.vt.cols != size.cols or p.terminal.vt.rows != size.rows) {
            try p.terminal.resize(size.cols, size.rows);
            s.runtime.changed();
            s.dirty = true;
        }
    }
}

pub fn clearControls(cl: *Client) void {
    for (cl.controls.items) |control| if (control.kind == .action) {
        a.free(control.name);
        a.free(control.value);
    };
    cl.controls.clearRetainingCapacity();
}
fn targetViewer(s: *Server, v: std.json.Value) !?*Client {
    const relaunch = std.mem.eql(u8, agents.str(v, "name"), "relaunch");
    const onboard = std.mem.eql(u8, agents.str(v, "name"), "onboard") and v.object.get("pane") != null;
    if (relaunch or onboard) {
        const pane = try protocol.typedId(layout.PaneId, v, "pane");
        var target: ?*Client = null;
        for (s.clients.items) |*view| if (view.viewer and !view.dead and view.view_focus == pane) {
            if (target != null) return error.AmbiguousViewer;
            target = view;
        };
        const view = target orelse return error.NoViewer;
        if (relaunch and !std.fs.path.isAbsolute(agents.str(v, "value"))) return error.InvalidExecutable;
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
pub fn routeControl(s: *Server, cl: *Client, v: std.json.Value, op: Op) !void {
    if (op == .@"viewer.list") {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        cl.queue(.{ .ok = true, .viewers = try viewers(s, arena.allocator()) });
        return;
    }
    const target = try targetViewer(s, v) orelse return error.NoViewer;
    if (target.controls.items.len >= 64) return error.ViewerBusy;
    if (op == .action) {
        const name = try a.dupe(u8, agents.str(v, "name"));
        errdefer a.free(name);
        const value = try a.dupe(u8, agents.str(v, "value"));
        errdefer a.free(value);
        try enqueue(target, .{ .kind = .action, .name = name, .value = value });
    } else if (op == .focus) {
        const id = try protocol.typedId(layout.PaneId, v, "pane");
        if (s.runtime.pane(id) == null) return error.NoPane;
        try enqueue(target, .{ .kind = .focus, .id = @intFromEnum(id) });
    } else {
        const id = try protocol.typedId(WorkspaceId, v, "workspace");
        _ = try s.runtime.getWorkspace(id);
        try enqueue(target, .{ .kind = .workspace, .id = @intFromEnum(id) });
    }
    cl.queue(.{ .ok = true, .viewer = target.viewer_id, .queued = true });
}

fn enqueue(cl: *Client, value: peer.Control) !void {
    var control = value;
    control.seq = cl.next_control;
    try cl.controls.append(a, control);
    cl.next_control += 1;
}

const ViewerInfo = struct { id: u32, workspace: WorkspaceId, pane: ?layout.PaneId, watched: bool };
pub fn viewers(s: *Server, alloc: std.mem.Allocator) ![]const ViewerInfo {
    var result: std.ArrayList(ViewerInfo) = .empty;
    for (s.clients.items) |view| if (view.viewer and !view.dead) try result.append(alloc, .{
        .id = view.viewer_id,
        .workspace = view.view_workspace,
        .pane = view.view_focus,
        .watched = view.watched,
    });
    return result.toOwnedSlice(alloc);
}
