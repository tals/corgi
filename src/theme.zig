const std = @import("std");
const vt = @import("ghostty-vt");
const os = @import("os.zig");
const keys = @import("keys.zig");
const corgi_badge = @import("corgi_badge.zig");
const a = os.allocator;

/// The host's default colors and its configurable ANSI palette. Applications
/// still own their OSC overrides; changing the host only changes defaults.
pub const Theme = struct {
    foreground: ?vt.color.RGB = null,
    background: ?vt.color.RGB = null,
    palette: [16]?vt.color.RGB = .{null} ** 16,

    pub fn fromJson(value: std.json.Value) Theme {
        const parsed = std.json.parseFromValue(Theme, a, value, .{ .ignore_unknown_fields = true }) catch return .{};
        defer parsed.deinit();
        return parsed.value;
    }
    pub fn merge(t: *Theme, other: Theme) void {
        if (other.foreground) |color| t.foreground = color;
        if (other.background) |color| t.background = color;
        for (other.palette, 0..) |entry, i| if (entry) |color| {
            t.palette[i] = color;
        };
    }
    pub fn apply(t: Theme, terminal: *vt.Terminal) void {
        if (t.foreground) |color| terminal.colors.foreground.default = color;
        if (t.background) |color| terminal.colors.background.default = color;
        var palette = terminal.colors.palette.original;
        for (t.palette, 0..) |entry, i| if (entry) |color| {
            palette[i] = color;
        };
        terminal.colors.palette.changeDefault(palette);
        terminal.flags.dirty.palette = true;
    }
    fn complete(t: Theme) bool {
        if (t.foreground == null or t.background == null) return false;
        for (t.palette) |entry| if (entry == null) return false;
        return true;
    }
    const OscKind = enum { @"4", @"10", @"11" };
    fn accept(t: *Theme, body: []const u8) bool {
        var fields = std.mem.splitScalar(u8, body, ';');
        const kind = std.meta.stringToEnum(OscKind, fields.next() orelse return false) orelse return false;
        const entry = fields.next() orelse return false;
        switch (kind) {
            .@"4" => {
                const index = std.fmt.parseInt(u8, entry, 10) catch return false;
                if (index >= t.palette.len) return false;
                const rgb = fields.next() orelse return false;
                if (fields.next() != null) return false;
                t.palette[index] = vt.color.RGB.parse(rgb) catch return false;
            },
            .@"10", .@"11" => {
                if (fields.next() != null) return false;
                const color = vt.color.RGB.parse(entry) catch return false;
                if (kind == .@"10") t.foreground = color else t.background = color;
            },
        }
        return true;
    }
};

/// Remove host color and graphics replies from terminal input. Retain user
/// keystrokes, fragmented replies, and literal escape sequences in bracketed paste.
pub const Probe = struct {
    theme: Theme = .{},
    badge: corgi_badge.State = .{},
    changed: bool = false,
    paste: bool = false,
    pending: [128]u8 = undefined,
    len: usize = 0,
    touched: i64 = 0,

    pub fn feed(p: *Probe, bytes: []const u8, input: *std.ArrayList(u8)) !void {
        for (bytes) |byte| {
            if (p.len == 0 and byte != 0x1b) {
                try input.append(a, byte);
                continue;
            }
            p.pending[p.len] = byte;
            p.len += 1;
            p.touched = std.time.milliTimestamp();
            const sequence = p.pending[0..p.len];
            const start = keys.paste_start;
            const end = keys.paste_end;
            if (std.mem.eql(u8, sequence, start) or std.mem.eql(u8, sequence, end)) {
                p.paste = std.mem.eql(u8, sequence, start);
                try p.flush(input);
                continue;
            }
            if (std.mem.startsWith(u8, start, sequence) or std.mem.startsWith(u8, end, sequence)) continue;
            if (!p.paste) {
                const badge_prefix = corgi_badge.reply_prefix;
                if (std.mem.startsWith(u8, badge_prefix, sequence)) continue;
                if (std.mem.startsWith(u8, sequence, badge_prefix)) {
                    if (std.mem.endsWith(u8, sequence, "\x1b\\")) {
                        // Even a wrong image ID is a host reply, not user input.
                        // Only matching IDs may advance the badge state.
                        _ = p.badge.accept(sequence);
                        p.len = 0;
                        continue;
                    }
                    if (p.len < p.pending.len) continue;
                }
                var partial = false;
                var color = false;
                for ([_][]const u8{ "\x1b]10;", "\x1b]11;", "\x1b]4;" }) |prefix| {
                    partial = partial or std.mem.startsWith(u8, prefix, sequence);
                    color = color or std.mem.startsWith(u8, sequence, prefix);
                }
                if (partial) continue;
                if (color) {
                    const terminator: usize = if (byte == 7) 1 else if (std.mem.endsWith(u8, sequence, "\x1b\\")) 2 else 0;
                    if (terminator > 0) {
                        if (p.theme.accept(sequence[2 .. sequence.len - terminator])) {
                            p.changed = true;
                            p.len = 0;
                            continue;
                        }
                    } else if (p.len < p.pending.len) continue;
                }
            }
            try p.flush(input);
        }
    }
    fn flush(p: *Probe, input: *std.ArrayList(u8)) !void {
        try input.appendSlice(a, p.pending[0..p.len]);
        p.len = 0;
    }
    pub fn expire(p: *Probe, input: *std.ArrayList(u8)) !void {
        // An Escape key must not wait indefinitely for another input byte.
        if (p.len > 0 and std.time.milliTimestamp() - p.touched >= 100) try p.flush(input);
    }
    pub fn query(p: *Probe, input: *std.ArrayList(u8)) !void {
        try os.writeAll(1, "\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
        for (0..16) |i| {
            var buf: [32]u8 = undefined;
            try os.writeAll(1, try std.fmt.bufPrint(&buf, "\x1b]4;{d};?\x1b\\", .{i}));
        }
        const deadline = std.time.milliTimestamp() + 150;
        while (!p.theme.complete()) {
            const left = deadline - std.time.milliTimestamp();
            if (left <= 0) break;
            var poll = os.c.struct_pollfd{ .fd = 0, .events = os.c.POLLIN, .revents = 0 };
            if (os.c.poll(&poll, 1, @intCast(left)) <= 0 or poll.revents & os.c.POLLIN == 0) break;
            var buf: [4096]u8 = undefined;
            const n = os.c.read(0, &buf, buf.len);
            if (n <= 0) break;
            try p.feed(buf[0..@intCast(n)], input);
        }
        // Keep parsing late replies in the normal client loop.
        p.changed = false;
    }
};

test "host color probe separates fragmented replies from keys and paste" {
    var p: Probe = .{};
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    const bytes = "hi\x1b]10;rgb:aaaa/bbbb/cccc\x1b\\\x1b]11;rgb:12/34/56\x07\x1b]4;2;rgb:1/2/3\x07!";
    for (bytes) |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings("hi!", input.items);
    try std.testing.expectEqual(vt.color.RGB{ .r = 0xaa, .g = 0xbb, .b = 0xcc }, p.theme.foreground.?);
    try std.testing.expectEqual(vt.color.RGB{ .r = 0x12, .g = 0x34, .b = 0x56 }, p.theme.background.?);
    try std.testing.expectEqual(vt.color.RGB{ .r = 0x11, .g = 0x22, .b = 0x33 }, p.theme.palette[2].?);
    input.clearRetainingCapacity();
    const paste = "\x1b[200~\x1b]11;rgb:ff/ff/ff\x07\x1b[201~";
    for (paste) |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings(paste, input.items);
    try std.testing.expectEqual(@as(u8, 0x12), p.theme.background.?.r);
    input.clearRetainingCapacity();
    const unknown = "\x1b[A\x1b]11;broken\x07\x1b]52;abc\x07";
    try p.feed(unknown, &input);
    try std.testing.expectEqualStrings(unknown, input.items);
    try p.feed("\x1b", &input);
    p.touched -= 101;
    try p.expire(&input);
    try std.testing.expectEqualStrings(unknown ++ "\x1b", input.items);
}

test "badge replies are consumed across fragments but not inside pasted text" {
    var p: Probe = .{};
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    const reply = corgi_badge.reply_prefix ++ "i=730031;OK\x1b\\";
    for ("x" ++ reply ++ "y") |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings("xy", input.items);
    try std.testing.expect(p.badge.status == .supported);
    input.clearRetainingCapacity();
    const pasted = "\x1b[200~" ++ reply ++ "\x1b[201~";
    try p.feed(pasted, &input);
    try std.testing.expectEqualStrings(pasted, input.items);
}

test "graphics replies never leak into input and only matching IDs confirm the badge" {
    var p: Probe = .{};
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    p.badge.status = .confirming;
    const wrong = "\x1b_Gi=0;OK\x1b\\";
    const reply = "\x1b_Gp=1,i=730031;OK\x1b\\";
    for ("x" ++ wrong ++ "y") |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings("xy", input.items);
    try std.testing.expect(p.badge.status == .confirming);
    for (reply ++ "z") |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings("xyz", input.items);
    try std.testing.expect(p.badge.mode() == .image);
    try std.testing.expect(p.badge.supports_kitty_graphics);
    input.clearRetainingCapacity();
    const pasted = "\x1b[200~" ++ wrong ++ "\x1b[201~";
    for (pasted) |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings(pasted, input.items);
}
