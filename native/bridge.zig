const std = @import("std");
const pane = @import("pane");
const a = std.heap.c_allocator;
comptime {
    _ = @import("app_bridge.zig");
    _ = @import("frame_diff_bridge.zig");
    _ = @import("viewer_bridge.zig");
}
// As in corgi's main.zig: only the daemon logs (its stderr is server.log).
// A viewer's stderr is the user's screen.
var log_to_stderr = false;
pub const std_options: std.Options = .{ .logFn = logFn };
fn logFn(
    comptime level: std.log.Level,
    comptime scope: @EnumLiteral(),
    comptime format: []const u8,
    args: anytype,
) void {
    if (log_to_stderr) std.log.defaultLog(level, scope, format, args);
}
pub export fn native_log_stderr(on: bool) void {
    log_to_stderr = on;
}
const c = @cImport({
    @cInclude("fcntl.h");
    @cInclude("time.h");
    @cInclude("unistd.h");
});
pub export fn nano() u64 {
    var ts: c.struct_timespec = undefined;
    _ = c.clock_gettime(c.CLOCK_MONOTONIC, &ts);
    return @as(u64, @intCast(ts.tv_sec)) * 1_000_000_000 + @as(u64, @intCast(ts.tv_nsec));
}
pub export fn terminal_new() ?*pane.Terminal {
    return pane.Terminal.create(120, 40) catch null;
}
pub export fn terminal_free(t: *pane.Terminal) void {
    t.destroy();
}
pub export fn terminal_resize(t: *pane.Terminal, cols: u16, rows: u16) i32 {
    if (cols == 0 or cols > 500 or rows == 0 or rows > 200) return -1;
    t.resize(cols, rows) catch return -2;
    return 0;
}
pub export fn terminal_feed(t: *pane.Terminal, data: [*]const u8, len: usize) void {
    t.feed(data[0..len]);
}
pub export fn terminal_send(t: *pane.Terminal, data: [*]const u8, len: usize) i32 {
    t.send(data[0..len]) catch |err| return if (err == error.InputBackpressure) -2 else -1;
    return 0;
}
pub export fn terminal_pending(t: *pane.Terminal) usize {
    return t.pending.items.len;
}
pub export fn terminal_text(t: *pane.Terminal, out: [*]u8, cap: usize) i64 {
    const text = t.text() catch return -1;
    defer a.free(text);
    if (text.len > cap) return -2;
    @memcpy(out[0..text.len], text);
    return @intCast(text.len);
}
pub export fn terminal_snapshot(t: *pane.Terminal, out: [*]u8, cap: usize) i64 {
    const text = t.liveSnapshot() catch return -1;
    defer a.free(text);
    if (text.len > cap) return -2;
    @memcpy(out[0..text.len], text);
    return @intCast(text.len);
}
pub export fn terminal_surface(t: *pane.Terminal) i64 {
    t.updateRender() catch return -1;
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    for (0..40) |row| pane.surface.writeRow(&out.writer, &t.render, t.hyperlinks(), @enumFromInt(1), row, 120, false) catch return -1;
    return @intCast(out.written().len);
}
pub export fn json_parse(data: [*]const u8, len: usize) i64 {
    var lines = std.mem.splitScalar(u8, data[0..len], '\n');
    var sum: i64 = 0;
    while (lines.next()) |line| {
        if (line.len == 0) continue;
        const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch return -1;
        defer parsed.deinit();
        sum += parsed.value.object.get("id").?.integer;
        sum += parsed.value.object.get("usage").?.object.get("tokens").?.integer;
    }
    return sum;
}
pub export fn scan_urls(data: [*]const u8, len: usize) i64 {
    var sum: i64 = 0;
    var start: usize = 0;
    while (std.mem.indexOfPos(u8, data[0..len], start, "https://")) |at| {
        var end = at;
        while (end < len and data[end] > 32 and data[end] != '"') : (end += 1) {}
        sum += @intCast(end - at);
        start = end;
    }
    return sum;
}
pub export fn frame_make(frame: u32) i64 {
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    out.writer.writeAll("\x1b[?2026h\x1b[H") catch return -1;
    for (0..40) |y| {
        out.writer.print("\x1b[{d};1H", .{y + 1}) catch return -1;
        for (0..120) |x| out.writer.writeByte(@intCast(32 + (x + y + frame) % 95)) catch return -1;
    }
    out.writer.writeAll("\x1b[?2026l") catch return -1;
    return @intCast(out.written().len);
}
pub export fn proc_scan(pid: i32) i64 {
    var path: [64]u8 = undefined;
    const p = std.fmt.bufPrintZ(&path, "/proc/{d}/stat", .{pid}) catch return -1;
    const fd = c.open(p, c.O_RDONLY);
    if (fd < 0) return -1;
    defer _ = c.close(fd);
    var buf: [4096]u8 = undefined;
    const n = c.read(fd, &buf, buf.len);
    if (n <= 0) return -1;
    const bytes = buf[0..@intCast(n)];
    const end = std.mem.lastIndexOfScalar(u8, bytes, ')') orelse return -1;
    var fields = std.mem.tokenizeAny(u8, bytes[end + 1 ..], " \n");
    var index: usize = 3;
    var sum: i64 = 0;
    while (fields.next()) |v| : (index += 1) {
        switch (index) {
            4, 14, 15, 22, 24 => sum +%= std.fmt.parseInt(i64, v, 10) catch return -1,
            else => {},
        }
    }
    return sum;
}

pub export fn graphics_encode(data: [*]const u8, len: usize) i64 {
    const encoder = std.base64.standard.Encoder;
    const base = a.alloc(u8, encoder.calcSize(len)) catch return -1;
    defer a.free(base);
    _ = encoder.encode(base, data[0..len]);
    var out: std.Io.Writer.Allocating = .init(a);
    defer out.deinit();
    var offset: usize = 0;
    while (offset < base.len) : (offset += 4096) {
        const end = @min(base.len, offset + 4096);
        out.writer.print("\x1b_G{s}m={d};", .{ if (offset == 0) "a=t,f=100,i=730031,q=2," else "", @intFromBool(end < base.len) }) catch return -1;
        out.writer.writeAll(base[offset..end]) catch return -1;
        out.writer.writeAll("\x1b\\") catch return -1;
    }
    return @intCast(out.written().len);
}
