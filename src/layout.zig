const std = @import("std");

pub const max_panes = 64;
pub const max_borders = max_panes + 3;
pub const max_tabs = 24;
const max_nodes = max_panes * 2;
pub const PaneId = enum(u32) {
    _,

    /// Never assigned. Saved and wire formats use 0 for "no pane".
    pub const none: PaneId = @enumFromInt(0);
    pub const first: PaneId = @enumFromInt(1);

    pub fn next(id: PaneId) PaneId {
        return @enumFromInt(@intFromEnum(id) + 1);
    }
};
pub const TabId = enum(u32) {
    _,

    /// Never assigned. Saved and wire formats use 0 for "no tab".
    pub const none: TabId = @enumFromInt(0);
};
pub const Axis = enum { horizontal, vertical };
pub const Direction = enum { left, down, up, right };
pub const Rect = struct {
    x: u16 = 0,
    y: u16 = 0,
    w: u16 = 0,
    h: u16 = 0,
    pub fn contains(r: Rect, x: u16, y: u16) bool {
        return x >= r.x and y >= r.y and x < r.x + r.w and y < r.y + r.h;
    }
};
pub const Split = struct { axis: Axis, first: u8, second: u8, ratio: u16 = 500 };
pub const Node = union(enum) { pane: PaneId, split: Split };
pub const Tab = struct {
    id: TabId,
    root: u8,
    name: [80]u8 = .{0} ** 80,
    name_len: usize = 0, // Zero means unnamed; its number is derived from its current position.
    const Data = struct { id: TabId, root: u8, title: []const u8 };
    pub fn jsonStringify(t: Tab, writer: anytype) !void {
        try writer.write(Data{ .id = t.id, .root = t.root, .title = t.title() });
    }
    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !Tab {
        return fromData(try std.json.innerParse(Data, allocator, source, options));
    }
    pub fn jsonParseFromValue(allocator: std.mem.Allocator, value: std.json.Value, options: std.json.ParseOptions) !Tab {
        return fromData(try std.json.innerParseFromValue(Data, allocator, value, options));
    }
    fn fromData(data: Data) Tab {
        var tab: Tab = .{ .id = data.id, .root = data.root };
        tab.rename(data.title);
        return tab;
    }
    pub fn title(t: *const Tab) []const u8 {
        return t.name[0..t.name_len];
    }
    pub fn rename(t: *Tab, name: []const u8) void {
        const trimmed = std.mem.trim(u8, name, " ");
        t.name_len = @min(trimmed.len, t.name.len);
        for (trimmed[0..t.name_len], 0..) |ch, i| t.name[i] = if (ch >= 32 and ch < 127) ch else '_';
    }
};
pub const Placement = struct { id: PaneId, rect: Rect };
pub const Model = struct {
    nodes: [max_nodes]?Node = .{null} ** max_nodes,
    tabs: [max_tabs]Tab = undefined,
    count: usize = 0,
    next_id: PaneId = .first,
    revision: u64 = 0,

    // The same flat arrangement is used by the runtime, snapshots and viewers.
    // Only occupied tab slots and the used node prefix cross the wire.
    const Data = struct { nodes: []const ?Node, tabs: []const Tab, revision: u64 };
    pub fn jsonStringify(m: Model, writer: anytype) !void {
        var end = m.nodes.len;
        while (end > 0 and m.nodes[end - 1] == null) : (end -= 1) {}
        try writer.write(Data{ .nodes = m.nodes[0..end], .tabs = m.tabs[0..m.count], .revision = m.revision });
    }
    pub fn jsonParse(allocator: std.mem.Allocator, source: anytype, options: std.json.ParseOptions) !Model {
        return fromData(try std.json.innerParse(Data, allocator, source, options));
    }
    pub fn jsonParseFromValue(allocator: std.mem.Allocator, value: std.json.Value, options: std.json.ParseOptions) !Model {
        return fromData(try std.json.innerParseFromValue(Data, allocator, value, options));
    }
    fn fromData(data: Data) !Model {
        if (data.nodes.len > max_nodes or data.tabs.len > max_tabs) return error.UnexpectedToken;
        var model: Model = .{ .count = data.tabs.len, .revision = data.revision };
        @memcpy(model.nodes[0..data.nodes.len], data.nodes);
        @memcpy(model.tabs[0..data.tabs.len], data.tabs);
        var visited: [max_nodes]bool = @splat(false);
        for (data.tabs, 0..) |tab, i| {
            if (tab.id == TabId.none or tab.name_len > tab.name.len) return error.UnexpectedToken;
            for (data.tabs[0..i]) |other| if (other.id == tab.id) return error.UnexpectedToken;
            try model.validateTree(tab.root, &visited);
        }
        for (model.nodes, visited, 0..) |slot, seen, i| {
            if (slot) |node| {
                if (!seen) return error.UnexpectedToken;
                if (node == .pane) for (model.nodes[0..i]) |other| {
                    if (other != null and other.? == .pane and other.?.pane == node.pane) return error.UnexpectedToken;
                };
            }
        }
        return model;
    }
    fn validateTree(m: *const Model, index: u8, visited: *[max_nodes]bool) error{UnexpectedToken}!void {
        if (index >= max_nodes or visited[index]) return error.UnexpectedToken;
        const node = m.nodes[index] orelse return error.UnexpectedToken;
        visited[index] = true;
        switch (node) {
            .pane => |id| if (id == PaneId.none) return error.UnexpectedToken,
            .split => |branch| {
                if (branch.ratio < 100 or branch.ratio > 900) return error.UnexpectedToken;
                try m.validateTree(branch.first, visited);
                try m.validateTree(branch.second, visited);
            },
        }
    }

    pub fn alloc(m: *Model, node: Node) !u8 {
        for (&m.nodes, 0..) |*slot, i| if (slot.* == null) {
            slot.* = node;
            return @intCast(i);
        };
        return error.TooManyPanes;
    }

    pub fn newTab(m: *Model, name: []const u8) !PaneId {
        if (m.count == max_tabs) return error.TooManyTabs;
        const id = m.next_id;
        const root = try m.alloc(.{ .pane = id });
        // Tab ids share the pane-id counter: the new tab takes the slot right after its root pane.
        m.next_id = @enumFromInt(@intFromEnum(id) + 2);
        m.tabs[m.count] = .{ .id = @enumFromInt(@intFromEnum(id) + 1), .root = root };
        m.tabs[m.count].rename(name);
        m.count += 1;
        return id;
    }
    pub fn findNode(m: *const Model, id: PaneId) ?u8 {
        for (m.nodes, 0..) |maybe, i| if (maybe) |n| {
            if (n == .pane and n.pane == id) return @intCast(i);
        };
        return null;
    }
    pub fn split(m: *Model, target: PaneId, axis: Axis) !PaneId {
        const old = m.findNode(target) orelse return error.NoPane;
        const first = try m.alloc(m.nodes[old].?);
        errdefer m.nodes[first] = null;
        const id = m.next_id;
        const second = try m.alloc(.{ .pane = id });
        m.next_id = id.next();
        m.nodes[old] = .{ .split = .{ .axis = axis, .first = first, .second = second } };
        return id;
    }
    pub fn firstPane(m: *const Model, index: u8) PaneId {
        return switch (m.nodes[index].?) {
            .pane => |id| id,
            .split => |s| m.firstPane(s.first),
        };
    }
    pub fn contains(m: *const Model, index: u8, id: PaneId) bool {
        return switch (m.nodes[index].?) {
            .pane => |p| p == id,
            .split => |s| m.contains(s.first, id) or m.contains(s.second, id),
        };
    }

    pub fn tabForPane(m: *const Model, id: PaneId) ?usize {
        for (m.tabs[0..m.count], 0..) |t, i| if (m.contains(t.root, id)) return i;
        return null;
    }
    pub fn tabIndex(m: *const Model, id: TabId) ?usize {
        for (m.tabs[0..m.count], 0..) |t, i| if (t.id == id) return i;
        return null;
    }
    pub fn close(m: *Model, id: PaneId) !void {
        const node = m.findNode(id) orelse return error.NoPane;
        for (m.tabs[0..m.count], 0..) |t, i| if (t.root == node) {
            m.nodes[node] = null;
            std.mem.copyForwards(Tab, m.tabs[i .. m.count - 1], m.tabs[i + 1 .. m.count]);
            m.count -= 1;
            return;
        };
        for (&m.nodes) |*maybe| if (maybe.*) |n| {
            if (n != .split) continue;
            const s = n.split;
            const sibling = if (s.first == node) s.second else if (s.second == node) s.first else continue;
            maybe.* = m.nodes[sibling];
            m.nodes[sibling] = null;
            m.nodes[node] = null;
            return;
        };
        return error.NoPane;
    }
    pub fn swap(m: *Model, target: PaneId, other: PaneId) !void {
        const a = m.findNode(target) orelse return error.NoPane;
        const b = m.findNode(other) orelse return error.NoPane;
        std.mem.swap(?Node, &m.nodes[a], &m.nodes[b]);
        // Focus follows the process, not its former rectangle.
    }
    pub fn resize(m: *Model, id: PaneId, direction: Direction) void {
        const axis: Axis = switch (direction) {
            .left, .right => .horizontal,
            .up, .down => .vertical,
        };
        const delta: i32 = switch (direction) {
            .left, .up => -40,
            .right, .down => 40,
        };
        const index = m.tabForPane(id) orelse return;
        _ = m.resizeNode(m.tabs[index].root, id, axis, delta);
    }
    fn resizeNode(m: *Model, index: u8, id: PaneId, axis: Axis, delta: i32) bool {
        const n = &m.nodes[index].?;
        if (n.* != .split) return false;
        const s = &n.split;
        const child = if (m.contains(s.first, id)) s.first else s.second;
        if (m.resizeNode(child, id, axis, delta)) return true;
        if (s.axis != axis) return false;
        s.ratio = @intCast(std.math.clamp(@as(i32, s.ratio) + delta, 100, 900));
        return true;
    }

    pub fn moveTab(m: *Model, id: TabId, insert: usize) void {
        if (insert > m.count or m.count == 0) return;
        for (m.tabs[0..m.count], 0..) |tab_value, source| {
            if (tab_value.id != id) continue;
            const dest = insert - @intFromBool(insert > source);
            var i = source;
            while (i < dest) : (i += 1) m.tabs[i] = m.tabs[i + 1];
            while (i > dest) : (i -= 1) m.tabs[i] = m.tabs[i - 1];
            m.tabs[dest] = tab_value;
            return;
        }
    }
    /// Copy a subtree between detached model snapshots. Callers commit only on success.
    pub fn copyTree(m: *Model, source: *const Model, root: u8) anyerror!u8 {
        return m.alloc(switch (source.nodes[root].?) {
            .pane => |id| .{ .pane = id },
            .split => |s| .{ .split = .{ .axis = s.axis, .ratio = s.ratio, .first = try m.copyTree(source, s.first), .second = try m.copyTree(source, s.second) } },
        });
    }
    pub fn removeTab(m: *Model, index: usize) void {
        m.freeTree(m.tabs[index].root);
        std.mem.copyForwards(Tab, m.tabs[index .. m.count - 1], m.tabs[index + 1 .. m.count]);
        m.count -= 1;
    }
    fn freeTree(m: *Model, root: u8) void {
        if (m.nodes[root].? == .split) {
            const s = m.nodes[root].?.split;
            m.freeTree(s.first);
            m.freeTree(s.second);
        }
        m.nodes[root] = null;
    }
    pub fn insertTree(m: *Model, root: u8, target: PaneId, direction: Direction) !void {
        const node = m.findNode(target) orelse return error.NoPane;
        const old = try m.alloc(m.nodes[node].?);
        const before = direction == .left or direction == .up;
        m.nodes[node] = .{ .split = .{ .axis = if (direction == .left or direction == .right) .horizontal else .vertical, .first = if (before) root else old, .second = if (before) old else root } };
    }
    pub fn setShare(m: *Model, id: PaneId, axis: Axis, ratio: u16) !void {
        const tab_index = m.tabForPane(id) orelse return error.NoPane;
        if (!m.shareNode(m.tabs[tab_index].root, id, axis, ratio)) return error.NoSplit;
    }
    fn shareNode(m: *Model, root: u8, id: PaneId, axis: Axis, ratio: u16) bool {
        const n = &m.nodes[root].?;
        if (n.* != .split) return false;
        const first = m.contains(n.split.first, id);
        if (m.shareNode(if (first) n.split.first else n.split.second, id, axis, ratio)) return true;
        if (n.split.axis != axis) return false;
        n.split.ratio = if (first) ratio else 1000 - ratio;
        return true;
    }
};

/// Viewer-local tab, pane and zoom selection, reconciled once against shared IDs.
pub const Selection = struct {
    pub const TabState = struct { id: TabId, focus: PaneId, zoom: bool = false };
    tabs: [max_tabs]TabState = @splat(.{ .id = .none, .focus = .none }),
    count: usize = 0,
    active: usize = 0,
    pub fn reconcile(s: *Selection, m: *const Model) void {
        const old = s.*;
        var selected = if (old.count > 0) old.tabs[old.active].id else TabId.none;
        // A closed selected tab falls back to its nearest surviving neighbour, preferring the left.
        if (selected != TabId.none and m.tabIndex(selected) == null) {
            selected = TabId.none;
            var i = old.active;
            while (i > 0 and selected == TabId.none) {
                i -= 1;
                if (m.tabIndex(old.tabs[i].id) != null) selected = old.tabs[i].id;
            }
            i = old.active + 1;
            while (i < old.count and selected == TabId.none) : (i += 1) {
                if (m.tabIndex(old.tabs[i].id) != null) selected = old.tabs[i].id;
            }
        }
        s.count = m.count;
        s.active = 0;
        for (m.tabs[0..m.count], 0..) |item, i| {
            s.tabs[i] = .{ .id = item.id, .focus = m.firstPane(item.root) };
            for (old.tabs[0..old.count]) |saved| if (saved.id == item.id) {
                if (m.contains(item.root, saved.focus)) s.tabs[i] = saved;
                break;
            };
            if (item.id == selected) s.active = i;
        }
    }
    pub fn focus(s: *Selection, m: *const Model, id: PaneId) !void {
        const i = m.tabForPane(id) orelse return error.NoPane;
        s.active = i;
        s.tabs[i].focus = id;
    }
    pub fn tab(s: *Selection) *TabState {
        return &s.tabs[s.active];
    }
};

/// Read-only geometry of one arrangement as seen by a particular viewer.
pub const View = struct {
    model: *const Model,
    selection: *const Selection,
    pub fn placements(m: View, area: Rect, out: *[max_panes]Placement) []Placement {
        if (m.model.count == 0) return out[0..0];
        const t = m.model.tabs[m.selection.active];
        const selected = m.selection.tabs[m.selection.active];
        if (selected.zoom) {
            out[0] = .{ .id = selected.focus, .rect = area };
            return out[0..1];
        }
        var len: usize = 0;
        m.walk(t.root, m.contentArea(area), out, &len);
        return out[0..len];
    }
    fn hasFrame(m: View, area: Rect) bool {
        return m.model.count > 0 and !m.selection.tabs[m.selection.active].zoom and area.w >= 3 and area.h >= 3 and m.model.nodes[m.model.tabs[m.selection.active].root].? == .split;
    }
    fn contentArea(m: View, area: Rect) Rect {
        if (!m.hasFrame(area)) return area;
        return .{ .x = area.x + 1, .y = area.y + 1, .w = area.w - 2, .h = area.h - 2 };
    }
    fn walk(m: View, index: u8, r: Rect, out: *[max_panes]Placement, len: *usize) void {
        switch (m.model.nodes[index].?) {
            .pane => |id| {
                if (len.* < max_panes) {
                    out[len.*] = .{ .id = id, .rect = r };
                    len.* += 1;
                }
            },
            .split => |s| {
                const parts = splitRects(s, r);
                m.walk(s.first, parts[0], out, len);
                m.walk(s.second, parts[2], out, len);
            },
        }
    }
    pub fn neighbor(m: View, direction: Direction, area: Rect) ?PaneId {
        var items: [max_panes]Placement = undefined;
        var selection = m.selection.*;
        selection.tabs[selection.active].zoom = false;
        const placements_ = (View{ .model = m.model, .selection = &selection }).placements(area, &items);
        var current: Rect = .{};
        for (placements_) |p| if (p.id == m.selection.tabs[m.selection.active].focus) {
            current = p.rect;
        };
        var best: ?PaneId = null;
        var score: u64 = std.math.maxInt(u64);
        const cx = @as(i32, current.x) * 2 + current.w;
        const cy = @as(i32, current.y) * 2 + current.h;
        for (placements_) |p| {
            if (p.id == m.selection.tabs[m.selection.active].focus) continue;
            const dx = @as(i32, p.rect.x) * 2 + p.rect.w - cx;
            const dy = @as(i32, p.rect.y) * 2 + p.rect.h - cy;
            const valid = switch (direction) {
                .left => dx < 0,
                .right => dx > 0,
                .up => dy < 0,
                .down => dy > 0,
            };
            if (!valid) continue;
            const primary = switch (direction) {
                .left, .right => @abs(dx),
                .up, .down => @abs(dy),
            };
            const secondary = switch (direction) {
                .left, .right => @abs(dy),
                .up, .down => @abs(dx),
            };
            const value = @as(u64, primary) + @as(u64, secondary) * 4;
            if (value < score) {
                score = value;
                best = p.id;
            }
        }
        return best;
    }
    pub const Divider = struct { node: u8, rect: Rect };
    pub fn dividerAt(m: View, area: Rect, x: u16, y: u16) ?Divider {
        if (m.model.count == 0 or m.selection.tabs[m.selection.active].zoom) return null;
        return m.dividerNode(m.model.tabs[m.selection.active].root, m.contentArea(area), x, y);
    }
    fn dividerNode(m: View, index: u8, r: Rect, x: u16, y: u16) ?Divider {
        if (!r.contains(x, y)) return null;
        const n = m.model.nodes[index].?;
        if (n != .split) return null;
        const s = n.split;
        const parts = splitRects(s, r);
        if (parts[1].contains(x, y)) return .{ .node = index, .rect = r };
        if (parts[0].contains(x, y)) return m.dividerNode(s.first, parts[0], x, y);
        return m.dividerNode(s.second, parts[2], x, y);
    }
    pub const Border = struct { rect: Rect, axis: Axis, draggable: bool = true };
    pub fn borders(m: View, area: Rect, out: *[max_borders]Border) []Border {
        if (m.model.count == 0 or m.selection.tabs[m.selection.active].zoom) return out[0..0];
        var len: usize = 0;
        if (m.hasFrame(area)) {
            out[0] = .{ .rect = .{ .x = area.x, .y = area.y, .w = area.w, .h = 1 }, .axis = .vertical, .draggable = false };
            out[1] = .{ .rect = .{ .x = area.x, .y = area.y + area.h - 1, .w = area.w, .h = 1 }, .axis = .vertical, .draggable = false };
            out[2] = .{ .rect = .{ .x = area.x, .y = area.y + 1, .w = 1, .h = area.h - 2 }, .axis = .horizontal, .draggable = false };
            out[3] = .{ .rect = .{ .x = area.x + area.w - 1, .y = area.y + 1, .w = 1, .h = area.h - 2 }, .axis = .horizontal, .draggable = false };
            len = 4;
        }
        m.borderNode(m.model.tabs[m.selection.active].root, m.contentArea(area), out, &len);
        return out[0..len];
    }
    fn borderNode(m: View, index: u8, r: Rect, out: *[max_borders]Border, len: *usize) void {
        if (r.w == 0 or r.h == 0) return;
        const n = m.model.nodes[index].?;
        if (n != .split) return;
        const parts = splitRects(n.split, r);
        out[len.*] = .{ .rect = parts[1], .axis = n.split.axis };
        len.* += 1;
        m.borderNode(n.split.first, parts[0], out, len);
        m.borderNode(n.split.second, parts[2], out, len);
    }

    pub fn dividerRatio(divider: Divider, axis: Axis, x: u16, y: u16) u16 {
        const total = if (axis == .horizontal) divider.rect.w else divider.rect.h;
        const pos = if (axis == .horizontal) x -| divider.rect.x else y -| divider.rect.y;
        return @intCast(std.math.clamp((@as(u32, pos) * 1000 + (total -| 2)) / @max(1, total -| 1), 100, 900));
    }
};

// Pane geometry, visible lines and hit testing share the same reserved cell.
fn splitRects(s: Split, r: Rect) [3]Rect {
    const total = if (s.axis == .horizontal) r.w else r.h;
    const available = total -| 1;
    const first: u16 = @intCast(@as(u32, available) * s.ratio / 1000);
    var parts = [3]Rect{ r, r, r };
    if (s.axis == .horizontal) {
        parts[0].w = first;
        parts[1].x += first;
        parts[1].w = @min(total, 1);
        parts[2].x += @min(total, first + 1);
        parts[2].w = available - first;
    } else {
        parts[0].h = first;
        parts[1].y += first;
        parts[1].h = @min(total, 1);
        parts[2].y += @min(total, first + 1);
        parts[2].h = available - first;
    }
    return parts;
}

test "nested split close preserves stable identities and collapses tree" {
    var m: Model = .{};
    var selection: Selection = .{};
    const view: View = .{ .model = &m, .selection = &selection };
    const a = try m.newTab("one");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const b = try m.split(selection.tab().focus, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, b);
    const c = try m.split(selection.tab().focus, .vertical);
    selection.reconcile(&m);
    try selection.focus(&m, c);
    try m.close(b);
    selection.reconcile(&m);
    try std.testing.expectEqual(c, selection.tab().focus);
    var out: [max_panes]Placement = undefined;
    const p = view.placements(.{ .w = 81, .h = 24 }, &out);
    try std.testing.expectEqual(@as(usize, 2), p.len);
    try std.testing.expectEqual(a, p[0].id);
    try std.testing.expectEqual(c, p[1].id);
    try m.close(a);
    selection.reconcile(&m);
    try std.testing.expectEqual(c, m.nodes[m.tabs[selection.active].root].?.pane);
    try m.close(c);
    selection.reconcile(&m);
    try std.testing.expectEqual(@as(usize, 0), m.count);
}
test "closing the selected tab selects its nearest neighbour, preferring the left" {
    var m: Model = .{};
    var selection: Selection = .{};
    _ = try m.newTab("one");
    _ = try m.newTab("two");
    const c = try m.newTab("three");
    _ = try m.newTab("four");
    selection.reconcile(&m);
    selection.active = 2;
    try m.close(c);
    selection.reconcile(&m);
    try std.testing.expectEqual(@as(usize, 1), selection.active);
    selection.active = 0;
    m.removeTab(0);
    selection.reconcile(&m);
    try std.testing.expectEqual(@as(usize, 0), selection.active);
    try std.testing.expectEqual(m.tabs[0].id, selection.tabs[0].id);
    selection.active = 1;
    m.removeTab(1);
    selection.reconcile(&m);
    try std.testing.expectEqual(@as(usize, 0), selection.active);
}
test "directional focus, zoom and resize keep geometry inside bounds" {
    var m: Model = .{};
    var selection: Selection = .{};
    const view: View = .{ .model = &m, .selection = &selection };
    const a = try m.newTab("one");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const b = try m.split(selection.tab().focus, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, b);
    try std.testing.expectEqual(a, view.neighbor(.left, .{ .w = 81, .h = 24 }).?);
    m.resize(selection.tab().focus, .left);
    var out: [max_panes]Placement = undefined;
    for (view.placements(.{ .w = 1, .h = 1 }, &out)) |p| {
        try std.testing.expect(p.rect.x + p.rect.w <= 1);
        try std.testing.expect(p.rect.y + p.rect.h <= 1);
    }
    selection.tab().zoom = true;
    try std.testing.expectEqual(b, view.placements(.{ .w = 81, .h = 24 }, &out)[0].id);
}
test "tab insertion preserves order, names, splits and logical focus" {
    var m: Model = .{};
    var selection: Selection = .{};
    _ = try m.newTab("");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const first = m.tabs[selection.active];
    _ = try m.newTab("named");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const added = try m.split(selection.tab().focus, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, added);
    const second = m.tabs[selection.active];
    _ = try m.newTab("");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const third = m.tabs[selection.active];
    m.moveTab(first.id, 3);
    selection.reconcile(&m);
    try std.testing.expectEqualDeep(second, m.tabs[0]);
    try std.testing.expectEqualDeep(third, m.tabs[1]);
    try std.testing.expectEqualDeep(first, m.tabs[2]);
    try std.testing.expectEqual(third.id, m.tabs[selection.active].id);
    m.moveTab(first.id, 0);
    selection.reconcile(&m);
    try std.testing.expectEqualDeep(first, m.tabs[0]);
    try std.testing.expectEqualDeep(second, m.tabs[1]);
    m.moveTab(second.id, 2);
    selection.reconcile(&m); // Its own trailing gap is a no-op.
    try std.testing.expectEqualDeep(second, m.tabs[1]);
    try std.testing.expectEqual(third.id, m.tabs[selection.active].id);
}

test "divider cells match gaps at every size and drag lands on requested cell" {
    var m: Model = .{};
    var selection: Selection = .{};
    const view: View = .{ .model = &m, .selection = &selection };
    _ = try m.newTab("");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const split = try m.split(selection.tab().focus, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, split);
    _ = try m.split(selection.tab().focus, .vertical);
    selection.reconcile(&m);
    for (0..20) |width| {
        for (0..14) |height| {
            const area: Rect = .{ .x = 3, .y = 2, .w = @intCast(width), .h = @intCast(height) };
            var panes: [max_panes]Placement = undefined;
            var lines: [max_borders]View.Border = undefined;
            const placements = view.placements(area, &panes);
            const borders = view.borders(area, &lines);
            for (area.y..area.y + area.h) |y| for (area.x..area.x + area.w) |x| {
                var coverage: usize = 0;
                for (placements) |p| if (p.rect.contains(@intCast(x), @intCast(y))) {
                    coverage += 1;
                };
                for (borders) |b| if (b.rect.contains(@intCast(x), @intCast(y))) {
                    coverage += 1;
                    try std.testing.expectEqual(b.draggable, view.dividerAt(area, @intCast(x), @intCast(y)) != null);
                };
                try std.testing.expectEqual(@as(usize, 1), coverage);
            };
        }
    }
    const area: Rect = .{ .x = 28, .y = 1, .w = 72, .h = 28 };
    const divider = view.dividerAt(area, 63, 2).?;
    m.nodes[divider.node].?.split.ratio = View.dividerRatio(divider, .horizontal, 75, 2);
    try std.testing.expect(view.dividerAt(area, 75, 2) != null);
    selection.tab().zoom = true;
    var lines: [max_borders]View.Border = undefined;
    try std.testing.expectEqual(@as(usize, 0), view.borders(area, &lines).len);
    try std.testing.expect(view.dividerAt(area, 75, 2) == null);
}

test "only split layouts reserve an outer frame and closing restores the area" {
    var m: Model = .{};
    var selection: Selection = .{};
    const view: View = .{ .model = &m, .selection = &selection };
    _ = try m.newTab("");
    selection.reconcile(&m);
    selection.active = m.count - 1;
    const area: Rect = .{ .x = 28, .y = 1, .w = 72, .h = 28 };
    var panes: [max_panes]Placement = undefined;
    try std.testing.expectEqualDeep(area, view.placements(area, &panes)[0].rect);
    const second = try m.split(selection.tab().focus, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, second);
    for (view.placements(area, &panes)) |p| {
        try std.testing.expect(p.rect.x > area.x and p.rect.y > area.y);
        try std.testing.expect(p.rect.x + p.rect.w < area.x + area.w);
        try std.testing.expect(p.rect.y + p.rect.h < area.y + area.h);
    }
    try m.close(second);
    selection.reconcile(&m);
    try std.testing.expectEqualDeep(area, view.placements(area, &panes)[0].rect);
}

test "shared model decoder rejects cycles orphan nodes and duplicate panes" {
    const invalid = [_][]const u8{
        \\{"nodes":[{"split":{"axis":"horizontal","ratio":500,"first":0,"second":1}},{"pane":1}],"tabs":[{"id":2,"root":0,"title":""}],"revision":1}
        ,
        \\{"nodes":[{"pane":1},{"pane":3}],"tabs":[{"id":2,"root":0,"title":""}],"revision":1}
        ,
        \\{"nodes":[{"pane":1},{"pane":1}],"tabs":[{"id":2,"root":0,"title":""},{"id":3,"root":1,"title":""}],"revision":1}
        ,
    };
    for (invalid) |bytes| {
        try std.testing.expectError(error.UnexpectedToken, std.json.parseFromSlice(Model, std.testing.allocator, bytes, .{}));
    }
}
