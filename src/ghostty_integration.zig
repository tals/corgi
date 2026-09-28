//! Viewer-local, opt-in Ghostty shortcuts. Never edits existing bindings.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const keymap = @import("keymap.zig");
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
            try out.writer.writeAll("# cmux preset; applies throughout Ghostty. Reload with Cmd+Shift+comma.\n");
            const Binding = struct { host: []const u8, cp: u21, mods: u8 };
            const bindings = [_]Binding{
                .{ .host = "cmd+t", .cp = 't', .mods = 9 },                    .{ .host = "cmd+n", .cp = 'n', .mods = 9 },
                .{ .host = "cmd+r", .cp = 'r', .mods = 9 },                    .{ .host = "cmd+shift+r", .cp = 'r', .mods = 10 },
                .{ .host = "cmd+shift+w", .cp = 'w', .mods = 10 },             .{ .host = "cmd+p", .cp = 'p', .mods = 9 },
                .{ .host = "cmd+d", .cp = 'd', .mods = 9 },                    .{ .host = "cmd+shift+d", .cp = 'd', .mods = 10 },
                .{ .host = "cmd+alt+left", .cp = 57350, .mods = 11 },          .{ .host = "cmd+alt+right", .cp = 57351, .mods = 11 },
                .{ .host = "cmd+alt+up", .cp = 57352, .mods = 11 },            .{ .host = "cmd+alt+down", .cp = 57353, .mods = 11 },
                .{ .host = "cmd+shift+right_bracket", .cp = ']', .mods = 10 }, .{ .host = "cmd+shift+left_bracket", .cp = '[', .mods = 10 },
                .{ .host = "cmd+shift+enter", .cp = 13, .mods = 10 },          .{ .host = "cmd+w", .cp = 'w', .mods = 9 },
                .{ .host = "cmd+shift+m", .cp = 'm', .mods = 10 },             .{ .host = "cmd+shift+p", .cp = 'p', .mods = 10 },
                .{ .host = "cmd+shift+u", .cp = 'u', .mods = 10 },             .{ .host = "cmd+b", .cp = 'b', .mods = 9 },
                .{ .host = "cmd+comma", .cp = ',', .mods = 9 },
            };
            for (bindings) |binding| try out.writer.print("keybind = {s}=text:\\x1b[{d};{d}u\n", .{ binding.host, binding.cp, binding.mods });
            for (1..10) |digit| {
                try out.writer.print("keybind = cmd+{d}=text:\\x1b[{d};9u\nkeybind = ctrl+{d}=text:\\x1b[{d};5u\n", .{ digit, '0' + digit, digit, '0' + digit });
            }
            for ("hjkl") |key| try out.writer.print("keybind = ctrl+shift+{c}=text:\\x1b[{d};6u\n", .{ key, key });
        } else {
            // Each host key types the prefix and whatever key the preset
            // uses for the action.
            try out.writer.writeAll("# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\n");
            const prefix = keymap.prefixByte(k.prefix);
            const Host = struct { host: []const u8, action: u8 };
            for ([_]Host{ .{ .host = "cmd+t", .action = 'c' }, .{ .host = "cmd+w", .action = 'X' }, .{ .host = "ctrl+tab", .action = 'n' }, .{ .host = "ctrl+shift+tab", .action = 'p' } }) |host| {
                const key = keymap.shortcut(k.preset, host.action) orelse continue;
                try out.writer.print("keybind = {s}=text:\\x{x:0>2}{c}\n", .{ host.host, prefix, key });
            }
            for (1..10) |i| {
                const key = keymap.shortcut(k.preset, '0' + @as(u8, @intCast(i))) orelse continue;
                try out.writer.print("keybind = cmd+{d}=text:\\x{x:0>2}{c}\nkeybind = cmd+digit_{d}=text:\\x{x:0>2}{c}\n", .{ i, prefix, key, i, prefix, key });
            }
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
        .{ .keys = .{ .preset = .corgi, .prefix = .ctrl_a }, .lines = &.{ "keybind = cmd+t=text:\\x01c\n", "keybind = cmd+3=text:\\x013\n" }, .absent = &.{"\\x02"} },
        .{ .keys = .{ .preset = .tmux, .prefix = .ctrl_b }, .lines = &.{ "keybind = cmd+1=text:\\x020\n", "keybind = cmd+w=text:\\x02&\n", "keybind = cmd+digit_9=text:\\x028\n" } },
        .{ .keys = .{ .preset = .herdr, .prefix = .ctrl_b }, .lines = &.{ "keybind = cmd+t=text:\\x02c\n", "keybind = cmd+w=text:\\x02X\n" } },
        .{ .keys = .{ .preset = .cmux, .prefix = .ctrl_a }, .lines = &.{"keybind = cmd+t=text:\\x1b[116;9u\n"}, .absent = &.{ "\\x01", "\\x02" } },
    }) |case| {
        const block_text = try transform(std.testing.allocator, "", case.keys);
        defer std.testing.allocator.free(block_text);
        for (case.lines) |line| try std.testing.expect(std.mem.indexOf(u8, block_text, line) != null);
        for (case.absent) |text| try std.testing.expect(std.mem.indexOf(u8, block_text, text) == null);
    }
}
