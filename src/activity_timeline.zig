//! A bounded, runtime-only record of activity intervals. The last point is
//! current; pending includes its accumulated usage and new observations.
//! Tokens are observed during each interval, not causal attribution to a tool.
//! Meters count from when Corgi began observing, so a missing reading means
//! nothing was observed yet. Only a loss inside an interval makes it partial.
const std = @import("std");
const summary = @import("activity_summary.zig");
const usage = @import("live_usage.zig");

pub const Point = struct { at: i64, label: summary.Label, usage: usage.View, steps: u32 = 0 };
pub const Timeline = struct {
    points: [4]Point = undefined,
    len: usize = 0,
    baseline: usage.View = .{ .known = true },
    turn: [160]u8 = @splat(0),
    turn_len: usize = 0,
    // Tool calls of a turn that has no summary yet join its first phase.
    fresh_steps: u32 = 0,

    pub fn step(t: *Timeline, turn: []const u8) void {
        if (t.len > 0 and std.mem.eql(u8, turn, t.turn[0..t.turn_len]))
            t.points[t.len - 1].steps +|= 1
        else
            t.fresh_steps +|= 1;
    }

    pub fn pending(t: *const Timeline, current: usage.View) usage.View {
        var value = t.observedDelta(current);
        if (t.len > 0) {
            const last = t.points[t.len - 1].usage;
            value.tokens.add(last.tokens);
            value.known = value.known or last.known;
            value.partial = value.partial or last.partial;
            value.losses +|= last.losses;
        }
        return value;
    }

    fn observedDelta(t: *const Timeline, current: usage.View) usage.View {
        var delta: usage.View = .{
            .known = current.known,
            .partial = current.losses != t.baseline.losses,
            .losses = current.losses -| t.baseline.losses,
            .since = if (t.len > 0) t.points[t.len - 1].at else current.since,
            .updated_at = current.updated_at,
        };
        if (!current.known) return delta;
        inline for (std.meta.fields(usage.Tokens)) |field| {
            const before = @field(t.baseline.tokens, field.name);
            const after = @field(current.tokens, field.name);
            @field(delta.tokens, field.name) = after -| before;
            if (after < before) delta.partial = true;
        }
        return delta;
    }

    pub fn checkpoint(t: *Timeline, turn: []const u8, label: summary.Label, current: usage.View, now: i64) void {
        const interval = t.pending(current);
        const at = if (t.len > 0) @max(now, t.points[t.len - 1].at) else now;
        if (t.len > 0) t.points[t.len - 1].usage = interval;
        if (t.len > 0 and std.mem.eql(u8, turn, t.turn[0..t.turn_len]) and std.mem.eql(u8, label.text(), t.points[t.len - 1].label.text())) {
            // Repeated summaries continue the same interval and start time.
            t.points[t.len - 1].steps +|= t.fresh_steps;
        } else {
            if (t.len == t.points.len) {
                std.mem.copyForwards(Point, t.points[0 .. t.len - 1], t.points[1..t.len]);
                t.len -= 1;
            }
            // Keep observations before the first summary with the first phase.
            t.points[t.len] = .{ .at = at, .label = label, .usage = if (t.len == 0) interval else .{ .known = current.known }, .steps = t.fresh_steps };
            t.len += 1;
        }
        t.fresh_steps = 0;
        t.turn_len = @min(turn.len, t.turn.len);
        @memcpy(t.turn[0..t.turn_len], turn[0..t.turn_len]);
        // Runtime counters are monotonic. Retain a high-water mark if telemetry
        // temporarily disappears or regresses so its return cannot bill twice.
        inline for (std.meta.fields(usage.Tokens)) |field| {
            @field(t.baseline.tokens, field.name) = @max(@field(t.baseline.tokens, field.name), @field(current.tokens, field.name));
        }
        t.baseline.known = current.known;
        t.baseline.losses = current.losses;
    }
};

test "checkpoints partition own usage, coalesce repeated labels, and remain bounded" {
    var timeline: Timeline = .{};
    const reading = summary.Label.parse("Reading source").?;
    const testing = summary.Label.parse("Running tests").?;
    var current: usage.View = .{ .known = true, .tokens = .{ .input = 100, .cached_input = 60, .output = 20 } };
    timeline.checkpoint("a", reading, current, 1000);
    current.tokens.add(.{ .input = 30, .cached_input = 10, .output = 5 });
    timeline.checkpoint("a", reading, current, 2000);
    try std.testing.expectEqual(@as(usize, 1), timeline.len);
    try std.testing.expectEqual(@as(u64, 155), timeline.points[0].usage.tokens.total());
    try std.testing.expectEqual(@as(i64, 1000), timeline.points[0].at);
    current.tokens.add(.{ .input = 40, .output = 10 });
    timeline.checkpoint("a", testing, current, 3000);
    try std.testing.expectEqual(@as(u64, 205), timeline.points[0].usage.tokens.total());
    try std.testing.expectEqual(@as(u64, 0), timeline.points[1].usage.tokens.total());
    current.tokens.add(.{ .input = 7, .output = 3 });
    try std.testing.expectEqual(@as(u64, 10), timeline.pending(current).tokens.total());
    try std.testing.expectEqual(@as(u64, 10), timeline.pending(current).tokens.total());
    timeline.checkpoint("b", testing, current, 4000);
    try std.testing.expectEqual(@as(usize, 3), timeline.len);
    for (0..8) |i| timeline.checkpoint("b", if (i % 2 == 0) reading else testing, current, @intCast(5000 + i));
    try std.testing.expectEqual(@as(usize, 4), timeline.len);
    try std.testing.expectEqual(@as(u64, 0), timeline.pending(current).tokens.total());
}

test "only intervals containing a loss or regression are partial" {
    var timeline: Timeline = .{};
    const label = summary.Label.parse("Reading source").?;
    const other = summary.Label.parse("Running tests").?;
    // Nothing observed yet is zero, not a gap in coverage.
    timeline.checkpoint("a", label, .{}, 1);
    timeline.checkpoint("a", label, .{ .known = true, .tokens = .{ .input = 100 } }, 2);
    try std.testing.expect(!timeline.points[0].usage.partial);
    try std.testing.expectEqual(@as(u64, 100), timeline.points[0].usage.tokens.total());
    // A counter regression cannot bill twice and marks only its interval.
    timeline.checkpoint("b", other, .{ .known = true, .tokens = .{ .input = 50 } }, 3);
    try std.testing.expectEqual(@as(u64, 0), timeline.points[1].usage.tokens.total());
    try std.testing.expect(timeline.points[0].usage.partial);
    try std.testing.expect(!timeline.points[1].usage.partial);
    const clean = timeline.pending(.{ .known = true, .tokens = .{ .input = 110 } });
    try std.testing.expectEqual(@as(u64, 10), clean.tokens.total());
    try std.testing.expect(!clean.partial);
    // A loss marks the interval it happened in, and no later ones.
    const lost: usage.View = .{ .known = true, .partial = true, .losses = 1, .tokens = .{ .input = 130 } };
    try std.testing.expect(timeline.pending(lost).partial);
    timeline.checkpoint("b", label, lost, 4);
    try std.testing.expect(timeline.points[1].usage.partial);
    try std.testing.expect(!timeline.points[2].usage.partial);
    var later = lost;
    later.tokens.input = 150;
    try std.testing.expect(!timeline.pending(later).partial);
    timeline.checkpoint("b", other, later, 5);
    try std.testing.expect(!timeline.points[3].usage.partial);
}

test "activity transitions charge the previous phase and pending retains repeated summaries" {
    var timeline: Timeline = .{};
    const reviewing = summary.Label.parse("Reviewing pending changes").?;
    const inspecting = summary.Label.parse("Inspecting repository changes").?;
    timeline.checkpoint("turn", reviewing, .{}, 1000);
    var current: usage.View = .{ .known = true, .tokens = .{ .input = 21500, .cached_input = 12800 } };
    timeline.checkpoint("turn", inspecting, current, 2000);
    const previous = timeline.points[0].usage.tokens;
    try std.testing.expectEqual(@as(u64, 8700), previous.input - previous.cached_input);
    try std.testing.expectEqual(@as(u64, 12800), previous.cached_input);
    current.tokens.add(.{ .input = 99600, .cached_input = 78700 });
    timeline.checkpoint("turn", inspecting, current, 3000);
    const live = timeline.pending(current).tokens;
    try std.testing.expectEqual(@as(usize, 2), timeline.len);
    try std.testing.expectEqual(@as(u64, 20900), live.input - live.cached_input);
    try std.testing.expectEqual(@as(u64, 78700), live.cached_input);
    try std.testing.expectEqual(@as(i64, 2000), timeline.points[1].at);
    timeline.checkpoint("turn", reviewing, current, 4000);
    try std.testing.expectEqual(live, timeline.points[1].usage.tokens);
    try std.testing.expectEqual(@as(u64, 0), timeline.pending(current).tokens.total());
}

test "steps count toward the current phase and a new turn's first phase" {
    var timeline: Timeline = .{};
    const reading = summary.Label.parse("Reading source").?;
    const testing = summary.Label.parse("Running tests").?;
    timeline.step("a");
    timeline.step("a");
    timeline.checkpoint("a", reading, .{}, 1);
    try std.testing.expectEqual(@as(u32, 2), timeline.points[0].steps);
    timeline.step("a");
    timeline.checkpoint("a", reading, .{}, 2);
    try std.testing.expectEqual(@as(u32, 3), timeline.points[0].steps);
    timeline.checkpoint("a", testing, .{}, 3);
    timeline.step("a");
    try std.testing.expectEqual(@as(u32, 1), timeline.points[1].steps);
    // A new turn's steps wait for its own first phase.
    timeline.step("b");
    try std.testing.expectEqual(@as(u32, 1), timeline.points[1].steps);
    timeline.checkpoint("b", testing, .{}, 4);
    try std.testing.expectEqual(@as(u32, 1), timeline.points[2].steps);
}
