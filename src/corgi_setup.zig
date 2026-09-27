//! Setup modal opened from the corgi badge (or Ctrl-B i), centered on screen.
//! Viewer-owned; applying a choice sends `inference.configure` to the daemon.
const std = @import("std");
const setup = @import("inference_setup.zig");
const sidebar = @import("sidebar.zig");
const Rect = @import("layout.zig").Rect;
pub const Choice = enum {
    auto,
    codex,
    claude,
    off,
    ghostty,
    keyboard,
    import,

    pub fn provider(choice: Choice) ?Provider {
        return std.meta.stringToEnum(Provider, @tagName(choice));
    }
    fn summarizer(choice: Choice) bool {
        return @intFromEnum(choice) <= @intFromEnum(Choice.off);
    }
};
const ghostty = @import("ghostty_integration.zig");
const km = @import("keymap.zig");

const providers = @import("providers.zig");
const Provider = providers.Provider;

/// Rows inside the frame, top to bottom. Drawing and hit testing both walk
/// this table; short terminals drop the spacers.
const Line = union(enum) {
    spacer,
    heading: []const u8,
    /// Dim text aligned with headings.
    lead: []const u8,
    /// Dim text aligned with row labels.
    hint: []const u8,
    option: Choice,
    /// Requirements or status for the highlighted (or current) summarizer.
    detail,
    divider,
    footer,
};
const lines = [_]Line{
    .spacer,
    .{ .heading = "Activity summaries" },
    .{ .lead = "Who writes activity summaries and link names?" },
    .spacer,
    .{ .option = .auto },
    .{ .option = .codex },
    .{ .option = .claude },
    .{ .option = .off },
    .detail,
    .spacer,
    .{ .heading = "Ghostty" },
    .{ .option = .ghostty },
    .{ .hint = "Cmd+1-9, Cmd+T/W, Ctrl+Tab / Ctrl+Shift+Tab" },
    .{ .hint = "Every Ghostty window · reload with Cmd+Shift+," },
    .spacer,
    .{ .heading = "Shortcuts & import" },
    .{ .option = .keyboard },
    .{ .option = .import },
    .{ .hint = "Bring in sessions from other terminal multiplexers" },
    .spacer,
    .divider,
    .footer,
};
const spacers = blk: {
    var n = 0;
    for (lines) |line| n += @intFromBool(line == .spacer);
    break :blk n;
};
const full_height = lines.len + 2;
const compact_height = full_height - spacers;
const max_width = 64;
const min_width = 48;

fn compact(rows: u16) bool {
    return rows < full_height;
}
/// The line on `offset` rows below the top border.
fn lineAt(rows: u16, offset: usize) ?Line {
    var n: usize = 0;
    for (lines) |line| {
        if (compact(rows) and line == .spacer) continue;
        if (n == offset) return line;
        n += 1;
    }
    return null;
}
fn usable(b: Rect) bool {
    return b.w >= min_width and b.h >= compact_height;
}

const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
const text = "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
const bright = "\x1b[1;38;2;226;230;233;48;2;35;40;47m";
const mint = "\x1b[0;38;2;161;194;178;48;2;35;40;47m";
const heading = "\x1b[1;38;2;161;194;178;48;2;35;40;47m";
const yellow = "\x1b[0;38;2;232;190;115;48;2;35;40;47m";
const keycap = "\x1b[1;38;2;24;27;32;48;2;161;194;178m";
const Row = struct { text: []const u8, label: []const u8, accent: []const u8, quiet: []const u8, warn: []const u8 };
const row_normal: Row = .{ .text = text, .label = text, .accent = mint, .quiet = panel, .warn = yellow };
const row_selected: Row = .{
    .text = "\x1b[0;38;2;201;224;211;48;2;47;64;59m",
    .label = "\x1b[1;38;2;226;230;233;48;2;47;64;59m",
    .accent = "\x1b[0;38;2;161;194;178;48;2;47;64;59m",
    .quiet = "\x1b[0;38;2;112;124;135;48;2;47;64;59m",
    .warn = "\x1b[0;38;2;232;190;115;48;2;47;64;59m",
};
const shadow = "\x1b[0;48;2;12;14;17m";
// Columns inside the frame, counted from its left border.
const marker_x = 3;
const label_x = 5;
const summary_x = 17;

pub const Menu = struct {
    selected: Choice,
    integration: ghostty.State = .unavailable,
    preset: km.Preset = .corgi,
    prefix: km.Prefix = .ctrl_b,

    pub fn open(status: setup.Status) Menu {
        return .{ .selected = @enumFromInt(@intFromEnum(status.choice)) };
    }
    pub fn bounds(cols: u16, rows: u16) Rect {
        const w = @min(cols, max_width);
        const h: u16 = @min(rows, if (compact(rows)) compact_height else full_height);
        return .{ .x = (cols - w) / 2, .y = (rows - h) / 2, .w = w, .h = h };
    }
    pub fn contains(cols: u16, rows: u16, x: u16, y: u16) bool {
        return bounds(cols, rows).contains(x, y);
    }
    pub fn hit(cols: u16, rows: u16, x: u16, y: u16) ?Choice {
        const b = bounds(cols, rows);
        if (!usable(b) or x <= b.x or x >= b.x + b.w - 1 or y <= b.y) return null;
        return switch (lineAt(rows, y - b.y - 1) orelse return null) {
            .option => |choice| choice,
            else => null,
        };
    }
    pub fn move(m: *Menu, next: bool) void {
        const index: usize = @intFromEnum(m.selected);
        m.selected = @enumFromInt(if (next) @min(index + 1, @intFromEnum(Choice.import)) else index -| 1);
    }
    pub fn draw(m: *const Menu, w: *std.Io.Writer, status: setup.Status, cols: u16, rows: u16) !void {
        const b = bounds(cols, rows);
        if (!usable(b)) return;
        // Shadow one row below and two columns right, clipped to the screen.
        if (b.y + b.h < rows) {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + b.h + 1, b.x + 3, shadow });
            try w.splatByteAll(' ', @min(b.w, cols -| (b.x + 2)));
        }
        for (1..b.h) |row| {
            const room = @min(2, cols -| (b.x + b.w));
            if (room == 0) break;
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + b.w + 1, shadow });
            try w.splatByteAll(' ', room);
        }
        for (0..b.h) |row| {
            const line = if (row == 0 or row == b.h - 1) null else lineAt(rows, row - 1);
            const divider = line != null and line.? == .divider;
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, panel });
            try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else if (divider) "├" else "│");
            if (row == 0 or row == b.h - 1 or divider) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else if (divider) "┤" else "│");
        }
        try w.print("\x1b[{d};{d}H{s} ᐯ•ᴥ•ᐯ {s}Corgi setup ", .{ b.y + 1, b.x + 3, mint, bright });
        try w.print("\x1b[{d};{d}H{s} esc ", .{ b.y + 1, b.x + b.w - 7, panel });
        for (1..b.h - 1) |row| {
            const y = b.y + row;
            switch (lineAt(rows, row - 1).?) {
                .spacer, .divider => {},
                .heading => |label| try put(w, b, marker_x, y, heading, label),
                .lead => |label| try put(w, b, marker_x, y, panel, label),
                .hint => |label| try put(w, b, label_x, y, panel, label),
                .option => |choice| try m.drawOption(w, b, y, choice, status),
                .detail => {
                    var buffer: [96]u8 = undefined;
                    const current: Choice = @enumFromInt(@intFromEnum(status.choice));
                    try put(w, b, summary_x, y, panel, detail(if (m.selected.summarizer()) m.selected else current, status, &buffer));
                },
                .footer => {
                    try put(w, b, marker_x, y, panel, "↑↓ choose · esc close");
                    var buffer: [48]u8 = undefined;
                    if (m.action(status, &buffer)) |label| {
                        var cap: [64]u8 = undefined;
                        const shown = std.fmt.bufPrint(&cap, "[ Enter {s} ]", .{label}) catch unreachable;
                        try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 1, b.x + b.w - 3 - sidebar.displayWidth(shown) + 1, keycap, shown });
                    }
                },
            }
        }
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
    fn drawOption(m: *const Menu, w: *std.Io.Writer, b: Rect, y: usize, choice: Choice, status: setup.Status) !void {
        const highlighted = choice == m.selected;
        const p = if (highlighted) row_selected else row_normal;
        const base = p.text;
        const label_style = p.label;
        const accent = p.accent;
        const quiet = p.quiet;
        try w.print("\x1b[{d};{d}H{s}", .{ y + 1, b.x + 2, base });
        try w.splatByteAll(' ', b.w - 2);
        if (highlighted) try w.print("\x1b[{d};{d}H{s}›", .{ y + 1, b.x + marker_x + 1, accent });
        var right_buffer: [48]u8 = undefined;
        const right: struct { text: []const u8, style: []const u8 } = switch (choice) {
            .ghostty => switch (m.integration) {
                .enabled => .{ .text = "● On", .style = accent },
                .disabled => .{ .text = "○ Off", .style = quiet },
                .unavailable => .{ .text = "local macOS only", .style = quiet },
                .failed => .{ .text = "config unreadable", .style = p.warn },
            },
            .keyboard => .{ .text = m.keysLabel(&right_buffer), .style = accent },
            .import => .{ .text = "→", .style = accent },
            else => .{ .text = if (@intFromEnum(choice) == @intFromEnum(status.choice)) "in use" else "", .style = accent },
        };
        const right_width = sidebar.displayWidth(right.text);
        const right_x = b.w - 4 - right_width;
        if (choice.summarizer()) {
            const current = @intFromEnum(choice) == @intFromEnum(status.choice);
            try w.print("\x1b[{d};{d}H{s}{s} {s}{s}", .{ y + 1, b.x + label_x + 1, if (current) accent else quiet, if (current) "●" else "○", label_style, labels[@intFromEnum(choice)] });
            try w.print("\x1b[{d};{d}H{s}", .{ y + 1, b.x + summary_x + 1, base });
            var buffer: [96]u8 = undefined;
            try sidebar.writeEllipsis(w, summary(choice, status, &buffer), right_x -| (@as(usize, summary_x) + @intFromBool(right_width > 0) + 1));
        } else {
            try w.print("\x1b[{d};{d}H{s}", .{ y + 1, b.x + label_x + 1, label_style });
            try sidebar.writeEllipsis(w, switch (choice) {
                .ghostty => "Command-key integration",
                .keyboard => "Keyboard shortcuts",
                else => "Import sessions",
            }, right_x -| (label_x + 1));
        }
        if (right_width > 0) try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 1, b.x + right_x + 1, right.style, right.text });
    }
    fn keysLabel(m: *const Menu, buffer: []u8) []const u8 {
        if (m.preset == .cmux) return "cmux · Cmd  →";
        return std.fmt.bufPrint(buffer, "{s} · {s}  →", .{ km.name(m.preset), if (m.prefix == .ctrl_b) "Ctrl+B" else "Ctrl+A" }) catch "→";
    }
    /// The keycap label for Enter, or null when Enter would do nothing useful.
    fn action(m: *const Menu, status: setup.Status, buffer: []u8) ?[]const u8 {
        return switch (m.selected) {
            .ghostty => switch (m.integration) {
                .enabled => "Turn off",
                .disabled => "Turn on",
                .unavailable, .failed => null,
            },
            .keyboard, .import => "Open →",
            else => |choice| if (@intFromEnum(choice) == @intFromEnum(status.choice))
                "Keep"
            else
                std.fmt.bufPrint(buffer, "Use {s}", .{labels[@intFromEnum(choice)]}) catch null,
        };
    }
};
const labels = [_][]const u8{ "Auto", "Codex", "Claude", "Off" };

fn put(w: *std.Io.Writer, b: Rect, x: u16, y: usize, style: []const u8, value: []const u8) !void {
    try w.print("\x1b[{d};{d}H{s}", .{ y + 1, b.x + x + 1, style });
    try sidebar.writeEllipsis(w, value, b.w -| (x + 2));
}

fn modelName(id: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, id, "claude-haiku-4-5")) "Haiku 4.5" else id;
}

fn summary(choice: Choice, status: setup.Status, buffer: []u8) []const u8 {
    return switch (choice) {
        .keyboard, .import, .ghostty => unreachable,
        .auto => if (status.choice != .auto)
            "Follow the agents you run"
        else if (status.provider) |provider|
            std.fmt.bufPrint(buffer, "{s} {s} · {s}", .{
                if (status.locked) "Settled on" else "Following you →",
                provider.info().name,
                modelName(providers.get(status.models, provider)),
            }) catch ""
        else
            "Follow the agents you run",
        // Mismatched eyes: every glyph stays one terminal column wide.
        .off => "ᐯoᴥ°ᐯ  no summaries, plain links",
        .codex, .claude => {
            const provider = choice.provider().?;
            return std.fmt.bufPrint(buffer, "{s} · your {s} login", .{ modelName(providers.get(status.models, provider)), provider.info().name }) catch "";
        },
    };
}

fn detail(choice: Choice, status: setup.Status, buffer: []u8) []const u8 {
    return switch (choice) {
        .keyboard, .import, .ghostty => unreachable,
        .auto => if (status.launches.codex + status.launches.claude == 0)
            "No agents yet this session; using your last one"
        else
            std.fmt.bufPrint(buffer, "Since start: claude {d}× · codex {d}×", .{ status.launches.claude, status.launches.codex }) catch "",
        .codex, .claude => std.fmt.bufPrint(buffer, "Needs {s} installed and signed in", .{choice.provider().?.info().executables[0]}) catch "",
        .off => "Activity text stays blank; links say Open Link",
    };
}

fn rowOf(cols: u16, rows: u16, choice: Choice) ?u16 {
    const b = Menu.bounds(cols, rows);
    for (b.y..b.y + b.h) |y| if (Menu.hit(cols, rows, b.x + 6, @intCast(y)) == choice) return @intCast(y);
    return null;
}

test "setup modal is centered and its rows are clickable inside the frame" {
    const b = Menu.bounds(100, 30);
    try std.testing.expectEqual(@as(u16, (100 - b.w) / 2), b.x);
    try std.testing.expectEqual(@as(u16, (30 - b.h) / 2), b.y);
    const auto = rowOf(100, 30, .auto).?;
    try std.testing.expectEqual(auto + 3, rowOf(100, 30, .off).?);
    try std.testing.expect(rowOf(100, 30, .off).? < rowOf(100, 30, .ghostty).?);
    try std.testing.expect(rowOf(100, 30, .ghostty).? < rowOf(100, 30, .keyboard).?);
    try std.testing.expectEqual(rowOf(100, 30, .keyboard).? + 1, rowOf(100, 30, .import).?);
    try std.testing.expect(Menu.hit(100, 30, b.x + 6, b.y + 2) == null);
    try std.testing.expect(Menu.hit(100, 30, b.x, auto) == null);
    // Short terminals drop spacer rows but keep every choice reachable.
    for (std.enums.values(Choice)) |choice| try std.testing.expect(rowOf(80, compact_height, choice) != null);
    var menu = Menu.open(.{ .choice = .claude });
    menu.move(true);
    try std.testing.expectEqual(Choice.off, menu.selected);
    menu.move(true);
    try std.testing.expectEqual(Choice.ghostty, menu.selected);
    for (0..4) |_| menu.move(true);
    try std.testing.expectEqual(Choice.import, menu.selected);
    menu.selected = .auto;
    menu.move(false);
    try std.testing.expectEqual(Choice.auto, menu.selected);
}

test "setup modal explains the automatic choice" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const menu = Menu.open(.{});
    try menu.draw(&output.writer, .{ .choice = .auto, .provider = .claude, .launches = .{ .claude = 3, .codex = 1 }, .models = .{ .claude = "claude-haiku-4-5-20251001" } }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Following you → Claude · Haiku 4.5") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "claude 3× · codex 1×") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "[ Enter Keep ]") != null);
    output.clearRetainingCapacity();
    try menu.draw(&output.writer, .{ .choice = .auto, .provider = .codex, .locked = true, .model = "gpt-6-luna", .models = .{ .codex = "gpt-6-luna", .claude = "claude-haiku-4-5-20251001" } }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Settled on Codex · gpt-6-luna") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "gpt-6-luna · your Codex login") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Haiku 4.5 · your Claude login") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᐯoᴥ°ᐯ") != null);
    try std.testing.expectEqual(std.unicode.utf8CountCodepoints("ᐯoᴥ°ᐯ"), sidebar.displayWidth("ᐯoᴥ°ᐯ"));
    output.clearRetainingCapacity();
    try menu.draw(&output.writer, .{}, 20, 8);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
}


