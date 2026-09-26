//! Viewer preferences that survive restarts. Viewers on one machine share the
//! file; the daemon never reads it. Unreadable files fall back to defaults.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;

pub const Preferences = struct {
    /// Only the two lasting scopes persist; a single-workspace pick is per session.
    agents: enum { workspace, all } = .workspace,
    preset: @import("keymap.zig").Preset = .corgi,
    prefix: @import("keymap.zig").Prefix = .ctrl_b,
    onboarding_complete: bool = false,
};

pub fn path() ![]const u8 {
    if (os.env("XDG_STATE_HOME")) |root| return std.fs.path.join(a, &.{ root, "corgi", "viewer.json" });
    return std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".local", "state", "corgi", "viewer.json" });
}

pub fn load() Preferences {
    const file = path() catch return .{};
    defer a.free(file);
    var saved = readExisting(file);
    if (saved != null and saved.?.onboarding_complete) return saved.?;
    // Older builds kept preferences beside an overridden socket. Carry a
    // completed setup forward once; the shared file then takes precedence.
    if (os.env("CORGI_SOCKET")) |socket| {
        const legacy = std.fmt.allocPrint(a, "{s}.viewer.json", .{socket}) catch return saved orelse .{};
        defer a.free(legacy);
        if (readExisting(legacy)) |old| if (old.onboarding_complete) {
            var migrated = saved orelse old;
            migrated.preset = old.preset;
            migrated.prefix = old.prefix;
            migrated.onboarding_complete = true;
            write(file, migrated) catch {};
            saved = migrated;
        };
    }
    return saved orelse .{};
}

pub fn save(value: Preferences) !void {
    const file = try path();
    defer a.free(file);
    try write(file, value);
}

fn read(file: []const u8) Preferences {
    return readExisting(file) orelse .{};
}

fn readExisting(file: []const u8) ?Preferences {
    const bytes = std.fs.cwd().readFileAlloc(a, file, 64 * 1024) catch return null;
    defer a.free(bytes);
    const parsed = std.json.parseFromSlice(Preferences, a, bytes, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    return parsed.value;
}

fn write(file: []const u8, value: Preferences) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{ .whitespace = .indent_2 });
    defer a.free(bytes);
    try std.fs.cwd().makePath(std.fs.path.dirname(file) orelse ".");
    // Every viewer uses this file, so each writer needs its own temporary file.
    var atomic = try std.fs.cwd().atomicFile(file, .{ .mode = 0o600, .write_buffer = &.{} });
    defer atomic.deinit();
    try atomic.file_writer.interface.writeAll(bytes);
    try atomic.file_writer.file.sync();
    try atomic.finish();
}

test "preferences round trip and fall back to defaults" {
    var dir = std.testing.tmpDir(.{});
    defer dir.cleanup();
    const root = try dir.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const file = try std.fs.path.join(std.testing.allocator, &.{ root, "nested", "viewer.json" });
    defer std.testing.allocator.free(file);
    try std.testing.expectEqual(Preferences{}, read(file));
    try write(file, .{ .agents = .all });
    try std.testing.expectEqual(Preferences{ .agents = .all }, read(file));
    try dir.dir.writeFile(.{ .sub_path = "nested/viewer.json", .data = "{broken" });
    try std.testing.expectEqual(Preferences{}, read(file));
}
