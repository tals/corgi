//! Viewer-local resource card: three framed graphs and a stable mini top.
const std = @import("std");
const resources = @import("trackers.zig").resources;
const sidebar = @import("sidebar.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const Rect = @import("layout.zig").Rect;
const palette = @import("palette.zig");
// Each write sets a whole style, so bold never leaks into the next.
const text = (palette.Style{ .fg = .text, .bg = .bg }).sgr();
const faint = (palette.Style{ .fg = .faint, .bg = .bg }).sgr();
const rule = (palette.Style{ .fg = .line, .bg = .bg }).sgr();
/// Titles, headings, and the figures the table sorts by.
const strong = (palette.Style{ .fg = .strong, .bg = .bg, .bold = true }).sgr();
const warm = (palette.Style{ .fg = .warm, .bg = .bg }).sgr();
/// Graph cells: live data, like the limit sparks.
const live = (palette.Style{ .fg = .accent, .bg = .bg }).sgr();

pub fn geometry(cols: u16, rows: u16, side: u16, anchor: u16) ?Rect {
    if (cols < 68 or rows < 22) return null;
    const w = @min(82, cols - 2);
    const h = @min(24, rows - 2);
    return .{ .x = @min(side, cols - w - 1), .y = @min(anchor, rows - h - 1), .w = w, .h = h };
}
/// Where the pointer left the resource row on its way to the card, and when it
/// last moved inside the aim triangle.
pub const Aim = struct { x: u16, y: u16, at: i64 = 0 };
/// A pointer resting this long short of the card has stopped aiming for it.
pub const aim_ms = 300;
/// Amazon's mega-dropdown "menu aim": after the pointer leaves the resource
/// row, cells inside the triangle from its exit point to the card's left edge
/// are on the way to the card, even across other sidebar rows. Moves arrive a
/// whole cell at a time and cells are about twice as tall as wide, so the apex
/// sits two columns behind the exit point: a first step straight down still
/// counts as aiming, a second does not.
pub fn aimed(rect: Rect, from: Aim, x: u16, y: u16) bool {
    const ax = @as(i32, from.x) - 2;
    const ay: i32 = from.y;
    const px: i32 = x;
    const py: i32 = y;
    const edge: i32 = rect.x;
    if (px <= ax or px >= edge) return false;
    const top = (@as(i32, rect.y) - ay) * (px - ax);
    const bottom = (@as(i32, rect.y) + rect.h - 1 - ay) * (px - ax);
    const slope = (py - ay) * (edge - ax);
    return slope >= top and slope <= bottom;
}
const Key = struct { pid: i32, start: u64 };
pub const State = struct {
    workspace: ?WorkspaceId = null,
    anchor: u16 = 0,
    sort: resources.Sort = .cpu,
    order: [resources.process_capacity]Key = undefined,
    count: usize = 0,
    frozen: bool = false,
    pub fn update(s: *State, work: resources.Work, freeze: bool) void {
        if (s.workspace != work.id) {
            s.workspace = work.id;
            s.count = 0;
            s.sort = .cpu;
            s.frozen = false;
        }
        if (freeze and s.frozen and s.count > 0) return;
        var list: [resources.process_capacity]resources.Process = undefined;
        const n = @min(list.len, work.processes.len);
        @memcpy(list[0..n], work.processes[0..n]);
        std.mem.sort(resources.Process, list[0..n], s.sort, resources.Process.less);
        for (list[0..n], 0..) |p, i| s.order[i] = .{ .pid = p.pid, .start = p.start };
        s.count = n;
        s.frozen = freeze;
    }
    pub fn click(s: *State, rect: Rect, x: u16, y: u16) void {
        s.sort = sortAt(rect, x, y) orelse return;
        s.frozen = false;
    }
};
/// The sortable column header under a cell, from "CPU %" through "W MB/s".
/// Both disk columns sort by I/O.
pub fn sortAt(rect: Rect, x: u16, y: u16) ?resources.Sort {
    if (y != rect.y + 14 or x < rect.x + rect.w - 32 or x >= rect.x + rect.w - 2) return null;
    if (x >= rect.x + rect.w - 17) return .io;
    if (x >= rect.x + rect.w - 24) return .memory;
    return .cpu;
}

fn at(w: *std.Io.Writer, x: usize, y: usize, color: []const u8, value: []const u8, width: usize) !void {
    try w.print("\x1b[{d};{d}H{s}", .{ y + 1, x + 1, color });
    if (value.len == 0) return;
    var clean: [512]u8 = undefined;
    try sidebar.writeClipped(w, sidebar.directoryLabel(&clean, value, null), width);
}
fn right(w: *std.Io.Writer, x: usize, y: usize, color: []const u8, value: []const u8, width: usize) !void {
    try at(w, x + width -| @min(width, sidebar.displayWidth(value)), y, color, value, width);
}
fn box(w: *std.Io.Writer, rect: Rect, title: []const u8, title_color: []const u8) !void {
    try at(w, rect.x, rect.y, rule, "┌", 1);
    for (0..rect.w - 2) |_| try w.writeAll("─");
    try w.writeAll("┐");
    for (1..rect.h - 1) |row| {
        try at(w, rect.x, rect.y + row, rule, "│", 1);
        try at(w, rect.x + rect.w - 1, rect.y + row, rule, "│", 1);
    }
    try at(w, rect.x, rect.y + rect.h - 1, rule, "└", 1);
    for (0..rect.w - 2) |_| try w.writeAll("─");
    try w.writeAll("┘");
    try at(w, rect.x + 2, rect.y, title_color, title, rect.w - 4);
}
fn graph(w: *std.Io.Writer, rect: Rect, work: resources.Work, metric: resources.Sort) !void {
    var buf: [64]u8 = undefined;
    const total = if (work.read != null and work.written != null) work.read.? +| work.written.? else null;
    const value = switch (metric) {
        .cpu => resources.cpuText(&buf, work.cpu),
        .memory => if (work.memory) |n| try std.fmt.bufPrint(&buf, "{d:.2} GiB", .{@as(f64, @floatFromInt(n)) / (1024 * 1024 * 1024)}) else "",
        .io => resources.ioText(&buf, total),
    };
    if (value.len == 0) return;
    try box(w, rect, switch (metric) {
        .cpu => " cpu ",
        .memory => " memory ",
        .io => " disk I/O ",
    }, faint);
    try at(w, rect.x + 2, rect.y + 1, strong, value, rect.w - 4);
    const width: usize = rect.w - 4;
    const history = work.history[work.history.len - @min(width, work.history.len) ..];
    var ceiling: f64 = if (metric == .cpu) 100 else 1;
    for (history) |point| if (sample(point, metric)) |v| {
        ceiling = @max(ceiling, v);
    };
    const rows: usize = rect.h - 4;
    const glyphs = [_][]const u8{ " ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█" };
    for (history, 0..) |point, i| {
        const v = sample(point, metric) orelse continue;
        const eighths: usize = @intFromFloat(@round(v / ceiling * @as(f64, @floatFromInt(rows * 8))));
        for (0..rows) |row| {
            const fill = @min(8, eighths -| (row * 8));
            try at(w, rect.x + 2 + width - history.len + i, rect.y + rect.h - 2 - row, live, glyphs[fill], 1);
        }
    }
}
fn sample(point: resources.Point, metric: resources.Sort) ?f64 {
    return switch (metric) {
        .cpu => point.cpu,
        .memory => if (point.memory) |n| @floatFromInt(n) else null,
        .io => if (point.io) |n| @floatFromInt(n) else null,
    };
}
fn statusText(work: resources.Work) []const u8 {
    if (!work.known) return "Sampling unavailable";
    if (work.partial) return "Partial process coverage";
    if (work.cpu_pressure) return "CPU busy";
    return "";
}

pub fn draw(w: *std.Io.Writer, rect: Rect, name: []const u8, snapshot: resources.Snapshot, state: State) !void {
    const work = snapshot.workspace(state.workspace orelse return);
    try w.writeAll("\x1b7\x1b]8;;\x1b\\" ++ text ++ "\x1b[?25l");
    for (0..rect.h) |row| {
        try w.print("\x1b[{d};{d}H", .{ rect.y + row + 1, rect.x + 1 });
        try w.splatByteAll(' ', rect.w);
    }
    var buf: [180]u8 = undefined;
    try box(w, rect, try std.fmt.bufPrint(&buf, " {s} / resources ", .{name}), strong);
    const status = statusText(work);
    try at(w, rect.x + 2, rect.y + 1, if (work.cpu_pressure) warm else text, status, rect.w - 20);
    try right(w, rect.x + rect.w - 16, rect.y + 1, faint, try std.fmt.bufPrint(&buf, "live / {d}s", .{snapshot.interval_ms / 1000}), 13);
    const gw = (rect.w - 6) / 3;
    inline for (.{ resources.Sort.cpu, resources.Sort.memory, resources.Sort.io }, 0..) |metric, i| {
        try graph(w, .{ .x = rect.x + 2 + @as(u16, i) * (gw + 1), .y = rect.y + 3, .w = gw, .h = 7 }, work, metric);
    }
    var cpu_buf: [24]u8 = undefined;
    var host_line = std.Io.Writer.fixed(&buf);
    try host_line.print("HOST {d} cores", .{snapshot.cores});
    if (snapshot.host_cpu != null) try host_line.print(" / {s} CPU", .{resources.cpuText(&cpu_buf, snapshot.host_cpu)});
    if (snapshot.memory_pressure != .unknown) try host_line.print(" / memory {s}", .{@tagName(snapshot.memory_pressure)});
    try at(w, rect.x + 2, rect.y + 11, faint, host_line.buffered(), rect.w - 4);
    try at(w, rect.x + 2, rect.y + 13, strong, "TOP PROCESSES", 20);
    const header = rect.y + 14;
    // The sorted column's heading and figures are bright; the rest recede.
    const cpu = if (state.sort == .cpu) strong else text;
    const memory = if (state.sort == .memory) strong else text;
    const io = if (state.sort == .io) strong else text;
    try right(w, rect.x + 2, header, faint, "PID", 6);
    try at(w, rect.x + 10, header, faint, "PROCESS", rect.w - 43);
    try right(w, rect.x + rect.w - 32, header, if (state.sort == .cpu) strong else faint, "CPU %", 7);
    try right(w, rect.x + rect.w - 24, header, if (state.sort == .memory) strong else faint, "GiB", 6);
    try right(w, rect.x + rect.w - 17, header, if (state.sort == .io) strong else faint, "R MB/s", 7);
    try right(w, rect.x + rect.w - 9, header, if (state.sort == .io) strong else faint, "W MB/s", 7);
    const count = @min(state.count, rect.h -| 19);
    for (state.order[0..count], 0..) |key, i| {
        const y = header + 1 + i;
        const proc: ?resources.Process = for (work.processes) |p| {
            if (p.pid == key.pid and p.start == key.start) break p;
        } else null;
        try right(w, rect.x + 2, y, faint, try std.fmt.bufPrint(&buf, "{d}", .{key.pid}), 6);
        if (proc) |p| {
            try at(w, rect.x + 10, y, text, try std.fmt.bufPrint(&buf, "{s}{s}", .{ if (p.provider) |provider| (if (provider == .claude) "* " else "† ") else "", p.name }), rect.w - 43);
            try right(w, rect.x + rect.w - 32, y, cpu, if (p.cpu) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{n}) else "", 7);
            try right(w, rect.x + rect.w - 24, y, memory, try std.fmt.bufPrint(&buf, "{d:.2}", .{@as(f64, @floatFromInt(p.memory)) / (1024 * 1024 * 1024)}), 6);
            try right(w, rect.x + rect.w - 17, y, io, if (p.read) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{@as(f64, @floatFromInt(n)) / 1000000}) else "", 7);
            try right(w, rect.x + rect.w - 9, y, io, if (p.written) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{@as(f64, @floatFromInt(n)) / 1000000}) else "", 7);
        } else try at(w, rect.x + 10, y, faint, "Sample not available", rect.w - 43);
    }
    try at(w, rect.x + 2, rect.y + rect.h - 3, faint, "* Claude Code   † Codex", rect.w - 4);
    try at(w, rect.x + 2, rect.y + rect.h - 2, faint, try std.fmt.bufPrint(&buf, "{d} local processes / {s}{s} / {d} shown", .{
        work.count,
        snapshot.memory_kind,
        if (work.partial) " / partial" else "",
        count,
    }), rect.w - 4);
    try w.writeAll("\x1b[0m\x1b8\x1b[?25l");
}

test "resource card stays within terminal bounds" {
    for ([_]u16{ 68, 88, 120, 200 }) |cols| for ([_]u16{ 24, 30, 40 }) |rows| {
        const rect = geometry(cols, rows, 28, rows - 1).?;
        try std.testing.expect(rect.x + rect.w < cols);
        try std.testing.expect(rect.y + rect.h < rows);
    };
}

test "aim triangle spans from the row exit to the card's left edge" {
    const card: Rect = .{ .x = 28, .y = 4, .w = 82, .h = 24 };
    const exit: Aim = .{ .x = 4, .y = 4 };
    // A diagonal swing across the rows below stays on course.
    for ([_][2]u16{ .{ 8, 7 }, .{ 14, 10 }, .{ 20, 13 }, .{ 27, 26 } }) |p| try std.testing.expect(aimed(card, exit, p[0], p[1]));
    // One step straight down is cell noise; a second is not aiming.
    try std.testing.expect(aimed(card, exit, 4, 5));
    try std.testing.expect(!aimed(card, exit, 4, 6));
    // Moving back, above the card or past its bottom corner leaves the triangle.
    try std.testing.expect(!aimed(card, exit, 3, 5));
    try std.testing.expect(!aimed(card, exit, 20, 3));
    try std.testing.expect(!aimed(card, exit, 27, 28));
    try std.testing.expect(!aimed(card, exit, 28, 10));
    // A card lifted above the row, near the bottom of the screen, aims upward too.
    const lifted: Rect = .{ .x = 28, .y = 10, .w = 82, .h = 24 };
    try std.testing.expect(aimed(lifted, .{ .x = 4, .y = 30 }, 16, 24));
    try std.testing.expect(!aimed(lifted, .{ .x = 4, .y = 30 }, 16, 36));
    // A card that covers the exit point has nothing to aim across.
    try std.testing.expect(!aimed(.{ .x = 2, .y = 4, .w = 82, .h = 24 }, exit, 3, 5));
}

test "process rows freeze by identity while their numbers can refresh" {
    var state: State = .{};
    var processes = [_]resources.Process{ .{ .pid = 1, .start = 10, .name = "first", .cpu = 90 }, .{ .pid = 2, .start = 20, .name = "second", .cpu = 10 } };
    const work: resources.Work = .{ .id = WorkspaceId.first, .known = true, .processes = &processes };
    state.update(work, true);
    processes[0].cpu = 0;
    processes[1].cpu = 100;
    state.update(work, true);
    try std.testing.expectEqual(@as(i32, 1), state.order[0].pid);
    state.update(work, false);
    try std.testing.expectEqual(@as(i32, 2), state.order[0].pid);
}
