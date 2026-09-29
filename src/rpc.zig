//! Ordered JSON transport shared by CLI commands and viewers.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const agents = @import("agents.zig");
const viewer_version = @import("viewer_version.zig");
const protocol = @import("protocol.zig");
const Op = protocol.Op;
pub const Connection = struct {
    fd: c_int,
    pub fn request(conn: *Connection, value: anytype) !std.json.Parsed(std.json.Value) {
        try os.sendJson(conn.fd, value);
        const bytes = try os.readLine(conn.fd, 16 * 1024 * 1024);
        defer a.free(bytes);
        const result = try std.json.parseFromSlice(std.json.Value, a, bytes, .{ .allocate = .alloc_always });
        return result;
    }
    /// Sends `op` with `payload` and decodes the reply. An `err` reply is a
    /// `protocol.Rejection`, or `ServerRejected` for any other name.
    pub fn call(conn: *Connection, comptime op: Op, payload: protocol.Payload(op)) !std.json.Parsed(protocol.Reply(op)) {
        const raw = try conn.request(protocol.Envelope(op){ .payload = payload });
        errdefer raw.deinit();
        const err = agents.str(raw.value, "err");
        if (err.len > 0) return protocol.rejection(err);
        // Before the payload, whose shape may differ between viewer protocols.
        if (comptime protocol.check(op) == .viewer) try viewer_version.require(raw.value);
        if (protocol.Reply(op) == std.json.Value) return raw;
        // Strings in the reply point into the raw reply's arena, which it keeps.
        const reply = try std.json.parseFromValueLeaky(protocol.Reply(op), raw.arena.allocator(), raw.value, .{ .ignore_unknown_fields = true });
        return .{ .arena = raw.arena, .value = reply };
    }
    /// `call` for a request whose reply only says it succeeded.
    pub fn send(conn: *Connection, comptime op: Op, payload: protocol.Payload(op)) !void {
        const reply = try conn.call(op, payload);
        reply.deinit();
    }
};
