//! The viewer's host-screen differ: Corgi's own `frame_diff.zig`, so the Bun
//! viewer writes the same changed-cell spans as the Zig viewer.
const std = @import("std");
const frame_diff = @import("frame_diff");
const a = std.heap.c_allocator;

const Host = struct { differ: *frame_diff.Differ, out: std.Io.Writer.Allocating };

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
    a.destroy(host);
}
/// Diffs `frame` against what the host shows; returns the output's length,
/// which `frame_diff_take` copies out, or -1.
pub export fn frame_diff_diff(host: *Host, frame: [*]const u8, len: usize) i64 {
    host.out.clearRetainingCapacity();
    host.differ.diff(&host.out.writer, frame[0..len]) catch return -1;
    return @intCast(host.out.written().len);
}
pub export fn frame_diff_take(host: *Host, out: [*]u8, cap: usize) i64 {
    const bytes = host.out.written();
    if (bytes.len > cap) return -5;
    @memcpy(out[0..bytes.len], bytes);
    return @intCast(bytes.len);
}

/// Ghostty's cell width for every codepoint, as the Zig viewer measures text.
pub export fn unicode_widths(out: [*]u8, len: usize) void {
    const vt = @import("pane").terminal.vt;
    for (0..@min(len, 0x110000)) |cp| out[cp] = vt.unicode.codepointWidth(@intCast(cp));
}
