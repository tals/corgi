const std = @import("std");
pub const Label = @import("bounded_text.zig").BoundedText(80);
/// `value` trimmed, with bytes outside printable ASCII shown as `_`.
pub fn label(value: []const u8) Label {
    var buf: [Label.capacity]u8 = undefined;
    const clean = std.mem.trim(u8, value, " ");
    const len = @min(clean.len, buf.len);
    for (clean[0..len], buf[0..len]) |ch, *out| out.* = if (ch >= 32 and ch < 127) ch else '_';
    return .initTruncated(buf[0..len]);
}
