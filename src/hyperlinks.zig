//! Own link metadata alongside completed render cells. Page pointers cannot be
//! consulted later: synchronized output may already have changed/freed them.
const std = @import("std");
const vt = @import("ghostty-vt");
const a = @import("os.zig").allocator;
pub const Link = struct { row: usize, start: usize, end: usize, uri: []const u8, id: u64 };
pub const Snapshot = struct {
    arena: std.heap.ArenaAllocator = .init(a),
    links: []const Link = &.{},
    pub fn deinit(s: *Snapshot) void {
        s.arena.deinit();
    }
    pub fn capture(s: *Snapshot, state: *const vt.RenderState) !void {
        var next: std.heap.ArenaAllocator = .init(a);
        errdefer next.deinit();
        const allocator = next.allocator();
        var links: std.ArrayList(Link) = .empty;
        for (state.row_data.items(.pin), state.row_data.items(.cells), 0..) |pin, cells, row| {
            var last_id: ?u16 = null;
            for (cells.items(.raw), 0..) |cell, col| {
                if (!cell.hyperlink) {
                    last_id = null;
                    continue;
                }
                const page = pin.node.page();
                const actual = page.getRowAndCell(@intCast(col), pin.y).cell;
                const id = page.lookupHyperlink(actual) orelse {
                    last_id = null;
                    continue;
                };
                if (last_id == id) {
                    links.items[links.items.len - 1].end = col + 1;
                    continue;
                }
                const entry = page.hyperlink_set.get(page.memory, id);
                const uri = entry.uri.slice(page.memory);
                if (!safeUri(uri)) {
                    last_id = null;
                    continue;
                }
                var hash = std.hash.Wyhash.init(0);
                hash.update(uri);
                switch (entry.id) {
                    .explicit => |value| hash.update(value.slice(page.memory)),
                    .implicit => |value| hash.update(std.mem.asBytes(&value)),
                }
                try links.append(allocator, .{ .row = row, .start = col, .end = col + 1, .uri = try allocator.dupe(u8, uri), .id = hash.final() });
                last_id = id;
            }
        }
        const owned = try links.toOwnedSlice(allocator);
        s.arena.deinit();
        s.arena = next;
        s.links = owned;
    }
};
fn safeUri(uri: []const u8) bool {
    if (uri.len == 0 or !std.unicode.utf8ValidateSlice(uri)) return false;
    for (uri) |byte| if (byte < 0x20 or byte == 0x7f) return false;
    return true;
}
