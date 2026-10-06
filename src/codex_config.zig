//! Codex owns TOML parsing and editing; Corgi only adds its identity field.
const std = @import("std");
const os = @import("os.zig");
const common = @import("providers/common.zig");
const field = common.field;
const str = common.str;

pub const Edit = struct {
    keyPath: []const u8 = "tui.terminal_title",
    value: []const []const u8,
    mergeStrategy: []const u8 = "replace",
    filePath: []const u8,
    expectedVersion: []const u8,
};

/// All returned strings borrow the response except the allocated item slice.
pub fn edit(alloc: std.mem.Allocator, result: std.json.Value, path: []const u8) !?Edit {
    const layers = field(result, "layers");
    if (layers != .array) return error.MissingConfigLayers;
    for (layers.array.items) |layer| {
        const source = field(layer, "name");
        if (!std.mem.eql(u8, str(source, "type"), "user") or
            !std.mem.eql(u8, str(source, "file"), path) or field(source, "profile") != .null) continue;
        if (field(layer, "disabledReason") != .null) return error.DisabledConfigLayer;
        const version = str(layer, "version");
        if (version.len == 0) return error.MissingConfigVersion;
        const items = try titleItems(alloc, field(field(layer, "config"), "tui")) orelse return null;
        return .{ .value = items, .filePath = path, .expectedVersion = version };
    }
    return error.MissingUserConfig;
}

fn titleItems(alloc: std.mem.Allocator, tui: std.json.Value) !?[]const []const u8 {
    if (tui != .null and tui != .object) return error.InvalidTitleConfig;
    const title = field(tui, "terminal_title");
    var items: std.ArrayList([]const u8) = .empty;
    errdefer items.deinit(alloc);
    if (title == .null) {
        try items.appendSlice(alloc, &.{ "app-name", "thread-id", "activity", "project" });
    } else {
        if (title != .array) return error.InvalidTitleConfig;
        var found = false;
        for (title.array.items) |item| {
            if (item != .string) return error.InvalidTitleConfig;
            found = found or std.mem.eql(u8, item.string, "thread-id");
        }
        if (found) return null;
        for (title.array.items) |item| try items.append(alloc, item.string);
        try items.append(alloc, "thread-id");
    }
    return try items.toOwnedSlice(alloc);
}

/// Refuse user-managed indirection and retain the original before Codex edits it.
pub fn backup(path: []const u8) !void {
    const io = os.io();
    const stat = std.Io.Dir.cwd().statFile(io, path, .{ .follow_symlinks = false }) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    if (stat.kind != .file) return error.ConfigNotRegular;
    const before = try std.Io.Dir.cwd().readFileAlloc(io, path, os.allocator, .limited(1024 * 1024));
    defer os.allocator.free(before);
    const name = try std.fmt.allocPrint(os.allocator, "{s}.corgi-backup", .{path});
    defer os.allocator.free(name);
    const file = std.Io.Dir.cwd().createFile(io, name, .{ .exclusive = true, .permissions = .fromMode(0o600) }) catch |err| {
        if (err == error.PathAlreadyExists) return;
        return err;
    };
    defer file.close(io);
    try file.writeStreamingAll(io, before);
}

test "title setup preserves custom items and is idempotent" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"terminal_title":["activity","project"]}
    , .{});
    defer parsed.deinit();
    const items = (try titleItems(alloc, parsed.value)).?;
    defer alloc.free(items);
    try std.testing.expectEqual(@as(usize, 3), items.len);
    for ([_][]const u8{ "activity", "project", "thread-id" }, items) |expected, actual| try std.testing.expectEqualStrings(expected, actual);
    const complete = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"terminal_title":["thread-id","project"]}
    , .{});
    defer complete.deinit();
    try std.testing.expectEqual(null, try titleItems(alloc, complete.value));
}

test "title setup supplies defaults and rejects malformed values" {
    const alloc = std.testing.allocator;
    const items = (try titleItems(alloc, .null)).?;
    defer alloc.free(items);
    try std.testing.expectEqualStrings("thread-id", items[1]);
    const bad = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"terminal_title":["thread-id",42]}
    , .{});
    defer bad.deinit();
    try std.testing.expectError(error.InvalidTitleConfig, titleItems(alloc, bad.value));
}

test "title setup targets the base user layer with a version precondition" {
    const alloc = std.testing.allocator;
    const parsed = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"layers":[
        \\ {"name":{"type":"project"},"config":{"tui":{"terminal_title":["thread-id"]}}},
        \\ {"name":{"type":"user","file":"/config.toml","profile":"work"},"version":"profile","config":{}},
        \\ {"name":{"type":"user","file":"/config.toml","profile":null},"version":"original","config":{"tui":{"terminal_title":[]}}}
        \\]}
    , .{});
    defer parsed.deinit();
    const change = (try edit(alloc, parsed.value, "/config.toml")).?;
    defer alloc.free(change.value);
    try std.testing.expectEqualStrings("original", change.expectedVersion);
    try std.testing.expectEqual(@as(usize, 1), change.value.len);
    try std.testing.expectEqualStrings("thread-id", change.value[0]);
    try std.testing.expectError(error.MissingUserConfig, edit(alloc, parsed.value, "/other.toml"));
    try std.testing.expectError(error.MissingConfigLayers, edit(alloc, .null, "/config.toml"));
}
