//! Compact, single-line usage and reset groups for the agent picker.
const std = @import("std");
const metadata = @import("account_preview.zig");
const sidebar = @import("sidebar.zig");
const account_cache = @import("account_cache.zig");

pub const Cell = struct {
    const Window = struct {
        label: metadata.Text = .{},
        used: u8 = 0,
        reset: metadata.Text = .{},

        fn width(window: Window) usize {
            return sidebar.displayWidth(window.label.text()) + 1 + percentWidth(window.used) + 3 + window.reset.len;
        }
    };
    windows: [2]Window = .{ .{}, .{} },
    len: usize = 0,
    fallback: metadata.Text = .{},

    pub fn init(windows: [2]?metadata.Window, now: i64) Cell {
        var cell: Cell = .{};
        for (windows) |maybe| {
            const window = maybe orelse continue;
            const out = &cell.windows[cell.len];
            var label: [16]u8 = undefined;
            out.label.set(window.label(&label));
            out.used = window.used;
            var reset: [48]u8 = undefined;
            out.reset.set(window.countdown(now, &reset) orelse "unknown");
            cell.len += 1;
        }
        return cell;
    }

    /// Copied raw: `Text.set` would blank the "…" and "—" in statuses.
    pub fn status(text: []const u8) Cell {
        var cell: Cell = .{};
        cell.fallback.len = @min(text.len, cell.fallback.bytes.len);
        @memcpy(cell.fallback.bytes[0..cell.fallback.len], text[0..cell.fallback.len]);
        return cell;
    }

    pub fn unavailable(reason: []const u8) Cell {
        var cell: Cell = .{};
        const text = std.fmt.bufPrint(&cell.fallback.bytes, "Unavailable · {s}", .{reason}) catch {
            cell.fallback.set("Unavailable");
            return cell;
        };
        cell.fallback.len = text.len;
        return cell;
    }

    pub fn minimumWidth(cell: Cell) usize {
        if (cell.len == 0) return sidebar.displayWidth(cell.fallback.text());
        var size: usize = (cell.len - 1) * 3;
        for (cell.windows[0..cell.len]) |window| size += window.width();
        return size;
    }

    pub fn preferredWidth(cell: Cell) usize {
        return cell.minimumWidth() + cell.len * 7; // Six bar cells and one space per limit.
    }

    pub fn write(cell: Cell, w: *std.Io.Writer, width: usize, row_style: []const u8) !void {
        if (cell.len == 0) return sidebar.writeEllipsis(w, cell.fallback.text(), width);
        const minimum = cell.minimumWidth();
        if (width < minimum) {
            // At exceptionally small widths, clip text before adding any SGR.
            var buffer: [512]u8 = undefined;
            var plain = std.Io.Writer.fixed(&buffer);
            for (cell.windows[0..cell.len], 0..) |window, i| {
                if (i > 0) try plain.writeAll(" │ ");
                try plain.print("{s} {d}% · {s}", .{ window.label.text(), window.used, window.reset.text() });
            }
            try sidebar.writeEllipsis(w, plain.buffered(), width);
            return;
        }
        const extra = (width - minimum) / cell.len;
        const bar_width: usize = if (extra >= 3) @min(6, extra - 1) else 0;
        for (cell.windows[0..cell.len], 0..) |window, i| {
            if (i > 0) try w.writeAll("\x1b[38;2;83;97;106m │ ");
            try w.print("{s}\x1b[1;38;2;169;200;184m{s}{s} ", .{ row_style, window.label.text(), row_style });
            const color = if (window.used >= 100) "237;163;152" else if (window.used >= 80) "229;195;139" else "169;200;184";
            if (bar_width > 0) {
                const filled = (bar_width * window.used + 50) / 100;
                try w.print("\x1b[38;2;{s}m", .{color});
                for (0..bar_width) |j| {
                    if (j == filled) try w.writeAll("\x1b[38;2;83;97;106m");
                    try w.writeAll("━");
                }
                try w.print("{s} ", .{row_style});
            }
            try w.print("\x1b[1;38;2;{s}m{d}%{s}\x1b[38;2;83;97;106m · \x1b[38;2;147;159;169m{s}{s}", .{
                if (window.used >= 80) color else "220;225;229", window.used, row_style, window.reset.text(), row_style,
            });
        }
    }
};

fn percentWidth(used: u8) usize {
    return if (used >= 100) 4 else if (used >= 10) 3 else 2;
}

test "usage groups omit absent limits and show each window's reset" {
    const cell = Cell.init(.{ null, .{ .minutes = 10080, .used = 48, .reset_at = 273700 } }, 100);
    try std.testing.expectEqual(@as(usize, 1), cell.len);
    try std.testing.expectEqualStrings("7d", cell.windows[0].label.text());
    try std.testing.expectEqualStrings("3d 4h", cell.windows[0].reset.text());
    const zero = Cell.init(.{ .{ .minutes = 300, .used = 0, .reset_at = 8200 }, .{ .minutes = 10080, .used = 100, .reset_at = 273700 } }, 100);
    try std.testing.expectEqual(@as(usize, 2), zero.len);
    try std.testing.expectEqual(@as(u8, 0), zero.windows[0].used);
    try std.testing.expectEqualStrings("2h 15m", zero.windows[0].reset.text());
    const other = Cell.init(.{ .{ .minutes = 1440, .used = 12 }, null }, 100);
    try std.testing.expectEqualStrings("1d", other.windows[0].label.text());
    try std.testing.expectEqualStrings("unknown", other.windows[0].reset.text());
}

test "cached readings have no extra indicator and statuses remain readable" {
    var state: account_cache.State = .{};
    var info: metadata.Info = .{ .signed_in = true };
    info.limits = .{ .windows = .{ .{ .minutes = 300, .used = 12 }, .{ .minutes = 10080, .used = 48 } } };
    state.update(info, 1000);
    const fresh = Cell.init(info.limits.windows, 1100);
    state.update(.{ .signed_in = true }, 1100);
    const retained = state.display(1100);
    const cached = Cell.init(retained.limits.windows, 1100);
    try std.testing.expectEqual(@as(usize, 2), cached.len);
    try std.testing.expectEqual(fresh.preferredWidth(), cached.preferredWidth());
    for ([_]usize{ 25, fresh.minimumWidth(), fresh.preferredWidth() }) |width| {
        var a_buffer: [2048]u8 = undefined;
        var b_buffer: [2048]u8 = undefined;
        var a_writer = std.Io.Writer.fixed(&a_buffer);
        var b_writer = std.Io.Writer.fixed(&b_buffer);
        try cached.write(&a_writer, width, "\x1b[0m");
        try fresh.write(&b_writer, width, "\x1b[0m");
        try std.testing.expectEqualStrings(b_writer.buffered(), a_writer.buffered());
        try std.testing.expect(std.mem.indexOf(u8, a_writer.buffered(), "cached") == null);
    }
    for ([_][]const u8{ "Reading…", "Track usage", "Metered", "—" }) |text| {
        const cell = Cell.status(text);
        try std.testing.expectEqual(@as(usize, 0), cell.len);
        try std.testing.expectEqualStrings(text, cell.fallback.text());
    }
}

test "text-only usage fits both limits without bars and clips within its cell" {
    const cell = Cell.init(.{ .{ .minutes = 300, .used = 0 }, .{ .minutes = 10080, .used = 100 } }, 100);
    var buffer: [2048]u8 = undefined;
    var w = std.Io.Writer.fixed(&buffer);
    try cell.write(&w, cell.minimumWidth(), "\x1b[0m");
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "━") == null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), " │ ") != null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "100%") != null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "(cached)") == null);
    w = std.Io.Writer.fixed(&buffer);
    try cell.write(&w, 25, "\x1b[0m");
    try std.testing.expect(sidebar.displayWidth(w.buffered()) <= 25);
}
