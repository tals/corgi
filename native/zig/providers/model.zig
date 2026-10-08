//! A model id resolved once, where it arrives. Bedrock and Vertex spellings,
//! dates, version suffixes and `[1m]` reduce to the first-party id, the way
//! Claude Code canonicalizes ids; its family and version give the name both
//! CLIs show and Claude's context window. Codex reports its windows itself.
//! Claude Code's aliases keep their spelling and get its picker's names.
const std = @import("std");
const Name = @import("../bounded_text.zig").BoundedText(160);

pub const Model = struct {
    /// The first-party id, such as "claude-opus-4-5-20251101" or "gpt-6-astra".
    /// An alias or an id of unknown shape stays as reported.
    id: Name = .{},
    /// "Opus 4.5", "GPT-6 Astra", "Opus"; empty for an id of unknown shape.
    name: Name = .{},
    /// Claude's context window; zero for aliases and every other model.
    window: u64 = 0,

    pub fn resolve(reported: []const u8) Model {
        var id = reported;
        const million = std.mem.endsWith(u8, id, "[1m]");
        if (million) id = id[0 .. id.len - "[1m]".len];
        if (std.meta.stringToEnum(Alias, id)) |alias| return alias.model(reported, million);
        // Bedrock ARNs and Vertex resource names end in the model id.
        if (std.mem.lastIndexOfScalar(u8, id, '/')) |slash| id = id[slash + 1 ..];
        // Bedrock prefixes "anthropic.", optionally after a region such as "us.".
        if (std.mem.indexOf(u8, id, "anthropic.claude-")) |at| {
            if (at == 0 or (id[at - 1] == '.' and region(id[0 .. at - 1]))) id = id[at + "anthropic.".len ..];
        }
        if (std.mem.startsWith(u8, id, "claude-")) if (claude(id, million)) |model| return model;
        if (openai(reported)) |model| return model;
        return .{ .id = .ascii(reported) };
    }

    /// The name, or the id when its shape is unknown.
    pub fn label(m: *const Model) []const u8 {
        return if (m.name.len > 0) m.name.text() else m.id.text();
    }
};

/// Families whose newer versions Claude Code runs with a 1M window.
const Family = enum { opus, sonnet, haiku, fable, mythos };

fn nativeMillion(family: []const u8, major: u8, minor: u8) bool {
    return switch (std.meta.stringToEnum(Family, family) orelse return false) {
        .opus => major > 4 or (major == 4 and minor >= 7),
        .sonnet => major >= 5,
        .fable, .mythos => true,
        .haiku => major >= 5,
    };
}

/// The aliases Claude Code's model picker offers. Which version one runs is
/// Claude Code's choice, so the name has none.
const Alias = enum {
    opus,
    sonnet,
    haiku,
    fable,
    opusplan,

    fn model(alias: Alias, reported: []const u8, million: bool) Model {
        const name = switch (alias) {
            .opus => "Opus",
            .sonnet => "Sonnet",
            .haiku => "Haiku",
            .fable => "Fable",
            .opusplan => "Opus Plan Mode",
        };
        var buf: [Name.capacity]u8 = undefined;
        const full = if (million) std.fmt.bufPrint(&buf, "{s} (1M context)", .{name}) catch name else name;
        return .{ .id = .ascii(reported), .name = .ascii(full) };
    }
};

fn region(prefix: []const u8) bool {
    if (prefix.len == 0) return false;
    for (prefix) |ch| if (!std.ascii.isLower(ch) and ch != '-') return false;
    return true;
}

/// "claude-opus-4-5", or the older "claude-3-5-sonnet", then an optional tail.
fn claude(id: []const u8, million: bool) ?Model {
    var rest = id["claude-".len..];
    const first = token(&rest);
    const legacy = !word(first);
    var family = first;
    const major = number(if (legacy) first else token(&rest)) orelse return null;
    const minor = optionalNumber(&rest);
    if (legacy) {
        family = token(&rest);
        if (!word(family)) return null;
    }
    const date = tail(rest) orelse return null;

    var id_buf: [Name.capacity]u8 = undefined;
    var name_buf: [Name.capacity]u8 = undefined;
    var ids = std.Io.Writer.fixed(&id_buf);
    var names = std.Io.Writer.fixed(&name_buf);
    const native = !legacy and nativeMillion(family, major, minor orelse 0);
    if (legacy) ids.print("claude-{d}", .{major}) catch return null else ids.print("claude-{s}-{d}", .{ family, major }) catch return null;
    if (minor) |n| ids.print("-{d}", .{n}) catch return null;
    if (legacy) ids.print("-{s}", .{family}) catch return null;
    if (date.len > 0) ids.print("-{s}", .{date}) catch return null;
    names.print("{c}{s} {d}", .{ std.ascii.toUpper(family[0]), family[1..], major }) catch return null;
    // "claude-opus-4-0" is "Opus 4".
    if (minor) |n| if (n != 0) names.print(".{d}", .{n}) catch return null;
    // Claude Code labels the opt-in, not models that are 1M anyway.
    if (million and !native) names.writeAll(" (1M context)") catch return null;
    return .{
        .id = .ascii(ids.buffered()),
        .name = .ascii(names.buffered()),
        .window = if (million or native) 1_000_000 else 200_000,
    };
}

/// The next token after an optional '-', ending at a '-' or at the '@' of a
/// Vertex date. `rest` keeps its separator.
fn token(rest: *[]const u8) []const u8 {
    var s = rest.*;
    if (s.len > 0 and s[0] == '-') s = s[1..];
    const end = std.mem.indexOfAny(u8, s, "-@") orelse s.len;
    rest.* = s[end..];
    return s[0..end];
}
/// A minor version: one or two digits, never the start of a date.
fn optionalNumber(rest: *[]const u8) ?u8 {
    var after = rest.*;
    const n = number(token(&after)) orelse return null;
    rest.* = after;
    return n;
}
fn number(t: []const u8) ?u8 {
    if (t.len == 0 or t.len > 2 or !digits(t)) return null;
    return std.fmt.parseInt(u8, t, 10) catch null;
}
fn word(t: []const u8) bool {
    if (t.len == 0) return false;
    for (t) |ch| if (!std.ascii.isLower(ch)) return false;
    return true;
}
fn digits(s: []const u8) bool {
    for (s) |ch| if (!std.ascii.isDigit(ch)) return false;
    return true;
}

/// What may follow the version, as Claude Code accepts it: "-fast" or
/// "-latest", a date ("-20251101", "@20251101", "-v2@20241022"), then Bedrock's
/// "-v1" or "-v1:0". Returns the date, or null for any other tail.
fn tail(rest: []const u8) ?[]const u8 {
    var s = rest;
    for ([_][]const u8{ "-fast", "-latest" }) |tag| if (std.mem.startsWith(u8, s, tag)) {
        s = s[tag.len..];
        break;
    };
    var date: []const u8 = "";
    if (revision(s)) |after| if (after.len >= 9 and after[0] == '@' and digits(after[1..9])) {
        date = after[1..9];
        s = after[9..];
    };
    if (date.len == 0 and s.len >= 9 and (s[0] == '-' or s[0] == '@') and digits(s[1..9])) {
        date = s[1..9];
        s = s[9..];
    }
    if (revision(s)) |after| {
        s = after;
        if (s.len > 1 and s[0] == ':') {
            var n: usize = 1;
            while (n < s.len and n <= 3 and std.ascii.isDigit(s[n])) n += 1;
            if (n > 1) s = s[n..];
        }
    }
    return if (s.len == 0) date else null;
}
/// What follows "-v" and one to three digits.
fn revision(s: []const u8) ?[]const u8 {
    if (!std.mem.startsWith(u8, s, "-v")) return null;
    var n: usize = 2;
    while (n < s.len and n <= 4 and std.ascii.isDigit(s[n])) n += 1;
    return if (n == 2) null else s[n..];
}

/// "gpt-6.1-sol" reads "GPT-6.1 Sol" and "codex-auto-review" "Codex Auto
/// Review", as Codex names them but with a space after the version. Other
/// OpenAI ids ("o3", "gpt-oss-120b") have no such pattern and stay unnamed.
fn openai(id: []const u8) ?Model {
    for (id) |ch| if (!std.ascii.isLower(ch) and !std.ascii.isDigit(ch) and ch != '-' and ch != '.') return null;
    var name_buf: [Name.capacity]u8 = undefined;
    var names = std.Io.Writer.fixed(&name_buf);
    var words = std.mem.splitScalar(u8, id, '-');
    const first = words.first();
    if (std.mem.eql(u8, first, "gpt")) {
        const version = words.next() orelse return null;
        if (version.len == 0 or !std.ascii.isDigit(version[0])) return null;
        names.print("GPT-{s}", .{version}) catch return null;
    } else if (std.mem.eql(u8, first, "codex")) {
        names.writeAll("Codex") catch return null;
    } else return null;
    while (words.next()) |w| {
        if (w.len == 0) return null;
        names.print(" {c}{s}", .{ std.ascii.toUpper(w[0]), w[1..] }) catch return null;
    }
    return .{ .id = .ascii(id), .name = .ascii(names.buffered()) };
}

test "ids resolve to the names Claude Code and Codex show, across provider spellings" {
    const cases = [_]struct { []const u8, []const u8, []const u8, u64 }{
        // Claude Code's own model table, catalogs and SDK model list.
        .{ "claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", 1_000_000 },
        .{ "claude-opus-5", "claude-opus-5", "Opus 5", 1_000_000 },
        .{ "claude-opus-4-8", "claude-opus-4-8", "Opus 4.8", 1_000_000 },
        .{ "claude-opus-4-7", "claude-opus-4-7", "Opus 4.7", 1_000_000 },
        .{ "claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", 200_000 },
        .{ "claude-opus-4-5-20251101", "claude-opus-4-5-20251101", "Opus 4.5", 200_000 },
        .{ "claude-opus-4-1-20250805", "claude-opus-4-1-20250805", "Opus 4.1", 200_000 },
        .{ "claude-opus-4-0", "claude-opus-4-0", "Opus 4", 200_000 },
        .{ "claude-opus-4-20250514", "claude-opus-4-20250514", "Opus 4", 200_000 },
        .{ "claude-sonnet-5-5", "claude-sonnet-5-5", "Sonnet 5.5", 1_000_000 },
        .{ "claude-sonnet-4-6[1m]", "claude-sonnet-4-6", "Sonnet 4.6 (1M context)", 1_000_000 },
        .{ "claude-opus-5-5[1m]", "claude-opus-5-5", "Opus 5.5", 1_000_000 },
        .{ "claude-haiku-5-5", "claude-haiku-5-5", "Haiku 5.5", 1_000_000 },
        .{ "claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Haiku 4.5", 200_000 },
        .{ "claude-fable-5-1", "claude-fable-5-1", "Fable 5.1", 1_000_000 },
        .{ "claude-mythos-5", "claude-mythos-5", "Mythos 5", 1_000_000 },
        .{ "claude-3-5-sonnet", "claude-3-5-sonnet", "Sonnet 3.5", 200_000 },
        .{ "claude-3-7-sonnet-20250219", "claude-3-7-sonnet-20250219", "Sonnet 3.7", 200_000 },
        // Bedrock and Vertex spellings Claude Code uses.
        .{ "us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001", "Haiku 4.5", 200_000 },
        .{ "us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", "Sonnet 3.5", 200_000 },
        .{ "anthropic.claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", 1_000_000 },
        .{ "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5", "claude-sonnet-5", "Sonnet 5", 1_000_000 },
        .{ "claude-opus-4-5@20251101", "claude-opus-4-5-20251101", "Opus 4.5", 200_000 },
        .{ "claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet-20241022", "Sonnet 3.5", 200_000 },
        .{ "projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1@20250805", "claude-opus-4-1-20250805", "Opus 4.1", 200_000 },
        // Codex's models and the retired ones in older conversations.
        .{ "gpt-6-astra", "gpt-6-astra", "GPT-6 Astra", 0 },
        .{ "gpt-6.1-sol", "gpt-6.1-sol", "GPT-6.1 Sol", 0 },
        .{ "gpt-5.5", "gpt-5.5", "GPT-5.5", 0 },
        .{ "gpt-5.3-codex-spark", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", 0 },
        .{ "codex-auto-review", "codex-auto-review", "Codex Auto Review", 0 },
        // Claude Code's aliases name no version.
        .{ "opus", "opus", "Opus", 0 },
        .{ "sonnet[1m]", "sonnet[1m]", "Sonnet (1M context)", 0 },
        .{ "opusplan", "opusplan", "Opus Plan Mode", 0 },
        // Unknown shapes keep their id and have no name.
        .{ "google/gemma-4-26b-a4b-it", "google/gemma-4-26b-a4b-it", "", 0 },
        .{ "<synthetic>", "<synthetic>", "", 0 },
        .{ "gpt-oss-120b", "gpt-oss-120b", "", 0 },
        .{ "claude-opus-4-5-experimental", "claude-opus-4-5-experimental", "", 0 },
        .{ "best", "best", "", 0 },
        .{ "", "", "", 0 },
    };
    for (cases) |case| {
        const model: Model = .resolve(case[0]);
        errdefer std.debug.print("resolving {s}: {s} / {s} / {d}\n", .{ case[0], model.id.text(), model.name.text(), model.window });
        try std.testing.expectEqualStrings(case[1], model.id.text());
        try std.testing.expectEqualStrings(case[2], model.name.text());
        try std.testing.expectEqual(case[3], model.window);
    }
    try std.testing.expectEqualStrings("google/gemma-4-26b-a4b-it", Model.resolve("google/gemma-4-26b-a4b-it").label());
}
