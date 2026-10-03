//! Viewer preferences that survive restarts. Viewers on one machine share the
//! file; the daemon never reads it. Unreadable files fall back to defaults.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const keymap = @import("keymap.zig");
const builtin = @import("builtin");
const Scope = @import("sidebar.zig").Scope;

/// Resource readings shown in the sidebar. Disabling removes the row and,
/// once every attached viewer is off, stops the daemon's sampling. Settings
/// older builds kept beside `enabled` are ignored.
pub const Resources = struct {
    enabled: bool = true,
};

pub const Preferences = struct {
    /// The agent scope persists across viewer restarts.
    agents: Scope = .workspace,
    /// The last dragged sidebar width seeds new viewers; open ones keep their own.
    sidebar_width: u16 = 28,
    preset: keymap.Preset = .corgi,
    prefix: keymap.Prefix = .ctrl_b,
    onboarding_complete: bool = false,
    resources: Resources = .{},
    /// Idle agents nap as corgis in the sidebar; off marks them with a faint Z.
    sleeping_corgis: bool = true,
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

/// Saves the given fields and keeps the rest as another viewer may have left
/// them. `changes` names `Preferences` fields: `update(.{ .agents = .all })`.
pub fn update(changes: anytype) !void {
    const file = try path();
    defer a.free(file);
    try updateFile(file, changes);
}

fn updateFile(file: []const u8, changes: anytype) !void {
    var saved = read(file);
    inline for (std.meta.fields(@TypeOf(changes))) |field| @field(saved, field.name) = @field(changes, field.name);
    try write(file, saved);
}

fn read(file: []const u8) Preferences {
    return readExisting(file) orelse .{};
}

fn readExisting(file: []const u8) ?Preferences {
    const bytes = std.Io.Dir.cwd().readFileAlloc(os.io(), file, a, .limited(64 * 1024)) catch return null;
    defer a.free(bytes);
    const parsed = std.json.parseFromSlice(Preferences, a, bytes, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    var value = parsed.value;
    value.sidebar_width = @max(value.sidebar_width, 20);
    value.preset = keymap.supportedPreset(value.preset);
    return value;
}

fn write(file: []const u8, value: Preferences) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, value, .{ .whitespace = .indent_2 });
    defer a.free(bytes);
    try std.Io.Dir.cwd().createDirPath(os.io(), std.fs.path.dirname(file) orelse ".");
    // Every viewer uses this file, so each writer needs its own temporary file.
    var atomic = try std.Io.Dir.cwd().createFileAtomic(os.io(), file, .{ .permissions = .fromMode(0o600), .replace = true });
    defer atomic.deinit(os.io());
    try atomic.file.writeStreamingAll(os.io(), bytes);
    try atomic.file.sync(os.io());
    try atomic.replace(os.io());
}

test "preferences round trip and fall back to defaults" {
    var dir = std.testing.tmpDir(.{});
    defer dir.cleanup();
    const root = try os.realpathAlloc(std.testing.allocator, dir.dir, ".");
    defer std.testing.allocator.free(root);
    const file = try std.fs.path.join(std.testing.allocator, &.{ root, "nested", "viewer.json" });
    defer std.testing.allocator.free(file);
    try std.testing.expectEqual(Preferences{}, read(file));
    try write(file, .{ .agents = .all });
    try std.testing.expectEqual(Preferences{ .agents = .all }, read(file));
    try write(file, .{ .sidebar_width = 44 });
    try std.testing.expectEqual(@as(u16, 44), read(file).sidebar_width);
    try updateFile(file, .{ .agents = .all });
    try std.testing.expectEqual(Preferences{ .agents = .all, .sidebar_width = 44 }, read(file));
    try write(file, .{ .resources = .{ .enabled = false } });
    try std.testing.expectEqual(Resources{ .enabled = false }, read(file).resources);
    try dir.dir.writeFile(os.io(), .{ .sub_path = "nested/viewer.json", .data = "{\"resources\":{\"enabled\":false,\"io\":false,\"alerts\":true}}" });
    try std.testing.expectEqual(Resources{ .enabled = false }, read(file).resources);
    try write(file, .{ .preset = .cmux, .onboarding_complete = true });
    try std.testing.expectEqual(if (builtin.os.tag == .macos) keymap.Preset.cmux else .corgi, read(file).preset);
    try dir.dir.writeFile(os.io(), .{ .sub_path = "nested/viewer.json", .data = "{broken" });
    try std.testing.expectEqual(Preferences{}, read(file));
}
