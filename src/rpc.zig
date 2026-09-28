//! Ordered JSON transport shared by CLI commands and viewers.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const agents = @import("agents.zig");
const viewer_version = @import("viewer_version.zig");
const Rejection = @import("protocol.zig").Rejection;
pub const Connection = struct {
    fd: c_int,
    pub fn request(conn: *Connection, value: anytype) !std.json.Parsed(std.json.Value) {
        try os.sendJson(conn.fd, value);
        const bytes = try os.readLine(conn.fd, 16 * 1024 * 1024);
        defer a.free(bytes);
        const result = try std.json.parseFromSlice(std.json.Value, a, bytes, .{ .allocate = .alloc_always });
        return result;
    }
    pub fn call(conn: *Connection, value: anytype) !std.json.Parsed(std.json.Value) {
        const result = try conn.request(value);
        errdefer result.deinit();
        const err = agents.str(result.value, "err");
        if (err.len > 0) {
            return switch (std.meta.stringToEnum(Rejection, err) orelse return error.ServerRejected) {
                .StaleLayout => error.StaleLayout,
                .NoPane => error.NoPane,
                else => error.ServerRejected,
            };
        }
        return result;
    }
    pub fn callViewer(conn: *Connection, value: anytype) !std.json.Parsed(std.json.Value) {
        const result = try conn.request(value);
        errdefer result.deinit();
        const err = agents.str(result.value, "err");
        if (err.len > 0) {
            return switch (std.meta.stringToEnum(Rejection, err) orelse return error.ServerRejected) {
                .UnsupportedViewerProtocol, .UnsupportedProtocol, .ProtocolRequired => error.IncompatibleViewerProtocol,
                else => error.ServerRejected,
            };
        }
        // Validate the envelope before any viewer-specific payload is decoded.
        try viewer_version.require(result.value);
        return result;
    }
    pub fn send(conn: *Connection, value: anytype) !void {
        const response = try conn.call(value);
        response.deinit();
    }
};
