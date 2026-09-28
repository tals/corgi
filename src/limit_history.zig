//! Usage history behind the limits pane's sparks. Each window's span, from its
//! start to its reset, is split into `cells` slots; a slot keeps the last
//! reading taken during it, and a slot with no reading stays null, so time
//! without a daemon shows as a gap. Files are keyed by provider and account,
//! not credential, because credentials rotate on every token refresh.
const std = @import("std");
const metadata = @import("account_preview.zig");
const account_cache = @import("account_cache.zig");
const Provider = @import("providers.zig").Provider;
const log = std.log.scoped(.limit_history);

pub const cells = 11;
/// Percent used per slot, oldest first; null where no reading was taken.
pub const Spark = [cells]?u8;
pub const none: [2]Spark = @splat(@splat(null));

const Track = struct {
    minutes: i64 = 0,
    reset_at: i64 = 0,
    spark: Spark = @splat(null),
};

pub const State = struct {
    tracks: [2]Track = .{ .{}, .{} },

    /// Files each window's reading at `at` into its slot and returns the
    /// sparks in the order of `windows`. Windows are matched by length.
    pub fn record(s: *State, windows: [2]?metadata.Window, at: i64) [2]Spark {
        var result = none;
        for (windows, &result) |maybe, *out| {
            const window = maybe orelse continue;
            const minutes = window.minutes orelse continue;
            const reset = window.reset_at orelse continue;
            if (minutes <= 0) continue;
            const span = minutes * 60;
            const track = s.find(minutes);
            // A reset more than one slot away starts a new window.
            if (@abs(track.reset_at - reset) * cells > @as(u64, @intCast(span))) track.* = .{ .minutes = minutes, .reset_at = reset };
            const start = track.reset_at - span;
            if (at >= start and at < track.reset_at) track.spark[@intCast(@divFloor((at - start) * cells, span))] = window.used;
            out.* = track.spark;
        }
        return result;
    }

    fn find(s: *State, minutes: i64) *Track {
        for (&s.tracks) |*track| if (track.minutes == minutes) return track;
        for (&s.tracks) |*track| if (track.minutes == 0) return track;
        s.tracks[1] = s.tracks[0];
        s.tracks[0] = .{};
        return &s.tracks[0];
    }
};

const Store = account_cache.Locked(State, "limit-history");
var last_error: ?anyerror = null;

/// Records an account's latest reading and returns its sparks. Only the
/// launcher worker thread calls this.
pub fn update(provider: Provider, info: metadata.Info, stopping: *const std.atomic.Value(bool)) [2]Spark {
    const windows = switch (info.limits) {
        .windows => |windows| windows,
        else => return none,
    };
    if (info.usage_fetched_at <= 0) return none;
    return store(provider, info.account.text(), windows, info.usage_fetched_at, stopping) catch |err| {
        const repeat = if (last_error) |previous| previous == err else false;
        if (!repeat) log.warn("limit history update failed: {}", .{err});
        last_error = err;
        return none;
    };
}

fn store(provider: Provider, account: []const u8, windows: [2]?metadata.Window, at: i64, stopping: *const std.atomic.Value(bool)) ![2]Spark {
    var file = try Store.open(@tagName(provider), account, stopping);
    defer file.close();
    const before = file.state;
    const sparks = file.state.record(windows, at);
    if (!std.meta.eql(before, file.state)) try file.save();
    last_error = null;
    return sparks;
}

test "readings fill their slot and leave unread slots as gaps" {
    var state: State = .{};
    const reset: i64 = 300 * 60;
    const five: metadata.Window = .{ .minutes = 300, .used = 12, .reset_at = reset };
    _ = state.record(.{ five, null }, 60);
    var later = five;
    later.used = 40;
    const sparks = state.record(.{ later, null }, 150 * 60);
    try std.testing.expectEqual(@as(?u8, 12), sparks[0][0]);
    try std.testing.expectEqual(@as(?u8, null), sparks[0][1]);
    try std.testing.expectEqual(@as(?u8, 40), sparks[0][5]);
    try std.testing.expectEqual(@as(?u8, null), sparks[1][0]);
    // The newest reading in a slot wins.
    later.used = 44;
    try std.testing.expectEqual(@as(?u8, 44), state.record(.{ later, null }, 150 * 60 + 30)[0][5]);
}

test "a new reset starts a new spark while drift within a slot does not" {
    var state: State = .{};
    const week: metadata.Window = .{ .minutes = 10080, .used = 30, .reset_at = 10080 * 60 };
    _ = state.record(.{ null, week }, 60);
    var drifted = week;
    drifted.reset_at = week.reset_at.? + 90;
    drifted.used = 31;
    const same = state.record(.{ null, drifted }, 2 * 86400);
    try std.testing.expectEqual(@as(?u8, 30), same[1][0]);
    try std.testing.expectEqual(@as(?u8, 31), same[1][3]);
    var next = week;
    next.reset_at = week.reset_at.? + 10080 * 60;
    next.used = 2;
    const fresh = state.record(.{ null, next }, week.reset_at.? + 60);
    try std.testing.expectEqual(@as(?u8, 2), fresh[1][0]);
    try std.testing.expectEqual(@as(?u8, null), fresh[1][3]);
}

test "windows follow their length across provider slots and unknown resets have no spark" {
    var state: State = .{};
    const week: metadata.Window = .{ .minutes = 10080, .used = 84, .reset_at = 10080 * 60 };
    _ = state.record(.{ week, null }, 60);
    // The same weekly window reported in the other slot keeps its history.
    try std.testing.expectEqual(@as(?u8, 84), state.record(.{ null, week }, 120)[1][0]);
    const unknown: metadata.Window = .{ .minutes = 300, .used = 5 };
    try std.testing.expectEqual(@as(?u8, null), state.record(.{ unknown, null }, 60)[0][0]);
}
