//! A bounded, runtime-only record of activity intervals. The last point is
//! current; pending includes its accumulated usage and new observations.
//! Tokens are observed during each interval, not causal attribution to a tool.
//! Meters count from when Corgi began observing, so a missing reading means
//! nothing was observed yet. Only a loss inside an interval makes it partial.
const std = @import("std");
const summary = @import("summary.zig");
const usage = @import("../usage.zig").live;
const BoundedText = @import("../bounded_text.zig").BoundedText;

pub const Point = struct { at: i64, label: summary.Label, usage: usage.View };
pub const Timeline = struct {
    points: [16]Point = undefined,
    len: usize = 0,
    baseline: usage.View = .{ .known = true },
    turn: BoundedText(160) = .{},
    open: bool = true,

    pub fn pending(t: *const Timeline, current: usage.View) usage.View {
        if (!t.open and t.len > 0) return t.points[t.len - 1].usage;
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
        if (t.open and t.len > 0 and std.mem.eql(u8, turn, t.turn.text()) and std.mem.eql(u8, label.text(), t.points[t.len - 1].label.text())) {
            // Repeated summaries continue the same interval and start time.
        } else {
            if (t.len == t.points.len) {
                std.mem.copyForwards(Point, t.points[0 .. t.len - 1], t.points[1..t.len]);
                t.len -= 1;
            }
            // Keep observations before the first summary, or after a finished
            // phase awaiting its next summary, with the newly named phase.
            t.points[t.len] = .{ .at = at, .label = label, .usage = if (t.len == 0) interval else if (!t.open) t.observedDelta(current) else .{ .known = current.known } };
            t.len += 1;
        }
        t.turn = .initTruncated(turn);
        t.open = true;
        t.advanceBaseline(current);
    }

    pub fn finish(t: *Timeline, current: usage.View) void {
        if (t.len > 0) t.points[t.len - 1].usage = t.pending(current);
        t.open = false;
        t.advanceBaseline(current);
    }

    fn advanceBaseline(t: *Timeline, current: usage.View) void {
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
    const reading = summary.parseLabel("Reading source").?;
    const testing = summary.parseLabel("Running tests").?;
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
    for (0..timeline.points.len) |i| timeline.checkpoint("b", if (i % 2 == 0) reading else testing, current, @intCast(5000 + i));
    try std.testing.expectEqual(timeline.points.len, timeline.len);
    try std.testing.expectEqual(@as(u64, 0), timeline.pending(current).tokens.total());
}

test "only intervals containing a loss or regression are partial" {
    var timeline: Timeline = .{};
    const label = summary.parseLabel("Reading source").?;
    const other = summary.parseLabel("Running tests").?;
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
    const reviewing = summary.parseLabel("Reviewing pending changes").?;
    const inspecting = summary.parseLabel("Inspecting repository changes").?;
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

test "usage after a finished compaction belongs to the next named phase" {
    var timeline: Timeline = .{};
    timeline.checkpoint("turn", summary.parseLabel("Compacting context").?, .{}, 1000);
    var current: usage.View = .{ .known = true, .tokens = .{ .input = 10 } };
    timeline.finish(current);
    current.tokens.input = 20;
    try std.testing.expectEqual(@as(u64, 10), timeline.pending(current).tokens.input);
    timeline.checkpoint("turn", summary.parseLabel("Running tests").?, current, 2000);
    try std.testing.expectEqual(@as(u64, 10), timeline.points[0].usage.tokens.input);
    try std.testing.expectEqual(@as(u64, 10), timeline.pending(current).tokens.input);
    current.tokens.input = 30;
    try std.testing.expectEqual(@as(u64, 20), timeline.pending(current).tokens.input);
}
