const std = @import("std");
const Terminal = @import("terminal.zig").Terminal;
const cp = @import("checkpoint.zig");
const a = @import("os.zig").allocator;
fn restored(old: *Terminal) !*Terminal {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    return (try cp.Screen.capture(arena.allocator(), old, true)).restore(true);
}
fn equal(old: *Terminal, fresh: *Terminal) !void {
    const expected = try old.snapshot();
    defer a.free(expected);
    const actual = try fresh.snapshot();
    defer a.free(actual);
    try std.testing.expectEqualStrings(expected, actual);
    try std.testing.expectEqual(old.vt.screens.active.cursor.x, fresh.vt.screens.active.cursor.x);
    try std.testing.expectEqual(old.vt.screens.active.cursor.y, fresh.vt.screens.active.cursor.y);
    try std.testing.expectEqualDeep(old.vt.screens.active.kitty_keyboard, fresh.vt.screens.active.kitty_keyboard);
    try std.testing.expectEqualDeep(old.vt.modes, fresh.vt.modes);
}
test "live checkpoint preserves both screens history margins wrap keyboard stack and colors" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.record();
    old.applyTheme(.{ .foreground = .{ .r = 20, .g = 40, .b = 60 } });
    old.feed("FIRST_HISTORY_LINE\r\n");
    for (0..400) |_| old.feed("a line of retained terminal history\r\n");
    old.feed("\x1b[3;5H\x1b[31mRED\x1b[>1u\x1b[?1049hALTERNATE\x1b[>3u\x1b[>7u");
    old.feed("\x1b[2;5r\x1b[?6h\x1b[2;3H\x1b7\x1b[?2004h\x1b[?1002h\x1b[?1006h\x1b]11;#123456\x07");
    const fresh = try restored(old);
    defer fresh.destroy();
    try equal(old, fresh);
    for ([_][]const u8{ "\x1b[<u\x1b8HELLO", "\x1b[?1049l", "\x1b8AFTER" }) |bytes| {
        old.feed(bytes);
        fresh.feed(bytes);
        try equal(old, fresh);
    }
    try old.resize(25, 8);
    try fresh.resize(25, 8);
    try equal(old, fresh);
    try std.testing.expect(try fresh.search("FIRST_HISTORY_LINE", 0));
}
test "live checkpoint preserves fragments at every byte including UTF8 CSI OSC and DCS" {
    const sequence = "hello🙂é\x1b[31;1mRED\x1b]2;title✓\x1b\\\x1bP$qm\x1b\\\x1b[3;4H!";
    for (0..sequence.len) |split| {
        const old = try Terminal.create(30, 5);
        defer old.destroy();
        old.record();
        old.feed(sequence[0..split]);
        const fresh = try restored(old);
        defer fresh.destroy();
        try std.testing.expectEqual(@as(usize, 0), fresh.pending.items.len);
        old.pending.clearRetainingCapacity();
        old.feed(sequence[split..]);
        fresh.feed(sequence[split..]);
        try equal(old, fresh);
        try std.testing.expectEqualStrings(old.pending.items, fresh.pending.items);
    }
}
test "live checkpoint retains completed synchronized frame and falls back after journal failure" {
    const old = try Terminal.create(30, 5);
    defer old.destroy();
    old.record();
    old.feed("COMPLETE\x1b[2;3H");
    try old.updateRender();
    old.feed("\x1b[?2026h\x1b[1;1HPARTIAL");
    const fresh = try restored(old);
    defer fresh.destroy();
    const expected = try old.text();
    defer a.free(expected);
    const actual = try fresh.text();
    defer a.free(actual);
    try std.testing.expectEqualStrings(expected, actual);
    try std.testing.expectEqualDeep(old.render.cursor.viewport, fresh.render.cursor.viewport);
    old.feed("\x1b[?2026l");
    fresh.feed("\x1b[?2026l");
    try equal(old, fresh);
    old.journal.fail();
    const fallback = try cp.Screen.capture(a, old, true);
    defer a.free(fallback.data);
    try std.testing.expect(fallback.approximate);
    const recovered = try fallback.restore(true);
    defer recovered.destroy();
    try std.testing.expect(recovered.redraw_pending);
    try std.testing.expect(recovered.journal.enabled and !recovered.journal.failed);
    const cold = try cp.Screen.capture(a, old, false);
    defer a.free(cold.data);
    try std.testing.expect(cold.data.len > 0);
}
test "fallback preserves screens input modes cursor and title without replaying replies" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.record();
    old.feed("primary history\x1b[?1049h\x1b[2Jalternate\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>3u\x1b]2;agent title\x1b\\\x1b[3;5H");
    old.journal.fail();
    const fresh = try restored(old);
    defer fresh.destroy();
    try std.testing.expectEqual(old.vt.screens.active_key, fresh.vt.screens.active_key);
    try std.testing.expect(fresh.vt.modes.get(.bracketed_paste));
    try std.testing.expectEqual(old.vt.flags.mouse_event, fresh.vt.flags.mouse_event);
    try std.testing.expectEqual(old.vt.flags.mouse_format, fresh.vt.flags.mouse_format);
    try std.testing.expectEqual(old.vt.screens.active.kitty_keyboard.current(), fresh.vt.screens.active.kitty_keyboard.current());
    try std.testing.expectEqual(old.vt.screens.active.cursor.x, fresh.vt.screens.active.cursor.x);
    try std.testing.expectEqual(old.vt.screens.active.cursor.y, fresh.vt.screens.active.cursor.y);
    try std.testing.expectEqualStrings("agent title", fresh.vt.getTitle().?);
    try std.testing.expectEqual(@as(usize, 0), fresh.pending.items.len);
    const visible = try fresh.text();
    defer a.free(visible);
    try std.testing.expect(std.mem.indexOf(u8, visible, "alternate") != null);
    fresh.feed("\x1b[?1049l");
    const primary = try fresh.text();
    defer a.free(primary);
    try std.testing.expect(std.mem.indexOf(u8, primary, "primary history") != null);
}
test "redraw cycle changes PTY dimensions only after activation and restores them" {
    const os = @import("os.zig");
    const c = os.c;
    var master: c_int = -1;
    var slave: c_int = -1;
    var ws = std.mem.zeroes(c.struct_winsize);
    ws.ws_col = 40;
    ws.ws_row = 6;
    try std.testing.expectEqual(@as(c_int, 0), c.openpty(&master, &slave, null, null, &ws));
    defer _ = c.close(slave);
    const t = try Terminal.create(40, 6);
    defer t.destroy();
    t.fd = master;
    t.redraw_pending = true;
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 40), ws.ws_col);
    t.refreshRedraw(1000);
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 39), ws.ws_col);
    t.refreshRedraw(1100);
    try std.testing.expect(t.redraw_restore_at != null);
    t.refreshRedraw(1250);
    _ = c.ioctl(slave, c.TIOCGWINSZ, &ws);
    try std.testing.expectEqual(@as(u16, 40), ws.ws_col);
    try std.testing.expect(t.redraw_restore_at == null);
}
test "resume command quotes session text as one shell argument" {
    var hint: cp.Resume = .{ .provider = .codex };
    hint.len = @import("agents.zig").clean(&hint.session, "session'with quote");
    const command = try hint.command(a);
    defer a.free(command);
    try std.testing.expectEqualStrings("codex resume 'session'\\''with quote'", command);
}
