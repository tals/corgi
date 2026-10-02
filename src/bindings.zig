//! Every keyboard shortcut, per preset. The first binding listed for an
//! action is the one shown for it.
const std = @import("std");
const keyboard = @import("keyboard.zig");
const keymap = @import("keymap.zig");
const Action = @import("action.zig").Action;
const Preset = keymap.Preset;

pub const Mods = packed struct(u4) {
    // Kitty's modifier bits: the CSI-u parameter is this value plus one.
    shift: bool = false,
    alt: bool = false,
    ctrl: bool = false,
    super: bool = false,
};
pub const Binding = struct {
    /// A printable character, a control byte (9 is Tab, 1 is Ctrl+A) or
    /// one of Kitty's functional keys, such as `keyboard.arrow_up`.
    key: u21,
    mods: Mods = .{},
    /// False for a key held down on its own, such as cmux's Cmd+T.
    prefixed: bool = true,
    action: Action,

    /// The key as the help screen shows it: "c", "Tab", "Ctrl+T",
    /// "Cmd+Shift+]".
    pub fn format(b: Binding, w: *std.Io.Writer) std.Io.Writer.Error!void {
        if (b.mods.super) try w.writeAll("Cmd+");
        if (b.mods.alt) try w.writeAll("Opt+");
        if (b.mods.ctrl) try w.writeAll("Ctrl+");
        if (b.mods.shift) try w.writeAll("Shift+");
        switch (b.key) {
            9 => try w.writeAll("Tab"),
            13 => try w.writeAll("Enter"),
            1...8, 10...12, 14...26 => try w.print("Ctrl+{c}", .{@as(u8, @intCast(b.key)) + '@'}),
            keyboard.arrow_left => try w.writeAll("←"),
            keyboard.arrow_right => try w.writeAll("→"),
            keyboard.arrow_up => try w.writeAll("↑"),
            keyboard.arrow_down => try w.writeAll("↓"),
            keyboard.f1...keyboard.f1 + 24 => try w.print("F{d}", .{b.key - keyboard.f1 + 1}),
            // A held letter names the key; a typed one is the character.
            'a'...'z' => try w.writeByte(@intCast(if (b.mods == Mods{}) b.key else b.key - 32)),
            else => try w.print("{u}", .{b.key}),
        }
    }
};
/// The key in a cell or two, for cards that say which modifier to hold:
/// `v`, `%`, `D`, `⇧D`, `↑`. Shift is the only modifier it shows.
pub const Compact = struct {
    binding: Binding,
    pub fn format(c: Compact, w: *std.Io.Writer) std.Io.Writer.Error!void {
        const b = c.binding;
        if (b.mods.shift) try w.writeAll("⇧");
        const letter = b.mods != Mods{} and b.key >= 'a' and b.key <= 'z';
        try (Binding{ .key = if (letter) b.key - 32 else b.key, .action = b.action }).format(w);
    }
};
pub fn compact(b: Binding) Compact {
    return .{ .binding = b };
}
/// Prints what `corgi keys` shows and the docs keep: a Markdown table with
/// a row per action and a column per preset. Digit runs share a cell.
pub fn writeTable(w: *std.Io.Writer, presets: []const Preset) !void {
    try w.writeAll("| Action |");
    for (presets) |preset| try w.print(" {s} |", .{keymap.name(preset)});
    try w.writeAll("\n| --- |");
    for (presets) |_| try w.writeAll(" --- |");
    try w.writeByte('\n');
    // Every action any listed preset binds, in the union's order.
    var rows: [128]Action = undefined;
    var count: usize = 0;
    inline for (@typeInfo(Action).@"union".fields) |field| {
        const values: []const Action = switch (@typeInfo(field.type)) {
            .void => &.{@unionInit(Action, field.name, {})},
            .@"enum" => |e| comptime blk: {
                var all: [e.fields.len]Action = undefined;
                for (e.fields, &all) |f, *act| act.* = @unionInit(Action, field.name, @enumFromInt(f.value));
                const done = all;
                break :blk &done;
            },
            .int => &.{@unionInit(Action, field.name, 1)},
            else => &.{},
        };
        for (values) |act| {
            for (presets) |preset| if (cell(preset, act) != null) {
                rows[count] = act;
                count += 1;
                break;
            };
        }
    }
    for (rows[0..count]) |act| {
        try w.print("| {s} |", .{act.title()});
        for (presets) |preset| {
            try w.writeByte(' ');
            try writeCell(w, preset, act);
            try w.writeAll(" |");
        }
        try w.writeByte('\n');
    }
}
/// Whether a binding belongs in `act`'s row: numbered actions share one.
fn sameRow(b: Binding, act: Action) bool {
    return switch (act) {
        .tab, .@"goto-workspace" => std.meta.activeTag(b.action) == std.meta.activeTag(act),
        else => std.meta.eql(b.action, act),
    };
}
fn cell(preset: Preset, act: Action) ?Binding {
    for (table(preset)) |b| if (sameRow(b, act)) return b;
    return null;
}
fn writeCell(w: *std.Io.Writer, preset: Preset, act: Action) !void {
    const list = table(preset);
    var written = false;
    var i: usize = 0;
    while (i < list.len) : (i += 1) {
        const b = list[i];
        if (!sameRow(b, act)) continue;
        // A run of digits with consecutive numbers: `prefix 1–9`.
        var last = i;
        while (last + 1 < list.len and sameRow(list[last + 1], act) and list[last + 1].key == list[last].key + 1 and
            list[last + 1].mods == b.mods and list[last + 1].prefixed == b.prefixed) last += 1;
        if (written) try w.writeAll(", ");
        written = true;
        try w.print("`{s}{f}", .{ if (b.prefixed) "prefix " else "", b });
        if (last > i) try w.print("–{u}", .{list[last].key});
        try w.writeByte('`');
        i = last;
    }
}
/// Whether a key reaches the viewer as one byte, not a sequence.
fn plain(key: u21, mods: Mods) bool {
    return key < 0x80 and mods == Mods{};
}

const ctrl: Mods = .{ .ctrl = true };
const ctrl_shift: Mods = .{ .ctrl = true, .shift = true };
const cmd: Mods = .{ .super = true };
const cmd_shift: Mods = .{ .super = true, .shift = true };
const cmd_alt: Mods = .{ .super = true, .alt = true };

fn held(key: u21, mods: Mods, action: Action) Binding {
    return .{ .key = key, .mods = mods, .prefixed = false, .action = action };
}
/// `count` digit keys from `zero`, for tabs or workspaces 1, 2, ...
fn digits(comptime zero: u8, comptime count: usize, comptime mods: Mods, comptime prefixed: bool, comptime tag: std.meta.Tag(Action)) [count]Binding {
    var out: [count]Binding = undefined;
    for (&out, 0..) |*b, i| b.* = .{ .key = zero + i, .mods = mods, .prefixed = prefixed, .action = @unionInit(Action, @tagName(tag), i + 1) };
    return out;
}

/// The Corgi preset's prefixed keys, which cmux shares.
const corgi_keys = [_]Binding{
    .{ .key = 'c', .action = .new },
    .{ .key = 'n', .action = .next },
    .{ .key = 'p', .action = .prev },
} ++ digits('1', 9, .{}, true, .tab) ++ [_]Binding{
    .{ .key = 'T', .action = .@"rename-tab" },
    .{ .key = 'X', .action = .@"close-tab" },
    .{ .key = 'w', .action = .@"new-workspace" },
    .{ .key = 'W', .action = .@"edit-workspace" },
    .{ .key = '}', .action = .@"workspace-next" },
    .{ .key = '{', .action = .@"workspace-prev" },
    .{ .key = 'g', .action = .@"find-agent" },
    .{ .key = ']', .action = .@"next-agent" },
    .{ .key = '[', .action = .@"prev-agent" },
    .{ .key = 9, .action = .@"last-agent" },
    .{ .key = 'f', .action = .attention },
    .{ .key = 'a', .action = .@"new-agent" },
    .{ .key = 'm', .action = .mute },
    .{ .key = 'h', .action = .{ .focus = .left } },
    .{ .key = 'j', .action = .{ .focus = .down } },
    .{ .key = 'k', .action = .{ .focus = .up } },
    .{ .key = 'l', .action = .{ .focus = .right } },
    .{ .key = 'H', .action = .{ .swap = .left } },
    .{ .key = 'J', .action = .{ .swap = .down } },
    .{ .key = 'K', .action = .{ .swap = .up } },
    .{ .key = 'L', .action = .{ .swap = .right } },
    .{ .key = 'v', .action = .{ .split = .right } },
    .{ .key = '-', .action = .{ .split = .down } },
    .{ .key = 'r', .action = .@"resize-mode" },
    .{ .key = 'z', .action = .zoom },
    .{ .key = '!', .action = .@"break" },
    .{ .key = 'x', .action = .close },
    .{ .key = 'u', .action = .@"undo-close" },
    .{ .key = 's', .action = .@"copy-mode" },
    .{ .key = 'q', .action = .detach },
    .{ .key = 'b', .action = .sidebar },
    .{ .key = 'i', .action = .setup },
    .{ .key = '?', .action = .help },
    // tmux's spellings, which the Corgi preset has always accepted too.
    .{ .key = '%', .action = .{ .split = .right } },
    .{ .key = '"', .action = .{ .split = .down } },
    .{ .key = ',', .action = .@"rename-tab" },
    .{ .key = 'C', .action = .setup },
    .{ .key = 'd', .action = .detach },
    .{ .key = 'A', .action = .@"new-agent" },
    .{ .key = 1, .action = .@"new-agent" },
};
const corgi = corgi_keys ++ [_]Binding{
    .{ .key = 20, .prefixed = false, .action = .new },
    held('t', ctrl_shift, .@"undo-close"),
    held('t', cmd_shift, .@"undo-close"),
    held(keyboard.f1, .{}, .attention),
};

const tmux = [_]Binding{
    .{ .key = 'c', .action = .new },
    .{ .key = 'n', .action = .next },
    .{ .key = 'p', .action = .prev },
} ++ digits('0', 10, .{}, true, .tab) ++ [_]Binding{
    .{ .key = ',', .action = .@"rename-tab" },
    .{ .key = '&', .action = .@"close-tab" },
    .{ .key = 'N', .action = .@"new-workspace" },
    .{ .key = '$', .action = .@"edit-workspace" },
    .{ .key = '}', .action = .@"workspace-next" },
    .{ .key = '{', .action = .@"workspace-prev" },
    .{ .key = 's', .action = .@"choose-workspace" },
    .{ .key = 'G', .action = .@"find-agent" },
    .{ .key = 'F', .action = .attention },
    .{ .key = 'a', .action = .@"new-agent" },
    .{ .key = 'm', .action = .mute },
    .{ .key = keyboard.arrow_left, .action = .{ .focus = .left } },
    .{ .key = keyboard.arrow_down, .action = .{ .focus = .down } },
    .{ .key = keyboard.arrow_up, .action = .{ .focus = .up } },
    .{ .key = keyboard.arrow_right, .action = .{ .focus = .right } },
    .{ .key = 'o', .action = .@"next-pane" },
    .{ .key = '%', .action = .{ .split = .right } },
    .{ .key = '"', .action = .{ .split = .down } },
    .{ .key = keyboard.arrow_left, .mods = ctrl, .action = .{ .resize = .left } },
    .{ .key = keyboard.arrow_down, .mods = ctrl, .action = .{ .resize = .down } },
    .{ .key = keyboard.arrow_up, .mods = ctrl, .action = .{ .resize = .up } },
    .{ .key = keyboard.arrow_right, .mods = ctrl, .action = .{ .resize = .right } },
    .{ .key = 'z', .action = .zoom },
    .{ .key = '!', .action = .@"break" },
    .{ .key = 'x', .action = .close },
    .{ .key = 'u', .action = .@"undo-close" },
    .{ .key = '[', .action = .@"copy-mode" },
    .{ .key = ']', .action = .paste },
    .{ .key = 'd', .action = .detach },
    .{ .key = 'b', .action = .sidebar },
    .{ .key = 'C', .action = .setup },
    .{ .key = '?', .action = .help },
};

const herdr = [_]Binding{
    .{ .key = 'c', .action = .new },
    .{ .key = 'n', .action = .next },
    .{ .key = 'p', .action = .prev },
} ++ digits('1', 9, .{}, true, .tab) ++ [_]Binding{
    .{ .key = 'T', .action = .@"rename-tab" },
    .{ .key = 'X', .action = .@"close-tab" },
    .{ .key = 'N', .action = .@"new-workspace" },
    .{ .key = 'W', .action = .@"edit-workspace" },
    .{ .key = '}', .action = .@"workspace-next" },
    .{ .key = '{', .action = .@"workspace-prev" },
    .{ .key = 'w', .action = .@"choose-workspace" },
    .{ .key = 'g', .action = .@"choose-workspace" },
    .{ .key = 'D', .action = .@"close-workspace" },
    .{ .key = 'f', .action = .@"find-agent" },
    .{ .key = 'o', .action = .attention },
    .{ .key = 'a', .action = .@"new-agent" },
    .{ .key = 'm', .action = .mute },
    .{ .key = 'h', .action = .{ .focus = .left } },
    .{ .key = 'j', .action = .{ .focus = .down } },
    .{ .key = 'k', .action = .{ .focus = .up } },
    .{ .key = 'l', .action = .{ .focus = .right } },
    .{ .key = 'H', .action = .{ .swap = .left } },
    .{ .key = 'J', .action = .{ .swap = .down } },
    .{ .key = 'K', .action = .{ .swap = .up } },
    .{ .key = 'L', .action = .{ .swap = .right } },
    .{ .key = 9, .action = .@"next-pane" },
    .{ .key = 9, .mods = .{ .shift = true }, .action = .@"prev-pane" },
    .{ .key = 'v', .action = .{ .split = .right } },
    .{ .key = '-', .action = .{ .split = .down } },
    .{ .key = 'r', .action = .@"resize-mode" },
    .{ .key = 'z', .action = .zoom },
    .{ .key = '!', .action = .@"break" },
    .{ .key = 'x', .action = .close },
    .{ .key = 'u', .action = .@"undo-close" },
    .{ .key = '[', .action = .@"copy-mode" },
    .{ .key = 'q', .action = .detach },
    .{ .key = 'b', .action = .sidebar },
    .{ .key = 's', .action = .setup },
    .{ .key = '?', .action = .help },
};

/// cmux's held keys arrive as Kitty sequences, some typed by the Ghostty
/// integration block. They come first so they are the ones shown; the
/// Corgi preset's keys still work after the prefix.
const cmux = [_]Binding{
    held('t', cmd, .new),
    held(']', cmd_shift, .next),
    held('[', cmd_shift, .prev),
} ++ digits('1', 9, ctrl, false, .tab) ++ [_]Binding{
    held('r', cmd, .@"rename-tab"),
    held('n', cmd, .@"new-workspace"),
    held('r', cmd_shift, .@"edit-workspace"),
    held('p', cmd, .@"choose-workspace"),
    held('w', cmd_shift, .@"close-workspace"),
} ++ digits('1', 9, cmd, false, .@"goto-workspace") ++ [_]Binding{
    held('p', cmd_shift, .@"find-agent"),
    held('u', cmd_shift, .attention),
    held(keyboard.arrow_left, cmd_alt, .{ .focus = .left }),
    held(keyboard.arrow_down, cmd_alt, .{ .focus = .down }),
    held(keyboard.arrow_up, cmd_alt, .{ .focus = .up }),
    held(keyboard.arrow_right, cmd_alt, .{ .focus = .right }),
    held('d', cmd, .{ .split = .right }),
    held('d', cmd_shift, .{ .split = .down }),
    held('h', ctrl_shift, .{ .resize = .left }),
    held('j', ctrl_shift, .{ .resize = .down }),
    held('k', ctrl_shift, .{ .resize = .up }),
    held('l', ctrl_shift, .{ .resize = .right }),
    held(13, cmd_shift, .zoom),
    held('w', cmd, .close),
    held('t', cmd_shift, .@"undo-close"),
    held('m', cmd_shift, .@"copy-mode"),
    held('b', cmd, .sidebar),
    held(',', cmd, .setup),
} ++ corgi_keys;

pub fn table(preset: Preset) []const Binding {
    return switch (preset) {
        .corgi => &corgi,
        .tmux => &tmux,
        .herdr => &herdr,
        .cmux => &cmux,
    };
}

/// The action bound to a key, or null to pass the key on.
pub fn lookup(preset: Preset, prefixed: bool, key: u21, mods: Mods) ?Action {
    for (table(preset)) |b| {
        if (b.prefixed == prefixed and b.key == key and b.mods == mods) return b.action;
    }
    return null;
}

/// The action for a key that arrived as an escape sequence. Held keys work
/// with a prefix pending too. Keys that also exist as one byte are left to
/// the byte path.
pub fn chord(preset: Preset, prefixed: bool, k: keyboard.Key) ?Action {
    const key: u21 = switch (k.codepoint) {
        'A'...'Z' => k.codepoint + 32,
        '}' => if (k.mods.shift) ']' else '}',
        '{' => if (k.mods.shift) '[' else '{',
        // Kitty's functional codes for Enter and Tab.
        57345 => 13,
        57346 => 9,
        else => k.codepoint,
    };
    const mods: Mods = .{ .shift = k.mods.shift, .alt = k.mods.alt, .ctrl = k.mods.ctrl, .super = k.mods.super };
    if (plain(key, mods)) return null;
    if (prefixed) if (lookup(preset, true, key, mods)) |act| return act;
    return lookup(preset, false, key, mods);
}

/// The action for a sequence after the prefix. Terminals send modified
/// arrows (`\x1b[1;5A`) and Shift+Tab (`\x1b[Z`) this way even with
/// Kitty keys on.
pub fn prefixedSequence(preset: Preset, seq: []const u8) ?Action {
    if (std.mem.eql(u8, seq, "\x1b[Z")) return lookup(preset, true, 9, .{ .shift = true });
    if (seq.len != 6 or !std.mem.startsWith(u8, seq, "\x1b[1;")) return null;
    const key = switch (seq[5]) {
        'A' => keyboard.arrow_up,
        'B' => keyboard.arrow_down,
        'C' => keyboard.arrow_right,
        'D' => keyboard.arrow_left,
        else => return null,
    };
    const parameter = std.fmt.charToDigit(seq[4], 10) catch return null;
    if (parameter < 2) return null;
    return lookup(preset, true, key, @bitCast(@as(u4, @intCast(parameter - 1))));
}

/// The binding shown for an action: the first one listed.
pub fn find(preset: Preset, action: Action) ?Binding {
    for (table(preset)) |b| if (std.meta.eql(b.action, action)) return b;
    return null;
}
/// The first binding for an action that follows the prefix, or is held.
pub fn first(preset: Preset, action: Action, prefixed: bool) ?Binding {
    for (table(preset)) |b| if (b.prefixed == prefixed and std.meta.eql(b.action, action)) return b;
    return null;
}

test "no preset binds a key twice" {
    for (std.enums.values(Preset)) |preset| {
        const list = table(preset);
        for (list, 0..) |b, i| for (list[i + 1 ..]) |other| {
            try std.testing.expect(!(b.key == other.key and b.mods == other.mods and b.prefixed == other.prefixed));
        };
    }
}

test "each action shows its first binding" {
    const Case = struct { preset: Preset, action: Action, key: u21, mods: Mods = .{}, prefixed: bool = true };
    for ([_]Case{
        .{ .preset = .corgi, .action = .new, .key = 'c' },
        .{ .preset = .corgi, .action = .{ .split = .right }, .key = 'v' },
        .{ .preset = .corgi, .action = .detach, .key = 'q' },
        .{ .preset = .tmux, .action = .{ .split = .right }, .key = '%' },
        .{ .preset = .tmux, .action = .{ .tab = 1 }, .key = '0' },
        .{ .preset = .herdr, .action = .@"choose-workspace", .key = 'w' },
        .{ .preset = .cmux, .action = .new, .key = 't', .mods = cmd, .prefixed = false },
        .{ .preset = .cmux, .action = .{ .tab = 3 }, .key = '3', .mods = ctrl, .prefixed = false },
        .{ .preset = .cmux, .action = .{ .swap = .up }, .key = 'K' },
    }) |case| {
        const b = find(case.preset, case.action).?;
        try std.testing.expectEqual(case.key, b.key);
        try std.testing.expectEqual(case.mods, b.mods);
        try std.testing.expectEqual(case.prefixed, b.prefixed);
    }
    try std.testing.expectEqual(null, find(.tmux, .@"resize-mode"));
}

test "keys are spelled the way the help screen shows them" {
    const Case = struct { binding: Binding, text: []const u8 };
    for ([_]Case{
        .{ .binding = .{ .key = 'c', .action = .new }, .text = "c" },
        .{ .binding = .{ .key = 'T', .action = .new }, .text = "T" },
        .{ .binding = .{ .key = 9, .action = .new }, .text = "Tab" },
        .{ .binding = .{ .key = 20, .action = .new }, .text = "Ctrl+T" },
        .{ .binding = held('t', cmd, .new), .text = "Cmd+T" },
        .{ .binding = held(']', cmd_shift, .new), .text = "Cmd+Shift+]" },
        .{ .binding = held(13, cmd_shift, .new), .text = "Cmd+Shift+Enter" },
        .{ .binding = .{ .key = 9, .mods = .{ .shift = true }, .action = .new }, .text = "Shift+Tab" },
        .{ .binding = .{ .key = keyboard.arrow_up, .mods = ctrl, .action = .new }, .text = "Ctrl+↑" },
        .{ .binding = held(keyboard.f1, .{}, .attention), .text = "F1" },
    }) |case| {
        var buf: [32]u8 = undefined;
        try std.testing.expectEqualStrings(case.text, try std.fmt.bufPrint(&buf, "{f}", .{case.binding}));
    }
}

test "every preset has keys for a new tab, help and detach after the prefix" {
    for (std.enums.values(Preset)) |preset| {
        try std.testing.expect(first(preset, .new, true) != null);
        try std.testing.expect(first(preset, .help, true) != null);
        try std.testing.expect(first(preset, .detach, true) != null);
    }
}

test "compact spellings for the onboarding cards" {
    const Case = struct { binding: Binding, text: []const u8 };
    for ([_]Case{
        .{ .binding = .{ .key = 'v', .action = .new }, .text = "v" },
        .{ .binding = .{ .key = '"', .action = .new }, .text = "\"" },
        .{ .binding = held('d', cmd, .new), .text = "D" },
        .{ .binding = held('d', cmd_shift, .new), .text = "⇧D" },
        .{ .binding = held(']', cmd_shift, .new), .text = "⇧]" },
        .{ .binding = held(keyboard.arrow_up, cmd_alt, .new), .text = "↑" },
    }) |case| {
        var buf: [32]u8 = undefined;
        try std.testing.expectEqualStrings(case.text, try std.fmt.bufPrint(&buf, "{f}", .{compact(case.binding)}));
    }
}

test "the shortcut table lists each preset's keys" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeTable(&out.writer, &.{ .corgi, .tmux, .cmux });
    const text = out.written();
    try std.testing.expect(std.mem.startsWith(u8, text, "| Action | Corgi | tmux | cmux |\n| --- | --- | --- | --- |\n"));
    for ([_][]const u8{
        "| New tab (agent picker) | `prefix c`, `Ctrl+T` | `prefix c` | `Cmd+T`, `prefix c` |\n",
        "| Split right | `prefix v`, `prefix %` | `prefix %` | `Cmd+D`, `prefix v`, `prefix %` |\n",
        "| Select tab | `prefix 1–9` | `prefix 0–9` | `Ctrl+1–9`, `prefix 1–9` |\n",
        "| Select workspace |  |  | `Cmd+1–9` |\n",
        "| Resize up |  | `prefix Ctrl+↑` | `Ctrl+Shift+K` |\n",
        "| Jump to attention | `prefix f`, `F1` | `prefix F` | `Cmd+Shift+U`, `prefix f` |\n",
    }) |row| try std.testing.expect(std.mem.indexOf(u8, text, row) != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Relaunch") == null);
}

test "keys that arrive as bytes" {
    try std.testing.expectEqual(Action{ .tab = 10 }, lookup(.tmux, true, '9', .{}).?);
    try std.testing.expectEqual(Action.@"choose-workspace", lookup(.herdr, true, 'g', .{}).?);
    try std.testing.expectEqual(Action{ .split = .right }, lookup(.corgi, true, '%', .{}).?);
    try std.testing.expectEqual(Action.new, lookup(.corgi, false, 20, .{}).?);
    try std.testing.expectEqual(null, lookup(.cmux, false, 20, .{}));
    try std.testing.expectEqual(null, lookup(.tmux, true, 'v', .{}));
    // A four-byte character's first byte.
    try std.testing.expectEqual(null, lookup(.corgi, true, 0xf0, .{}));
}

test "keys that arrive as sequences" {
    const Case = struct { preset: Preset, prefixed: bool = false, key: u21, mods: Mods = .{}, action: ?Action };
    for ([_]Case{
        .{ .preset = .cmux, .key = 't', .mods = cmd, .action = .new },
        .{ .preset = .cmux, .prefixed = true, .key = 't', .mods = cmd, .action = .new },
        .{ .preset = .cmux, .key = 'T', .mods = cmd, .action = .new },
        .{ .preset = .cmux, .key = '}', .mods = cmd_shift, .action = .next },
        .{ .preset = .cmux, .key = 57345, .mods = cmd_shift, .action = .zoom },
        .{ .preset = .cmux, .key = '4', .mods = cmd, .action = .{ .@"goto-workspace" = 4 } },
        .{ .preset = .tmux, .prefixed = true, .key = keyboard.arrow_left, .action = .{ .focus = .left } },
        .{ .preset = .tmux, .prefixed = true, .key = keyboard.arrow_up, .mods = ctrl, .action = .{ .resize = .up } },
        .{ .preset = .tmux, .key = keyboard.arrow_left, .action = null },
        .{ .preset = .herdr, .prefixed = true, .key = 57346, .mods = .{ .shift = true }, .action = .@"prev-pane" },
        // Ctrl+T is a byte too; the byte path handles it.
        .{ .preset = .corgi, .key = 't', .mods = ctrl, .action = null },
        .{ .preset = .corgi, .prefixed = true, .key = 'c', .action = null },
        .{ .preset = .corgi, .key = keyboard.f1, .action = .attention },
        .{ .preset = .corgi, .prefixed = true, .key = keyboard.f1, .action = .attention },
        .{ .preset = .corgi, .key = 'T', .mods = ctrl_shift, .action = .@"undo-close" },
        .{ .preset = .corgi, .key = 't', .mods = cmd_shift, .action = .@"undo-close" },
        .{ .preset = .cmux, .key = 'T', .mods = cmd_shift, .action = .@"undo-close" },
        .{ .preset = .tmux, .key = keyboard.f1, .action = null },
    }) |case| {
        const event: keyboard.Key = .{ .codepoint = case.key, .mods = .{ .shift = case.mods.shift, .alt = case.mods.alt, .ctrl = case.mods.ctrl, .super = case.mods.super } };
        try std.testing.expectEqual(case.action, chord(case.preset, case.prefixed, event));
    }
    try std.testing.expectEqual(Action{ .resize = .left }, prefixedSequence(.tmux, "\x1b[1;5D").?);
    try std.testing.expectEqual(Action.@"prev-pane", prefixedSequence(.herdr, "\x1b[Z").?);
    try std.testing.expectEqual(null, prefixedSequence(.corgi, "\x1b[Z"));
    try std.testing.expectEqual(null, prefixedSequence(.tmux, "\x1b[1;2D"));
    try std.testing.expectEqual(null, prefixedSequence(.tmux, "\x1b[1;5E"));
}
