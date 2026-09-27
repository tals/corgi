//! One viewer's captured workspace gesture, mirroring agent_drag.zig. Rows are
//! keyed by identity so changing snapshots cannot redirect a pending drop.
const std = @import("std");
const sidebar = @import("sidebar.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
pub const Drag = struct {
    source: usize,
    start_x: u16,
    start_y: u16,
    cols: u16,
    rows: u16,
    width: u16,
    ids: [workspace.max_workspaces]WorkspaceId = undefined,
    count: usize,
    dragging: bool = false,
    cancelled: bool = false,
    drop: ?sidebar.View.Drop = null,
    preview: ?usize = null,

    pub fn init(view: sidebar.View, ids: []const WorkspaceId, source: usize, x: u16, y: u16) Drag {
        var result: Drag = .{ .source = source, .start_x = x, .start_y = y, .cols = view.cols, .rows = view.rows, .width = view.width, .count = ids.len };
        @memcpy(result.ids[0..ids.len], ids);
        return result;
    }
    pub fn valid(self: *Drag, view: sidebar.View, ids: []const WorkspaceId) bool {
        if (self.cols != view.cols or self.rows != view.rows or self.width != view.width or !std.mem.eql(WorkspaceId, self.ids[0..self.count], ids)) self.cancelled = true;
        if (self.cancelled) {
            self.drop = null;
            self.preview = null;
        }
        return !self.cancelled;
    }
    pub fn update(self: *Drag, view: sidebar.View, ids: []const WorkspaceId, x: u16, y: u16) void {
        self.drop = null;
        self.preview = null;
        if (!self.valid(view, ids) or !self.dragging) return;
        const drop = view.workspaceDrop(x, y) orelse return;
        self.preview = drop.index - @as(usize, if (drop.index > self.source) 1 else 0);
        if (self.preview == self.source) return;
        self.drop = drop;
    }
    /// `workspace.move` names the dragged workspace itself to mean "after the last one".
    pub fn before(self: Drag) ?WorkspaceId {
        const drop = self.drop orelse return null;
        return if (drop.index == self.count) self.ids[self.source] else self.ids[drop.index];
    }
};

test "workspace drop follows row midpoints, scrolling, and stale lists" {
    const ids = [_]WorkspaceId{ @enumFromInt(1), @enumFromInt(2), @enumFromInt(3), @enumFromInt(4) };
    // Rows 2-4, 5-7, 8-10 hold three visible workspaces.
    const view = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(ids.len, 0);
    var drag = Drag.init(view, &ids, 0, 5, 2);
    drag.update(view, &ids, 5, 9);
    try std.testing.expect(drag.drop == null);
    drag.dragging = true;
    drag.update(view, &ids, 5, 9);
    try std.testing.expectEqual(@as(usize, 2), drag.drop.?.index);
    try std.testing.expectEqual(@as(usize, 1), drag.preview.?);
    try std.testing.expectEqual(ids[2], drag.before().?);
    drag.update(view, &ids, 5, 10);
    try std.testing.expectEqual(@as(usize, 3), drag.drop.?.index);
    drag.update(view, &ids, 5, 3);
    try std.testing.expect(drag.drop == null);
    drag.update(view, &ids, 80, 9);
    try std.testing.expect(drag.drop == null);
    const scrolled = view.withWorkspaces(ids.len, 1);
    drag.update(scrolled, &ids, 5, 10);
    try std.testing.expectEqual(@as(usize, 4), drag.drop.?.index);
    try std.testing.expectEqual(ids[0], drag.before().?);
    try std.testing.expect(!drag.valid(view, ids[0..3]));
}
