//! Public account metadata only. Credentials never enter the preview protocol.
const std = @import("std");
const common = @import("../providers/common.zig");
const field = common.field;
const str = common.str;
const Provider = @import("../providers.zig").Provider;
const agents = @import("../agents.zig");
pub const Text = agents.Text;
pub const usage_max_age: i64 = 10 * 60;
pub const Info = struct {
    signed_in: ?bool = null,
    account: Text = .{},
    plan: Text = .{},
    limits: Limits = .none,
    usage_fetched_at: i64 = 0,
    usage_error: Text = .{},
    usage_needs_consent: bool = false,
};

/// A usage reading as reported; the launcher derives its text.
pub const Limits = union(enum) {
    none,
    /// API keys and external providers bill per token; never stale.
    metered,
    /// The provider refused a reading and none was retained.
    rate_limited,
    windows: [2]?Window,
};

pub const Window = struct {
    /// Null when the provider does not report the window's length.
    minutes: ?i64 = null,
    /// Whole percent used, 0 through 100.
    used: u8 = 0,
    reset_at: ?i64 = null,

    pub fn label(w: Window, buf: []u8) []const u8 {
        const n = w.minutes orelse return "Window";
        if (n <= 0) return "Window";
        if (@mod(n, 1440) == 0) return std.fmt.bufPrint(buf, "{d}d", .{@divExact(n, 1440)}) catch "Window";
        if (@mod(n, 60) == 0) return std.fmt.bufPrint(buf, "{d}h", .{@divExact(n, 60)}) catch "Window";
        return std.fmt.bufPrint(buf, "{d}m", .{n}) catch "Window";
    }

    pub fn countdown(w: Window, now: i64, buf: []u8) ?[]const u8 {
        return resetCountdown(w.reset_at orelse return null, now, buf);
    }
};

/// Whether a reading fetched at `fetched_at` is too old to show.
pub fn expired(fetched_at: i64, now: i64) bool {
    return fetched_at <= 0 or now -| fetched_at >= usage_max_age;
}

fn resetCountdown(at: i64, now: i64, buf: []u8) []const u8 {
    const seconds = at -| now;
    if (seconds <= 0) return "now";
    const minutes = @divTrunc(seconds, 60) + @as(i64, if (@mod(seconds, 60) > 0) 1 else 0);
    const days = @divTrunc(minutes, 1440);
    const hours = @mod(@divTrunc(minutes, 60), 24);
    const mins = @mod(minutes, 60);
    if (days > 0) {
        if (hours > 0) return std.fmt.bufPrint(buf, "{d}d {d}h", .{ days, hours }) catch "";
        if (mins > 0) return std.fmt.bufPrint(buf, "{d}d {d}m", .{ days, mins }) catch "";
        return std.fmt.bufPrint(buf, "{d}d", .{days}) catch "";
    }
    if (hours > 0) {
        if (mins > 0) return std.fmt.bufPrint(buf, "{d}h {d}m", .{ hours, mins }) catch "";
        return std.fmt.bufPrint(buf, "{d}h", .{hours}) catch "";
    }
    return std.fmt.bufPrint(buf, "{d}m", .{minutes}) catch "";
}

fn windowMinutes(format: common.LimitsFormat, item: std.json.Value, i: usize) ?i64 {
    if (format.minutes) |minutes| return minutes[i];
    const reported = field(item, "windowDurationMins");
    return if (reported == .integer and reported.integer > 0) reported.integer else null;
}

fn resetTimestamp(value: std.json.Value, format: common.LimitsFormat) ?i64 {
    if (format.reset == .unix_seconds) {
        const at = field(value, "resetsAt");
        return if (at == .integer and at.integer > 0) at.integer else null;
    }
    const raw = str(value, "resets_at");
    // Claude returns ISO 8601, including fractional seconds and UTC offsets.
    var normalized: [96]u8 = undefined;
    var stamp = raw;
    var offset: i64 = 0;
    if (raw.len >= 25 and (raw[raw.len - 6] == '+' or raw[raw.len - 6] == '-')) {
        const tail = raw[raw.len - 6 ..];
        if (tail[3] != ':') return null;
        const hours = std.fmt.parseInt(u8, tail[1..3], 10) catch return null;
        const minutes = std.fmt.parseInt(u8, tail[4..6], 10) catch return null;
        if (hours > 23 or minutes > 59) return null;
        offset = (@as(i64, hours) * 60 + minutes) * 60;
        if (tail[0] == '-') offset = -offset;
        stamp = std.fmt.bufPrint(&normalized, "{s}Z", .{raw[0 .. raw.len - 6]}) catch return null;
    }
    return @divFloor(common.timestampMs(stamp) orelse return null, 1000) - offset;
}

pub fn limits(value: std.json.Value, provider: Provider) Limits {
    const format = provider.info().limits;
    var windows: [2]?Window = .{ null, null };
    for (format.windows, &windows, 0..) |name, *window, i| {
        const item = field(value, name);
        const used = percent(field(item, format.used)) orelse continue;
        window.* = .{ .minutes = windowMinutes(format, item, i), .used = @intFromFloat(@round(used)), .reset_at = resetTimestamp(item, format) };
    }
    return if (windows[0] == null and windows[1] == null) .none else .{ .windows = windows };
}

pub fn codexAccount(value: std.json.Value) Info {
    var info: Info = .{};
    info.signed_in = value != .null;
    const email = str(value, "email");
    const api = std.mem.eql(u8, str(value, "type"), "apiKey");
    info.account = .ascii(if (api) "API key" else if (email.len > 0) email else if (value == .null) "Not signed in" else "Signed in");
    info.plan = .ascii(if (api) "API" else str(value, "planType"));
    if (api) info.limits = .metered;
    return info;
}

pub fn claudeAccount(value: std.json.Value) Info {
    var info: Info = .{};
    const logged = field(value, "loggedIn");
    if (logged != .bool) return info;
    info.signed_in = logged.bool;
    const api = std.mem.eql(u8, str(value, "authMethod"), "api_key");
    const email = str(value, "email");
    info.account = .ascii(if (!logged.bool) "Not signed in" else if (api) "API key" else if (email.len > 0) email else "Signed in");
    if (logged.bool) {
        info.plan = .ascii(if (api) "API" else str(value, "subscriptionType"));
        if (api) info.limits = .metered;
    }
    return info;
}

fn percent(value: std.json.Value) ?f64 {
    const n: f64 = switch (value) {
        .integer => @floatFromInt(value.integer),
        .float => value.float,
        else => return null,
    };
    return if (std.math.isFinite(n) and n >= 0 and n <= 100) n else null;
}

test "account usage distinguishes missing windows from zero and preserves durations" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"primary":{"usedPercent":0,"windowDurationMins":300},"secondary":{"usedPercent":63,"windowDurationMins":10080}}
    , .{});
    defer parsed.deinit();
    const codex = limits(parsed.value, .codex).windows;
    var buf: [16]u8 = undefined;
    try std.testing.expectEqual(@as(u8, 0), codex[0].?.used);
    try std.testing.expectEqualStrings("5h", codex[0].?.label(&buf));
    try std.testing.expectEqual(@as(u8, 63), codex[1].?.used);
    try std.testing.expectEqualStrings("7d", codex[1].?.label(&buf));
    const missing = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"five_hour":null,"seven_day":{"utilization":42.3}}
    , .{});
    defer missing.deinit();
    const claude = limits(missing.value, .claude).windows;
    try std.testing.expectEqual(@as(?Window, null), claude[0]);
    try std.testing.expectEqual(@as(u8, 42), claude[1].?.used);
    try std.testing.expectEqualStrings("7d", claude[1].?.label(&buf));
    try std.testing.expect(limits(.null, .claude) == .none);
    try std.testing.expectEqualStrings("Window", (Window{}).label(&buf));
}

test "signed out and API accounts do not borrow subscription details" {
    const logged_out = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"loggedIn":false,"email":"old@example.com","subscriptionType":"max","accessToken":"secret"}
    , .{});
    defer logged_out.deinit();
    const out = claudeAccount(logged_out.value);
    try std.testing.expectEqualStrings("Not signed in", out.account.text());
    try std.testing.expectEqualStrings("", out.plan.text());
    const api = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"type":"apiKey","planType":"pro","email":"old@example.com"}
    , .{});
    defer api.deinit();
    const info = codexAccount(api.value);
    try std.testing.expectEqualStrings("API key", info.account.text());
    try std.testing.expectEqualStrings("API", info.plan.text());
    try std.testing.expect(info.limits == .metered);
}

test "reset countdown rounds up and belongs to its window" {
    var buf: [48]u8 = undefined;
    try std.testing.expectEqualStrings("now", resetCountdown(99, 100, &buf));
    try std.testing.expectEqualStrings("1m", resetCountdown(101, 100, &buf));
    try std.testing.expectEqualStrings("2h 15m", resetCountdown(8200, 100, &buf));
    try std.testing.expectEqualStrings("3d 4h", resetCountdown(273700, 100, &buf));
    const codex = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":8200},"secondary":{"usedPercent":63,"windowDurationMins":10080,"resetsAt":273700}}
    , .{});
    defer codex.deinit();
    const codex_windows = limits(codex.value, .codex).windows;
    try std.testing.expectEqualStrings("2h 15m", codex_windows[0].?.countdown(100, &buf).?);
    try std.testing.expectEqualStrings("3d 4h", codex_windows[1].?.countdown(100, &buf).?);
    const claude = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"five_hour":{"utilization":12,"resets_at":"2026-09-24T12:00:00.000000+00:00"},"seven_day":{"utilization":48,"resets_at":"2026-09-27T16:00:00Z"}}
    , .{});
    defer claude.deinit();
    const claude_windows = limits(claude.value, .claude).windows;
    const now = @divExact(common.timestampMs("2026-09-24T10:00:00Z").?, 1000);
    try std.testing.expectEqualStrings("2h", claude_windows[0].?.countdown(now, &buf).?);
    try std.testing.expectEqualStrings("3d 6h", claude_windows[1].?.countdown(now, &buf).?);
    try std.testing.expectEqual(@as(?[]const u8, null), (Window{ .used = 48 }).countdown(now, &buf));
}
