const std = @import("std");
const unicode = @import("ghostty-vt").unicode;
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const keys = @import("keys.zig");
const launch_command = @import("launch.zig").command;
const sidebar = @import("sidebar.zig");
const palette = @import("palette.zig");
const fork_motion = @import("fork_motion.zig");
const clock = @import("clock.zig");

pub const Target = union(enum) {
    pane: layout.PaneId,
    rename: layout.TabId,
    workspace_name: ?WorkspaceId,
    agent_command: usize,
    /// The conversation an agent pane shows, named in its agent's own records.
    agent: layout.PaneId,
    /// The name a copy of an agent pane's conversation starts with.
    fork: layout.PaneId,

    /// Whether names keep non-ASCII text, which the agents' own names carry.
    fn unicode(t: Target) bool {
        return t == .agent_command or t == .agent or t == .fork;
    }
};
pub const Result = enum { none, save, cancel };
/// The longest name, in bytes, outside launch commands.
pub const name_limit = 80;
pub const Hit = union(enum) { none, save, clear, cancel, field: usize };
pub const Dialog = struct {
    target: Target,
    text: [@max(std.fs.max_path_bytes, launch_command.max_length)]u8 = @splat(0),
    len: usize = 0,
    cursor: usize = 0,
    selected: bool = true,
    failed: bool = false,
    overflow: bool = false,
    /// The fork card's hero.
    hero: fork_motion.Hero = .{},

    pub fn init(target: Target, initial: []const u8) Dialog {
        var d: Dialog = .{ .target = target };
        d.len = @min(initial.len, if (target == .agent_command) @as(usize, launch_command.max_length) else name_limit);
        for (initial[0..d.len], 0..) |ch, i| d.text[i] = if (target.unicode() or (ch >= 32 and ch < 127)) ch else '_';
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
        if (byte < 32 or (byte >= 127 and !d.target.unicode())) return;
        d.insert(&.{byte});
    }
    pub fn pasteByte(d: *Dialog, byte: u8) void {
        if (d.target == .agent_command and (byte == '\t' or byte == '\r' or byte == '\n')) {
            d.insert(&.{byte});
        } else d.typeByte(byte);
    }
    fn insert(d: *Dialog, bytes: []const u8) void {
        if (d.selected) d.clear();
        const limit: usize = if (d.target == .agent_command) launch_command.max_length else name_limit;
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
        switch (keys.parse(seq) orelse return) {
            .left => d.position(if (d.selected) 0 else d.previous()),
            .right => d.position(if (d.selected) d.len else d.next()),
            .home => d.position(0),
            .end => d.position(d.len),
            .delete => if (d.selected) d.clear() else if (d.cursor < d.len) {
                const next_pos = d.next();
                const count = next_pos - d.cursor;
                std.mem.copyForwards(u8, d.text[d.cursor .. d.len - count], d.text[next_pos..d.len]);
                d.len -= count;
            },
            else => {},
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
    /// Where the text starts and how many columns of it show; the field's
    /// fill reaches one column past each side when `padded`.
    text_x: u16,
    text_width: u16,
    padded: bool = false,
    /// The first button forks instead of saving.
    fork: bool = false,
    /// The fork card's roomier rows, when the screen has space for them.
    card: ?Card = null,
    const Card = struct { hero_y: ?u16, subtitle_y: u16, label_y: u16 };
    const Button = struct { x: u16, width: u16, label: []const u8, padded: bool };
    pub fn init(width: u16, height: u16, d: Dialog) View {
        if (d.target == .fork) if (forkCard(width, height, d)) |v| return v;
        const w = @min(width, @max(10, @max(@min(width -| 2, 36), @min(width * 3 / 5, 70))));
        const h = @min(height, 7);
        const y = (height - h) / 2;
        const field_y = y + @as(u16, if (h >= 7) 3 else if (h >= 5) 2 else 1);
        const x = (width - w) / 2;
        return .{ .x = x, .y = y, .width = w, .height = h, .title_y = y + @as(u16, if (h >= 5) 1 else 0), .field_y = field_y, .buttons_y = field_y + 1, .offset = scroll(d, w - 2), .text_x = x + 1, .text_width = w - 2, .fork = d.target == .fork };
    }
    /// The first byte that shows, keeping the cursor inside `columns`.
    fn scroll(d: Dialog, columns: u16) usize {
        var offset = d.cursor -| (columns -| 1);
        while (offset < d.cursor and d.text[offset] & 0xc0 == 0x80) offset += 1;
        return offset;
    }
    /// The fork card: a hero, a title and its subtitle, a labelled field and
    /// the buttons, with room around each. Without space for the hero it
    /// leaves it out; without space for the rest, the plain dialog is used.
    fn forkCard(width: u16, height: u16, d: Dialog) ?View {
        const w = @min(width -| 6, 72);
        const hero = height >= 21;
        const h: u16 = if (hero) 19 else 15;
        if (w < 46 or height < h + 2) return null;
        const x = (width - w) / 2;
        const y = (height - h) / 2;
        const top: u16 = if (hero) 6 else 2;
        return .{
            .x = x,
            .y = y,
            .width = w,
            .height = h,
            .title_y = y + top,
            // The field and the buttons are three rows tall; these are their middles.
            .field_y = y + top + 5,
            .buttons_y = y + top + 9,
            .offset = scroll(d, w - 10),
            .text_x = x + 5,
            .text_width = w - 10,
            .padded = true,
            .fork = true,
            .card = .{ .hero_y = if (hero) y + 2 else null, .subtitle_y = y + top + 1, .label_y = y + top + 3 },
        };
    }
    /// The fork card's buttons, centered: the call to action, clear and
    /// cancel, each padded as wide as the card allows.
    fn cardButtons(v: View) [3]Button {
        const labels = [3][]const u8{ "↵ Create Fork", "^C Clear", "esc Cancel" };
        const lengths = card_label_widths;
        const gap = 2;
        const inner = v.width - 2;
        var pad: u16 = 3;
        while (pad > 1 and lengths[0] + lengths[1] + lengths[2] + 6 * pad + 2 * gap > inner) pad -= 1;
        const total = lengths[0] + lengths[1] + lengths[2] + 6 * pad + 2 * gap;
        var x = v.x + 1 + (inner -| total) / 2;
        var result: [3]Button = undefined;
        for (labels, lengths, 0..) |label, len, i| {
            result[i] = .{ .x = x, .width = len + 2 * pad, .label = label, .padded = true };
            x += len + 2 * pad + gap;
        }
        return result;
    }
    fn buttons(v: View) [3]Button {
        const inner = v.width - 2;
        const full = inner >= 32;
        const compact = inner >= 23;
        const labels: [3][]const u8 = if (full)
            .{ if (v.fork) "↵ fork" else "↵ save", "^C clear", "esc cancel" }
        else if (compact)
            .{ if (v.fork) "fork" else "save", "clear", "cancel" }
        else
            .{ "↵", "^C", "esc" };
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
        if (v.card != null) {
            // The field and the buttons are three rows tall, padded around.
            if (y + 1 >= v.field_y and y <= v.field_y + 1 and x + 2 >= v.text_x and x < v.text_x + v.text_width + 2) return .{ .field = v.offset + (x -| v.text_x) };
            if (y + 1 >= v.buttons_y and y <= v.buttons_y + 1) for (v.cardButtons(), 0..) |b, i| {
                if (x >= b.x and x < b.x + b.width) return switch (i) {
                    0 => .save,
                    1 => .clear,
                    else => .cancel,
                };
            };
            return .none;
        }
        if (y == v.field_y and x >= v.text_x and x < v.text_x + v.text_width) return .{ .field = v.offset + (x - v.text_x) };
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
        if (v.card) |card| return v.drawCard(card, d, w);
        const panel = (palette.Style{ .fg = .text, .bg = .surface }).sgr();
        const border = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
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
            .agent => "rename agent",
            .fork => "Fork this agent",
            .workspace_name => |id| if (id == null) "new workspace: name" else "edit workspace: name",
        };
        try w.print("\x1b[{d};{d}H{s}\x1b[1m" ++ palette.fg(.strong) ++ "{s}", .{ v.title_y + 1, v.x + 2, panel, title[0..@min(title.len, v.width - 2)] });
        if ((d.failed or d.overflow) and v.height >= 7) {
            const msg = if (d.target == .agent_command) "Could not save command; max 2048 bytes." else "Could not save. Check folder or capacity.";
            try w.print("\x1b[{d};{d}H{s}" ++ palette.fg(.hot) ++ "{s}", .{ v.title_y + 2, v.x + 2, panel, msg[0..@min(msg.len, v.width - 2)] });
        }
        if (d.target == .agent_command and !d.failed and !d.overflow and v.height >= 7) {
            var hint: [160]u8 = undefined;
            const launch = launch_command;
            const provider = launch.identify(d.name());
            const text = try std.fmt.bufPrint(&hint, "{s} · {s} · empty saves delete", .{ std.fs.path.basename(launch.shell()), if (provider) |known| @tagName(known) else "resolved at launch" });
            try w.print("\x1b[{d};{d}H{s}", .{ v.title_y + 2, v.x + 2, panel });
            try sidebar.writeEllipsis(w, text, v.width - 2);
        }
        try w.print("\x1b[{d};{d}H" ++ (palette.Style{ .fg = .text, .bg = .selected }).sgr(), .{ v.field_y + 1, v.text_x + 1 });
        try w.splatByteAll(' ', v.text_width);
        try w.print("\x1b[{d};{d}H", .{ v.field_y + 1, v.text_x + 1 });
        if (d.len == 0 and d.target != .pane and d.target != .agent_command and d.target != .agent and d.target != .fork) {
            // This is a preview of the current position, never an editable/saved name.
            try w.print(palette.fg(.muted) ++ "{d}", .{number});
        } else {
            if (d.selected) try w.writeAll("\x1b[7m");
            const end = d.byteAtColumn(v.offset, v.text_width);
            for (d.text[v.offset..end]) |byte| try w.writeByte(if (d.target == .agent_command and byte < 32) ' ' else byte);
        }
        for (v.buttons(), 0..) |b, i| {
            const style = if (i == 0) (palette.Style{ .fg = .strong, .bg = .selected, .bold = true }).sgr() else (palette.Style{ .fg = .text, .bg = .selected, .bold = true }).sgr();
            try w.print("\x1b[{d};{d}H{s}", .{ v.buttons_y + 1, b.x + 1, style });
            if (b.padded) try w.writeByte(' ');
            try w.writeAll(b.label);
            if (b.padded) try w.writeByte(' ');
        }
        try v.placeCursor(d, w);
    }
    fn placeCursor(v: View, d: Dialog, w: *std.Io.Writer) !void {
        var cursor_width: usize = 0;
        var it = (try std.unicode.Utf8View.init(d.text[v.offset..d.cursor])).iterator();
        while (it.nextCodepoint()) |cp| cursor_width += if (d.target == .agent_command and cp < 32) 1 else unicode.codepointWidth(cp);
        try w.print("\x1b[0m\x1b[{d};{d}H\x1b[?25h", .{ v.field_y + 1, v.text_x + 1 + cursor_width });
    }
    fn drawCard(v: View, card: Card, d: Dialog, w: *std.Io.Writer) !void {
        const panel = comptime (palette.Style{ .fg = .text, .bg = .surface }).sgr();
        const border = comptime (palette.Style{ .fg = .line, .bg = .surface }).sgr();
        for (0..v.height) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ v.y + row + 1, v.x + 1, border });
            if (row == 0 or row + 1 == v.height) {
                try w.writeAll(if (row == 0) "╭" else "╰");
                for (0..v.width - 2) |_| try w.writeAll("─");
                try w.writeAll(if (row == 0) "╮" else "╯");
            } else {
                try w.writeAll("│" ++ panel);
                try w.splatByteAll(' ', v.width - 2);
                try w.writeAll(border ++ "│");
            }
        }
        if (card.hero_y) |y| try fork_motion.draw(w, v.x + (v.width - fork_motion.width) / 2, y, d.hero, clock.milliTimestamp());
        try v.centered(w, v.title_y, comptime (palette.Style{ .fg = .strong, .bg = .surface, .bold = true }).sgr(), "Fork this agent");
        if (d.overflow)
            try v.centered(w, card.subtitle_y, comptime (palette.Style{ .fg = .hot, .bg = .surface }).sgr(), "Names fit in 80 characters")
        else
            try v.centered(w, card.subtitle_y, comptime (palette.Style{ .fg = .muted, .bg = .surface }).sgr(), "Copies the conversation into a new tab");
        try w.print("\x1b[{d};{d}H" ++ (palette.Style{ .fg = .faint, .bg = .surface }).sgr() ++ "Name", .{ card.label_y + 1, v.text_x - 1 });
        // A field three rows tall, with two columns of fill beside the text.
        for (0..3) |row| {
            try w.print("\x1b[{d};{d}H" ++ (palette.Style{ .fg = .text, .bg = .selected }).sgr(), .{ v.field_y + row, v.text_x - 1 });
            try w.splatByteAll(' ', v.text_width + 4);
        }
        try w.print("\x1b[{d};{d}H{s}", .{ v.field_y + 1, v.text_x + 1, if (d.selected) selection else "" });
        try w.writeAll(d.text[v.offset..d.byteAtColumn(v.offset, v.text_width)]);
        for (v.cardButtons(), 0..) |b, i| {
            const fill = if (i == 0) create_fill else (palette.Style{ .bg = .selected }).sgr();
            for (0..3) |row| {
                try w.print("\x1b[{d};{d}H{s}", .{ v.buttons_y + row, b.x + 1, fill });
                try w.splatByteAll(' ', b.width);
            }
            const key_end = std.mem.indexOfScalar(u8, b.label, ' ').?;
            const pad = (b.width - card_label_widths[i]) / 2;
            try w.print("\x1b[{d};{d}H", .{ v.buttons_y + 1, b.x + 1 + pad });
            if (i == 0) {
                try w.writeAll(create_label ++ "↵ Create Fork");
            } else {
                try w.print((palette.Style{ .fg = .muted, .bg = .selected }).sgr() ++ "{s}" ++ (palette.Style{ .fg = .text, .bg = .selected, .bold = true }).sgr() ++ "{s}", .{ b.label[0..key_end], b.label[key_end..] });
            }
        }
        try v.placeCursor(d, w);
    }
    /// `text`, ASCII, centered on row `y`.
    fn centered(v: View, w: *std.Io.Writer, y: u16, style: []const u8, text: []const u8) !void {
        const shown = text[0..@min(text.len, v.width - 4)];
        try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 1, v.x + (v.width - shown.len) / 2 + 1, style, shown });
    }
};

/// How many columns each fork card button's label takes.
const card_label_widths = [3]u16{ 13, 8, 10 };
/// The fork card's selected name and call to action: tints of the accent, not
/// its full strength, so neither glares on the panel.
const selection = palette.fgRgb(palette.Token.strong.rgb()) ++ palette.bgRgb(palette.mix(palette.Token.selected.rgb(), palette.Token.accent.rgb(), 30));
const create_fill = "\x1b[0m" ++ palette.bgRgb(palette.mix(palette.Token.surface.rgb(), palette.Token.accent.rgb(), 22));
const create_label = create_fill ++ "\x1b[1m" ++ palette.fgRgb(palette.Token.accent.rgb());

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

test "the fork card is roomy where it fits and plain where it doesn't" {
    const d = Dialog.init(.{ .fork = @enumFromInt(1) }, "refactor (fork)");
    // The name starts selected: typing replaces it.
    try std.testing.expect(d.selected);
    const v = View.init(120, 40, d);
    try std.testing.expect(v.card != null and v.card.?.hero_y != null);
    try std.testing.expectEqual(@as(u16, 72), v.width);
    const create, const clear, const cancel = v.cardButtons();
    // The buttons answer on all three of their rows.
    for ([_]u16{ v.buttons_y - 1, v.buttons_y, v.buttons_y + 1 }) |y| {
        try std.testing.expectEqual(Hit.save, v.hit(create.x, y));
        try std.testing.expectEqual(Hit.clear, v.hit(clear.x + clear.width - 1, y));
        try std.testing.expectEqual(Hit.cancel, v.hit(cancel.x, y));
    }
    try std.testing.expectEqual(Hit{ .field = 0 }, v.hit(v.text_x - 2, v.field_y - 1));
    try std.testing.expectEqual(Hit.none, v.hit(v.text_x, v.field_y - 3));
    try std.testing.expectEqual(Hit.cancel, v.hit(0, 0));
    // Without room for the hero it goes; without room for the card, the
    // plain dialog takes over.
    try std.testing.expect(View.init(120, 18, d).card.?.hero_y == null);
    try std.testing.expect(View.init(40, 40, d).card == null);
    try std.testing.expect(View.init(120, 12, d).card == null);

    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try v.draw(d, &out.writer, 0);
    for ([_][]const u8{ "Fork this agent", "Create Fork", "^C", "Clear", "Cancel", "┤", "●", selection ++ "refactor (fork)" }) |text| {
        try std.testing.expect(std.mem.indexOf(u8, out.written(), text) != null);
    }
}
