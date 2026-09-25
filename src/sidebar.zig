const std = @import("std");
const agents = @import("agents.zig");
const layout = @import("layout.zig");
const vt = @import("ghostty-vt");
const corgi_animation = @import("corgi_animation.zig");

pub const max_entries = layout.max_panes + 16;
pub const Target = union(enum) { pane: u32, native: u32 };
pub const Search = struct { text: []const u8, cursor: usize };
pub const Entry = struct {
    conversation: u32 = 0,
    children: usize = 0,
    exit: ?struct { frame_ms: i64, progress: f64 } = null,
    name: []const u8 = "",
    target: Target,
    provider: agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    focused: bool = false,
    cwd: []const u8 = "",
    tool_active: bool = false,
    compacting: bool = false,
    unread: bool = false,
    activity: []const u8 = "",
    subagents: agents.Subagents = .{},

    // Herdr's dot style and Catppuccin colors; finished attention is its
    // unseen-idle state. Corgi also retains ended native sessions.
    fn indicator(e: Entry) struct { icon: []const u8, color: []const u8 } {
        if (e.state == .done) return .{ .icon = "○", .color = "\x1b[38;2;108;112;134m" };
        if (e.state == .blocked or e.attention == .needs_input) return .{ .icon = "●", .color = "\x1b[38;2;243;139;168m" };
        if (e.state == .working) return .{ .icon = "●", .color = "\x1b[38;2;249;226;175m" };
        if (e.attention == .finished) return .{ .icon = "●", .color = "\x1b[38;2;148;226;213m" };
        if (e.state == .initializing) return .{ .icon = "●", .color = "\x1b[38;2;160;146;184m" };
        if (e.state == .idle) return .{ .icon = "○", .color = "\x1b[38;2;166;227;161m" };
        return .{ .icon = "·", .color = "\x1b[38;2;108;112;134m" };
    }
};

pub const WorkspaceEntry = struct { ports: @import("ports.zig").Snapshot = .{}, remote_links: bool = false, git_ahead: ?u64 = null, git_commits: []const @import("protocol.zig").GitCommit = &.{}, id: u32, name: []const u8, cwd: []const u8, active: bool, working: usize = 0, unread: usize = 0, attention: usize = 0, stats: @import("usage.zig").Counts = .{} };
pub const Hit = union(enum) { none, toggle, agent_new, agent_options, previous, next, entry: usize, workspace_new, workspace_previous, workspace_next, workspace: usize };
pub const View = struct {
    search: ?Search = null,
    corgi_badge: @import("corgi_badge.zig").Mode = .none,
    cols: u16,
    rows: u16,
    width: u16,
    count: usize,
    offset: usize,
    capacity: usize,
    workspace_count: usize = 0,
    workspace_offset: usize = 0,
    pub fn middle(v: View) u16 {
        return (v.rows -| 1) / 2;
    }
    pub fn workspaceCapacity(v: View) usize {
        return @max(1, (v.middle() -| 3) / 3);
    }
    pub fn withWorkspaces(v: View, count: usize, offset: usize) View {
        var result = v;
        result.workspace_count = count;
        result.workspace_offset = @min(offset, count -| v.workspaceCapacity());
        return result;
    }

    pub fn widthFor(cols: u16, open: bool) u16 {
        return if (open and cols >= 64) 28 else 0;
    }
    pub fn init(cols: u16, rows: u16, open: bool, offset: usize, count: usize) View {
        const capacity = @max(1, (rows -| ((rows -| 1) / 2) -| 4) / 2);
        return .{ .cols = cols, .rows = rows, .width = if (rows >= 13) widthFor(cols, open) else 0, .count = count, .capacity = capacity, .offset = @min(offset, count -| capacity) };
    }
    pub fn withWidth(v: View, preferred: u16) View {
        var result = v;
        if (result.width > 0) result.width = std.math.clamp(preferred, 20, v.cols - 20);
        return result;
    }
    pub fn withSearch(v: View, search: ?Search) View {
        var result = v;
        result.search = search;
        // Search opens the same sidebar on compact terminals too, while
        // preserving at least twenty columns for the terminal pane.
        if (search != null and v.cols >= 40 and v.rows >= 13) result.width = @min(28, v.cols - 20);
        return result;
    }
    pub fn searchOffset(v: View) usize {
        const search = v.search orelse return 0;
        return search.cursor -| (v.width -| 5);
    }
    pub fn searchCursor(v: View, w: *std.Io.Writer) !void {
        const search = v.search orelse return;
        if (v.width == 0) return;
        try w.print("\x1b[0m\x1b[{d};{d}H\x1b[?25h", .{ v.middle() + 2, 4 + search.cursor - v.searchOffset() });
    }
    pub fn area(v: View) layout.Rect {
        return .{ .x = v.width, .y = 1, .w = v.cols - v.width, .h = v.rows -| 2 };
    }
    pub fn tabX(v: View) u16 {
        return if (v.width > 0) v.width else if (v.cols >= 64) 3 else 0;
    }
    pub fn hit(v: View, x: u16, y: u16) Hit {
        if (v.width == 0) return if (v.cols >= 64 and x < 3 and y == 0) .toggle else .none;
        if (x >= v.width - 1 or y >= v.rows - 1) return .none;
        if (y == 0 and x >= v.width - 5) return .toggle;
        if (y == 0 and x >= v.width - 11 and x < v.width - 6) return .workspace_new;
        if (y == v.middle() and x >= v.width - 10 and x < v.width - 2) return if (x >= v.width - 4) .agent_options else .agent_new;
        if (y < v.middle()) {
            if (y == v.middle() - 2) {
                if (v.workspace_count > v.workspaceCapacity()) {
                    if (x >= v.width - 8 and x < v.width - 5) return .workspace_previous;
                    if (x >= v.width - 5 and x < v.width - 2) return .workspace_next;
                }
                return .none;
            }
            if (y < 2 or y >= v.middle() - 2) return .none;
            if ((y - 2) % 3 == 2) return .none;
            const index = (y - 2) / 3 + v.workspace_offset;
            return if (index < v.workspace_count and (y - 2) / 3 < v.workspaceCapacity()) .{ .workspace = index } else .none;
        }
        if (y == v.rows - 2 and v.count > v.capacity) return if (x < v.width / 2) .previous else .next;
        if (y < v.middle() + 2 or y >= v.rows - 2) return .none;
        const index = (y - v.middle() - 2) / 2;
        if (index >= v.capacity or v.offset + index >= v.count) return .none;
        return .{ .entry = v.offset + index };
    }
    pub fn unreadRange(v: View, ws: WorkspaceEntry) struct { start: usize, end: usize } {
        var buf: [40]u8 = undefined;
        const unread_width = displayWidth(compactCount(&buf, ws.unread)) + 7 + @as(usize, if (ws.unread > 0) 2 else 0);
        const metadata_width = statusMetadataWidth(ws);
        const attention_width = if (ws.attention > 0) displayWidth(compactCount(&buf, ws.attention)) + 1 else 0;
        const working_width = if (ws.working > 0) displayWidth(compactCount(&buf, ws.working)) + 1 else 1;
        const room = ((v.width -| 3) -| (metadata_width + 1)) -| (unread_width + 3);
        const slot = @max(3, working_width);
        const working = if (slot + attention_width <= room) slot else 0;
        const status_width = working + @min(attention_width, room - working);
        const start = 1 + status_width + @as(usize, if (working > 0 or attention_width > 0) 3 else 0);
        return .{ .start = start, .end = start + unread_width };
    }
    pub fn unreadHit(v: View, ws: WorkspaceEntry, x: u16, y: u16) bool {
        if (ws.unread == 0 or y < 3 or (y - 2) % 3 != 1) return false;
        const range = v.unreadRange(ws);
        return x >= range.start and x < range.end;
    }
    pub fn draw(v: View, w: *std.Io.Writer, entries: []const Entry, workspaces: []const WorkspaceEntry) !void {
        return v.drawAt(w, entries, workspaces, std.time.milliTimestamp());
    }
    fn drawAt(v: View, w: *std.Io.Writer, entries: []const Entry, workspaces: []const WorkspaceEntry, now_ms: i64) !void {
        corgi_animation.beginFrame();
        defer corgi_animation.endFrame();
        const thinking_frames = [_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
        const panel = "\x1b[0;38;2;155;163;175;48;2;24;27;32m";
        if (v.width == 0) {
            if (v.cols >= 64) try w.writeAll("\x1b[1;1H\x1b[1;38;2;161;194;178m > \x1b[0m");
            return;
        }
        for (0..v.rows - 1) |row| {
            try w.print("\x1b[{d};1H{s}", .{ row + 1, panel });
            try w.splatByteAll(' ', v.width - 1);
            try w.writeAll("\x1b[38;2;55;61;70m│");
        }
        try v.line(w, v.middle(), "agents", "\x1b[1;38;2;226;230;233m");
        if (v.search) |search| {
            try v.line(w, v.middle() + 1, "/ ", "\x1b[0;38;2;161;194;178;48;2;35;40;47m");
            try w.splatByteAll(' ', v.width - 5);
            try w.print("\x1b[{d};4H", .{v.middle() + 2});
            if (search.text.len == 0) try writeClipped(w, "type to search", v.width - 5) else try writeClipped(w, search.text[v.searchOffset()..], v.width - 5);
        } else try w.print("\x1b[{d};{d}H\x1b[0;1;38;2;161;194;178;48;2;35;40;47m New  ▾ {s}", .{ v.middle() + 1, v.width - 9, panel });
        try w.print("\x1b[1;{d}H{s} < ", .{ v.width - 4, panel });
        if (v.corgi_badge != .none) {
            if (v.corgi_badge == .emoji) try w.print("\x1b[1;2H{s}{s}", .{ panel, @import("corgi_badge.zig").emoji });
            try w.writeAll("\x1b[1;6H\x1b[1;38;2;226;230;233m");
            try writeEllipsis(w, "workspaces", v.width -| 17);
        } else try v.line(w, 0, "workspaces", "\x1b[1;38;2;226;230;233m");
        try w.print("\x1b[1;{d}H\x1b[0;1;38;2;161;194;178;48;2;35;40;47m[ + ]{s}", .{ v.width - 10, panel });
        for (workspaces[v.workspace_offset..@min(workspaces.len, v.workspace_offset + v.workspaceCapacity())], 0..) |ws, index| {
            const y: u16 = @intCast(2 + index * 3);
            const style = if (ws.active) "\x1b[1;38;2;161;194;178;48;2;35;40;47m" else panel;
            try w.print("\x1b[{d};1H{s}", .{ y + 1, style });
            try w.splatByteAll(' ', v.width - 1);
            var label: [std.fs.max_path_bytes + 1]u8 = undefined;
            var badge_buf: [32]u8 = undefined;
            var number: [24]u8 = undefined;
            const badge = if (ws.git_ahead) |n| if (n > 0) try std.fmt.bufPrint(&badge_buf, "↑{s}", .{compactCount(&number, n)}) else "" else "";
            const badge_width = displayWidth(badge);
            try w.print("\x1b[{d};2H{s}", .{ y + 1, style });
            const link = linkRange(v, ws, workspaces);
            try writeClipped(w, directoryLabel(&label, ws.name, null), link.start -| 2);
            if (link.end > link.start) {
                try w.print("\x1b[{d};{d}H", .{ y + 1, link.start + 1 });
                try drawPorts(w, ws, link.end - link.start, false);
            }
            if (badge_width > 0) try w.print("\x1b[{d};{d}H\x1b[38;2;166;227;161m{s}", .{ y + 1, v.width - 1 - badge_width, badge });
            try w.print("\x1b[{d};2H{s}", .{ y + 2, panel });
            var metadata_buf: [96]u8 = undefined;
            var tools_buf: [24]u8 = undefined;
            const tools = compactCount(&tools_buf, ws.stats.tools);
            var unread_buf: [40]u8 = undefined;
            var attention_buf: [24]u8 = undefined;
            var number_buf: [24]u8 = undefined;
            const unread = try std.fmt.bufPrint(&unread_buf, "{s} unread{s}", .{ compactCount(&number_buf, ws.unread), if (ws.unread > 0) " →" else "" });
            const attention = if (ws.attention > 0) try std.fmt.bufPrint(&attention_buf, "{s}●", .{compactCount(&number_buf, ws.attention)}) else "";
            const unread_width = displayWidth(unread);
            const attention_width = displayWidth(attention);
            const metadata = try std.fmt.bufPrint(&metadata_buf, "{s}⚒", .{tools});
            const metadata_width = displayWidth(metadata);
            const left_room = (v.width - 3) -| (statusMetadataWidth(ws) + 1);
            var room: usize = left_room -| (unread_width + 3);
            var text_buf: [96]u8 = undefined;
            var has_status = false;
            {
                const text = if (ws.working == 0) "○" else try std.fmt.bufPrint(&text_buf, "{s}●", .{compactCount(&number_buf, ws.working)});
                const text_width = displayWidth(text);
                const slot_width = @max(3, text_width);
                if (slot_width + attention_width <= room) {
                    try w.splatByteAll(' ', slot_width - text_width);
                    room -= slot_width - text_width;
                    try statusPart(w, text, if (ws.working > 0) "\x1b[38;2;249;226;175m" else "\x1b[38;2;166;227;161m", &room);
                    has_status = true;
                }
            }
            if (attention_width > 0) {
                try statusPart(w, attention, "\x1b[1;38;2;243;139;168m", &room);
                has_status = true;
            }
            if (has_status) try w.writeAll("\x1b[22;38;2;90;97;108m · ");
            try w.print("\x1b[{d};{d}H", .{ y + 2, v.unreadRange(ws).start + 1 });
            var unread_room = unread_width;
            try statusPart(w, unread, if (ws.unread > 0) "\x1b[1;38;2;148;226;213m" else panel, &unread_room);
            if (ws.stats.tools > 0) try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 2, v.width - 1 - metadata_width, panel, metadata });
            try w.writeAll(panel);
            if (y + 2 < v.middle() - 2) {
                try w.print("\x1b[{d};2H{s}", .{ y + 3, panel });
                const divider = index + 1 < @min(workspaces.len - v.workspace_offset, v.workspaceCapacity());
                if (divider) {
                    try w.writeAll("\x1b[4;58:2::65:70:77m");
                    try w.splatByteAll(' ', v.width - 3);
                    try w.print("\x1b[{d};2H", .{y + 3});
                }
                try w.writeAll("\x1b[24;59m");
            }
        }
        if (v.workspace_count > v.workspaceCapacity()) {
            try w.print("\x1b[{d};{d}H{s} <  > ", .{ v.middle() - 1, v.width - 7, panel });
        }
        try w.print("\x1b[{d};2H{s}\x1b[38;2;55;61;70m", .{ v.middle(), panel });
        for (0..v.width - 3) |_| try w.writeAll("─");
        if (entries.len == 0) {
            try v.line(w, v.middle() + 2, if (v.search != null) "No matching agents" else "No agents yet", panel);
            if (v.search == null) {
                try v.line(w, v.middle() + 4, "Launch inside a pane:", panel);
                try v.line(w, v.middle() + 5, "codex  or  claude", panel);
            }
        }
        for (entries[v.offset..@min(entries.len, v.offset + v.capacity)], 0..) |e, index| {
            var exit_buffer: [16384]u8 = undefined;
            var exit_writer = std.Io.Writer.fixed(&exit_buffer);
            const row_writer = if (e.exit != null) &exit_writer else w;
            const frame_ms = if (e.exit) |closing| closing.frame_ms else now_ms;
            const frame_index: usize = @intCast(@mod(@divFloor(frame_ms, 80), thinking_frames.len));
            const y: u16 = @intCast(v.middle() + 2 + index * 2);
            const bg = if (e.focused) "\x1b[48;2;35;40;47m" else "\x1b[48;2;24;27;32m";
            for (0..2) |row| {
                if (y + row >= v.rows - 2) break;
                try row_writer.print("\x1b[{d};1H\x1b[0m{s}", .{ y + row + 1, bg });
                try row_writer.splatByteAll(' ', v.width - 1);
            }
            const dot = e.indicator();
            try row_writer.print("\x1b[{d};2H\x1b[22m{s}{s}\x1b[{d};5H\x1b[1;38;2;226;230;233m", .{ y + 1, dot.color, dot.icon, y + 1 });
            const room = v.width - 6;
            const divider = index + 1 < @min(entries.len - v.offset, v.capacity);
            const underline = if (divider) "\x1b[4;58:2::65:70:77m" else "";
            const compacting = e.state == .working and e.compacting;
            const waiting = e.state == .working and e.subagents.waiting and !compacting;
            const activity = if (waiting) "◷" else if (e.tool_active and (e.state == .working or e.state == .blocked)) "🔧" else if (e.state == .working) thinking_frames[frame_index] else "";
            var name: [160]u8 = undefined;
            const provider = if (e.name.len > 0) directoryLabel(&name, e.name, null) else @tagName(e.provider);
            try row_writer.print("\x1b[{d};5H\x1b[22;38;2;226;230;233m", .{y + 1});
            try writeEllipsis(row_writer, provider, room);
            // Underline the existing second row, including its padding, without
            // consuming another terminal row or changing the entry hit area.
            try row_writer.print("\x1b[{d};2H{s}", .{ y + 2, underline });
            try row_writer.splatByteAll(' ', v.width - 3);
            try row_writer.print("\x1b[{d};2H\x1b[22;38;2;125;132;143m{s}\x1b[{d};5H\x1b[38;2;226;230;233m", .{ y + 2, activity, y + 2 });
            var clean: [512]u8 = undefined;
            const detail = if (compacting) "Compacting…" else if (waiting) "Waiting on agents" else switch (e.state) {
                .working => e.activity,
                .blocked => "Needs input",
                .initializing => "Starting session",
                .done => "Session ended",
                else => "",
            };
            var badge_buf: [48]u8 = undefined;
            const badge = subagentBadge(&badge_buf, e.subagents, e.children);
            const badge_width = displayWidth(badge);
            const detail_room = room -| (badge_width + @as(usize, if (badge_width > 0) 1 else 0));
            const animation_seed: u64 = switch (e.target) {
                .pane => |id| @as(u64, id) * 17,
                .native => |id| (@as(u64, id) + 0x100000000) * 17,
            };
            const fallback = e.state == .working and !compacting and !waiting and e.activity.len == 0;
            const mode: corgi_animation.Mode = if (fallback) .awake else if (e.state == .idle) .asleep else .content;
            const presentation = corgi_animation.observe(animation_seed, mode, frame_ms);
            if (mode != .content) {
                try presentation.?.writeCorgi(row_writer, detail_room, animation_seed, e.focused, e.state == .working);
            } else {
                // Lifecycle signals (blocked/ended/etc.) must be immediate.
                // Interrupts already switch straight to the sleeping mode.
                if (e.state != .working) if (presentation) |p| p.skipReveal();
                const text = directoryLabel(&clean, detail, null);
                if (presentation != null and presentation.?.reveal_started_ms != null) {
                    try presentation.?.writeCorgi(row_writer, detail_room, animation_seed, e.focused, e.state == .working);
                    try row_writer.print("\x1b[{d};5H\x1b[38;2;226;230;233m", .{y + 2});
                    try writeRevealedDetail(row_writer, text, detail_room, presentation.?.revealedColumns(detail_room, frame_ms), presentation.?.revealPosition(detail_room, frame_ms));
                } else try writeEllipsis(row_writer, text, detail_room);
            }
            if (badge_width > 0) {
                const color = if (e.subagents.blocked > 0) "\x1b[38;2;243;139;168m" else "\x1b[38;2;148;226;213m";
                try row_writer.print("\x1b[{d};{d}H{s}{s}", .{ y + 2, v.width - 1 - badge_width, color, badge });
            }
            try row_writer.writeAll("\x1b[24;59m");
            if (e.exit) |closing| try writeExit(w, exit_writer.buffered(), closing.progress);
        }
        if (v.search != null) {
            try v.line(w, v.rows - 2, "↑↓  ↵ jump  Esc back", panel);
        } else if (v.count > v.capacity) {
            var text: [64]u8 = undefined;
            const footer = try std.fmt.bufPrint(&text, "< {d}-{d}/{d} >", .{ v.offset + 1, @min(v.count, v.offset + v.capacity), v.count });
            try v.line(w, v.rows - 2, footer, panel);
        }
        try w.writeAll("\x1b[0m");
    }
    fn line(v: View, w: *std.Io.Writer, y: u16, text: []const u8, style: []const u8) !void {
        if (y >= v.rows - 1) return;
        try w.print("\x1b[{d};2H{s}", .{ y + 1, style });
        try writeClipped(w, text, v.width - 3);
    }
};

fn subagentBadge(buf: []u8, status: agents.Subagents, children: usize) []const u8 {
    var running_buf: [24]u8 = undefined;
    var blocked_buf: [24]u8 = undefined;
    const running = compactCount(&running_buf, status.running);
    const blocked = compactCount(&blocked_buf, status.blocked);
    if (status.blocked > 0) return if (status.running > 0)
        std.fmt.bufPrint(buf, "↳{s} !{s}", .{ running, blocked }) catch unreachable
    else
        std.fmt.bufPrint(buf, "↳!{s}", .{blocked}) catch unreachable;
    if (status.running > 0) return std.fmt.bufPrint(buf, "↳{s}", .{running}) catch unreachable;
    if (children > 0) return std.fmt.bufPrint(buf, "↳{s}", .{compactCount(&running_buf, children)}) catch unreachable;
    return "";
}

pub fn agentAt(v: View, entries: []const Entry, x: u16, y: u16) ?*const Entry {
    const hit = v.hit(x, y);
    if (hit != .entry or hit.entry >= entries.len) return null;
    const entry = &entries[hit.entry];
    return if (entry.exit == null) entry else null;
}

// Fade both the card background and its foreground/underline colors into the
// sidebar panel. All cursor positions and glyphs stay fixed until removal.
fn writeExit(w: *std.Io.Writer, frame: []const u8, progress: f64) !void {
    const t = std.math.clamp(progress, 0, 1);
    const opacity = 1 - t * t * (3 - 2 * t);
    var i: usize = 0;
    while (i < frame.len) {
        if (std.mem.startsWith(u8, frame[i..], "\x1b[")) {
            var end = i + 2;
            while (end < frame.len and (frame[end] < 0x40 or frame[end] > 0x7e)) : (end += 1) {}
            if (end < frame.len and frame[end] == 'm') {
                try w.writeAll("\x1b[");
                var p = i + 2;
                while (p < end) {
                    const prefix: ?[]const u8 = for ([_][]const u8{ "38;2;", "48;2;", "58:2::" }) |candidate| {
                        if (std.mem.startsWith(u8, frame[p..end], candidate)) break candidate;
                    } else null;
                    if (prefix) |color_prefix| {
                        const separator: u8 = if (color_prefix[2] == ':') ':' else ';';
                        var cursor = p + color_prefix.len;
                        var color: [3]u8 = undefined;
                        var valid = true;
                        for (&color, [_]u8{ 24, 27, 32 }, 0..) |*channel, background, n| {
                            const start = cursor;
                            while (cursor < end and std.ascii.isDigit(frame[cursor])) : (cursor += 1) {}
                            const value = std.fmt.parseInt(u8, frame[start..cursor], 10) catch {
                                valid = false;
                                break;
                            };
                            channel.* = @intFromFloat(@round(@as(f64, @floatFromInt(background)) +
                                (@as(f64, @floatFromInt(value)) - @as(f64, @floatFromInt(background))) * opacity));
                            if (n < 2) {
                                if (cursor >= end or frame[cursor] != separator) {
                                    valid = false;
                                    break;
                                }
                                cursor += 1;
                            }
                        }
                        if (valid) {
                            try w.print("{s}{d}{c}{d}{c}{d}", .{ color_prefix, color[0], separator, color[1], separator, color[2] });
                            p = cursor;
                            continue;
                        }
                    }
                    try w.writeByte(frame[p]);
                    p += 1;
                }
                try w.writeByte('m');
                i = end + 1;
                continue;
            }
        }
        try w.writeByte(frame[i]);
        i += 1;
    }
}

fn statusPart(w: *std.Io.Writer, text: []const u8, style: []const u8, room: *usize) !void {
    try w.writeAll("\x1b[22m");
    try w.writeAll(style);
    try writeClipped(w, text, room.*);
    room.* -|= displayWidth(text);
}
fn compactCount(buf: []u8, value: u64) []const u8 {
    if (value < 1000) return std.fmt.bufPrint(buf, "{d}", .{value}) catch unreachable;
    for ([_]u64{ 1_000_000_000_000_000_000, 1_000_000_000_000_000, 1_000_000_000_000, 1_000_000_000, 1_000_000, 1_000 }, "EPTGMk") |scale, suffix| {
        if (value >= scale) return std.fmt.bufPrint(buf, "{d}{c}", .{ value / scale, suffix }) catch unreachable;
    }
    unreachable;
}

pub fn displayWidth(text: []const u8) usize {
    var it = (std.unicode.Utf8View.init(text) catch unreachable).iterator();
    var width: usize = 0;
    while (it.nextCodepoint()) |cp| width += vt.unicode.codepointWidth(cp);
    return width;
}
pub fn writeClipped(w: *std.Io.Writer, text: []const u8, room: usize) !void {
    var it = (try std.unicode.Utf8View.init(text)).iterator();
    var used: usize = 0;
    while (it.nextCodepointSlice()) |bytes| {
        used += vt.unicode.codepointWidth(try std.unicode.utf8Decode(bytes));
        if (used > room) break;
        try w.writeAll(bytes);
    }
}

pub fn writeEllipsis(w: *std.Io.Writer, text: []const u8, room: usize) !void {
    if (displayWidth(text) <= room) return w.writeAll(text);
    if (room == 0) return;
    try writeClipped(w, text, room - 1);
    try w.writeAll("…");
}
// Clip the final (already ellipsized) text, so the ellipsis does not move with
// the wipe. Opaque padding covers the old dog even for a short/empty label.
fn writeRevealedDetail(w: *std.Io.Writer, text: []const u8, room: usize, revealed: usize, edge: ?f64) !void {
    var buffer: [2048]u8 = undefined;
    var final = std.Io.Writer.fixed(&buffer);
    try writeEllipsis(&final, text, room);
    var it = (try std.unicode.Utf8View.init(final.buffered())).iterator();
    var used: usize = 0;
    const limit = @min(room, revealed);
    while (it.nextCodepointSlice()) |bytes| {
        const width = vt.unicode.codepointWidth(try std.unicode.utf8Decode(bytes));
        if (used + width > limit) break;
        if (edge) |position| {
            // The three cells behind the edge brighten continuously between
            // column steps; smoothstep avoids a sudden brightness jump.
            const t = std.math.clamp((position - @as(f64, @floatFromInt(used + width))) / corgi_animation.Presentation.reveal_feather, 0, 1);
            const amount = t * t * (3 - 2 * t);
            var color: [3]u8 = undefined;
            for ([_]u8{ 108, 112, 134 }, [_]u8{ 226, 230, 233 }, &color) |dim, bright, *channel| {
                channel.* = @intFromFloat(@round(@as(f64, @floatFromInt(dim)) + @as(f64, @floatFromInt(bright - dim)) * amount));
            }
            try w.print("\x1b[38;2;{d};{d};{d}m", .{ color[0], color[1], color[2] });
        }
        try w.writeAll(bytes);
        used += width;
    }
    try w.splatByteAll(' ', limit - used);
    if (edge != null) try w.writeAll("\x1b[38;2;226;230;233m");
}

// Keep the root and the longest whole-component suffix that fits.
fn writeDirectory(w: *std.Io.Writer, path: []const u8, room: usize) !void {
    if (displayWidth(path) <= room) return w.writeAll(path);
    const prefix: []const u8 = if (std.mem.startsWith(u8, path, "~/")) "~/.../" else if (std.mem.startsWith(u8, path, "/")) "/.../" else ".../";
    if (room <= prefix.len) return writeClipped(w, path, room);
    var tail = path;
    while (std.mem.indexOfScalar(u8, tail, '/')) |slash| {
        tail = tail[slash + 1 ..];
        if (prefix.len + displayWidth(tail) <= room) {
            try w.writeAll(prefix);
            return w.writeAll(tail);
        }
    }
    try w.writeAll(prefix);
    // A single oversized filename still keeps its end and complete codepoints.
    var width = displayWidth(tail);
    while (tail.len > 0 and width > room - prefix.len - 1) {
        const n = std.unicode.utf8ByteSequenceLength(tail[0]) catch unreachable;
        width -= vt.unicode.codepointWidth(std.unicode.utf8Decode(tail[0..n]) catch unreachable);
        tail = tail[n..];
    }
    try w.writeAll("…");
    try w.writeAll(tail);
}
pub fn directoryLabel(out: []u8, cwd: []const u8, home_dir: ?[]const u8) []const u8 {
    var source = if (cwd.len == 0) "?" else cwd;
    var len: usize = 0;
    if (home_dir) |home| {
        if (home.len > 0 and std.mem.startsWith(u8, source, home) and (source.len == home.len or source[home.len] == '/')) {
            out[0] = '~';
            len = 1;
            source = source[home.len..];
        }
    }
    // Paths may contain control characters or invalid UTF-8. Never let them
    // inject terminal escapes, and keep complete codepoints when clipping.
    while (source.len > 0 and len < out.len) {
        const n = std.unicode.utf8ByteSequenceLength(source[0]) catch 1;
        const cp = if (n <= source.len) std.unicode.utf8Decode(source[0..n]) catch 0 else 0;
        const valid = cp >= 32 and !(cp >= 127 and cp <= 159);
        const count = if (valid) n else 1;
        if (len + count > out.len) break;
        if (valid) @memcpy(out[len..][0..count], source[0..count]) else out[len] = '?';
        len += count;
        source = source[@min(source.len, if (cp == 0) 1 else n)..];
    }
    return out[0..len];
}

test "directory labels keep path boundaries, Unicode and terminal safety" {
    var buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings("~/dev/corgi", directoryLabel(&buf, "/home/tal/dev/corgi", "/home/tal"));
    try std.testing.expectEqualStrings("/home/tally", directoryLabel(&buf, "/home/tally", "/home/tal"));
    try std.testing.expectEqualStrings("~/项目", directoryLabel(&buf, "/home/tal/项目", "/home/tal"));
    try std.testing.expectEqualStrings("/tmp/?[2J?oops", directoryLabel(&buf, "/tmp/\x1b[2J\noops", null));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeClipped(&output.writer, "ab项目", 5);
    try std.testing.expectEqualStrings("ab项", output.written());
}

test "compact paths preserve root and folder within column budget" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeDirectory(&output.writer, "~/dev/personal/corgi", 15);
    try std.testing.expectEqualStrings("~/.../corgi", output.written());
    output.clearRetainingCapacity();
    try writeDirectory(&output.writer, "/very/long/parent/项目", 12);
    try std.testing.expectEqualStrings("/.../项目", output.written());
    output.clearRetainingCapacity();
    try writeDirectory(&output.writer, "~/extraordinarilylongfolder", 14);
    try std.testing.expect(displayWidth(output.written()) <= 14);
    try std.testing.expect(std.mem.endsWith(u8, output.written(), "folder"));
}

test "compact workspace rows, spacers and bottom bar have distinct click targets" {
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(2, 0);
    try std.testing.expectEqual(Hit{ .workspace = 0 }, view.hit(24, 2));
    try std.testing.expectEqual(Hit{ .workspace = 0 }, view.hit(24, 3));
    try std.testing.expectEqual(Hit.none, view.hit(24, 4));
    try std.testing.expectEqual(Hit{ .workspace = 1 }, view.hit(24, 5));
    try std.testing.expectEqual(Hit{ .workspace = 1 }, view.hit(24, 6));
    try std.testing.expectEqual(Hit.none, view.hit(24, 7));
    try std.testing.expectEqual(Hit.none, view.hit(2, 12));
    try std.testing.expectEqual(Hit.none, view.hit(2, 13));
    try std.testing.expectEqual(Hit.workspace_new, view.hit(17, 0));
    try std.testing.expectEqual(Hit.workspace_new, view.hit(21, 0));
    try std.testing.expectEqual(Hit.none, view.hit(22, 0));
    try std.testing.expectEqual(Hit.toggle, view.hit(23, 0));
    try std.testing.expectEqual(@as(u16, 0), View.init(100, 12, true, 0, 0).width);
    const compact = View.init(100, 13, true, 0, 0).withWorkspaces(2, 0);
    try std.testing.expectEqual(Hit{ .workspace = 0 }, compact.hit(24, 3));
    try std.testing.expectEqual(Hit.none, compact.hit(2, 4));
    try std.testing.expectEqual(Hit.workspace_previous, compact.hit(21, 4));
    try std.testing.expectEqual(Hit.workspace_next, compact.hit(24, 4));
    try std.testing.expectEqual(Hit.none, compact.hit(24, 5));
    const paged = view.withWorkspaces(8, 99);
    try std.testing.expectEqual(@as(usize, 3), paged.workspaceCapacity());
    try std.testing.expectEqual(@as(usize, 5), paged.workspace_offset);
    try std.testing.expectEqual(Hit{ .workspace = 7 }, paged.hit(24, 9));
    try std.testing.expectEqual(Hit.workspace_next, paged.hit(24, 12));
}

test "unpushed badge retains its columns beside a long workspace name" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
    const entries = [_]WorkspaceEntry{.{ .id = 1, .name = "abcdefghijklmnopqrstuvwxyz", .cwd = "/tmp", .active = true, .git_ahead = 123 }};
    try view.draw(&output.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "abcdefghijklmnopqrst") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "abcdefghijklmnopqrstu") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[3;23H\x1b[38;2;166;227;161m↑123") != null);
}

test "subagent badge shares the second row without reserving empty space" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var entry: Entry = .{ .target = .{ .pane = 1 }, .name = "Long agent title", .provider = .codex, .state = .working, .attention = .none, .activity = "abcdefghijklmnopqrstuv", .subagents = .{ .running = 2, .waiting = true } };
    for ([_]u16{ 20, 28, 40 }) |width| {
        const view = View.init(100, 30, true, 0, 1).withWidth(width);
        try view.draw(&output.writer, &.{entry}, &.{});
        var expected: [100]u8 = undefined;
        const position = try std.fmt.bufPrint(&expected, "\x1b[18;{d}H\x1b[38;2;148;226;213m↳2", .{width - 3});
        try std.testing.expect(std.mem.indexOf(u8, output.written(), position) != null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "Waiting on") != null);
        try std.testing.expectEqual(Hit{ .entry = 0 }, view.hit(width - 3, 17));
        output.clearRetainingCapacity();
    }
    entry.subagents = .{};
    try View.init(100, 30, true, 0, 1).draw(&output.writer, &.{entry}, &.{});
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "↳") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), entry.activity) != null);
}

test "workspace status uses agent colors and keeps usage on its second row" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
    const entries = [_]WorkspaceEntry{.{ .id = 1, .name = "Project", .cwd = "/tmp", .active = false, .working = 1, .attention = 2, .unread = 3, .stats = .{ .tools = 12, .input = 1200, .output = 300, .tokens_known = true } }};
    try view.draw(&output.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), " \x1b[22m\x1b[38;2;249;226;175m1●") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;243;139;168m2●") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;148;226;213m3 unread →") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "12⚒") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;24H\x1b[0;38;2;155;163;175;48;2;24;27;32m12⚒") != null);
    output.clearRetainingCapacity();
    const empty = [_]WorkspaceEntry{.{ .id = 1, .name = "Project", .cwd = "/tmp", .active = true }};
    try view.draw(&output.writer, &.{}, &empty);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0 unread") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0●") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0⚒") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "  \x1b[22m\x1b[38;2;166;227;161m○") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "—") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;25H\x1b[0;38;2;155;163;175;48;2;24;27;32m0⚒") == null);
    output.clearRetainingCapacity();
    var away = empty;
    away[0].active = false;
    away[0].stats = .{ .tools = 1, .input = 100, .output = 20, .tokens_known = true };
    try view.draw(&output.writer, &.{}, &away);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0 unread") != null);
    output.clearRetainingCapacity();
    away[0].working = 1;
    away[0].attention = 1;
    away[0].stats = .{ .tools = 999_000, .input = 999_000, .output = 999_000, .tokens_known = true };
    try view.draw(&output.writer, &.{}, &away);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0 unread") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;243;139;168m1●") != null);
}

test "unread label and arrow share their hit area across sidebar widths" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var ws: WorkspaceEntry = .{ .id = 1, .name = "Project", .cwd = "/tmp", .active = false, .unread = 3, .working = 1, .attention = 2 };
    for ([_]u16{ 20, 28, 40 }) |width| {
        const view = View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0);
        output.clearRetainingCapacity();
        try view.draw(&output.writer, &.{}, &.{ws});
        const range = view.unreadRange(ws);
        var expected: [100]u8 = undefined;
        const label = try std.fmt.bufPrint(&expected, "\x1b[4;{d}H\x1b[22m\x1b[1;38;2;148;226;213m3 unread →", .{range.start + 1});
        try std.testing.expect(std.mem.indexOf(u8, output.written(), label) != null);
        try std.testing.expect(view.unreadHit(ws, @intCast(range.start), 3));
        try std.testing.expect(view.unreadHit(ws, @intCast(range.end - 1), 3));
        try std.testing.expect(!view.unreadHit(ws, @intCast(range.start - 1), 3));
        try std.testing.expect(!view.unreadHit(ws, @intCast(range.end), 3));
        try std.testing.expect(!view.unreadHit(ws, @intCast(range.start), 2));
    }
    ws.unread = 0;
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
    try std.testing.expect(!view.unreadHit(ws, @intCast(view.unreadRange(ws).start), 3));
}

test "compaction occupies the second agent row ahead of waiting and summaries" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const entry: Entry = .{ .target = .{ .pane = 1 }, .name = "Agent title", .provider = .codex, .state = .working, .attention = .none, .compacting = true, .activity = "Old summary", .subagents = .{ .waiting = true } };
    try View.init(100, 30, true, 0, 1).draw(&output.writer, &.{entry}, &.{});
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[18;5H\x1b[38;2;226;230;233mCompacting…") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Old summary") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Waiting on agents") == null);
}

// OSC 8 belongs to the outer terminal: its usual link gesture opens the URL.
fn drawPorts(w: *std.Io.Writer, ws: WorkspaceEntry, width: usize, divider: bool) !void {
    var buf: [256]u8 = undefined;
    _ = try portLine(w, ws, width, null, &buf, divider);
}

fn gitColumn(workspaces: []const WorkspaceEntry) usize {
    var width: usize = 4;
    for (workspaces) |ws| if (ws.git_ahead) |n| {
        var buf: [24]u8 = undefined;
        width = @max(width, 1 + displayWidth(compactCount(&buf, n)));
    };
    return width;
}
fn linkRange(v: View, ws: WorkspaceEntry, workspaces: []const WorkspaceEntry) struct { start: usize, end: usize } {
    const count = urlCount(ws);
    var buf: [96]u8 = undefined;
    const label = portLabel(ws, &buf);
    const end = (v.width -| 2) -| gitColumn(workspaces);
    const width = if (count > 0) @min(displayWidth(label), end -| 4) else 0;
    return .{ .start = end - width, .end = end };
}
/// Resolve names through the same deduplicated URL selection used by clicks.
pub fn workspaceUrlName(ws: WorkspaceEntry, index: usize) []const u8 {
    var target_buf: [256]u8 = undefined;
    const target = workspaceUrl(ws, index, &target_buf) orelse return "";
    for (ws.ports.workspace(ws.id).endpoints) |endpoint| {
        var candidate_buf: [256]u8 = undefined;
        const candidate = @import("ports.zig").url(&candidate_buf, endpoint, ws.remote_links) orelse continue;
        if (std.mem.eql(u8, target, candidate) and endpoint.label.len > 0) return endpoint.label;
    }
    return "";
}
fn workspaceUrlPending(ws: WorkspaceEntry, index: usize) bool {
    if (workspaceUrlName(ws, index).len > 0) return false;
    var target_buf: [256]u8 = undefined;
    const target = workspaceUrl(ws, index, &target_buf) orelse return false;
    for (ws.ports.workspace(ws.id).endpoints) |endpoint| {
        var candidate_buf: [256]u8 = undefined;
        const candidate = @import("ports.zig").url(&candidate_buf, endpoint, ws.remote_links) orelse continue;
        if (std.mem.eql(u8, target, candidate) and endpoint.label_pending) return true;
    }
    return false;
}
fn portPending(ws: WorkspaceEntry) bool {
    for (0..urlCount(ws)) |i| if (workspaceUrlPending(ws, i)) return true;
    return false;
}
fn portLabel(ws: WorkspaceEntry, buf: []u8) []const u8 {
    const count = urlCount(ws);
    var name = workspaceUrlName(ws, 0);
    // A common name is useful for duplicate app endpoints; distinct apps keep
    // the generic chooser label and their individual names inside the menu.
    for (1..@max(1, count)) |i| if (!std.mem.eql(u8, name, workspaceUrlName(ws, i))) {
        name = "";
        break;
    };
    if (name.len == 0) name = if (portPending(ws)) "..." else "Link";
    return if (count == 1) std.fmt.bufPrint(buf, "Open {s} ↗", .{name}) catch "Open Link ↗" else std.fmt.bufPrint(buf, "Open {s} ↗ {d}", .{ name, count }) catch "Open Link ↗";
}
/// Keep all three dots in place; only their blue intensity travels gently.
/// Quantized to 80ms so idle viewers do not emit a different frame every poll.
fn writePortLabel(w: *std.Io.Writer, label: []const u8, width: usize, pending: bool, now_ms: i64) !void {
    if (!pending or !std.mem.startsWith(u8, label, "Open ...")) return writeClipped(w, label, width);
    try writeClipped(w, "Open ", width);
    for (0..@min(3, width -| 5)) |i| {
        const phase = @mod(@divFloor(now_ms, 80) * 80 - @as(i64, @intCast(i)) * 160, 1800);
        const glow: u32 = if (phase < 640) @intCast(320 - @abs(phase - 320)) else 0;
        try w.print("\x1b[38;2;{d};{d};{d}m.", .{ 125 + glow * 45 / 320, 164 + glow * 35 / 320, 220 + glow * 25 / 320 });
    }
    try w.writeAll("\x1b[38;2;137;180;250m");
    if (width > 8) try writeClipped(w, label[8..], width - 8);
}
fn statusMetadataWidth(ws: WorkspaceEntry) usize {
    var buf: [24]u8 = undefined;
    return displayWidth(compactCount(&buf, ws.stats.tools)) + 1;
}
pub fn portLink(v: View, workspaces: []const WorkspaceEntry, x: u16, y: u16, buf: []u8) ?[]const u8 {
    const ws = portWorkspace(v, workspaces, x, y) orelse return null;
    return if (urlCount(ws) == 1) workspaceUrl(ws, 0, buf) else null;
}

// Only confirmed browser URLs participate; duplicate binds collapse to one link.
pub fn workspaceUrl(ws: WorkspaceEntry, wanted: usize, buf: []u8) ?[]const u8 {
    const ports = @import("ports.zig");
    const endpoints = ws.ports.workspace(ws.id).endpoints;
    var count: usize = 0;
    for (endpoints, 0..) |endpoint, i| {
        const target = ports.url(buf, endpoint, ws.remote_links) orelse continue;
        var duplicate = false;
        for (endpoints[0..i]) |previous| {
            var other_buf: [256]u8 = undefined;
            if (ports.url(&other_buf, previous, ws.remote_links)) |other| {
                if (std.mem.eql(u8, target, other)) {
                    duplicate = true;
                    break;
                }
            }
        }
        if (duplicate) continue;
        if (count == wanted) return target;
        count += 1;
    }
    return null;
}
pub fn urlCount(ws: WorkspaceEntry) usize {
    var buf: [256]u8 = undefined;
    var count: usize = 0;
    while (workspaceUrl(ws, count, &buf) != null) : (count += 1) {}
    return count;
}
pub fn portWorkspace(v: View, workspaces: []const WorkspaceEntry, x: u16, y: u16) ?WorkspaceEntry {
    if (v.width == 0 or x < 1 or y < 2 or y >= v.middle() - 2 or (y - 2) % 3 != 0) return null;
    const offset = (y - 2) / 3;
    const index = v.workspace_offset + offset;
    if (offset >= v.workspaceCapacity() or index >= workspaces.len) return null;
    const ws = workspaces[index];
    const link = linkRange(v, ws, workspaces);
    if (x < link.start or x >= link.end) return null;
    return ws;
}
fn portLine(writer: ?*std.Io.Writer, ws: WorkspaceEntry, width: usize, hit: ?usize, url_buf: []u8, divider: bool) !?[]const u8 {
    const count = urlCount(ws);
    if (count == 0) return null;
    var label_buf: [96]u8 = undefined;
    const label = portLabel(ws, &label_buf);
    if (count == 1) {
        const target = workspaceUrl(ws, 0, url_buf).?;
        if (hit) |col| {
            if (col < @min(displayWidth(label), width)) return target;
        }
        if (writer) |w| try w.print("\x1b]8;id=corgi-port-{d};{s}\x1b\\", .{ ws.id, target });
    }
    if (writer) |w| {
        try w.writeAll("\x1b[4;38;2;137;180;250m");
        try writePortLabel(w, label, width, portPending(ws), std.time.milliTimestamp());
        if (count == 1) try w.writeAll("\x1b]8;;\x1b\\");
        try w.writeAll("\x1b[24;38;2;155;163;175m");
        if (divider) try w.writeAll("\x1b[4;58:2::65:70:77m");
    }
    return null;
}

pub const PortMenu = struct {
    workspace: u32,
    selected: usize = 0,
    pub fn bounds(cols: u16, rows: u16) layout.Rect {
        const width = @min(cols, 64);
        const height = @min(rows, 14);
        return .{ .x = (cols - width) / 2, .y = (rows - height) / 2, .w = width, .h = height };
    }
    pub fn capacity(rows: u16) usize {
        return @max(1, @as(usize, @min(rows, 14)) -| 3);
    }
    pub fn hit(menu: PortMenu, ws: WorkspaceEntry, cols: u16, rows: u16, x: u16, y: u16) ?usize {
        const rect = bounds(cols, rows);
        if (x <= rect.x or x >= rect.x + rect.w -| 1 or y < rect.y + 2 or y >= rect.y + rect.h -| 1) return null;
        const selected = @min(menu.selected, urlCount(ws) -| 1);
        const index = selected / capacity(rows) * capacity(rows) + y - rect.y - 2;
        return if (index < urlCount(ws)) index else null;
    }
    pub fn draw(menu: PortMenu, w: *std.Io.Writer, ws: WorkspaceEntry, cols: u16, rows: u16) !void {
        const rect = bounds(cols, rows);
        if (rect.w < 8 or rect.h < 4) return;
        for (0..rect.h) |row| {
            try w.print("\x1b[{d};{d}H\x1b[0;38;2;155;163;175;48;2;35;40;47m", .{ rect.y + row + 1, rect.x + 1 });
            try w.splatByteAll(' ', rect.w);
        }
        try w.print("\x1b[{d};{d}H", .{ rect.y + 1, rect.x + 2 });
        try writeClipped(w, "Links · Esc to close", rect.w - 2);
        const count = urlCount(ws);
        const selected = @min(menu.selected, count -| 1);
        const offset = selected / capacity(rows) * capacity(rows);
        for (offset..@min(count, offset + capacity(rows))) |index| {
            var buf: [256]u8 = undefined;
            const url = workspaceUrl(ws, index, &buf) orelse continue;
            try w.print("\x1b[{d};{d}H{s} {s} \x1b]8;id=corgi-popup-{d}-{d};{s}\x1b\\", .{ rect.y + 3 + index - offset, rect.x + 1, if (index == selected) "\x1b[38;2;137;180;250;48;2;49;56;68m" else "\x1b[38;2;137;180;250;48;2;35;40;47m", if (index == selected) "›" else " ", ws.id, index, url });
            const name = workspaceUrlName(ws, index);
            var label_buf: [384]u8 = undefined;
            const pending = workspaceUrlPending(ws, index);
            const label = if (name.len > 0) try std.fmt.bufPrint(&label_buf, "Open {s} · {s}", .{ name, url }) else if (pending) try std.fmt.bufPrint(&label_buf, "Open ... · {s}", .{url}) else url;
            try writePortLabel(w, label, rect.w - 4, pending, std.time.milliTimestamp());
            try w.writeAll("\x1b]8;;\x1b\\");
        }
    }
};

test "workspace port labels contain OSC8 URLs selected per viewer" {
    const ports = @import("ports.zig");
    const ifaces = [_]ports.Interface{.{ .name = "tailscale0", .address = "100.80.1.2", .kind = .tailscale }};
    const endpoints = [_]ports.Endpoint{.{ .pid = 12, .pane = 1, .name = "web", .transport = .tcp, .bind_address = "*", .port = 3000, .scheme = .http, .http_status = 200, .interfaces = &ifaces }};
    const works = [_]ports.Work{.{ .id = 1, .background = 2, .endpoints = &endpoints }};
    var ws: WorkspaceEntry = .{ .id = 1, .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } };
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try drawPorts(&out.writer, ws, 25, false);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), ";http://localhost:3000\x1b\\") != null);
    out.clearRetainingCapacity();
    ws.remote_links = true;
    try drawPorts(&out.writer, ws, 25, false);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "http://100.80.1.2:3000") != null);
}

test "non-browser endpoints have no link-out control" {
    const ports = @import("ports.zig");
    const endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = 1, .name = "dns", .transport = .udp, .bind_address = "127.0.0.1", .port = 5353 },
        .{ .pid = 13, .pane = 1, .name = "db", .transport = .tcp, .bind_address = "::1", .port = 5432, .ipv6 = true },
    };
    const works = [_]ports.Work{.{ .id = 1, .endpoints = &endpoints }};
    const ws: WorkspaceEntry = .{ .id = 1, .name = "test", .cwd = "/tmp", .active = true, .remote_links = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } };
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try drawPorts(&out.writer, ws, 60, false);
    try std.testing.expectEqualStrings("", out.written());
}

test "port hit testing matches clipped labels and outer terminal receives link metadata" {
    const ports = @import("ports.zig");
    const endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = 1, .name = "web", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 },
        .{ .pid = 12, .pane = 1, .name = "web", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3001, .scheme = .http, .http_status = 200 },
    };
    const works = [_]ports.Work{.{ .id = 1, .endpoints = &endpoints }};
    const entries = [_]WorkspaceEntry{.{ .id = 1, .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } }};
    const view = View.init(80, 24, true, 0, 0).withWorkspaces(1, 0);
    var buf: [256]u8 = undefined;
    try std.testing.expect(portLink(view, &entries, 1, 4, &buf) == null);
    try std.testing.expectEqual(@as(u32, 1), portWorkspace(view, &entries, 12, 2).?.id);
    try std.testing.expect(portWorkspace(view, &entries, 1, 2) == null);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try view.draw(&out.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open Link ↗ 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "http://") == null);
    const menu: PortMenu = .{ .workspace = 1 };
    try menu.draw(&out.writer, entries[0], 80, 24);
    const host = try @import("terminal.zig").Terminal.create(80, 24);
    defer host.destroy();
    host.feed(out.written());
    try host.updateRender();
    try std.testing.expectEqual(@as(usize, 2), host.hyperlinks().len);
    try std.testing.expectEqualStrings("http://localhost:3000", host.hyperlinks()[0].uri);
    const rect = PortMenu.bounds(80, 24);
    try std.testing.expectEqual(@as(usize, 0), menu.hit(entries[0], 80, 24, rect.x + 3, rect.y + 2).?);
    try std.testing.expect(menu.hit(entries[0], 80, 24, 0, 0) == null);
    var single = entries[0];
    const single_works = [_]ports.Work{.{ .id = 1, .endpoints = endpoints[0..1] }};
    single.ports.workspaces = &single_works;
    try std.testing.expectEqualStrings("http://localhost:3000", portLink(view, &.{single}, 13, 2, &buf).?);
}

test "inferred link names share clipped hit geometry and name chooser destinations" {
    const ports = @import("ports.zig");
    var endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = 1, .name = "web", .label = "Finance Dashboard", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 },
        .{ .pid = 13, .pane = 2, .name = "web", .label = "API Docs", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3001, .scheme = .http, .http_status = 200 },
    };
    var works = [_]ports.Work{.{ .id = 1, .endpoints = endpoints[0..1] }};
    const ws: WorkspaceEntry = .{ .id = 1, .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .workspaces = &works } };
    var buf: [256]u8 = undefined;
    for ([_]u16{ 20, 28, 40 }) |width| {
        const view = View.init(100, 30, true, 0, 0).withWidth(width).withWorkspaces(1, 0);
        const range = linkRange(view, ws, &.{ws});
        try std.testing.expectEqualStrings("http://localhost:3000", portLink(view, &.{ws}, @intCast(range.start), 2, &buf).?);
        try std.testing.expect(portLink(view, &.{ws}, @intCast(range.end), 2, &buf) == null);
        try std.testing.expect(portLink(view, &.{ws}, @intCast(range.start - 1), 2, &buf) == null);
    }
    works[0].endpoints = &endpoints;
    try std.testing.expectEqualStrings("Open Link ↗ 2", portLabel(ws, &buf));
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try (PortMenu{ .workspace = 1 }).draw(&out.writer, ws, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open Finance Dashboard · http://localhost:3000") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open API Docs · http://localhost:3001") != null);
}

test "corgi frames occupy one column per glyph in the terminal" {
    const frames = @import("corgi_frames.zig");
    const routines = [_][]const []const u8{ &frames.wag, &frames.fetch, &frames.sniff };
    for (routines) |routine| for (routine) |frame| {
        try std.testing.expectEqual(try std.unicode.utf8CountCodepoints(frame), displayWidth(frame));
        try std.testing.expect(displayWidth(frame) <= 18);
    };
}

test "idle face replaces stale activity while working activity remains useful" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var entry: Entry = .{ .target = .{ .pane = 1 }, .name = "Agent", .provider = .codex, .state = .idle, .attention = .none, .activity = "Reading source files" };
    const view = View.init(100, 30, true, 0, 1);
    try view.draw(&output.writer, &.{entry}, &.{});
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᐯ◡ᴥ◡ᐯ") != null or
        std.mem.indexOf(u8, output.written(), "ᐯ◡ω◡ᐯ") != null or
        std.mem.indexOf(u8, output.written(), "ᐯ◡ˑ◡ᐯ") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), entry.activity) == null);
    output.clearRetainingCapacity();
    try view.draw(&output.writer, &.{}, &.{}); // Hide the old row; labels below have no corgi to replace.
    output.clearRetainingCapacity();
    for ([_]agents.State{ .blocked, .initializing, .done }, [_][]const u8{ "Needs input", "Starting session", "Session ended" }) |state, label| {
        entry.state = state;
        try view.draw(&output.writer, &.{entry}, &.{});
        try std.testing.expect(std.mem.indexOf(u8, output.written(), label) != null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), entry.activity) == null);
        output.clearRetainingCapacity();
    }
    entry.state = .working;
    try view.draw(&output.writer, &.{entry}, &.{});
    try std.testing.expect(std.mem.indexOf(u8, output.written(), entry.activity) != null);
    output.clearRetainingCapacity();
    entry.activity = "";
    try view.draw(&output.writer, &.{entry}, &.{});
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Working") == null);
    var has_spinner = false;
    for ([_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" }) |glyph| {
        has_spinner = has_spinner or std.mem.indexOf(u8, output.written(), glyph) != null;
    }
    try std.testing.expect(has_spinner);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;249;226;175m") != null);
}

/// Hit only the visible badge, using the exact columns used by draw().
pub fn gitWorkspace(v: View, workspaces: []const WorkspaceEntry, x: u16, y: u16) ?WorkspaceEntry {
    if (v.width == 0 or y < 2 or (y - 2) % 3 != 0) return null;
    const hit = v.hit(x, y);
    if (hit != .workspace) return null;
    const ws = workspaces[hit.workspace];
    const count = ws.git_ahead orelse return null;
    if (count == 0) return null;
    var buf: [24]u8 = undefined;
    const size = 1 + displayWidth(compactCount(&buf, count));
    const end = v.width - 2;
    return if (x >= end -| size and x < end) ws else null;
}

pub fn drawGitTooltip(w: *std.Io.Writer, ws: WorkspaceEntry, cols: u16, rows: u16, px: u16, py: u16) !void {
    if (cols < 24 or rows < 8) return;
    const width: usize = @min(76, cols);
    const count: usize = @min(ws.git_commits.len, (rows - 6) / 2);
    const remaining = (ws.git_ahead orelse 0) -| count;
    const has_footer = remaining > 0 or ws.git_commits.len == 0;
    const height = 3 + count * 2 + @as(usize, if (has_footer) 1 else 0);
    const x: usize = @min(@as(usize, px) + 2, cols - width);
    const y: usize = @min(@as(usize, py) + 1, rows - 1 - height);
    const base = "\x1b[0;38;2;205;214;244;48;2;30;30;46m";
    try w.writeAll("\x1b7\x1b]8;;\x1b\\");
    for (0..height) |row| {
        try w.print("\x1b[{d};{d}H{s}", .{ y + row + 1, x + 1, base });
        try w.writeAll(if (row == 0) "╭" else if (row == height - 1) "╰" else "│");
        for (0..width - 2) |_| try w.writeAll(if (row == 0 or row == height - 1) "─" else " ");
        try w.writeAll(if (row == 0) "╮" else if (row == height - 1) "╯" else "│");
    }
    var buf: [160]u8 = undefined;
    try w.print("\x1b[{d};{d}H\x1b[1;38;2;166;227;161m", .{ y + 2, x + 3 });
    try writeEllipsis(w, try std.fmt.bufPrint(&buf, "↑ {d} unpushed commit{s}", .{ ws.git_ahead orelse 0, if (ws.git_ahead == 1) "" else "s" }), width - 4);
    for (ws.git_commits[0..count], 0..) |item, i| {
        try w.print("\x1b[{d};{d}H{s}\x1b[38;2;249;226;175m{s}  \x1b[38;2;205;214;244m", .{ y + 3 + i * 2, x + 3, base, item.hash });
        try writeEllipsis(w, item.subject, (width - 6) -| item.hash.len);
        try w.print("\x1b[{d};{d}H\x1b[38;2;127;132;156m", .{ y + 4 + i * 2, x + 5 });
        var age_buf: [48]u8 = undefined;
        const age = relativeTime(&age_buf, item.timestamp, std.time.timestamp());
        const timing = try std.fmt.bufPrint(&buf, "{s} · {s}", .{ item.date, age });
        const author_room = @min(24, (width - 9) -| displayWidth(timing));
        if (author_room > 0) {
            try writeEllipsis(w, item.author, author_room);
            try w.writeAll(" · ");
        }
        try writeEllipsis(w, timing, (width - 6) -| (if (author_room > 0) @min(displayWidth(item.author), author_room) + 3 else @as(usize, 0)));
    }
    if (has_footer) {
        try w.print("\x1b[{d};{d}H{s}\x1b[38;2;127;132;156m", .{ y + height - 1, x + 3, base });
        const footer = if (ws.git_commits.len == 0) "Commit details unavailable" else try std.fmt.bufPrint(&buf, "+{d} more", .{remaining});
        try writeEllipsis(w, footer, width - 4);
    }
    try w.writeAll("\x1b[0m\x1b8");
}

test "git badge hit area follows sidebar width and workspace scroll" {
    const entries = [_]WorkspaceEntry{
        .{ .id = 1, .name = "one", .cwd = "/tmp", .active = false },
        .{ .id = 2, .name = "two", .cwd = "/tmp", .active = true, .git_ahead = 14 },
        .{ .id = 3, .name = "three", .cwd = "/tmp", .active = false },
    };
    const view = View.init(100, 20, true, 0, 0).withWidth(36).withWorkspaces(3, 1);
    try std.testing.expectEqual(@as(u32, 2), gitWorkspace(view, &entries, 31, 2).?.id);
    try std.testing.expect(gitWorkspace(view, &entries, 30, 2) == null);
    try std.testing.expect(gitWorkspace(view, &entries, 34, 2) == null);
    try std.testing.expect(gitWorkspace(view, &entries, 32, 3) == null);
    try std.testing.expect(gitWorkspace(view, &entries, 32, 5) == null);
    try std.testing.expect(gitWorkspace(View.init(100, 20, false, 0, 0), &entries, 32, 2) == null);
}

fn relativeTime(buf: []u8, timestamp: i64, now: i64) []const u8 {
    if (timestamp == 0) return "";
    const seconds: u64 = @intCast(if (now >= timestamp) now -| timestamp else timestamp -| now);
    if (seconds < 60) return "just now";
    const unit: struct { seconds: u64, name: []const u8 } = if (seconds < 3600)
        .{ .seconds = 60, .name = "minute" }
    else if (seconds < 86400)
        .{ .seconds = 3600, .name = "hour" }
    else if (seconds < 30 * 86400)
        .{ .seconds = 86400, .name = "day" }
    else if (seconds < 365 * 86400)
        .{ .seconds = 30 * 86400, .name = "month" }
    else
        .{ .seconds = 365 * 86400, .name = "year" };
    const n = seconds / unit.seconds;
    return std.fmt.bufPrint(buf, "{s}{d} {s}{s}{s}", .{ if (timestamp > now) "in " else "", n, unit.name, if (n == 1) "" else "s", if (timestamp > now) "" else " ago" }) catch "";
}

test "commit relative time humanizes elapsed and future timestamps" {
    var buf: [48]u8 = undefined;
    try std.testing.expectEqualStrings("just now", relativeTime(&buf, 10000, 10010));
    try std.testing.expectEqualStrings("1 minute ago", relativeTime(&buf, 10000, 10060));
    try std.testing.expectEqualStrings("2 hours ago", relativeTime(&buf, 10000, 17200));
    try std.testing.expectEqualStrings("in 2 hours", relativeTime(&buf, 17200, 10000));
}

test "content wipes over the old corgi in terminal cells and then clears it" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const host = try @import("terminal.zig").Terminal.create(100, 30);
    defer host.destroy();
    var entry: Entry = .{ .target = .{ .pane = 10001 }, .name = "Agent", .provider = .codex, .state = .working, .attention = .none };
    const view = View.init(100, 30, true, 0, 1);
    try view.drawAt(&output.writer, &.{entry}, &.{}, 0);
    host.feed(output.written());
    output.clearRetainingCapacity();
    entry.activity = "Reading files";
    try view.drawAt(&output.writer, &.{entry}, &.{}, 100);
    host.feed(output.written());
    output.clearRetainingCapacity();
    try view.drawAt(&output.writer, &.{entry}, &.{}, 145);
    host.feed(output.written());
    const mixed = try host.text();
    defer @import("os.zig").allocator.free(mixed);
    // Two revealed cells overlay the old tail and ear; the awake face stays below.
    try std.testing.expect(std.mem.indexOf(u8, mixed, "Re•") != null);
    output.clearRetainingCapacity();
    entry.state = .working;
    entry.activity = "OK";
    try view.drawAt(&output.writer, &.{entry}, &.{}, 150);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᐯ◡ᴥ◡ᐯ") == null);
    output.clearRetainingCapacity();
    try view.drawAt(&output.writer, &.{entry}, &.{}, 550);
    host.feed(output.written());
    const completed = try host.text();
    defer @import("os.zig").allocator.free(completed);
    try std.testing.expect(std.mem.indexOf(u8, completed, "OK                    ") != null);
    try std.testing.expect(std.mem.indexOf(u8, completed, "ᐯ") == null);
}

test "reveal pads short text and never splits a wide glyph or moves the ellipsis" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeRevealedDetail(&output.writer, "OK", 10, 6, null);
    try std.testing.expectEqualStrings("OK    ", output.written());
    output.clearRetainingCapacity();
    try writeRevealedDetail(&output.writer, "界abcdef", 5, 1, null);
    try std.testing.expectEqualStrings(" ", output.written());
    output.clearRetainingCapacity();
    try writeRevealedDetail(&output.writer, "界abcdef", 5, 3, null);
    try std.testing.expectEqualStrings("界a", output.written());
    output.clearRetainingCapacity();
    try writeRevealedDetail(&output.writer, "界abcdef", 5, 5, null);
    try std.testing.expectEqualStrings("界ab…", output.written());
}

test "closing card keeps its glyphs and geometry while all colors fade into the panel" {
    const frame = "\x1b[19;1H\x1b[0;48;2;35;40;47m \x1b[1;38;2;226;230;233mAgent\x1b[4;58:2::65:70:77m corgi";
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try writeExit(&output.writer, frame, 0);
    try std.testing.expectEqualStrings(frame, output.written());
    output.clearRetainingCapacity();
    try writeExit(&output.writer, frame, 0.5);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "38;2;125;129;133mAgent") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[19;1H") != null);
    output.clearRetainingCapacity();
    try writeExit(&output.writer, frame, 1);
    try std.testing.expectEqualStrings("\x1b[19;1H\x1b[0;48;2;24;27;32m \x1b[1;38;2;24;27;32mAgent\x1b[4;58:2::24:27:32m corgi", output.written());
}
