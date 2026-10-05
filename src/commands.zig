const std = @import("std");
const Direction = @import("layout.zig").Direction;
const palette = @import("palette.zig");

/// A resize menu row: the key it shows and the resize a click performs.
pub const Entry = struct {
    key: u8,
    label: []const u8,
    direction: Direction,
    needs_pane: bool = true,
};
const resize_entries = [_]Entry{
    .{ .key = 'h', .label = "Resize left", .direction = .left },
    .{ .key = 'j', .label = "Resize down", .direction = .down },
    .{ .key = 'k', .label = "Resize up", .direction = .up },
    .{ .key = 'l', .label = "Resize right", .direction = .right },
};
pub const Hit = union(enum) { none, close, previous, next, command: Entry };
// Herdr's tab context menu: these actions apply to the clicked tab, not the
// currently focused tab. Keep its identity even while tabs move or disappear.
pub const TabMenu = struct {
    tab: u32,
    anchor_x: u16,
    anchor_y: u16 = 0,
    workspace: bool = false,
    pane: bool = false,
    source: ?u32 = null,
    highlighted: usize = 0,
    /// What a row does to the menu's tab, workspace or pane.
    pub const Item = enum { new, rename, @"clear-name", swap, @"split-right", @"split-down", zoom, close };
    pub const Row = struct { item: Item, key: u8, label: []const u8 };
    const actions = [_]Row{
        .{ .item = .new, .key = 'c', .label = "New tab" },
        .{ .item = .rename, .key = 'T', .label = "Rename" },
        .{ .item = .close, .key = 'X', .label = "Close" },
    };
    const pane_actions = [_]Row{
        .{ .item = .swap, .key = 's', .label = "Swap with focused pane" },
        .{ .item = .rename, .key = 'T', .label = "Rename pane" },
        .{ .item = .@"clear-name", .key = 'C', .label = "Clear pane name" },
        .{ .item = .@"split-right", .key = 'v', .label = "Split right" },
        .{ .item = .@"split-down", .key = '-', .label = "Split down" },
        .{ .item = .zoom, .key = 'z', .label = "Zoom / unzoom" },
        .{ .item = .close, .key = 'X', .label = "Close pane" },
    };
    pub fn entries(m: TabMenu) []const Row {
        if (m.pane) return if (m.source != null) &pane_actions else pane_actions[1..];
        return if (m.workspace) actions[1..] else &actions;
    }
    /// The row a key picks: its shown key, or `r` and `x` for rename and close.
    pub fn itemFor(m: TabMenu, key: u8) ?Item {
        const shown: u8 = switch (key) {
            'r' => 'T',
            'x' => 'X',
            else => key,
        };
        for (m.entries()) |row| if (row.key == shown) return row.item;
        return null;
    }
    const Bounds = struct { x: u16, y: u16, width: u16, padding: u16 };
    const border = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
    fn bounds(m: TabMenu, width: u16, height: u16) Bounds {
        const w = @min(width, if (m.pane) @as(u16, 30) else 20);
        return .{
            .x = @min(m.anchor_x, width - w),
            .y = @min(m.anchor_y, height -| (m.entries().len + 2)),
            .width = w,
            .padding = if (height >= m.entries().len + 2) 1 else 0,
        };
    }
    pub fn hit(m: TabMenu, width: u16, height: u16, x: u16, y: u16) ?usize {
        const b = m.bounds(width, height);
        if (x < b.x + 1 or x >= b.x + b.width - 1 or y < b.y + b.padding or y >= b.y + b.padding + m.entries().len) return null;
        return y - b.y - b.padding;
    }
    pub fn move(m: *TabMenu, next: bool) void {
        m.highlighted = if (next) (m.highlighted + 1) % m.entries().len else (m.highlighted + m.entries().len - 1) % m.entries().len;
    }
    pub fn draw(m: TabMenu, w: *std.Io.Writer, width: u16, height: u16) !void {
        const b = m.bounds(width, height);
        if (b.padding > 0) {
            for ([_]u16{ 0, @intCast(m.entries().len + 1) }) |row| {
                try w.print("\x1b[{d};{d}H" ++ border ++ "+", .{ b.y + row + 1, b.x + 1 });
                try w.splatByteAll('-', b.width - 2);
                try w.writeByte('+');
            }
        }
        for (m.entries(), 0..) |entry, index| {
            const row_style = if (index == m.highlighted) (palette.Style{ .fg = .strong, .bg = .selected, .bold = true }).sgr() else (palette.Style{ .fg = .strong, .bg = .surface }).sgr();
            try w.print("\x1b[{d};{d}H" ++ border ++ "|{s}", .{ b.y + index + b.padding + 1, b.x + 1, row_style });
            const show_key = b.width >= 14;
            const len = @min(entry.label.len, b.width - @as(u16, if (show_key) 6 else 2));
            try w.writeAll(entry.label[0..len]);
            try w.splatByteAll(' ', b.width - 2 - len - @as(u16, if (show_key) 2 else 0));
            if (show_key) try w.print("{c} ", .{entry.key});
            try w.writeAll(border ++ "|");
        }
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
};
/// Key and label styles for a resize-menu row: a keycap when the row can run,
/// and the label on the row's background.
fn rowColors(enabled: bool, selected: bool) struct { key: []const u8, label: []const u8 } {
    if (!enabled) return .{ .key = palette.fg(.faint), .label = palette.fg(.faint) };
    return .{ .key = palette.keycap, .label = if (selected) (palette.Style{ .fg = .strong, .bg = .selected }).sgr() else (palette.Style{ .fg = .strong, .bg = .surface }).sgr() };
}
pub const ResizeView = struct {
    x: u16,
    y: u16,
    width: u16,
    rows: u16,
    columns: u16,
    page: usize,
    pages: usize,
    has_pane: bool,
    highlighted: ?u8 = null,

    pub fn init(width: u16, height: u16, page: usize, has_pane: bool) ResizeView {
        const w = @min(width, 34);
        const count: u16 = resize_entries.len;
        const rows = @max(1, @min(count, height -| 3));
        const pages = (count + rows - 1) / rows;
        return .{ .x = (width - w) / 2, .y = (height -| (rows + 3)) / 2, .width = w, .rows = rows, .columns = 1, .page = @min(page, pages - 1), .pages = pages, .has_pane = has_pane };
    }
    pub fn items(v: ResizeView) []const Entry {
        const all: []const Entry = &resize_entries;
        const size = v.rows * v.columns;
        const start = v.page * size;
        return all[start..@min(all.len, start + size)];
    }
    pub fn hit(v: ResizeView, x: u16, y: u16) Hit {
        if (x < v.x or x >= v.x + v.width or y < v.y or y >= v.y + v.rows + 3) return .close;
        if (y == v.y) return if (x >= v.x + v.width -| 3) .close else .none;
        if (y == v.y + v.rows + 2) {
            if (v.pages > 1) return if (x < v.x + v.width / 2) .previous else .next;
            return .close;
        }
        if (y < v.y + 2) return .none;
        const col = @min(v.columns - 1, (x - v.x) / (v.width / v.columns));
        const index = col * v.rows + y - v.y - 2;
        const list = v.items();
        if (index >= list.len or (list[index].needs_pane and !v.has_pane)) return .none;
        return .{ .command = list[index] };
    }
    pub fn draw(v: ResizeView, w: *std.Io.Writer) !void {
        for (0..v.rows + 3) |row| {
            try w.print("\x1b[{d};{d}H" ++ (palette.Style{ .bg = .surface }).sgr(), .{ v.y + row + 1, v.x + 1 });
            try w.splatByteAll(' ', v.width);
        }
        try v.line(w, 0, " Resize panes", true);
        try w.print("\x1b[{d};{d}H" ++ palette.fg(.muted) ++ " x", .{ v.y + 1, v.x + v.width - 1 });
        try v.line(w, 1, " Shortcut or click", false);
        const col_width = v.width / v.columns;
        for (v.items(), 0..) |entry, index| {
            const row = index % v.rows;
            const col = index / v.rows;
            const enabled = !entry.needs_pane or v.has_pane;
            const selected = enabled and v.highlighted == entry.key;
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 3, v.x + col * col_width + 1, if (selected) palette.bg(.selected) else palette.bg(.surface) });
            try w.splatByteAll(' ', col_width);
            const rc = rowColors(enabled, selected);
            try w.print("\x1b[{d};{d}H{s} {s} {s} ", .{ v.y + row + 3, v.x + col * col_width + 1, rc.key, if (entry.key == 9) "⇥" else &.{entry.key}, rc.label });
            try w.writeAll(entry.label[0..@min(entry.label.len, col_width -| 5)]);
        }
        try w.writeAll(palette.bg(.surface));
        if (v.pages > 1) {
            var footer: [64]u8 = undefined;
            const previous = try std.fmt.bufPrint(&footer, " < {d}/{d}", .{ v.page + 1, v.pages });
            try v.line(w, v.rows + 2, previous[0..@min(previous.len, v.width / 2)], false);
            const next = "Next >";
            const next_len = @min(next.len, v.width / 2);
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + v.rows + 3, v.x + v.width - next_len + 1, next[next.len - next_len ..] });
        } else try v.line(w, v.rows + 2, " Esc done", false);
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
    fn line(v: ResizeView, w: *std.Io.Writer, row: u16, text: []const u8, bold: bool) !void {
        try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 1, v.x + 1, if (bold) comptime "\x1b[1m" ++ palette.fg(.strong) else comptime "\x1b[22m" ++ palette.fg(.muted) });
        try w.writeAll(text[0..@min(text.len, v.width)]);
    }
};

test "menu keys pick the rows each menu shows" {
    const tab: TabMenu = .{ .tab = 1, .anchor_x = 0 };
    try std.testing.expectEqual(TabMenu.Item.new, tab.itemFor('c').?);
    try std.testing.expectEqual(TabMenu.Item.rename, tab.itemFor('r').?);
    try std.testing.expectEqual(TabMenu.Item.close, tab.itemFor('x').?);
    try std.testing.expectEqual(null, tab.itemFor('v'));
    const workspace: TabMenu = .{ .tab = 1, .anchor_x = 0, .workspace = true };
    try std.testing.expectEqual(null, workspace.itemFor('c'));
    const pane: TabMenu = .{ .tab = 1, .anchor_x = 0, .pane = true };
    try std.testing.expectEqual(TabMenu.Item.@"split-down", pane.itemFor('-').?);
    try std.testing.expectEqual(TabMenu.Item.@"clear-name", pane.itemFor('C').?);
    try std.testing.expectEqual(null, pane.itemFor('s'));
    const swap: TabMenu = .{ .tab = 1, .anchor_x = 0, .pane = true, .source = 2 };
    try std.testing.expectEqual(TabMenu.Item.swap, swap.itemFor('s').?);
}
