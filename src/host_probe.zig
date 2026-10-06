//! The viewer's scan of its input for host terminal replies: default colors,
//! the ANSI palette, graphics support and the clipboard protocol.
const std = @import("std");
const vt = @import("ghostty-vt");
const os = @import("os.zig");
const keys = @import("keys.zig");
const corgi_badge = @import("corgi_badge.zig");
const host_clipboard = @import("host_clipboard.zig");
const Theme = @import("theme.zig").Theme;
const a = os.allocator;

const clipboard_prefix = "\x1b]5522;";
/// DECRQM's answer for paste events, and XTVERSION's.
const mode_prefix = "\x1b[?5522;";
const version_prefix = "\x1bP>|";
/// Clipboard packets carry 4 KiB of data each, base64 encoded.
const max_packet = 16 * 1024;

/// Remove host replies from terminal input. Retain user keystrokes,
/// fragmented replies, and literal escape sequences in bracketed paste.
pub const Probe = struct {
    theme: Theme = .{},
    badge: corgi_badge.State = .{},
    clipboard: host_clipboard.State = .{},
    changed: bool = false,
    paste: bool = false,
    pending: [128]u8 = undefined,
    len: usize = 0,
    touched: i64 = 0,
    /// A clipboard packet being received; it outgrows `pending`.
    packet: std.ArrayList(u8) = .empty,
    in_packet: bool = false,
    /// The packet's last byte was the ESC of its terminator.
    packet_escape: bool = false,

    pub fn deinit(p: *Probe) void {
        p.packet.deinit(a);
        p.clipboard.deinit();
    }

    pub fn feed(p: *Probe, bytes: []const u8, input: *std.ArrayList(u8)) !void {
        var rest = bytes;
        while (rest.len > 0) {
            if (p.in_packet) {
                rest = rest[try p.collect(rest)..];
                continue;
            }
            try p.scan(rest[0], input);
            rest = rest[1..];
        }
    }
    fn scan(p: *Probe, byte: u8, input: *std.ArrayList(u8)) !void {
        if (p.len == 0 and byte != 0x1b) return input.append(a, byte);
        p.pending[p.len] = byte;
        p.len += 1;
        p.touched = os.milliTimestamp();
        const sequence = p.pending[0..p.len];
        const start = keys.paste_start;
        const end = keys.paste_end;
        if (std.mem.eql(u8, sequence, start) or std.mem.eql(u8, sequence, end)) {
            p.paste = std.mem.eql(u8, sequence, start);
            return p.flush(input);
        }
        if (std.mem.startsWith(u8, start, sequence) or std.mem.startsWith(u8, end, sequence)) return;
        if (!p.paste) {
            const badge_prefix = corgi_badge.reply_prefix;
            if (std.mem.startsWith(u8, badge_prefix, sequence)) return;
            if (std.mem.startsWith(u8, sequence, badge_prefix)) {
                if (std.mem.endsWith(u8, sequence, "\x1b\\")) {
                    // Even a wrong image ID is a host reply, not user input.
                    // Only matching IDs may advance the badge state.
                    _ = p.badge.accept(sequence);
                    p.len = 0;
                    return;
                }
                if (p.len < p.pending.len) return;
            }
            if (std.mem.eql(u8, sequence, clipboard_prefix)) {
                p.len = 0;
                p.in_packet = true;
                p.packet.clearRetainingCapacity();
                return;
            }
            if (std.mem.startsWith(u8, sequence, mode_prefix)) {
                if (byte == 'y') {
                    const digits = sequence[mode_prefix.len..];
                    const value = std.fmt.parseInt(u8, digits[0..(std.mem.indexOfScalar(u8, digits, '$') orelse digits.len)], 10) catch 0;
                    try p.clipboard.modeReport(value, os.milliTimestamp());
                    p.len = 0;
                    return;
                }
                if (p.len < 16) return;
            }
            if (std.mem.startsWith(u8, sequence, version_prefix)) {
                if (std.mem.endsWith(u8, sequence, "\x1b\\")) {
                    p.clipboard.terminalName(sequence[version_prefix.len .. sequence.len - 2]);
                    p.len = 0;
                    return;
                }
                if (p.len < p.pending.len) return;
            }
            var partial = false;
            var color = false;
            for ([_][]const u8{ "\x1b]10;", "\x1b]11;", "\x1b]4;", clipboard_prefix, mode_prefix, version_prefix }, 0..) |prefix, i| {
                partial = partial or std.mem.startsWith(u8, prefix, sequence);
                color = color or (i < 3 and std.mem.startsWith(u8, sequence, prefix));
            }
            if (partial) return;
            if (color) {
                const terminator: usize = if (byte == 7) 1 else if (std.mem.endsWith(u8, sequence, "\x1b\\")) 2 else 0;
                if (terminator > 0) {
                    if (p.theme.accept(sequence[2 .. sequence.len - terminator])) {
                        p.changed = true;
                        p.len = 0;
                        return;
                    }
                } else if (p.len < p.pending.len) return;
            }
        }
        try p.flush(input);
    }
    /// Adds bytes to the packet up to its terminator; returns how many it used.
    fn collect(p: *Probe, bytes: []const u8) !usize {
        p.touched = os.milliTimestamp();
        if (p.packet_escape) {
            p.packet_escape = false;
            if (bytes[0] == '\\') {
                try p.finishPacket();
                return 1;
            }
            // Not a terminator: the ESC began something new, so the packet
            // was cut short.
            p.in_packet = false;
            p.pending[0] = 0x1b;
            p.len = 1;
            return 0;
        }
        const end = std.mem.indexOfAny(u8, bytes, "\x07\x1b") orelse bytes.len;
        // An oversized packet is still consumed, then dropped.
        if (p.packet.items.len <= max_packet) try p.packet.appendSlice(a, bytes[0..@min(end, max_packet + 1 - p.packet.items.len)]);
        if (end == bytes.len) return end;
        if (bytes[end] == 0x07) try p.finishPacket() else p.packet_escape = true;
        return end + 1;
    }
    fn finishPacket(p: *Probe) !void {
        p.in_packet = false;
        if (p.packet.items.len <= max_packet) try p.clipboard.packet(p.packet.items, os.milliTimestamp());
    }
    fn flush(p: *Probe, input: *std.ArrayList(u8)) !void {
        try input.appendSlice(a, p.pending[0..p.len]);
        p.len = 0;
    }
    pub fn expire(p: *Probe, input: *std.ArrayList(u8)) !void {
        // An Escape key must not wait indefinitely for another input byte.
        if (p.len > 0 and os.milliTimestamp() - p.touched >= 100) try p.flush(input);
        // Nor may a packet that never ends hold back later keys.
        if (p.in_packet and os.milliTimestamp() - p.touched >= 10_000) {
            p.in_packet = false;
            p.packet_escape = false;
        }
    }
    pub fn query(p: *Probe, input: *std.ArrayList(u8)) !void {
        try os.writeAll(1, "\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
        for (0..16) |i| {
            var buf: [32]u8 = undefined;
            try os.writeAll(1, try std.fmt.bufPrint(&buf, "\x1b]4;{d};?\x1b\\", .{i}));
        }
        const deadline = os.milliTimestamp() + 150;
        while (!p.theme.complete()) {
            const left = deadline - os.milliTimestamp();
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

test "clipboard packets and their questions' answers never reach the keys" {
    var p: Probe = .{};
    defer p.deinit();
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    try p.clipboard.start(os.milliTimestamp());
    p.clipboard.out.clearRetainingCapacity();
    const replies = "a\x1bP>|ghostty 1.3.2\x1b\\b\x1b[?5522;2$yc" ++
        "\x1b]5522;type=read:status=OK:id=corgi-probe\x07" ++
        "\x1b]5522;type=read:status=DATA:id=corgi-probe:mime=Lg==;aW1hZ2UvcG5nCg==\x1b\\" ++
        "\x1b]5522;type=read:status=DONE:id=corgi-probe\x1b\\d";
    for (replies) |byte| try p.feed(&.{byte}, &input);
    try std.testing.expectEqualStrings("abcd", input.items);
    try std.testing.expectEqualStrings("ghostty 1.3.2", p.clipboard.terminal.text());
    try std.testing.expect(p.clipboard.support == .on);
    input.clearRetainingCapacity();

    // A packet longer than the reply buffer arrives in one piece.
    const long = "\x1b]5522;type=read:status=DATA:id=x;" ++ "A" ** 600 ++ "\x1b\\";
    try p.feed("e" ++ long ++ "f", &input);
    try std.testing.expectEqualStrings("ef", input.items);
    input.clearRetainingCapacity();

    // An ESC that isn't the terminator cuts the packet short and is kept.
    try p.feed("\x1b]5522;type=read\x1b[A", &input);
    try std.testing.expectEqualStrings("\x1b[A", input.items);
    input.clearRetainingCapacity();

    const pasted = "\x1b[200~\x1b]5522;type=read:status=OK\x07\x1b[?5522;1$y\x1b[201~";
    try p.feed(pasted, &input);
    try std.testing.expectEqualStrings(pasted, input.items);
}
