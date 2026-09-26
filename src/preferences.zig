//! Viewer preferences that survive restarts. Viewers on one machine share the
//! file; the daemon never reads it. Unreadable files fall back to defaults.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;

pub const Preferences = struct {
    /// Only the two lasting scopes persist; a single-workspace pick is per session.
    agents: enum { workspace, all } = .workspace,
};

pub fn path() ![]const u8 {
    if (os.env("CORGI_SOCKET")) |socket| return std.fmt.allocPrint(a, "{s}.viewer.json", .{socket});
    if (os.env("XDG_STATE_HOME")) |root| return std.fs.path.join(a, &.{ root, "corgi", "viewer.json" });
    return std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".local", "state", "corgi", "viewer.json" });
}

pub fn load() Preferences {
    const file = path() catch return .{};
    defer a.free(file);
    return read(file);
}

pub fn save(value: Preferences) !void {
    const file = try path();
    defer a.free(file);
    try write(file, value);
}

fn read(file: []const u8) Preferences {
    const bytes = std.fs.cwd().readFileAlloc(a, file, 64 * 1024) catch return .{};
    defer a.free(bytes);
    const parsed = std.json.parseFromSlice(Preferences, a, bytes, .{ .ignore_unknown_fields = true }) catch return .{};
    defer parsed.deinit();
    return parsed.value;
}

fn write(file: []const u8, value: Preferences) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{ .whitespace = .indent_2 });
    defer a.free(bytes);
    try std.fs.cwd().makePath(std.fs.path.dirname(file) orelse ".");
    const temp = try std.fmt.allocPrint(a, "{s}.tmp", .{file});
    defer a.free(temp);
    var handle = try std.fs.cwd().createFile(temp, .{ .mode = 0o600 });
    defer handle.close();
    errdefer std.fs.cwd().deleteFile(temp) catch {};
    try handle.writeAll(bytes);
    try handle.sync();
    try std.fs.cwd().rename(temp, file);
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
