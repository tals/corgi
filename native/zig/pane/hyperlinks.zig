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

// Map UTF-8 bytes back to actual cells. Explicit OSC 8 cells and concealed
// text are barriers: their targets must win.
fn detectPlain(allocator: std.mem.Allocator, state: *const vt.RenderState, links: *std.ArrayList(Link)) !void {
    var scratch: std.heap.ArenaAllocator = .init(a);
    defer scratch.deinit();
    const temporary = scratch.allocator();
    var text: std.ArrayList(u8) = .empty;
    var positions: std.ArrayList(Position) = .empty;
    var rows: std.ArrayList(Row) = .empty;
    for (state.row_data.items(.raw), state.row_data.items(.cells), 0..) |row, cells, y| {
        const start = text.items.len;
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
        var indent = start;
        while (indent < text.items.len and text.items[indent] == ' ') : (indent += 1) {}
        try rows.append(temporary, .{ .start = start, .end = text.items.len, .indent = indent - start });
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
            i += 1;
            continue;
        }
        candidate.clearRetainingCapacity();
        mapped.clearRetainingCapacity();
        const indent = rows.items[positions.items[i].row].indent;
        var end = i;
        while (end < bytes.len) {
            if (urlByte(bytes[end])) {
                try candidate.append(temporary, bytes[end]);
                try mapped.append(temporary, positions.items[end]);
                end += 1;
                continue;
            }
            const suffix = candidate.items[trimmed(candidate.items).len..];
            if (mapped.items.len > prefix and std.mem.indexOfAny(u8, suffix, ")]}") == null) {
                if (continuation(bytes, rows.items, mapped.items[mapped.items.len - 1], state.cols, indent)) |next| {
                    end = next;
                    continue;
                }
            }
            break;
        }
        const uri_text = trimmed(candidate.items);
        if (uri_text.len > prefix and uri_text[prefix] != '/' and safeUri(uri_text)) {
            const uri = try allocator.dupe(u8, uri_text);
            var hash = std.hash.Wyhash.init(0);
            hash.update(uri);
            hash.update(std.mem.asBytes(&i));
            const id = hash.final();
            var at: usize = 0;
            while (at < uri.len) {
                const first = mapped.items[at];
                var last = first;
                at += 1;
                while (at < uri.len and mapped.items[at].row == first.row) : (at += 1) last = mapped.items[at];
                try links.append(allocator, .{ .row = first.row, .start = first.col, .end = last.end, .uri = uri, .id = id });
            }
        }
        i = end;
    }
}

const Position = struct { row: usize, col: usize, end: usize };
const Row = struct { start: usize, end: usize, indent: usize };

fn webPrefix(bytes: []const u8) usize {
    return if (std.mem.startsWith(u8, bytes, "https://")) 8 else if (std.mem.startsWith(u8, bytes, "http://")) 7 else 0;
}

fn urlByte(byte: u8) bool {
    return byte > 0x20 and byte != 0x7f and std.mem.indexOfScalar(u8, "<>\"`", byte) == null;
}

// Applications also wrap with CRLF or cursor moves. Require a full row,
// matching nonzero indentation, and a continuation containing only one token.
fn continuation(bytes: []const u8, rows: []const Row, last: Position, cols: usize, indent: usize) ?usize {
    if (last.end != cols or indent == 0 or last.row + 1 >= rows.len) return null;
    const row = rows[last.row + 1];
    if (row.indent != indent or row.start + indent == row.end) return null;
    const start = row.start + indent;
    if (!urlByte(bytes[start]) or webPrefix(bytes[start..row.end]) != 0) return null;
    var end = start;
    while (end < row.end and urlByte(bytes[end])) : (end += 1) {}
    for (bytes[end..row.end]) |byte| if (byte != ' ') return null;
    return start;
}

fn trimmed(bytes: []const u8) []const u8 {
    var end = bytes.len;
    while (end > 0) {
        const last = bytes[end - 1];
        if (std.mem.indexOfScalar(u8, ".,;:!?\'", last) != null) {
            end -= 1;
            continue;
        }
        const opening: ?u8 = switch (last) {
            ')' => '(',
            ']' => '[',
            '}' => '{',
            else => null,
        };
        if (opening) |open| {
            if (std.mem.count(u8, bytes[0..end], &.{last}) > std.mem.count(u8, bytes[0..end], &.{open})) {
                end -= 1;
                continue;
            }
        }
        break;
    }
    return bytes[0..end];
}
