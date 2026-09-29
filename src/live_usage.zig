//! Small, runtime-only meters. Each session has one source and its own counters.
//! Explicit child ownership permits a bounded initial catch-up; ambiguous
//! prefixes establish a baseline and are marked partial instead of guessed.
const std = @import("std");
const agents = @import("agents.zig");
const field = @import("usage.zig").field;
const providers = @import("providers.zig");

pub const Tokens = struct {
    input: u64 = 0,
    cached_input: u64 = 0,
    output: u64 = 0,
    pub fn total(t: Tokens) u64 {
        return t.input +| t.output;
    }
    pub fn add(t: *Tokens, other: Tokens) void {
        t.input +|= other.input;
        t.cached_input +|= other.cached_input;
        t.output +|= other.output;
    }
};
pub const View = struct {
    tokens: Tokens = .{},
    known: bool = false,
    partial: bool = false,
    // Loss events since observation began. An interval is partial only if
    // this changed within it; partial alone records that some loss occurred.
    losses: u32 = 0,
    since: i64 = 0,
    updated_at: i64 = 0,
    recent_tokens: u64 = 0,
};
pub const Meter = struct {
    const Bucket = struct { minute: i64 = -1, tokens: u64 = 0 };
    value: View = .{},
    buckets: [5]Bucket = @splat(.{}),
    pub fn lose(m: *Meter) void {
        m.value.partial = true;
        m.value.losses +|= 1;
    }
    pub fn add(m: *Meter, tokens: Tokens, timestamp: i64) void {
        m.value.known = true;
        m.value.tokens.add(tokens);
        if (m.value.since == 0) m.value.since = timestamp;
        m.value.updated_at = @max(m.value.updated_at, timestamp);
        const minute = @divFloor(timestamp, 60_000);
        const slot = &m.buckets[@intCast(@mod(minute, m.buckets.len))];
        if (slot.minute > minute) return;
        if (slot.minute != minute) slot.* = .{ .minute = minute };
        slot.tokens +|= tokens.total();
    }
    pub fn view(m: *const Meter, now: i64) View {
        var out = m.value;
        const minute = @divFloor(now, 60_000);
        for (m.buckets) |b| if (b.minute >= minute - 4 and b.minute <= minute) {
            out.recent_tokens +|= b.tokens;
        };
        return out;
    }
};
fn number(v: std.json.Value, key: []const u8) ?u64 {
    const n = field(v, key);
    return if (n == .integer and n.integer >= 0) @intCast(n.integer) else null;
}
fn parseTokens(v: std.json.Value, camel: bool) ?Tokens {
    const input = number(v, if (camel) "inputTokens" else "input_tokens") orelse return null;
    return .{
        .input = input,
        .cached_input = @min(input, number(v, if (camel) "cachedInputTokens" else "cached_input_tokens") orelse 0),
        .output = number(v, if (camel) "outputTokens" else "output_tokens") orelse return null,
    };
}
pub const Codex = struct {
    meter: Meter = .{},
    previous: ?Tokens = null,
    child: bool = false,
    owned_from: ?u64 = null,
    catch_up: bool = false,
    ordinal: ?u64 = null,
    baseline_next: bool = false,

    pub fn header(t: *Codex, value: std.json.Value, child: bool, tracked_since: i64, complete_prefix: bool) void {
        t.child = child;
        const payload = field(value, "payload");
        t.owned_from = number(payload, "subagent_history_start_ordinal");
        const created = providers.timestampMs(agents.str(payload, "timestamp")) orelse
            providers.timestampMs(agents.str(value, "timestamp"));
        t.catch_up = child and complete_prefix and t.owned_from != null and created != null and tracked_since > 0 and created.? >= tracked_since;
        if (child and (!t.catch_up or t.owned_from == null)) t.meter.lose();
    }
    pub fn ingest(t: *Codex, value: std.json.Value, appended: bool, now: i64) void {
        if (std.meta.stringToEnum(providers.Codex.RolloutKind, agents.str(value, "type")) != .event_msg) return;
        const payload = field(value, "payload");
        if (std.meta.stringToEnum(providers.Codex.EventKind, agents.str(payload, "type")) != .token_count) return;
        const ordinal = number(value, "ordinal");
        if (t.owned_from) |boundary| {
            if (ordinal == null) {
                t.meter.lose();
                return;
            }
            if (ordinal.? < boundary) return;
        }
        if (ordinal) |n| {
            if (t.ordinal) |old| if (n <= old) return;
            t.ordinal = n;
        }
        const info = field(payload, "info");
        const total = parseTokens(field(info, "total_token_usage"), false) orelse return;
        const last = parseTokens(field(info, "last_token_usage"), false);
        const stamp = providers.timestampMs(agents.str(value, "timestamp")) orelse now;
        t.sample(total, last, appended or t.catch_up, @min(stamp, now));
    }
    pub fn native(t: *Codex, value: std.json.Value, active: bool, now: i64) void {
        const total = parseTokens(field(value, "total"), true) orelse return;
        t.sample(total, parseTokens(field(value, "last"), true), active, now);
    }
    fn sample(t: *Codex, total: Tokens, last: ?Tokens, count: bool, stamp: i64) void {
        if (!count or t.baseline_next) {
            if (t.previous) |previous| {
                if (total.input < previous.input or total.output < previous.output or total.cached_input < previous.cached_input) {
                    t.meter.lose();
                    return;
                }
            }
            t.previous = total;
            t.baseline_next = false;
            return;
        }
        var delta: Tokens = .{};
        if (t.previous) |previous| {
            if (std.meta.eql(previous, total)) return;
            if (total.input < previous.input or total.output < previous.output or total.cached_input < previous.cached_input) {
                // Counter restart or reordered telemetry: keep the high-water
                // mark. Reopening a replaced stream explicitly rebaselines it.
                t.meter.lose();
                return;
            }
            delta = .{ .input = total.input - previous.input, .cached_input = total.cached_input - previous.cached_input, .output = total.output - previous.output };
            if (last) |request| {
                // A jump can include an inherited baseline or unobserved work.
                // Charge only this request's reported components in that case.
                if (delta.input > request.input or delta.output > request.output) t.meter.lose();
                delta.input = @min(delta.input, request.input);
                delta.cached_input = @min(delta.cached_input, request.cached_input);
                delta.output = @min(delta.output, request.output);
            }
        } else if (last) |request| {
            delta = .{ .input = @min(total.input, request.input), .cached_input = @min(total.cached_input, request.cached_input), .output = @min(total.output, request.output) };
        } else {
            t.meter.lose();
            t.previous = total;
            return;
        }
        t.previous = total;
        t.meter.add(delta, stamp);
    }
};

test "owned first request is counted once and recent buckets expire" {
    var t: Codex = .{};
    t.sample(.{ .input = 1100, .cached_input = 800, .output = 120 }, .{ .input = 100, .cached_input = 50, .output = 20 }, true, 60_000);
    t.sample(.{ .input = 1100, .cached_input = 800, .output = 120 }, .{ .input = 100, .cached_input = 50, .output = 20 }, true, 60_100);
    try std.testing.expectEqual(@as(u64, 120), t.meter.view(60_200).tokens.total());
    try std.testing.expectEqual(@as(u64, 120), t.meter.view(60_200).recent_tokens);
    try std.testing.expectEqual(@as(u64, 0), t.meter.view(360_000).recent_tokens);
    try std.testing.expectEqual(@as(u64, 50), t.meter.value.tokens.cached_input);
}

test "counter regressions and inherited jumps cannot inflate live spend" {
    var t: Codex = .{};
    t.sample(.{ .input = 1000, .output = 100 }, null, false, 1);
    t.sample(.{ .input = 10, .output = 1 }, null, true, 2);
    t.sample(.{ .input = 1000, .output = 100 }, null, true, 3);
    try std.testing.expectEqual(@as(u64, 0), t.meter.value.tokens.total());
    t.sample(.{ .input = 9000, .output = 900 }, .{ .input = 30, .output = 5 }, true, 4);
    try std.testing.expectEqual(@as(u64, 35), t.meter.value.tokens.total());
    try std.testing.expect(t.meter.value.partial);
}
