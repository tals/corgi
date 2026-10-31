//! The viewer's host-screen differ: Corgi's own `frame_diff.zig`, so the Bun
//! viewer writes the same changed-cell spans as the Zig viewer.
const std = @import("std");
const frame_diff = @import("frame_diff");
const pane = @import("pane");
const a = std.heap.c_allocator;

const Host = struct {
    differ: *frame_diff.Differ,
    out: std.Io.Writer.Allocating,
    panes: std.ArrayList(frame_diff.Differ.Pane) = .empty,
    timing: frame_diff.Differ.Timing = .{},
};

pub export fn frame_diff_new(cols: u16, rows: u16) ?*Host {
    const host = a.create(Host) catch return null;
    const differ = frame_diff.Differ.create(cols, rows) catch {
        a.destroy(host);
        return null;
    };
    host.* = .{ .differ = differ, .out = .init(a) };
    return host;
}
pub export fn frame_diff_free(host: *Host) void {
    host.differ.destroy();
    host.out.deinit();
    host.panes.deinit(a);
    a.destroy(host);
}
/// Image writes outside a frame require its placements to be replayed.
pub export fn frame_diff_invalidate_images(host: *Host) void {
    host.differ.images_stale = true;
}
/// Discard an unwritten batch after a presentation changed its retained cells.
pub export fn frame_diff_invalidate(host: *Host) void {
    host.differ.invalidate();
}
/// Diagnostic counters are opt-in and never write to a log.
pub export fn frame_diff_timing_enable(host: *Host, enabled: bool) void {
    host.timing = .{};
    host.differ.timing = if (enabled) &host.timing else null;
}
/// Cumulative nanoseconds spent parsing, updating render state, comparing and emitting.
pub export fn frame_diff_timing(host: *Host, out: [*]u64) void {
    out[0] = host.timing.parse_ns;
    out[1] = host.timing.render_ns;
    out[2] = host.timing.compare_ns;
    out[3] = host.timing.emit_ns;
}
pub export fn frame_diff_stats(host: *Host, out: [*]u64) void {
    out[0] = host.differ.damaged_rows;
    out[1] = host.differ.compared_cells;
    out[2] = @as(u64, host.differ.cols) * (@as(u64, host.differ.rows) + 1);
    out[3] = host.differ.managedCapacity();
}
/// Diffs `frame` against what the host shows; returns the output's length,
/// which `frame_diff_take` copies out, or -1.
pub export fn frame_diff_diff(host: *Host, frame: [*]const u8, len: usize) i64 {
    host.out.clearRetainingCapacity();
    host.differ.diff(&host.out.writer, frame[0..len]) catch return -1;
    return @intCast(host.out.written().len);
}
/// Compose fresh chrome with retained pane cells. Handles and xywh rectangles
/// are borrowed from the caller; no terminal pointer survives this call.
pub export fn frame_diff_compose(host: *Host, chrome: ?[*]const u8, len: usize, handles: [*]const usize, rects: [*]const u16, count: usize, cursor_x: u16, cursor_y: u16, cursor_visible: bool, chrome_mode: u8) i64 {
    host.out.clearRetainingCapacity();
    host.panes.clearRetainingCapacity();
    defer host.panes.clearRetainingCapacity();
    if (chrome_mode > @backingInt(frame_diff.Differ.ChromeMode.reuse)) return -2;
    if (count > @as(usize, host.differ.cols) * host.differ.rows) return -2;
    host.panes.ensureTotalCapacity(a, count) catch return -1;
    for (handles[0..count], 0..) |handle, i| {
        if (handle == 0) return -2;
        const source: *pane.Terminal = @ptrFromInt(handle);
        if (source.graphics.placements.items.len != 0 or source.vt.modes.get(.synchronized_output)) return -2;
        source.updateRender() catch return -1;
        const epochs = source.presentationRows() catch return -1;
        const rect = rects[i * 4 ..][0..4];
        host.panes.appendAssumeCapacity(.{ .state = &source.render, .identity = source.surface_identity, .epochs = epochs, .x = rect[0], .y = rect[1], .w = rect[2], .h = rect[3] });
    }
    const accepted = host.differ.compose(&host.out.writer, if (chrome) |bytes| bytes[0..len] else null, host.panes.items, .{ .x = cursor_x, .y = cursor_y, .visible = cursor_visible }, @fromBackingInt(@intCast(chrome_mode))) catch return -1;
    return if (accepted) @intCast(host.out.written().len) else -2;
}
pub export fn frame_diff_take(host: *Host, out: [*]u8, cap: usize) i64 {
    const bytes = host.out.written();
    if (bytes.len > cap) return -5;
    @memcpy(out[0..bytes.len], bytes);
    return @intCast(bytes.len);
}

/// Ghostty's cell width for every codepoint, as the Zig viewer measures text.
pub export fn unicode_widths(out: [*]u8, len: usize) void {
    const vt = pane.terminal.vt;
    for (0..@min(len, 0x110000)) |cp| out[cp] = vt.unicode.codepointWidth(@intCast(cp));
}
