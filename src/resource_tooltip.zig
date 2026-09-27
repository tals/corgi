//! Viewer-local resource card: three framed graphs and a stable mini top.
const std = @import("std");
const resources = @import("resources.zig");
const sidebar = @import("sidebar.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const Rect = @import("layout.zig").Rect;
const text = "\x1b[38;2;214;222;232m";
const muted = "\x1b[38;2;125;137;155m";
const rule = "\x1b[38;2;67;80;99m";
const blue = "\x1b[38;2;137;180;250m";
const mint = "\x1b[38;2;148;226;213m";
const violet = "\x1b[38;2;203;166;247m";
const warm = "\x1b[38;2;249;226;175m";

pub fn geometry(cols: u16, rows: u16, side: u16, anchor: u16) ?Rect {
    if (cols < 68 or rows < 22) return null;
    const w = @min(82, cols - 2);
    const h = @min(24, rows - 2);
    return .{ .x = @min(side, cols - w - 1), .y = @min(anchor, rows - h - 1), .w = w, .h = h };
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
            s.sort = if (work.memory_pressure) .memory else .cpu;
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
        if (y != rect.y + 14) return;
        if (x >= rect.x + rect.w - 17) s.sort = .io else if (x >= rect.x + rect.w - 24) s.sort = .memory else if (x >= rect.x + rect.w - 32) s.sort = .cpu else return;
        s.frozen = false;
    }
};

fn at(w: *std.Io.Writer, x: usize, y: usize, color: []const u8, value: []const u8, width: usize) !void {
    try w.print("\x1b[{d};{d}H{s}", .{ y + 1, x + 1, color });
    if (value.len == 0) return;
    var clean: [512]u8 = undefined;
    try sidebar.writeClipped(w, sidebar.directoryLabel(&clean, value, null), width);
}
fn right(w: *std.Io.Writer, x: usize, y: usize, color: []const u8, value: []const u8, width: usize) !void {
    try at(w, x + width -| @min(width, sidebar.displayWidth(value)), y, color, value, width);
}
fn box(w: *std.Io.Writer, rect: Rect, title: []const u8) !void {
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
    try at(w, rect.x + 2, rect.y, muted, title, rect.w - 4);
}
fn graph(w: *std.Io.Writer, rect: Rect, work: resources.Work, metric: resources.Sort, color: []const u8) !void {
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
    });
    try at(w, rect.x + 2, rect.y + 1, color, value, rect.w - 4);
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
            try at(w, rect.x + 2 + width - history.len + i, rect.y + rect.h - 2 - row, color, glyphs[fill], 1);
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

pub fn draw(w: *std.Io.Writer, rect: Rect, name: []const u8, snapshot: resources.Snapshot, state: State) !void {
    const work = snapshot.workspace(state.workspace orelse return);
    try w.writeAll("\x1b7\x1b]8;;\x1b\\\x1b[0;48;2;29;37;49m\x1b[?25l");
    for (0..rect.h) |row| {
        try w.print("\x1b[{d};{d}H", .{ rect.y + row + 1, rect.x + 1 });
        try w.splatByteAll(' ', rect.w);
    }
    var buf: [180]u8 = undefined;
    try box(w, rect, try std.fmt.bufPrint(&buf, " {s} / resources ", .{name}));
    const status = if (!work.known) "Sampling unavailable" else if (work.partial) "Partial process coverage" else if (work.cpu_pressure and work.memory_pressure) "CPU busy + memory pressure" else if (work.memory_pressure) "Memory pressure" else if (work.cpu_pressure) "CPU busy" else "";
    try at(w, rect.x + 2, rect.y + 1, if (work.cpu_pressure or work.memory_pressure) warm else text, status, rect.w - 20);
    try right(w, rect.x + rect.w - 16, rect.y + 1, muted, try std.fmt.bufPrint(&buf, "live / {d}s", .{snapshot.interval_ms / 1000}), 13);
    const gw = (rect.w - 6) / 3;
    inline for (.{ resources.Sort.cpu, resources.Sort.memory, resources.Sort.io }, 0..) |metric, i| {
        try graph(w, .{ .x = rect.x + 2 + @as(u16, i) * (gw + 1), .y = rect.y + 3, .w = gw, .h = 7 }, work, metric, switch (metric) {
            .cpu => if (work.cpu_pressure) warm else blue,
            .memory => if (work.memory_pressure) warm else mint,
            .io => violet,
        });
    }
    var cpu_buf: [24]u8 = undefined;
    var host_line = std.Io.Writer.fixed(&buf);
    try host_line.print("HOST {d} cores", .{snapshot.cores});
    if (snapshot.host_cpu != null) try host_line.print(" / {s} CPU", .{resources.cpuText(&cpu_buf, snapshot.host_cpu)});
    if (snapshot.memory_pressure != .unknown) try host_line.print(" / memory {s}", .{@tagName(snapshot.memory_pressure)});
    try at(w, rect.x + 2, rect.y + 11, muted, host_line.buffered(), rect.w - 4);
    try at(w, rect.x + 2, rect.y + 13, text, "TOP PROCESSES", 20);
    const header = rect.y + 14;
    try right(w, rect.x + 2, header, muted, "PID", 6);
    try at(w, rect.x + 10, header, muted, "PROCESS", 10);
    try at(w, rect.x + 21, header, muted, "ACTIVITY", rect.w - 54);
    try right(w, rect.x + rect.w - 32, header, if (state.sort == .cpu) blue else muted, "CPU %", 7);
    try right(w, rect.x + rect.w - 24, header, if (state.sort == .memory) mint else muted, "GiB", 6);
    try right(w, rect.x + rect.w - 17, header, if (state.sort == .io) violet else muted, "R MB/s", 7);
    try right(w, rect.x + rect.w - 9, header, if (state.sort == .io) violet else muted, "W MB/s", 7);
    const count = @min(state.count, rect.h -| 19);
    for (state.order[0..count], 0..) |key, i| {
        const y = header + 1 + i;
        const proc: ?resources.Process = for (work.processes) |p| {
            if (p.pid == key.pid and p.start == key.start) break p;
        } else null;
        try right(w, rect.x + 2, y, muted, try std.fmt.bufPrint(&buf, "{d}", .{key.pid}), 6);
        if (proc) |p| {
            try at(w, rect.x + 10, y, text, try std.fmt.bufPrint(&buf, "{s}{s}", .{ if (p.provider) |provider| (if (provider == .claude) "* " else "† ") else "", p.name }), 10);
            try at(w, rect.x + 21, y, if (p.hint) muted else mint, try std.fmt.bufPrint(&buf, "{s}{s}", .{ if (p.hint) "~" else "", p.activity }), rect.w - 54);
            try right(w, rect.x + rect.w - 32, y, blue, if (p.cpu) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{n}) else "", 7);
            try right(w, rect.x + rect.w - 24, y, mint, try std.fmt.bufPrint(&buf, "{d:.2}", .{@as(f64, @floatFromInt(p.memory)) / (1024 * 1024 * 1024)}), 6);
            try right(w, rect.x + rect.w - 17, y, violet, if (p.read) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{@as(f64, @floatFromInt(n)) / 1000000}) else "", 7);
            try right(w, rect.x + rect.w - 9, y, violet, if (p.written) |n| try std.fmt.bufPrint(&buf, "{d:.1}", .{@as(f64, @floatFromInt(n)) / 1000000}) else "", 7);
        } else try at(w, rect.x + 21, y, muted, "Sample not available", rect.w - 54);
    }
    try at(w, rect.x + 2, rect.y + rect.h - 3, muted, "* Claude Code   † Codex", rect.w - 4);
    try at(w, rect.x + 2, rect.y + rect.h - 2, muted, try std.fmt.bufPrint(&buf, "{d} local processes / {s}{s} / {d} shown", .{ work.count, snapshot.memory_kind, if (work.partial) " / partial" else "", count }), rect.w - 4);
    try w.writeAll("\x1b[0m\x1b8\x1b[?25l");
}

test "resource card stays within terminal bounds" {
    for ([_]u16{ 68, 88, 120, 200 }) |cols| for ([_]u16{ 24, 30, 40 }) |rows| {
        const rect = geometry(cols, rows, 28, rows - 1).?;
        try std.testing.expect(rect.x + rect.w < cols);
        try std.testing.expect(rect.y + rect.h < rows);
    };
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
