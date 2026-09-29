//! Which harness runs Corgi's own inference (activity summaries, link names).
//! `auto` follows the agents the user launches after the daemon starts, and
//! stops re-evaluating once a harness has answered. The setup screen's choice
//! is saved beside workspace state and wins over the environment default.
const std = @import("std");
const os = @import("../os.zig");
const inference = @import("harness.zig");
const a = os.allocator;
const providers = @import("../providers.zig");
const workspace = @import("../workspace.zig");
pub const Choice = inference.Choice;
pub const Provider = providers.Provider;

/// Agents detected in panes since the daemon started.
pub const Launches = struct {
    count: providers.Each(u32, 0) = .{},
    latest: ?Provider = null,
    pub fn record(l: *Launches, provider: Provider) void {
        l.count.getPtr(provider).* +|= 1;
        l.latest = provider;
    }
    /// The most launched provider. Ties go to the latest launch, then `fallback`.
    pub fn favorite(l: *const Launches, fallback: Provider) Provider {
        var best: u32 = 0;
        for (Provider.all) |provider| best = @max(best, l.count.get(provider));
        var leaders: usize = 0;
        var leader = fallback;
        for (Provider.all) |provider| if (l.count.get(provider) == best) {
            leaders += 1;
            leader = provider;
        };
        if (leaders == 1) return leader;
        return l.latest orelse fallback;
    }
};

/// Shared with viewers in the session snapshot.
pub const Status = struct {
    choice: Choice = .auto,
    /// The harness in use, or the one the next request would start. Null when off.
    provider: ?Provider = null,
    model: []const u8 = "",
    /// A harness has answered; `auto` keeps this provider until reconfigured.
    locked: bool = false,
    launches: providers.Each(u32, 0) = .{},
    /// What each provider would use, so the setup screen can compare them.
    models: providers.Each([]const u8, "") = .{},
};

/// `remembered` is the last agent from the saved checkpoint, used when no
/// agent has launched since the daemon started.
pub fn resolve(choice: Choice, launches: Launches, remembered: Provider) ?Provider {
    return switch (choice) {
        .off => null,
        .auto => launches.favorite(remembered),
        else => choice.provider().?,
    };
}

pub fn model(provider: ?Provider) []const u8 {
    const value = provider orelse return "";
    if (os.env("CORGI_INFERENCE_MODEL") orelse os.env("CORGI_SUMMARY_MODEL")) |override| return override;
    return value.info().summary_model;
}

/// Saved setup choice, then the environment, then `auto`. Unknown provider
/// names disable inference rather than silently using another provider.
pub fn initial(saved: ?Choice) Choice {
    if (saved) |choice| return choice;
    if (std.mem.eql(u8, os.env("CORGI_SUMMARY_COMMAND") orelse "", "off")) return .off;
    const name = os.env("CORGI_INFERENCE_PROVIDER") orelse return .auto;
    return std.meta.stringToEnum(Choice, name) orelse .off;
}

const Saved = struct { inference: ?Choice = null };

/// Caller owns the result. Lives beside workspaces.json.
pub fn path(socket: []const u8) ![]const u8 {
    const state = try workspace.Store.statePath(socket);
    defer a.free(state);
    const suffix = "workspaces.json";
    std.debug.assert(std.mem.endsWith(u8, state, suffix));
    return std.fmt.allocPrint(a, "{s}settings.json", .{state[0 .. state.len - suffix.len]});
}

pub fn load(file: []const u8) ?Choice {
    const bytes = std.fs.cwd().readFileAlloc(a, file, 64 * 1024) catch return null;
    defer a.free(bytes);
    const parsed = std.json.parseFromSlice(Saved, a, bytes, .{ .ignore_unknown_fields = true }) catch return null;
    defer parsed.deinit();
    return parsed.value.inference;
}

pub fn save(file: []const u8, choice: Choice) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, Saved{ .inference = choice }, .{ .whitespace = .indent_2 });
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

test "auto follows launched agents, then the remembered agent" {
    var launches: Launches = .{};
    try std.testing.expectEqual(Provider.codex, resolve(.auto, launches, .codex).?);
    try std.testing.expectEqual(Provider.claude, resolve(.auto, launches, .claude).?);
    launches.record(.claude);
    try std.testing.expectEqual(Provider.claude, resolve(.auto, launches, .codex).?);
    launches.record(.codex);
    // A tie goes to the most recent launch.
    try std.testing.expectEqual(Provider.codex, resolve(.auto, launches, .claude).?);
    launches.record(.claude);
    launches.record(.claude);
    launches.record(.codex);
    try std.testing.expectEqual(Provider.claude, resolve(.auto, launches, .codex).?);
    try std.testing.expectEqual(Provider.codex, resolve(.codex, launches, .claude).?);
    try std.testing.expect(resolve(.off, launches, .claude) == null);
}

test "setup choice round-trips beside workspace state" {
    var dir = std.testing.tmpDir(.{});
    defer dir.cleanup();
    const root = try dir.dir.realpathAlloc(a, ".");
    defer a.free(root);
    const file = try std.fs.path.join(a, &.{ root, "nested", "settings.json" });
    defer a.free(file);
    try std.testing.expect(load(file) == null);
    try save(file, .claude);
    try std.testing.expectEqual(Choice.claude, load(file).?);
    try save(file, .off);
    try std.testing.expectEqual(Choice.off, load(file).?);
    try std.testing.expectEqual(Choice.claude, initial(.claude));
}
