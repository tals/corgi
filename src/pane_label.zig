const std = @import("std");
pub const Label = struct {
    bytes: [80]u8 = .{0} ** 80,
    len: usize = 0,
    pub fn text(self: *const Label) []const u8 {
        return self.bytes[0..self.len];
    }
    pub fn set(self: *Label, value: []const u8) void {
        const clean = std.mem.trim(u8, value, " ");
        self.len = @min(clean.len, self.bytes.len);
        for (clean[0..self.len], 0..) |ch, i| self.bytes[i] = if (ch >= 32 and ch < 127) ch else '_';
    }
};
