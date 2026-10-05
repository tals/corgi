//! Compact, single-line usage and reset groups for the agent picker.
const std = @import("std");
const metadata = @import("usage.zig").account;
const sidebar = @import("sidebar.zig");
const account_cache = @import("usage.zig").account_cache;
const palette = @import("palette.zig");
const os = @import("os.zig");
const Terminal = @import("pane.zig").Terminal;

/// "  6%" through "100%".
const percent_width = 4;
const separator = " │ ";

pub const Cell = struct {
    const Window = struct {
        label: metadata.Text = .{},
        used: u8 = 0,
        reset: metadata.Text = .{},
    };
    /// By slot, so one provider's weekly limit sits under another's.
    windows: [2]?Window = .{ null, null },
    fallback: metadata.Text = .{},

    pub fn init(windows: [2]?metadata.Window, now: i64) Cell {
        var cell: Cell = .{};
        for (windows, &cell.windows) |maybe, *out| {
            const window = maybe orelse continue;
            var label: [16]u8 = undefined;
            var reset: [48]u8 = undefined;
            out.* = .{
                .label = .ascii(window.label(&label)),
                .used = window.used,
                .reset = .ascii(window.countdown(now, &reset) orelse "unknown"),
            };
        }
        return cell;
    }

    /// Not `ascii`, which would blank the "…" and "—" in statuses.
    pub fn status(text: []const u8) Cell {
        return .{ .fallback = .initTruncated(text) };
    }

    pub fn unavailable(reason: []const u8) Cell {
        var buf: [metadata.Text.capacity]u8 = undefined;
        const text = std.fmt.bufPrint(&buf, "Unavailable · {s}", .{reason}) catch "Unavailable";
        return .{ .fallback = .initTruncated(text) };
    }

    pub fn limited(cell: Cell) bool {
        return cell.windows[0] != null or cell.windows[1] != null;
    }

    /// `selected` rows need brighter grays: faint text and empty cells vanish on them.
    pub fn write(cell: Cell, w: *std.Io.Writer, grid: Grid, width: usize, row_style: []const u8, selected: bool) !void {
        if (!cell.limited()) return sidebar.writeEllipsis(w, cell.fallback.text(), width);
        if (width < grid.groupsWidth(0) or !grid.holds(cell)) {
            // At exceptionally small widths, clip text before adding any SGR.
            var buffer: [512]u8 = undefined;
            var plain = std.Io.Writer.fixed(&buffer);
            for (grid.slots, cell.windows, 0..) |maybe_slot, maybe_window, i| {
                const slot = maybe_slot orelse continue;
                if (i > 0 and grid.slots[0] != null) try plain.writeAll(separator);
                const window = maybe_window orelse {
                    try plain.splatByteAll(' ', slot.width(0));
                    continue;
                };
                try writePadded(&plain, window.label.text(), slot.label);
                try plain.print(" {d:>3}% · ", .{window.used});
                try writePadded(&plain, window.reset.text(), slot.reset);
            }
            try sidebar.writeEllipsis(w, std.mem.trimEnd(u8, plain.buffered(), " "), width);
            return;
        }
        const bar_width = grid.barWidth(width);
        const empty = if (selected) palette.fg(.line) else palette.fg(.selected);
        const quiet = if (selected) palette.fg(.muted) else palette.fg(.faint);
        for (grid.slots, cell.windows, 0..) |maybe_slot, maybe_window, i| {
            const slot = maybe_slot orelse continue;
            if (i > 0 and grid.slots[0] != null) try w.print(palette.fg(.line) ++ separator ++ "{s}", .{row_style});
            const window = maybe_window orelse {
                try w.splatByteAll(' ', slot.width(bar_width));
                continue;
            };
            try w.print("{s}" ++ palette.fg(.muted), .{row_style});
            try writePadded(w, window.label.text(), slot.label);
            try w.print("{s} ", .{row_style});
            const color = if (window.used >= 100) palette.fg(.hot) else if (window.used >= 80) palette.fg(.warm) else palette.fg(.accent);
            if (bar_width > 0) {
                const filled = (bar_width * window.used + 50) / 100;
                try w.writeAll(color);
                for (0..bar_width) |j| {
                    if (j == filled) try w.writeAll(empty);
                    try w.writeAll("━");
                }
                try w.print("{s} ", .{row_style});
            }
            try w.print("\x1b[1m{s}{d:>3}%{s}" ++ palette.fg(.line) ++ " · {s}", .{
                if (window.used >= 80) color else palette.fg(.strong), window.used, row_style, quiet,
            });
            try writePadded(w, window.reset.text(), slot.reset);
            try w.writeAll(row_style);
        }
    }
};

/// Column widths shared by every row's groups, so they line up as a grid.
pub const Grid = struct {
    const Slot = struct {
        label: usize = 0,
        reset: usize = 0,

        fn width(slot: Slot, bar: usize) usize {
            return slot.label + 1 + (if (bar > 0) bar + 1 else 0) + percent_width + 3 + slot.reset;
        }
    };
    /// Null where no row has that window.
    slots: [2]?Slot = .{ null, null },
    /// The widest status, such as "Track usage", shown instead of groups.
    status: usize = 0,

    pub fn add(grid: *Grid, cell: Cell) void {
        if (!cell.limited()) grid.status = @max(grid.status, sidebar.displayWidth(cell.fallback.text()));
        for (cell.windows, &grid.slots) |maybe, *slot| {
            const window = maybe orelse continue;
            var wider = slot.* orelse Slot{};
            wider.label = @max(wider.label, sidebar.displayWidth(window.label.text()));
            wider.reset = @max(wider.reset, sidebar.displayWidth(window.reset.text()));
            slot.* = wider;
        }
    }

    pub fn minimumWidth(grid: Grid) usize {
        return @max(grid.status, grid.groupsWidth(0));
    }

    pub fn preferredWidth(grid: Grid) usize {
        return @max(grid.status, grid.groupsWidth(6));
    }

    fn groupsWidth(grid: Grid, bar: usize) usize {
        var size: usize = 0;
        for (grid.slots) |maybe| {
            const slot = maybe orelse continue;
            if (size > 0) size += sidebar.displayWidth(separator);
            size += slot.width(bar);
        }
        return size;
    }

    /// The same in every row: up to six cells, then none once a group would
    /// get fewer than two.
    fn barWidth(grid: Grid, width: usize) usize {
        const groups: usize = @as(usize, @intFromBool(grid.slots[0] != null)) + @intFromBool(grid.slots[1] != null);
        if (groups == 0) return 0;
        const extra = (width -| grid.groupsWidth(0)) / groups;
        return if (extra >= 3) @min(6, extra - 1) else 0;
    }

    /// Whether `cell` was among the rows the grid was sized for.
    fn holds(grid: Grid, cell: Cell) bool {
        var wider = grid;
        wider.add(cell);
        return std.meta.eql(wider.slots, grid.slots);
    }
};

fn writePadded(w: *std.Io.Writer, text: []const u8, width: usize) !void {
    try w.writeAll(text);
    try w.splatByteAll(' ', width -| sidebar.displayWidth(text));
}

test "usage groups keep each limit in its slot and show its reset" {
    const cell = Cell.init(.{ null, .{ .minutes = 10080, .used = 48, .reset_at = 273700 } }, 100);
    try std.testing.expect(cell.windows[0] == null);
    try std.testing.expectEqualStrings("7d", cell.windows[1].?.label.text());
    try std.testing.expectEqualStrings("3d 4h", cell.windows[1].?.reset.text());
    const zero = Cell.init(.{ .{ .minutes = 300, .used = 0, .reset_at = 8200 }, .{ .minutes = 10080, .used = 100, .reset_at = 273700 } }, 100);
    try std.testing.expectEqual(@as(u8, 0), zero.windows[0].?.used);
    try std.testing.expectEqualStrings("2h 15m", zero.windows[0].?.reset.text());
    const other = Cell.init(.{ .{ .minutes = 1440, .used = 12 }, null }, 100);
    try std.testing.expectEqualStrings("1d", other.windows[0].?.label.text());
    try std.testing.expectEqualStrings("unknown", other.windows[0].?.reset.text());
    try std.testing.expect(other.windows[1] == null);
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
    try std.testing.expect(cached.windows[0] != null and cached.windows[1] != null);
    var grid: Grid = .{};
    grid.add(fresh);
    try std.testing.expect(grid.holds(cached));
    for ([_]usize{ 25, grid.minimumWidth(), grid.preferredWidth() }) |width| {
        var a_buffer: [2048]u8 = undefined;
        var b_buffer: [2048]u8 = undefined;
        var a_writer = std.Io.Writer.fixed(&a_buffer);
        var b_writer = std.Io.Writer.fixed(&b_buffer);
        try cached.write(&a_writer, grid, width, "\x1b[0m", false);
        try fresh.write(&b_writer, grid, width, "\x1b[0m", false);
        try std.testing.expectEqualStrings(b_writer.buffered(), a_writer.buffered());
        try std.testing.expect(std.mem.indexOf(u8, a_writer.buffered(), "cached") == null);
    }
    for ([_][]const u8{ "Reading…", "Track usage", "Metered", "—" }) |text| {
        const cell = Cell.status(text);
        try std.testing.expect(!cell.limited());
        try std.testing.expectEqualStrings(text, cell.fallback.text());
    }
}

test "text-only usage fits both limits without bars and clips within its cell" {
    const cell = Cell.init(.{ .{ .minutes = 300, .used = 0 }, .{ .minutes = 10080, .used = 100 } }, 100);
    var grid: Grid = .{};
    grid.add(cell);
    var buffer: [2048]u8 = undefined;
    var w = std.Io.Writer.fixed(&buffer);
    try cell.write(&w, grid, grid.minimumWidth(), "\x1b[0m", false);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "━") == null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), separator) != null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "100%") != null);
    try std.testing.expect(std.mem.indexOf(u8, w.buffered(), "(cached)") == null);
    w = std.Io.Writer.fixed(&buffer);
    try cell.write(&w, grid, 25, "\x1b[0m", false);
    try std.testing.expect(sidebar.displayWidth(w.buffered()) <= 25);
}

test "usage rows line up on one grid at every width" {
    const now = 100;
    const cells = [_]Cell{
        .init(.{ null, .{ .minutes = 10080, .used = 6, .reset_at = now + 4 * 86400 + 18 * 3600 } }, now),
        .init(.{ .{ .minutes = 300, .used = 70, .reset_at = now + 3 * 60 }, .{ .minutes = 10080, .used = 84, .reset_at = now + 10 * 3600 + 43 * 60 } }, now),
        .init(.{ .{ .minutes = 300, .used = 100, .reset_at = now + 2 * 3600 + 15 * 60 }, null }, now),
    };
    var grid: Grid = .{};
    for (cells) |cell| grid.add(cell);
    // No bars, short bars and full bars.
    for ([_]usize{ grid.minimumWidth(), grid.minimumWidth() + 8, grid.preferredWidth() }) |width| {
        const host = try Terminal.create(80, 4);
        defer host.destroy();
        var buffer: [4096]u8 = undefined;
        var w = std.Io.Writer.fixed(&buffer);
        for (cells, 1..) |cell, y| {
            try w.print("\x1b[{d};1H", .{y});
            try cell.write(&w, grid, width, "\x1b[0m", false);
        }
        host.feed(w.buffered());
        const rendered = try host.text();
        defer os.allocator.free(rendered);
        var lines = std.mem.splitScalar(u8, rendered, '\n');
        const weekly = lines.next().?;
        const both = lines.next().?;
        const short = lines.next().?;
        try std.testing.expectEqual(columnOf(both, "·", 0), columnOf(short, "·", 0));
        try std.testing.expectEqual(columnOf(both, "·", 1), columnOf(weekly, "·", 0));
        try std.testing.expectEqual(columnOf(both, "│", 0), columnOf(weekly, "│", 0));
        try std.testing.expectEqual(columnOf(both, "│", 0), columnOf(short, "│", 0));
        try std.testing.expectEqual(columnOf(both, "7d", 0), columnOf(weekly, "7d", 0));
        for ([_][]const u8{ weekly, both, short }) |line| try std.testing.expect(sidebar.displayWidth(std.mem.trimEnd(u8, line, " ")) <= width);
    }
}

/// The display column of the `nth` (from zero) `needle` in a rendered line.
fn columnOf(line: []const u8, needle: []const u8, nth: usize) usize {
    var start: usize = 0;
    for (0..nth) |_| start = std.mem.indexOfPos(u8, line, start, needle).? + needle.len;
    return sidebar.displayWidth(line[0..std.mem.indexOfPos(u8, line, start, needle).?]);
}
