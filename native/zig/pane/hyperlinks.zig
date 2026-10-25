//! Own link metadata alongside completed render cells. Page pointers cannot be
//! consulted later: synchronized output may already have changed/freed them.
const std = @import("std");
const vt = @import("ghostty-vt");
const a = @import("../os.zig").allocator;
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
                if (!cell.hyperlink or (cell.style_id != 0 and cells.items(.style)[col].flags.invisible)) {
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
        try detectPlain(allocator, state, &links);
        std.mem.sort(Link, links.items, {}, struct {
            fn less(_: void, lhs: Link, rhs: Link) bool {
                return lhs.row < rhs.row or (lhs.row == rhs.row and lhs.start < rhs.start);
            }
        }.less);
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

// Map UTF-8 bytes back to actual cells, joining only soft-wrapped rows. Explicit
// OSC 8 cells and concealed text are barriers: their targets must win.
fn detectPlain(allocator: std.mem.Allocator, state: *const vt.RenderState, links: *std.ArrayList(Link)) !void {
    if (!hasPlainPrefix(state)) return;
    var scratch: std.heap.ArenaAllocator = .init(a);
    defer scratch.deinit();
    const temporary = scratch.allocator();
    var text: std.ArrayList(u8) = .empty;
    var positions: std.ArrayList(Position) = .empty;
    for (state.row_data.items(.raw), state.row_data.items(.cells), 0..) |row, cells, y| {
        for (cells.items(.raw), 0..) |cell, x| {
            if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
            const hidden = cell.style_id != 0 and cells.items(.style)[x].flags.invisible;
            const cp = cell.codepoint();
            var bytes: [4]u8 = undefined;
            const n = try std.unicode.utf8Encode(if (cell.hyperlink or hidden or cp == 0) ' ' else cp, &bytes);
            const pos: Position = .{ .row = y, .col = x, .end = x + @as(usize, if (cell.wide == .wide) 2 else 1) };
            try text.appendSlice(temporary, bytes[0..n]);
            try positions.appendNTimes(temporary, pos, n);
            if (!cell.hyperlink and !hidden and cell.content_tag == .codepoint_grapheme) for (cells.items(.grapheme)[x]) |extra| {
                const count = try std.unicode.utf8Encode(extra, &bytes);
                try text.appendSlice(temporary, bytes[0..count]);
                try positions.appendNTimes(temporary, pos, count);
            };
        }
        if (!row.wrap) {
            try text.append(temporary, '\n');
            try positions.append(temporary, .{ .row = y, .col = cells.len, .end = cells.len });
        }
    }
    const bytes = text.items;
    var i: usize = 0;
    while (i < bytes.len) {
        const prefix: usize = if (std.mem.startsWith(u8, bytes[i..], "https://")) 8 else if (std.mem.startsWith(u8, bytes[i..], "http://")) 7 else {
            if (imagePath(bytes, i)) |end| {
                const uri = try std.mem.concat(allocator, u8, &.{ "file://", bytes[i..end] });
                try append(allocator, links, positions.items, uri, i, end);
                i = end;
            } else i += 1;
            continue;
        };
        var end = i + prefix;
        while (end < bytes.len and bytes[end] > 0x20 and bytes[end] != 0x7f and std.mem.indexOfScalar(u8, "<>\"'`", bytes[end]) == null) : (end += 1) {}
        var trimmed = end;
        while (trimmed > i + prefix) {
            const last = bytes[trimmed - 1];
            if (std.mem.indexOfScalar(u8, ".,;:!?", last) != null) {
                trimmed -= 1;
                continue;
            }
            const opening: ?u8 = switch (last) {
                ')' => '(',
                ']' => '[',
                '}' => '{',
                else => null,
            };
            if (opening) |open| {
                if (std.mem.count(u8, bytes[i..trimmed], &.{last}) > std.mem.count(u8, bytes[i..trimmed], &.{open})) {
                    trimmed -= 1;
                    continue;
                }
            }
            break;
        }
        if (trimmed > i + prefix and bytes[i + prefix] != '/' and safeUri(bytes[i..trimmed]))
            try append(allocator, links, positions.items, try allocator.dupe(u8, bytes[i..trimmed]), i, trimmed);
        i = end;
    }
}
const Position = struct { row: usize, col: usize, end: usize };
/// Adds the link over text bytes `start..end`, one span per row it covers.
fn append(allocator: std.mem.Allocator, links: *std.ArrayList(Link), positions: []const Position, uri: []const u8, start: usize, end: usize) !void {
    var hash = std.hash.Wyhash.init(0);
    hash.update(uri);
    hash.update(std.mem.asBytes(&start));
    const id = hash.final();
    var at = start;
    while (at < end) {
        const first = positions[at];
        var last = first;
        at += 1;
        while (at < end and positions[at].row == first.row) : (at += 1) last = positions[at];
        try links.append(allocator, .{ .row = first.row, .start = first.col, .end = last.end, .uri = uri, .id = id });
    }
}
const image_extensions = [_][]const u8{ ".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp", ".tif", ".tiff", ".heic", ".avif" };
/// The end of an absolute path to an image file starting at `start`, or null.
/// Its bytes need no escaping in a file:// URI.
fn imagePath(bytes: []const u8, start: usize) ?usize {
    if (bytes[start] != '/' or start + 1 >= bytes.len or bytes[start + 1] == '/') return null;
    if (start > 0 and std.mem.indexOfScalar(u8, " \n(['\"`<", bytes[start - 1]) == null) return null;
    var end = start;
    while (end < bytes.len and (std.ascii.isAlphanumeric(bytes[end]) or std.mem.indexOfScalar(u8, "/._-+@~=,", bytes[end]) != null)) : (end += 1) {}
    while (end > start and std.mem.indexOfScalar(u8, ".,", bytes[end - 1]) != null) end -= 1;
    for (image_extensions) |extension| {
        if (end - start > extension.len and std.ascii.endsWithIgnoreCase(bytes[start..end], extension)) return end;
    }
    return null;
}

// Avoid the byte-to-cell map when there cannot be a link: no "http", and no
// image extension after a slash. Graphemes take the full path; this scan only
// rules out screens made of single codepoints.
fn hasPlainPrefix(state: *const vt.RenderState) bool {
    var matched: usize = 0;
    var slash = false;
    var tail: [5]u8 = @splat(0);
    for (state.row_data.items(.raw), state.row_data.items(.cells)) |row, cells| {
        for (cells.items(.raw)) |cell| {
            if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
            if (cell.content_tag == .codepoint_grapheme) return true;
            const cp = cell.codepoint();
            matched = if (cp == "http"[matched]) matched + 1 else if (cp == 'h') 1 else 0;
            if (matched == 4) return true;
            if (cp == '/') slash = true;
            std.mem.copyForwards(u8, tail[0..4], tail[1..]);
            tail[4] = if (cp < 128) std.ascii.toLower(@intCast(cp)) else 0;
            // Every extension is four or five bytes, dot first.
            if (slash and (tail[0] == '.' or tail[1] == '.')) for (image_extensions) |extension| {
                if (std.mem.endsWith(u8, &tail, extension)) return true;
            };
        }
        if (!row.wrap) matched = 0;
    }
    return false;
}
