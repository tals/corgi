//! Viewer-owned Kitty image: upload once, then redraw by image/placement ID.
//! Hosts that never answer the graphics query get an emoji in the same spot.
const std = @import("std");
const png = @embedFile("assets/corgi-badge.png");
// PNG IHDR dimensions. iTerm2 needs them in transmission metadata to scale
// width-only placements; otherwise it accepts the image but draws zero height.
const pixel_width = std.mem.readInt(u32, png[16..20], .big);
const pixel_height = std.mem.readInt(u32, png[20..24], .big);
pub const reply_prefix = "\x1b_G";
pub const query = "\x1b_Ga=q,i=730031,t=d,f=24,s=1,v=1;AAAA\x1b\\";
pub const remove = "\x1b_Ga=d,d=I,i=730031,q=2\x1b\\";
// Target the placement explicitly: iTerm2 evicts the image for d=i without p.
pub const hide = "\x1b_Ga=d,d=i,i=730031,p=1,q=2\x1b\\";

pub const emoji = "🐕";
/// Hosts without Kitty graphics ignore the query rather than reject it.
const probe_timeout_ms = 1500;

pub const Mode = enum { none, emoji, image };

pub fn hit(mode: Mode, sidebar_width: u16, x: u16, y: u16) bool {
    if (sidebar_width == 0) return false;
    return switch (mode) {
        .none => false,
        .emoji => x >= 1 and x < 3 and y == 0,
        .image => x >= 1 and x < 4 and y < 2,
    };
}

pub const State = struct {
    status: enum { probing, supported, uploading, confirming, ready, unavailable } = .probing,
    supports_kitty_graphics: bool = false,
    uploaded: bool = false,
    retry_at: i64 = 0,
    attempts: u8 = 0,
    probe_deadline: ?i64 = null,

    pub fn mode(self: State) Mode {
        return switch (self.status) {
            .ready => .image,
            .unavailable => .emoji,
            .probing, .supported, .uploading, .confirming => .none,
        };
    }

    pub fn accept(self: *State, sequence: []const u8) bool {
        if (!std.mem.startsWith(u8, sequence, reply_prefix) or !std.mem.endsWith(u8, sequence, "\x1b\\")) return false;
        const rest = sequence[reply_prefix.len .. sequence.len - 2];
        const separator = std.mem.indexOfScalar(u8, rest, ';') orelse return false;
        var id: ?u32 = null;
        var placement: ?u32 = null;
        var fields = std.mem.splitScalar(u8, rest[0..separator], ',');
        while (fields.next()) |field| {
            const equals = std.mem.indexOfScalar(u8, field, '=') orelse return false;
            const key = field[0..equals];
            if (std.mem.eql(u8, key, "i")) {
                if (id != null) return false;
                id = std.fmt.parseInt(u32, field[equals + 1 ..], 10) catch return false;
            } else if (std.mem.eql(u8, key, "p")) {
                if (placement != null) return false;
                placement = std.fmt.parseInt(u32, field[equals + 1 ..], 10) catch return false;
            }
        }
        if (id != 730031 or (placement != null and placement.? != 1)) return false;
        const message = rest[separator + 1 ..];
        if (std.mem.eql(u8, message, "OK")) {
            self.supports_kitty_graphics = true;
            self.status = switch (self.status) {
                .probing => .supported,
                // A slow host (e.g. over SSH) can answer after the probe timed out.
                .unavailable => if (self.uploaded) .unavailable else .supported,
                .uploading, .confirming => .ready,
                else => self.status,
            };
            if (self.status == .ready) {
                self.attempts = 0;
                self.retry_at = 0;
            }
        } else if ((self.status == .ready or self.status == .confirming) and std.mem.startsWith(u8, message, "ENOENT")) {
            // The image was evicted or a silent upload failed. Retry within the
            // same bound, keeping the successful capability probe independent.
            self.status = if (self.attempts < 3) .supported else .unavailable;
            self.retry_at = 0;
        } else self.status = .unavailable;
        return true;
    }

    pub fn upload(self: *State, out: *std.Io.Writer, now_ms: i64) !void {
        if (self.status == .probing) {
            const deadline = self.probe_deadline orelse now_ms + probe_timeout_ms;
            self.probe_deadline = deadline;
            if (now_ms >= deadline) self.status = .unavailable;
        }
        if (self.status == .uploading and now_ms >= self.retry_at) {
            // Some hosts acknowledge a chunked upload with i=0. Ask to place
            // our actual image ID before deciding that the upload failed.
            try placementCommand(out, 0);
            // Confirmation must not leave a badge in a hidden sidebar or menu.
            try out.writeAll(hide);
            self.status = .confirming;
            self.retry_at = now_ms + 1500;
            return;
        }
        if (self.status == .confirming and now_ms >= self.retry_at) {
            self.status = if (self.attempts < 3) .supported else .unavailable;
        }
        if (self.status != .supported or now_ms < self.retry_at) return;
        var encoded: [std.base64.standard.Encoder.calcSize(png.len)]u8 = undefined;
        const data = std.base64.standard.Encoder.encode(&encoded, png);
        var offset: usize = 0;
        while (offset < data.len) {
            const end = @min(offset + 4096, data.len);
            if (offset == 0) {
                try out.print("\x1b_Ga=t,t=d,f=100,s={d},v={d},i=730031,m={d};", .{ pixel_width, pixel_height, @intFromBool(end < data.len) });
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
    try placementCommand(out, 1);
}

fn placementCommand(out: *std.Io.Writer, quiet: u1) !void {
    // Set only the width so the host preserves the PNG aspect ratio.
    // Terminal cells are taller than they are wide; specifying rows stretches it.
    try out.print("\x1b7\x1b[1;2H\x1b_Ga=p,i=730031,p=1,c=3,z=1,C=1,q={d}\x1b\\\x1b8", .{quiet});
}

test "badge uploads only on support or lost-image recovery" {
    var state: State = .{};
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try state.upload(&output.writer, 0);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    try state.upload(&output.writer, 0);
    try std.testing.expect(output.written().len > png.len);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "m=1;") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "m=0;") != null);
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 2000);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try place(&output.writer);
    try std.testing.expect(output.written().len < 100);
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031,p=1;ENOENT:missing\x1b\\"));
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 4000);
    try std.testing.expect(output.written().len > png.len);
    try std.testing.expect(!state.accept(reply_prefix ++ "i=7300319;OK\x1b\\"));
}

test "unanswered probe falls back to the emoji and upgrades on a late reply" {
    var state: State = .{};
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try state.upload(&output.writer, 1000);
    try std.testing.expect(state.mode() == .none);
    try state.upload(&output.writer, 1000 + probe_timeout_ms);
    try std.testing.expect(state.mode() == .emoji);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    try state.upload(&output.writer, 3000);
    try std.testing.expect(output.written().len > png.len);
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    try std.testing.expect(state.mode() == .image);
}

test "emoji hit area covers only its two cells" {
    try std.testing.expect(hit(.emoji, 30, 1, 0));
    try std.testing.expect(hit(.emoji, 30, 2, 0));
    try std.testing.expect(!hit(.emoji, 30, 3, 0));
    try std.testing.expect(!hit(.emoji, 30, 1, 1));
    try std.testing.expect(hit(.image, 30, 3, 1));
    try std.testing.expect(!hit(.none, 30, 1, 0));
    try std.testing.expect(!hit(.emoji, 0, 1, 0));
}

test "chunked upload with a wrong acknowledgement ID is confirmed by placement" {
    var state: State = .{};
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try state.upload(&output.writer, 0);
    try std.testing.expect(std.mem.count(u8, output.written(), "\x1b_G") > 1);
    // iTerm2 acknowledges the final chunk using its omitted (zero) image ID.
    try std.testing.expect(!state.accept(reply_prefix ++ "i=0;OK\x1b\\"));
    try std.testing.expect(state.status == .uploading);
    try std.testing.expect(state.supports_kitty_graphics);
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 3000);
    try std.testing.expect(state.status == .confirming);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "a=p,i=730031,p=1,c=3,z=1,C=1,q=0") != null);
    try std.testing.expect(std.mem.endsWith(u8, output.written(), hide));
    try std.testing.expect(state.accept(reply_prefix ++ "p=1,i=730031;OK\x1b\\"));
    try std.testing.expect(state.mode() == .image);
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 10000);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    // Eviction recovery still works after a confirmed upload.
    try std.testing.expect(state.accept(reply_prefix ++ "p=1,i=730031;ENOENT:missing\x1b\\"));
    try state.upload(&output.writer, 10000);
    try std.testing.expect(output.written().len > png.len);
}

test "badge replies require exact image and placement IDs in any field order" {
    var state: State = .{};
    for ([_][]const u8{
        "i=0;OK",          "i=7300319;OK",    "p=1;OK",              "i=730031,p=2;OK",
        "i=730031,i=0;OK", "i=0,i=730031;OK", "i=730031,p=1,p=2;OK",
    }) |body| {
        var buf: [128]u8 = undefined;
        try std.testing.expect(!state.accept(try std.fmt.bufPrint(&buf, "{s}{s}\x1b\\", .{ reply_prefix, body })));
    }
    try std.testing.expect(!state.supports_kitty_graphics);
    try std.testing.expect(state.accept(reply_prefix ++ "p=1,i=730031;OK\x1b\\"));
    try std.testing.expect(state.supports_kitty_graphics);
}

test "missing upload and placement acknowledgements fall back without losing capability" {
    var state: State = .{};
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for (0..3) |attempt| {
        output.clearRetainingCapacity();
        try state.upload(&output.writer, @intCast(attempt * 4500));
        try std.testing.expect(output.written().len > png.len);
        output.clearRetainingCapacity();
        try state.upload(&output.writer, @intCast(attempt * 4500 + 3000));
        try std.testing.expect(state.status == .confirming);
        try std.testing.expect(output.written().len < 200);
    }
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 13500);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.mode() == .emoji);
    try std.testing.expect(state.supports_kitty_graphics);
}

test "placement missing-image replies retry only a bounded number of uploads" {
    var state: State = .{};
    try std.testing.expect(state.accept(reply_prefix ++ "i=730031;OK\x1b\\"));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for (0..3) |attempt| {
        output.clearRetainingCapacity();
        try state.upload(&output.writer, @intCast(attempt * 3000));
        try std.testing.expect(output.written().len > png.len);
        try state.upload(&output.writer, @intCast(attempt * 3000 + 3000));
        try std.testing.expect(state.accept(reply_prefix ++ "p=1,i=730031;ENOENT:missing\x1b\\"));
    }
    output.clearRetainingCapacity();
    try state.upload(&output.writer, 9000);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
    try std.testing.expect(state.mode() == .emoji);
    try std.testing.expect(state.supports_kitty_graphics);
}
