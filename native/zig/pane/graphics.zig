const std = @import("std");
const vt = @import("ghostty-vt");
const unicode = vt.kitty.graphics.unicode;
const a = @import("../os.zig").allocator;

pub const Image = struct {
    id: []const u8,
    width: u32,
    height: u32,
    format: u8,
    bytes: usize,
};
pub const Placement = struct {
    image: Image,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    source_x: u32,
    source_y: u32,
    source_width: u32,
    source_height: u32,
    z: i32,
};
const Asset = struct {
    image: Image,
    generation: u64,
    data: []const u8,
};

/// Kitty placeholder runs in the viewport, left to right within each row.
/// Ghostty resolves their colors and diacritics; a run never spans rows.
const VirtualPlacements = struct {
    rows: vt.PageList.RowIterator,
    row: ?vt.Pin = null,
    x: usize = 0,

    fn next(self: *VirtualPlacements) ?unicode.Placement {
        while (self.row) |row| {
            if (row.rowAndCell().row.kitty_virtual_placeholder) {
                const cells = row.cells(.all);
                var run: ?unicode.IncompletePlacement = null;
                var start = self.x;
                while (self.x < cells.len) : (self.x += 1) {
                    const cell = &cells[self.x];
                    if (cell.codepoint() != unicode.placeholder) {
                        if (run != null) break;
                        continue;
                    }
                    const style = row.style(cell);
                    const curr: unicode.IncompletePlacement = .init(&style, row.grapheme(cell) orelse &.{});
                    if (run) |*prev| {
                        if (!prev.append(&curr)) break;
                    } else {
                        run = curr.start();
                        start = self.x;
                    }
                }
                if (run) |r| {
                    var pin = row;
                    pin.x = @intCast(start);
                    return .{ .pin = pin, .image_id = r.imageId(), .placement_id = r.placement_id orelse 0, .col = r.col.?, .row = r.row.?, .width = r.width, .height = 1 };
                }
            }
            self.row = self.rows.next();
            self.x = 0;
        }
        return null;
    }
};

/// Owns the pixels and placements of the last completed render, including
/// while the program replaces or deletes images in a synchronized update.
pub const Snapshot = struct {
    assets: std.ArrayList(Asset) = .empty,
    placements: std.ArrayList(Placement) = .empty,

    pub fn deinit(self: *Snapshot) void {
        for (self.assets.items) |asset| {
            a.free(asset.image.id);
            a.free(asset.data);
        }
        self.assets.deinit(a);
        self.placements.deinit(a);
        self.* = .{};
    }

    pub fn capture(self: *Snapshot, t: *vt.Terminal, identity: u64) !void {
        const storage = &t.screens.active.kitty_images;
        var next: Snapshot = .{};
        errdefer next.deinit();
        // Reuse unchanged pixels; a viewport or text update only rebuilds placements.
        var images = storage.images.valueIterator();
        while (images.next()) |image| {
            const data = image.data.bytes() orelse continue;
            var reused = false;
            for (self.assets.items, 0..) |asset, i| {
                if (asset.generation != image.generation) continue;
                try next.assets.append(a, asset);
                _ = self.assets.swapRemove(i);
                reused = true;
                break;
            }
            if (reused) continue;
            const id = try std.fmt.allocPrint(a, "{x}-{x}", .{ identity, image.generation });
            errdefer a.free(id);
            const pixels = try a.dupe(u8, data);
            errdefer a.free(pixels);
            try next.assets.append(a, .{
                .image = .{ .id = id, .width = image.width, .height = image.height, .format = if (image.format == .rgb) 24 else 32, .bytes = data.len },
                .generation = image.generation,
                .data = pixels,
            });
        }
        const pages = &t.screens.active.pages;
        const viewport = pages.pointFromPin(.screen, pages.getTopLeft(.viewport)).?.screen;
        const cw: f64 = @floatFromInt(@max(1, t.width_px / t.cols));
        const ch: f64 = @floatFromInt(@max(1, t.height_px / t.rows));
        var placements = storage.placements.iterator();
        var has_virtual = false;
        while (placements.next()) |entry| {
            const p = entry.value_ptr;
            const image = storage.imageById(entry.key_ptr.image_id) orelse continue;
            var pin: *const vt.Pin = undefined;
            var dx: i32 = 0;
            var dy: i32 = 0;
            switch (p.location) {
                .pin => |value| pin = value,
                .virtual => {
                    has_virtual = true;
                    continue;
                },
                .relative => |rel| {
                    const chain = storage.resolveChain(rel) orelse continue;
                    pin = switch (chain.root.location) {
                        .pin => |value| value,
                        else => continue,
                    };
                    dx = chain.horizontal_offset;
                    dy = chain.vertical_offset;
                },
            }
            if (pin.garbage) continue;
            const point = (pages.pointFromPin(.screen, pin.*) orelse continue).screen;
            const size = p.pixelSize(image, t);
            const offset = p.cellOffset(t);
            const source = p.sourceRect(image);
            const x = @as(f64, @floatFromInt(@as(i64, point.x) + dx)) + @as(f64, @floatFromInt(offset.x)) / cw;
            const y = @as(f64, @floatFromInt(@as(i64, @intCast(point.y)) - @as(i64, @intCast(viewport.y)) + dy)) + @as(f64, @floatFromInt(offset.y)) / ch;
            const width = @as(f64, @floatFromInt(size.width)) / cw;
            const height = @as(f64, @floatFromInt(size.height)) / ch;
            if (width == 0 or height == 0 or x + width <= 0 or y + height <= 0 or x >= t.cols or y >= t.rows) continue;
            for (next.assets.items) |asset| {
                if (asset.generation != image.generation) continue;
                try next.placements.append(a, .{
                    .image = asset.image,
                    .x = x,
                    .y = y,
                    .width = width,
                    .height = height,
                    .source_x = source.x,
                    .source_y = source.y,
                    .source_width = source.width,
                    .source_height = source.height,
                    .z = p.z,
                });
                break;
            }
        }
        if (has_virtual) {
            var virtuals: VirtualPlacements = .{ .rows = pages.getTopLeft(.viewport).rowIterator(.right_down, pages.getBottomRight(.viewport)) };
            virtuals.row = virtuals.rows.next();
            while (virtuals.next()) |p| {
                const image = storage.imageById(p.image_id) orelse continue;
                const target = storage.placeholderTarget(p.image_id, p.placement_id) orelse continue;
                const rendered = p.renderPlacement(&target.placement, &image, @intFromFloat(cw), @intFromFloat(ch)) catch continue;
                if (rendered.dest_width == 0 or rendered.dest_height == 0 or rendered.source_width == 0 or rendered.source_height == 0) continue;
                const point = (pages.pointFromPin(.viewport, rendered.top_left) orelse continue).viewport;
                for (next.assets.items) |asset| {
                    if (asset.generation != image.generation) continue;
                    try next.placements.append(a, .{
                        .image = asset.image,
                        .x = @as(f64, @floatFromInt(point.x)) + @as(f64, @floatFromInt(rendered.offset_x)) / cw,
                        .y = @as(f64, @floatFromInt(point.y)) + @as(f64, @floatFromInt(rendered.offset_y)) / ch,
                        .width = @as(f64, @floatFromInt(rendered.dest_width)) / cw,
                        .height = @as(f64, @floatFromInt(rendered.dest_height)) / ch,
                        .source_x = rendered.source_x,
                        .source_y = rendered.source_y,
                        .source_width = rendered.source_width,
                        .source_height = rendered.source_height,
                        .z = -1,
                    });
                    break;
                }
            }
        }
        self.deinit();
        self.* = next;
    }

    /// Bounded transfers keep image bytes out of ordinary surface updates.
    pub fn chunk(self: *const Snapshot, alloc: std.mem.Allocator, id: []const u8, offset: usize) !?[]const u8 {
        for (self.assets.items) |asset| {
            if (!std.mem.eql(u8, asset.image.id, id)) continue;
            if (offset >= asset.data.len) return null;
            const data = asset.data[offset..@min(asset.data.len, offset +| 192 * 1024)];
            const out = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(data.len));
            return std.base64.standard.Encoder.encode(out, data);
        }
        return null;
    }
};

pub fn decodePng(alloc: std.mem.Allocator, data: []const u8) vt.sys.DecodeError!vt.sys.Image {
    const decoded = @import("wuffs").png.decode(alloc, data) catch |err| return switch (err) {
        error.OutOfMemory => error.OutOfMemory,
        else => error.InvalidData,
    };
    return .{ .width = decoded.width, .height = decoded.height, .data = decoded.data };
}
