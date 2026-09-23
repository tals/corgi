//! Base64 fields in JSON handoff and recovery snapshots.
const std = @import("std");
const codec = std.base64.standard;
pub fn encode(alloc: std.mem.Allocator, bytes: []const u8) ![]const u8 {
    const out = try alloc.alloc(u8, codec.Encoder.calcSize(bytes.len));
    return codec.Encoder.encode(out, bytes);
}
pub fn decode(alloc: std.mem.Allocator, text: []const u8) ![]u8 {
    const out = try alloc.alloc(u8, try codec.Decoder.calcSizeForSlice(text));
    errdefer alloc.free(out);
    try codec.Decoder.decode(out, text);
    return out;
}
