//! Runtime operations for viewer-owned presentation. No menus, key bindings,
//! screen coordinates, or composed UI frames are produced by this interface.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const viewer_version = @import("viewer_version.zig");
const surface = @import("surface.zig");
const workspace = @import("workspace.zig");
const peer = @import("peer.zig");
const session_command = @import("session.zig");
const Client = peer.Client;
const Server = @import("server.zig").Server;
const WorkspaceId = workspace.Workspace.Id;
const Request = protocol.Request;
const Action = @import("action.zig").Action;

pub fn open(s: *Server, cl: *Client, q: Request.Open) !void {
    if (cl.subscribed or cl.launch_preview != null or cl.viewer) return error.AlreadyAttached;
    if (s.runtime.panes.items.len == 0 and s.initialWorkspace().model.count == 0) {
        if (s.default_folder_pending and q.cwd.len > 0) {
            try s.runtime.workspaces.edit(s.initialWorkspace().id, s.initialWorkspace().customName(), q.cwd);
            s.default_folder_pending = false;
            s.saveWorkspaces();
        }
        // The wizard may import live work. Leave its starter workspace
        // empty until the user chooses to launch something instead.
        if (!q.onboarding) {
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
    if (first) s.updateTheme(q.theme);
    cl.queue(.{ .ok = true, .viewer_protocol = viewer_version.version, .bell_seq = s.bell_seq, .workspace = s.initialWorkspace().id });
}

pub fn sync(s: *Server, cl: *Client, arena: std.mem.Allocator, q: Request.Sync) !void {
    if (!cl.viewer) return error.NotAttached;
    if (q.interests.len > layout.max_panes) return error.TooManyPanes;
    for (q.interests, 0..) |interest, i| {
        if (interest.cols == 0 or interest.cols > 500 or interest.rows == 0 or interest.rows > 200) return error.InvalidSize;
        for (q.interests[0..i]) |other| if (other.pane == interest.pane) return error.InvalidTarget;
    }
    if (q.ack >= cl.next_control or q.ack < cl.last_control) return error.InvalidAcknowledgement;
    while (cl.controls.items.len > 0 and cl.controls.items[0].seq <= q.ack) {
        const done = cl.controls.orderedRemove(0);
        if (done.kind == .action) {
            a.free(done.name);
            a.free(done.value);
        }
    }
    cl.last_control = q.ack;
    cl.interest_count = 0;
    for (q.interests) |interest| if (s.runtime.pane(interest.pane) != null) {
        cl.interests[cl.interest_count] = interest;
        cl.interest_count += 1;
    };
    cl.view_focus = null;
    for (cl.interests[0..cl.interest_count]) |interest| if (q.focus == interest.pane) {
        cl.view_focus = q.focus;
    };
    cl.watched = q.watched;
    cl.resources = q.resources;
    cl.resource_detail = if (q.resource_detail) |id| if (s.runtime.workspaces.get(id) != null) id else null else null;
    if (q.active) {
        s.next_active += 1;
        cl.active_seq = s.next_active;
    }
    if (s.runtime.workspaces.index(q.workspace) != null) cl.view_workspace = q.workspace;
    if (cl.watched) {
        s.visitWorkspace(cl.view_workspace);
        if (s.preferred_workspace != cl.view_workspace) {
            s.preferred_workspace = cl.view_workspace;
            s.saveWorkspaces();
        }
    }
    try resize(s);
    var frames: std.ArrayList(surface.View) = .empty;
    for (cl.interests[0..cl.interest_count]) |interest| {
        const terminal = s.runtime.pane(interest.pane).?.terminal;
        if (interest.known) |receipt| if (std.meta.eql(receipt, surface.stamp(terminal, interest.offset))) continue;
        try frames.append(arena, try surface.captureView(arena, interest.pane, terminal, interest.offset));
    }
    // Snapshot fields include time-dependent usage and metadata updated by
    // independent workers. Compare the actual payload, not just layout revision.
    const session = try std.json.Stringify.valueAlloc(arena, try session_command.viewerSnapshot(arena, &s.runtime), .{});
    const session_hash = std.hash.Wyhash.hash(0, session);
    // Readings change every few seconds while the session stays put, and
    // each viewer asks for its own detail, so they have their own hash.
    const usage = try s.runtime.resources.current.forViewer(arena, cl.resource_detail);
    const readings = try std.json.Stringify.valueAlloc(arena, usage, .{});
    const resources_hash = std.hash.Wyhash.hash(0, readings);
    cl.queue(.{
        .type = "view",
        .viewer_protocol = viewer_version.version,
        .session = if (q.session_hash == session_hash) @as(?RawJson, null) else RawJson{ .bytes = session },
        .session_hash = session_hash,
        .resources = if (q.resources_hash == resources_hash) @as(?RawJson, null) else RawJson{ .bytes = readings },
        .resources_hash = resources_hash,
        .surfaces = frames.items,
        .bell_seq = s.bell_seq,
        .bell_kind = s.last_bell_kind,
        .controls = cl.controls.items,
        .viewer = cl.viewer_id,
        .detach = s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.items.len == 1,
    });
}

pub fn search(s: *Server, cl: *Client, q: Request.Search) !void {
    const p = s.runtime.pane(q.pane) orelse return error.NoPane;
    const result = try p.terminal.search(q.needle, q.skip);
    cl.queue(.{ .ok = true, .offset = result.offset, .match = result.match });
}

pub fn acknowledge(s: *Server, cl: *Client, q: Request.Acknowledge) !void {
    const p = s.runtime.pane(q.pane) orelse return error.NoPane;
    const bound: ActorId = if (p.attachment.actor) |actor| actor.id else .none;
    if (!std.mem.eql(u8, q.session, p.agent().sessionId())) return error.StaleAcknowledgement;
    if (q.binding) |binding| if (binding != p.attachment.generation) return error.StaleAcknowledgement;
    if (q.conversation) |id| if (id != bound) return error.StaleAcknowledgement;
    if (p.agent().attention != .none or p.agent().observation.unread()) {
        if (p.attachment.actor) |actor| {
            actor.acknowledge(q.through, q.attention_at);
        } else {
            if (q.attention_at == p.agent().changed_at) p.agent().attention = .none;
            p.agent().readThrough(q.through);
        }
        s.runtime.changed();
        s.dirty = true;
    }
    cl.queue(.{ .ok = true });
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
        var chosen: ?protocol.Interest = null;
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

/// `relaunch` and `onboard` come from a process in a pane (`corgi` after an
/// update, `corgi onboard`), so they go to the one viewer showing that pane.
pub fn action(s: *Server, cl: *Client, q: protocol.Payload(.action)) !void {
    const parsed = try Action.parse(q.name, q.value);
    const target = switch (parsed) {
        .relaunch => |executable| target: {
            const view = try viewerShowing(s, q.pane orelse return error.NoViewer);
            if (!std.fs.path.isAbsolute(executable)) return error.InvalidExecutable;
            break :target view;
        },
        .onboard => if (q.pane) |pane| try viewerShowing(s, pane) else try targetViewer(s, q.viewer),
        else => try targetViewer(s, q.viewer),
    };
    const name = try a.dupe(u8, q.name);
    errdefer a.free(name);
    const value = try a.dupe(u8, q.value);
    errdefer a.free(value);
    try send(cl, target, .{ .kind = .action, .name = name, .value = value });
}
pub fn focus(s: *Server, cl: *Client, q: protocol.Payload(.focus)) !void {
    const target = try targetViewer(s, q.viewer);
    if (s.runtime.pane(q.pane) == null) return error.NoPane;
    try send(cl, target, .{ .kind = .focus, .id = @intFromEnum(q.pane) });
}
pub fn switchWorkspace(s: *Server, cl: *Client, q: protocol.Payload(.@"workspace.switch")) !void {
    const target = try targetViewer(s, q.viewer);
    _ = try s.runtime.getWorkspace(q.workspace);
    try send(cl, target, .{ .kind = .workspace, .id = @intFromEnum(q.workspace) });
}

/// The viewer a control names; an unqualified CLI command targets the
/// oldest live viewer.
fn targetViewer(s: *Server, viewer: ?u32) !*Client {
    for (s.clients.items) |*cl| if (cl.viewer and !cl.dead) {
        if (viewer == null or cl.viewer_id == viewer.?) return cl;
    };
    return error.NoViewer;
}
fn viewerShowing(s: *Server, pane: layout.PaneId) !*Client {
    var target: ?*Client = null;
    for (s.clients.items) |*view| if (view.viewer and !view.dead and view.view_focus == pane) {
        if (target != null) return error.AmbiguousViewer;
        target = view;
    };
    return target orelse error.NoViewer;
}
/// Queues `value` for `target`, delivered in its next viewer.sync, and tells
/// the requester which viewer took it.
fn send(cl: *Client, target: *Client, value: protocol.Control) !void {
    if (target.controls.items.len >= 64) return error.ViewerBusy;
    var control = value;
    control.seq = target.next_control;
    try target.controls.append(a, control);
    target.next_control += 1;
    cl.queue(.{ .ok = true, .viewer = target.viewer_id, .queued = true });
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
