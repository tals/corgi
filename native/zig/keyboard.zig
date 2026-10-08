const std = @import("std");
const vt = @import("ghostty-vt");

// Request only disambiguation: text/IME input stays text, and hosts do not
// send release events or alternate-key/associated-text fields.
pub const enable = "\x1b[>1u";
pub const disable = "\x1b[<u";

/// Kitty's codepoints for the arrow keys. `decode` reports plain cursor
/// keys with them too.
pub const arrow_left: u21 = 57350;
pub const arrow_right: u21 = 57351;
pub const arrow_up: u21 = 57352;
pub const arrow_down: u21 = 57353;
/// Kitty's codepoint for F1; F2 to F25 follow it.
pub const f1: u21 = 57364;

pub const Key = struct {
    codepoint: u21,
    mods: vt.input.KeyMods,

    pub fn encode(self: Key, writer: *std.Io.Writer, options: vt.input.KeyEncodeOptions) !void {
        var utf8: [4]u8 = undefined;
        const functional = functionalKey(self.codepoint);
        const len = if (functional == null) try std.unicode.utf8Encode(self.codepoint, &utf8) else 0;
        var key = functional orelse vt.input.Key.unidentified;
        if (functional == null) {
            inline for (std.meta.fields(vt.input.Key)) |field| {
                const candidate: vt.input.Key = @enumFromInt(field.value);
                if (comptime candidate.codepoint()) |cp| {
                    if (self.codepoint == cp) key = candidate;
                }
            }
        }
        var opts = options;
        opts.macos_option_as_alt = .true;
        try vt.input.encodeKey(writer, .{
            .key = key,
            .mods = self.mods,
            .utf8 = utf8[0..len],
            .unshifted_codepoint = self.codepoint,
        }, opts);
    }
};

// Decode ordinary cursor keys as well as CSI-u so the child's application
// cursor mode, rather than the host's mode, determines their encoding.
// Reject extensions we did not request instead of losing fields.
pub fn decode(bytes: []const u8) ?Key {
    if (bytes.len == 3 and bytes[0] == 27 and (bytes[1] == '[' or bytes[1] == 'O')) {
        const cp: u21 = switch (bytes[2]) {
            'A' => arrow_up,
            'B' => arrow_down,
            'C' => arrow_right,
            'D' => arrow_left,
            // F1 to F4: SS3 in legacy mode, CSI with Kitty keys on. Kitty
            // sends F3 as CSI 13~, since CSI R is a cursor position report.
            'P', 'Q', 'S' => f1 + (bytes[2] - 'P'),
            'R' => if (bytes[1] == 'O') f1 + 2 else return null,
            else => return null,
        };
        return .{ .codepoint = cp, .mods = .{} };
    }
    if (bytes.len < 4 or !std.mem.startsWith(u8, bytes, "\x1b[") or bytes[bytes.len - 1] != 'u') return null;
    var fields = std.mem.splitScalar(u8, bytes[2 .. bytes.len - 1], ';');
    const cp = std.fmt.parseInt(u21, fields.next() orelse return null, 10) catch return null;
    if (!std.unicode.utf8ValidCodepoint(cp)) return null;
    // Kitty reserves this private-use block for functional keys. Unknown
    // functions must stay encoded, never turn into private-use text.
    if (cp >= 57344 and cp <= 63743 and functionalKey(cp) == null) return null;
    const parameter = if (fields.next()) |value| std.fmt.parseInt(u9, value, 10) catch return null else 1;
    if (fields.next() != null or parameter == 0 or parameter > 256) return null;
    const mods = parameter - 1;
    // Ghostty has no Hyper/Meta representation; preserve those sequences.
    if (mods & 48 != 0) return null;
    return .{ .codepoint = cp, .mods = .{
        .shift = mods & 1 != 0,
        .alt = mods & 2 != 0,
        .ctrl = mods & 4 != 0,
        .super = mods & 8 != 0,
        .caps_lock = mods & 64 != 0,
        .num_lock = mods & 128 != 0,
    } };
}

fn functionalKey(cp: u21) ?vt.input.Key {
    return switch (cp) {
        27 => .escape,
        13 => .enter,
        9 => .tab,
        127 => .backspace,
        57344 => .escape,
        57345 => .enter,
        57346 => .tab,
        57347 => .backspace,
        57348 => .insert,
        57349 => .delete,
        57350 => .arrow_left,
        57351 => .arrow_right,
        57352 => .arrow_up,
        57353 => .arrow_down,
        57354 => .page_up,
        57355 => .page_down,
        57356 => .home,
        57357 => .end,
        57358 => .caps_lock,
        57359 => .scroll_lock,
        57360 => .num_lock,
        57361 => .print_screen,
        57362 => .pause,
        57363 => .context_menu,
        57364 => .f1,
        57365 => .f2,
        57366 => .f3,
        57367 => .f4,
        57368 => .f5,
        57369 => .f6,
        57370 => .f7,
        57371 => .f8,
        57372 => .f9,
        57373 => .f10,
        57374 => .f11,
        57375 => .f12,
        57376 => .f13,
        57377 => .f14,
        57378 => .f15,
        57379 => .f16,
        57380 => .f17,
        57381 => .f18,
        57382 => .f19,
        57383 => .f20,
        57384 => .f21,
        57385 => .f22,
        57386 => .f23,
        57387 => .f24,
        57388 => .f25,
        57399 => .numpad_0,
        57400 => .numpad_1,
        57401 => .numpad_2,
        57402 => .numpad_3,
        57403 => .numpad_4,
        57404 => .numpad_5,
        57405 => .numpad_6,
        57406 => .numpad_7,
        57407 => .numpad_8,
        57408 => .numpad_9,
        57409 => .numpad_decimal,
        57410 => .numpad_divide,
        57411 => .numpad_multiply,
        57412 => .numpad_subtract,
        57413 => .numpad_add,
        57414 => .numpad_enter,
        57415 => .numpad_equal,
        57416 => .numpad_separator,
        57417 => .numpad_left,
        57418 => .numpad_right,
        57419 => .numpad_up,
        57420 => .numpad_down,
        57421 => .numpad_page_up,
        57422 => .numpad_page_down,
        57423 => .numpad_home,
        57424 => .numpad_end,
        57425 => .numpad_insert,
        57426 => .numpad_delete,
        57427 => .numpad_begin,
        57441 => .shift_left,
        57447 => .shift_right,
        57442 => .control_left,
        57448 => .control_right,
        57444 => .meta_left,
        57450 => .meta_right,
        57443 => .alt_left,
        57449 => .alt_right,
        else => null,
    };
}

test "modified Return uses the pane keyboard protocol" {
    const testing = std.testing;
    var out: std.Io.Writer.Allocating = .init(testing.allocator);
    defer out.deinit();
    for ([_][]const u8{ "\x1b[13;2u", "\x1b[13;5u", "\x1b[13;9u", "\x1b[27u" }) |seq| {
        out.clearRetainingCapacity();
        try decode(seq).?.encode(&out.writer, .{ .kitty_flags = .{ .disambiguate = true } });
        try testing.expectEqualStrings(seq, out.written());
    }
    out.clearRetainingCapacity();
    try decode("\x1b[13;2u").?.encode(&out.writer, .{});
    try testing.expectEqualStrings("\x1b[27;2;13~", out.written());
    out.clearRetainingCapacity();
    try decode("\x1b[98;5u").?.encode(&out.writer, .{});
    try testing.expectEqualStrings("\x02", out.written());
    out.clearRetainingCapacity();
    try decode("\x1b[13;3u").?.encode(&out.writer, .{ .alt_esc_prefix = true });
    try testing.expectEqualStrings("\x1b\r", out.written());
}

test "unsupported and malformed CSI-u remains untouched" {
    for ([_][]const u8{ "\x1b[1;5A", "\x1b[?1u", "\x1b[13;0u", "\x1b[13;257u", "\x1b[13;2:3u", "\x1b[13:10;2u", "\x1b[55296u", "\x1b[1114112u", "\x1b[13;17u" }) |seq| {
        try std.testing.expect(decode(seq) == null);
    }
}

test "ordinary arrows follow the pane application cursor mode in both directions" {
    var terminal = try vt.Terminal.init(std.testing.io, std.testing.allocator, .{ .cols = 80, .rows = 24 });
    defer terminal.deinit(std.testing.allocator);
    var stream = terminal.vtStream();
    defer stream.deinit();
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for ([_]bool{ true, false }) |application| {
        stream.nextSlice(if (application) "\x1b[?1h" else "\x1b[?1l");
        for ("ABCD") |suffix| {
            for ("[O") |prefix| {
                const incoming = [_]u8{ 27, prefix, suffix };
                const expected = [_]u8{ 27, if (application) 'O' else '[', suffix };
                out.clearRetainingCapacity();
                try decode(&incoming).?.encode(&out.writer, vt.input.KeyEncodeOptions.fromTerminal(&terminal));
                try std.testing.expectEqualStrings(&expected, out.written());
            }
        }
    }
}

test "CSI-u navigation keys use legacy and application cursor encodings" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try decode("\x1b[57352;5u").?.encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1b[1;5A", out.written());
    out.clearRetainingCapacity();
    try decode("\x1b[57350u").?.encode(&out.writer, .{ .cursor_key_application = true });
    try std.testing.expectEqualStrings("\x1bOD", out.written());
}

test "CSI-u function keys are encoded as keys rather than private-use text" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try decode("\x1b[57364u").?.encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1bOP", out.written());
    out.clearRetainingCapacity();
    try decode("\x1b[57375u").?.encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1b[24~", out.written());
    try std.testing.expect(decode("\x1b[57398u") == null);
}

test "F1 to F4 arrive in either host form and leave in the pane's" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for ([_][2][]const u8{
        .{ "\x1bOP", "\x1bOP" },
        .{ "\x1b[P", "\x1bOP" },
        .{ "\x1b[Q", "\x1bOQ" },
        .{ "\x1bOR", "\x1bOR" },
        .{ "\x1b[S", "\x1bOS" },
    }) |case| {
        out.clearRetainingCapacity();
        try decode(case[0]).?.encode(&out.writer, .{});
        try std.testing.expectEqualStrings(case[1], out.written());
    }
    out.clearRetainingCapacity();
    try decode("\x1bOP").?.encode(&out.writer, .{ .kitty_flags = .{ .disambiguate = true } });
    try std.testing.expectEqualStrings("\x1b[P", out.written());
    // A cursor position report, not F3.
    try std.testing.expect(decode("\x1b[R") == null);
}
