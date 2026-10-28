const std = @import("std");
const vt = @import("ghostty-vt");

pub const Key = struct {
    codepoint: u21,
    mods: vt.input.KeyMods,

    pub fn encode(self: Key, writer: *std.Io.Writer, options: vt.input.KeyEncodeOptions) !void {
        var utf8: [4]u8 = undefined;
        const functional = functionalKey(self.codepoint);
        const len = if (functional == null) try std.unicode.utf8Encode(self.codepoint, &utf8) else 0;
        var key = functional orelse vt.input.Key.unidentified;
        if (functional == null) {
            inline for (@typeInfo(vt.input.Key).@"enum".field_values) |value| {
                const candidate: vt.input.Key = @enumFromInt(value);
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
    for ([_]Key{
        .{ .codepoint = 13, .mods = .{ .shift = true } },
        .{ .codepoint = 13, .mods = .{ .ctrl = true } },
        .{ .codepoint = 13, .mods = .{ .super = true } },
        .{ .codepoint = 27, .mods = .{} },
    }, [_][]const u8{ "\x1b[13;2u", "\x1b[13;5u", "\x1b[13;9u", "\x1b[27u" }) |key, seq| {
        out.clearRetainingCapacity();
        try key.encode(&out.writer, .{ .kitty_flags = .{ .disambiguate = true } });
        try testing.expectEqualStrings(seq, out.written());
    }
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 13, .mods = .{ .shift = true } }).encode(&out.writer, .{});
    try testing.expectEqualStrings("\x1b[27;2;13~", out.written());
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 'b', .mods = .{ .ctrl = true } }).encode(&out.writer, .{});
    try testing.expectEqualStrings("\x02", out.written());
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 13, .mods = .{ .alt = true } }).encode(&out.writer, .{ .alt_esc_prefix = true });
    try testing.expectEqualStrings("\x1b\r", out.written());
}

test "arrows follow the pane application cursor mode" {
    var terminal = try vt.Terminal.init(std.testing.io, std.testing.allocator, .{ .cols = 80, .rows = 24 });
    defer terminal.deinit(std.testing.allocator);
    var stream = terminal.vtStream();
    defer stream.deinit();
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for ([_]bool{ true, false }) |application| {
        stream.nextSlice(if (application) "\x1b[?1h" else "\x1b[?1l");
        for ("ABCD", [_]u21{ 57352, 57353, 57351, 57350 }) |suffix, cp| {
            const expected = [_]u8{ 27, if (application) 'O' else '[', suffix };
            out.clearRetainingCapacity();
            try (Key{ .codepoint = cp, .mods = .{} }).encode(&out.writer, vt.input.KeyEncodeOptions.fromTerminal(&terminal));
            try std.testing.expectEqualStrings(&expected, out.written());
        }
    }
}

test "navigation keys use legacy and application cursor encodings" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try (Key{ .codepoint = 57352, .mods = .{ .ctrl = true } }).encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1b[1;5A", out.written());
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 57350, .mods = .{} }).encode(&out.writer, .{ .cursor_key_application = true });
    try std.testing.expectEqualStrings("\x1bOD", out.written());
}

test "function keys are encoded as keys rather than private-use text" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try (Key{ .codepoint = 57364, .mods = .{} }).encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1bOP", out.written());
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 57375, .mods = .{} }).encode(&out.writer, .{});
    try std.testing.expectEqualStrings("\x1b[24~", out.written());
}

test "F1 to F4 use the pane keyboard protocol" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for ("PQRS", [_]u21{ 57364, 57365, 57366, 57367 }) |suffix, cp| {
        const expected = [_]u8{ 27, 'O', suffix };
        out.clearRetainingCapacity();
        try (Key{ .codepoint = cp, .mods = .{} }).encode(&out.writer, .{});
        try std.testing.expectEqualStrings(&expected, out.written());
    }
    out.clearRetainingCapacity();
    try (Key{ .codepoint = 57364, .mods = .{} }).encode(&out.writer, .{ .kitty_flags = .{ .disambiguate = true } });
    try std.testing.expectEqualStrings("\x1b[P", out.written());
}
