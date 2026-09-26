//! List prices used only to rank agents by comparable spend. Figures are
//! standard-tier USD per million tokens, stored in thousandths of a dollar.
//! Anthropic: platform.claude.com pricing; OpenAI: developers.openai.com/api/docs/pricing
//! (both as of 2026-09).
const std = @import("std");

pub const Price = struct {
    /// Short name for column headings, such as "opus".
    label: []const u8,
    input: u64,
    output: u64,
};

const Entry = struct { id: []const u8, price: Price };
const table = [_]Entry{
    .{ .id = "claude-fable-5-1", .price = .{ .label = "fable", .input = 10_000, .output = 50_000 } },
    .{ .id = "claude-fable-5", .price = .{ .label = "fable", .input = 10_000, .output = 50_000 } },
    .{ .id = "claude-opus-5-5", .price = .{ .label = "opus", .input = 4_000, .output = 20_000 } },
    .{ .id = "claude-opus-5", .price = .{ .label = "opus", .input = 5_000, .output = 25_000 } },
    .{ .id = "claude-opus-4-1", .price = .{ .label = "opus", .input = 15_000, .output = 75_000 } },
    .{ .id = "claude-opus-4-20250514", .price = .{ .label = "opus", .input = 15_000, .output = 75_000 } },
    .{ .id = "claude-opus-4", .price = .{ .label = "opus", .input = 5_000, .output = 25_000 } },
    .{ .id = "claude-sonnet-5", .price = .{ .label = "sonnet", .input = 2_000, .output = 10_000 } },
    .{ .id = "claude-sonnet-4", .price = .{ .label = "sonnet", .input = 3_000, .output = 15_000 } },
    .{ .id = "claude-haiku-4-5", .price = .{ .label = "haiku", .input = 1_000, .output = 5_000 } },
    .{ .id = "gpt-6-astra", .price = .{ .label = "astra", .input = 10_000, .output = 50_000 } },
    .{ .id = "gpt-6-sol", .price = .{ .label = "sol", .input = 2_000, .output = 10_000 } },
    .{ .id = "gpt-6-luna", .price = .{ .label = "luna", .input = 100, .output = 500 } },
    .{ .id = "gpt-5.3-codex", .price = .{ .label = "codex", .input = 1_750, .output = 14_000 } },
    // Claude Code settings aliases resolve to the current model of each family.
    .{ .id = "fable", .price = .{ .label = "fable", .input = 10_000, .output = 50_000 } },
    .{ .id = "opus", .price = .{ .label = "opus", .input = 4_000, .output = 20_000 } },
    .{ .id = "sonnet", .price = .{ .label = "sonnet", .input = 2_000, .output = 10_000 } },
    .{ .id = "haiku", .price = .{ .label = "haiku", .input = 1_000, .output = 5_000 } },
};

/// The longest table id that prefixes `model`, so dated and context suffixes
/// ("-20251001", "[1m]") match their base model. Unknown models return null.
pub fn lookup(model: []const u8) ?Price {
    var best: ?Entry = null;
    for (table) |entry| {
        if (!std.mem.startsWith(u8, model, entry.id)) continue;
        // Require a boundary so "claude-opus-5" does not claim "claude-opus-55".
        if (model.len > entry.id.len and std.ascii.isDigit(model[entry.id.len])) continue;
        if (best == null or entry.id.len > best.?.id.len) best = entry;
    }
    return if (best) |entry| entry.price else null;
}

/// Uncached input plus output, rescaled per token kind into `reference` tokens.
pub fn equivalent(price: Price, reference: Price, uncached_input: u64, output: u64) u64 {
    const in: u128 = @as(u128, uncached_input) * price.input / reference.input;
    const out: u128 = @as(u128, output) * price.output / reference.output;
    return @intCast(@min(in + out, std.math.maxInt(u64)));
}

test "model ids match their base model and family aliases" {
    try std.testing.expectEqual(@as(u64, 4_000), lookup("claude-opus-5-5[1m]").?.input);
    try std.testing.expectEqual(@as(u64, 5_000), lookup("claude-opus-5").?.input);
    try std.testing.expectEqual(@as(u64, 1_000), lookup("claude-haiku-4-5-20251001").?.input);
    try std.testing.expectEqual(@as(u64, 5_000), lookup("claude-opus-4-7").?.input);
    try std.testing.expectEqual(@as(u64, 15_000), lookup("claude-opus-4-20250514").?.input);
    try std.testing.expectEqualStrings("luna", lookup("gpt-6-luna").?.label);
    try std.testing.expectEqualStrings("opus", lookup("opus").?.label);
    try std.testing.expectEqual(null, lookup("claude-opus-55"));
    try std.testing.expectEqual(null, lookup("codex-auto-review"));
    try std.testing.expectEqual(null, lookup(""));
}

test "equivalent tokens rescale input and output separately" {
    const opus = lookup("claude-opus-5").?;
    const haiku = lookup("claude-haiku-4-5").?;
    try std.testing.expectEqual(@as(u64, 1_200), equivalent(haiku, opus, 5_000, 1_000));
    try std.testing.expectEqual(@as(u64, 6_000), equivalent(opus, opus, 5_000, 1_000));
}
