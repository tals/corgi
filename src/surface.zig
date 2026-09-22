const std = @import("std");
const terminal = @import("terminal.zig");
const vt = terminal.vt;

pub const Surface = struct {
    pane: u32,
    cols: u16,
    rows: u16,
    lines: []const []const u8,
    cursor: ?struct { x: u16, y: u16 },
};

/// Each line starts with its own style and ends with SGR reset. Coordinates,
/// cursor visibility, and all surrounding UI belong to the consuming viewer.
pub fn capture(allocator: std.mem.Allocator, id: u32, t: *terminal.Terminal) !Surface {
    try t.updateRender();
    const state = &t.render;
    const lines = try allocator.alloc([]const u8, state.rows);
    var used: usize = 0;
    errdefer {
        for (lines[0..used]) |line| allocator.free(line);
        allocator.free(lines);
    }
    for (lines, 0..) |*line, row| {
        var out: std.Io.Writer.Allocating = .init(allocator);
        defer out.deinit();
        try writeRow(&out.writer, state, t.hyperlinks(), id, row, state.cols, false);
        line.* = try out.toOwnedSlice();
        used += 1;
    }
    return .{
        .pane = id,
        .cols = state.cols,
        .rows = state.rows,
        .lines = lines,
        .cursor = if (state.cursor.visible) if (state.cursor.viewport) |pos| .{ .x = pos.x, .y = pos.y } else null else null,
    };
}

pub fn writeRow(w: *std.Io.Writer, state: *const vt.RenderState, links: []const @import("hyperlinks.zig").Link, pane: u32, row: usize, cols: u16, dimmed: bool) !void {
    return writeRowHovered(w, state, links, pane, row, cols, dimmed, null);
}

pub fn writeRowHovered(w: *std.Io.Writer, state: *const vt.RenderState, links: []const @import("hyperlinks.zig").Link, pane: u32, row: usize, cols: u16, dimmed: bool, hovered: ?u64) !void {
    const cells = state.row_data.items(.cells)[row];
    var active_link: ?u64 = null;
    var link_index: usize = 0;
    while (link_index < links.len and links[link_index].row < row) link_index += 1;
    var last_style: ?vt.Style = null;
    var last_fg: ?vt.color.RGB = null;
    var last_bg: ?vt.color.RGB = null;
    for (cells.items(.raw), 0..) |cell, col| {
        if (col >= cols) break;
        if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
        var style: terminal.vt.Style = if (cell.style_id == 0) .{} else cells.items(.style)[col];
        while (link_index < links.len and links[link_index].row == row and links[link_index].end <= col) link_index += 1;
        const link: ?@import("hyperlinks.zig").Link = if (!style.flags.invisible and link_index < links.len and links[link_index].row == row and links[link_index].start <= col and col < links[link_index].end) links[link_index] else null;
        const link_id: ?u64 = if (link) |value| value.id else null;
        if (hovered != null and link_id == hovered) style.flags.underline = .single;
        if (active_link != link_id) {
            if (active_link != null) try w.writeAll("\x1b]8;;\x1b\\");
            if (link) |value| try w.print("\x1b]8;id=corgi-{d}-{x};{s}\x1b\\", .{ pane, value.id, value.uri });
            active_link = link_id;
        }
        var fg = style.fg(.{ .default = state.colors.foreground, .palette = &state.colors.palette });
        var bg = style.bg(&cell, &state.colors.palette) orelse state.colors.background;
        if (dimmed) {
            fg = dim(fg);
            bg = dim(bg);
        }
        const selected = if (state.row_data.items(.selection)[row]) |range| col >= range[0] and col <= range[1] else false;
        if (style.flags.inverse != selected) std.mem.swap(terminal.vt.color.RGB, &fg, &bg);
        if (last_style == null or !last_style.?.eql(style) or !std.meta.eql(last_fg.?, fg) or !std.meta.eql(last_bg.?, bg)) {
            try w.print("\x1b[0;38;2;{d};{d};{d};48;2;{d};{d};{d}m", .{ fg.r, fg.g, fg.b, bg.r, bg.g, bg.b });
            if (style.flags.bold) try w.writeAll("\x1b[1m");
            if (style.flags.faint) try w.writeAll("\x1b[2m");
            if (style.flags.italic) try w.writeAll("\x1b[3m");
            if (style.flags.underline != .none) try w.writeAll("\x1b[4m");
            if (style.flags.strikethrough) try w.writeAll("\x1b[9m");
            last_style = style;
            last_fg = fg;
            last_bg = bg;
        }
        const cp = cell.codepoint();
        var bytes: [4]u8 = undefined;
        const len = try std.unicode.utf8Encode(if (cp == 0 or style.flags.invisible) ' ' else cp, &bytes);
        try w.writeAll(bytes[0..len]);
        if (cell.content_tag == .codepoint_grapheme and !style.flags.invisible) for (cells.items(.grapheme)[col]) |extra| {
            const n = try std.unicode.utf8Encode(extra, &bytes);
            try w.writeAll(bytes[0..n]);
        };
    }
    if (active_link != null) try w.writeAll("\x1b]8;;\x1b\\");
    try w.writeAll("\x1b[0m");
}

fn dim(color: vt.color.RGB) vt.color.RGB {
    return .{ .r = color.r / 2, .g = color.g / 2, .b = color.b / 2 };
}

pub const Modes = struct {
    bracketed_paste: bool,
    cursor_keys: bool,
    keypad_keys: bool,
    backarrow: bool,
    numlock: bool,
    alt_escape: bool,
    modify_other: bool,
    kitty: u5,
    mouse_event: @FieldType(vt.input.MouseEncodeOptions, "event"),
    mouse_format: @FieldType(vt.input.MouseEncodeOptions, "format"),
};
pub const View = struct { surface: Surface, bottom: usize, offset: usize, modes: Modes };

/// Borrow a viewport for a synchronous capture; never change another viewer's
/// scroll or selection. A pending synchronized redraw keeps its completed frame.
pub fn captureView(allocator: std.mem.Allocator, id: u32, t: *terminal.Terminal, offset: ?usize) !View {
    const screen = t.vt.screens.active;
    const pages = &screen.pages;
    const bottom = pages.total_rows -| t.vt.rows;
    const old_viewport = pages.viewport;
    const old_pin = pages.viewport_pin.*;
    const old_offset = pages.viewport_pin_row_offset;
    const old_selection = screen.selection;
    const synchronized = t.vt.modes.get(.synchronized_output);
    defer if (!synchronized) {
        pages.viewport = old_viewport;
        pages.viewport_pin.* = old_pin;
        pages.viewport_pin_row_offset = old_offset;
        screen.selection = old_selection;
        t.vt.flags.dirty.clear = true;
        t.updateRender() catch {};
    };
    if (!synchronized) {
        screen.selection = null;
        if (offset) |row| t.vt.scrollViewport(.{ .row = row }) else t.vt.scrollViewport(.bottom);
        t.vt.flags.dirty.clear = true;
    }
    return .{
        .surface = try capture(allocator, id, t),
        .bottom = bottom,
        .offset = @min(offset orelse bottom, bottom),
        .modes = .{
            .bracketed_paste = t.vt.modes.get(.bracketed_paste),
            .cursor_keys = t.vt.modes.get(.cursor_keys),
            .keypad_keys = t.vt.modes.get(.keypad_keys),
            .backarrow = t.vt.modes.get(.backarrow_key_mode),
            .numlock = t.vt.modes.get(.ignore_keypad_with_numlock),
            .alt_escape = t.vt.modes.get(.alt_esc_prefix),
            .modify_other = t.vt.flags.modify_other_keys_2,
            .kitty = t.vt.screens.active.kitty_keyboard.current().int(),
            .mouse_event = t.vt.flags.mouse_event,
            .mouse_format = t.vt.flags.mouse_format,
        },
    };
}

test "named hyperlinks survive capture and a second terminal render without leaking" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(32, 3);
    defer t.destroy();
    t.feed("\x1b]8;id=docs;https://example.com/docs\x1b\\\x1b[4mDocs 界\x1b]8;;\x1b\\\x1b[0m plain");
    const captured = try capture(arena.allocator(), 7, t);
    try std.testing.expect(std.mem.indexOf(u8, captured.lines[0], ";https://example.com/docs\x1b\\") != null);
    const mirror = try terminal.Terminal.create(32, 3);
    defer mirror.destroy();
    mirror.feed(captured.lines[0]);
    const again = try capture(arena.allocator(), 7, mirror);
    const host = try terminal.Terminal.create(32, 3);
    defer host.destroy();
    host.feed(again.lines[0]);
    try host.updateRender();
    try std.testing.expectEqual(@as(usize, 1), host.hyperlinks().len);
    const link = host.hyperlinks()[0];
    try std.testing.expectEqualStrings("https://example.com/docs", link.uri);
    try std.testing.expectEqual(@as(usize, 0), link.start);
    try std.testing.expectEqual(@as(usize, 7), link.end);
    // A redraw of the same source retains the same emitted identity.
    const repeated = try capture(arena.allocator(), 7, t);
    try std.testing.expectEqualStrings(captured.lines[0], repeated.lines[0]);
}

test "hyperlinks retain completed frame during synchronized output and disappear on overwrite" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 2);
    defer t.destroy();
    t.feed("\x1b]8;;https://example.com/old\x1b\\OLD\x1b]8;;\x1b\\");
    const before = try capture(arena.allocator(), 1, t);
    t.feed("\x1b[?2026h\x1b[2J\x1b[HNEW");
    const during = try capture(arena.allocator(), 1, t);
    try std.testing.expectEqualStrings(before.lines[0], during.lines[0]);
    t.feed("\x1b[?2026l");
    const after = try capture(arena.allocator(), 1, t);
    try std.testing.expect(std.mem.indexOf(u8, after.lines[0], "\x1b]8;") == null);
}

test "plain web links map Unicode cells, trim punctuation and preserve explicit targets" {
    const t = try terminal.Terminal.create(100, 4);
    defer t.destroy();
    t.feed("界e\xcc\x81 (https://example.com/a_(b)). plain\r\n" ++
        "\x1b]8;;https://explicit.example/\x1b\\https://printed.example/\x1b]8;;\x1b\\" ++
        " \x1b[8mhttps://hidden.example/\x1b[0m");
    try t.updateRender();
    try std.testing.expectEqual(@as(usize, 2), t.hyperlinks().len);
    try std.testing.expectEqualStrings("https://example.com/a_(b)", t.hyperlinks()[0].uri);
    try std.testing.expectEqual(@as(usize, 5), t.hyperlinks()[0].start);
    try std.testing.expectEqual(@as(usize, 30), t.hyperlinks()[0].end);
    try std.testing.expectEqualStrings("https://explicit.example/", t.hyperlinks()[1].uri);
}

test "plain links span soft wraps but not hard newlines and remain snapshot owned" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 5);
    defer t.destroy();
    const url = "https://example.com/a-long-path";
    t.feed(url ++ " ");
    const before = try capture(arena.allocator(), 9, t);
    try std.testing.expectEqual(@as(usize, 2), t.hyperlinks().len);
    for (t.hyperlinks()) |link| try std.testing.expectEqualStrings(url, link.uri);
    for (before.lines[0..2]) |line| try std.testing.expect(std.mem.indexOf(u8, line, ";" ++ url ++ "\x1b\\") != null);
    t.feed("\x1b[?2026h\x1b[2J\x1b[Hhttps://new.example/");
    const during = try capture(arena.allocator(), 9, t);
    try std.testing.expectEqualStrings(before.lines[0], during.lines[0]);
    t.feed("\x1b[?2026l\x1b[2J\x1b[Hhttp://\r\nexample.com");
    _ = try capture(arena.allocator(), 9, t);
    try std.testing.expectEqual(@as(usize, 0), t.hyperlinks().len);
}
