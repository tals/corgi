//! Parses raw terminal escape sequences into a `Key` once, via a comptime
//! lookup, instead of scattered `eq(seq, "\x1b[A") or eq(seq, "\x1bOA")` chains.
//! Only sequences some call site actually compares are included; CSI and SS3
//! forms share one tag except where a call site deliberately distinguishes
//! them (those sites keep their own literal `std.mem.eql` checks).
const std = @import("std");

pub const Key = enum {
    up,
    down,
    left,
    right,
    page_up,
    page_down,
    home,
    end,
    shift_tab,
    focus_in,
    focus_out,
    paste_start,
    paste_end,
};

/// Bracketed-paste markers, shared with theme.zig's incremental byte scan.
pub const paste_start = "\x1b[200~";
pub const paste_end = "\x1b[201~";

const map = std.StaticStringMap(Key).initComptime(.{
    .{ "\x1b[A", .up },
    .{ "\x1bOA", .up },
    .{ "\x1b[B", .down },
    .{ "\x1bOB", .down },
    .{ "\x1b[C", .right },
    .{ "\x1b[D", .left },
    .{ "\x1b[5~", .page_up },
    .{ "\x1b[6~", .page_down },
    .{ "\x1b[H", .home },
    .{ "\x1bOH", .home },
    .{ "\x1b[1~", .home },
    .{ "\x1b[F", .end },
    .{ "\x1bOF", .end },
    .{ "\x1b[4~", .end },
    .{ "\x1b[Z", .shift_tab },
    .{ "\x1b[I", .focus_in },
    .{ "\x1b[O", .focus_out },
    .{ paste_start, .paste_start },
    .{ paste_end, .paste_end },
});

pub fn parse(seq: []const u8) ?Key {
    return map.get(seq);
}

test "parse recognizes CSI and SS3 forms, and rejects the unmapped" {
    try std.testing.expectEqual(Key.up, parse("\x1b[A").?);
    try std.testing.expectEqual(Key.up, parse("\x1bOA").?);
    try std.testing.expectEqual(Key.home, parse("\x1b[1~").?);
    try std.testing.expectEqual(Key.shift_tab, parse("\x1b[Z").?);
    try std.testing.expectEqual(Key.paste_start, parse(paste_start).?);
    try std.testing.expectEqual(Key.paste_end, parse(paste_end).?);
    try std.testing.expect(parse("\x1bOC") == null);
    try std.testing.expect(parse("\x1b[3~") == null);
    try std.testing.expect(parse("") == null);
}
