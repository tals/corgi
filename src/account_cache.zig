//! Account-scoped preview cache and request gate, shared by daemon processes.
//! Only public display metadata and deadlines are persisted, never credentials.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const metadata = @import("account_preview.zig");
const log = std.log.scoped(.account_cache);
pub const interval: i64 = 60;
pub const cooldown: i64 = 5 * 60;
/// The one place the producer's "Metered" text is read back; callers use the
/// typed `Option.usage_metered` it feeds.
pub fn isMetered(usage_text: []const u8) bool {
    return std.mem.eql(u8, usage_text, "Metered");
}

pub const State = struct {
    info: metadata.Info = .{},
    next_usage: i64 = 0,
    next_profile: i64 = 0,
    rate_limited: bool = false,

    pub fn update(s: *State, fresh: metadata.Info, now: i64) void {
        const previous = s.info;
        s.info = fresh;
        if (fresh.usage.len > 0) {
            s.info.usage_fetched_at = now;
        } else if (fresh.signed_in == true and previous.usage.len > 0) {
            s.info.usage = previous.usage;
            s.info.resets = previous.resets;
            s.info.usage_fetched_at = previous.usage_fetched_at;
        }
    }
    pub fn display(s: State, now: i64) metadata.Info {
        var result = s.info;
        if (s.rate_limited and result.usage_error.len == 0) result.usage_error.set("server returned 429");
        if (result.usage.len > 0) {
            if (!isMetered(result.usage.text()) and
                (result.usage_fetched_at <= 0 or now -| result.usage_fetched_at >= metadata.usage_max_age))
            {
                result.usage.set("Unavailable");
                result.resets = .{};
                if (result.usage_error.len == 0) result.usage_error.set(if (result.usage_fetched_at <= 0) "fetch time unknown" else "last success 10m+ ago");
            }
        } else if (s.rate_limited) result.usage.set("Rate limited");
        return result;
    }

    pub fn failed(s: *State, reason: []const u8) void {
        s.rate_limited = false;
        s.info.usage_error.set(reason);
    }

    pub fn failedResponse(s: *State, status: u16) void {
        var buffer: [48]u8 = undefined;
        s.failed(if (status == 0) "request failed" else std.fmt.bufPrint(&buffer, "server returned {d}", .{status}) catch "request failed");
        s.rate_limited = status == 429;
    }
};
pub const Cache = struct {
    file: std.fs.File,
    state: State = .{},
    pub fn open(provider: []const u8, identity: []const u8, stopping: *const std.atomic.Value(bool)) !Cache {
        const home = os.env("HOME") orelse return error.NoHome;
        const root = if (os.env("XDG_STATE_HOME")) |state|
            try std.fs.path.join(a, &.{ state, "corgi", "account-previews" })
        else
            try std.fs.path.join(a, &.{ home, ".local", "state", "corgi", "account-previews" });
        defer a.free(root);
        try std.fs.cwd().makePath(root);
        var digest: [32]u8 = undefined;
        std.crypto.hash.sha2.Sha256.hash(identity, &digest, .{});
        const name = try std.fmt.allocPrint(a, "{s}/{s}-{s}.json", .{ root, provider, std.fmt.bytesToHex(digest, .lower) });
        defer a.free(name);
        const file = try std.fs.cwd().createFile(name, .{ .read = true, .truncate = false, .mode = 0o600 });
        errdefer file.close();
        const deadline = std.time.milliTimestamp() + 10000;
        while (!try file.tryLock(.exclusive)) {
            if (stopping.load(.acquire) or std.time.milliTimestamp() >= deadline) return error.CacheBusy;
            std.Thread.sleep(10 * std.time.ns_per_ms);
        }
        var result: Cache = .{ .file = file };
        const bytes = try file.readToEndAlloc(a, 16384);
        defer a.free(bytes);
        if (std.json.parseFromSlice(State, a, bytes, .{ .ignore_unknown_fields = true })) |parsed| {
            defer parsed.deinit();
            result.state = parsed.value;
        } else |err| log.warn("discarding unreadable {s} account cache: {}", .{ provider, err });
        return result;
    }
    pub fn save(cache: *Cache) !void {
        const bytes = try std.json.Stringify.valueAlloc(a, cache.state, .{});
        defer a.free(bytes);
        try cache.file.seekTo(0);
        try cache.file.writeAll(bytes);
        try cache.file.setEndPos(bytes.len);
        try cache.file.sync();
    }
    pub fn close(cache: *Cache) void {
        cache.file.unlock();
        cache.file.close();
    }
};

pub const Response = struct { status: u16 = 0, retry_at: ?i64 = null, body: []const u8 = "" };
pub fn response(bytes: []const u8, now: i64) Response {
    var rest = bytes;
    var result: Response = .{};
    // curl --include can emit a proxy CONNECT or informational header first.
    while (std.mem.startsWith(u8, rest, "HTTP/")) {
        const end = std.mem.indexOf(u8, rest, "\r\n\r\n") orelse return .{};
        var lines = std.mem.splitSequence(u8, rest[0..end], "\r\n");
        var status = std.mem.tokenizeScalar(u8, lines.next().?, ' ');
        _ = status.next();
        result = .{ .status = std.fmt.parseInt(u16, status.next() orelse "", 10) catch 0 };
        while (lines.next()) |line| {
            const colon = std.mem.indexOfScalar(u8, line, ':') orelse continue;
            if (std.ascii.eqlIgnoreCase(line[0..colon], "retry-after")) result.retry_at = retryAt(std.mem.trim(u8, line[colon + 1 ..], " \t"), now);
        }
        rest = rest[end + 4 ..];
    }
    result.body = rest;
    return result;
}
fn retryAt(value: []const u8, now: i64) ?i64 {
    if (std.fmt.parseInt(u32, value, 10)) |seconds| return now + seconds else |_| {}
    const c = @cImport({
        @cInclude("time.h");
    });
    const terminated = a.dupeZ(u8, value) catch return null;
    defer a.free(terminated);
    var tm = std.mem.zeroes(c.struct_tm);
    const end = c.strptime(terminated, "%a, %d %b %Y %H:%M:%S GMT", &tm);
    if (end == null or end[0] != 0) return null;
    const timestamp = c.timegm(&tm);
    return if (timestamp > now) timestamp else null;
}
pub fn nextAttempt(reply: Response, now: i64) i64 {
    return if (reply.status == 429) @max(now + interval, reply.retry_at orelse (now + cooldown)) else now + interval;
}

test "HTTP retry gate honors seconds and dates with a one-minute floor" {
    const now: i64 = 1700000000;
    const seconds = response("HTTP/2 429\r\nRetry-After: 120\r\n\r\n{}", now);
    try std.testing.expectEqual(now + 120, nextAttempt(seconds, now));
    try std.testing.expectEqual(now + cooldown, nextAttempt(.{ .status = 429 }, now));
    try std.testing.expectEqual(now + interval, nextAttempt(.{ .status = 429, .retry_at = now + 1 }, now));
    const date = response("HTTP/1.1 200 Connection established\r\n\r\nHTTP/2 429\r\nretry-after: Tue, 14 Nov 2023 22:15:20 GMT\r\n\r\n{}", now);
    try std.testing.expectEqual(now + 120, nextAttempt(date, now));
    try std.testing.expectEqualStrings("{}", date.body);
}

test "partial account refresh retains usage until a fresh reading or sign-out" {
    var state: State = .{};
    var fresh: metadata.Info = .{ .signed_in = true };
    fresh.account.set("user@example.com");
    fresh.usage.set("5h 12%");
    fresh.resets.at[0] = 1700001000;
    state.update(fresh, 1000);
    fresh.usage = .{};
    fresh.resets = .{};
    state.update(fresh, 1100);
    try std.testing.expectEqualStrings("5h 12%", state.display(1100).usage.text());
    try std.testing.expectEqual(@as(i64, 1000), state.info.usage_fetched_at);
    try std.testing.expectEqual(@as(?i64, 1700001000), state.info.resets.at[0]);
    fresh.usage.set("5h 14%");
    state.update(fresh, 1200);
    try std.testing.expectEqual(@as(i64, 1200), state.info.usage_fetched_at);
    try std.testing.expectEqualStrings("5h 14%", state.info.usage.text());
    state.update(.{ .signed_in = false }, 1300);
    try std.testing.expectEqual(@as(usize, 0), state.info.usage.len);
}

test "usage age follows successful fetches and expires at ten minutes" {
    var state: State = .{};
    var fresh: metadata.Info = .{ .signed_in = true };
    fresh.usage.set("7d 48%");
    fresh.resets.at[1] = 90000;
    state.update(fresh, 1000);
    state.rate_limited = true;
    state.next_usage = 2000;
    state.update(.{ .signed_in = true }, 1500);
    try std.testing.expectEqualStrings("7d 48%", state.display(1599).usage.text());
    try std.testing.expectEqualStrings("Unavailable", state.display(1600).usage.text());
    try std.testing.expectEqual(@as(?i64, null), state.display(1600).resets.at[1]);
    try std.testing.expectEqualStrings("7d 48%", state.info.usage.text());
    try std.testing.expectEqual(@as(i64, 1000), state.info.usage_fetched_at);
    state.update(fresh, 1601);
    try std.testing.expectEqualStrings("7d 48%", state.display(1601).usage.text());
    state.info.usage_fetched_at = 0;
    try std.testing.expectEqualStrings("Unavailable", state.display(1601).usage.text());
}

test "usage failures preserve recent readings and give stale readings a reason" {
    var state: State = .{};
    var fresh: metadata.Info = .{ .signed_in = true };
    fresh.usage.set("7d 48%");
    state.update(fresh, 1000);
    state.failedResponse(429);
    try std.testing.expectEqualStrings("7d 48%", state.display(1100).usage.text());
    try std.testing.expectEqualStrings("server returned 429", state.display(1600).usage_error.text());
    state.failedResponse(503);
    try std.testing.expectEqualStrings("server returned 503", state.display(1600).usage_error.text());
    state.failedResponse(0);
    try std.testing.expectEqualStrings("request failed", state.display(1600).usage_error.text());
    state.update(fresh, 1601);
    try std.testing.expectEqual(@as(usize, 0), state.info.usage_error.len);
    try std.testing.expectEqualStrings("last success 10m+ ago", state.display(2201).usage_error.text());
}
