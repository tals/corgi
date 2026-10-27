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
/// The providers' programs, so terminals know an agent in front of them.
pub export fn detection_configure(data: [*]const u8, len: usize) i32 {
    pane.detection.configure(data[0..len]) catch return -1;
    return 0;
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
