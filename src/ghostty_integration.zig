//! Viewer-local, opt-in Ghostty shortcuts. Never edits existing bindings.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const keymap = @import("keymap.zig");
const bindings = @import("bindings.zig");
const keyboard = @import("keyboard.zig");
const Action = @import("action.zig").Action;
const a = os.allocator;
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n";
const end = "# END CORGI GHOSTTY INTEGRATION\n";
pub const State = enum { unavailable, disabled, enabled, failed };

pub fn available() bool {
    return builtin.os.tag == .macos and os.env("SSH_CONNECTION") == null and os.env("SSH_TTY") == null;
}

fn path() ![]const u8 {
    const home = os.env("HOME") orelse return error.NoHomeDirectory;
    const native_dir = try std.fs.path.join(a, &.{ home, "Library/Application Support/com.mitchellh.ghostty" });
    defer a.free(native_dir);
    const xdg_dir = if (os.env("XDG_CONFIG_HOME")) |root|
        try std.fs.path.join(a, &.{ root, "ghostty" })
    else
        try std.fs.path.join(a, &.{ home, ".config/ghostty" });
    defer a.free(xdg_dir);
    // Last default file wins. Resolve symlinks so atomic writes preserve dotfile links.
    for ([_][]const u8{ native_dir, xdg_dir }) |dir| {
        for ([_][]const u8{ "config.ghostty", "config" }) |name| {
            const candidate = try std.fs.path.join(a, &.{ dir, name });
            defer a.free(candidate);
            const resolved = std.fs.cwd().realpathAlloc(a, candidate) catch |err| {
                if (err == error.FileNotFound) continue;
                return err;
            };
            return resolved;
        }
    }
    return std.fs.path.join(a, &.{ native_dir, "config" });
}

fn read(file: []const u8) ![]u8 {
    return std.fs.cwd().readFileAlloc(a, file, 1024 * 1024) catch |err| {
        if (err == error.FileNotFound) return a.dupe(u8, "");
        return err;
    };
}
fn block(bytes: []const u8) !?struct { start: usize, stop: usize } {
    const start = std.mem.indexOf(u8, bytes, begin);
    const stop = std.mem.indexOf(u8, bytes, end);
    if (start == null and stop == null) return null;
    if (start == null or stop == null or stop.? < start.?) return error.InvalidIntegrationBlock;
    const after = stop.? + end.len;
    if ((start.? > 0 and bytes[start.? - 1] != '\n') or
        (stop.? > 0 and bytes[stop.? - 1] != '\n') or
        std.mem.indexOf(u8, bytes[start.? + begin.len ..], begin) != null or
        std.mem.indexOf(u8, bytes[after..], end) != null) return error.InvalidIntegrationBlock;
    return .{ .start = start.?, .stop = after };
}
pub fn state() State {
    if (!available()) return .unavailable;
    const file = path() catch return .failed;
    defer a.free(file);
    const bytes = read(file) catch return .failed;
    defer a.free(bytes);
    return if ((block(bytes) catch return .failed) != null) .enabled else .disabled;
}
/// Host keys outside cmux, which type the prefix and the preset's key.
const Host = struct { host: []const u8, action: Action };
const host_keys = [_]Host{
    .{ .host = "cmd+t", .action = .new },
    .{ .host = "cmd+w", .action = .@"close-tab" },
    .{ .host = "cmd+shift+t", .action = .@"undo-close" },
    .{ .host = "ctrl+tab", .action = .next },
    .{ .host = "ctrl+shift+tab", .action = .prev },
} ++ digitKeys("cmd+") ++ digitKeys("cmd+digit_");
fn digitKeys(comptime modifier: []const u8) [9]Host {
    var out: [9]Host = undefined;
    for (&out, 1..) |*host, n| host.* = .{ .host = modifier ++ std.fmt.comptimePrint("{d}", .{n}), .action = .{ .tab = n } };
    return out;
}
/// A held binding as a Ghostty trigger, such as `cmd+shift+right_bracket`.
const Trigger = struct {
    binding: bindings.Binding,
    pub fn format(t: Trigger, w: *std.Io.Writer) std.Io.Writer.Error!void {
        const m = t.binding.mods;
        if (m.super) try w.writeAll("cmd+");
        if (m.ctrl) try w.writeAll("ctrl+");
        if (m.alt) try w.writeAll("alt+");
        if (m.shift) try w.writeAll("shift+");
        try switch (t.binding.key) {
            13 => w.writeAll("enter"),
            ',' => w.writeAll("comma"),
            '[' => w.writeAll("left_bracket"),
            ']' => w.writeAll("right_bracket"),
            keyboard.arrow_left => w.writeAll("left"),
            keyboard.arrow_right => w.writeAll("right"),
            keyboard.arrow_up => w.writeAll("up"),
            keyboard.arrow_down => w.writeAll("down"),
            else => |key| w.print("{u}", .{key}),
        };
    }
};
fn trigger(b: bindings.Binding) Trigger {
    return .{ .binding = b };
}
/// The settings a block is written for.
pub const Keys = struct { preset: keymap.Preset, prefix: keymap.Prefix };
/// `bytes` with the block for `keys`, or without any block when null.
fn transform(allocator: std.mem.Allocator, bytes: []const u8, keys: ?Keys) ![]u8 {
    const existing = try block(bytes);
    var out: std.Io.Writer.Allocating = .init(allocator);
    defer out.deinit();
    if (existing) |b| {
        try out.writer.writeAll(bytes[0..b.start]);
        try out.writer.writeAll(bytes[b.stop..]);
    } else try out.writer.writeAll(bytes);
    if (keys) |k| {
        if (out.written().len > 0 and out.written()[out.written().len - 1] != '\n') try out.writer.writeByte('\n');
        try out.writer.writeAll(begin);
        if (k.preset == .cmux) {
            // Each held key types its own Kitty sequence.
            try out.writer.writeAll("# cmux preset; applies throughout Ghostty. Reload with Cmd+Shift+comma.\n");
            for (bindings.table(.cmux)) |b| if (!b.prefixed) {
                try out.writer.print("keybind = {f}=text:\\x1b[{d};{d}u\n", .{ trigger(b), b.key, @as(u5, @as(u4, @bitCast(b.mods))) + 1 });
            };
        } else {
            // Each host key types the prefix and the preset's key for its action.
            try out.writer.writeAll("# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\n");
            for (host_keys) |host| if (bindings.first(k.preset, host.action, true)) |b| if (b.mods == bindings.Mods{} and b.key < 0x80) {
                try out.writer.print("keybind = {s}=text:\\x{x:0>2}", .{ host.host, keymap.prefixByte(k.prefix) });
                if (b.key > ' ' and b.key < 0x7f and b.key != '\\') try out.writer.writeByte(@intCast(b.key)) else try out.writer.print("\\x{x:0>2}", .{b.key});
                try out.writer.writeByte('\n');
            };
        }
        try out.writer.writeAll(end);
    }
    return allocator.dupe(u8, out.written());
}
/// Writes the block for `keys`, or removes it when null. An unchanged file
/// is not rewritten.
pub fn sync(keys: ?Keys) !void {
    _ = try apply(keys, false);
}
/// Re-renders a block already there after the preset or prefix changed, so
/// it stops typing the old keys; never adds one. Returns whether it changed.
pub fn refresh(keys: Keys) !bool {
    return apply(keys, true);
}
fn apply(keys: ?Keys, existing_only: bool) !bool {
    if (!available()) return error.LocalMacOSOnly;
    const file = try path();
    defer a.free(file);
    const bytes = try read(file);
    defer a.free(bytes);
    if (existing_only and try block(bytes) == null) return false;
    const updated = try transform(a, bytes, keys);
    defer a.free(updated);
    if (std.mem.eql(u8, bytes, updated)) return false;
    try std.fs.cwd().makePath(std.fs.path.dirname(file).?);
    const stat = std.fs.cwd().statFile(file) catch |err| blk: {
        if (err == error.FileNotFound) break :blk null;
        return err;
    };
    const mode = if (stat) |info| info.mode else 0o600;
    // Atomic replacement; another viewer cannot collide with our temporary file.
    var atomic = try std.fs.cwd().atomicFile(file, .{ .mode = mode, .write_buffer = &.{} });
    defer atomic.deinit();
    try atomic.file_writer.file.chmod(mode);
    try atomic.file_writer.interface.writeAll(updated);
    try atomic.file_writer.file.sync();
    try atomic.finish();
    return true;
}

test "integration preserves custom bindings, covers physical digits, and is reversible" {
    const original = "# My settings\nkeybind = cmd+1=goto_tab:1\nfont-size = 14\n";
    const keys: Keys = .{ .preset = .corgi, .prefix = .ctrl_b };
    const enabled = try transform(std.testing.allocator, original, keys);
    defer std.testing.allocator.free(enabled);
    try std.testing.expect(std.mem.startsWith(u8, enabled, original));
    for (1..10) |i| {
        var buf: [80]u8 = undefined;
        const binding = try std.fmt.bufPrint(&buf, "keybind = cmd+digit_{d}=text:\\x02{d}\n", .{ i, i });
        try std.testing.expect(std.mem.indexOf(u8, enabled, binding) != null);
    }
    const again = try transform(std.testing.allocator, enabled, keys);
    defer std.testing.allocator.free(again);
    try std.testing.expectEqualStrings(enabled, again);
    const disabled = try transform(std.testing.allocator, enabled, null);
    defer std.testing.allocator.free(disabled);
    try std.testing.expectEqualStrings(original, disabled);
    try std.testing.expectError(error.InvalidIntegrationBlock, transform(std.testing.allocator, begin, null));
}

test "re-rendering a block replaces the old prefix and keeps other settings" {
    const original = "font-size = 14\n";
    const old = try transform(std.testing.allocator, original, .{ .preset = .corgi, .prefix = .ctrl_b });
    defer std.testing.allocator.free(old);
    const updated = try transform(std.testing.allocator, old, .{ .preset = .corgi, .prefix = .ctrl_a });
    defer std.testing.allocator.free(updated);
    try std.testing.expect(std.mem.startsWith(u8, updated, original));
    try std.testing.expect(std.mem.indexOf(u8, updated, "\\x02") == null);
    try std.testing.expect(std.mem.indexOf(u8, updated, "keybind = cmd+t=text:\\x01c\n") != null);
    try std.testing.expect(std.mem.count(u8, updated, begin) == 1);
}

test "the block types the chosen prefix and each preset's keys" {
    const Case = struct { keys: Keys, lines: []const []const u8, absent: []const []const u8 = &.{} };
    for ([_]Case{
        .{ .keys = .{ .preset = .corgi, .prefix = .ctrl_a }, .lines = &.{ "keybind = cmd+t=text:\\x01c\n", "keybind = cmd+3=text:\\x013\n", "keybind = cmd+shift+t=text:\\x01u\n" }, .absent = &.{"\\x02"} },
        .{ .keys = .{ .preset = .tmux, .prefix = .ctrl_b }, .lines = &.{ "keybind = cmd+1=text:\\x020\n", "keybind = cmd+w=text:\\x02&\n", "keybind = cmd+digit_9=text:\\x028\n" } },
        .{ .keys = .{ .preset = .herdr, .prefix = .ctrl_b }, .lines = &.{ "keybind = cmd+t=text:\\x02c\n", "keybind = cmd+w=text:\\x02X\n" } },
        .{ .keys = .{ .preset = .tmux, .prefix = .ctrl_a }, .lines = &.{ "keybind = cmd+w=text:\\x01&\n", "keybind = ctrl+tab=text:\\x01n\n" }, .absent = &.{"\\x02"} },
        .{ .keys = .{ .preset = .cmux, .prefix = .ctrl_a }, .lines = &.{
            "keybind = cmd+t=text:\\x1b[116;9u\n",
            "keybind = cmd+shift+right_bracket=text:\\x1b[93;10u\n",
            "keybind = cmd+alt+left=text:\\x1b[57350;11u\n",
            "keybind = ctrl+shift+h=text:\\x1b[104;6u\n",
            "keybind = ctrl+3=text:\\x1b[51;5u\n",
            "keybind = cmd+comma=text:\\x1b[44;9u\n",
            "keybind = cmd+shift+enter=text:\\x1b[13;10u\n",
            "keybind = cmd+shift+t=text:\\x1b[116;10u\n",
        }, .absent = &.{ "\\x01", "\\x02" } },
    }) |case| {
        const block_text = try transform(std.testing.allocator, "", case.keys);
        defer std.testing.allocator.free(block_text);
        for (case.lines) |line| try std.testing.expect(std.mem.indexOf(u8, block_text, line) != null);
        for (case.absent) |text| try std.testing.expect(std.mem.indexOf(u8, block_text, text) == null);
    }
}
