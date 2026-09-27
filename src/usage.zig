//! Reported activity only. Token totals are provider totals, including cached
//! input and reasoning output; they are not estimates of cost or context size.
const std = @import("std");
const agents = @import("agents.zig");
pub const Counts = struct {
    tools: u64 = 0,
    input: u64 = 0,
    // Cache reads, included in input as providers report them.
    cached_input: u64 = 0,
    output: u64 = 0,
    tokens_known: bool = false,
    pub fn add(c: *Counts, other: Counts) void {
        c.tools +|= other.tools;
        c.input +|= other.input;
        c.cached_input +|= other.cached_input;
        c.output +|= other.output;
        c.tokens_known = c.tokens_known or other.tokens_known;
    }
    pub fn any(c: Counts) bool {
        return c.tools > 0 or c.input > 0 or c.output > 0;
    }
};
pub const Window = struct {
    since: i64 = 0,
    counts: Counts = .{},
    pub fn visit(w: *Window, now: i64) bool {
        const changed = w.counts.any();
        w.since = @max(w.since, now);
        w.counts = .{};
        return changed;
    }
    pub fn record(w: *Window, since: i64, delta: Counts) bool {
        // Results from a worker launched before a visit cannot resurrect stats.
        if (since != w.since) return false;
        const changed = delta.any() or (delta.tokens_known and !w.counts.tokens_known);
        w.counts.add(delta);
        return changed;
    }
};
pub fn field(v: std.json.Value, key: []const u8) std.json.Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
fn number(v: std.json.Value, key: []const u8) ?u64 {
    const n = field(v, key);
    return if (n == .integer and n.integer >= 0) @intCast(n.integer) else null;
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
// Bounded deduplication for incremental append-only streams. We never replay
// history into counters when opening/replacing a transcript.
pub const Tracker = struct {
    const Sample = struct { id: u64 = 0, input: u64 = 0, cached_input: u64 = 0, output: u64 = 0 };
    samples: [128]Sample = @splat(.{}),
    next_sample: usize = 0,
    tools: [256]u64 = @splat(0),
    next_tool: usize = 0,
    fn key(text: []const u8) u64 {
        return std.hash.Wyhash.hash(0, text) | 1;
    }
    fn tool(t: *Tracker, id: []const u8) u64 {
        if (id.len == 0) return 0;
        const hash = key(id);
        for (t.tools) |old| if (old == hash) return 0;
        t.tools[t.next_tool] = hash;
        t.next_tool = (t.next_tool + 1) % t.tools.len;
        return 1;
    }
    fn tokens(t: *Tracker, id: []const u8, input: u64, output: u64, baseline: bool) Counts {
        return t.tokensCached(id, input, 0, output, baseline);
    }
    fn tokensCached(t: *Tracker, id: []const u8, input: u64, cached: u64, output: u64, baseline: bool) Counts {
        const hash = key(id);
        for (&t.samples) |*sample| if (sample.id == hash) {
            const delta: Counts = .{ .input = input -| sample.input, .cached_input = cached -| sample.cached_input, .output = output -| sample.output, .tokens_known = true };
            sample.input = @max(sample.input, input);
            sample.cached_input = @max(sample.cached_input, cached);
            sample.output = @max(sample.output, output);
            return delta;
        };
        t.samples[t.next_sample] = .{ .id = hash, .input = input, .cached_input = cached, .output = output };
        t.next_sample = (t.next_sample + 1) % t.samples.len;
        return .{ .input = if (baseline) 0 else input, .cached_input = if (baseline) 0 else cached, .output = if (baseline) 0 else output, .tokens_known = true };
    }
    pub fn hasSample(t: *const Tracker, id: []const u8) bool {
        const hash = key(id);
        for (t.samples) |sample| if (sample.id == hash) return true;
        return false;
    }
    pub fn codexNotification(t: *Tracker, id: []const u8, value: std.json.Value, active: bool) Counts {
        const known = t.hasSample(id);
        var delta = t.codexTokens(id, field(value, "total"), true);
        if (!known and active and delta.tokens_known) {
            const last = field(value, "last");
            delta.input = number(last, "inputTokens") orelse 0;
            delta.output = number(last, "outputTokens") orelse 0;
        }
        return delta;
    }
    pub fn beginCodex(t: *Tracker, id: []const u8) void {
        _ = t.tokens(id, 0, 0, true);
    }
    pub fn codexTokens(t: *Tracker, id: []const u8, total: std.json.Value, camel: bool) Counts {
        const input = number(total, if (camel) "inputTokens" else "input_tokens") orelse return .{};
        const output = number(total, if (camel) "outputTokens" else "output_tokens") orelse return .{};
        return t.tokens(id, input, output, true);
    }
    pub fn claudeMessage(t: *Tracker, message: std.json.Value) Counts {
        var delta: Counts = .{};
        const id = agents.str(message, "id");
        const usage = field(message, "usage");
        if (id.len > 0) if (number(usage, "input_tokens")) |input| {
            if (number(usage, "output_tokens")) |output| {
                const cached = number(usage, "cache_read_input_tokens") orelse 0;
                delta = t.tokensCached(id, input +| cached +| (number(usage, "cache_creation_input_tokens") orelse 0), cached, output, false);
            }
        };
        const content = field(message, "content");
        if (content == .array) for (content.array.items) |block| {
            if (eq(agents.str(block, "type"), "tool_use")) delta.tools +|= t.tool(agents.str(block, "id"));
        };
        return delta;
    }
    pub fn transcript(t: *Tracker, provider: agents.Provider, session: []const u8, value: std.json.Value) Counts {
        return switch (provider) {
            .claude => t.claudeTranscript(session, value),
            .codex => t.codexTranscript(value),
        };
    }
    fn claudeTranscript(t: *Tracker, session: []const u8, value: std.json.Value) Counts {
        if (!eq(agents.str(value, "sessionId"), session)) return .{};
        const side = field(value, "isSidechain");
        if (side == .bool and side.bool) return .{};
        if (eq(agents.str(value, "type"), "assistant")) return t.claudeMessage(field(value, "message"));
        return .{};
    }
    fn codexTranscript(t: *Tracker, value: std.json.Value) Counts {
        const payload = field(value, "payload");
        const kind = agents.str(value, "type");
        const subtype = agents.str(payload, "type");
        if (eq(kind, "event_msg") and eq(subtype, "token_count")) return t.codexTokens("codex", field(field(payload, "info"), "total_token_usage"), false);
        if (eq(kind, "response_item")) {
            for ([_][]const u8{ "function_call", "custom_tool_call", "web_search_call", "local_shell_call" }) |tool_kind| {
                if (eq(subtype, tool_kind)) {
                    const id = agents.str(payload, "call_id");
                    return .{ .tools = t.tool(if (id.len > 0) id else agents.str(payload, "id")) };
                }
            }
        }
        return .{};
    }
};

test "usage windows discard work observed before a visit" {
    var w: Window = .{};
    try std.testing.expect(w.record(0, .{ .tools = 3, .input = 100 }));
    try std.testing.expect(w.visit(10));
    try std.testing.expect(!w.record(0, .{ .tools = 9 }));
    try std.testing.expect(w.record(10, .{ .tools = 1 }));
    try std.testing.expectEqual(@as(u64, 1), w.counts.tools);
    try std.testing.expectEqual(@as(u64, 0), w.counts.input);
}

test "cumulative usage establishes a baseline and duplicate samples add nothing" {
    var t: Tracker = .{};
    const alloc = std.testing.allocator;
    const first = try std.json.parseFromSlice(std.json.Value, alloc, "{\"input_tokens\":100,\"output_tokens\":10}", .{});
    defer first.deinit();
    const next = try std.json.parseFromSlice(std.json.Value, alloc, "{\"input_tokens\":150,\"output_tokens\":20}", .{});
    defer next.deinit();
    try std.testing.expect(!t.codexTokens("a", first.value, false).any());
    const delta = t.codexTokens("a", next.value, false);
    try std.testing.expectEqual(@as(u64, 50), delta.input);
    try std.testing.expectEqual(@as(u64, 10), delta.output);
    try std.testing.expect(!t.codexTokens("a", next.value, false).any());
}

test "Claude repeated message blocks count tools once and include cached input" {
    var t: Tracker = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"id":"msg1","usage":{"input_tokens":5,"cache_read_input_tokens":10,"cache_creation_input_tokens":20,"output_tokens":3},"content":[{"type":"tool_use","id":"tool1"}]}
    , .{});
    defer parsed.deinit();
    const delta = t.claudeMessage(parsed.value);
    try std.testing.expectEqual(@as(u64, 35), delta.input);
    // Only cache reads are cached input; cache creation is a write.
    try std.testing.expectEqual(@as(u64, 10), delta.cached_input);
    try std.testing.expectEqual(@as(u64, 3), delta.output);
    try std.testing.expectEqual(@as(u64, 1), delta.tools);
    try std.testing.expect(!t.claudeMessage(parsed.value).any());
}

test "out-of-order samples cannot make a repeated total count twice" {
    var t: Tracker = .{};
    t.beginCodex("thread");
    _ = t.tokens("thread", 200, 20, true);
    try std.testing.expect(!t.tokens("thread", 100, 10, true).any());
    try std.testing.expect(!t.tokens("thread", 200, 20, true).any());
}

test "new native turn reports last usage without charging older thread history" {
    var t: Tracker = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"total":{"inputTokens":1100,"outputTokens":110},"last":{"inputTokens":100,"outputTokens":10}}
    , .{});
    defer parsed.deinit();
    const delta = t.codexNotification("thread", parsed.value, true);
    try std.testing.expectEqual(@as(u64, 100), delta.input);
    try std.testing.expectEqual(@as(u64, 10), delta.output);
    try std.testing.expect(!t.codexNotification("thread", parsed.value, true).any());
    try std.testing.expect(!t.codexNotification("resumed", parsed.value, false).any());
}
