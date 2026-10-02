//! A directory subscription owns the latest launcher snapshot independently of
//! popup lifetime. The separate socket keeps events out of ordered RPC replies.
//! It also carries the conversations the launcher can resume, on request.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const Preview = @import("launch.zig").Preview;
const History = @import("launch.zig").history.History;
const Provider = @import("providers.zig").Provider;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const Path = @import("bounded_text.zig").Path;
const protocol = @import("protocol.zig");

pub const Stream = struct {
    socket: []const u8 = "",
    fd: ?c_int = null,
    input: std.ArrayList(u8) = .empty,
    cwd: Path = .{},
    workspace: WorkspaceId = .none,
    preview: Preview = .{},
    received: bool = false,
    retry_at: i64 = 0,
    /// The last conversations received, in `history_arena`.
    history: History = .{},
    history_arena: ?std.heap.ArenaAllocator = null,
    /// A request is due once connected, or sent and unanswered.
    history_due: bool = false,
    history_sent: bool = false,
    history_at: i64 = 0,

    const Kind = enum { @"agent.preview", @"agent.history" };

    pub fn deinit(s: *Stream) void {
        s.disconnect();
        s.input.deinit(a);
        if (s.history_arena) |*arena| arena.deinit();
    }

    /// Ask for the conversations again unless an answer is on its way or
    /// arrived within `max_age_ms`.
    pub fn requestHistory(s: *Stream, max_age_ms: i64) void {
        if (s.history_sent or s.history_due) return;
        if (s.history_at != 0 and std.time.milliTimestamp() - s.history_at < max_age_ms) return;
        s.history_due = true;
        s.sendHistoryRequest();
    }
    fn sendHistoryRequest(s: *Stream) void {
        const fd = s.fd orelse return;
        os.sendJson(fd, protocol.Envelope(.@"agent.history"){ .payload = {} }) catch return;
        s.history_due = false;
        s.history_sent = true;
    }

    fn disconnect(s: *Stream) void {
        if (s.fd) |fd| _ = os.c.close(fd);
        s.fd = null;
        s.input.clearRetainingCapacity();
        // The next connection asks again.
        if (s.history_sent) s.history_due = true;
        s.history_sent = false;
    }

    pub fn current(s: *const Stream, cwd: []const u8) Preview {
        if (std.mem.eql(u8, cwd, s.cwd.text())) return s.preview;
        // Provider visibility survives a directory change; model settings don't.
        var result: Preview = .{ .installed = s.preview.installed };
        for (Provider.all) |provider| result.options.getPtr(provider).signed_in = s.preview.options.get(provider).signed_in;
        return result;
    }

    pub fn pending(s: *Stream, cwd: []const u8) void {
        if (std.mem.eql(u8, cwd, s.cwd.text())) s.preview.pending = true;
    }

    /// Subscribe only when the directory changes or the connection is lost.
    /// Otherwise this only drains pushed messages; it sends no requests.
    pub fn poll(s: *Stream, workspace: WorkspaceId, cwd: []const u8) bool {
        if (s.socket.len == 0) return false;
        const dir = Path.init(cwd) catch return false;
        var changed = false;
        if (s.workspace != workspace or !std.mem.eql(u8, cwd, s.cwd.text())) {
            const initial = s.current(cwd);
            s.disconnect();
            s.cwd = dir;
            s.workspace = workspace;
            s.preview = initial;
            s.received = false;
            s.retry_at = 0;
            changed = true;
        }
        const now = std.time.milliTimestamp();
        if (s.fd == null) {
            if (now < s.retry_at) return changed;
            s.retry_at = now + 1000;
            const fd = os.connect(s.socket) catch return changed;
            s.fd = fd;
            os.sendJson(fd, protocol.Envelope(.@"agent.subscribe"){ .payload = .{ .workspace = workspace, .cwd = cwd } }) catch {
                s.disconnect();
                s.retry_at = now + 1000;
                return changed;
            };
        }
        if (s.history_due) s.sendHistoryRequest();
        const previous = s.preview;
        const received = s.drain() catch {
            s.disconnect();
            s.retry_at = now + 1000;
            return changed or !std.meta.eql(previous, s.preview);
        };
        return changed or received;
    }

    fn drain(s: *Stream) !bool {
        var changed = false;
        while (true) {
            var bytes: [8192]u8 = undefined;
            const n = os.c.recv(s.fd.?, &bytes, bytes.len, os.c.MSG_DONTWAIT);
            if (n < 0) switch (std.posix.errno(n)) {
                .AGAIN => return changed,
                .INTR => continue,
                else => return error.ReadFailed,
            };
            if (n == 0) return error.EndOfStream;
            // The daemon caps a message at 4 MiB; conversations are the largest.
            if (s.input.items.len + @as(usize, @intCast(n)) > 4 * 1024 * 1024 + 1) return error.MessageTooLarge;
            try s.input.appendSlice(a, bytes[0..@intCast(n)]);
            var consumed: usize = 0;
            while (std.mem.indexOfScalarPos(u8, s.input.items, consumed, '\n')) |end| {
                changed = try s.receive(s.input.items[consumed..end]) or changed;
                consumed = end + 1;
            }
            std.mem.copyForwards(u8, s.input.items[0 .. s.input.items.len - consumed], s.input.items[consumed..]);
            s.input.items.len -= consumed;
        }
    }

    fn receive(s: *Stream, bytes: []const u8) !bool {
        const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        defer parsed.deinit();
        const Header = struct { type: []const u8 = "", err: ?[]const u8 = null };
        const header = try std.json.parseFromValueLeaky(Header, parsed.arena.allocator(), parsed.value, .{ .ignore_unknown_fields = true });
        switch (std.meta.stringToEnum(Kind, header.type) orelse {
            // An older daemon refuses `agent.history`; show none rather than wait.
            if (s.history_sent and header.err != null) {
                s.history_sent = false;
                s.storeHistory(.{ .pending = false }, null);
                return true;
            }
            return false;
        }) {
            .@"agent.history" => {
                var arena: std.heap.ArenaAllocator = .init(a);
                errdefer arena.deinit();
                const Message = struct { history: History };
                const message = try std.json.parseFromValueLeaky(Message, arena.allocator(), parsed.value, .{ .ignore_unknown_fields = true, .allocate = .alloc_always });
                // A pending list is the last read; a fresh one follows.
                s.history_sent = message.history.pending;
                s.storeHistory(message.history, arena);
                return true;
            },
            .@"agent.preview" => {},
        }
        const Message = struct { cwd: []const u8, preview: Preview };
        const decoded = try std.json.parseFromValue(Message, a, parsed.value, .{ .ignore_unknown_fields = true });
        defer decoded.deinit();
        const message = decoded.value;
        if (!std.mem.eql(u8, message.cwd, s.cwd.text())) return false;
        var preview = message.preview;
        if (preview.pending) {
            if (s.received) {
                preview = s.preview;
                preview.pending = true;
                preview.installed = message.preview.installed;
            }
            for (Provider.all) |provider| {
                const option = preview.options.getPtr(provider);
                if (option.signed_in == null) option.signed_in = s.preview.options.get(provider).signed_in;
            }
        }
        const changed = !std.meta.eql(s.preview, preview);
        s.preview = preview;
        s.received = true;
        return changed;
    }
    fn storeHistory(s: *Stream, history: History, arena: ?std.heap.ArenaAllocator) void {
        if (s.history_arena) |*old| old.deinit();
        s.history_arena = arena;
        s.history = history;
        s.history_at = std.time.milliTimestamp();
    }
};

test "preview stream handles partial and consecutive messages and ignores old directories" {
    var pair: [2]c_int = undefined;
    if (os.c.socketpair(os.c.AF_UNIX, os.c.SOCK_STREAM, 0, &pair) != 0) return error.SocketPairFailed;
    defer _ = os.c.close(pair[1]);
    var stream: Stream = .{ .fd = pair[0], .cwd = .initTruncated("/a") };
    defer stream.deinit();
    var preview: Preview = .{ .pending = false };
    preview.options.getPtr(.codex).model = .ascii("initial");
    const first = try std.json.Stringify.valueAlloc(a, .{ .type = "agent.preview", .cwd = "/a", .preview = preview }, .{});
    defer a.free(first);
    try os.writeAll(pair[1], first[0..100]);
    try std.testing.expect(!try stream.drain());
    try os.writeAll(pair[1], first[100..]);
    try os.writeAll(pair[1], "\n");
    try std.testing.expect(try stream.drain());
    try std.testing.expectEqualStrings("initial", stream.current("/a").options.get(.codex).model.text());
    preview.options.getPtr(.codex).model = .ascii("updated");
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/a", .preview = preview });
    preview.options.getPtr(.codex).model = .ascii("wrong directory");
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/b", .preview = preview });
    try std.testing.expect(try stream.drain());
    try std.testing.expectEqualStrings("updated", stream.current("/a").options.get(.codex).model.text());
    try std.testing.expectEqual(@as(usize, 0), stream.current("/b").options.get(.codex).model.len);
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/a", .preview = Preview{} });
    try std.testing.expect(try stream.drain());
    try std.testing.expect(stream.preview.pending);
    try std.testing.expectEqualStrings("updated", stream.preview.options.getPtr(.codex).model.text());
}

test "history arrives on the preview stream and an old daemon's refusal ends the wait" {
    var pair: [2]c_int = undefined;
    if (os.c.socketpair(os.c.AF_UNIX, os.c.SOCK_STREAM, 0, &pair) != 0) return error.SocketPairFailed;
    defer _ = os.c.close(pair[1]);
    var stream: Stream = .{ .fd = pair[0], .cwd = .initTruncated("/a") };
    defer stream.deinit();
    stream.requestHistory(0);
    try std.testing.expect(stream.history_sent);
    var request: [256]u8 = undefined;
    const n = os.c.recv(pair[1], &request, request.len, 0);
    try std.testing.expect(std.mem.indexOf(u8, request[0..@intCast(n)], "\"op\":\"agent.history\"") != null);
    try os.sendJson(pair[1], .{ .type = "agent.history", .history = History{ .pending = false, .entries = &.{
        .{ .provider = .claude, .session = "s1", .title = "Sidebar flicker", .cwd = "/a", .updated_at = 5 },
    } } });
    try std.testing.expect(try stream.drain());
    try std.testing.expect(!stream.history_sent);
    try std.testing.expectEqual(@as(usize, 1), stream.history.entries.len);
    try std.testing.expectEqualStrings("Sidebar flicker", stream.history.entries[0].title);
    // Recent enough: no second request.
    stream.requestHistory(60_000);
    try std.testing.expect(!stream.history_sent);
    stream.requestHistory(0);
    try std.testing.expect(stream.history_sent);
    _ = os.c.recv(pair[1], &request, request.len, 0);
    try os.sendJson(pair[1], .{ .err = "UnknownOperation" });
    try std.testing.expect(try stream.drain());
    try std.testing.expect(!stream.history_sent and !stream.history.pending);
    try std.testing.expectEqual(@as(usize, 0), stream.history.entries.len);
}
