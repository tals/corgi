//! Presentation has a separate wire contract from the public runtime API.
//! Check every exchange: handoff preserves sockets, but can replace the server
//! with a build that speaks a different viewer protocol.
const std = @import("std");

pub const version: u32 = 2;

pub fn compatible(value: std.json.Value) bool {
    if (value != .object) return false;
    const received = value.object.get("viewer_protocol") orelse return false;
    return received == .integer and received.integer == version;
}

pub fn require(value: std.json.Value) !void {
    if (!compatible(value)) return error.IncompatibleViewerProtocol;
}
