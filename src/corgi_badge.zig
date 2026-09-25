//! Viewer-owned Kitty image: upload once, then redraw by image/placement ID.
const std = @import("std");
const png = @embedFile("assets/corgi-badge.png");
pub const reply_prefix = "\x1b_Gi=730031";
pub const query = "\x1b_Ga=q,i=730031,t=d,f=24,s=1,v=1;AAAA\x1b\\";
pub const remove = "\x1b_Ga=d,d=I,i=730031,q=2\x1b\\";
pub const hide = "\x1b_Ga=d,d=i,i=730031,q=2\x1b\\";

pub fn hit(visible: bool, sidebar_width: u16, x: u16, y: u16) bool {
    return visible and sidebar_width > 0 and x >= 1 and x < 4 and y < 2;
}

pub const State = struct {
    status: enum { probing, supported, uploading, ready, unavailable } = .probing,
    uploaded: bool = false,
    retry_at: i64 = 0,
    attempts: u8 = 0,

    pub fn accept(self: *State, sequence: []const u8) bool {
        if (!std.mem.startsWith(u8, sequence, reply_prefix) or !std.mem.endsWith(u8, sequence, "\x1b\\")) return false;
        const rest = sequence[reply_prefix.len .. sequence.len - 2];
        if (rest.len == 0 or (rest[0] != ';' and rest[0] != ',')) return false;
        const separator = std.mem.indexOfScalar(u8, rest, ';') orelse return false;
        const message = rest[separator + 1 ..];
        if (std.mem.eql(u8, message, "OK")) {
            self.status = switch (self.status) {
                .probing => .supported,
                .uploading => .ready,
                else => self.status,
            };
        } else if (self.status == .ready and std.mem.startsWith(u8, message, "ENOENT")) {
            // Storage can be evicted by the host; recover without resending on every frame.
            self.status = .supported;
        } else self.status = .unavailable;
        return true;
    }

    pub fn upload(self: *State, out: *std.Io.Writer, now_ms: i64) !void {
        if (self.status == .uploading and now_ms >= self.retry_at) {
            self.status = if (self.attempts < 3) .supported else .unavailable;
        }
        if (self.status != .supported or now_ms < self.retry_at) return;
        var encoded: [std.base64.standard.Encoder.calcSize(png.len)]u8 = undefined;
        const data = std.base64.standard.Encoder.encode(&encoded, png);
        var offset: usize = 0;
        while (offset < data.len) {
            const end = @min(offset + 4096, data.len);
            if (offset == 0) {
                try out.print("\x1b_Ga=t,t=d,f=100,i=730031,m={d};", .{@intFromBool(end < data.len)});
            } else try out.print("\x1b_Gm={d};", .{@intFromBool(end < data.len)});
            try out.writeAll(data[offset..end]);
            try out.writeAll("\x1b\\");
            offset = end;
        }
        self.status = .uploading;
        self.uploaded = true;
        self.retry_at = now_ms + 3000;
        self.attempts +|= 1;
    }
};

pub fn place(out: *std.Io.Writer) !void {
    // Set only the width so the host preserves the PNG aspect ratio.
    // Terminal cells are taller than they are wide; specifying rows stretches it.
    try out.writeAll("\x1b7\x1b[1;2H\x1b_Ga=p,i=730031,p=1,c=3,z=1,C=1,q=1\x1b\\\x1b8");
}

test "badge uploads only on support or lost-image recovery" {
    var state: State = .{};
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try state.upload(&output.writer, 0);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.accept(reply_prefix ++ ";OK\x1b\\"));
    try state.upload(&output.writer, 0);
    try std.testing.expect(output.written().len > png.len);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "m=1;") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "m=0;") != null);
    try std.testing.expect(state.accept(reply_prefix ++ ";OK\x1b\\"));
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 2000);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try place(&output.writer);
    try std.testing.expect(output.written().len < 100);
    try std.testing.expect(state.accept(reply_prefix ++ ",p=1;ENOENT:missing\x1b\\"));
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 4000);
    try std.testing.expect(output.written().len > png.len);
    try std.testing.expect(!state.accept(reply_prefix ++ "9;OK\x1b\\"));
}

test "missing upload acknowledgement retries a bounded number of times" {
    var state: State = .{ .status = .supported };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for (0..3) |attempt| {
        output.clearRetainingCapacity();
        try state.upload(&output.writer, @intCast(attempt * 3000));
        try std.testing.expect(output.written().len > png.len);
    }
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 9000);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.status == .unavailable);
}
