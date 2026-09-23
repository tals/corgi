//! Characterization of the pinned Ghostty formatter for the future handoff.
//! This is deliberately test-only: a formatted screen is not a complete live
//! checkpoint. In particular, parser fragments and inactive screens need more.
const std = @import("std");
const terminal = @import("terminal.zig");
const Terminal = terminal.Terminal;
const a = @import("os.zig").allocator;

fn format(t: *Terminal) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var formatter = terminal.vt.formatter.TerminalFormatter.init(&t.vt, .{ .emit = .vt, .trim = false });
    formatter.extra = .all;
    try formatter.format(&out.writer);
    // Global extras (notably tabstops) move the replay cursor after the screen
    // extras. A handoff must restore it last; this probe uses default origin.
    const cursor = t.vt.screens.active.cursor;
    try out.writer.print("\x1b[{d};{d}H", .{ cursor.y + 1, cursor.x + 1 });
    return out.toOwnedSlice();
}

test "checkpoint probe restores retained primary history cursor and input modes" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.feed("FIRST_HISTORY_LINE\r\n");
    for (0..400) |_| old.feed("a line of retained terminal history\r\n");
    old.feed("\x1b[3;5H\x1b[31mRED\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b[>1u");
    const saved = try format(old);
    defer a.free(saved);
    try std.testing.expect(saved.len > 8192);
    const fresh = try Terminal.create(40, 6);
    defer fresh.destroy();
    fresh.feed(saved);
    try std.testing.expectEqual(old.vt.screens.active.cursor.x, fresh.vt.screens.active.cursor.x);
    try std.testing.expectEqual(old.vt.screens.active.cursor.y, fresh.vt.screens.active.cursor.y);
    try std.testing.expect(fresh.vt.modes.get(.bracketed_paste));
    try std.testing.expectEqual(old.vt.flags.mouse_event, fresh.vt.flags.mouse_event);
    try std.testing.expectEqual(old.vt.screens.active.kitty_keyboard.current(), fresh.vt.screens.active.kitty_keyboard.current());
    try std.testing.expect((try fresh.search("FIRST_HISTORY_LINE", 0)).offset != null);
}

test "checkpoint probe only preserves current keyboard flags not their push stack" {
    const old = try Terminal.create(30, 5);
    defer old.destroy();
    old.feed("\x1b[>1u\x1b[>3u");
    const saved = try format(old);
    defer a.free(saved);
    const fresh = try Terminal.create(30, 5);
    defer fresh.destroy();
    fresh.feed(saved);
    try std.testing.expectEqual(old.vt.screens.active.kitty_keyboard.current(), fresh.vt.screens.active.kitty_keyboard.current());
    old.feed("\x1b[<u");
    fresh.feed("\x1b[<u");
    try std.testing.expect(!std.meta.eql(old.vt.screens.active.kitty_keyboard.current(), fresh.vt.screens.active.kitty_keyboard.current()));
}

test "checkpoint probe formats the active alternate screen but omits inactive primary" {
    const old = try Terminal.create(30, 5);
    defer old.destroy();
    old.feed("PRIMARY_ONLY\x1b[?1049hALTERNATE_CONTENT\x1b[2;3H");
    const saved = try format(old);
    defer a.free(saved);
    const fresh = try Terminal.create(30, 5);
    defer fresh.destroy();
    fresh.feed(saved);
    try std.testing.expectEqual(.alternate, fresh.vt.screens.active_key);
    try std.testing.expect((try fresh.search("ALTERNATE_CONTENT", 0)).offset != null);
    fresh.feed("\x1b[?1049l");
    try std.testing.expect((try fresh.search("PRIMARY_ONLY", 0)).offset == null);
}

test "checkpoint probe does not preserve a partially parsed escape" {
    const old = try Terminal.create(30, 5);
    defer old.destroy();
    old.feed("before\x1b[31;");
    const saved = try format(old);
    defer a.free(saved);
    const fresh = try Terminal.create(30, 5);
    defer fresh.destroy();
    fresh.feed(saved);
    old.feed("1mAFTER");
    fresh.feed("1mAFTER");
    const expected = try old.text();
    defer a.free(expected);
    const actual = try fresh.text();
    defer a.free(actual);
    try std.testing.expect(std.mem.indexOf(u8, expected, "beforeAFTER") != null);
    try std.testing.expect(std.mem.indexOf(u8, actual, "before1mAFTER") != null);
}
