//! A directory subscription owns the latest launcher snapshot independently of
//! popup lifetime. The separate socket keeps events out of ordered RPC replies.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const Preview = @import("agent_launcher.zig").Preview;

pub const Stream = struct {
    socket: []const u8 = "",
    fd: ?c_int = null,
    input: std.ArrayList(u8) = .empty,
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    len: usize = 0,
    workspace: u32 = 0,
    preview: Preview = .{},
    received: bool = false,
    retry_at: i64 = 0,

    pub fn deinit(s: *Stream) void {
        s.disconnect();
        s.input.deinit(a);
    }

    fn disconnect(s: *Stream) void {
        if (s.fd) |fd| _ = os.c.close(fd);
        s.fd = null;
        s.input.clearRetainingCapacity();
    }

    pub fn current(s: *const Stream, cwd: []const u8) Preview {
        if (std.mem.eql(u8, cwd, s.cwd[0..s.len])) return s.preview;
        // Provider visibility survives a directory change; model settings don't.
        var result: Preview = .{ .installed = s.preview.installed };
        for (&result.options, s.preview.options) |*option, previous| option.signed_in = previous.signed_in;
        return result;
    }

    pub fn pending(s: *Stream, cwd: []const u8) void {
        if (std.mem.eql(u8, cwd, s.cwd[0..s.len])) s.preview.pending = true;
    }

    /// Subscribe only when the directory changes or the connection is lost.
    /// Otherwise this only drains pushed messages; it sends no requests.
    pub fn poll(s: *Stream, workspace: u32, cwd: []const u8) bool {
        if (s.socket.len == 0 or cwd.len > s.cwd.len) return false;
        var changed = false;
        if (s.workspace != workspace or !std.mem.eql(u8, cwd, s.cwd[0..s.len])) {
            const initial = s.current(cwd);
            s.disconnect();
            @memcpy(s.cwd[0..cwd.len], cwd);
            s.len = cwd.len;
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
            os.sendJson(fd, .{ .op = "agent.subscribe", .protocol = 1, .workspace = workspace, .cwd = cwd }) catch {
                s.disconnect();
                s.retry_at = now + 1000;
                return changed;
            };
        }
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
            if (s.input.items.len + @as(usize, @intCast(n)) > 128 * 1024) return error.MessageTooLarge;
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
        const Message = struct { type: []const u8, cwd: []const u8, preview: Preview };
        const parsed = try std.json.parseFromSlice(Message, a, bytes, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const message = parsed.value;
        if (!std.mem.eql(u8, message.type, "agent.preview") or !std.mem.eql(u8, message.cwd, s.cwd[0..s.len])) return false;
        var preview = message.preview;
        if (preview.pending) {
            if (s.received) {
                preview = s.preview;
                preview.pending = true;
                preview.installed = message.preview.installed;
            }
            for (&preview.options, s.preview.options) |*option, previous| {
                if (option.signed_in == null) option.signed_in = previous.signed_in;
            }
        }
        const changed = !std.meta.eql(s.preview, preview);
        s.preview = preview;
        s.received = true;
        return changed;
    }
};

test "preview stream handles partial and consecutive messages and ignores old directories" {
    var pair: [2]c_int = undefined;
    if (os.c.socketpair(os.c.AF_UNIX, os.c.SOCK_STREAM, 0, &pair) != 0) return error.SocketPairFailed;
    defer _ = os.c.close(pair[1]);
    var stream: Stream = .{ .fd = pair[0], .len = 2 };
    defer stream.deinit();
    @memcpy(stream.cwd[0..2], "/a");
    var preview: Preview = .{ .pending = false };
    preview.options[0].model.set("initial");
    const first = try std.json.Stringify.valueAlloc(a, .{ .type = "agent.preview", .cwd = "/a", .preview = preview }, .{});
    defer a.free(first);
    try os.writeAll(pair[1], first[0..100]);
    try std.testing.expect(!try stream.drain());
    try os.writeAll(pair[1], first[100..]);
    try os.writeAll(pair[1], "\n");
    try std.testing.expect(try stream.drain());
    try std.testing.expectEqualStrings("initial", stream.current("/a").options[0].model.text());
    preview.options[0].model.set("updated");
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/a", .preview = preview });
    preview.options[0].model.set("wrong directory");
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/b", .preview = preview });
    try std.testing.expect(try stream.drain());
    try std.testing.expectEqualStrings("updated", stream.current("/a").options[0].model.text());
    try std.testing.expectEqual(@as(usize, 0), stream.current("/b").options[0].model.len);
    try os.sendJson(pair[1], .{ .type = "agent.preview", .cwd = "/a", .preview = Preview{} });
    try std.testing.expect(try stream.drain());
    try std.testing.expect(stream.preview.pending);
    try std.testing.expectEqualStrings("updated", stream.preview.options[0].model.text());
}
