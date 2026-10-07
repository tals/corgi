//! The fork card's hero: a line grows out with the conversation's node at its
//! tip, pauses, then peels apart on a spring into the original and its copy.
//! At rest it is text. Where the host has Kitty graphics and reports its cell
//! size, the moving parts are images drawn here at that size, sent once, and
//! re-placed by id with pixel offsets on each frame; elsewhere the hero shows
//! at rest from the start.
const std = @import("std");
const palette = @import("palette.zig");

/// The hero's cells: the trunk 0–3, the junction 4, the branches 5–10 and
/// their nodes 11, on three rows.
pub const width = 12;
const junction = 4;
const node_col = 11;
/// Branch images while the corner grows, from straight to fully rounded.
const corners = 6;
/// The stem below a lifted branch's corner, in rows: room for the overshoot.
const stem_rows = 2;

const motion_ms = 520.0;
const pause_ms = 120.0;
const grow_ms = 0.38 * motion_ms;
const peel_ms = 0.62 * motion_ms;
/// How far the spring overshoots: 0 settles without overshoot.
const bounce = 0.55;
pub const total_ms: i64 = @intFromFloat(grow_ms + pause_ms + peel_ms);
/// How long the images get to arrive before the first frame places them.
pub const lead_ms = 40;

/// The host's cell, in pixels.
pub const Cell = struct { width: u16, height: u16 };
pub const Motion = struct { start: i64, cell: Cell };
/// What the hero shows: `glyphs` when the host draws Kitty's branch drawing
/// characters (Ghostty and Kitty do), and `motion` while it animates.
pub const Hero = struct { glyphs: bool = false, motion: ?Motion = null };

/// Ghostty's and Kitty's branch drawing characters: a filled node with a line
/// to its cell's left edge, and a line fading in from the left.
const node_glyph = "\u{f5f2}";
const fade_glyph = "\u{f5d3}";

const Glyph = enum { fade, line, half, junction, top_corner, bottom_corner, original, copy };
const Text = struct { col: u8, row: u8, glyph: Glyph };
/// One image placed on a frame: its top-left in pixels from the hero's
/// top-left, its layer, and the rows of the image it shows.
const Placement = struct { image: u32, placement: u32, x: i32, y: i32, z: u8 = 2, crop: ?struct { y: u32, h: u32 } = null };
const Frame = struct {
    text: [3 * width]Text = undefined,
    len: usize = 0,
    placements: [4]Placement = undefined,
    placed: usize = 0,

    fn add(f: *Frame, col: usize, row: usize, glyph: Glyph) void {
        f.text[f.len] = .{ .col = @intCast(col), .row = @intCast(row), .glyph = glyph };
        f.len += 1;
    }
    fn place(f: *Frame, p: Placement) void {
        f.placements[f.placed] = p;
        f.placed += 1;
    }
};

// Image ids: the original's node, the copy's, then each branch's corner frames.
const first_id = 730100;
const original_id = first_id;
const copy_id = first_id + 1;
fn branchId(up: bool, k: usize) u32 {
    return @intCast(first_id + 2 + @as(usize, if (up) 0 else corners + 1) + k);
}
const last_id = first_id + 1 + 2 * (corners + 1);
/// Frees every hero image.
pub const remove = std.fmt.comptimePrint("\x1b_Ga=d,d=R,x={d},y={d},q=2\x1b\\", .{ first_id, last_id });

/// The cell's geometry the way Ghostty draws box and branch characters
/// (font/sprite/draw/branch.zig), so images and text line up.
const Metrics = struct {
    cw: f64,
    ch: f64,
    t: f64,
    h_top: f64,
    v_left: f64,
    cx: f64,
    cy: f64,
    r: f64,

    fn of(cell: Cell) Metrics {
        const t: u16 = @max(1, (cell.height + 11) / 22);
        const h_top: f64 = @floatFromInt((cell.height -| t) / 2);
        const v_left: f64 = @floatFromInt((cell.width -| t) / 2);
        const cw: f64 = @floatFromInt(cell.width);
        const ch: f64 = @floatFromInt(cell.height);
        const tf: f64 = @floatFromInt(t);
        const cx = v_left + tf / 2;
        const cy = h_top + tf / 2;
        return .{ .cw = cw, .ch = ch, .t = tf, .h_top = h_top, .v_left = v_left, .cx = cx, .cy = cy, .r = @min(@min(cx, cy), @min(cw - cx, ch - cy)) };
    }
};

fn easeInOut(x: f64) f64 {
    return if (x < 0.5) 4 * x * x * x else 1 - std.math.pow(f64, -2 * x + 2, 3) / 2;
}
/// A damped spring from 0 to 1, settling by x = 1 after overshooting by
/// `bounce`'s share.
fn spring(x: f64) f64 {
    return if (x >= 1) 1 else underdamped(x) / underdamped(1);
}
fn underdamped(u: f64) f64 {
    const zeta = 0.95 - 0.7 * bounce;
    const omega = 12.0;
    const damped = omega * @sqrt(1 - zeta * zeta);
    return 1 - @exp(-zeta * omega * u) * (@cos(damped * u) + (zeta * omega / damped) * @sin(damped * u));
}

/// Whether the hero is still moving at `now`.
pub fn moving(hero: Hero, now: i64) bool {
    const m = hero.motion orelse return false;
    return now < m.start + total_ms;
}

/// The hero at `now`: at rest without motion or once it has finished, and
/// blank until the motion starts.
fn frameAt(hero: Hero, now: i64) Frame {
    var f: Frame = .{};
    const m = hero.motion orelse return rest(f);
    const elapsed: f64 = @floatFromInt(now - m.start);
    if (elapsed < 0) return f;
    if (elapsed >= @as(f64, @floatFromInt(total_ms))) return rest(f);
    const g = Metrics.of(m.cell);
    f.add(0, 1, .fade);
    if (elapsed < grow_ms + pause_ms) {
        // The line grows from the left with the node at its tip, then rests.
        const tip = easeInOut(@min(1, elapsed / grow_ms)) * (node_col * g.cw + g.cx);
        for (1..node_col) |col| {
            const covered = (tip - @as(f64, @floatFromInt(col)) * g.cw) / g.cw;
            if (covered >= 1) f.add(col, 1, .line) else if (covered >= 0.5) f.add(col, 1, .half);
        }
        f.place(.{ .image = original_id, .placement = 1, .x = @intFromFloat(@round(tip - g.cx)), .y = @intFromFloat(g.ch) });
        return f;
    }
    // The peel: everything past the junction lifts apart as two copies.
    for (1..junction) |col| f.add(col, 1, .line);
    f.add(junction, 1, .half);
    const lift = spring((elapsed - grow_ms - pause_ms) / peel_ms) * g.ch;
    const k: usize = @intFromFloat(@min(corners, @round(@abs(lift) / (g.ch / 2) * corners)));
    const trunk = g.ch + g.h_top; // the trunk's stroke, from the hero's top
    const x: i32 = @intFromFloat(junction * g.cw);
    // The upper branch's line sits in its image's first row; it shows down to the trunk's stroke.
    const up_top = g.ch - lift;
    f.place(.{ .image = branchId(true, k), .placement = 2, .x = x, .y = @intFromFloat(@round(up_top)), .crop = .{ .y = 0, .h = @intFromFloat(@max(1, @round(trunk + g.t - up_top))) } });
    // The lower branch's line sits in its image's last row; it shows from the trunk's stroke down.
    const down_top = g.ch + lift - stem_rows * g.ch;
    const from: u32 = @intFromFloat(@max(0, @round(trunk - down_top)));
    const tall: u32 = @intFromFloat((stem_rows + 1) * g.ch);
    f.place(.{ .image = branchId(false, k), .placement = 3, .x = x, .y = @as(i32, @intFromFloat(@round(down_top))) + @as(i32, @intCast(from)), .crop = .{ .y = from, .h = @max(1, tall -| from) } });
    // The nodes ride on the lines, uncropped, the original above: the copy
    // peels out from under it.
    const node_x: i32 = @intFromFloat(node_col * g.cw);
    f.place(.{ .image = copy_id, .placement = 4, .x = node_x, .y = @intFromFloat(@round(g.ch + lift)), .z = 3 });
    f.place(.{ .image = original_id, .placement = 5, .x = node_x, .y = @intFromFloat(@round(up_top)), .z = 4 });
    return f;
}
fn rest(f: Frame) Frame {
    var out = f;
    out.add(0, 1, .fade);
    for (1..junction) |col| out.add(col, 1, .line);
    out.add(junction, 1, .junction);
    out.add(junction, 0, .top_corner);
    out.add(junction, 2, .bottom_corner);
    for (junction + 1..node_col) |col| {
        out.add(col, 0, .line);
        out.add(col, 2, .line);
    }
    out.add(node_col, 0, .original);
    out.add(node_col, 2, .copy);
    return out;
}

/// Draws the hero with its top-left at 0-based cell `x`, `y` on a surface panel.
pub fn draw(w: *std.Io.Writer, x: u16, y: u16, hero: Hero, now: i64) !void {
    const f = frameAt(hero, now);
    const line = comptime (palette.Style{ .fg = .faint, .bg = .surface }).sgr();
    for (f.text[0..f.len]) |cell| {
        const shown: struct { []const u8, []const u8 } = switch (cell.glyph) {
            .fade => .{ line, if (hero.glyphs) fade_glyph else "─" },
            .line => .{ line, "─" },
            .half => .{ line, "╴" },
            .junction => .{ line, "┤" },
            .top_corner => .{ line, "╭" },
            .bottom_corner => .{ line, "╰" },
            .original => .{ comptime (palette.Style{ .fg = .muted, .bg = .surface }).sgr(), if (hero.glyphs) node_glyph else "●" },
            .copy => .{ comptime (palette.Style{ .fg = .accent, .bg = .surface }).sgr(), if (hero.glyphs) node_glyph else "●" },
        };
        try w.print("\x1b[{d};{d}H{s}{s}", .{ y + cell.row + 1, x + cell.col + 1, shown[0], shown[1] });
    }
    const m = hero.motion orelse return;
    // Clear the last frame's placements, then place this frame's.
    try w.print("\x1b7\x1b_Ga=d,d=r,x={d},y={d},q=2\x1b\\", .{ first_id, last_id });
    const cw: i32 = m.cell.width;
    const ch: i32 = m.cell.height;
    for (f.placements[0..f.placed]) |p| {
        const left = @as(i32, x) * cw + p.x;
        const top = @as(i32, y) * ch + p.y;
        const col = @divFloor(left, cw);
        const row = @divFloor(top, ch);
        try w.print("\x1b[{d};{d}H\x1b_Ga=p,i={d},p={d},X={d},Y={d}", .{ row + 1, col + 1, p.image, p.placement, left - col * cw, top - row * ch });
        if (p.crop) |crop| try w.print(",y={d},h={d}", .{ crop.y, crop.h });
        try w.print(",z={d},C=1,q=2\x1b\\", .{p.z});
    }
    try w.writeAll("\x1b8");
}

// ---- Images, drawn here at the host's cell size ---------------------------------

const Canvas = struct {
    w: usize,
    h: usize,
    pixels: []u8,

    fn init(alloc: std.mem.Allocator, w: usize, h: usize) !Canvas {
        const pixels = try alloc.alloc(u8, w * h * 4);
        @memset(pixels, 0);
        return .{ .w = w, .h = h, .pixels = pixels };
    }
    fn deinit(c: Canvas, alloc: std.mem.Allocator) void {
        alloc.free(c.pixels);
    }
    /// Fills whole pixels from `x0`,`y0` up to `x1`,`y1`.
    fn rect(c: Canvas, x0: f64, y0: f64, x1: f64, y1: f64, color: palette.Rgb) void {
        c.fill(x0, y0, x1, y1, color, struct {
            fn contains(_: @This(), _: f64, _: f64) bool {
                return true;
            }
        }{});
    }
    /// Covers the pixels of `shape` inside the box, 4×4 samples a pixel.
    fn fill(c: Canvas, x0: f64, y0: f64, x1: f64, y1: f64, color: palette.Rgb, shape: anytype) void {
        const left: usize = @intFromFloat(@max(0, @floor(x0)));
        const top: usize = @intFromFloat(@max(0, @floor(y0)));
        const right: usize = @intFromFloat(@min(@as(f64, @floatFromInt(c.w)), @ceil(x1)));
        const bottom: usize = @intFromFloat(@min(@as(f64, @floatFromInt(c.h)), @ceil(y1)));
        var py = top;
        while (py < bottom) : (py += 1) {
            var px = left;
            while (px < right) : (px += 1) {
                var hits: u32 = 0;
                for (0..4) |sy| for (0..4) |sx| {
                    const fx = @as(f64, @floatFromInt(px)) + (@as(f64, @floatFromInt(sx)) + 0.5) / 4;
                    const fy = @as(f64, @floatFromInt(py)) + (@as(f64, @floatFromInt(sy)) + 0.5) / 4;
                    if (fx >= x0 and fx < x1 and fy >= y0 and fy < y1 and shape.contains(fx, fy)) hits += 1;
                };
                if (hits == 0) continue;
                const alpha: u8 = @intCast(hits * 255 / 16);
                const i = (py * c.w + px) * 4;
                if (alpha >= c.pixels[i + 3]) {
                    c.pixels[i..][0..3].* = color;
                    c.pixels[i + 3] = alpha;
                }
            }
        }
    }
};
const Disc = struct {
    cx: f64,
    cy: f64,
    r: f64,
    fn contains(d: Disc, x: f64, y: f64) bool {
        return (x - d.cx) * (x - d.cx) + (y - d.cy) * (y - d.cy) <= d.r * d.r;
    }
};
/// A quarter of an elliptical ring, `t` thick, left of its center and above
/// it (`up`) or below it.
const Arc = struct {
    cx: f64,
    cy: f64,
    rx: f64,
    ry: f64,
    t: f64,
    up: bool,
    fn contains(a: Arc, x: f64, y: f64) bool {
        const dx = x - a.cx;
        const dy = y - a.cy;
        if (dx > 0 or (a.up and dy > 0) or (!a.up and dy < 0)) return false;
        // The distance to the ellipse, to first order: its equation over its gradient.
        const f = (dx / a.rx) * (dx / a.rx) + (dy / a.ry) * (dy / a.ry) - 1;
        const gx = 2 * dx / (a.rx * a.rx);
        const gy = 2 * dy / (a.ry * a.ry);
        const slope = @sqrt(gx * gx + gy * gy);
        return slope > 0 and @abs(f) / slope <= a.t / 2;
    }
};

/// A node as Ghostty draws its filled branch node: a disc as wide as it fits,
/// centered on the box lines, with a line out to the cell's left edge.
fn node(c: Canvas, g: Metrics, x: f64, y: f64, color: palette.Rgb) void {
    c.rect(x, y + g.h_top, x + @ceil(g.cx - g.r + g.t / 2), y + g.h_top + g.t, color);
    c.fill(x, y, x + g.cw, y + g.ch, color, Disc{ .cx = x + g.cx, .cy = y + g.cy, .r = g.r });
}
/// A branch from the junction's cell up to its node's, its line in the
/// image's first row (`up`) or last, with frame `k` of the corner and the
/// stem from the corner toward the trunk.
fn branch(c: Canvas, g: Metrics, up: bool, k: usize) void {
    const faint = palette.Token.faint.rgb();
    const row: f64 = if (up) 0 else stem_rows * g.ch;
    const node_x = (node_col - junction) * g.cw;
    if (k == 0) {
        c.rect(0, row + g.h_top, node_x, row + g.h_top + g.t, faint);
    } else {
        const share = @as(f64, @floatFromInt(k)) / corners;
        const ry = g.ch / 2 * share;
        const rx = g.cw / 2 * share;
        const line_y = row + g.cy;
        const corner_y = if (up) line_y + ry else line_y - ry;
        const tall: f64 = @floatFromInt(c.h);
        if (up) c.rect(g.v_left, corner_y, g.v_left + g.t, tall, faint) else c.rect(g.v_left, 0, g.v_left + g.t, corner_y, faint);
        c.fill(0, 0, g.cw, tall, faint, Arc{ .cx = g.cx + rx, .cy = corner_y, .rx = rx, .ry = ry, .t = g.t, .up = up });
        c.rect(g.cx + rx, row + g.h_top, node_x, row + g.h_top + g.t, faint);
    }
}

/// Sends every hero image for `cell`, zlib-compressed, quietly.
pub fn upload(alloc: std.mem.Allocator, w: *std.Io.Writer, cell: Cell) !void {
    const g = Metrics.of(cell);
    const cw: usize = cell.width;
    const ch: usize = cell.height;
    for ([_]u32{ original_id, copy_id }) |id| {
        const c = try Canvas.init(alloc, cw, ch);
        defer c.deinit(alloc);
        node(c, g, 0, 0, (if (id == original_id) palette.Token.muted else palette.Token.accent).rgb());
        try transmit(alloc, w, id, c);
    }
    for ([_]bool{ true, false }) |up| for (0..corners + 1) |k| {
        const c = try Canvas.init(alloc, (node_col - junction) * cw, (stem_rows + 1) * ch);
        defer c.deinit(alloc);
        branch(c, g, up, k);
        try transmit(alloc, w, branchId(up, k), c);
    };
}
fn transmit(alloc: std.mem.Allocator, w: *std.Io.Writer, id: u32, c: Canvas) !void {
    var zipped: std.Io.Writer.Allocating = try .initCapacity(alloc, 4096);
    defer zipped.deinit();
    const window = try alloc.alloc(u8, std.compress.flate.max_window_len);
    defer alloc.free(window);
    var compress: std.compress.flate.Compress = try .init(&zipped.writer, window, .zlib, .fastest);
    try compress.writer.writeAll(c.pixels);
    try compress.finish();
    const data = zipped.written();
    const encoded = try alloc.alloc(u8, std.base64.standard.Encoder.calcSize(data.len));
    defer alloc.free(encoded);
    _ = std.base64.standard.Encoder.encode(encoded, data);
    var offset: usize = 0;
    while (offset < encoded.len) {
        const end = @min(offset + 4096, encoded.len);
        const more = @intFromBool(end < encoded.len);
        if (offset == 0) {
            try w.print("\x1b_Ga=t,t=d,f=32,o=z,s={d},v={d},i={d},q=2,m={d};", .{ c.w, c.h, id, more });
        } else try w.print("\x1b_Gm={d};", .{more});
        try w.writeAll(encoded[offset..end]);
        try w.writeAll("\x1b\\");
        offset = end;
    }
}

test "the spring overshoots, then settles on its end" {
    try std.testing.expectEqual(@as(f64, 0), spring(0));
    try std.testing.expectEqual(@as(f64, 1), spring(1));
    var peak: f64 = 0;
    for (0..100) |i| peak = @max(peak, spring(@as(f64, @floatFromInt(i)) / 100));
    try std.testing.expect(peak > 1.05 and peak < 1.25);
}

test "without motion the hero is at rest; with it, blank until it starts" {
    const at_rest = frameAt(.{}, 0);
    try std.testing.expectEqual(@as(usize, 0), at_rest.placed);
    try std.testing.expectEqual(Glyph.copy, at_rest.text[at_rest.len - 1].glyph);
    const hero: Hero = .{ .motion = .{ .start = 1000, .cell = .{ .width = 18, .height = 40 } } };
    try std.testing.expectEqual(@as(usize, 0), frameAt(hero, 999).len);
    try std.testing.expect(moving(hero, 1000 + total_ms - 1));
    try std.testing.expect(!moving(hero, 1000 + total_ms));
    const done = frameAt(hero, 1000 + total_ms);
    try std.testing.expectEqual(at_rest.len, done.len);
    try std.testing.expectEqual(@as(usize, 0), done.placed);
}

test "the node leads the growing line, then the branches lift apart" {
    const cell: Cell = .{ .width = 18, .height = 40 };
    const hero: Hero = .{ .motion = .{ .start = 0, .cell = cell } };
    var last_x: i32 = std.math.minInt(i32);
    var t: i64 = 0;
    while (t < @as(i64, @intFromFloat(grow_ms))) : (t += 10) {
        const f = frameAt(hero, t);
        try std.testing.expectEqual(@as(usize, 1), f.placed);
        try std.testing.expect(f.placements[0].x >= last_x);
        last_x = f.placements[0].x;
    }
    // Lifting, the upper branch climbs and the lower one drops, each cropped at the trunk.
    const early = frameAt(hero, @intFromFloat(grow_ms + pause_ms + 30));
    const late = frameAt(hero, @intFromFloat(grow_ms + pause_ms + 150));
    try std.testing.expectEqual(@as(usize, 4), early.placed);
    try std.testing.expect(late.placements[0].y < early.placements[0].y);
    try std.testing.expect(late.placements[1].crop.?.h > early.placements[1].crop.?.h);
    try std.testing.expect(late.placements[0].image != early.placements[0].image or late.placements[0].image == branchId(true, corners));
}

test "placements land inside their anchor cell, and only while moving" {
    const hero: Hero = .{ .glyphs = true, .motion = .{ .start = 0, .cell = .{ .width = 18, .height = 40 } } };
    var t: i64 = 0;
    while (t <= total_ms) : (t += 7) {
        var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer out.deinit();
        try draw(&out.writer, 30, 3, hero, t);
        var rest_of = out.written();
        while (std.mem.indexOf(u8, rest_of, ",X=")) |at| {
            rest_of = rest_of[at + 3 ..];
            const x = try std.fmt.parseInt(u32, rest_of[0..std.mem.indexOfScalar(u8, rest_of, ',').?], 10);
            const y_at = std.mem.indexOf(u8, rest_of, ",Y=").? + 3;
            const y = try std.fmt.parseInt(u32, rest_of[y_at..][0..std.mem.indexOfAny(u8, rest_of[y_at..], ",\x1b").?], 10);
            try std.testing.expect(x < 18 and y < 40);
        }
        if (t >= total_ms) try std.testing.expect(std.mem.indexOf(u8, out.written(), "a=p") == null);
    }
}

test "the hero at rest is text: node glyphs where the host draws them, dots elsewhere" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try draw(&out.writer, 0, 0, .{ .glyphs = true }, 0);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, out.written(), node_glyph));
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "\x1b_G") == null);
    out.clearRetainingCapacity();
    try draw(&out.writer, 0, 0, .{}, 0);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, out.written(), "●"));
    try std.testing.expectEqual(@as(usize, 0), std.mem.count(u8, out.written(), node_glyph));
}

test "images go out compressed, once each, and unpack to their pixels" {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    const cell: Cell = .{ .width = 9, .height = 20 };
    try upload(std.testing.allocator, &out.writer, cell);
    const sent = out.written();
    try std.testing.expectEqual(@as(usize, last_id - first_id + 1), std.mem.count(u8, sent, "a=t,"));
    // The node's payload decompresses to its RGBA pixels.
    const start = std.mem.indexOfScalar(u8, sent, ';').? + 1;
    const end = std.mem.indexOf(u8, sent, "\x1b\\").?;
    const zipped = try std.testing.allocator.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(sent[start..end]));
    defer std.testing.allocator.free(zipped);
    try std.base64.standard.Decoder.decode(zipped, sent[start..end]);
    var reader: std.Io.Reader = .fixed(zipped);
    var window: [std.compress.flate.max_window_len]u8 = undefined;
    var decompress: std.compress.flate.Decompress = .init(&reader, .zlib, &window);
    const pixels = try decompress.reader.allocRemaining(std.testing.allocator, .unlimited);
    defer std.testing.allocator.free(pixels);
    try std.testing.expectEqual(@as(usize, 9 * 20 * 4), pixels.len);
    // Its center is opaque muted; its corner is clear.
    const center = (10 * 9 + 4) * 4;
    try std.testing.expectEqual(palette.Token.muted.rgb(), pixels[center..][0..3].*);
    try std.testing.expectEqual(@as(u8, 255), pixels[center + 3]);
    try std.testing.expectEqual(@as(u8, 0), pixels[3]);
}
