const std = @import("std");

pub const Entry = struct {
    key: u8,
    label: []const u8,
    needs_pane: bool = true,
};
pub const entries = [_]Entry{
    .{ .key = 'c', .label = "New tab", .needs_pane = false },
    .{ .key = 'T', .label = "Rename tab" },
    .{ .key = 'n', .label = "Next tab" },
    .{ .key = 'p', .label = "Previous tab" },
    .{ .key = 'X', .label = "Close tab" },
    .{ .key = 'u', .label = "Reopen closed pane", .needs_pane = false },
    .{ .key = 'v', .label = "Split right" },
    .{ .key = '-', .label = "Split down" },
    .{ .key = 'z', .label = "Zoom / unzoom" },
    .{ .key = 'x', .label = "Close pane" },
    .{ .key = '!', .label = "Move pane to new tab" },
    .{ .key = '[', .label = "Scroll / copy" },
    .{ .key = 'h', .label = "Focus left" },
    .{ .key = 'j', .label = "Focus down" },
    .{ .key = 'k', .label = "Focus up" },
    .{ .key = 'l', .label = "Focus right" },
    .{ .key = 'H', .label = "Swap left" },
    .{ .key = 'J', .label = "Swap down" },
    .{ .key = 'K', .label = "Swap up" },
    .{ .key = 'L', .label = "Swap right" },
    .{ .key = 'r', .label = "Resize panes..." },
    .{ .key = 'a', .label = "Jump to attention", .needs_pane = false },
    .{ .key = 'm', .label = "Mute / unmute", .needs_pane = false },
    .{ .key = 'q', .label = "Detach", .needs_pane = false },
    .{ .key = 'w', .label = "New workspace", .needs_pane = false },
    .{ .key = 'W', .label = "Edit workspace", .needs_pane = false },
    .{ .key = '}', .label = "Next workspace", .needs_pane = false },
    .{ .key = '{', .label = "Previous workspace", .needs_pane = false },
    .{ .key = 'b', .label = "Toggle sidebar", .needs_pane = false },
};
const resize_entries = [_]Entry{
    .{ .key = 'h', .label = "Resize left" },
    .{ .key = 'j', .label = "Resize down" },
    .{ .key = 'k', .label = "Resize up" },
    .{ .key = 'l', .label = "Resize right" },
};
pub const Hit = union(enum) { none, close, previous, next, command: Entry };
// Herdr's tab context menu: these actions apply to the clicked tab, not the
// currently focused tab. Keep its identity even while tabs move or disappear.
pub const TabMenu = struct {
    tab: u32,
    anchor_x: u16,
    anchor_y: u16 = 0,
    workspace: bool = false,
    highlighted: usize = 0,
    pub const actions = [_]Entry{
        .{ .key = 'c', .label = "New tab" },
        .{ .key = 'T', .label = "Rename" },
        .{ .key = 'X', .label = "Close" },
    };
    pub fn entries(m: TabMenu) []const Entry {
        return if (m.workspace) actions[1..] else &actions;
    }
    const Bounds = struct { x: u16, y: u16, width: u16, padding: u16 };
    fn bounds(m: TabMenu, width: u16, height: u16) Bounds {
        const w = @min(width, 20);
        return .{ .x = @min(m.anchor_x, width - w), .y = @min(m.anchor_y, height -| (m.entries().len + 2)), .width = w, .padding = if (height >= m.entries().len + 2) 1 else 0 };
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
                try w.print("\x1b[{d};{d}H\x1b[0;38;2;100;108;121;48;2;35;40;47m+", .{ b.y + row + 1, b.x + 1 });
                try w.splatByteAll('-', b.width - 2);
                try w.writeByte('+');
            }
        }
        for (m.entries(), 0..) |entry, index| {
            try w.print("\x1b[{d};{d}H\x1b[0;38;2;100;108;121;48;2;35;40;47m|{s}", .{ b.y + index + b.padding + 1, b.x + 1, if (index == m.highlighted) "\x1b[1;38;2;24;27;32;48;2;161;194;178m" else "\x1b[22;38;2;226;230;233m" });
            const show_key = b.width >= 14;
            const len = @min(entry.label.len, b.width - @as(u16, if (show_key) 6 else 2));
            try w.writeAll(entry.label[0..len]);
            try w.splatByteAll(' ', b.width - 2 - len - @as(u16, if (show_key) 2 else 0));
            if (show_key) try w.print("{c} ", .{entry.key});
            try w.writeAll("\x1b[0;38;2;100;108;121;48;2;35;40;47m|");
        }
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
};
pub const View = struct {
    x: u16,
    y: u16,
    width: u16,
    rows: u16,
    columns: u16,
    page: usize,
    pages: usize,
    resizing: bool,
    has_pane: bool,
    highlighted: ?u8 = null,

    pub fn init(width: u16, height: u16, resizing: bool, page: usize, has_pane: bool) View {
        const columns: u16 = if (width >= 64 and !resizing) 2 else 1;
        const w = @min(width, if (columns == 2) @as(u16, 66) else 34);
        const count: u16 = if (resizing) resize_entries.len else entries.len;
        const rows = @max(1, @min((count + columns - 1) / columns, height -| 3));
        const pages = (count + rows * columns - 1) / (rows * columns);
        return .{ .x = (width - w) / 2, .y = (height -| (rows + 3)) / 2, .width = w, .rows = rows, .columns = columns, .page = @min(page, pages - 1), .pages = pages, .resizing = resizing, .has_pane = has_pane };
    }
    pub fn items(v: View) []const Entry {
        const all: []const Entry = if (v.resizing) &resize_entries else &entries;
        const size = v.rows * v.columns;
        const start = v.page * size;
        return all[start..@min(all.len, start + size)];
    }
    pub fn hit(v: View, x: u16, y: u16) Hit {
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
    pub fn draw(v: View, w: *std.Io.Writer) !void {
        for (0..v.rows + 3) |row| {
            try w.print("\x1b[{d};{d}H\x1b[0;48;2;35;40;47m", .{ v.y + row + 1, v.x + 1 });
            try w.splatByteAll(' ', v.width);
        }
        try v.line(w, 0, if (v.resizing) " Resize panes" else " Commands", true);
        try w.print("\x1b[{d};{d}H\x1b[38;2;155;163;175m x", .{ v.y + 1, v.x + v.width - 1 });
        try v.line(w, 1, " Shortcut or click", false);
        const col_width = v.width / v.columns;
        for (v.items(), 0..) |entry, index| {
            const row = index % v.rows;
            const col = index / v.rows;
            const enabled = !entry.needs_pane or v.has_pane;
            const selected = enabled and v.highlighted == entry.key;
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 3, v.x + col * col_width + 1, if (selected) "\x1b[48;2;161;194;178m" else "\x1b[48;2;35;40;47m" });
            try w.splatByteAll(' ', col_width);
            try w.print("\x1b[{d};{d}H{s} {c}  \x1b[22m{s}", .{ v.y + row + 3, v.x + col * col_width + 1, if (selected) "\x1b[1;38;2;24;27;32m" else if (enabled) "\x1b[1;38;2;161;194;178m" else "\x1b[38;2;86;94;105m", entry.key, if (selected) "\x1b[38;2;24;27;32m" else if (enabled) "\x1b[38;2;226;230;233m" else "\x1b[38;2;86;94;105m" });
            try w.writeAll(entry.label[0..@min(entry.label.len, col_width -| 5)]);
        }
        try w.writeAll("\x1b[48;2;35;40;47m");
        if (v.pages > 1) {
            var footer: [64]u8 = undefined;
            const previous = try std.fmt.bufPrint(&footer, " < {d}/{d}", .{ v.page + 1, v.pages });
            try v.line(w, v.rows + 2, previous[0..@min(previous.len, v.width / 2)], false);
            const next = "Next >";
            const next_len = @min(next.len, v.width / 2);
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + v.rows + 3, v.x + v.width - next_len + 1, next[next.len - next_len ..] });
        } else try v.line(w, v.rows + 2, if (v.resizing) " Esc done" else " Esc close   1-9 jump to tab", false);
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
    fn line(v: View, w: *std.Io.Writer, row: u16, text: []const u8, bold: bool) !void {
        try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 1, v.x + 1, if (bold) "\x1b[1;38;2;226;230;233m" else "\x1b[22;38;2;155;163;175m" });
        try w.writeAll(text[0..@min(text.len, v.width)]);
    }
};
