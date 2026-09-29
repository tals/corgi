//! Usage from Corgi's own fresh, tool-free inference conversations.
const std = @import("std");
const live = @import("../usage.zig").live;
const common = @import("../providers/common.zig");
const Claude = @import("../providers/claude.zig").Claude;
const Codex = @import("../providers/codex.zig").Codex;
const a = @import("../os.zig").allocator;
const log = std.log.scoped(.system_usage);
pub const System = struct {
    meter: live.Meter = .{ .value = .{ .known = true } },
    reports: u64 = 0,
    /// System usage never recovers from partial, so every cause is logged to
    /// server.log with enough context to tell a real loss from a false alarm.
    pub fn markPartial(system: *System, comptime reason: []const u8, args: anytype) void {
        log.warn("{d} partial{s} after {d} reports, {d} tokens: " ++ reason, .{
            std.time.milliTimestamp(),
            if (system.meter.value.partial) " (again)" else "",
            system.reports,
            system.meter.value.tokens.total(),
        } ++ args);
        system.meter.value.partial = true;
    }
};
pub const Tracker = struct {
    // Owned thread IDs survive history rotation until the harness is closed,
    // so late reports still count and repeated cumulative samples never do.
    threads: std.StringHashMapUnmanaged(live.Tokens) = .{},
    pub fn deinit(t: *Tracker) void {
        var keys = t.threads.keyIterator();
        while (keys.next()) |key| a.free(key.*);
        t.threads.deinit(a);
    }
    pub fn begin(t: *Tracker, id: []const u8) !void {
        if (t.threads.contains(id)) return;
        const key = try a.dupe(u8, id);
        errdefer a.free(key);
        try t.threads.put(a, key, .{});
    }
    pub fn ingest(t: *Tracker, v: std.json.Value, system: *System, now: i64) void {
        if (std.meta.stringToEnum(Codex.Method, common.str(v, "method")) == .@"thread/tokenUsage/updated") {
            const params = common.field(v, "params");
            const previous = t.threads.getPtr(common.str(params, "threadId")) orelse return;
            const total = common.field(common.field(params, "tokenUsage"), "total");
            const current: live.Tokens = .{
                .input = number(total, "inputTokens") orelse return,
                .cached_input = number(total, "cachedInputTokens") orelse 0,
                .output = number(total, "outputTokens") orelse return,
            };
            var delta: live.Tokens = .{};
            inline for (std.meta.fields(live.Tokens)) |field| {
                const before = @field(previous, field.name);
                const after = @field(current, field.name);
                @field(delta, field.name) = after -| before;
                if (after < before) system.markPartial("thread {s} {s} went backwards {d} -> {d}", .{ common.str(params, "threadId"), field.name, before, after });
                @field(previous, field.name) = @max(before, after);
            }
            system.meter.add(delta, now);
            system.reports +|= 1;
        } else if (std.meta.stringToEnum(Claude.MessageType, common.str(v, "type")) == .result) {
            // Claude streaming-input results carry this turn's main-loop usage.
            // Count results (including failures), not assistant blocks as well.
            // https://code.claude.com/docs/en/agent-sdk/cost-tracking
            const value = common.field(v, "usage");
            const input = number(value, "input_tokens") orelse return;
            const output = number(value, "output_tokens") orelse return;
            const cached = number(value, "cache_read_input_tokens") orelse 0;
            const created = number(value, "cache_creation_input_tokens") orelse 0;
            system.meter.add(.{ .input = input +| cached +| created, .cached_input = cached, .output = output }, now);
            system.reports +|= 1;
        }
    }
};
fn number(v: std.json.Value, key: []const u8) ?u64 {
    const n = common.field(v, key);
    return if (n == .integer and n.integer >= 0) @intCast(n.integer) else null;
}

test "system usage counts fresh Codex threads once and each Claude result once" {
    var tracker: Tracker = .{};
    defer tracker.deinit();
    var system: System = .{};
    const event = try std.json.parseFromSlice(std.json.Value, a,
        \\{"method":"thread/tokenUsage/updated","params":{"threadId":"owned","tokenUsage":{"total":{"inputTokens":100,"cachedInputTokens":60,"outputTokens":20}}}}
    , .{});
    defer event.deinit();
    tracker.ingest(event.value, &system, 1);
    try std.testing.expectEqual(@as(u64, 0), system.meter.value.tokens.total());
    try tracker.begin("owned");
    tracker.ingest(event.value, &system, 2);
    tracker.ingest(event.value, &system, 3);
    try std.testing.expectEqual(@as(u64, 120), system.meter.value.tokens.total());
    const result = try std.json.parseFromSlice(std.json.Value, a,
        \\{"type":"result","is_error":true,"usage":{"input_tokens":10,"cache_read_input_tokens":30,"cache_creation_input_tokens":20,"output_tokens":5}}
    , .{});
    defer result.deinit();
    tracker.ingest(result.value, &system, 4);
    tracker.ingest(result.value, &system, 5);
    try std.testing.expectEqual(@as(u64, 250), system.meter.value.tokens.total());
    try std.testing.expectEqual(@as(u64, 120), system.meter.value.tokens.cached_input);
}
