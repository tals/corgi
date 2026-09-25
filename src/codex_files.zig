//! Read-only presentation metadata for explicitly identified Codex sessions.
//! Never selects a pane or supplies lifecycle/completion observations.
const std = @import("std");
const agents = @import("agents.zig");
const a = std.heap.c_allocator;

pub const Name = struct {
    bytes: [160]u8 = @splat(0),
    len: usize = 0,
};

pub const Index = struct {
    bytes: []const u8 = "",
    next_read: i64 = 0,

    pub fn deinit(index: *Index) void {
        if (index.bytes.len > 0) a.free(index.bytes);
    }
    pub fn refresh(index: *Index) void {
        const now = std.time.milliTimestamp();
        if (now < index.next_read) return;
        index.next_read = now + 1000;
        const home = @import("os.zig").env("HOME") orelse return;
        const root = @import("os.zig").env("CODEX_HOME");
        const path = if (root) |dir| std.fs.path.join(a, &.{ dir, "session_index.jsonl" }) catch return else std.fs.path.join(a, &.{ home, ".codex", "session_index.jsonl" }) catch return;
        defer a.free(path);
        const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0) catch return;
        const file: std.fs.File = .{ .handle = fd };
        defer file.close();
        const stat = file.stat() catch return;
        if (stat.kind != .file or stat.size > 8 * 1024 * 1024) return;
        const bytes = file.readToEndAlloc(a, 8 * 1024 * 1024) catch return;
        index.deinit();
        index.bytes = bytes;
    }
    pub fn name(index: *const Index, session: []const u8) Name {
        var out: Name = .{};
        var lines = std.mem.splitScalar(u8, index.bytes, '\n');
        while (lines.next()) |line| {
            // A writer may still be appending the last record.
            if (lines.index == null and !std.mem.endsWith(u8, index.bytes, "\n")) break;
            const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch continue;
            defer parsed.deinit();
            if (!std.mem.eql(u8, agents.str(parsed.value, "id"), session)) continue;
            const value = agents.str(parsed.value, "thread_name");
            if (value.len == 0 or !std.unicode.utf8ValidateSlice(value)) continue;
            out.len = agents.clean(&out.bytes, value);
        }
        return out;
    }
};

pub fn available(agent: *const agents.Agent, now: i64) bool {
    return agent.provider == .codex and (agent.metadata_protocol_at == 0 or now - agent.metadata_protocol_at > 5 * std.time.us_per_s);
}

test "index selects exact identity and latest complete name" {
    const index: Index = .{
        .bytes = "{\"id\":\"a\",\"thread_name\":\"Old\"}\n" ++
            "broken\n{\"id\":\"b\",\"thread_name\":\"Other\"}\n" ++
            "{\"id\":\"a\",\"thread_name\":\"Investigate missing session details\"}\n" ++
            "{\"id\":\"a\",\"thread_name\":\"Partial\"}",
    };
    const name = index.name("a");
    try std.testing.expectEqualStrings("Investigate missing session details", name.bytes[0..name.len]);
    try std.testing.expectEqual(@as(usize, 0), index.name("missing").len);
}
