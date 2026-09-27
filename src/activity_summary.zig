//! Provider-neutral, bounded evidence and validated display text. Providers
//! supply evidence; inference backends never need to understand their protocols.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
pub const Text = struct {
    bytes: [2048]u8 = @splat(0),
    len: usize = 0,
    pub fn text(t: *const Text) []const u8 {
        return t.bytes[0..t.len];
    }
    pub fn append(t: *Text, value: []const u8) void {
        var n = @min(value.len, t.bytes.len - t.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(value[0..n])) n -= 1;
        @memcpy(t.bytes[t.len..][0..n], value[0..n]);
        t.len += n;
    }
    pub fn hash(t: *const Text) u64 {
        return std.hash.Wyhash.hash(0, t.text());
    }
};
pub const Label = struct {
    bytes: [80]u8 = @splat(0),
    len: usize = 0,
    pub fn text(t: *const Label) []const u8 {
        return t.bytes[0..t.len];
    }
    pub fn parse(value: []const u8) ?Label {
        return validate(value) catch null;
    }
    pub fn validate(value: []const u8) !Label {
        const clean = std.mem.trim(u8, value, " \t\r\n\"");
        if (clean.len == 0) return error.EmptyLabel;
        if (clean.len > 80) return error.LabelTooLong;
        if (!std.unicode.utf8ValidateSlice(clean)) return error.InvalidUtf8;
        var words = std.mem.tokenizeScalar(u8, clean, ' ');
        var count: usize = 0;
        while (words.next()) |_| count += 1;
        // Two or three words is a prompt target, not a reason to hide a useful
        // short label and leave the animation up for a minute.
        if (count < 2 or count > 6) return error.InvalidWordCount;
        var it = (try std.unicode.Utf8View.init(clean)).iterator();
        while (it.nextCodepoint()) |cp| if (cp < 32 or (cp >= 127 and cp <= 159)) return error.ControlCharacter;
        var result: Label = .{};
        @memcpy(result.bytes[0..clean.len], clean);
        result.len = clean.len;
        return result;
    }
};
/// Actor-owned bounded context. Native harnesses are a disposable cache; this
/// checkpoint survives turn changes, detachment, eviction and harness failures.
/// Live daemon handoff preserves it; cold recovery starts fresh context.
pub const Conversation = struct {
    recent: [4]Text = @splat(.{}),
    len: usize = 0,
    previous: Label = .{},

    pub fn key(_: *const Conversation, actor: ActorId, buffer: []u8) []const u8 {
        return std.fmt.bufPrint(buffer, "activity:{d}", .{actor}) catch unreachable;
    }
    pub fn remember(c: *Conversation, turn: []const u8, evidence: []const u8, label: Label) void {
        if (c.len == c.recent.len) {
            std.mem.copyForwards(Text, c.recent[0 .. c.recent.len - 1], c.recent[1..]);
            c.len -= 1;
        }
        const entry = &c.recent[c.len];
        entry.* = .{};
        entry.append("Turn: ");
        entry.append(turn);
        entry.append("\nActivity: ");
        entry.append(label.text());
        entry.append("\nEvidence: ");
        entry.append(evidence[0..@min(evidence.len, 512)]);
        c.len += 1;
        c.previous = label;
    }
};

fn field(v: std.json.Value, key: []const u8) std.json.Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
fn str(v: std.json.Value, key: []const u8) []const u8 {
    const item = field(v, key);
    return if (item == .string) item.string else "";
}
// Codex thread/turn item kinds (`items[].type`) as returned by app-server reads.
const ItemKind = enum { userMessage, agentMessage };
// The summary view contains the first user message and latest assistant message.
// Favor recent commentary over the original request when space is constrained.
pub fn codex(turn: std.json.Value) Text {
    var out: Text = .{};
    const items = field(turn, "items");
    if (items != .array) return out;
    var latest: []const u8 = "";
    for (items.array.items) |item| {
        if (std.meta.stringToEnum(ItemKind, str(item, "type")) == .agentMessage) latest = str(item, "text");
    }
    if (latest.len > 0) {
        out.append("Latest agent update: ");
        out.append(latest[0..@min(latest.len, 1400)]);
        out.append("\n");
    }
    for (items.array.items) |item| {
        if (std.meta.stringToEnum(ItemKind, str(item, "type")) != .userMessage) continue;
        const content = field(item, "content");
        if (content != .array) continue;
        out.append("User request: ");
        for (content.array.items) |part| {
            if (std.mem.eql(u8, str(part, "type"), "text")) out.append(str(part, "text"));
        }
        break;
    }
    return out;
}

test "bounded commentary evidence and strict labels" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"items":[{"type":"userMessage","content":[{"type":"text","text":"Fix tabs"}]},{"type":"agentMessage","text":"Tracing focus changes"}]}
    , .{});
    defer parsed.deinit();
    const evidence = codex(parsed.value);
    try std.testing.expect(std.mem.startsWith(u8, evidence.text(), "Latest agent update: Tracing focus changes"));
    try std.testing.expect(std.mem.indexOf(u8, evidence.text(), "User request: Fix tabs") != null);
    try std.testing.expect(Label.parse("Tracing focus changes") != null);
    try std.testing.expect(Label.parse("Running\ncommands") == null);
    try std.testing.expect(Label.parse("Tracing tool activity code") != null);
    try std.testing.expect(Label.parse("Inspecting logs and summary behavior") != null);
    try std.testing.expect(Label.parse("Checking tool calls and background builds") != null);
    try std.testing.expect(Label.parse("This label has far too many words") == null);
    try std.testing.expect(Label.parse("\x1b[2J bad") == null);
}
