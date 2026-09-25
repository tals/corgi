//! Setup popover opened from the corgi badge (or Ctrl-B i). Viewer-owned;
//! applying a choice sends `inference.configure` to the daemon.
const std = @import("std");
const setup = @import("inference_setup.zig");
const sidebar = @import("sidebar.zig");
const Rect = @import("layout.zig").Rect;
pub const Choice = enum { auto, codex, claude, off, ghostty };
const ghostty = @import("ghostty_integration.zig");

const options = [_]struct { choice: Choice, label: []const u8 }{
    .{ .choice = .auto, .label = "Auto" },
    .{ .choice = .codex, .label = "Codex" },
    .{ .choice = .claude, .label = "Claude" },
    .{ .choice = .off, .label = "Off" },
};
const first_option = 3;

pub const Menu = struct {
    selected: Choice,
    integration: ghostty.State = .unavailable,

    pub fn open(status: setup.Status) Menu {
        return .{ .selected = @enumFromInt(@intFromEnum(status.choice)) };
    }
    pub fn bounds(cols: u16, rows: u16) Rect {
        const width = @min(cols, 52);
        const height = @min(rows, 15);
        // Hang below the badge: its image is drawn above text on rows 0–1.
        return .{ .x = @min(1, cols - width), .y = @min(2, rows - height), .w = width, .h = height };
    }
    pub fn contains(cols: u16, rows: u16, x: u16, y: u16) bool {
        return bounds(cols, rows).contains(x, y);
    }
    pub fn hit(cols: u16, rows: u16, x: u16, y: u16) ?Choice {
        const b = bounds(cols, rows);
        if (b.w < 32 or b.h < 15 or x <= b.x or x >= b.x + b.w - 1) return null;
        if (y == b.y + 10) return .ghostty;
        if (y < b.y + first_option or y >= b.y + first_option + options.len) return null;
        return options[y - b.y - first_option].choice;
    }
    pub fn move(m: *Menu, next: bool) void {
        const index: usize = @intFromEnum(m.selected);
        m.selected = @enumFromInt(if (next) @min(index + 1, options.len) else index -| 1);
    }
    pub fn draw(m: *const Menu, w: *std.Io.Writer, status: setup.Status, cols: u16, rows: u16) !void {
        const b = bounds(cols, rows);
        if (b.w < 32 or b.h < 15) return;
        const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
        const text = "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
        const bright = "\x1b[1;38;2;226;230;233;48;2;35;40;47m";
        const accent = "\x1b[0;38;2;161;194;178;48;2;35;40;47m";
        for (0..b.h) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, panel });
            try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
            if (row == 0 or row == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
        }
        try w.print("\x1b[{d};{d}H{s} ᐯ•ᴥ•ᐯ {s}Corgi setup ", .{ b.y + 1, b.x + 3, accent, bright });
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 2, b.x + 3, text });
        try sidebar.writeEllipsis(w, "Who writes activity summaries and link names?", b.w - 5);
        for (options, 0..) |option, i| {
            const row = b.y + first_option + i + 1;
            const highlighted = option.choice == m.selected;
            const style = if (highlighted) "\x1b[0;38;2;226;230;233;48;2;47;64;59m" else text;
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, style });
            try w.splatByteAll(' ', b.w - 2);
            const current = @intFromEnum(option.choice) == @intFromEnum(status.choice);
            try w.print("\x1b[{d};{d}H{s} {s} {s}", .{ row, b.x + 2, if (highlighted) "›" else " ", if (current) "●" else "○", option.label });
            try w.print("\x1b[{d};{d}H", .{ row, b.x + 14 });
            var buffer: [96]u8 = undefined;
            try sidebar.writeEllipsis(w, summary(option.choice, status, &buffer), b.w -| 16);
        }
        var buffer: [96]u8 = undefined;
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + first_option + options.len + 2, b.x + 3, panel });
        try sidebar.writeEllipsis(w, detail(m.selected, status, &buffer), b.w - 5);
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 11, b.x + 3, if (m.selected == .ghostty) bright else text });
        try sidebar.writeEllipsis(w, switch (m.integration) {
            .enabled => "Disable Ghostty integration",
            .disabled => "Enable Ghostty integration",
            .unavailable => "Ghostty integration: local macOS only",
            .failed => "Ghostty integration: config unavailable",
        }, b.w - 5);
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 12, b.x + 3, panel });
        try sidebar.writeEllipsis(w, "Cmd+1-9, Cmd+T, Ctrl+Tab / Ctrl+Shift+Tab", b.w - 5);
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 13, b.x + 3, panel });
        try sidebar.writeEllipsis(w, "Applies everywhere in Ghostty; reload to apply", b.w - 5);
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + b.h - 1, b.x + 3, panel });
        try sidebar.writeEllipsis(w, "↑↓ choose · Enter save · Esc close", b.w - 5);
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
};

fn modelName(id: []const u8) []const u8 {
    return if (std.mem.startsWith(u8, id, "claude-haiku-4-5")) "Haiku 4.5" else id;
}

fn summary(choice: Choice, status: setup.Status, buffer: []u8) []const u8 {
    return switch (choice) {
        .ghostty => "Reload Ghostty with Cmd+Shift+, after changes",
        .auto => if (status.choice != .auto)
            "Follow the agents you run"
        else if (status.provider) |provider|
            std.fmt.bufPrint(buffer, "{s} {s} · {s}", .{
                if (status.locked) "Settled on" else "Following you →",
                if (provider == .codex) "Codex" else "Claude",
                modelName(if (provider == .codex) status.codex_model else status.claude_model),
            }) catch ""
        else
            "Follow the agents you run",
        .codex => std.fmt.bufPrint(buffer, "{s} · your Codex login", .{modelName(status.codex_model)}) catch "",
        .claude => std.fmt.bufPrint(buffer, "{s} · your Claude login", .{modelName(status.claude_model)}) catch "",
        // Mismatched eyes: every glyph stays one terminal column wide.
        .off => "ᐯoᴥ°ᐯ  no summaries, plain links",
    };
}

fn detail(choice: Choice, status: setup.Status, buffer: []u8) []const u8 {
    return switch (choice) {
        .ghostty => "Reload Ghostty with Cmd+Shift+, after changes",
        .auto => if (status.codex_launches + status.claude_launches == 0)
            "No agents yet this session; using your last one"
        else
            std.fmt.bufPrint(buffer, "Since start: claude {d}× · codex {d}×", .{ status.claude_launches, status.codex_launches }) catch "",
        .codex => "Needs codex installed and signed in",
        .claude => "Needs claude installed and signed in",
        .off => "Activity text stays blank; links say Open Link",
    };
}

test "setup popover options are clickable rows inside its frame" {
    const b = Menu.bounds(100, 30);
    try std.testing.expectEqual(Choice.auto, Menu.hit(100, 30, b.x + 3, b.y + first_option).?);
    try std.testing.expectEqual(Choice.off, Menu.hit(100, 30, b.x + 3, b.y + first_option + 3).?);
    try std.testing.expect(Menu.hit(100, 30, b.x + 3, b.y + 1) == null);
    try std.testing.expect(Menu.hit(100, 30, b.x, b.y + first_option) == null);
    var menu = Menu.open(.{ .choice = .claude });
    menu.move(true);
    try std.testing.expectEqual(Choice.off, menu.selected);
    menu.move(true);
    try std.testing.expectEqual(Choice.ghostty, menu.selected);
    menu.selected = .auto;
    menu.move(false);
    try std.testing.expectEqual(Choice.auto, menu.selected);
}

test "setup popover explains the automatic choice" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const menu = Menu.open(.{});
    try menu.draw(&output.writer, .{ .choice = .auto, .provider = .claude, .claude_launches = 3, .codex_launches = 1, .claude_model = "claude-haiku-4-5-20251001" }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Following you → Claude · Haiku 4.5") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "claude 3× · codex 1×") != null);
    output.clearRetainingCapacity();
    try menu.draw(&output.writer, .{ .choice = .auto, .provider = .codex, .locked = true, .model = "gpt-6-luna", .codex_model = "gpt-6-luna", .claude_model = "claude-haiku-4-5-20251001" }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Settled on Codex · gpt-6-luna") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "gpt-6-luna · your Codex login") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Haiku 4.5 · your Claude login") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᐯoᴥ°ᐯ") != null);
    try std.testing.expectEqual(std.unicode.utf8CountCodepoints("ᐯoᴥ°ᐯ"), sidebar.displayWidth("ᐯoᴥ°ᐯ"));
    output.clearRetainingCapacity();
    try menu.draw(&output.writer, .{}, 20, 8);
    try std.testing.expectEqual(@as(usize, 0), output.written().len);
}
