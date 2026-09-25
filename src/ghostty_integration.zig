//! Viewer-local, opt-in Ghostty shortcuts. Never edits existing bindings.
const std = @import("std");
const os = @import("os.zig");
const a = std.heap.page_allocator;
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n";
const end = "# END CORGI GHOSTTY INTEGRATION\n";
pub const State = enum { unavailable, disabled, enabled, failed };

pub fn available() bool {
    return @import("builtin").os.tag == .macos and os.env("SSH_CONNECTION") == null and os.env("SSH_TTY") == null;
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
fn transform(allocator: std.mem.Allocator, bytes: []const u8, enable: bool) ![]u8 {
    const existing = try block(bytes);
    var out: std.Io.Writer.Allocating = .init(allocator);
    defer out.deinit();
    if (existing) |b| {
        try out.writer.writeAll(bytes[0..b.start]);
        try out.writer.writeAll(bytes[b.stop..]);
    } else try out.writer.writeAll(bytes);
    if (enable) {
        if (out.written().len > 0 and out.written()[out.written().len - 1] != '\n') try out.writer.writeByte('\n');
        try out.writer.writeAll(begin);
        try out.writer.writeAll("# Applies throughout Ghostty. Reload with Cmd+Shift+comma.\nkeybind = cmd+t=text:\\x02A\nkeybind = cmd+w=text:\\x02X\nkeybind = ctrl+tab=text:\\x02n\nkeybind = ctrl+shift+tab=text:\\x02p\n");
        for (1..10) |i| try out.writer.print("keybind = cmd+{d}=text:\\x02{d}\nkeybind = cmd+digit_{d}=text:\\x02{d}\n", .{ i, i, i, i });
        try out.writer.writeAll(end);
    }
    return allocator.dupe(u8, out.written());
}
pub fn setEnabled(enable: bool) !void {
    if (!available()) return error.LocalMacOSOnly;
    const file = try path();
    defer a.free(file);
    const bytes = try read(file);
    defer a.free(bytes);
    const updated = try transform(a, bytes, enable);
    defer a.free(updated);
    if (std.mem.eql(u8, bytes, updated)) return;
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
}

test "integration preserves custom bindings, covers physical digits, and is reversible" {
    const original = "# My settings\nkeybind = cmd+1=goto_tab:1\nfont-size = 14\n";
    const enabled = try transform(std.testing.allocator, original, true);
    defer std.testing.allocator.free(enabled);
    try std.testing.expect(std.mem.startsWith(u8, enabled, original));
    for (1..10) |i| {
        var buf: [80]u8 = undefined;
        const binding = try std.fmt.bufPrint(&buf, "keybind = cmd+digit_{d}=text:\\x02{d}\n", .{ i, i });
        try std.testing.expect(std.mem.indexOf(u8, enabled, binding) != null);
    }
    const again = try transform(std.testing.allocator, enabled, true);
    defer std.testing.allocator.free(again);
    try std.testing.expectEqualStrings(enabled, again);
    const disabled = try transform(std.testing.allocator, enabled, false);
    defer std.testing.allocator.free(disabled);
    try std.testing.expectEqualStrings(original, disabled);
    try std.testing.expectError(error.InvalidIntegrationBlock, transform(std.testing.allocator, begin, false));
}
