//! Own link metadata alongside completed render cells. Page pointers cannot be
//! consulted later: synchronized output may already have changed/freed them.
const std = @import("std");
const vt = @import("ghostty-vt");
const a = @import("../os.zig").allocator;
/// `joined` continues the segment ending the row above as one link: across a
/// soft wrap, or for plain text, an application's line break.
pub const Link = struct { row: usize, start: usize, end: usize, uri: []const u8, id: u64, joined: bool = false };
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
        const rows = state.row_data.items(.raw);
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
                const link_id = hash.final();
                // A wide character's spacer may end a row one cell early.
                const joined = col == 0 and links.items.len > 0 and above: {
                    const prev = links.items[links.items.len - 1];
                    break :above prev.id == link_id and prev.row + 1 == row and rows[prev.row].wrap and prev.end + 1 >= state.cols;
                };
                try links.append(allocator, .{ .row = row, .start = col, .end = col + 1, .uri = try allocator.dupe(u8, uri), .id = link_id, .joined = joined });
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

// Map UTF-8 bytes back to actual cells. Explicit OSC 8 cells and concealed
// text are barriers: their targets must win.
fn detectPlain(allocator: std.mem.Allocator, state: *const vt.RenderState, links: *std.ArrayList(Link)) !void {
    if (!hasPlainPrefix(state)) return;
    var scratch: std.heap.ArenaAllocator = .init(a);
    defer scratch.deinit();
    const temporary = scratch.allocator();
    var text: std.ArrayList(u8) = .empty;
    var positions: std.ArrayList(Position) = .empty;
    var rows: std.ArrayList(Row) = .empty;
    for (state.row_data.items(.raw), state.row_data.items(.cells), 0..) |row, cells, y| {
        const start = text.items.len;
        var indent: usize = 0;
        var leading = true;
        for (cells.items(.raw), 0..) |cell, x| {
            if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
            const hidden = cell.style_id != 0 and cells.items(.style)[x].flags.invisible;
            const cp = cell.codepoint();
            if (leading and !cell.hyperlink and !hidden and (cp == 0 or cp == ' ')) indent += 1 else leading = false;
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
        const hanging = marker(text.items[start..], positions.items[start..], indent);
        try rows.append(temporary, .{ .start = start, .end = text.items.len, .indent = indent, .hanging = hanging });
        if (!row.wrap) {
            try text.append(temporary, '\n');
            try positions.append(temporary, .{ .row = y, .col = cells.len, .end = cells.len });
        }
    }
    const bytes = text.items;
    var candidate: std.ArrayList(u8) = .empty;
    var mapped: std.ArrayList(Position) = .empty;
    var i: usize = 0;
    while (i < bytes.len) {
        const prefix = webPrefix(bytes[i..]);
        if (prefix == 0) {
            if (imagePath(bytes, i)) |end| {
                const uri = try std.mem.concat(allocator, u8, &.{ "file://", bytes[i..end] });
                try append(allocator, links, positions.items[i..end], uri, i);
                i = end;
            } else i += 1;
            continue;
        }
        candidate.clearRetainingCapacity();
        mapped.clearRetainingCapacity();
        const first = rows.items[positions.items[i].row];
        var end = i;
        while (end < bytes.len) {
            if (urlByte(bytes[end]) and !closingQuote(bytes, end)) {
                try candidate.append(temporary, bytes[end]);
                try mapped.append(temporary, positions.items[end]);
                end += 1;
                continue;
            }
            const suffix = candidate.items[trimmed(candidate.items).len..];
            if (mapped.items.len > prefix and std.mem.indexOfAny(u8, suffix, ")]}") == null) {
                if (continuation(bytes, rows.items, mapped.items[mapped.items.len - 1], end, state.cols, first)) |next| {
                    end = next;
                    continue;
                }
            }
            break;
        }
        const uri_text = trimmed(candidate.items);
        if (uri_text.len > prefix and uri_text[prefix] != '/' and safeUri(uri_text))
            try append(allocator, links, mapped.items[0..uri_text.len], try allocator.dupe(u8, uri_text), i);
        i = end;
    }
}

const Position = struct { row: usize, col: usize, end: usize };
/// `indent` counts leading blank cells; explicit links and concealed text are
/// not blank. `hanging` is the column after a list marker, or 0.
const Row = struct { start: usize, end: usize, indent: usize, hanging: usize };
/// Adds the link over the cells of its bytes, one span per row it covers.
fn append(allocator: std.mem.Allocator, links: *std.ArrayList(Link), positions: []const Position, uri: []const u8, start: usize) !void {
    var hash = std.hash.Wyhash.init(0);
    hash.update(uri);
    hash.update(std.mem.asBytes(&start));
    const id = hash.final();
    var at: usize = 0;
    while (at < positions.len) {
        const first = positions[at];
        const joined = at > 0;
        var last = first;
        at += 1;
        while (at < positions.len and positions[at].row == first.row) : (at += 1) last = positions[at];
        try links.append(allocator, .{ .row = first.row, .start = first.col, .end = last.end, .uri = uri, .id = id, .joined = joined });
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

// Avoid the byte-to-cell map when there cannot be a URL or image path.
// Graphemes take the full path; this only rules out single-codepoint screens.
fn hasPlainPrefix(state: *const vt.RenderState) bool {
    var matched: usize = 0;
    for (state.row_data.items(.raw), state.row_data.items(.cells)) |row, cells| {
        for (cells.items(.raw)) |cell| {
            if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
            if (cell.content_tag == .codepoint_grapheme) return true;
            const cp = cell.codepoint();
            if (cp == '/') return true;
            matched = if (cp == "http"[matched]) matched + 1 else if (cp == 'h') 1 else 0;
            if (matched == 4) return true;
        }
        if (!row.wrap) matched = 0;
    }
    return false;
}

fn webPrefix(bytes: []const u8) usize {
    return if (std.mem.startsWith(u8, bytes, "https://")) 8 else if (std.mem.startsWith(u8, bytes, "http://")) 7 else 0;
}

fn urlByte(byte: u8) bool {
    return byte > 0x20 and byte != 0x7f and std.mem.indexOfScalar(u8, "<>\"`", byte) == null;
}

// An apostrophe stays inside a word ("it's") but a quote before punctuation
// ends the URL, as in "['https://a/x','https://b/y']". One that ends its row
// may be split from its word by a wrap; trimming drops it if nothing joins.
fn closingQuote(bytes: []const u8, at: usize) bool {
    if (bytes[at] != '\'') return false;
    var next = at + 1;
    while (next < bytes.len and bytes[next] == ' ') : (next += 1) {}
    return next < bytes.len and bytes[next] != '\n' and !std.ascii.isAlphanumeric(bytes[at + 1]);
}

// Applications also wrap with CRLF or cursor moves. Require a row filled to
// within a small right margin and a continuation indented like the first row
// or its list marker's text. The continuation is one token, or one that
// visibly ends the URL before more text, as in "…%20end) to review.". An
// image path or a capitalized word keeps its own line.
fn continuation(bytes: []const u8, rows: []const Row, last: Position, after: usize, cols: usize, first: Row) ?usize {
    if (last.end + right_margin < cols or last.row + 1 >= rows.len) return null;
    const rest = rows[last.row].end;
    for (bytes[@min(after, rest)..rest]) |byte| if (byte != ' ') return null;
    const row = rows[last.row + 1];
    if (row.indent == 0 or (row.indent != first.indent and row.indent != first.hanging)) return null;
    const start = row.start + row.indent;
    if (start == row.end or !urlByte(bytes[start]) or webPrefix(bytes[start..row.end]) != 0 or imagePath(bytes, start) != null) return null;
    var end = start;
    while (end < row.end and urlByte(bytes[end])) : (end += 1) {}
    for (bytes[end..row.end]) |byte| if (byte != ' ') return if (tail(bytes[start..end])) start else null;
    return if (word(trimmed(bytes[start..end]))) null else start;
}

// A capitalized word such as "Done" or "Thanks" reads as its own line.
fn word(piece: []const u8) bool {
    if (piece.len < 2 or !std.ascii.isUpper(piece[0])) return false;
    for (piece[1..]) |byte| if (!std.ascii.isLower(byte)) return false;
    return true;
}

const right_margin = 2;

fn tail(piece: []const u8) bool {
    const kept = trimmed(piece);
    if (kept.len == piece.len) return false;
    for (kept) |byte| if (!std.ascii.isAlphabetic(byte)) return true;
    return false;
}

// The column after a short marker that opens a row, as in "⏺ ", "- " or "1. ".
fn marker(text: []const u8, positions: []const Position, indent: usize) usize {
    var end = indent;
    while (end < text.len and text[end] != ' ') : (end += 1) if (std.ascii.isAlphabetic(text[end])) return 0;
    if (end == indent or end == text.len or positions[end].col - positions[indent].col > 3) return 0;
    while (end < text.len and text[end] == ' ') : (end += 1) {}
    return if (end < text.len) positions[end].col else 0;
}

fn trimmed(bytes: []const u8) []const u8 {
    const pairs = "()[]{}";
    var open: [3]usize = @splat(0);
    var close: [3]usize = @splat(0);
    for (bytes) |byte| if (std.mem.indexOfScalar(u8, pairs, byte)) |at| {
        if (at % 2 == 0) open[at / 2] += 1 else close[at / 2] += 1;
    };
    var end = bytes.len;
    while (end > 0) {
        const last = bytes[end - 1];
        if (std.mem.indexOfScalar(u8, ".,;:!?\'", last) != null) {
            end -= 1;
            continue;
        }
        // Only closers are trimmed, so the openers counted stay before `end`.
        if (std.mem.indexOfScalar(u8, pairs, last)) |at| if (at % 2 == 1 and close[at / 2] > open[at / 2]) {
            close[at / 2] -= 1;
            end -= 1;
            continue;
        };
        break;
    }
    return bytes[0..end];
}
