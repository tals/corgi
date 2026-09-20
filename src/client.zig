const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const keyboard = @import("keyboard.zig");
var keyboard_enabled = false;
var cursor_blink_saved = false;
var restore: ?c.struct_termios = null;
fn cleanup() void {
    if (restore) |*term| {
        _ = c.tcsetattr(0, c.TCSAFLUSH, term);
        if (keyboard_enabled) {
            os.writeAll(1, keyboard.disable) catch {};
            keyboard_enabled = false;
        }
        os.writeAll(1, "\x1b[?2026l\x1b[0m\x1b[?25h\x1b[?1003l\x1b[?1002l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[?1049l") catch {};
        if (cursor_blink_saved) {
            os.writeAll(1, "\x1b[?12r") catch {};
            cursor_blink_saved = false;
        }
        restore = null;
    }
}
fn signalHandler(_: c_int) callconv(.c) void {
    cleanup();
    c._exit(0);
}
pub fn attach(path: []const u8) !void {
    if (try attachOnce(path)) |executable| {
        defer a.free(executable);
        try os.exec(&.{ executable, "attach" });
    }
}
fn attachOnce(path: []const u8) !?[]const u8 {
    if (c.isatty(0) == 0 or c.isatty(1) == 0) return error.TerminalRequired;
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    var original: c.struct_termios = undefined;
    if (c.tcgetattr(0, &original) != 0) return error.TerminalRequired;
    restore = original;
    defer cleanup();
    _ = c.signal(c.SIGTERM, signalHandler);
    _ = c.signal(c.SIGHUP, signalHandler);
    _ = c.signal(c.SIGPIPE, os.sig_ignore);
    var raw = original;
    c.cfmakeraw(&raw);
    if (c.tcsetattr(0, c.TCSAFLUSH, &raw) != 0) return error.TerminalRequired;
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    var probe: @import("theme.zig").Probe = .{};
    try probe.query(&input);
    try os.writeAll(1, "\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?1004h\x1b[?2004h" ++ keyboard.enable);
    keyboard_enabled = true;
    if (!std.mem.eql(u8, os.env("CORGI_CURSOR_BLINK") orelse "", "1")) {
        // Save and disable only blinking: retain the host's cursor shape and
        // let each rendered frame continue to control cursor visibility.
        try os.writeAll(1, "\x1b[?12s\x1b[?12l");
        cursor_blink_saved = true;
    }
    return try @import("viewer.zig").run(fd, path, &probe, &input);
}
