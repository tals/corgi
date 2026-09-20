//! Bounded read-only JSON-RPC client for the daemon's Unix WebSocket transport.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const limit = 2 * 1024 * 1024;
pub const Client = struct {
    fd: c_int,
    next_id: u32 = 1,
    deadline: i64 = 0,
    pub fn open(path: []const u8) !Client {
        const addr = try std.net.Address.initUnix(path);
        const fd = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC | std.posix.SOCK.NONBLOCK, 0);
        errdefer std.posix.close(fd);
        try std.posix.connect(fd, &addr.any, addr.getOsSockLen());
        var s: Client = .{ .fd = fd, .deadline = std.time.milliTimestamp() + 1000 };
        var nonce: [16]u8 = undefined;
        std.crypto.random.bytes(&nonce);
        var key: [24]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&key, &nonce);
        const request = try std.fmt.allocPrint(a, "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: {s}\r\nSec-WebSocket-Version: 13\r\n\r\n", .{key});
        defer a.free(request);
        try s.write(request);
        var header: std.ArrayList(u8) = .empty;
        defer header.deinit(a);
        while (!std.mem.endsWith(u8, header.items, "\r\n\r\n")) {
            if (header.items.len >= 16384) return error.BadHandshake;
            var ch: [1]u8 = undefined;
            try s.read(&ch);
            try header.append(a, ch[0]);
        }
        if (!std.mem.startsWith(u8, header.items, "HTTP/1.1 101 ")) return error.BadHandshake;
        var sha = std.crypto.hash.Sha1.init(.{});
        sha.update(&key);
        sha.update("258EAFA5-E914-47DA-95CA-C5AB0DC85B11");
        var digest: [20]u8 = undefined;
        sha.final(&digest);
        var accept: [28]u8 = undefined;
        _ = std.base64.standard.Encoder.encode(&accept, &digest);
        if (std.mem.indexOf(u8, header.items, &accept) == null) return error.BadHandshake;
        const init = try s.call("initialize", .{ .clientInfo = .{ .name = "corgi-observer", .version = "0.1.0" }, .capabilities = .{ .experimentalApi = true } });
        init.deinit();
        try s.frame(1, "{\"method\":\"initialized\",\"params\":{}}");
        return s;
    }
    pub fn close(s: *Client) void {
        std.posix.close(s.fd);
    }
    fn ready(s: *Client, events: c_short) !void {
        const remaining = s.deadline - std.time.milliTimestamp();
        if (remaining <= 0) return error.Timeout;
        var p: c.struct_pollfd = .{ .fd = s.fd, .events = events, .revents = 0 };
        if (c.poll(&p, 1, @intCast(remaining)) <= 0) return error.Timeout;
        if (p.revents & events == 0) return error.Disconnected;
    }
    fn read(s: *Client, bytes: []u8) !void {
        var n: usize = 0;
        while (n < bytes.len) {
            try s.ready(c.POLLIN);
            const got = c.read(s.fd, bytes[n..].ptr, bytes.len - n);
            if (got <= 0) return error.Disconnected;
            n += @intCast(got);
        }
    }
    fn write(s: *Client, bytes: []const u8) !void {
        var n: usize = 0;
        while (n < bytes.len) {
            try s.ready(c.POLLOUT);
            const got = c.write(s.fd, bytes[n..].ptr, bytes.len - n);
            if (got <= 0) return error.Disconnected;
            n += @intCast(got);
        }
    }
    fn frame(s: *Client, opcode: u8, bytes: []const u8) !void {
        if (bytes.len > limit) return error.TooLarge;
        var header: [14]u8 = undefined;
        header[0] = 0x80 | opcode;
        var n: usize = 2;
        if (bytes.len < 126) header[1] = 0x80 | @as(u8, @intCast(bytes.len)) else if (bytes.len <= 65535) {
            header[1] = 0x80 | 126;
            std.mem.writeInt(u16, header[2..4], @intCast(bytes.len), .big);
            n = 4;
        } else {
            header[1] = 0x80 | 127;
            std.mem.writeInt(u64, header[2..10], bytes.len, .big);
            n = 10;
        }
        var mask: [4]u8 = undefined;
        std.crypto.random.bytes(&mask);
        @memcpy(header[n..][0..4], &mask);
        try s.write(header[0 .. n + 4]);
        const payload = try a.dupe(u8, bytes);
        defer a.free(payload);
        for (payload, 0..) |*b, i| b.* ^= mask[i % 4];
        try s.write(payload);
    }
    fn message(s: *Client) ![]u8 {
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(a);
        var fragmented = false;
        while (true) {
            var h: [2]u8 = undefined;
            try s.read(&h);
            if (h[0] & 0x70 != 0 or h[1] & 0x80 != 0) return error.BadFrame;
            const opcode = h[0] & 15;
            var len: u64 = h[1] & 127;
            if (len == 126) {
                var b: [2]u8 = undefined;
                try s.read(&b);
                len = std.mem.readInt(u16, &b, .big);
            }
            if (len == 127) {
                var b: [8]u8 = undefined;
                try s.read(&b);
                len = std.mem.readInt(u64, &b, .big);
            }
            if (len > limit -| out.items.len) return error.TooLarge;
            if (opcode >= 8) {
                if (len > 125 or h[0] & 0x80 == 0) return error.BadFrame;
                var control: [125]u8 = undefined;
                try s.read(control[0..@intCast(len)]);
                if (opcode == 8) return error.Disconnected;
                if (opcode == 9) try s.frame(10, control[0..@intCast(len)]);
                continue;
            }
            if ((opcode == 1 and fragmented) or (opcode == 0 and !fragmented) or (opcode != 0 and opcode != 1)) return error.BadFrame;
            const old = out.items.len;
            try out.resize(a, old + @as(usize, @intCast(len)));
            try s.read(out.items[old..]);
            if (h[0] & 128 != 0) return out.toOwnedSlice(a);
            fragmented = true;
        }
    }
    pub fn call(s: *Client, method: []const u8, params: anytype) !std.json.Parsed(std.json.Value) {
        s.deadline = std.time.milliTimestamp() + 1000;
        const id = s.next_id;
        s.next_id +%= 1;
        const json = try std.json.Stringify.valueAlloc(a, .{ .id = id, .method = method, .params = params }, .{});
        defer a.free(json);
        try s.frame(1, json);
        while (true) {
            const bytes = try s.message();
            defer a.free(bytes);
            const parsed = try std.json.parseFromSlice(std.json.Value, a, bytes, .{ .allocate = .alloc_always });
            const value = parsed.value;
            if (value == .object) if (value.object.get("id")) |got| {
                if (got == .integer and got.integer == id) {
                    if (value.object.contains("error")) {
                        parsed.deinit();
                        return error.RpcFailure;
                    }
                    return parsed;
                }
            };
            parsed.deinit();
        }
    }
};
