//! Account-scoped preview cache and request gate, shared by daemon processes.
//! Only public display metadata and deadlines are persisted, never credentials.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const metadata = @import("account_preview.zig");
const log = std.log.scoped(.account_cache);
pub const interval: i64 = 60;
pub const cooldown: i64 = 5 * 60;

pub const State = struct {
    info: metadata.Info = .{},
    next_usage: i64 = 0,
    next_profile: i64 = 0,
    rate_limited: bool = false,

    pub fn update(s: *State, fresh: metadata.Info, now: i64) void {
        const previous = s.info;
        s.info = fresh;
        if (fresh.limits != .none) {
            s.info.usage_fetched_at = now;
        } else if (fresh.signed_in == true and previous.limits != .none) {
            s.info.limits = previous.limits;
            s.info.usage_fetched_at = previous.usage_fetched_at;
        }
    }
    /// Viewers hide expired windows themselves; this only explains why.
    pub fn display(s: State, now: i64) metadata.Info {
        var result = s.info;
        if (s.rate_limited and result.usage_error.len == 0) result.usage_error.set("server returned 429");
        switch (result.limits) {
            .windows => if (metadata.expired(result.usage_fetched_at, now) and result.usage_error.len == 0)
                result.usage_error.set(if (result.usage_fetched_at <= 0) "fetch time unknown" else "last success 10m+ ago"),
            .none => if (s.rate_limited) {
                result.limits = .rate_limited;
            },
            .metered, .rate_limited => {},
        }
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
pub const Cache = Locked(State, "account-previews");

/// A private JSON state file under `dir`, named by `kind` and a fingerprint of
/// an identity, and held under an exclusive lock while open.
pub fn Locked(comptime T: type, comptime dir: []const u8) type {
    return struct {
        const Self = @This();
        file: std.fs.File,
        state: T = .{},
        pub fn open(kind: []const u8, identity: []const u8, stopping: *const std.atomic.Value(bool)) !Self {
            const home = os.env("HOME") orelse return error.NoHome;
            const root = if (os.env("XDG_STATE_HOME")) |state|
                try std.fs.path.join(a, &.{ state, "corgi", dir })
            else
                try std.fs.path.join(a, &.{ home, ".local", "state", "corgi", dir });
            defer a.free(root);
            try std.fs.cwd().makePath(root);
            var digest: [32]u8 = undefined;
            std.crypto.hash.sha2.Sha256.hash(identity, &digest, .{});
            const name = try std.fmt.allocPrint(a, "{s}/{s}-{s}.json", .{ root, kind, std.fmt.bytesToHex(digest, .lower) });
            defer a.free(name);
            const file = try std.fs.cwd().createFile(name, .{ .read = true, .truncate = false, .mode = 0o600 });
            errdefer file.close();
            const deadline = std.time.milliTimestamp() + 10000;
            while (!try file.tryLock(.exclusive)) {
                if (stopping.load(.acquire) or std.time.milliTimestamp() >= deadline) return error.CacheBusy;
                std.Thread.sleep(10 * std.time.ns_per_ms);
            }
            var result: Self = .{ .file = file };
            const bytes = try file.readToEndAlloc(a, 16384);
            defer a.free(bytes);
            if (bytes.len == 0) return result;
            if (std.json.parseFromSlice(T, a, bytes, .{ .ignore_unknown_fields = true })) |parsed| {
                defer parsed.deinit();
                result.state = parsed.value;
            } else |err| log.warn("discarding unreadable {s} {s} file: {}", .{ kind, dir, err });
            return result;
        }
        pub fn save(self: *Self) !void {
            const bytes = try std.json.Stringify.valueAlloc(a, self.state, .{});
            defer a.free(bytes);
            try self.file.seekTo(0);
            try self.file.writeAll(bytes);
            try self.file.setEndPos(bytes.len);
            try self.file.sync();
        }
        pub fn close(self: *Self) void {
            self.file.unlock();
            self.file.close();
        }
    };
}

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
    fresh.limits = .{ .windows = .{ .{ .minutes = 300, .used = 12, .reset_at = 1700001000 }, null } };
    state.update(fresh, 1000);
    fresh.limits = .none;
    state.update(fresh, 1100);
    try std.testing.expectEqual(@as(u8, 12), state.display(1100).limits.windows[0].?.used);
    try std.testing.expectEqual(@as(i64, 1000), state.info.usage_fetched_at);
    try std.testing.expectEqual(@as(?i64, 1700001000), state.info.limits.windows[0].?.reset_at);
    fresh.limits = .{ .windows = .{ .{ .minutes = 300, .used = 14 }, null } };
    state.update(fresh, 1200);
    try std.testing.expectEqual(@as(i64, 1200), state.info.usage_fetched_at);
    try std.testing.expectEqual(@as(u8, 14), state.info.limits.windows[0].?.used);
    state.update(.{ .signed_in = false }, 1300);
    try std.testing.expect(state.info.limits == .none);
}

test "usage age follows successful fetches and expires at ten minutes" {
    var state: State = .{};
    var fresh: metadata.Info = .{ .signed_in = true };
    fresh.limits = .{ .windows = .{ null, .{ .minutes = 10080, .used = 48, .reset_at = 90000 } } };
    state.update(fresh, 1000);
    state.rate_limited = true;
    state.next_usage = 2000;
    state.update(.{ .signed_in = true }, 1500);
    const recent = state.display(1599);
    try std.testing.expectEqual(@as(u8, 48), recent.limits.windows[1].?.used);
    try std.testing.expect(!metadata.expired(recent.usage_fetched_at, 1599));
    // Retained for the viewer, which hides it once expired.
    const old = state.display(1600);
    try std.testing.expect(old.limits == .windows);
    try std.testing.expect(metadata.expired(old.usage_fetched_at, 1600));
    try std.testing.expectEqual(@as(i64, 1000), state.info.usage_fetched_at);
    state.update(fresh, 1601);
    try std.testing.expect(!metadata.expired(state.display(1601).usage_fetched_at, 1601));
    state.info.usage_fetched_at = 0;
    state.rate_limited = false;
    try std.testing.expectEqualStrings("fetch time unknown", state.display(1601).usage_error.text());
}

test "usage failures preserve recent readings and give stale readings a reason" {
    var state: State = .{};
    var fresh: metadata.Info = .{ .signed_in = true };
    fresh.limits = .{ .windows = .{ null, .{ .minutes = 10080, .used = 48 } } };
    state.update(fresh, 1000);
    state.failedResponse(429);
    try std.testing.expectEqual(@as(u8, 48), state.display(1100).limits.windows[1].?.used);
    try std.testing.expectEqualStrings("server returned 429", state.display(1600).usage_error.text());
    state.failedResponse(503);
    try std.testing.expectEqualStrings("server returned 503", state.display(1600).usage_error.text());
    state.failedResponse(0);
    try std.testing.expectEqualStrings("request failed", state.display(1600).usage_error.text());
    state.update(fresh, 1601);
    try std.testing.expectEqual(@as(usize, 0), state.info.usage_error.len);
    try std.testing.expectEqualStrings("last success 10m+ ago", state.display(2201).usage_error.text());
    var empty: State = .{};
    empty.failedResponse(429);
    try std.testing.expect(empty.display(1000).limits == .rate_limited);
    empty.failedResponse(503);
    try std.testing.expect(empty.display(1000).limits == .none);
}
