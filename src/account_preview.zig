//! Public account metadata only. Credentials never enter the preview protocol.
const std = @import("std");
const common = @import("providers/common.zig");
const field = common.field;
const str = common.str;
pub const Text = struct {
    bytes: [160]u8 = @splat(0),
    len: usize = 0,
    pub fn set(t: *Text, value: []const u8) void {
        t.len = @import("agents.zig").clean(&t.bytes, value);
    }
    pub fn text(t: *const Text) []const u8 {
        return t.bytes[0..t.len];
    }
};
pub const Info = struct { signed_in: ?bool = null, account: Text = .{}, plan: Text = .{}, usage: Text = .{}, resets: Resets = .{}, usage_needs_consent: bool = false };

pub const Resets = struct {
    at: [2]?i64 = .{ null, null },
    labels: [2]Text = .{ .{}, .{} },

    pub fn text(r: *const Resets, now: i64) Text {
        var result: Text = .{};
        var buf: [160]u8 = undefined;
        var writer = std.Io.Writer.fixed(&buf);
        for (r.at, r.labels) |at, label| {
            const stamp = at orelse continue;
            if (writer.end > 0) writer.writeAll(" / ") catch break;
            var countdown_text: [48]u8 = undefined;
            writer.print("{s} {s}", .{ label.text(), resetCountdown(stamp, now, &countdown_text) }) catch break;
        }
        result.set(writer.buffered());
        return result;
    }
};

fn resetCountdown(at: i64, now: i64, buf: []u8) []const u8 {
    const seconds = at -| now;
    if (seconds <= 0) return "now";
    const minutes = @divTrunc(seconds, 60) + @as(i64, if (@mod(seconds, 60) > 0) 1 else 0);
    const days = @divTrunc(minutes, 1440);
    const hours = @mod(@divTrunc(minutes, 60), 24);
    const mins = @mod(minutes, 60);
    return if (days > 0)
        (if (hours > 0) std.fmt.bufPrint(buf, "{d}d {d}h", .{ days, hours }) else if (mins > 0) std.fmt.bufPrint(buf, "{d}d {d}m", .{ days, mins }) else std.fmt.bufPrint(buf, "{d}d", .{days})) catch ""
    else if (hours > 0)
        (if (mins > 0) std.fmt.bufPrint(buf, "{d}h {d}m", .{ hours, mins }) else std.fmt.bufPrint(buf, "{d}h", .{hours})) catch ""
    else
        std.fmt.bufPrint(buf, "{d}m", .{minutes}) catch "";
}

fn resetTimestamp(value: std.json.Value, codex: bool) ?i64 {
    if (codex) {
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
    return @divFloor(@import("transcript.zig").timestampMs(stamp) orelse return null, 1000) - offset;
}

pub fn resets(value: std.json.Value, codex: bool) Resets {
    var result: Resets = .{};
    const windows = [_]std.json.Value{ field(value, if (codex) "primary" else "five_hour"), field(value, if (codex) "secondary" else "seven_day") };
    for (windows, 0..) |item, i| {
        if (percent(field(item, if (codex) "usedPercent" else "utilization")) == null) continue;
        result.at[i] = resetTimestamp(item, codex);
        var buf: [32]u8 = undefined;
        result.labels[i].set(if (codex) duration(item, &buf) else if (i == 0) "5h" else "7d");
    }
    return result;
}

pub fn codexAccount(value: std.json.Value) Info {
    var info: Info = .{};
    info.signed_in = value != .null;
    const email = str(value, "email");
    const api = std.mem.eql(u8, str(value, "type"), "apiKey");
    info.account.set(if (api) "API key" else if (email.len > 0) email else if (value == .null) "Not signed in" else "Signed in");
    info.plan.set(if (api) "API" else str(value, "planType"));
    if (api) info.usage.set("Metered");
    return info;
}

pub fn claudeAccount(value: std.json.Value) Info {
    var info: Info = .{};
    const logged = field(value, "loggedIn");
    if (logged != .bool) return info;
    info.signed_in = logged.bool;
    const api = std.mem.eql(u8, str(value, "authMethod"), "api_key");
    const email = str(value, "email");
    info.account.set(if (!logged.bool) "Not signed in" else if (api) "API key" else if (email.len > 0) email else "Signed in");
    if (logged.bool) {
        info.plan.set(if (api) "API" else str(value, "subscriptionType"));
        if (api) info.usage.set("Metered");
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

fn window(value: std.json.Value, key: []const u8, label: []const u8, buf: []u8) []const u8 {
    const used = percent(field(value, key)) orelse return "";
    return std.fmt.bufPrint(buf, "{s} {d:.0}%", .{ label, used }) catch "";
}

fn duration(value: std.json.Value, buf: []u8) []const u8 {
    const minutes = field(value, "windowDurationMins");
    if (minutes != .integer or minutes.integer <= 0) return "Window";
    const n = minutes.integer;
    return if (@mod(n, 1440) == 0) std.fmt.bufPrint(buf, "{d}d", .{@divExact(n, 1440)}) catch "Window" else if (@mod(n, 60) == 0) std.fmt.bufPrint(buf, "{d}h", .{@divExact(n, 60)}) catch "Window" else std.fmt.bufPrint(buf, "{d}m", .{n}) catch "Window";
}

pub fn usage(value: std.json.Value, codex: bool) Text {
    var first_buf: [64]u8 = undefined;
    var second_buf: [64]u8 = undefined;
    var first_label: [32]u8 = undefined;
    var second_label: [32]u8 = undefined;
    const first = field(value, if (codex) "primary" else "five_hour");
    const second = field(value, if (codex) "secondary" else "seven_day");
    const key = if (codex) "usedPercent" else "utilization";
    const one = window(first, key, if (codex) duration(first, &first_label) else "5h", &first_buf);
    const two = window(second, key, if (codex) duration(second, &second_label) else "7d", &second_buf);
    var result: Text = .{};
    var buf: [160]u8 = undefined;
    result.set(std.fmt.bufPrint(&buf, "{s}{s}{s}", .{ one, if (one.len > 0 and two.len > 0) " / " else "", two }) catch "");
    return result;
}

test "account usage distinguishes missing windows from zero and preserves durations" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"primary":{"usedPercent":0,"windowDurationMins":300},"secondary":{"usedPercent":63,"windowDurationMins":10080}}
    , .{});
    defer parsed.deinit();
    try std.testing.expectEqualStrings("5h 0% / 7d 63%", usage(parsed.value, true).text());
    const missing = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"five_hour":null,"seven_day":{"utilization":42.3}}
    , .{});
    defer missing.deinit();
    try std.testing.expectEqualStrings("7d 42%", usage(missing.value, false).text());
    try std.testing.expectEqualStrings("", usage(.null, false).text());
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
    try std.testing.expectEqualStrings("Metered", info.usage.text());
}

test "reset countdown rounds up and preserves window labels" {
    var buf: [48]u8 = undefined;
    try std.testing.expectEqualStrings("now", resetCountdown(99, 100, &buf));
    try std.testing.expectEqualStrings("1m", resetCountdown(101, 100, &buf));
    try std.testing.expectEqualStrings("2h 15m", resetCountdown(8200, 100, &buf));
    try std.testing.expectEqualStrings("3d 4h", resetCountdown(273700, 100, &buf));
    const codex = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"primary":{"usedPercent":0,"windowDurationMins":300,"resetsAt":8200},"secondary":{"usedPercent":63,"windowDurationMins":10080,"resetsAt":273700}}
    , .{});
    defer codex.deinit();
    const times = resets(codex.value, true);
    try std.testing.expectEqualStrings("5h 2h 15m / 7d 3d 4h", times.text(100).text());
    const claude = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"five_hour":{"utilization":12,"resets_at":"2026-09-24T12:00:00.000000+00:00"},"seven_day":{"utilization":48,"resets_at":"2026-09-27T16:00:00Z"}}
    , .{});
    defer claude.deinit();
    const claude_times = resets(claude.value, false);
    const now = @divExact(@import("transcript.zig").timestampMs("2026-09-24T10:00:00Z").?, 1000);
    try std.testing.expectEqualStrings("5h 2h / 7d 3d 6h", claude_times.text(now).text());
    const unknown = resets(.null, false);
    try std.testing.expectEqualStrings("", unknown.text(now).text());
}
