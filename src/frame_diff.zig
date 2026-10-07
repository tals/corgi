//! The host terminal's screen as the viewer last left it. A frame that changes
//! only cells is written as the spans that differ, so a busy pane costs a few
//! rows instead of the whole screen. Anything else a frame says (images,
//! pointer shape, mouse modes, a full clear) sends the whole frame again.
const std = @import("std");
const vt = @import("ghostty-vt");
const os = @import("os.zig");
const a = os.allocator;

pub const Differ = struct {
    vt: vt.Terminal,
    stream: vt.TerminalStream,
    render: vt.RenderState = .empty,
    cols: u16,
    rows: u16,
    /// One hash per cell, as the host shows it.
    cells: []u64,
    next: []u64,
    /// The frame's non-cell sequences, which must match to send only cells.
    controls: u64 = 0,
    cursor: Cursor = .{},
    /// The host shows something else: the next frame goes whole.
    stale: bool = true,

    const Cursor = struct { x: u16 = 0, y: u16 = 0, visible: bool = false };

    pub fn create(cols: u16, rows: u16) !*Differ {
        const d = try a.create(Differ);
        errdefer a.destroy(d);
        const count = @as(usize, cols) * rows;
        const cells = try a.alloc(u64, count);
        errdefer a.free(cells);
        const next = try a.alloc(u64, count);
        errdefer a.free(next);
        d.* = .{
            .vt = try vt.Terminal.init(os.io(), a, .{ .cols = cols, .rows = rows, .max_scrollback_bytes = 0 }),
            .stream = undefined,
            .cols = cols,
            .rows = rows,
            .cells = cells,
            .next = next,
        };
        d.stream = .init(.{ .handler = d.vt.vtHandler(), .allocator = a });
        return d;
    }
    pub fn destroy(d: *Differ) void {
        d.stream.deinit();
        d.render.deinit(a);
        d.vt.deinit(a);
        a.free(d.cells);
        a.free(d.next);
        a.destroy(d);
    }

    /// What to write so the host shows `frame`, which starts from a clear
    /// screen. Empty when the host already shows it.
    pub fn diff(d: *Differ, out: *std.Io.Writer, frame: []const u8) !void {
        var hasher = std.hash.Wyhash.init(0);
        var start: usize = 0;
        var i: usize = 0;
        while (std.mem.indexOfScalarPos(u8, frame, i, 0x1b)) |at| {
            const sequence = scan(frame[at..]);
            i = at + sequence.len;
            if (sequence.kind == .cells) continue;
            d.stream.nextSlice(frame[start..at]);
            hasher.update(frame[at..i]);
            // Images are placed at the cursor; nothing else depends on it.
            if (sequence.kind == .image) {
                const cursor = d.vt.screens.active.cursor;
                hasher.update(std.mem.asBytes(&[2]u16{ @intCast(cursor.x), @intCast(cursor.y) }));
            } else d.stream.nextSlice(frame[at..i]);
            start = i;
        }
        d.stream.nextSlice(frame[start..]);
        const controls = hasher.final();
        try d.render.update(a, &d.vt);
        d.hashCells(d.next);
        const screen = d.vt.screens.active;
        const cursor: Cursor = .{ .x = @intCast(screen.cursor.x), .y = @intCast(screen.cursor.y), .visible = d.vt.modes.get(.cursor_visible) };
        defer {
            std.mem.swap([]u64, &d.cells, &d.next);
            d.controls = controls;
            d.cursor = cursor;
            d.stale = false;
        }
        if (d.stale or controls != d.controls) return out.writeAll(frame);
        const changed = !std.mem.eql(u64, d.cells, d.next);
        if (!changed and std.meta.eql(cursor, d.cursor)) return;
        try out.writeAll("\x1b[?2026h\x1b[?25l");
        if (changed) for (0..d.rows) |row| {
            const line = row * d.cols;
            const old = d.cells[line..][0..d.cols];
            const new = d.next[line..][0..d.cols];
            const first = std.mem.indexOfDiff(u64, old, new) orelse continue;
            var last: usize = d.cols - 1;
            while (old[last] == new[last]) last -= 1;
            try d.writeSpan(out, row, first, last);
        };
        try out.print("\x1b[{d};{d}H", .{ cursor.y + 1, cursor.x + 1 });
        if (cursor.visible) try out.writeAll("\x1b[?25h");
        try out.writeAll("\x1b[?2026l");
    }

    fn hashCells(d: *Differ, into: []u64) void {
        @memset(into, 0);
        const pins = d.render.row_data.items(.pin);
        for (d.render.row_data.items(.cells)[0..@min(d.rows, d.render.rows)], 0..) |cells, row| {
            const raw = cells.items(.raw);
            for (raw[0..@min(d.cols, raw.len)], 0..) |cell, col| {
                var h = std.hash.Wyhash.init(0);
                var content = cell;
                content.style_id = 0;
                content.hyperlink = false;
                content.semantic_content = .output;
                h.update(std.mem.asBytes(&@as(u64, @bitCast(content))));
                if (cell.style_id != 0) hashStyle(&h, cells.items(.style)[col]);
                if (cell.content_tag == .codepoint_grapheme) h.update(std.mem.sliceAsBytes(cells.items(.grapheme)[col]));
                if (cell.hyperlink) if (link(pins[row], col)) |target| {
                    h.update(target.uri);
                    h.update(target.id orelse "");
                };
                into[row * d.cols + col] = h.final();
            }
        }
    }

    fn writeSpan(d: *Differ, out: *std.Io.Writer, row: usize, from: usize, to: usize) !void {
        const cells = d.render.row_data.items(.cells)[row];
        const pin = d.render.row_data.items(.pin)[row];
        const raw = cells.items(.raw);
        var first = from;
        while (first > 0 and raw[first].wide == .spacer_tail) first -= 1;
        const last = if (raw[to].wide == .wide and to + 1 < raw.len) to + 1 else to;
        try out.print("\x1b[{d};{d}H", .{ row + 1, first + 1 });
        var style: ?vt.Style = null;
        var open: ?Link = null;
        for (first..last + 1) |col| {
            const cell = raw[col];
            if (cell.wide == .spacer_tail) continue;
            const current: vt.Style = switch (cell.content_tag) {
                .bg_color_palette => .{ .bg_color = .{ .palette = cell.content.color_palette.data } },
                .bg_color_rgb => .{ .bg_color = .{ .rgb = .{ .r = cell.content.color_rgb.r, .g = cell.content.color_rgb.g, .b = cell.content.color_rgb.b } } },
                else => if (cell.style_id == 0) .{} else cells.items(.style)[col],
            };
            const target = if (cell.hyperlink) link(pin, col) else null;
            if (!sameLink(open, target)) {
                if (open != null) try out.writeAll("\x1b]8;;\x1b\\");
                if (target) |t| try out.print("\x1b]8;{s}{s};{s}\x1b\\", .{ if (t.id != null) "id=" else "", t.id orelse "", t.uri });
                open = target;
            }
            if (style == null or !style.?.eql(current)) {
                try out.print("{f}", .{current.formatterVt()});
                style = current;
            }
            const text = cell.codepoint();
            if (cell.wide == .spacer_head or text == 0 or cell.content_tag == .bg_color_palette or cell.content_tag == .bg_color_rgb) {
                try out.writeByte(' ');
                continue;
            }
            try writeCodepoint(out, text);
            if (cell.content_tag == .codepoint_grapheme) for (cells.items(.grapheme)[col]) |extra| try writeCodepoint(out, extra);
        }
        if (open != null) try out.writeAll("\x1b]8;;\x1b\\");
        try out.writeAll("\x1b[0m");
    }
};

const Link = struct { uri: []const u8, id: ?[]const u8 };
fn link(pin: vt.Pin, col: usize) ?Link {
    const page = pin.node.page();
    const cell = page.getRowAndCell(@intCast(col), pin.y).cell;
    const id = page.lookupHyperlink(cell) orelse return null;
    const entry = page.hyperlink_set.get(page.memory, id);
    return .{
        .uri = entry.uri.slice(page.memory),
        .id = switch (entry.id) {
            .explicit => |value| value.slice(page.memory),
            .implicit => null,
        },
    };
}
fn sameLink(lhs: ?Link, rhs: ?Link) bool {
    const l = lhs orelse return rhs == null;
    const r = rhs orelse return false;
    return std.mem.eql(u8, l.uri, r.uri) and std.mem.eql(u8, l.id orelse "", r.id orelse "") and (l.id == null) == (r.id == null);
}
fn hashStyle(h: *std.hash.Wyhash, style: vt.Style) void {
    for ([_]vt.Style.Color{ style.fg_color, style.bg_color, style.underline_color }) |color| switch (color) {
        .none => h.update(&.{0}),
        .palette => |index| h.update(&.{ 1, index }),
        .rgb => |rgb| h.update(&.{ 2, rgb.r, rgb.g, rgb.b }),
    };
    h.update(std.mem.asBytes(&@as(u16, @bitCast(style.flags))));
}
fn writeCodepoint(out: *std.Io.Writer, cp: u21) !void {
    var bytes: [4]u8 = undefined;
    const n = std.unicode.utf8Encode(cp, &bytes) catch return out.writeByte(' ');
    try out.writeAll(bytes[0..n]);
}

const Sequence = struct {
    len: usize,
    kind: enum { cells, image, control },
};
/// Sorts the escape sequence at the start of `bytes`. Cells are what the
/// mirror can redraw: text, styles, links, cursor moves and erases within
/// the screen. Everything else is a control.
fn scan(bytes: []const u8) Sequence {
    if (bytes.len < 2) return .{ .len = bytes.len, .kind = .cells };
    switch (bytes[1]) {
        '_' => {
            const end = std.mem.indexOfPos(u8, bytes, 2, "\x1b\\") orelse return .{ .len = bytes.len, .kind = .image };
            return .{ .len = end + 2, .kind = .image };
        },
        ']' => {
            var end: usize = 2;
            const len = while (end < bytes.len) : (end += 1) {
                if (bytes[end] == 0x07) break end + 1;
                if (bytes[end] == 0x1b and end + 1 < bytes.len and bytes[end + 1] == '\\') break end + 2;
            } else bytes.len;
            return .{ .len = len, .kind = if (std.mem.startsWith(u8, bytes[2..], "8;")) .cells else .control };
        },
        '[' => {
            var end: usize = 2;
            while (end < bytes.len and (bytes[end] < 0x40 or bytes[end] > 0x7e)) end += 1;
            if (end == bytes.len) return .{ .len = bytes.len, .kind = .cells };
            const params = bytes[2..end];
            const kind: @FieldType(Sequence, "kind") = switch (bytes[end]) {
                // Cursor visibility is the cursor's; the frame's own
                // synchronized update is replaced by the diff's.
                'h', 'l' => if (std.mem.eql(u8, params, "?25") or std.mem.eql(u8, params, "?2026")) .cells else .control,
                // A full clear also drops the host's images.
                'J' => if (std.mem.eql(u8, params, "2") or std.mem.eql(u8, params, "3")) .control else .cells,
                'q' => .control,
                else => .cells,
            };
            return .{ .len = end + 1, .kind = kind };
        },
        'c' => return .{ .len = 2, .kind = .control },
        else => return .{ .len = 2, .kind = .cells },
    }
}

fn render(d: *Differ, frame: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    errdefer out.deinit();
    try d.diff(&out.writer, frame);
    return out.toOwnedSlice();
}

test "a frame that changes one cell writes that cell" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const first = "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mworld\x1b[0m\x1b[?2026l";
    const whole = try render(d, first);
    defer std.testing.allocator.free(whole);
    try std.testing.expectEqualStrings(first, whole);
    const same = try render(d, first);
    defer std.testing.allocator.free(same);
    try std.testing.expectEqualStrings("", same);
    const changed = try render(d, "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mwOrld\x1b[0m\x1b[?2026l");
    defer std.testing.allocator.free(changed);
    try std.testing.expectEqualStrings("\x1b[?2026h\x1b[?25l\x1b[2;2H\x1b[0m\x1b[38;5;1mO\x1b[0m\x1b[2;6H\x1b[?25h\x1b[?2026l", changed);
}

test "a changed control sends the whole frame" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const frames = [_][]const u8{
        "\x1b[H\x1b[Jtext\x1b]22;default\x1b\\",
        "\x1b[H\x1b[Jtext\x1b]22;pointer\x1b\\",
        "\x1b[H\x1b[J\x1b[2;3H\x1b_Ga=p,i=1\x1b\\text",
        "\x1b[H\x1b[J\x1b[3;3H\x1b_Ga=p,i=1\x1b\\text",
    };
    for (frames) |frame| {
        const out = try render(d, frame);
        defer std.testing.allocator.free(out);
        try std.testing.expectEqualStrings(frame, out);
    }
}

test "a moved cursor is written without cells" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const first = try render(d, "\x1b[H\x1b[J$ \x1b[1;3H\x1b[?25h");
    defer std.testing.allocator.free(first);
    const moved = try render(d, "\x1b[H\x1b[J$ \x1b[2;5H\x1b[?25h");
    defer std.testing.allocator.free(moved);
    try std.testing.expectEqualStrings("\x1b[?2026h\x1b[?25l\x1b[2;5H\x1b[?25h\x1b[?2026l", moved);
}

test "wide characters and links are rewritten whole" {
    const d = try Differ.create(20, 2);
    defer d.destroy();
    const first = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://a.example\x1b\\ab\x1b]8;;\x1b\\界c");
    defer std.testing.allocator.free(first);
    const changed = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界d");
    defer std.testing.allocator.free(changed);
    try std.testing.expect(std.mem.indexOf(u8, changed, "\x1b]8;id=x;https://b.example\x1b\\") != null);
    try std.testing.expect(std.mem.indexOf(u8, changed, "界d") != null);
    const tail = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界e");
    defer std.testing.allocator.free(tail);
    try std.testing.expect(std.mem.indexOf(u8, tail, "\x1b[1;5H") != null);
    try std.testing.expect(std.mem.indexOf(u8, tail, "界") == null);
}
