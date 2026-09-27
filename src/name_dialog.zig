const std = @import("std");
const unicode = @import("ghostty-vt").unicode;
const layout = @import("layout.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;

pub const Target = union(enum) { pane: layout.PaneId, rename: layout.TabId, workspace_name: ?WorkspaceId, agent_command: usize };
pub const Result = enum { none, save, cancel };
pub const Hit = union(enum) { none, save, clear, cancel, field: usize };
pub const Dialog = struct {
    target: Target,
    text: [@max(std.fs.max_path_bytes, @import("launch_command.zig").max_length)]u8 = @splat(0),
    len: usize = 0,
    cursor: usize = 0,
    selected: bool = true,
    failed: bool = false,
    overflow: bool = false,

    pub fn init(target: Target, initial: []const u8) Dialog {
        var d: Dialog = .{ .target = target };
        d.len = @min(initial.len, if (target == .agent_command) @as(usize, @import("launch_command.zig").max_length) else 80);
        for (initial[0..d.len], 0..) |ch, i| d.text[i] = if (target == .agent_command or (ch >= 32 and ch < 127)) ch else '_';
        while (d.len > 0 and !std.unicode.utf8ValidateSlice(d.text[0..d.len])) d.len -= 1;
        d.cursor = d.len;
        return d;
    }
    pub fn name(d: *const Dialog) []const u8 {
        return std.mem.trim(u8, d.text[0..d.len], if (d.target == .agent_command) " \t\r\n" else " ");
    }
    pub fn clear(d: *Dialog) void {
        d.len = 0;
        d.cursor = 0;
        d.selected = false;
        d.failed = false;
        d.overflow = false;
    }
    pub fn typeByte(d: *Dialog, byte: u8) void {
        if (byte < 32 or (byte >= 127 and d.target != .agent_command)) return;
        d.insert(&.{byte});
    }
    pub fn pasteByte(d: *Dialog, byte: u8) void {
        if (d.target == .agent_command and (byte == '\t' or byte == '\r' or byte == '\n')) {
            d.insert(&.{byte});
        } else d.typeByte(byte);
    }
    fn insert(d: *Dialog, bytes: []const u8) void {
        if (d.selected) d.clear();
        const limit: usize = if (d.target == .agent_command) @import("launch_command.zig").max_length else 80;
        if (d.len + bytes.len > limit) {
            d.overflow = true;
            return;
        }
        std.mem.copyBackwards(u8, d.text[d.cursor + bytes.len .. d.len + bytes.len], d.text[d.cursor..d.len]);
        @memcpy(d.text[d.cursor..][0..bytes.len], bytes);
        d.len += bytes.len;
        d.cursor += bytes.len;
        d.failed = false;
    }
    pub fn key(d: *Dialog, byte: u8) Result {
        switch (byte) {
            27 => return .cancel,
            13 => return .save,
            3, 21 => d.clear(),
            1 => d.position(0),
            5 => d.position(d.len),
            8, 127 => {
                if (d.selected) d.clear() else if (d.cursor > 0) {
                    const previous_pos = d.previous();
                    const count = d.cursor - previous_pos;
                    std.mem.copyForwards(u8, d.text[previous_pos .. d.len - count], d.text[d.cursor..d.len]);
                    d.cursor = previous_pos;
                    d.len -= count;
                }
            },
            else => d.typeByte(byte),
        }
        return .none;
    }
    pub fn position(d: *Dialog, cursor: usize) void {
        d.cursor = @min(cursor, d.len);
        while (d.cursor > 0 and d.cursor < d.len and d.text[d.cursor] & 0xc0 == 0x80) d.cursor -= 1;
        d.selected = false;
    }
    fn previous(d: *const Dialog) usize {
        var pos = d.cursor -| 1;
        while (pos > 0 and d.text[pos] & 0xc0 == 0x80) pos -= 1;
        return pos;
    }
    fn next(d: *const Dialog) usize {
        if (d.cursor >= d.len) return d.len;
        return @min(d.len, d.cursor + (std.unicode.utf8ByteSequenceLength(d.text[d.cursor]) catch 1));
    }
    pub fn byteAtColumn(d: *const Dialog, start: usize, columns: usize) usize {
        var pos = start;
        var used: usize = 0;
        while (pos < d.len) {
            const n = std.unicode.utf8ByteSequenceLength(d.text[pos]) catch 1;
            if (pos + n > d.len) break;
            const cp = std.unicode.utf8Decode(d.text[pos..][0..n]) catch break;
            used += if (d.target == .agent_command and cp < 32) 1 else unicode.codepointWidth(cp);
            if (used > columns) break;
            pos += n;
        }
        return pos;
    }
    pub fn sequence(d: *Dialog, seq: []const u8) void {
        if (eq(seq, "\x1b[D") or eq(seq, "\x1bOD")) d.position(if (d.selected) 0 else d.previous()) else if (eq(seq, "\x1b[C") or eq(seq, "\x1bOC")) d.position(if (d.selected) d.len else d.next()) else if (eq(seq, "\x1b[H") or eq(seq, "\x1bOH") or eq(seq, "\x1b[1~")) d.position(0) else if (eq(seq, "\x1b[F") or eq(seq, "\x1bOF") or eq(seq, "\x1b[4~")) d.position(d.len) else if (eq(seq, "\x1b[3~")) {
            if (d.selected) d.clear() else if (d.cursor < d.len) {
                const next_pos = d.next();
                const count = next_pos - d.cursor;
                std.mem.copyForwards(u8, d.text[d.cursor .. d.len - count], d.text[next_pos..d.len]);
                d.len -= count;
            }
        }
    }
};

pub const View = struct {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    title_y: u16,
    field_y: u16,
    buttons_y: u16,
    offset: usize,
    const Button = struct { x: u16, width: u16, label: []const u8, padded: bool };
    pub fn init(width: u16, height: u16, d: Dialog) View {
        const w = @min(width, @max(10, @max(@min(width -| 2, 36), @min(width * 3 / 5, 70))));
        const h = @min(height, 7);
        const y = (height - h) / 2;
        const field_y = y + @as(u16, if (h >= 7) 3 else if (h >= 5) 2 else 1);
        var offset = d.cursor -| (w - 3);
        while (offset < d.cursor and d.text[offset] & 0xc0 == 0x80) offset += 1;
        return .{ .x = (width - w) / 2, .y = y, .width = w, .height = h, .title_y = y + @as(u16, if (h >= 5) 1 else 0), .field_y = field_y, .buttons_y = field_y + 1, .offset = offset };
    }
    fn buttons(v: View) [3]Button {
        const inner = v.width - 2;
        const full = inner >= 32;
        const compact = inner >= 23;
        const labels: [3][]const u8 = if (full) .{ "↵ save", "^C clear", "esc cancel" } else if (compact) .{ "save", "clear", "cancel" } else .{ "↵", "^C", "esc" };
        const widths: [3]u16 = if (full) .{ 8, 10, 12 } else if (compact) .{ 6, 7, 8 } else .{ 1, 2, 3 };
        var x = v.x + 1 + (inner - widths[0] - widths[1] - widths[2] - 2) / 2;
        var result: [3]Button = undefined;
        for (labels, widths, 0..) |label, w, i| {
            result[i] = .{ .x = x, .width = w, .label = label, .padded = full or compact };
            x += w + 1;
        }
        return result;
    }
    pub fn hit(v: View, x: u16, y: u16) Hit {
        if (x < v.x or x >= v.x + v.width or y < v.y or y >= v.y + v.height) return .cancel;
        if (y == v.field_y and x > v.x and x < v.x + v.width - 1) return .{ .field = v.offset + x - v.x - 1 };
        if (y == v.buttons_y) for (v.buttons(), 0..) |b, i| {
            if (x >= b.x and x < b.x + b.width) return switch (i) {
                0 => .save,
                1 => .clear,
                else => .cancel,
            };
        };
        return .none;
    }
    pub fn draw(v: View, d: Dialog, w: *std.Io.Writer, number: usize) !void {
        const panel = "\x1b[0;38;2;205;214;244;48;2;24;24;37m";
        const border = "\x1b[0;38;2;137;180;250;48;2;24;24;37m";
        for (0..v.height) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 1, v.x + 1, border });
            if (row == 0 or row + 1 == v.height) {
                try w.writeAll(if (row == 0) "┌" else "└");
                for (0..v.width - 2) |_| try w.writeAll("─");
                try w.writeAll(if (row == 0) "┐" else "┘");
            } else {
                try w.writeAll("│");
                try w.writeAll(panel);
                try w.splatByteAll(' ', v.width - 2);
                try w.writeAll(border);
                try w.writeAll("│");
            }
        }
        const title = switch (d.target) {
            .agent_command => "Agent launch command",
            .rename => "rename tab",
            .pane => "rename pane",
            .workspace_name => |id| if (id == null) "new workspace: name" else "edit workspace: name",
        };
        try w.print("\x1b[{d};{d}H{s}\x1b[1m{s}", .{ v.title_y + 1, v.x + 2, panel, title[0..@min(title.len, v.width - 2)] });
        if ((d.failed or d.overflow) and v.height >= 7) {
            const msg = if (d.target == .agent_command) "Could not save command; max 2048 bytes." else "Could not save. Check folder or capacity.";
            try w.print("\x1b[{d};{d}H{s}\x1b[38;2;243;139;168m{s}", .{ v.title_y + 2, v.x + 2, panel, msg[0..@min(msg.len, v.width - 2)] });
        }
        if (d.target == .agent_command and !d.failed and !d.overflow and v.height >= 7) {
            var hint: [160]u8 = undefined;
            const launch = @import("launch_command.zig");
            const provider = launch.identify(d.name());
            const text = try std.fmt.bufPrint(&hint, "{s} · {s} · empty saves delete", .{ std.fs.path.basename(launch.shell()), if (provider) |known| @tagName(known) else "resolved at launch" });
            try w.print("\x1b[{d};{d}H{s}", .{ v.title_y + 2, v.x + 2, panel });
            try @import("sidebar.zig").writeEllipsis(w, text, v.width - 2);
        }
        try w.print("\x1b[{d};{d}H\x1b[0;38;2;205;214;244;48;2;49;50;68m", .{ v.field_y + 1, v.x + 2 });
        try w.splatByteAll(' ', v.width - 2);
        try w.print("\x1b[{d};{d}H", .{ v.field_y + 1, v.x + 2 });
        if (d.len == 0 and d.target != .pane and d.target != .agent_command) {
            // This is a preview of the current position, never an editable/saved name.
            try w.print("\x1b[38;2;125;132;143m{d}", .{number});
        } else {
            if (d.selected) try w.writeAll("\x1b[38;2;24;27;32;48;2;137;180;250m");
            const end = d.byteAtColumn(v.offset, v.width - 2);
            for (d.text[v.offset..end]) |byte| try w.writeByte(if (d.target == .agent_command and byte < 32) ' ' else byte);
        }
        for (v.buttons(), 0..) |b, i| {
            try w.print("\x1b[{d};{d}H{s}", .{ v.buttons_y + 1, b.x + 1, if (i == 0) "\x1b[1;38;2;24;27;32;48;2;137;180;250m" else "\x1b[1;38;2;205;214;244;48;2;49;50;68m" });
            if (b.padded) try w.writeByte(' ');
            try w.writeAll(b.label);
            if (b.padded) try w.writeByte(' ');
        }
        var cursor_width: usize = 0;
        var it = (try std.unicode.Utf8View.init(d.text[v.offset..d.cursor])).iterator();
        while (it.nextCodepoint()) |cp| cursor_width += if (d.target == .agent_command and cp < 32) 1 else unicode.codepointWidth(cp);
        try w.print("\x1b[0m\x1b[{d};{d}H\x1b[?25h", .{ v.field_y + 1, v.x + 2 + cursor_width });
    }
};
fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}

test "name editing supports selection, insertion, cursor movement and clear" {
    var d = Dialog.init(.{ .rename = @enumFromInt(1) }, "original");
    _ = d.key('a');
    _ = d.key('c');
    d.sequence("\x1b[D");
    _ = d.key('b');
    try std.testing.expectEqualStrings("abc", d.name());
    d.sequence("\x1b[3~");
    try std.testing.expectEqualStrings("ab", d.name());
    _ = d.key(127);
    try std.testing.expectEqualStrings("a", d.name());
    _ = d.key(3);
    try std.testing.expectEqual(@as(usize, 0), d.len);
    try std.testing.expectEqualStrings("", d.name());
}

test "agent command editor preserves long pasted shell source" {
    var d = Dialog.init(.{ .agent_command = 0 }, "old");
    const source = "FOO='two words' \nmyagent --whatever 'quoted argument' ";
    for (source) |byte| d.pasteByte(byte);
    for (0..100) |_| d.pasteByte('x');
    try std.testing.expect(d.len > 80);
    try std.testing.expect(std.mem.startsWith(u8, d.name(), source));
    const edited = Dialog.init(.{ .agent_command = 0 }, d.name());
    try std.testing.expectEqualStrings(d.name(), edited.name());
    for (0..2048) |_| d.pasteByte('x');
    try std.testing.expect(d.overflow);
}
