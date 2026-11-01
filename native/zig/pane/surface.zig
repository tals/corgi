const std = @import("std");
const terminal = @import("terminal.zig");
const vt = terminal.vt;
const hyperlink = @import("hyperlinks.zig");
const graphics = @import("graphics.zig");

/// The daemon's id for a pane, which link ids carry.
pub const PaneId = enum(u32) { _ };

pub const Surface = struct {
    pane: PaneId,
    cols: u16,
    rows: u16,
    lines: []const []const u8,
    cursor: ?struct { x: u16, y: u16 },
    images: []const graphics.Placement = &.{},
};

/// Each line starts with its own style and ends with SGR reset. Coordinates,
/// cursor visibility, and all surrounding UI belong to the consuming viewer.
pub fn capture(allocator: std.mem.Allocator, id: PaneId, t: *terminal.Terminal) !Surface {
    try t.updateRender();
    const state = &t.render;
    try t.surface_rows.prepare(@intFromEnum(id), state.cols, state.rows);
    const lines = try allocator.alloc([]const u8, state.rows);
    var used: usize = 0;
    errdefer {
        for (lines[0..used]) |line| allocator.free(line);
        allocator.free(lines);
    }
    for (lines, 0..) |*line, row| {
        const cached = &t.surface_rows.rows[row];
        if (!cached.valid) {
            cached.out.clearRetainingCapacity();
            try writeRow(&cached.out.writer, state, t.hyperlinks(), id, row, state.cols, false);
            cached.valid = true;
            t.surface_rows.formatted +%= 1;
        } else t.surface_rows.reused +%= 1;
        line.* = try allocator.dupe(u8, cached.out.written());
        used += 1;
    }
    return .{
        .pane = id,
        .cols = state.cols,
        .rows = state.rows,
        .lines = lines,
        .images = try allocator.dupe(graphics.Placement, t.graphics.placements.items),
        .cursor = if (state.cursor.visible) if (state.cursor.viewport) |pos| .{ .x = pos.x, .y = pos.y } else null else null,
    };
}

pub fn writeRow(w: *std.Io.Writer, state: *const vt.RenderState, links: []const hyperlink.Link, pane: PaneId, row: usize, cols: u16, dimmed: bool) !void {
    return writeRowHovered(w, state, links, pane, row, cols, dimmed, null);
}

pub fn writeRowHovered(w: *std.Io.Writer, state: *const vt.RenderState, links: []const hyperlink.Link, pane: PaneId, row: usize, cols: u16, dimmed: bool, hovered: ?u64) !void {
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
        const at_link = link_index < links.len and links[link_index].row == row and
            links[link_index].start <= col and col < links[link_index].end;
        const link: ?hyperlink.Link = if (!style.flags.invisible and at_link) links[link_index] else null;
        const link_id: ?u64 = if (link) |value| value.id else null;
        if (hovered != null and link_id == hovered) style.flags.underline = .single;
        if (active_link != link_id) {
            if (active_link != null) try w.writeAll("\x1b]8;;\x1b\\");
            if (link) |value| try w.print("\x1b]8;id=corgi-{d}-{x};{s}\x1b\\", .{ @intFromEnum(pane), value.id, value.uri });
            active_link = link_id;
        }
        var fg = style.fg(.{ .default = state.colors.foreground, .palette = &state.colors.palette });
        var bg = style.bg(&cell, &state.colors.palette) orelse state.colors.background;
        if (dimmed) {
            // A cell on a light background fades toward white, so light themes recede too.
            const light = isLight(bg);
            fg = dim(fg, light);
            bg = dim(bg, light);
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
        const blank = cp == 0 or cp == vt.kitty.graphics.unicode.placeholder or style.flags.invisible;
        var bytes: [4]u8 = undefined;
        const len = try std.unicode.utf8Encode(if (blank) ' ' else cp, &bytes);
        try w.writeAll(bytes[0..len]);
        if (cell.content_tag == .codepoint_grapheme and !blank) for (cells.items(.grapheme)[col]) |extra| {
            const n = try std.unicode.utf8Encode(extra, &bytes);
            try w.writeAll(bytes[0..n]);
        };
    }
    if (active_link != null) try w.writeAll("\x1b]8;;\x1b\\");
    try w.writeAll("\x1b[0m");
}

/// Fades a color halfway toward black, or toward white for a cell on a
/// light background.
fn dim(color: vt.color.RGB, light: bool) vt.color.RGB {
    const toward: u16 = if (light) 255 else 0;
    return .{
        .r = @intCast((@as(u16, color.r) + toward) / 2),
        .g = @intCast((@as(u16, color.g) + toward) / 2),
        .b = @intCast((@as(u16, color.b) + toward) / 2),
    };
}

fn isLight(color: vt.color.RGB) bool {
    return @as(u32, color.r) * 299 + @as(u32, color.g) * 587 + @as(u32, color.b) * 114 > 127_500;
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
    /// The program takes pastes as Kitty paste events (mode 5522).
    paste_events: bool = false,
};
/// A receipt for a particular terminal and requested viewport. It is independent
/// of Ghostty's dirty flags, which other render consumers are allowed to clear.
pub const Stamp = struct {
    identity: u64,
    revision: u64,
    offset: ?usize,

    // Native JSON keeps receipts exact without a JavaScript reviver per field.
    pub fn jsonStringify(value: Stamp, writer: *std.json.Stringify) !void {
        try writer.beginObject();
        try writer.objectField("identity");
        try writer.print("\"{d}\"", .{value.identity});
        try writer.objectField("revision");
        try writer.print("\"{d}\"", .{value.revision});
        try writer.objectField("offset");
        try writer.write(value.offset);
        try writer.endObject();
    }
};
pub fn stamp(t: *const terminal.Terminal, offset: ?usize) Stamp {
    return .{ .identity = t.surface_identity, .revision = t.surface_revision, .offset = offset };
}
pub const View = struct { surface: Surface, bottom: usize, offset: usize, modes: Modes, stamp: Stamp };

test "native surface receipts serialize exactly as decimal strings" {
    const allocator = std.testing.allocator;
    for ([_]u64{ 0, (1 << 53) - 1, 1 << 53, std.math.maxInt(u64) }) |number| {
        for ([_]?usize{ null, (1 << 53) - 1 }) |offset| {
            const bytes = try std.json.Stringify.valueAlloc(allocator, Stamp{
                .identity = number,
                .revision = number,
                .offset = offset,
            }, .{});
            defer allocator.free(bytes);
            const parsed = try std.json.parseFromSlice(struct {
                identity: []const u8,
                revision: []const u8,
                offset: ?usize,
            }, allocator, bytes, .{});
            defer parsed.deinit();
            try std.testing.expectEqual(number, try std.fmt.parseInt(u64, parsed.value.identity, 10));
            try std.testing.expectEqual(number, try std.fmt.parseInt(u64, parsed.value.revision, 10));
            try std.testing.expectEqual(offset, parsed.value.offset);
        }
    }
}

/// Borrow a viewport for a synchronous capture; never change another viewer's
/// scroll or selection. A pending synchronized redraw keeps its completed frame.
pub fn captureView(allocator: std.mem.Allocator, id: PaneId, t: *terminal.Terminal, offset: ?usize) !View {
    const screen = t.vt.screens.active;
    const pages = &screen.pages;
    const bottom = pages.total_rows -| t.vt.rows;
    const saved = t.borrowViewport();
    const synchronized = t.vt.modes.get(.synchronized_output);
    const borrowed = !synchronized and (offset != null or pages.viewport != .active or saved.selection != null);
    defer if (borrowed) saved.restore();
    if (borrowed) {
        screen.selection = null;
        if (offset) |row| t.vt.scrollViewport(.{ .row = row }) else t.vt.scrollViewport(.bottom);
        t.vt.flags.dirty.clear = true;
    }
    return .{
        .surface = try capture(allocator, id, t),
        .stamp = stamp(t, offset),
        .bottom = bottom,
        .offset = @min(offset orelse bottom, bottom),
        .modes = modes(t),
    };
}
/// How a viewer encodes input for the program in `t`.
pub fn modes(t: *const terminal.Terminal) Modes {
    return .{
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
        .paste_events = t.vt.modes.get(.kitty_paste_events),
    };
}

test "named hyperlinks survive capture and a second terminal render without leaking" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(32, 3);
    defer t.destroy();
    t.feed("\x1b]8;id=docs;https://example.com/docs\x1b\\\x1b[4mDocs 界\x1b]8;;\x1b\\\x1b[0m plain");
    const captured = try capture(arena.allocator(), @enumFromInt(7), t);
    try std.testing.expect(std.mem.indexOf(u8, captured.lines[0], ";https://example.com/docs\x1b\\") != null);
    const mirror = try terminal.Terminal.create(32, 3);
    defer mirror.destroy();
    mirror.feed(captured.lines[0]);
    const again = try capture(arena.allocator(), @enumFromInt(7), mirror);
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
    const repeated = try capture(arena.allocator(), @enumFromInt(7), t);
    try std.testing.expectEqualStrings(captured.lines[0], repeated.lines[0]);
}

test "hyperlinks retain completed frame during synchronized output and disappear on overwrite" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 2);
    defer t.destroy();
    t.feed("\x1b]8;;https://example.com/old\x1b\\OLD\x1b]8;;\x1b\\");
    const before = try capture(arena.allocator(), @enumFromInt(1), t);
    t.feed("\x1b[?2026h\x1b[2J\x1b[HNEW");
    const during = try capture(arena.allocator(), @enumFromInt(1), t);
    try std.testing.expectEqualStrings(before.lines[0], during.lines[0]);
    t.feed("\x1b[?2026l");
    const after = try capture(arena.allocator(), @enumFromInt(1), t);
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

test "plain image paths survive link prefiltering without web links" {
    const t = try terminal.Terminal.create(40, 2);
    defer t.destroy();
    t.feed("Image: /tmp/photo.PNG plain.txt");
    try t.updateRender();
    try std.testing.expectEqual(@as(usize, 1), t.hyperlinks().len);
    try std.testing.expectEqualStrings("file:///tmp/photo.PNG", t.hyperlinks()[0].uri);
}

test "plain links span soft wraps but not hard newlines and remain snapshot owned" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 5);
    defer t.destroy();
    const url = "https://example.com/a-long-path";
    t.feed(url ++ " ");
    const before = try capture(arena.allocator(), @enumFromInt(9), t);
    try std.testing.expectEqual(@as(usize, 2), t.hyperlinks().len);
    for (t.hyperlinks()) |link| try std.testing.expectEqualStrings(url, link.uri);
    for (before.lines[0..2]) |line| try std.testing.expect(std.mem.indexOf(u8, line, ";" ++ url ++ "\x1b\\") != null);
    t.feed("\x1b[?2026h\x1b[2J\x1b[Hhttps://new.example/");
    const during = try capture(arena.allocator(), @enumFromInt(9), t);
    try std.testing.expectEqualStrings(before.lines[0], during.lines[0]);
    t.feed("\x1b[?2026l\x1b[2J\x1b[Hhttp://\r\nexample.com");
    _ = try capture(arena.allocator(), @enumFromInt(9), t);
    try std.testing.expectEqual(@as(usize, 0), t.hyperlinks().len);
}

fn expectCanonical(id: PaneId, t: *terminal.Terminal, captured: Surface) !void {
    try t.updateRender();
    try std.testing.expectEqual(t.render.cols, captured.cols);
    try std.testing.expectEqual(t.render.rows, captured.rows);
    for (captured.lines, 0..) |line, row| {
        var fresh: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer fresh.deinit();
        try writeRow(&fresh.writer, &t.render, t.hyperlinks(), id, row, t.render.cols, false);
        try std.testing.expectEqualStrings(fresh.written(), line);
    }
}

test "canonical cache is lazy and retains row damage across other render consumers" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 6);
    defer t.destroy();
    t.feed("\x1b[?7lFIRST\x1b[3;1HTHIRD\x1b[5;1HFIFTH\x1b[H");
    try t.updateRender();
    try std.testing.expectEqual(@as(usize, 0), t.surface_rows.rows.len);
    const before = try capture(arena.allocator(), @enumFromInt(1), t);
    try expectCanonical(@enumFromInt(1), t, before);
    t.feed("\x1b[3;1HX");
    try t.updateRender();
    t.feed("\x1b[5;1HY");
    const text = try t.text();
    defer @import("../os.zig").allocator.free(text);
    try t.updateRender();
    for (t.surface_rows.rows, 0..) |row, i| try std.testing.expectEqual(i % 2 == 1, row.valid);
    const after = try capture(arena.allocator(), @enumFromInt(1), t);
    try expectCanonical(@enumFromInt(1), t, after);
    try std.testing.expect(!std.mem.eql(u8, before.lines[2], after.lines[2]));
    try std.testing.expect(!std.mem.eql(u8, before.lines[4], after.lines[4]));
    for ([_]usize{ 0, 1, 3, 5 }) |row| try std.testing.expectEqualStrings(before.lines[row], after.lines[row]);
    t.feed("\x1b[?2026h\x1b[2J\x1b[HMID_REDRAW");
    const during = try capture(arena.allocator(), @enumFromInt(1), t);
    for (after.lines, during.lines) |old, current| try std.testing.expectEqualStrings(old, current);
    t.feed("\x1b[?2026l");
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
}

test "canonical cache refreshes cross-row link identities and owns old snapshots" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(40, 5);
    defer t.destroy();
    t.feed("ascii\r\nhttps://example.com/path\x1b[H");
    const before = try capture(arena.allocator(), @enumFromInt(3), t);
    t.feed("界");
    try t.updateRender();
    for (t.surface_rows.rows) |row| try std.testing.expect(!row.valid);
    const after = try capture(arena.allocator(), @enumFromInt(3), t);
    try expectCanonical(@enumFromInt(3), t, after);
    // A preceding UTF-8 byte offset changes an automatic link's identity.
    try std.testing.expect(!std.mem.eql(u8, before.lines[1], after.lines[1]));
    for ([_][]const u8{
        "\x1b[2J\x1b[Hhttps://example.com/a-very-long-path-that-wraps-around ",
        "\x1b[2;3HX",
        "\x1b[2J\x1b[H\x1b]8;id=docs;https://explicit.example/\x1b\\界e\xcc\x81\x1b]8;;\x1b\\",
        "\x1b[H\x1b[8mhttps://hidden.example/\x1b[0m",
        "\x1b[2J\x1b[HNO_LINKS",
    }) |update| {
        t.feed(update);
        try expectCanonical(@enumFromInt(3), t, try capture(arena.allocator(), @enumFromInt(3), t));
    }
    t.feed("\x1b[2J\x1b[Hhttps://example.com/");
    const one = try capture(arena.allocator(), @enumFromInt(3), t);
    const two = try capture(arena.allocator(), @enumFromInt(4), t);
    try std.testing.expect(!std.mem.eql(u8, one.lines[0], two.lines[0]));
    try expectCanonical(@enumFromInt(4), t, two);
}

test "canonical cache follows selection colors geometry and alternate screens" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 4);
    defer t.destroy();
    t.feed("\x1b[31mCOLORED\x1b[0m plain");
    _ = try capture(arena.allocator(), @enumFromInt(1), t);
    try t.select(1, 0, 4, 0);
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
    try t.clearSelection();
    t.applyTheme(.{ .foreground = .{ .r = 120, .g = 130, .b = 140 }, .background = .{ .r = 1, .g = 2, .b = 3 } });
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
    for ([_][]const u8{
        "\x1b]4;1;rgb:44/55/66\x1b\\",
        "\x1b[?5h",
        "\x1b[?1049hALTERNATE",
        "\x1b[?1049l\x1b[?5l",
    }) |update| {
        t.feed(update);
        try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
    }
    try t.resize(27, 7);
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
}

test "canonical cache keeps borrowed viewports independent and snapshots owned" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const t = try terminal.Terminal.create(20, 4);
    defer t.destroy();
    const reference = try terminal.Terminal.create(20, 4);
    defer reference.destroy();
    const input = "one\r\ntwo\r\nthree\r\nfour\r\nfive\r\nsix\r\nseven\r\neight";
    t.feed(input);
    reference.feed(input);
    _ = try capture(arena.allocator(), @enumFromInt(1), t);
    t.vt.scrollViewport(.{ .row = 1 });
    try t.select(0, 0, 2, 1);
    const viewport = t.vt.screens.active.pages.viewport;
    const selection = t.vt.screens.active.selection;
    for ([_]?usize{ 0, null, 2, 0 }) |offset| {
        const view = try captureView(arena.allocator(), @enumFromInt(1), t, offset);
        if (offset) |row| reference.vt.scrollViewport(.{ .row = row }) else reference.vt.scrollViewport(.bottom);
        try expectCanonical(@enumFromInt(1), reference, view.surface);
        try std.testing.expectEqualDeep(viewport, t.vt.screens.active.pages.viewport);
        try std.testing.expect(t.vt.screens.active.selection.?.eql(selection.?));
    }
}

test "canonical cache retries failed formatting and snapshot allocation" {
    var failing: std.testing.FailingAllocator = .init(std.testing.allocator, .{});
    const t = try terminal.Terminal.create(20, 4);
    defer t.destroy();
    t.surface_rows = .init(failing.allocator());
    try t.surface_rows.prepare(1, 20, 4);
    failing.fail_index = failing.alloc_index;
    t.feed("RETRY");
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    try std.testing.expectError(error.WriteFailed, capture(arena.allocator(), @enumFromInt(1), t));
    try std.testing.expect(!t.surface_rows.rows[0].valid);
    failing.fail_index = std.math.maxInt(usize);
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
    var snapshot_failure: std.testing.FailingAllocator = .init(std.testing.allocator, .{ .fail_index = 1 });
    try std.testing.expectError(error.OutOfMemory, capture(snapshot_failure.allocator(), @enumFromInt(1), t));
    try expectCanonical(@enumFromInt(1), t, try capture(arena.allocator(), @enumFromInt(1), t));
}
