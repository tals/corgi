//! Shared, viewer-owned shortcut screen for onboarding and the prefix menu.
//! Layout produces cell rows before clipping, so both columns share one scroll.
const std = @import("std");
const a = @import("os.zig").allocator;
const km = @import("keymap.zig");
const sidebar = @import("sidebar.zig");
const Rect = @import("layout.zig").Rect;

pub fn needsPane(action: u8) bool {
    return switch (action) {
        'a', 'c', 'u', 'g', '[', ']', 9, 'f', 'm', 'w', 'W', '{', '}', 'b', 'i', '?', km.workspace_picker, km.close_workspace => false,
        else => true,
    };
}

pub const State = struct {
    command_mode: bool = false,
    scroll: usize = 0,
    page_rows: usize = 1,
    max_scroll: usize = 0,

    pub fn move(s: *State, down: bool, rows: usize) void {
        s.scroll = if (down) @min(s.max_scroll, s.scroll +| rows) else s.scroll -| rows;
    }
    pub fn key(s: *State, byte: u8) bool {
        switch (byte) {
            27, 13, 'q', '?' => return true,
            'j', 14 => s.move(true, 1),
            'k', 16 => s.move(false, 1),
            'g' => s.scroll = 0,
            'G' => s.scroll = s.max_scroll,
            else => {},
        }
        return false;
    }
    pub fn sequence(s: *State, seq: []const u8) void {
        if (eq(seq, "\x1b[A") or eq(seq, "\x1bOA")) s.move(false, 1);
        if (eq(seq, "\x1b[B") or eq(seq, "\x1bOB")) s.move(true, 1);
        if (eq(seq, "\x1b[5~")) s.move(false, s.page_rows);
        if (eq(seq, "\x1b[6~")) s.move(true, s.page_rows);
        if (eq(seq, "\x1b[H") or eq(seq, "\x1bOH") or eq(seq, "\x1b[1~")) s.scroll = 0;
        if (eq(seq, "\x1b[F") or eq(seq, "\x1bOF") or eq(seq, "\x1b[4~")) s.scroll = s.max_scroll;
    }
    pub fn closeAt(cols: u16, rows: u16, x: u16, y: u16) bool {
        const b = bounds(cols, rows);
        return !b.contains(x, y) or (y == b.y + (b.h -| 2) and x >= b.x + (b.w -| 16));
    }
    pub const Hit = union(enum) { none, close, action: u8 };
    pub fn hit(s: *const State, cols: u16, rows: u16, x: u16, y: u16, preset: km.Preset) !Hit {
        if (closeAt(cols, rows, x, y)) return .close;
        const b = bounds(cols, rows);
        if (b.w < 32 or b.h < 12 or y < b.y + 5 or y >= b.y + b.h - 3) return .none;
        const dual = b.w >= 60;
        const width: u16 = if (dual) (b.w - 9) / 2 - 4 else b.w - 8;
        var columns = [_]Column{ .{ .width = width, .preset = preset }, .{ .width = width, .preset = preset } };
        defer for (&columns) |*column| column.rows.deinit(a);
        try navigation(&columns[0]);
        try panes(&columns[1]);
        const total = if (dual) @max(columns[0].rows.items.len, columns[1].rows.items.len) else columns[0].rows.items.len + 1 + columns[1].rows.items.len;
        const scroll = @min(s.scroll, total -| (b.h - 8));
        const offset = y - b.y - 5 + scroll;
        for (&columns, 0..) |*column, i| {
            const base: usize = if (dual or i == 0) 0 else columns[0].rows.items.len + 1;
            if (offset < base or offset - base >= column.rows.items.len) continue;
            const start: usize = b.x + @as(usize, if (!dual or i == 0) 4 else 7 + (b.w - 9) / 2);
            for (column.rows.items[offset - base].parts[0..column.rows.items[offset - base].len]) |part| {
                if (part.action) |action| if (x >= start + part.x and x < start + part.x + sidebar.displayWidth(part.value())) return .{ .action = action };
            }
        }
        return .none;
    }
    pub fn frame(s: *State, cols: u16, rows: u16, preset: km.Preset, prefix: km.Prefix) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(a);
        errdefer out.deinit();
        const w = &out.writer;
        try w.writeAll("\x1b[0;48;2;24;27;32m\x1b[2J\x1b[?25l");
        const b = bounds(cols, rows);
        if (b.w < 32 or b.h < 12) {
            s.page_rows = 1;
            s.max_scroll = 0;
            s.scroll = 0;
            try at(w, b, 0, 0, "Help needs 32 × 12", .text);
            if (b.h > 1) try at(w, b, 0, 1, "Esc back", .mint);
            try w.writeAll("\x1b[0m");
            return out.toOwnedSlice();
        }
        try box(w, b);
        try at(w, b, 2, 0, " Corgi ", .mint);
        try at(w, b, 3, 1, "Keyboard shortcuts", .bright);
        if (b.w >= 60) try at(w, b, b.w - 17, 1, km.name(preset), .dim);
        try at(w, b, 3, 3, "PREFIX", .dim);
        try at(w, b, 11, 3, if (prefix == .ctrl_b) "[ Ctrl+B ]" else "[ Ctrl+A ]", .keycap);
        try at(w, b, 23, 3, if (preset == .cmux) "P = prefix · Cmd = hold" else if (b.w < 76) "then key" else "Release, then press the key.", .dim);

        const dual = b.w >= 60;
        const width: u16 = if (dual) (b.w - 9) / 2 - 4 else b.w - 8;
        var columns = [_]Column{ .{ .width = width, .preset = preset }, .{ .width = width, .preset = preset } };
        defer for (&columns) |*column| column.rows.deinit(a);
        try navigation(&columns[0]);
        try panes(&columns[1]);
        const capacity = b.h - 8;
        const total = if (dual) @max(columns[0].rows.items.len, columns[1].rows.items.len) else columns[0].rows.items.len + 1 + columns[1].rows.items.len;
        s.page_rows = capacity;
        s.max_scroll = total -| capacity;
        s.scroll = @min(s.scroll, s.max_scroll);
        const right: u16 = 3 + (b.w - 9) / 2 + 3;
        if (dual) for (4..b.h - 2) |y| try at(w, b, right - 2, y, "│", .dim);
        for (&columns, 0..) |*column, i| {
            const base: usize = if (dual or i == 0) 0 else columns[0].rows.items.len + 1;
            const x: usize = if (!dual or i == 0) 4 else right + 1;
            for (column.rows.items, 0..) |row, index| {
                const y = base + index;
                if (y < s.scroll or y - s.scroll >= capacity) continue;
                for (row.parts[0..row.len]) |part| try at(w, b, x + part.x, 5 + y - s.scroll, part.value(), part.style);
            }
        }
        var buf: [80]u8 = undefined;
        const scroll_keys = if (s.command_mode and preset == .tmux) "PgUp/PgDn" else "↑↓ PgUp/PgDn";
        const footer = if (total > capacity)
            try std.fmt.bufPrint(&buf, "{s}  {d}–{d}/{d}", .{ scroll_keys, s.scroll + 1, @min(total, s.scroll + capacity), total })
        else if (s.command_mode)
            "Press a shortcut or click a key"
        else
            "All shortcuts";
        try clippedAt(w, b, 3, b.h - 2, b.w - 21, if (b.w < 60 and total > capacity) scroll_keys else footer, .dim);
        try at(w, b, b.w - 16, b.h - 2, "[ Esc Back ]", .mint);
        try w.writeAll("\x1b[0m");
        return out.toOwnedSlice();
    }
};

const Style = enum { text, bright, mint, dim, direct, keycap };
const Part = struct {
    x: u16,
    text: [192]u8 = undefined,
    len: usize,
    style: Style,
    action: ?u8 = null,
    fn value(p: *const Part) []const u8 {
        return p.text[0..p.len];
    }
};
const Row = struct {
    parts: [8]Part = undefined,
    len: usize = 0,
    fn add(r: *Row, x: usize, value: []const u8, style: Style) void {
        std.debug.assert(r.len < r.parts.len and value.len <= r.parts[0].text.len);
        var part = Part{ .x = @intCast(x), .len = value.len, .style = style };
        @memcpy(part.text[0..value.len], value);
        r.parts[r.len] = part;
        r.len += 1;
    }
    fn command(r: *Row, x: usize, value: []const u8, style: Style, action: u8) void {
        r.add(x, value, style);
        r.parts[r.len - 1].action = action;
    }
};
const Column = struct {
    rows: std.ArrayList(Row) = .empty,
    width: u16,
    preset: km.Preset,
    fn line(c: *Column, x: usize, value: []const u8, style: Style) !void {
        var row: Row = .{};
        row.add(x, value, style);
        try c.rows.append(a, row);
    }
    fn space(c: *Column) !void {
        try c.rows.append(a, .{});
    }
    fn heading(c: *Column, label: []const u8) !void {
        var row: Row = .{};
        row.add(0, label, .mint);
        var rule: [160]u8 = undefined;
        var len: usize = 0;
        for (0..c.width -| (label.len + 2)) |_| {
            @memcpy(rule[len..][0..3], "─");
            len += 3;
        }
        row.add(label.len + 2, rule[0..len], .dim);
        try c.rows.append(a, row);
    }
    fn group(c: *Column, label: []const u8) !void {
        try c.line(2, label, .bright);
    }
    fn wrapped(c: *Column, value: []const u8, indent: usize, style: Style, right: bool) !void {
        var rest = value;
        const room = c.width - indent;
        while (rest.len > 0) {
            var it = (try std.unicode.Utf8View.init(rest)).iterator();
            var end: usize = 0;
            var gap: usize = 0;
            while (it.nextCodepointSlice()) |bytes| {
                if (sidebar.displayWidth(rest[0 .. end + bytes.len]) > room) break;
                end += bytes.len;
                if (bytes[0] == ' ') gap = end - 1;
            }
            if (end < rest.len and gap > 0) end = gap;
            const slice = std.mem.trim(u8, rest[0..end], " ");
            try c.line(if (right) c.width - sidebar.displayWidth(slice) else indent, slice, style);
            rest = std.mem.trimStart(u8, rest[end..], " ");
        }
    }
    fn binding(c: *Column, label: []const u8, key: []const u8, indent: usize, direct: bool) !void {
        const key_width = sidebar.displayWidth(key);
        const style: Style = if (direct) .direct else .mint;
        if (indent + sidebar.displayWidth(label) + 3 + key_width <= c.width) {
            var row: Row = .{};
            row.add(indent, label, .text);
            row.add(c.width - key_width, key, style);
            try c.rows.append(a, row);
        } else {
            try c.wrapped(label, indent, .text, false);
            try c.wrapped(key, indent, style, true);
        }
    }
    fn action(c: *Column, label: []const u8, action_key: u8, indent: usize) !void {
        var buf: [128]u8 = undefined;
        if (try spelling(c.preset, action_key, &buf)) |key| {
            const start = c.rows.items.len;
            try c.binding(label, key, indent, false);
            c.mark(start, action_key);
        }
    }
    fn mark(c: *Column, start: usize, action_key: u8) void {
        for (c.rows.items[start..]) |*row| for (row.parts[0..row.len]) |*part| {
            part.action = action_key;
        };
    }
    fn pair(c: *Column, label: []const u8, first: u8, second: u8, indent: usize) !void {
        var one: [128]u8 = undefined;
        var two: [128]u8 = undefined;
        const k1 = try spelling(c.preset, first, &one);
        const k2 = try spelling(c.preset, second, &two);
        if (k1 != null and k2 != null) {
            const w1 = sidebar.displayWidth(k1.?);
            const w2 = sidebar.displayWidth(k2.?);
            const keys_width = w1 + 3 + w2;
            var row: Row = .{};
            if (indent + sidebar.displayWidth(label) + 3 + keys_width <= c.width) {
                row.add(indent, label, .text);
            } else try c.wrapped(label, indent, .text, false);
            if (indent + keys_width <= c.width) {
                const x = c.width - keys_width;
                row.command(x, k1.?, .mint, first);
                row.add(x + w1, " / ", .mint);
                row.command(x + w1 + 3, k2.?, .mint, second);
                try c.rows.append(a, row);
            } else {
                var start = c.rows.items.len;
                try c.wrapped(k1.?, indent, .mint, true);
                c.mark(start, first);
                start = c.rows.items.len;
                try c.wrapped(k2.?, indent, .mint, true);
                c.mark(start, second);
            }
        }
    }
};

// Resolve portable spellings from the same map that handles input. Command
// aliases include their portable fallback explicitly; P denotes the prefix.
fn spelling(preset: km.Preset, action: u8, buf: []u8) !?[]const u8 {
    const direct: ?[]const u8 = if (preset != .cmux) null else switch (action) {
        'c' => "Cmd+T",
        'n' => "Cmd+Shift+]",
        'p' => "Cmd+Shift+[",
        'T' => "Cmd+R",
        'w' => "Cmd+N",
        'W' => "Cmd+Shift+R",
        km.workspace_picker => "Cmd+P",
        km.close_workspace => "Cmd+Shift+W",
        'v' => "Cmd+D",
        '-' => "Cmd+Shift+D",
        'z' => "Cmd+Shift+Enter",
        'x' => "Cmd+W",
        's' => "Cmd+Shift+M",
        'g' => "Cmd+Shift+P",
        'f' => "Cmd+Shift+U",
        'b' => "Cmd+B",
        'i' => "Cmd+,",
        else => null,
    };
    const byte = km.shortcut(preset, action);
    var key_buf: [3]u8 = undefined;
    const portable: ?[]const u8 = if (byte) |k| if (k == 9) "Tab" else if (k >= 32 and k <= 126) blk: {
        key_buf[0] = k;
        break :blk key_buf[0..1];
    } else null else null;
    if (direct) |key| return if (portable) |p| try std.fmt.bufPrint(buf, "{s} · P {s}", .{ key, p }) else key;
    if (portable) |p| return try std.fmt.bufPrint(buf, "{s}{s}", .{ if (preset == .cmux) "P " else "", p });
    return null;
}
fn navigation(c: *Column) !void {
    try c.heading("TABS");
    try c.action("New tab → agent picker", 'c', 2);
    if (c.preset == .corgi) {
        const start = c.rows.items.len;
        try c.binding("Also works directly", "Ctrl+T", 4, true);
        c.mark(start, 'c');
    }
    try c.pair("Next / previous", 'n', 'p', 2);
    try c.binding("Select tab", if (c.preset == .tmux) "0–9" else if (c.preset == .cmux) "Ctrl+1–9 · P 1–9" else "1–9", 2, false);
    try c.action("Rename", 'T', 2);
    try c.action("Close", 'X', 2);
    try c.space();
    try c.heading("WORKSPACES");
    try c.action("New", 'w', 2);
    try c.action("Edit", 'W', 2);
    try c.pair("Next / previous", '}', '{', 2);
    try c.action("Choose workspace", km.workspace_picker, 2);
    if (c.preset == .herdr) try c.binding("Also choose workspace", "g", 4, false);
    if (c.preset == .cmux) try c.binding("Select workspace", "Cmd+1–9", 2, false);
    try c.action("Close workspace", km.close_workspace, 2);
    try c.space();
    try c.heading("AGENTS");
    try c.group("Navigate");
    try c.action("Find", 'g', 4);
    try c.pair("Next / previous", ']', '[', 4);
    try c.action("Last visited", 9, 4);
    try c.action("Needs attention", 'f', 4);
    try c.group("Manage");
    try c.action("New agent", 'a', 4);
    try c.action("Mute / unmute", 'm', 4);
}
fn direction(c: *Column, x: usize, title: []const u8, caption: []const u8, arrows: bool, swap: bool, start: usize) !void {
    while (c.rows.items.len < start + 4) try c.space();
    c.rows.items[start].add(x + 2, title, .bright);
    c.rows.items[start + 1].add(x + 2, caption, .dim);
    c.rows.items[start + 2].command(x + 6, if (arrows) "[↑]" else if (swap) "[K]" else "[k]", .mint, if (swap) 'K' else 'k');
    c.rows.items[start + 3].command(x + 2, if (arrows) "[←]" else if (swap) "[H]" else "[h]", .mint, if (swap) 'H' else 'h');
    c.rows.items[start + 3].command(x + 6, if (arrows) "[↓]" else if (swap) "[J]" else "[j]", .mint, if (swap) 'J' else 'j');
    c.rows.items[start + 3].command(x + 10, if (arrows) "[→]" else if (swap) "[L]" else "[l]", .mint, if (swap) 'L' else 'l');
}
fn panes(c: *Column) !void {
    try c.heading("PANES");
    const swap = c.preset != .tmux;
    const arrows = c.preset == .tmux or c.preset == .cmux;
    const caption = if (c.preset == .cmux) "Cmd+Option" else "Move focus";
    const top = c.rows.items.len;
    try direction(c, 0, "Focus", caption, arrows, false, top);
    if (swap) try direction(c, if (c.width >= 30) (c.width + 2) / 2 else 0, "Swap", if (c.preset == .cmux) "P + key" else "Move pane", false, true, if (c.width >= 30) top else c.rows.items.len);
    if (c.preset == .cmux) try c.binding("Also focus", "P h j k l", 2, false);
    try c.action("Next pane", km.cycle_next, 2);
    if (c.preset == .herdr) {
        const start = c.rows.items.len;
        try c.binding("Previous pane", "Shift+Tab", 2, false);
        c.mark(start, km.cycle_prev);
    }
    try c.space();
    try c.group("Split");
    if (c.width >= 30 and c.preset != .cmux) {
        const right = (c.width + 2) / 2;
        for ([_][]const u8{ "┌──┬──┐", "│  │  │", "└──┴──┘" }, [_][]const u8{ "┌─────┐", "├─────┤", "└─────┘" }) |left, down| {
            var row: Row = .{};
            row.command(2, left, .dim, 'v');
            row.command(right + 2, down, .dim, '-');
            try c.rows.append(a, row);
        }
        var row: Row = .{};
        row.command(2, if (c.preset == .tmux) "%" else "v", .mint, 'v');
        row.command(5, "Right", .text, 'v');
        row.command(right + 2, if (c.preset == .tmux) "\"" else "-", .mint, '-');
        row.command(right + 5, "Down", .text, '-');
        try c.rows.append(a, row);
    } else try c.pair("Right / down", 'v', '-', 4);
    try c.group("Arrange");
    try c.action("Resize", 'r', 4);
    if (c.preset == .tmux) try c.binding("Resize", "Ctrl+arrows", 4, false);
    if (c.preset == .cmux) try c.binding("Resize directly", "Ctrl+Shift+HJKL", 4, false);
    try c.action("Zoom / unzoom", 'z', 4);
    try c.action("Move to new tab", '!', 4);
    try c.group("Close & recover");
    try c.pair("Close / reopen", 'x', 'u', 4);
    try c.space();
    try c.heading("TERMINAL");
    try c.action("Scroll / copy", 's', 2);
    try c.action("Paste copied text", km.paste, 2);
    if (c.preset == .cmux) try c.binding("Paste (host terminal)", "Cmd+V", 2, false);
    try c.action("Detach", 'q', 2);
    try c.space();
    try c.heading("CORGI");
    try c.action("Toggle sidebar", 'b', 2);
    try c.action("Setup", 'i', 2);
}

pub fn bounds(cols: u16, rows: u16) Rect {
    const width = @min(cols, 112);
    const height = @min(rows, 36);
    return .{ .x = (cols - width) / 2, .y = (rows - height) / 2, .w = width, .h = height };
}
fn eq(a_: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a_, b);
}
fn color(style: Style) []const u8 {
    return switch (style) {
        .text => "\x1b[0;38;2;201;208;215;48;2;35;40;47m",
        .bright => "\x1b[1;38;2;226;230;233;48;2;35;40;47m",
        .mint => "\x1b[1;38;2;161;194;178;48;2;35;40;47m",
        .dim => "\x1b[0;38;2;112;124;135;48;2;35;40;47m",
        .direct => "\x1b[0;38;2;219;194;152;48;2;35;40;47m",
        .keycap => "\x1b[1;38;2;24;27;32;48;2;161;194;178m",
    };
}
fn clippedAt(w: *std.Io.Writer, b: Rect, x: usize, y: usize, room: usize, value: []const u8, style: Style) !void {
    if (x >= b.w or y >= b.h) return;
    try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + x + 1, color(style) });
    try sidebar.writeEllipsis(w, value, @min(room, b.w - x));
}
fn at(w: *std.Io.Writer, b: Rect, x: usize, y: usize, value: []const u8, style: Style) !void {
    try clippedAt(w, b, x, y, b.w -| (x + 1), value, style);
}
fn box(w: *std.Io.Writer, b: Rect) !void {
    for (0..b.h) |y| {
        try w.print("\x1b[{d};{d}H{s}{s}", .{ b.y + y + 1, b.x + 1, color(.dim), if (y == 0) "╭" else if (y + 1 == b.h) "╰" else "│" });
        if (y == 0 or y + 1 == b.h) {
            for (0..b.w - 2) |_| try w.writeAll("─");
        } else try w.splatByteAll(' ', b.w - 2);
        try w.writeAll(if (y == 0) "╮" else if (y + 1 == b.h) "╯" else "│");
    }
}
