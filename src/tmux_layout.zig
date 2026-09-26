//! Pane rectangles from tmux's saved (unzoomed) window_layout string.
const std = @import("std");
const layout = @import("layout.zig");

pub const Geometry = struct {
    panes: [layout.max_panes]struct { id: u32, rect: layout.Rect } = undefined,
    count: usize = 0,

    pub fn find(self: *const Geometry, id: []const u8) ?layout.Rect {
        if (id.len < 2 or id[0] != '%') return null;
        const number = std.fmt.parseInt(u32, id[1..], 10) catch return null;
        for (self.panes[0..self.count]) |pane| if (pane.id == number) return pane.rect;
        return null;
    }
};

pub fn parse(text: []const u8) !Geometry {
    if (text.len < 6 or text[4] != ',') return error.InvalidTmuxLayout;
    const expected = std.fmt.parseInt(u16, text[0..4], 16) catch return error.InvalidTmuxLayout;
    if (expected != checksum(text[5..])) return error.InvalidTmuxLayout;
    var parser = Parser{ .text = text[5..] };
    try parser.cell(0);
    if (parser.pos != parser.text.len) return error.InvalidTmuxLayout;
    return parser.geometry;
}

fn checksum(text: []const u8) u16 {
    var sum: u16 = 0;
    for (text) |byte| sum = ((sum >> 1) | (sum << 15)) +% byte;
    return sum;
}

const Parser = struct {
    text: []const u8,
    pos: usize = 0,
    geometry: Geometry = .{},

    fn take(self: *Parser, char: u8) bool {
        if (self.pos == self.text.len or self.text[self.pos] != char) return false;
        self.pos += 1;
        return true;
    }

    fn expect(self: *Parser, char: u8) !void {
        if (!self.take(char)) return error.InvalidTmuxLayout;
    }

    fn number(self: *Parser, comptime T: type) !T {
        const start = self.pos;
        while (self.pos < self.text.len and std.ascii.isDigit(self.text[self.pos])) self.pos += 1;
        return std.fmt.parseInt(T, self.text[start..self.pos], 10) catch error.InvalidTmuxLayout;
    }

    fn cell(self: *Parser, depth: usize) error{ InvalidTmuxLayout, TooManyPanes }!void {
        if (depth >= layout.max_panes) return error.InvalidTmuxLayout;
        const w = try self.number(u16);
        try self.expect('x');
        const h = try self.number(u16);
        try self.expect(',');
        const x = try self.number(u16);
        try self.expect(',');
        const y = try self.number(u16);
        if (w == 0 or h == 0) return error.InvalidTmuxLayout;
        const close: ?u8 = if (self.take('{')) '}' else if (self.take('[')) ']' else null;
        if (close) |char| {
            try self.cell(depth + 1);
            while (self.take(',')) try self.cell(depth + 1);
            try self.expect(char);
        } else {
            try self.expect(',');
            const id = try self.number(u32);
            if (self.geometry.count == self.geometry.panes.len) return error.TooManyPanes;
            for (self.geometry.panes[0..self.geometry.count]) |pane| if (pane.id == id) return error.InvalidTmuxLayout;
            self.geometry.panes[self.geometry.count] = .{ .id = id, .rect = .{ .x = x, .y = y, .w = w, .h = h } };
            self.geometry.count += 1;
        }
    }
};

fn fixture(body: []const u8, buf: []u8) ![]const u8 {
    return std.fmt.bufPrint(buf, "{x:0>4},{s}", .{ checksum(body), body });
}

test "tmux saved layout preserves nested panes by id, not listing order" {
    var buf: [512]u8 = undefined;
    const geometry = try parse(try fixture("120x40,0,0{59x40,0,0,12,60x40,60,0[60x19,60,0,3,60x20,60,20,27]}", &buf));
    try std.testing.expectEqual(@as(usize, 3), geometry.count);
    try std.testing.expectEqual(layout.Rect{ .x = 0, .y = 0, .w = 59, .h = 40 }, geometry.find("%12").?);
    try std.testing.expectEqual(layout.Rect{ .x = 60, .y = 0, .w = 60, .h = 19 }, geometry.find("%3").?);
    try std.testing.expectEqual(layout.Rect{ .x = 60, .y = 20, .w = 60, .h = 20 }, geometry.find("%27").?);
    try std.testing.expect(geometry.find("%1") == null);
}

test "tmux layouts allow single panes and multiple siblings" {
    var buf: [512]u8 = undefined;
    const single = try parse(try fixture("80x24,0,0,42", &buf));
    try std.testing.expectEqual(@as(usize, 1), single.count);
    const siblings = try parse(try fixture("122x24,0,0{40x24,0,0,1,40x24,41,0,2,40x24,82,0,3}", &buf));
    try std.testing.expectEqual(@as(usize, 3), siblings.count);
    try std.testing.expectEqual(@as(u16, 82), siblings.find("%3").?.x);
}

test "tmux layouts reject malformed or incomplete snapshots" {
    var buf: [512]u8 = undefined;
    for ([_][]const u8{
        "80x24,0,0", // Missing pane id.
        "80x24,0,0{39x24,0,0,1,40x24,40,0,2]", // Mismatched container.
        "80x24,0,0{39x24,0,0,1,40x24,40,0,1}", // Duplicate pane id.
        "80x24,0,0,1trailing",
        "65536x24,0,0,1",
        "0x24,0,0,1",
    }) |body| try std.testing.expectError(error.InvalidTmuxLayout, parse(try fixture(body, &buf)));
    const text = try fixture("80x24,0,0,1", &buf);
    buf[0] = if (buf[0] == '0') '1' else '0';
    try std.testing.expectError(error.InvalidTmuxLayout, parse(text));
}
