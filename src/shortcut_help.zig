//! Shared, viewer-owned shortcut screen for onboarding and the prefix menu.
//! Layout produces cell rows before clipping, so both columns share one scroll.
const std = @import("std");
const BoundedText = @import("bounded_text.zig").BoundedText;
const a = @import("os.zig").allocator;
const keys = @import("keys.zig");
const km = @import("keymap.zig");
const bindings = @import("bindings.zig");
const sidebar = @import("sidebar.zig");
const Action = @import("action.zig").Action;
const Rect = @import("layout.zig").Rect;

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
        switch (keys.parse(seq) orelse return) {
            .up => s.move(false, 1),
            .down => s.move(true, 1),
            .page_up => s.move(false, s.page_rows),
            .page_down => s.move(true, s.page_rows),
            .home => s.scroll = 0,
            .end => s.scroll = s.max_scroll,
            else => {},
        }
    }
    pub fn closeAt(cols: u16, rows: u16, x: u16, y: u16) bool {
        const b = bounds(cols, rows);
        return !b.contains(x, y) or (y == b.y + (b.h -| 2) and x >= b.x + (b.w -| 16));
    }
    pub const Hit = union(enum) { none, close, action: Action };
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
        var keycap: [16]u8 = undefined;
        try at(w, b, 11, 3, try std.fmt.bufPrint(&keycap, "[ {s} ]", .{km.prefixName(prefix)}), .keycap);
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

const Style = enum { text, bright, mint, dim, direct, keycap, attention };
const Part = struct {
    x: u16,
    text: BoundedText(192),
    style: Style,
    action: ?Action = null,
    fn value(p: *const Part) []const u8 {
        return p.text.text();
    }
};
const Row = struct {
    parts: [8]Part = undefined,
    len: usize = 0,
    fn add(r: *Row, x: usize, value: []const u8, style: Style) void {
        std.debug.assert(r.len < r.parts.len and value.len <= @FieldType(Part, "text").capacity);
        r.parts[r.len] = .{ .x = @intCast(x), .text = .initTruncated(value), .style = style };
        r.len += 1;
    }
    fn command(r: *Row, x: usize, value: []const u8, style: Style, action: Action) void {
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
    fn action(c: *Column, label: []const u8, act: Action, indent: usize) !void {
        var buf: [128]u8 = undefined;
        if (try spelling(c.preset, act, &buf)) |key| {
            const start = c.rows.items.len;
            try c.binding(label, key, indent, false);
            c.mark(start, act);
        }
    }
    /// An action people open help to find: a dot, a bright label and a
    /// keycap. The keycap drops to its own row when the column is narrow.
    fn featured(c: *Column, label: []const u8, act: Action, indent: usize) !void {
        var buf: [128]u8 = undefined;
        const key = try spelling(c.preset, act, &buf) orelse return;
        var cap: [136]u8 = undefined;
        const keycap = try std.fmt.bufPrint(&cap, "[ {s} ]", .{key});
        const key_width = sidebar.displayWidth(keycap);
        const start = c.rows.items.len;
        try c.wrapped(label, indent + 2, .bright, false);
        c.rows.items[start].add(indent, "●", .attention);
        const last = c.rows.items[c.rows.items.len - 1].parts[0];
        if (last.x + sidebar.displayWidth(last.value()) + 3 + key_width > c.width) try c.space();
        c.rows.items[c.rows.items.len - 1].add(c.width -| key_width, keycap, .keycap);
        c.mark(start, act);
    }
    /// A held key for an action whose shown key follows the prefix.
    fn alsoHeld(c: *Column, label: []const u8, act: Action, indent: usize) !void {
        const shown = bindings.find(c.preset, act) orelse return;
        const held = bindings.first(c.preset, act, false) orelse return;
        if (!shown.prefixed) return;
        var buf: [64]u8 = undefined;
        const start = c.rows.items.len;
        try c.binding(label, try std.fmt.bufPrint(&buf, "{f}", .{held}), indent, true);
        c.mark(start, act);
    }
    fn mark(c: *Column, start: usize, act: Action) void {
        for (c.rows.items[start..]) |*row| for (row.parts[0..row.len]) |*part| {
            part.action = act;
        };
    }
    fn pair(c: *Column, label: []const u8, first: Action, second: Action, indent: usize) !void {
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

/// The keys shown for an action. cmux shows its held key, then the
/// prefixed one after "P".
fn spelling(preset: km.Preset, act: Action, buf: []u8) !?[]const u8 {
    const shown = bindings.find(preset, act) orelse return null;
    if (shown.prefixed) return try std.fmt.bufPrint(buf, "{s}{f}", .{ if (preset == .cmux) "P " else "", shown });
    const fallback = bindings.first(preset, act, true) orelse return try std.fmt.bufPrint(buf, "{f}", .{shown});
    return try std.fmt.bufPrint(buf, "{f} · P {f}", .{ shown, fallback });
}
fn navigation(c: *Column) !void {
    try c.heading("TABS");
    try c.action("New tab → agent picker", .new, 2);
    try c.alsoHeld("Also works directly", .new, 4);
    try c.pair("Next / previous", .next, .prev, 2);
    try c.binding("Select tab", if (c.preset == .tmux) "0–9" else if (c.preset == .cmux) "Ctrl+1–9 · P 1–9" else "1–9", 2, false);
    try c.action("Rename", .@"rename-tab", 2);
    try c.action("Close", .@"close-tab", 2);
    try c.space();
    try c.heading("WORKSPACES");
    try c.action("New", .@"new-workspace", 2);
    try c.action("Edit", .@"edit-workspace", 2);
    try c.pair("Next / previous", .@"workspace-next", .@"workspace-prev", 2);
    try c.action("Choose workspace", .@"choose-workspace", 2);
    if (c.preset == .herdr) try c.binding("Also choose workspace", "g", 4, false);
    if (c.preset == .cmux) try c.binding("Select workspace", "Cmd+1–9", 2, false);
    try c.action("Close workspace", .@"close-workspace", 2);
    try c.space();
    try c.heading("AGENTS");
    try c.featured("Jump to who needs you", .attention, 2);
    try c.alsoHeld("Also works directly", .attention, 4);
    try c.group("Navigate");
    try c.action("Find", .@"find-agent", 4);
    try c.pair("Next / previous", .@"next-agent", .@"prev-agent", 4);
    try c.action("Last visited", .@"last-agent", 4);
    try c.group("Manage");
    try c.action("New agent", .@"new-agent", 4);
    try c.action("Mute / unmute", .mute, 4);
}
/// Four keycaps, one per direction, from the preset's keys for `tag`.
fn direction(c: *Column, x: usize, title: []const u8, caption: []const u8, comptime tag: std.meta.Tag(Action), start: usize) !void {
    while (c.rows.items.len < start + 4) try c.space();
    c.rows.items[start].add(x + 2, title, .bright);
    c.rows.items[start + 1].add(x + 2, caption, .dim);
    const places = [_]struct { dir: @FieldType(Action, @tagName(tag)), row: usize, x: usize }{
        .{ .dir = .up, .row = 2, .x = 6 },
        .{ .dir = .left, .row = 3, .x = 2 },
        .{ .dir = .down, .row = 3, .x = 6 },
        .{ .dir = .right, .row = 3, .x = 10 },
    };
    for (places) |place| {
        const act = @unionInit(Action, @tagName(tag), place.dir);
        var key = bindings.find(c.preset, act) orelse continue;
        key.mods = .{};
        var buf: [16]u8 = undefined;
        c.rows.items[start + place.row].command(x + place.x, try std.fmt.bufPrint(&buf, "[{f}]", .{key}), .mint, act);
    }
}
fn panes(c: *Column) !void {
    try c.heading("PANES");
    const swap = bindings.find(c.preset, .{ .swap = .up }) != null;
    const caption = if (c.preset == .cmux) "Cmd+Option" else "Move focus";
    const top = c.rows.items.len;
    try direction(c, 0, "Focus", caption, .focus, top);
    if (swap) try direction(c, if (c.width >= 30) (c.width + 2) / 2 else 0, "Swap", if (c.preset == .cmux) "P + key" else "Move pane", .swap, if (c.width >= 30) top else c.rows.items.len);
    if (c.preset == .cmux) try c.binding("Also focus", "P h j k l", 2, false);
    try c.action("Next pane", .@"next-pane", 2);
    try c.action("Previous pane", .@"prev-pane", 2);
    try c.space();
    try c.group("Split");
    if (c.width >= 30 and c.preset != .cmux) {
        const right = (c.width + 2) / 2;
        for ([_][]const u8{ "┌──┬──┐", "│  │  │", "└──┴──┘" }, [_][]const u8{ "┌─────┐", "├─────┤", "└─────┘" }) |left, down| {
            var row: Row = .{};
            row.command(2, left, .dim, .{ .split = .right });
            row.command(right + 2, down, .dim, .{ .split = .down });
            try c.rows.append(a, row);
        }
        var right_key: [16]u8 = undefined;
        var down_key: [16]u8 = undefined;
        var row: Row = .{};
        row.command(2, try std.fmt.bufPrint(&right_key, "{f}", .{bindings.first(c.preset, .{ .split = .right }, true).?}), .mint, .{ .split = .right });
        row.command(5, "Right", .text, .{ .split = .right });
        row.command(right + 2, try std.fmt.bufPrint(&down_key, "{f}", .{bindings.first(c.preset, .{ .split = .down }, true).?}), .mint, .{ .split = .down });
        row.command(right + 5, "Down", .text, .{ .split = .down });
        try c.rows.append(a, row);
    } else try c.pair("Right / down", .{ .split = .right }, .{ .split = .down }, 4);
    try c.group("Arrange");
    try c.action("Resize", .@"resize-mode", 4);
    if (c.preset == .tmux) try c.binding("Resize", "Ctrl+arrows", 4, false);
    if (c.preset == .cmux) try c.binding("Resize directly", "Ctrl+Shift+HJKL", 4, false);
    try c.action("Zoom / unzoom", .zoom, 4);
    try c.action("Move to new tab", .@"break", 4);
    try c.group("Close & recover");
    try c.pair("Close / reopen", .close, .@"undo-close", 4);
    try c.space();
    try c.heading("TERMINAL");
    try c.action("Scroll / copy", .@"copy-mode", 2);
    try c.action("Paste copied text", .paste, 2);
    if (c.preset == .cmux) try c.binding("Paste (host terminal)", "Cmd+V", 2, false);
    try c.action("Detach", .detach, 2);
    try c.space();
    try c.heading("CORGI");
    try c.action("Toggle sidebar", .sidebar, 2);
    try c.action("Setup", .setup, 2);
}

pub fn bounds(cols: u16, rows: u16) Rect {
    const width = @min(cols, 112);
    const height = @min(rows, 36);
    return .{ .x = (cols - width) / 2, .y = (rows - height) / 2, .w = width, .h = height };
}
fn color(style: Style) []const u8 {
    return switch (style) {
        .text => "\x1b[0;38;2;201;208;215;48;2;35;40;47m",
        .bright => "\x1b[1;38;2;226;230;233;48;2;35;40;47m",
        .mint => "\x1b[1;38;2;161;194;178;48;2;35;40;47m",
        .dim => "\x1b[0;38;2;112;124;135;48;2;35;40;47m",
        .direct => "\x1b[0;38;2;219;194;152;48;2;35;40;47m",
        .keycap => "\x1b[1;38;2;24;27;32;48;2;161;194;178m",
        // The sidebar's unseen-completion dot.
        .attention => "\x1b[0;38;2;148;226;213;48;2;35;40;47m",
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

test "the help screen spells each preset's keys from its bindings" {
    const Case = struct { preset: km.Preset, action: Action, text: ?[]const u8 };
    for ([_]Case{
        .{ .preset = .corgi, .action = .new, .text = "c" },
        .{ .preset = .corgi, .action = .@"last-agent", .text = "Tab" },
        .{ .preset = .corgi, .action = .paste, .text = null },
        .{ .preset = .tmux, .action = .paste, .text = "]" },
        .{ .preset = .herdr, .action = .@"choose-workspace", .text = "w" },
        .{ .preset = .herdr, .action = .@"prev-pane", .text = "Shift+Tab" },
        .{ .preset = .cmux, .action = .new, .text = "Cmd+T · P c" },
        .{ .preset = .cmux, .action = .@"close-workspace", .text = "Cmd+Shift+W" },
        .{ .preset = .cmux, .action = .@"new-agent", .text = "P a" },
    }) |case| {
        var buf: [128]u8 = undefined;
        const text = try spelling(case.preset, case.action, &buf);
        if (case.text) |expected| try std.testing.expectEqualStrings(expected, text.?) else try std.testing.expectEqual(null, text);
    }
}

test "agents lead with the attention jump, its key a keycap that fits" {
    const Case = struct { preset: km.Preset, keycap: []const u8 };
    for ([_]Case{
        .{ .preset = .corgi, .keycap = "[ f ]" },
        .{ .preset = .tmux, .keycap = "[ F ]" },
        .{ .preset = .herdr, .keycap = "[ o ]" },
        .{ .preset = .cmux, .keycap = "[ Cmd+Shift+U · P f ]" },
    }) |case| for ([_]u16{ 47, 21 }) |width| {
        var column: Column = .{ .width = width, .preset = case.preset };
        defer column.rows.deinit(a);
        try navigation(&column);
        var found = false;
        for (column.rows.items) |*row| for (row.parts[0..row.len]) |*part| {
            try std.testing.expect(part.style != .keycap or part.action.? == .attention);
            if (part.style != .keycap) continue;
            try std.testing.expectEqualStrings(case.keycap, part.value());
            try std.testing.expect(part.x + sidebar.displayWidth(part.value()) <= width);
            found = true;
        };
        try std.testing.expect(found);
    };
}
