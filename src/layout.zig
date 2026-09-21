const std = @import("std");

pub const max_panes = 64;
pub const max_borders = max_panes + 3;
pub const max_tabs = 24;
const max_nodes = max_panes * 2;
pub const Id = u32;
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
pub const Node = union(enum) { pane: Id, split: Split };
pub const Tab = struct {
    id: Id,
    root: u8,
    focus: Id,
    zoom: bool = false,
    name: [80]u8 = .{0} ** 80,
    name_len: usize = 0, // Zero means unnamed; its number is derived from its current position.
    pub fn title(t: *const Tab) []const u8 {
        return t.name[0..t.name_len];
    }
    pub fn rename(t: *Tab, name: []const u8) void {
        const trimmed = std.mem.trim(u8, name, " ");
        t.name_len = @min(trimmed.len, t.name.len);
        for (trimmed[0..t.name_len], 0..) |ch, i| t.name[i] = if (ch >= 32 and ch < 127) ch else '_';
    }
};
pub const Placement = struct { id: Id, rect: Rect };
pub const Model = struct {
    nodes: [max_nodes]?Node = .{null} ** max_nodes,
    tabs: [max_tabs]Tab = undefined,
    count: usize = 0,
    active: usize = 0,
    next_id: Id = 1,

    pub fn alloc(m: *Model, node: Node) !u8 {
        for (&m.nodes, 0..) |*slot, i| if (slot.* == null) {
            slot.* = node;
            return @intCast(i);
        };
        return error.TooManyPanes;
    }
    pub fn tab(m: *Model) *Tab {
        return &m.tabs[m.active];
    }
    pub fn newTab(m: *Model, name: []const u8) !Id {
        if (m.count == max_tabs) return error.TooManyTabs;
        const id = m.next_id;
        const root = try m.alloc(.{ .pane = id });
        m.next_id += 2;
        m.tabs[m.count] = .{ .id = id + 1, .root = root, .focus = id };
        m.tabs[m.count].rename(name);
        m.active = m.count;
        m.count += 1;
        return id;
    }
    pub fn findNode(m: *const Model, id: Id) ?u8 {
        for (m.nodes, 0..) |maybe, i| if (maybe) |n| {
            if (n == .pane and n.pane == id) return @intCast(i);
        };
        return null;
    }
    pub fn split(m: *Model, axis: Axis) !Id {
        const old = m.findNode(m.tab().focus) orelse return error.NoPane;
        const first = try m.alloc(m.nodes[old].?);
        errdefer m.nodes[first] = null;
        const id = m.next_id;
        const second = try m.alloc(.{ .pane = id });
        m.next_id += 1;
        m.nodes[old] = .{ .split = .{ .axis = axis, .first = first, .second = second } };
        m.tab().focus = id;
        m.tab().zoom = false;
        return id;
    }
    pub fn firstPane(m: *const Model, index: u8) Id {
        return switch (m.nodes[index].?) {
            .pane => |id| id,
            .split => |s| m.firstPane(s.first),
        };
    }
    pub fn contains(m: *const Model, index: u8, id: Id) bool {
        return switch (m.nodes[index].?) {
            .pane => |p| p == id,
            .split => |s| m.contains(s.first, id) or m.contains(s.second, id),
        };
    }
    pub fn focus(m: *Model, id: Id) !void {
        for (m.tabs[0..m.count], 0..) |t, i| if (m.contains(t.root, id)) {
            m.active = i;
            m.tab().focus = id;
            return;
        };
        return error.NoPane;
    }
    pub fn tabForPane(m: *const Model, id: Id) ?usize {
        for (m.tabs[0..m.count], 0..) |t, i| if (m.contains(t.root, id)) return i;
        return null;
    }
    pub fn close(m: *Model, id: Id) !void {
        const node = m.findNode(id) orelse return error.NoPane;
        for (m.tabs[0..m.count], 0..) |t, i| if (t.root == node) {
            m.nodes[node] = null;
            std.mem.copyForwards(Tab, m.tabs[i .. m.count - 1], m.tabs[i + 1 .. m.count]);
            m.count -= 1;
            if (m.active > i) m.active -= 1 else if (m.active >= m.count) m.active = m.count -| 1;
            return;
        };
        for (&m.nodes) |*maybe| if (maybe.*) |n| {
            if (n != .split) continue;
            const s = n.split;
            const sibling = if (s.first == node) s.second else if (s.second == node) s.first else continue;
            maybe.* = m.nodes[sibling];
            m.nodes[sibling] = null;
            m.nodes[node] = null;
            for (m.tabs[0..m.count]) |*t| if (t.focus == id) {
                t.focus = m.firstPane(t.root);
                t.zoom = false;
            };
            return;
        };
        return error.NoPane;
    }
    pub fn placements(m: *const Model, area: Rect, out: *[max_panes]Placement) []Placement {
        if (m.count == 0) return out[0..0];
        const t = m.tabs[m.active];
        if (t.zoom) {
            out[0] = .{ .id = t.focus, .rect = area };
            return out[0..1];
        }
        var len: usize = 0;
        m.walk(t.root, m.contentArea(area), out, &len);
        return out[0..len];
    }
    fn hasFrame(m: *const Model, area: Rect) bool {
        return m.count > 0 and !m.tabs[m.active].zoom and area.w >= 3 and area.h >= 3 and m.nodes[m.tabs[m.active].root].? == .split;
    }
    fn contentArea(m: *const Model, area: Rect) Rect {
        if (!m.hasFrame(area)) return area;
        return .{ .x = area.x + 1, .y = area.y + 1, .w = area.w - 2, .h = area.h - 2 };
    }
    fn walk(m: *const Model, index: u8, r: Rect, out: *[max_panes]Placement, len: *usize) void {
        switch (m.nodes[index].?) {
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
    pub fn neighbor(m: *const Model, direction: Direction, area: Rect) ?Id {
        var items: [max_panes]Placement = undefined;
        var copy = m.*;
        copy.tabs[copy.active].zoom = false;
        const placements_ = copy.placements(area, &items);
        var current: Rect = .{};
        for (placements_) |p| if (p.id == m.tabs[m.active].focus) {
            current = p.rect;
        };
        var best: ?Id = null;
        var score: u64 = std.math.maxInt(u64);
        const cx = @as(i32, current.x) * 2 + current.w;
        const cy = @as(i32, current.y) * 2 + current.h;
        for (placements_) |p| {
            if (p.id == m.tabs[m.active].focus) continue;
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
    pub fn swap(m: *Model, other: Id) !void {
        const a = m.findNode(m.tab().focus) orelse return error.NoPane;
        const b = m.findNode(other) orelse return error.NoPane;
        std.mem.swap(?Node, &m.nodes[a], &m.nodes[b]);
        // Focus follows the process, not its former rectangle.
    }
    pub fn resize(m: *Model, direction: Direction) void {
        const axis: Axis = switch (direction) {
            .left, .right => .horizontal,
            .up, .down => .vertical,
        };
        const delta: i32 = switch (direction) {
            .left, .up => -40,
            .right, .down => 40,
        };
        _ = m.resizeNode(m.tab().root, m.tab().focus, axis, delta);
    }
    fn resizeNode(m: *Model, index: u8, id: Id, axis: Axis, delta: i32) bool {
        const n = &m.nodes[index].?;
        if (n.* != .split) return false;
        const s = &n.split;
        const child = if (m.contains(s.first, id)) s.first else s.second;
        if (m.resizeNode(child, id, axis, delta)) return true;
        if (s.axis != axis) return false;
        s.ratio = @intCast(std.math.clamp(@as(i32, s.ratio) + delta, 100, 900));
        return true;
    }
    pub fn reorder(m: *Model, delta: i32) void {
        if (m.count == 0) return;
        const dest: usize = @intCast(std.math.clamp(@as(i32, @intCast(m.active)) + delta, 0, @as(i32, @intCast(m.count)) - 1));
        std.mem.swap(Tab, &m.tabs[m.active], &m.tabs[dest]);
        m.active = dest;
    }
    /// Insert a tab at a gap in the original order, preserving the focused tab.
    pub fn moveTab(m: *Model, id: Id, insert: usize) void {
        if (insert > m.count or m.count == 0) return;
        const focused = m.tabs[m.active].id;
        for (m.tabs[0..m.count], 0..) |tab_value, source| {
            if (tab_value.id != id) continue;
            const dest = insert - @intFromBool(insert > source);
            var i = source;
            while (i < dest) : (i += 1) m.tabs[i] = m.tabs[i + 1];
            while (i > dest) : (i -= 1) m.tabs[i] = m.tabs[i - 1];
            m.tabs[dest] = tab_value;
            for (m.tabs[0..m.count], 0..) |t, index| {
                if (t.id == focused) m.active = index;
            }
            return;
        }
    }
    pub fn breakPane(m: *Model) !void {
        if (m.count == max_tabs) return error.TooManyTabs;
        const id = m.tab().focus;
        if (m.nodes[m.tab().root].? == .pane) return;
        try m.close(id);
        const root = try m.alloc(.{ .pane = id });
        m.tabs[m.count] = .{ .id = m.next_id, .root = root, .focus = id };
        m.next_id += 1;
        m.active = m.count;
        m.count += 1;
    }
    pub fn joinPane(m: *Model, dest: usize) !void {
        if (dest >= m.count or dest == m.active) return error.NoTab;
        const before = m.*;
        errdefer m.* = before;
        const id = m.tab().focus;
        const target = m.tabs[dest].id;
        try m.close(id);
        for (m.tabs[0..m.count], 0..) |t, i| if (t.id == target) {
            m.active = i;
            break;
        };
        const temporary = try m.split(.horizontal);
        m.nodes[m.findNode(temporary).?] = .{ .pane = id };
        m.tab().focus = id;
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
        if (m.active > index) m.active -= 1 else if (m.active >= m.count) m.active = m.count -| 1;
    }
    fn freeTree(m: *Model, root: u8) void {
        if (m.nodes[root].? == .split) {
            const s = m.nodes[root].?.split;
            m.freeTree(s.first);
            m.freeTree(s.second);
        }
        m.nodes[root] = null;
    }
    pub fn insertTree(m: *Model, root: u8, target: Id, direction: Direction) !void {
        const node = m.findNode(target) orelse return error.NoPane;
        const old = try m.alloc(m.nodes[node].?);
        const before = direction == .left or direction == .up;
        m.nodes[node] = .{ .split = .{ .axis = if (direction == .left or direction == .right) .horizontal else .vertical, .first = if (before) root else old, .second = if (before) old else root } };
    }
    pub fn setShare(m: *Model, id: Id, axis: Axis, ratio: u16) !void {
        const tab_index = m.tabForPane(id) orelse return error.NoPane;
        if (!m.shareNode(m.tabs[tab_index].root, id, axis, ratio)) return error.NoSplit;
    }
    fn shareNode(m: *Model, root: u8, id: Id, axis: Axis, ratio: u16) bool {
        const n = &m.nodes[root].?;
        if (n.* != .split) return false;
        const first = m.contains(n.split.first, id);
        if (m.shareNode(if (first) n.split.first else n.split.second, id, axis, ratio)) return true;
        if (n.split.axis != axis) return false;
        n.split.ratio = if (first) ratio else 1000 - ratio;
        return true;
    }
    pub const Divider = struct { node: u8, rect: Rect };
    pub fn dividerAt(m: *const Model, area: Rect, x: u16, y: u16) ?Divider {
        if (m.count == 0 or m.tabs[m.active].zoom) return null;
        return m.dividerNode(m.tabs[m.active].root, m.contentArea(area), x, y);
    }
    fn dividerNode(m: *const Model, index: u8, r: Rect, x: u16, y: u16) ?Divider {
        if (!r.contains(x, y)) return null;
        const n = m.nodes[index].?;
        if (n != .split) return null;
        const s = n.split;
        const parts = splitRects(s, r);
        if (parts[1].contains(x, y)) return .{ .node = index, .rect = r };
        if (parts[0].contains(x, y)) return m.dividerNode(s.first, parts[0], x, y);
        return m.dividerNode(s.second, parts[2], x, y);
    }
    pub const Border = struct { rect: Rect, axis: Axis, draggable: bool = true };
    pub fn borders(m: *const Model, area: Rect, out: *[max_borders]Border) []Border {
        if (m.count == 0 or m.tabs[m.active].zoom) return out[0..0];
        var len: usize = 0;
        if (m.hasFrame(area)) {
            out[0] = .{ .rect = .{ .x = area.x, .y = area.y, .w = area.w, .h = 1 }, .axis = .vertical, .draggable = false };
            out[1] = .{ .rect = .{ .x = area.x, .y = area.y + area.h - 1, .w = area.w, .h = 1 }, .axis = .vertical, .draggable = false };
            out[2] = .{ .rect = .{ .x = area.x, .y = area.y + 1, .w = 1, .h = area.h - 2 }, .axis = .horizontal, .draggable = false };
            out[3] = .{ .rect = .{ .x = area.x + area.w - 1, .y = area.y + 1, .w = 1, .h = area.h - 2 }, .axis = .horizontal, .draggable = false };
            len = 4;
        }
        m.borderNode(m.tabs[m.active].root, m.contentArea(area), out, &len);
        return out[0..len];
    }
    fn borderNode(m: *const Model, index: u8, r: Rect, out: *[max_borders]Border, len: *usize) void {
        if (r.w == 0 or r.h == 0) return;
        const n = m.nodes[index].?;
        if (n != .split) return;
        const parts = splitRects(n.split, r);
        out[len.*] = .{ .rect = parts[1], .axis = n.split.axis };
        len.* += 1;
        m.borderNode(n.split.first, parts[0], out, len);
        m.borderNode(n.split.second, parts[2], out, len);
    }

    pub fn dragDivider(m: *Model, divider: Divider, x: u16, y: u16) void {
        const slot = &(m.nodes[divider.node] orelse return);
        if (slot.* != .split) return;
        const axis = slot.split.axis;
        const total = if (axis == .horizontal) divider.rect.w else divider.rect.h;
        const pos = if (axis == .horizontal) x -| divider.rect.x else y -| divider.rect.y;
        m.nodes[divider.node].?.split.ratio = @intCast(std.math.clamp((@as(u32, pos) * 1000 + (total -| 2)) / @max(1, total -| 1), 100, 900));
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
    const a = try m.newTab("one");
    const b = try m.split(.horizontal);
    const c = try m.split(.vertical);
    try m.close(b);
    try std.testing.expectEqual(c, m.tab().focus);
    var out: [max_panes]Placement = undefined;
    const p = m.placements(.{ .w = 81, .h = 24 }, &out);
    try std.testing.expectEqual(@as(usize, 2), p.len);
    try std.testing.expectEqual(a, p[0].id);
    try std.testing.expectEqual(c, p[1].id);
    try m.close(a);
    try std.testing.expectEqual(c, m.nodes[m.tab().root].?.pane);
    try m.close(c);
    try std.testing.expectEqual(@as(usize, 0), m.count);
}
test "directional focus, zoom and resize keep geometry inside bounds" {
    var m: Model = .{};
    const a = try m.newTab("one");
    const b = try m.split(.horizontal);
    try std.testing.expectEqual(a, m.neighbor(.left, .{ .w = 81, .h = 24 }).?);
    m.resize(.left);
    var out: [max_panes]Placement = undefined;
    for (m.placements(.{ .w = 1, .h = 1 }, &out)) |p| {
        try std.testing.expect(p.rect.x + p.rect.w <= 1);
        try std.testing.expect(p.rect.y + p.rect.h <= 1);
    }
    m.tab().zoom = true;
    try std.testing.expectEqual(b, m.placements(.{ .w = 81, .h = 24 }, &out)[0].id);
}
test "moving panes across tabs preserves pane identity" {
    var m: Model = .{};
    const a = try m.newTab("one");
    const b = try m.split(.horizontal);
    try m.breakPane();
    try std.testing.expectEqual(@as(usize, 2), m.count);
    try std.testing.expectEqual(b, m.tab().focus);
    try m.joinPane(0);
    try std.testing.expectEqual(@as(usize, 1), m.count);
    try std.testing.expect(m.findNode(a) != null and m.findNode(b) != null);
}
test "tab insertion preserves order, names, splits and logical focus" {
    var m: Model = .{};
    _ = try m.newTab("");
    const first = m.tab().*;
    _ = try m.newTab("named");
    _ = try m.split(.horizontal);
    const second = m.tab().*;
    _ = try m.newTab("");
    const third = m.tab().*;
    m.moveTab(first.id, 3);
    try std.testing.expectEqualDeep(second, m.tabs[0]);
    try std.testing.expectEqualDeep(third, m.tabs[1]);
    try std.testing.expectEqualDeep(first, m.tabs[2]);
    try std.testing.expectEqual(third.id, m.tab().id);
    m.moveTab(first.id, 0);
    try std.testing.expectEqualDeep(first, m.tabs[0]);
    try std.testing.expectEqualDeep(second, m.tabs[1]);
    m.moveTab(second.id, 2); // Its own trailing gap is a no-op.
    try std.testing.expectEqualDeep(second, m.tabs[1]);
    try std.testing.expectEqual(third.id, m.tab().id);
}

test "divider cells match gaps at every size and drag lands on requested cell" {
    var m: Model = .{};
    _ = try m.newTab("");
    _ = try m.split(.horizontal);
    _ = try m.split(.vertical);
    for (0..20) |width| {
        for (0..14) |height| {
            const area: Rect = .{ .x = 3, .y = 2, .w = @intCast(width), .h = @intCast(height) };
            var panes: [max_panes]Placement = undefined;
            var lines: [max_borders]Model.Border = undefined;
            const placements = m.placements(area, &panes);
            const borders = m.borders(area, &lines);
            for (area.y..area.y + area.h) |y| for (area.x..area.x + area.w) |x| {
                var coverage: usize = 0;
                for (placements) |p| if (p.rect.contains(@intCast(x), @intCast(y))) {
                    coverage += 1;
                };
                for (borders) |b| if (b.rect.contains(@intCast(x), @intCast(y))) {
                    coverage += 1;
                    try std.testing.expectEqual(b.draggable, m.dividerAt(area, @intCast(x), @intCast(y)) != null);
                };
                try std.testing.expectEqual(@as(usize, 1), coverage);
            };
        }
    }
    const area: Rect = .{ .x = 28, .y = 1, .w = 72, .h = 28 };
    const divider = m.dividerAt(area, 63, 2).?;
    m.dragDivider(divider, 75, 2);
    try std.testing.expect(m.dividerAt(area, 75, 2) != null);
    m.tab().zoom = true;
    var lines: [max_borders]Model.Border = undefined;
    try std.testing.expectEqual(@as(usize, 0), m.borders(area, &lines).len);
    try std.testing.expect(m.dividerAt(area, 75, 2) == null);
}

test "only split layouts reserve an outer frame and closing restores the area" {
    var m: Model = .{};
    _ = try m.newTab("");
    const area: Rect = .{ .x = 28, .y = 1, .w = 72, .h = 28 };
    var panes: [max_panes]Placement = undefined;
    try std.testing.expectEqualDeep(area, m.placements(area, &panes)[0].rect);
    const second = try m.split(.horizontal);
    for (m.placements(area, &panes)) |p| {
        try std.testing.expect(p.rect.x > area.x and p.rect.y > area.y);
        try std.testing.expect(p.rect.x + p.rect.w < area.x + area.w);
        try std.testing.expect(p.rect.y + p.rect.h < area.y + area.h);
    }
    try m.close(second);
    try std.testing.expectEqualDeep(area, m.placements(area, &panes)[0].rect);
}
