//! Canonical row bytes owned by one terminal. Render damage stays pending until
//! capture formats the row; other render consumers cannot acknowledge it.
const std = @import("std");

pub const Cache = struct {
    allocator: std.mem.Allocator,
    rows: []Row = &.{},
    pane: ?u32 = null,
    cols: u16 = 0,
    formatted: u64 = 0,
    reused: u64 = 0,

    pub const Row = struct {
        out: std.Io.Writer.Allocating,
        valid: bool = false,
    };

    pub fn init(allocator: std.mem.Allocator) Cache {
        return .{ .allocator = allocator };
    }
    pub fn deinit(cache: *Cache) void {
        for (cache.rows) |*row| row.out.deinit();
        cache.allocator.free(cache.rows);
    }
    pub fn prepare(cache: *Cache, pane: u32, cols: u16, rows: u16) !void {
        if (cache.rows.len != rows) {
            const next = try cache.allocator.alloc(Row, rows);
            for (next) |*row| row.* = .{ .out = .init(cache.allocator) };
            cache.deinit();
            cache.rows = next;
        }
        if (cache.pane != pane or cache.cols != cols) cache.invalidate();
        cache.pane = pane;
        cache.cols = cols;
    }
    pub fn invalidate(cache: *Cache) void {
        for (cache.rows) |*row| row.valid = false;
    }
    pub fn damage(cache: *Cache, dirty: []const bool, full: bool) void {
        if (full or dirty.len != cache.rows.len) return cache.invalidate();
        for (cache.rows, dirty) |*row, changed| if (changed) {
            row.valid = false;
        };
    }
    pub fn stats(cache: *const Cache) [4]u64 {
        var bytes: u64 = 0;
        var capacity: u64 = 0;
        for (cache.rows) |row| {
            bytes += row.out.writer.end;
            capacity += row.out.writer.buffer.len;
        }
        return .{ cache.formatted, cache.reused, bytes, capacity };
    }
};

test "row cache keeps pending damage and survives failed geometry allocation" {
    var failing: std.testing.FailingAllocator = .init(std.testing.allocator, .{});
    var cache: Cache = .init(failing.allocator());
    defer cache.deinit();
    try cache.prepare(1, 20, 4);
    for (cache.rows) |*row| row.valid = true;
    cache.damage(&.{ false, true, false, false }, false);
    cache.damage(&.{ false, false, true, false }, false);
    try std.testing.expect(cache.rows[0].valid and cache.rows[3].valid);
    try std.testing.expect(!cache.rows[1].valid and !cache.rows[2].valid);
    failing.fail_index = failing.alloc_index;
    try std.testing.expectError(error.OutOfMemory, cache.prepare(2, 30, 8));
    try std.testing.expectEqual(@as(?u32, 1), cache.pane);
    try std.testing.expectEqual(@as(usize, 4), cache.rows.len);
    try std.testing.expect(cache.rows[0].valid);
    failing.fail_index = std.math.maxInt(usize);
    try cache.prepare(2, 30, 8);
    for (cache.rows) |row| try std.testing.expect(!row.valid);
}
