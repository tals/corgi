//! Read-only presentation metadata for explicitly identified Codex sessions.
//! Never selects a pane or supplies lifecycle/completion observations.
const std = @import("std");
const agents = @import("agents.zig");
const BoundedText = @import("bounded_text.zig").BoundedText;
const os = @import("os.zig");
const Codex = @import("providers/codex.zig").Codex;
const a = os.allocator;

pub const Name = BoundedText(160);

/// Codex's session index, parsed when the file changes. Codex appends a
/// record per rename; the latest complete record for a session wins.
pub const Index = struct {
    arena: std.heap.ArenaAllocator = .init(a),
    names: std.StringHashMapUnmanaged(Name) = .empty,
    next_read: i64 = 0,
    stamp: Stamp = .{},

    const Stamp = struct { inode: std.fs.File.INode = 0, size: u64 = 0, mtime: i128 = 0 };
    const Record = struct { id: []const u8 = "", thread_name: []const u8 = "" };

    pub fn deinit(index: *Index) void {
        index.arena.deinit();
    }
    pub fn refresh(index: *Index) void {
        const now = std.time.milliTimestamp();
        if (now < index.next_read) return;
        index.next_read = now + 1000;
        const root = Codex.info.configDir(a) catch return;
        defer a.free(root);
        const path = std.fs.path.join(a, &.{ root, "session_index.jsonl" }) catch return;
        defer a.free(path);
        const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0) catch return;
        const file: std.fs.File = .{ .handle = fd };
        defer file.close();
        const stat = file.stat() catch return;
        if (stat.kind != .file or stat.size > 8 * 1024 * 1024) return;
        const stamp: Stamp = .{ .inode = stat.inode, .size = stat.size, .mtime = stat.mtime };
        if (std.meta.eql(stamp, index.stamp)) return;
        const bytes = file.readToEndAlloc(a, 8 * 1024 * 1024) catch return;
        defer a.free(bytes);
        index.load(bytes) catch return;
        index.stamp = stamp;
    }
    fn load(index: *Index, bytes: []const u8) !void {
        var arena: std.heap.ArenaAllocator = .init(a);
        errdefer arena.deinit();
        const allocator = arena.allocator();
        var names: std.StringHashMapUnmanaged(Name) = .empty;
        var lines = std.mem.splitScalar(u8, bytes, '\n');
        while (lines.next()) |line| {
            // A writer may still be appending the last record.
            if (lines.index == null and !std.mem.endsWith(u8, bytes, "\n")) break;
            const record = std.json.parseFromSliceLeaky(Record, allocator, line, .{ .ignore_unknown_fields = true, .allocate = .alloc_always }) catch continue;
            if (record.thread_name.len == 0 or !std.unicode.utf8ValidateSlice(record.thread_name)) continue;
            try names.put(allocator, record.id, .ascii(record.thread_name));
        }
        index.arena.deinit();
        index.arena = arena;
        index.names = names;
    }
    pub fn name(index: *const Index, session: []const u8) Name {
        return index.names.get(session) orelse .{};
    }
};

pub fn available(agent: *const agents.Agent, now: i64) bool {
    return agent.provider == .codex and (agent.metadata_at == 0 or now - agent.metadata_at > 5 * std.time.us_per_s);
}

test "file names wait five seconds after protocol metadata, on the daemon clock" {
    var agent: agents.Agent = .{ .provider = .codex };
    try std.testing.expect(available(&agent, 0));
    const applied = 50 * std.time.us_per_s;
    agent.metadata_at = applied;
    // The observer's ordering stamp does not age the window.
    agent.metadata_protocol_at = 1;
    try std.testing.expect(!available(&agent, applied + 5 * std.time.us_per_s));
    try std.testing.expect(available(&agent, applied + 5 * std.time.us_per_s + 1));
    agent.provider = .claude;
    try std.testing.expect(!available(&agent, applied + 6 * std.time.us_per_s));
}

test "index selects exact identity and latest complete name" {
    var index: Index = .{};
    defer index.deinit();
    try index.load("{\"id\":\"a\",\"thread_name\":\"Old\"}\n" ++
        "broken\n{\"id\":\"b\",\"thread_name\":\"Other\"}\n" ++
        "{\"id\":\"a\",\"thread_name\":\"Investigate missing session details\"}\n" ++
        "{\"id\":\"a\",\"thread_name\":\"\"}\n" ++
        "{\"id\":\"a\",\"thread_name\":\"Partial\"}");
    const name = index.name("a");
    try std.testing.expectEqualStrings("Investigate missing session details", name.text());
    try std.testing.expectEqualStrings("Other", index.name("b").text());
    try std.testing.expectEqual(@as(usize, 0), index.name("missing").len);
}
