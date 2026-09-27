//! One viewer's captured agent gesture. Rows are keyed by identity so changing
//! snapshots cannot silently redirect a pending drop to another agent.
const std = @import("std");
const sidebar = @import("sidebar.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
pub const Drag = struct {
    workspace: WorkspaceId,
    current: WorkspaceId,
    target: @import("agent_order.zig").Target,
    source: usize,
    first: usize,
    end: usize,
    start_x: u16,
    start_y: u16,
    cols: u16,
    rows: u16,
    width: u16,
    ids: [sidebar.max_entries]sidebar.Target = undefined,
    count: usize,
    dragging: bool = false,
    cancelled: bool = false,
    drop: ?sidebar.View.Drop = null,
    preview: ?usize = null,

    pub fn init(view: sidebar.View, source: usize, x: u16, y: u16, workspace: WorkspaceId, current: WorkspaceId) Drag {
        var first = source;
        while (first > 0 and view.entries[first - 1].target != .group) first -= 1;
        var end = source + 1;
        while (end < view.entries.len and view.entries[end].target != .group) end += 1;
        var result: Drag = .{ .workspace = workspace, .current = current, .target = view.entries[source].orderTarget().?, .source = source, .first = first, .end = end, .start_x = x, .start_y = y, .cols = view.cols, .rows = view.rows, .width = view.width, .count = view.entries.len };
        for (view.entries, 0..) |entry, i| result.ids[i] = entry.target;
        return result;
    }
    pub fn valid(self: *Drag, view: sidebar.View, current: WorkspaceId) bool {
        if (self.cols != view.cols or self.rows != view.rows or self.width != view.width or self.current != current or self.count != view.entries.len) self.cancelled = true;
        if (!self.cancelled) for (view.entries, 0..) |entry, i| {
            if (!std.meta.eql(self.ids[i], entry.target) or entry.exit != null) self.cancelled = true;
        };
        if (self.cancelled) {
            self.drop = null;
            self.preview = null;
        }
        return !self.cancelled;
    }
    pub fn update(self: *Drag, view: sidebar.View, current: WorkspaceId, x: u16, y: u16) void {
        self.drop = null;
        self.preview = null;
        if (!self.valid(view, current) or !self.dragging) return;
        const drop = view.agentDrop(x, y) orelse return;
        if (drop.index < self.first or drop.index > self.end) return;
        self.preview = drop.index - @as(usize, if (drop.index > self.source) 1 else 0);
        if (self.preview == self.source) return;
        self.drop = drop;
    }
};

test "agent drop respects grouped boundaries, scrolling, and stale rows" {
    const entry: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .provider = .claude, .state = .idle, .attention = .none };
    var entries = [_]sidebar.Entry{entry} ** 6;
    entries[0].target = .{ .group = @enumFromInt(1) };
    entries[2].target = .{ .pane = @enumFromInt(2) };
    entries[3].target = .{ .group = @enumFromInt(2) };
    entries[4].target = .{ .pane = @enumFromInt(3) };
    entries[5].target = .{ .native = @enumFromInt(1) };
    const ws: WorkspaceId = @enumFromInt(1);
    const view = sidebar.View.init(100, 30, true, 0, entries.len).withEntries(&entries);
    var drag = Drag.init(view, 1, 5, 17, ws, ws);
    drag.dragging = true;
    drag.update(view, ws, 5, 20);
    try std.testing.expectEqual(@as(usize, 3), drag.drop.?.index);
    try std.testing.expectEqual(@as(u16, 20), drag.drop.?.y);
    drag.update(view, ws, 5, 22);
    try std.testing.expect(drag.drop == null);
    drag.update(view, ws, 80, 20);
    try std.testing.expect(drag.drop == null);
    const scrolled = sidebar.View.init(100, 18, true, 2, entries.len).withEntries(&entries);
    try std.testing.expectEqual(@as(usize, 2), scrolled.agentDrop(5, scrolled.middle() + 2).?.index);
    entries[2].exit = .{ .frame_ms = 0, .progress = 0.5 };
    try std.testing.expect(!drag.valid(view, ws));
}
