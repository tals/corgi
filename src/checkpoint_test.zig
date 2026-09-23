const std = @import("std");
const Terminal = @import("terminal.zig").Terminal;
const cp = @import("checkpoint.zig");
const a = @import("os.zig").allocator;
fn restored(old: *Terminal) !*Terminal {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    return (try cp.Screen.capture(arena.allocator(), old, true)).restore(true);
}
test "compact checkpoint preserves screens input modes cursor and title without replaying replies" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.feed("primary history\x1b[?1049h\x1b[2Jalternate\x1b[?2004h\x1b[?1003h\x1b[?1006h\x1b[>3u\x1b]2;agent title\x1b\\\x1b[3;5H");
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

test "live checkpoint size depends on retained state not output volume" {
    const old = try Terminal.create(40, 6);
    defer old.destroy();
    old.feed("retained content");
    const first = try cp.Screen.capture(a, old, true);
    defer a.free(first.data);
    const noise = [_]u8{'\r'} ** 4096;
    for (0..256) |_| old.feed(&noise);
    const compact = try cp.Screen.capture(a, old, true);
    defer a.free(compact.data);
    try std.testing.expect(compact.data.len < first.data.len + 128);
    const fresh = try compact.restore(true);
    defer fresh.destroy();
    const text = try fresh.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "retained content") != null);
}

test "recovery metadata survives observation and clears on session switch" {
    var agent: @import("agents.zig").Agent = .{ .provider = .codex, .updated_at = 1000 };
    agent.session_len = @import("agents.zig").clean(&agent.session, "first");
    agent.setName("A session\nwith controls\x1b");
    var hint: cp.Resume = .{};
    hint.observe(&agent);
    const banner = try hint.banner(a, 1120);
    defer a.free(banner);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# A session with controls ") != null);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# Last active 2 minutes ago") != null);
    agent.session_len = @import("agents.zig").clean(&agent.session, "second");
    agent.name_len = 0;
    agent.updated_at = 0;
    hint.observe(&agent);
    try std.testing.expectEqual(@as(usize, 0), hint.name_len);
    try std.testing.expectEqual(@as(i64, 0), hint.touched_at);
}
test "recovery never prefills selection or control characters" {
    var hint: cp.Resume = .{ .provider = .codex };
    const missing = try hint.command(a);
    defer a.free(missing);
    try std.testing.expectEqualStrings("", missing);
    @memcpy(hint.session[0..4], "a\nbc");
    hint.len = 4;
    const unsafe = try hint.command(a);
    defer a.free(unsafe);
    try std.testing.expectEqualStrings("", unsafe);
}
