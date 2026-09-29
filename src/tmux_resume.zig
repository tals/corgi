//! Best-effort restart suggestions from foreground argv, never shell history.
const std = @import("std");
const os = @import("os.zig");
const Terminal = @import("terminal.zig").Terminal;

pub fn foregroundPid(processes: []const u8, pane_pid: i32) ?i32 {
    var lines = std.mem.tokenizeScalar(u8, processes, '\n');
    while (lines.next()) |line| {
        var fields = std.mem.tokenizeAny(u8, line, " \t");
        const pid = std.fmt.parseInt(i32, fields.next() orelse continue, 10) catch continue;
        const pgid = std.fmt.parseInt(i32, fields.next() orelse continue, 10) catch continue;
        if (pid == pane_pid) return if (pgid > 0) pgid else null;
    }
    return null;
}

pub fn command(alloc: std.mem.Allocator, pid: i32) ![]const u8 {
    // Read argv boundaries from the OS. `ps args` loses quoting and empty args.
    const bytes = try os.allocator.alloc(u8, 1024 * 1024);
    defer os.allocator.free(bytes);
    const p = os.processArgs(pid, bytes, .{}) orelse return "";
    // A truncated or rewritten argv would resume the wrong command.
    if (!p.complete) return "";
    return quote(alloc, p.args());
}

pub fn quote(alloc: std.mem.Allocator, args: []const []const u8) ![]const u8 {
    if (args.len == 0 or args[0].len == 0 or args[0][0] == '-') return "";
    const exe = std.fs.path.basename(args[0]);
    for ([_][]const u8{ "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh" }) |shell| {
        // A shell prompt or a shell pipeline cannot be reconstructed from argv.
        if (std.mem.eql(u8, exe, shell)) return "";
    }
    const line = try os.shellEscape(alloc, args) orelse return "";
    if (line.len > 2048) {
        alloc.free(line);
        return "";
    }
    return line;
}

/// Keep recent lines within their JSON-escaped byte budget and valid UTF-8.
pub fn tail(text: []const u8, limit: usize) []const u8 {
    const trimmed = std.mem.trimEnd(u8, text, " \r\n");
    var start = trimmed.len;
    var used: usize = 0;
    while (start > 0) {
        const ch = trimmed[start - 1];
        const size: usize = if (ch < 32) 6 else if (ch == '"' or ch == '\\') 2 else 1;
        if (used + size > limit) break;
        used += size;
        start -= 1;
    }
    if (start == 0) return trimmed;
    if (std.mem.indexOfScalar(u8, trimmed[start..], '\n')) |newline| {
        start += newline + 1;
    } else {
        while (start < trimmed.len and trimmed[start] & 0xc0 == 0x80) : (start += 1) {}
    }
    return trimmed[start..];
}

pub fn feed(terminal: *Terminal, text: []const u8) void {
    // capture-pane without -e supplies text, not a terminal command stream.
    // Drop controls defensively so imported output cannot write shell input.
    for (text) |ch| {
        if (ch == '\n') terminal.feed("\r\n") else if (ch >= 32 and ch != 127) terminal.feed(&.{ch});
    }
    if (text.len > 0) terminal.feed("\r\n");
}

test "restart suggestions preserve arguments and refuse shell input controls" {
    const a = std.testing.allocator;
    const quoted = try quote(a, &.{ "tig", "a b", "a'b", "a\\b", "$(touch nope)", "" });
    defer a.free(quoted);
    try std.testing.expectEqualStrings("tig a\\ b a\\'b a\\\\b \\$\\(touch\\ nope\\) ''", quoted);
    try std.testing.expectEqualStrings("", try quote(a, &.{"fish"}));
    try std.testing.expectEqualStrings("", try quote(a, &.{ "tig", "bad\rcommand" }));
    try std.testing.expectEqualStrings("", try quote(a, &.{ "tig", "bad\x1bcommand" }));
    try std.testing.expectEqual(@as(?i32, 77), foregroundPid(" 12 77\n 77 77\n", 12));
    try std.testing.expectEqual(@as(?i32, null), foregroundPid("12 -1\n", 12));
}

test "scrollback tail keeps recent complete lines within its wire budget" {
    try std.testing.expectEqualStrings("new", tail("old\nnew\n\n", 7));
    try std.testing.expectEqualStrings("", tail("new", 0));
    try std.testing.expectEqualStrings("é", tail("éé", 3));
    try std.testing.expectEqualStrings("one\ntwo", tail("one\ntwo", 12));
}
