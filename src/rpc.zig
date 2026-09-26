//! Ordered JSON transport shared by CLI commands and viewers.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
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
        const err = @import("agents.zig").str(result.value, "err");
        if (err.len > 0) {
            if (std.mem.eql(u8, err, "StaleLayout")) return error.StaleLayout;
            if (std.mem.eql(u8, err, "NoPane")) return error.NoPane;
            return error.ServerRejected;
        }
        return result;
    }
    pub fn callViewer(conn: *Connection, value: anytype) !std.json.Parsed(std.json.Value) {
        const result = try conn.request(value);
        errdefer result.deinit();
        const err = @import("agents.zig").str(result.value, "err");
        if (err.len > 0) {
            if (std.mem.eql(u8, err, "UnsupportedViewerProtocol") or
                std.mem.eql(u8, err, "UnsupportedProtocol") or
                std.mem.eql(u8, err, "ProtocolRequired")) return error.IncompatibleViewerProtocol;
            return error.ServerRejected;
        }
        // Validate the envelope before any viewer-specific payload is decoded.
        try @import("viewer_version.zig").require(result.value);
        return result;
    }
    pub fn send(conn: *Connection, value: anytype) !void {
        const response = try conn.call(value);
        response.deinit();
    }
};
