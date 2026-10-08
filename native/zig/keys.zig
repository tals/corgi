//! Parses raw terminal escape sequences into a `Key` once, via a comptime
//! lookup, instead of scattered `eq(seq, "\x1b[A") or eq(seq, "\x1bOA")` chains.
//! Only sequences some call site actually compares are included; CSI and SS3
//! forms share one tag except where a call site deliberately distinguishes
//! them (those sites keep their own literal `std.mem.eql` checks).
const std = @import("std");
const vt = @import("ghostty-vt");
const keyboard = @import("keyboard.zig");

pub const Key = enum {
    up,
    down,
    left,
    right,
    page_up,
    page_down,
    home,
    end,
    delete,
    shift_tab,
    focus_in,
    focus_out,
    paste_start,
    paste_end,
};

/// Bracketed-paste markers, shared with host_probe.zig's incremental byte scan.
pub const paste_start = "\x1b[200~";
pub const paste_end = "\x1b[201~";

const map = std.StaticStringMap(Key).initComptime(.{
    .{ "\x1b[A", .up },
    .{ "\x1bOA", .up },
    .{ "\x1b[B", .down },
    .{ "\x1bOB", .down },
    .{ "\x1b[C", .right },
    .{ "\x1bOC", .right },
    .{ "\x1b[D", .left },
    .{ "\x1bOD", .left },
    .{ "\x1b[5~", .page_up },
    .{ "\x1b[6~", .page_down },
    .{ "\x1b[H", .home },
    .{ "\x1bOH", .home },
    .{ "\x1b[1~", .home },
    .{ "\x1b[F", .end },
    .{ "\x1bOF", .end },
    .{ "\x1b[4~", .end },
    .{ "\x1b[3~", .delete },
    .{ "\x1b[Z", .shift_tab },
    .{ "\x1b[I", .focus_in },
    .{ "\x1b[O", .focus_out },
    .{ paste_start, .paste_start },
    .{ paste_end, .paste_end },
});

pub fn parse(seq: []const u8) ?Key {
    return map.get(seq);
}

const named_keys = std.StaticStringMap(u21).initComptime(.{
    .{ "esc", 27 },
    .{ "enter", 13 },
    .{ "tab", 9 },
    .{ "backspace", 127 },
    .{ "left", 57350 },
    .{ "right", 57351 },
    .{ "up", 57352 },
    .{ "down", 57353 },
    .{ "home", 57356 },
    .{ "end", 57357 },
    .{ "delete", 57349 },
    .{ "pageup", 57354 },
    .{ "pagedown", 57355 },
    .{ "space", 32 },
});
/// A key named on the command line (`enter`, `ctrl+c`, `a`) as the pane receives it.
pub fn logicalKey(name: []const u8) !keyboard.Key {
    var mods: vt.input.KeyMods = .{};
    var key = name;
    while (std.mem.indexOfScalar(u8, key, '+')) |i| {
        switch (std.meta.stringToEnum(enum { ctrl, alt, shift }, key[0..i]) orelse return error.InvalidKey) {
            inline else => |m| @field(mods, @tagName(m)) = true,
        }
        key = key[i + 1 ..];
    }
    if (named_keys.get(key)) |cp| return .{ .codepoint = cp, .mods = mods };
    if (key.len == 1 and key[0] >= 32 and key[0] < 127) return .{ .codepoint = key[0], .mods = mods };
    return error.InvalidKey;
}

test "parse recognizes CSI and SS3 forms, and rejects the unmapped" {
    try std.testing.expectEqual(Key.up, parse("\x1b[A").?);
    try std.testing.expectEqual(Key.up, parse("\x1bOA").?);
    try std.testing.expectEqual(Key.right, parse("\x1b[C").?);
    try std.testing.expectEqual(Key.right, parse("\x1bOC").?);
    try std.testing.expectEqual(Key.left, parse("\x1b[D").?);
    try std.testing.expectEqual(Key.left, parse("\x1bOD").?);
    try std.testing.expectEqual(Key.home, parse("\x1b[1~").?);
    try std.testing.expectEqual(Key.end, parse("\x1b[4~").?);
    try std.testing.expectEqual(Key.delete, parse("\x1b[3~").?);
    try std.testing.expectEqual(Key.shift_tab, parse("\x1b[Z").?);
    try std.testing.expectEqual(Key.paste_start, parse(paste_start).?);
    try std.testing.expectEqual(Key.paste_end, parse(paste_end).?);
    try std.testing.expectEqual(Key.down, parse("\x1bOB").?);
    try std.testing.expect(parse("\x1b[9~") == null);
    try std.testing.expect(parse("") == null);
}
