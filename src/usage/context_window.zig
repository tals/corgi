//! How full a conversation's context window is, from its latest model call.
//! Unlike usage meters this is a level, not a counter: reopening a transcript
//! reads it again from the tail, so it survives reloads without being saved.
const std = @import("std");
const agents = @import("../agents.zig");
const field = @import("tokens.zig").field;
const common = @import("../providers/common.zig");
const Claude = @import("../providers/claude.zig").Claude;
const Codex = @import("../providers/codex.zig").Codex;
const Name = @import("../codex_files.zig").Name;
const Model = @import("../providers/model.zig").Model;

/// What the usage worker last read from one transcript.
pub const Reading = struct {
    /// Tokens the latest model call carried, counted the way each provider's
    /// own UI does: Claude's input side (fresh, cache reads, cache writes),
    /// Codex's input plus output.
    used: u64 = 0,
    /// Zero until a reading names a known model.
    window: u64 = 0,
    /// Transcript time of the reading in milliseconds; zero means no reading.
    at: i64 = 0,
    model: Model = .{},
    /// Size at which this conversation last compacted on its own.
    auto_compaction: u64 = 0,

    pub fn claude(r: *Reading, value: std.json.Value) void {
        const line = Claude.Line.decode(value) orelse return;
        const stamp = common.timestampMs(line.timestamp) orelse return;
        switch (line.type orelse return) {
            .assistant => {
                // Also skips "<synthetic>" error records, which report no usage.
                const model: Model = .resolve(agents.str(line.message, "model"));
                if (model.window == 0) return;
                const usage = field(line.message, "usage");
                const input = number(usage, "input_tokens") orelse return;
                r.used = input +| (number(usage, "cache_read_input_tokens") orelse 0) +| (number(usage, "cache_creation_input_tokens") orelse 0);
                r.window = model.window;
                r.at = stamp;
                r.model = model;
            },
            .system => {
                if (!std.mem.eql(u8, line.subtype, "compact_boundary")) return;
                const meta = field(value, "compactMetadata");
                if (std.mem.eql(u8, agents.str(meta, "trigger"), "auto")) {
                    if (number(meta, "preTokens")) |tokens| r.auto_compaction = tokens;
                }
                // Until the next model call, the summary is what remains.
                r.used = number(meta, "postTokens") orelse 0;
                r.at = stamp;
            },
            else => {},
        }
    }

    pub fn codex(r: *Reading, value: std.json.Value) void {
        const rollout = Codex.Rollout.decode(value);
        if (rollout.type != .event_msg or rollout.payloadType() != .token_count) return;
        const stamp = common.timestampMs(rollout.timestamp) orelse return;
        // Rate-limit-only events carry a null info.
        const info = field(rollout.payload, "info");
        const window = number(info, "model_context_window") orelse return;
        const last = field(info, "last_token_usage");
        r.used = number(last, "total_tokens") orelse
            (number(last, "input_tokens") orelse return) +| (number(last, "output_tokens") orelse 0);
        r.window = window;
        r.at = stamp;
    }

    pub fn view(r: Reading, points: *const Points) View {
        return .{
            .used = r.used,
            .window = r.window,
            .at = r.at,
            .compacts_at = if (r.auto_compaction > 0) r.auto_compaction else points.get(r.model.id.text()),
        };
    }
};

/// The wire form of a reading.
pub const View = struct {
    used: u64 = 0,
    window: u64 = 0,
    /// Where this model compacts on its own; zero until Corgi has seen it.
    compacts_at: u64 = 0,
    at: i64 = 0,

    /// Share of the way to compaction: against the learned compaction point
    /// when there is one, else the whole window. Null without a reading.
    pub fn pressure(v: View) ?f64 {
        if (v.at == 0 or v.window == 0) return null;
        const limit = if (v.compacts_at > 0) @min(v.compacts_at, v.window) else v.window;
        return @as(f64, @floatFromInt(v.used)) / @as(f64, @floatFromInt(limit));
    }
    /// How close to compaction. The sidebar row shows its figure from `near`.
    pub const Band = enum { calm, near, high };
    pub fn band(v: View) ?Band {
        const p = v.pressure() orelse return null;
        return if (p < 0.7) .calm else if (p < 0.85) .near else .high;
    }
    /// Share of the window, as providers show it, in whole percent.
    pub fn percent(v: View) u64 {
        if (v.window == 0) return 0;
        return (v.used *| 100 +| v.window / 2) / v.window;
    }
};

/// Where each model last compacted on its own, shared by every conversation
/// on that model. Runtime only; a restart learns again from transcripts.
pub const Points = struct {
    const Entry = struct { model: Name = .{}, tokens: u64 = 0 };
    entries: [8]Entry = @splat(.{}),
    next: usize = 0,

    pub fn learn(p: *Points, model: []const u8, tokens: u64) void {
        if (model.len == 0 or tokens == 0) return;
        const slot = for (&p.entries) |*entry| {
            if (std.mem.eql(u8, entry.model.text(), model)) break entry;
        } else blk: {
            const entry = &p.entries[p.next];
            p.next = (p.next + 1) % p.entries.len;
            break :blk entry;
        };
        slot.model = .ascii(model);
        slot.tokens = tokens;
    }
    pub fn get(p: *const Points, model: []const u8) u64 {
        if (model.len == 0) return 0;
        for (p.entries) |entry| if (std.mem.eql(u8, entry.model.text(), model)) return entry.tokens;
        return 0;
    }
};

fn number(v: std.json.Value, key: []const u8) ?u64 {
    const n = field(v, key);
    return if (n == .integer and n.integer >= 0) @intCast(n.integer) else null;
}

fn feed(r: *Reading, provider: agents.Provider, line: []const u8) !void {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, line, .{});
    defer parsed.deinit();
    switch (provider) {
        .claude => r.claude(parsed.value),
        .codex => r.codex(parsed.value),
    }
}

test "claude counts the latest main-chain call's input side against its model window" {
    var r: Reading = .{};
    try feed(&r, .claude,
        \\{"type":"assistant","timestamp":"2026-09-27T17:29:27.178Z","message":{"model":"claude-opus-5-5","usage":{"input_tokens":2,"cache_creation_input_tokens":1160,"cache_read_input_tokens":251596,"output_tokens":795}}}
    );
    try std.testing.expectEqual(@as(u64, 252758), r.used);
    try std.testing.expectEqual(@as(u64, 1_000_000), r.window);
    try std.testing.expectEqualStrings("claude-opus-5-5", r.model.id.text());
    // Subagent and synthetic error records leave the reading alone.
    try feed(&r, .claude,
        \\{"type":"assistant","isSidechain":true,"timestamp":"2026-09-27T17:29:30.000Z","message":{"model":"claude-opus-5-5","usage":{"input_tokens":9,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
    );
    try feed(&r, .claude,
        \\{"type":"system","subtype":"compact_boundary","isSidechain":true,"timestamp":"2026-09-27T17:29:30.500Z","compactMetadata":{"trigger":"auto","preTokens":150000,"postTokens":9000}}
    );
    try feed(&r, .claude,
        \\{"type":"assistant","timestamp":"2026-09-27T17:29:31.000Z","message":{"model":"<synthetic>","usage":{"input_tokens":0,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}
    );
    try std.testing.expectEqual(@as(u64, 252758), r.used);
    try std.testing.expectEqual(@as(u64, 0), r.auto_compaction);
    try feed(&r, .claude,
        \\{"type":"assistant","timestamp":"2026-09-27T17:30:00.000Z","message":{"model":"claude-haiku-4-5-20251001","usage":{"input_tokens":40000}}}
    );
    try std.testing.expectEqual(@as(u64, 200_000), r.window);
}

test "claude compactions reset the level and only automatic ones teach the compaction point" {
    var r: Reading = .{};
    try feed(&r, .claude,
        \\{"type":"system","subtype":"compact_boundary","timestamp":"2026-09-27T17:31:25.260Z","compactMetadata":{"trigger":"manual","preTokens":253553,"postTokens":6070}}
    );
    try std.testing.expectEqual(@as(u64, 6070), r.used);
    try std.testing.expectEqual(@as(u64, 0), r.auto_compaction);
    try feed(&r, .claude,
        \\{"type":"system","subtype":"compact_boundary","timestamp":"2026-09-27T19:02:00.000Z","compactMetadata":{"trigger":"auto","preTokens":412000,"postTokens":9100}}
    );
    try std.testing.expectEqual(@as(u64, 412000), r.auto_compaction);
    try std.testing.expectEqual(@as(u64, 9100), r.used);
}

test "codex reads the last call and the reported window, ignoring null info" {
    var r: Reading = .{};
    try feed(&r, .codex,
        \\{"timestamp":"2026-09-06T02:08:31.286Z","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":5730919,"output_tokens":26352,"total_tokens":5757271},"last_token_usage":{"input_tokens":93139,"cached_input_tokens":92032,"output_tokens":529,"total_tokens":93668},"model_context_window":258400}}}
    );
    try std.testing.expectEqual(@as(u64, 93668), r.used);
    try std.testing.expectEqual(@as(u64, 258400), r.window);
    try feed(&r, .codex,
        \\{"timestamp":"2026-09-06T02:08:32.000Z","type":"event_msg","payload":{"type":"token_count","info":null,"rate_limits":{}}}
    );
    try std.testing.expectEqual(@as(u64, 93668), r.used);
    try std.testing.expectEqual(@as(u64, 36), r.view(&.{}).percent());
}

test "pressure follows a learned compaction point shared by model" {
    var points: Points = .{};
    var r: Reading = .{ .used = 300_000, .window = 1_000_000, .at = 1 };
    r.model = .resolve("claude-opus-5-5");
    try std.testing.expectEqual(@as(f64, 0.3), r.view(&points).pressure().?);
    points.learn("claude-opus-5-5", 400_000);
    try std.testing.expectEqual(@as(f64, 0.75), r.view(&points).pressure().?);
    try std.testing.expectEqual(@as(u64, 30), r.view(&points).percent());
    try std.testing.expect((View{}).pressure() == null);
}
