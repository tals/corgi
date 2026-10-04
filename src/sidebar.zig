const std = @import("std");
const os = @import("os.zig");
const ActorId = @import("conversations.zig").Actor.Id;
const NativeId = @import("native.zig").Session.Id;
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const agents = @import("agents.zig");
const layout = @import("layout.zig");
const vt = @import("ghostty-vt");
const corgi_animation = @import("corgi_animation.zig");
const agent_order = @import("agent_order.zig");
const resources = @import("trackers.zig").resources;
const ports = @import("trackers.zig").ports;
const git_push = @import("trackers.zig").git_push;
const protocol = @import("protocol.zig");
const tokens = @import("usage.zig").tokens;
const context_window = @import("usage.zig").context_window;
const corgi_badge = @import("corgi_badge.zig");
const resource_tooltip = @import("resource_tooltip.zig");
const preferences = @import("preferences.zig");
const Resources = preferences.Resources;
const terminal = @import("pane.zig").terminal;
const corgi_frames = @import("corgi_frames.zig");
const a = @import("os.zig").allocator;

/// Agents plus one header per workspace in the grouped "All" list.
pub const max_entries = layout.max_panes + 16 + workspace.max_workspaces;
const selected_bg = "\x1b[48;2;34;44;58m";
/// `group` is a workspace header row in the grouped "All" list, not an agent.
pub const Target = union(enum) { pane: layout.PaneId, native: NativeId, group: WorkspaceId };
pub const Search = struct { text: []const u8, cursor: usize };
/// Viewer-local agent list filter. `workspace` follows the selected workspace.
pub const Scope = enum { workspace, all };
/// Header totals for a `.group` entry; `current` marks the selected workspace.
pub const Group = struct { agents: usize = 0, working: usize = 0, attention: usize = 0, folded: bool = false, current: bool = false };
pub const Entry = struct {
    conversation: ActorId = .none,
    children: usize = 0,
    exit: ?struct { frame_ms: i64, progress: f64 } = null,
    /// A reopened agent's row, which fades in as a closing one fades out.
    reopened: bool = false,
    /// How far a reopened row has faded in, until it has.
    enter: ?f64 = null,
    name: []const u8 = "",
    target: Target,
    /// Null for workspace group headers.
    provider: ?agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    focused: bool = false,
    cwd: []const u8 = "",
    tool_active: bool = false,
    compacting: bool = false,
    unread: bool = false,
    activity: []const u8 = "",
    group: Group = .{},
    subagents: agents.Subagents = .{},
    context: context_window.View = .{},

    pub fn orderTarget(e: Entry) ?agent_order.Target {
        return switch (e.target) {
            .pane => |id| .{ .pane = id },
            .native => |id| .{ .native = id },
            .group => null,
        };
    }
    pub fn lessThan(order: []const agent_order.Target, left: Entry, right: Entry) bool {
        return agent_order.rank(order, left.orderTarget().?) < agent_order.rank(order, right.orderTarget().?);
    }

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

pub const WorkspaceEntry = struct {
    resources: resources.Work = .{ .id = .none },
    ports: ports.Snapshot = .{},
    remote_links: bool = false,
    git_push: git_push.View = .{},
    git_ahead: ?u64 = null,
    git_commits: []const protocol.GitCommit = &.{},
    id: WorkspaceId,
    name: []const u8,
    cwd: []const u8,
    active: bool,
    agents: usize = 0,
    working: usize = 0,
    unread: usize = 0,
    attention: usize = 0,
    stats: tokens.Counts = .{},
};
pub const Hit = union(enum) { none, toggle, agent_scope, agent_new, agent_options, entry: usize, workspace_new, workspace_previous, workspace_next, workspace: usize };
/// Render the prospective order without changing shared state or the stable
/// row geometry used by the captured gesture's hit testing.
pub const Preview = struct {
    source: usize,
    destination: usize,
    pub fn apply(p: Preview, comptime T: type, entries: []const T, out: []T) []const T {
        if (entries.len > out.len or p.source >= entries.len or p.destination >= entries.len) return entries;
        @memcpy(out[0..entries.len], entries);
        const item = out[p.source];
        if (p.source < p.destination) {
            std.mem.copyForwards(T, out[p.source..p.destination], out[p.source + 1 .. p.destination + 1]);
        } else {
            std.mem.copyBackwards(T, out[p.destination + 1 .. p.source + 1], out[p.destination..p.source]);
        }
        out[p.destination] = item;
        return out[0..entries.len];
    }
};
pub const View = struct {
    search: ?Search = null,
    /// Header scope: "all" or the workspace whose agents are listed.
    scope_label: []const u8 = "",
    corgi_badge: corgi_badge.Mode = .none,
    supports_kitty_graphics: bool = false,
    cols: u16,
    rows: u16,
    width: u16,
    count: usize,
    offset: usize,
    capacity: usize,
    /// When set, rows are measured per entry: group headers take one row.
    entries: []const Entry = &.{},
    dragged: ?usize = null,
    dragged_workspace: ?usize = null,
    workspace_count: usize = 0,
    workspace_offset: usize = 0,
    resources: Resources = .{},
    resource_hover: ?WorkspaceId = null,
    /// Corgi setup: idle agents nap as corgis; off marks them with a faint Z.
    sleeping_corgis: bool = true,
    pub fn middle(v: View) u16 {
        return (v.rows -| 1) / 2;
    }
    /// Name and status rows, plus the resource row unless readings are off.
    pub fn workspaceRows(v: View) u16 {
        return if (v.resources.enabled) 3 else 2;
    }
    /// Name and status rows end above the pager row; only a trailing
    /// resource row may give way to it.
    pub fn workspaceCapacity(v: View) usize {
        return @max(1, (v.middle() -| 4 + (v.workspaceRows() - 2)) / v.workspaceRows());
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
        var v: View = .{ .cols = cols, .rows = rows, .width = if (rows >= 13) widthFor(cols, open) else 0, .count = count, .capacity = 1, .offset = 0 };
        v.capacity = @max(1, v.listRows() / 2);
        v.offset = @min(offset, count -| v.capacity);
        return v;
    }
    /// The list runs to the bottom, above the search hint while searching.
    fn listEnd(v: View) u16 {
        return if (v.search != null) v.rows -| 1 else v.rows;
    }
    fn listRows(v: View) usize {
        return v.listEnd() -| (v.middle() + 2);
    }
    fn height(e: Entry) usize {
        return if (e.target == .group) 1 else 2;
    }
    /// Entries that fit in the list starting at `from`.
    fn fits(v: View, from: usize) usize {
        var used: usize = 0;
        var n: usize = 0;
        for (v.entries[@min(from, v.entries.len)..]) |e| {
            used += height(e);
            if (used > v.listRows()) break;
            n += 1;
        }
        return @max(1, n);
    }
    pub fn maxOffset(v: View) usize {
        if (v.entries.len == 0) return v.count -| v.capacity;
        var used: usize = 0;
        var start = v.entries.len;
        while (start > 0) : (start -= 1) {
            used += height(v.entries[start - 1]);
            if (used > v.listRows()) break;
        }
        return start;
    }
    fn rowsBefore(v: View, index: usize) usize {
        if (v.entries.len == 0) return index * 2;
        var rows: usize = 0;
        for (v.entries[0..index]) |e| rows += height(e);
        return rows;
    }
    /// The scrollbar thumb's rows within the list, drawn over the border;
    /// null while every entry fits.
    pub fn thumb(v: View) ?struct { start: usize, len: usize } {
        const track = v.listRows();
        const total = v.rowsBefore(v.count);
        if (total <= track or track < 2) return null;
        const len = std.math.clamp((track * track + total / 2) / total, 1, track - 1);
        const last = @max(1, v.rowsBefore(v.maxOffset()));
        const start = ((track - len) * v.rowsBefore(v.offset) + last / 2) / last;
        return .{ .start = @min(start, track - len), .len = len };
    }
    pub fn withEntries(v: View, entries: []const Entry) View {
        var result = v;
        result.entries = entries;
        result.count = entries.len;
        result.offset = @min(v.offset, result.maxOffset());
        result.capacity = result.fits(result.offset);
        return result;
    }
    /// The smallest scroll change that shows entry `index`.
    pub fn reveal(v: View, index: usize) usize {
        if (index < v.offset) return index;
        var offset = v.offset;
        while (offset < index and index >= offset + (if (v.entries.len > 0) v.fits(offset) else v.capacity)) offset += 1;
        return offset;
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
        return .{ .x = v.width, .y = 1, .w = v.cols - v.width, .h = v.rows -| 1 };
    }
    pub fn tabX(v: View) u16 {
        return if (v.width > 0) v.width else if (v.cols >= 64) 3 else 0;
    }
    pub fn hit(v: View, x: u16, y: u16) Hit {
        if (v.width == 0) return if (v.cols >= 64 and x < 3 and y == 0) .toggle else .none;
        if (x >= v.width - 1 or y >= v.rows) return .none;
        if (y == 0 and x >= v.width - 5) return .toggle;
        if (y == 0 and x >= v.width - 11 and x < v.width - 6) return .workspace_new;
        if (y == v.middle() and x >= v.width - 10 and x < v.width - 2) return if (x >= v.width - 4) .agent_options else .agent_new;
        if (y == v.middle() and x >= v.scopeStart()) {
            var label: [163]u8 = undefined;
            const qualifier = v.scopeQualifier(&label);
            if (x < v.scopeStart() + displayWidth(qualifier) + displayWidth(v.scopeArrow())) return .agent_scope;
        }
        if (y < v.middle()) {
            if (y == v.middle() - 2) {
                if (v.workspace_count > v.workspaceCapacity()) {
                    if (x >= v.width - 8 and x < v.width - 5) return .workspace_previous;
                    if (x >= v.width - 5 and x < v.width - 2) return .workspace_next;
                }
                return .none;
            }
            if (y < 2 or y >= v.middle() - 2) return .none;
            const slot = (y - 2) / v.workspaceRows();
            const index = slot + v.workspace_offset;
            return if (index < v.workspace_count and slot < v.workspaceCapacity()) .{ .workspace = index } else .none;
        }
        if (y < v.middle() + 2 or y >= v.listEnd()) return .none;
        var top: usize = v.middle() + 2;
        for (v.offset..@min(v.count, v.offset + v.capacity)) |index| {
            top += if (v.entries.len > 0) height(v.entries[index]) else 2;
            if (y < top) return .{ .entry = index };
        }
        return .none;
    }
    pub const Drop = struct { index: usize, y: u16 };
    /// Use the same row heights and viewport as hit testing. The marker sits
    /// just above the destination row, including the gap after the last row.
    pub fn agentDrop(v: View, x: u16, y: u16) ?Drop {
        if (v.width == 0 or x >= v.width - 1 or y < v.middle() + 2 or y >= v.listEnd() or v.entries.len == 0) return null;
        var top: usize = v.middle() + 2;
        const end = @min(v.count, v.offset + v.capacity);
        for (v.offset..end) |i| {
            const h = height(v.entries[i]);
            if (y < top + h / 2) return .{ .index = i, .y = @intCast(top - 1) };
            top += h;
        }
        return .{ .index = end, .y = @intCast(top - 1) };
    }
    /// `agentDrop` over the workspace slots in the upper list.
    pub fn workspaceDrop(v: View, x: u16, y: u16) ?Drop {
        if (v.width == 0 or x >= v.width - 1 or y < 2 or y >= v.middle() -| 2 or v.workspace_count == 0) return null;
        var top: usize = 2;
        const end = @min(v.workspace_count, v.workspace_offset + v.workspaceCapacity());
        for (v.workspace_offset..end) |i| {
            if (y < top + (v.workspaceRows() + 1) / 2) return .{ .index = i, .y = @intCast(top - 1) };
            top += v.workspaceRows();
        }
        return .{ .index = end, .y = @intCast(top - 1) };
    }
    pub fn unreadRange(v: View, ws: WorkspaceEntry) struct { start: usize, end: usize } {
        var buf: [40]u8 = undefined;
        const unread_width = unreadWidth(ws);
        const metadata_width = statusMetadataWidth(ws);
        const attention_width = if (ws.attention > 0) displayWidth(compactCount(&buf, ws.attention)) + 2 else 0;
        const working_width = if (ws.working > 0) displayWidth(compactCount(&buf, ws.working)) + 1 else 1;
        const room = ((v.width -| 3) -| (metadata_width + 1)) -| (unread_width + 3);
        const working = if (working_width + attention_width <= room) working_width else 0;
        const status_width = working + @min(attention_width, room - working);
        const start = 1 + status_width + @as(usize, if (working > 0 or attention_width > 0) 3 else 0);
        return .{ .start = start, .end = start + unread_width };
    }
    /// The label is blank at zero, but its slot keeps the width of "1 unread →"
    /// so the status row does not shift when the first unread arrives.
    fn unreadWidth(ws: WorkspaceEntry) usize {
        var buf: [40]u8 = undefined;
        return @max(10, displayWidth(compactCount(&buf, ws.unread)) + 9);
    }
    pub fn unreadHit(v: View, ws: WorkspaceEntry, x: u16, y: u16) bool {
        if (ws.unread == 0 or y < 3 or (y - 2) % v.workspaceRows() != 1) return false;
        const range = v.unreadRange(ws);
        return x >= range.start and x < range.end;
    }
    pub fn draw(v: View, w: *std.Io.Writer, entries: []const Entry, workspaces: []const WorkspaceEntry) !void {
        return v.drawAt(w, entries, workspaces, os.milliTimestamp());
    }
    fn drawAt(v: View, w: *std.Io.Writer, entries: []const Entry, workspaces: []const WorkspaceEntry, now_ms: i64) !void {
        corgi_animation.beginFrame();
        defer corgi_animation.endFrame();
        const panel = "\x1b[0;38;2;155;163;175;48;2;24;27;32m";
        if (v.width == 0) {
            if (v.cols >= 64) try w.writeAll("\x1b[1;1H\x1b[1;38;2;161;194;178m > \x1b[0m");
            return;
        }
        for (0..v.rows) |row| {
            try w.print("\x1b[{d};1H{s}", .{ row + 1, panel });
            try w.splatByteAll(' ', v.width - 1);
            try w.writeAll("\x1b[38;2;55;61;70m│");
        }
        try v.drawScope(w);
        if (v.search) |search| {
            try v.line(w, v.middle() + 1, "/ ", "\x1b[0;38;2;161;194;178;48;2;35;40;47m");
            try w.splatByteAll(' ', v.width - 5);
            try w.print("\x1b[{d};4H", .{v.middle() + 2});
            if (search.text.len == 0) try writeClipped(w, "type to search", v.width - 5) else try writeClipped(w, search.text[v.searchOffset()..], v.width - 5);
        } else try w.print("\x1b[{d};{d}H\x1b[0;1;38;2;161;194;178;48;2;35;40;47m New  ▾ {s}", .{ v.middle() + 1, v.width - 9, panel });
        try w.print("\x1b[1;{d}H{s} < ", .{ v.width - 4, panel });
        if (v.corgi_badge != .none) {
            if (v.corgi_badge == .emoji) try w.print("\x1b[1;2H{s}{s}", .{ panel, corgi_badge.emoji });
            try w.writeAll("\x1b[1;6H\x1b[1;38;2;226;230;233m");
            try writeEllipsis(w, "workspaces", v.width -| 17);
        } else try v.line(w, 0, "workspaces", "\x1b[1;38;2;226;230;233m");
        try w.print("\x1b[1;{d}H\x1b[0;1;38;2;161;194;178;48;2;35;40;47m[ + ]{s}", .{ v.width - 10, panel });
        const active_name = "\x1b[1;38;2;182;206;240;48;2;34;44;58m";
        const active_meta = "\x1b[0;38;2;155;163;175;48;2;34;44;58m";
        // Kitty-graphics hosts (kitty, Ghostty, WezTerm) draw block elements to
        // fill the cell, so a half block joins into one bar. Elsewhere the font's
        // glyph can leave gaps between rows, so paint the whole cell instead.
        const active_bar = if (v.supports_kitty_graphics) "\x1b[0;38;2;137;180;250;48;2;34;44;58m▌" else "\x1b[0;48;2;137;180;250m ";
        // The dragged workspace uses the dragged agent row's tint.
        const ghost_name = "\x1b[1;38;2;182;206;240;48;2;44;54;67m";
        const ghost_meta = "\x1b[0;38;2;155;163;175;48;2;44;54;67m";
        const ghost_bar = if (v.supports_kitty_graphics) "\x1b[0;38;2;137;180;250;48;2;44;54;67m▌" else active_bar;
        for (workspaces[v.workspace_offset..@min(workspaces.len, v.workspace_offset + v.workspaceCapacity())], 0..) |ws, index| {
            const y: u16 = @intCast(2 + index * v.workspaceRows());
            const ghost = v.dragged_workspace == v.workspace_offset + index;
            const tinted = ws.active or ghost;
            const style = if (ghost) ghost_name else if (ws.active) active_name else panel;
            const meta = if (ghost) ghost_meta else if (ws.active) active_meta else panel;
            const bar = if (ghost) ghost_bar else active_bar;
            try w.print("\x1b[{d};1H{s}", .{ y + 1, style });
            try w.splatByteAll(' ', v.width - 1);
            var label: [std.fs.max_path_bytes + 1]u8 = undefined;
            var badge_buf: [64]u8 = undefined;
            const badge = gitLabel(&badge_buf, ws, false);
            const badge_width = displayWidth(badge);
            try w.print("\x1b[{d};2H{s}", .{ y + 1, style });
            const link = linkRange(v, ws, workspaces);
            try writeClipped(w, directoryLabel(&label, ws.name, null), link.start -| 2);
            if (link.end > link.start) {
                try w.print("\x1b[{d};{d}H", .{ y + 1, link.start + 1 });
                try drawPorts(w, ws, link.end - link.start, false);
            }
            if (badge_width > 0) try w.print("\x1b[{d};{d}H\x1b[38;2;{s}m{s}", .{ y + 1, v.width - 1 - badge_width, if (ws.git_push.phase == .failed) "243;139;168" else "166;227;161", badge });
            if (tinted) {
                try w.print("\x1b[{d};1H{s}", .{ y + 2, meta });
                try w.splatByteAll(' ', v.width - 1);
            }
            const divider = index + 1 < @min(workspaces.len - v.workspace_offset, v.workspaceCapacity());
            // Without a resource row, the separator underlines the status row,
            // text included, as between agents.
            const rule = if (divider and v.workspaceRows() == 2) "\x1b[4;58:2::65:70:77m" else "";
            try w.print("\x1b[{d};2H{s}{s}", .{ y + 2, meta, rule });
            if (rule.len > 0) {
                try w.splatByteAll(' ', v.width - 3);
                try w.print("\x1b[{d};2H", .{y + 2});
            }
            var metadata_buf: [96]u8 = undefined;
            var tools_buf: [24]u8 = undefined;
            const tools = compactCount(&tools_buf, ws.stats.tools);
            var unread_buf: [40]u8 = undefined;
            var attention_buf: [24]u8 = undefined;
            var number_buf: [24]u8 = undefined;
            const unread = if (ws.unread > 0) try std.fmt.bufPrint(&unread_buf, "{s} unread →", .{compactCount(&number_buf, ws.unread)}) else "";
            const attention = if (ws.attention > 0) try std.fmt.bufPrint(&attention_buf, " ●{s}", .{compactCount(&number_buf, ws.attention)}) else "";
            const unread_width = unreadWidth(ws);
            const attention_width = displayWidth(attention);
            const metadata = try std.fmt.bufPrint(&metadata_buf, "⚒{s}", .{tools});
            const metadata_width = displayWidth(metadata);
            const left_room = (v.width - 3) -| (statusMetadataWidth(ws) + 1);
            var room: usize = left_room -| (unread_width + 3);
            var text_buf: [96]u8 = undefined;
            var has_status = false;
            {
                const text = if (ws.working == 0) "○" else try std.fmt.bufPrint(&text_buf, "●{s}", .{compactCount(&number_buf, ws.working)});
                if (displayWidth(text) + attention_width <= room) {
                    try statusPart(w, text, if (ws.working > 0) "\x1b[38;2;249;226;175m" else "\x1b[38;2;166;227;161m", &room);
                    has_status = true;
                }
            }
            if (attention_width > 0) {
                try statusPart(w, attention, "\x1b[1;38;2;243;139;168m", &room);
                has_status = true;
            }
            if (ws.unread > 0) {
                if (has_status) try w.writeAll("\x1b[22;38;2;90;97;108m · ");
                try w.print("\x1b[{d};{d}H", .{ y + 2, v.unreadRange(ws).start + 1 });
                var unread_room = unread_width;
                try statusPart(w, unread, "\x1b[1;38;2;148;226;213m", &unread_room);
            }
            if (ws.stats.tools > 0) try w.print("\x1b[{d};{d}H{s}{s}{s}", .{ y + 2, v.width - 1 - metadata_width, meta, rule, metadata });
            if (ws.active) for ([_]u16{ y + 1, y + 2 }) |row| try w.print("\x1b[{d};1H{s}", .{ row, bar });
            try w.writeAll(panel);
            if (v.workspaceRows() == 3 and y + 2 < v.middle() - 2) {
                if (tinted) {
                    try w.print("\x1b[{d};1H{s}", .{ y + 3, meta });
                    try w.splatByteAll(' ', v.width - 1);
                }
                try w.print("\x1b[{d};2H{s}", .{ y + 3, meta });
                if (divider) try w.writeAll("\x1b[4;58:2::65:70:77m");
                try drawResources(w, ws.resources, v, v.resource_hover == ws.id);
                try w.writeAll("\x1b[24;59m");
                try w.writeAll(panel);
                if (ws.active) try w.print("\x1b[{d};1H{s}{s}", .{ y + 3, bar, panel });
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
        const grouped = for (entries) |e| {
            if (e.target == .group) break true;
        } else false;
        var next_y: u16 = v.middle() + 2;
        const visible = entries[v.offset..@min(entries.len, v.offset + v.capacity)];
        var sleepers: [max_entries]u64 = undefined;
        var sleeping: usize = 0;
        for (visible) |e| {
            if (e.target == .group or e.state != .idle or e.exit != null) continue;
            sleepers[sleeping] = animationKey(e);
            sleeping += 1;
        }
        const dream = if (v.sleeping_corgis) corgi_animation.dreamer(sleepers[0..sleeping], now_ms) else null;
        for (visible, v.offset..) |e, absolute| {
            const index = absolute - v.offset;
            var exit_buffer: [16384]u8 = undefined;
            var exit_writer = std.Io.Writer.fixed(&exit_buffer);
            const fade: ?f64 = if (e.exit) |closing| closing.progress else if (e.enter) |opened| 1 - opened else null;
            const row_writer = if (fade != null) &exit_writer else w;
            const frame_ms = if (e.exit) |closing| closing.frame_ms else now_ms;
            const y = next_y;
            next_y += @intCast(height(e));
            if (e.target == .group) {
                try v.drawGroup(row_writer, e, y);
                if (fade) |faded| try writeExit(w, exit_writer.buffered(), faded);
                continue;
            }
            const last_in_group = grouped and (absolute + 1 == entries.len or entries[absolute + 1].target == .group);
            const divider = !grouped and index + 1 < @min(entries.len - v.offset, v.capacity);
            try v.drawAgent(row_writer, e, 0, y, grouped, last_in_group, divider, v.dragged == absolute, frame_ms, dream);
            if (fade) |faded| try writeExit(w, exit_writer.buffered(), faded);
        }
        if (v.search != null) try v.line(w, v.rows - 1, "↑↓  ↵ jump  Esc back", panel);
        if (v.thumb()) |t| for (t.start..t.start + t.len) |row| {
            try w.print("\x1b[{d};{d}H{s}\x1b[38;2;112;119;130m┃", .{ v.middle() + 3 + row, v.width, panel });
        };
        try w.writeAll("\x1b[0m");
    }
    /// The small glyph beside an agent's detail line: a wait clock, an active
    /// tool, the working spinner, or a napping "z" once idle.
    fn activityGlyph(e: Entry, waiting: bool, napping: bool, spinner: []const u8) []const u8 {
        if (waiting) return "◷";
        if (e.tool_active and (e.state == .working or e.state == .blocked)) return "🔧";
        if (e.state == .working) return spinner;
        if (napping) return "ᶻ";
        return "";
    }
    /// The thinking swirl, or dots that pile up and squash flat while compacting.
    fn spinnerFrame(compacting: bool, now_ms: i64) []const u8 {
        const thinking = [_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
        const pile = [_][]const u8{ "⣀", "⣁", "⣂", "⣄", "⣌", "⣔", "⣤", "⣥", "⣦", "⣮", "⣶", "⣷", "⣿", "⣿", "⣿", "⣶", "⣤", "⣀", "⣀" };
        if (compacting) return pile[@intCast(@mod(@divFloor(now_ms, 75), pile.len))];
        return thinking[@intCast(@mod(@divFloor(now_ms, 80), thinking.len))];
    }
    fn drawAgent(v: View, w: *std.Io.Writer, e: Entry, x: u16, y: u16, grouped: bool, last_in_group: bool, divider: bool, ghost: bool, now_ms: i64, dream: ?corgi_animation.Dream) !void {
        // Grouped rows select with the active workspace's tint; the rail stays unbroken.
        const row_bg: [3]u8 = if (ghost) .{ 44, 54, 67 } else if (!e.focused) .{ 24, 27, 32 } else if (grouped) .{ 34, 44, 58 } else .{ 35, 40, 47 };
        var bg_buf: [24]u8 = undefined;
        const bg = std.fmt.bufPrint(&bg_buf, "\x1b[48;2;{d};{d};{d}m", .{ row_bg[0], row_bg[1], row_bg[2] }) catch unreachable;
        for (0..2) |row| {
            if (y + row >= v.listEnd()) break;
            try w.print("\x1b[{d};{d}H\x1b[0m{s}", .{ y + row + 1, x + 1, bg });
            try w.splatByteAll(' ', v.width - 1);
        }
        if (grouped) {
            // The guide sits in the margin column, so agent text keeps its columns.
            // Beside the selected agent it turns heavy and blue, without a gap.
            const rail = if (e.focused) "\x1b[0;38;2;137;180;250m" else "\x1b[0;38;2;112;119;130m";
            const branch = if (e.focused) (if (last_in_group) "┗" else "┣") else if (last_in_group) "╰" else "├";
            try w.print("\x1b[{d};{d}H{s}{s}{s}", .{ y + 1, x + 1, rail, bg, branch });
            if (!last_in_group and y + 1 < v.listEnd()) try w.print("\x1b[{d};{d}H{s}", .{ y + 2, x + 1, if (e.focused) "┃" else "│" });
            try w.print("\x1b[0m{s}", .{bg});
        }
        const dot = e.indicator();
        try w.print("\x1b[{d};{d}H\x1b[22m{s}{s}\x1b[{d};{d}H\x1b[1;38;2;226;230;233m", .{ y + 1, x + 2, dot.color, dot.icon, y + 1, x + 5 });
        const room = v.width - 6;
        // Within a group, a dotted line under the text separates agents. Only
        // Kitty-graphics hosts get it; elsewhere the style could degrade to a
        // solid underline, so those terminals get no separator at all.
        const dotted = grouped and !last_in_group and v.supports_kitty_graphics;
        const underline = if (ghost) "\x1b[4;58:2::137;180;250m" else if (dotted) "\x1b[4:4m\x1b[58:2::65:70:77m" else if (divider) "\x1b[4;58:2::65:70:77m" else "";
        // Dotted lines start under the name, leaving the guide and activity clear.
        const underline_x: u16 = if (dotted) 5 else 2;
        const compacting = e.state == .working and e.compacting;
        const waiting = e.state == .working and e.subagents.waiting and !compacting;
        // Without sleeping corgis, a faint Z marks an idle agent; unseen ones are brighter.
        const napping = e.state == .idle and !v.sleeping_corgis;
        const activity = activityGlyph(e, waiting, napping, spinnerFrame(compacting, now_ms));
        const activity_color = if (!napping) "\x1b[22;38;2;125;132;143m" else if (e.attention == .finished) "\x1b[22;38;2;108;112;134m" else "\x1b[22;38;2;70;74;88m";
        var name: [160]u8 = undefined;
        const provider = if (e.name.len > 0) directoryLabel(&name, e.name, null) else if (e.provider) |known| @tagName(known) else "";
        var figure_buf: [8]u8 = undefined;
        const figure = contextFigure(&figure_buf, e, compacting, row_bg);
        const figure_width = if (figure) |f| displayWidth(f.text) else 0;
        try w.print("\x1b[{d};{d}H{s}", .{ y + 1, x + 5, if (grouped and e.focused) "\x1b[1;38;2;226;230;233m" else "\x1b[22;38;2;226;230;233m" });
        try writeEllipsis(w, provider, room -| (figure_width + @as(usize, if (figure_width > 0) 1 else 0)));
        try w.writeAll("\x1b[22m");
        if (figure) |f| try w.print("\x1b[{d};{d}H\x1b[38;2;{d};{d};{d}m{s}", .{ y + 1, x + v.width - 1 - figure_width, f.color[0], f.color[1], f.color[2], f.text });
        // Underline the existing second row, including its padding, without
        // consuming another terminal row or changing the entry hit area.
        try w.print("\x1b[{d};{d}H{s}", .{ y + 2, x + underline_x, underline });
        try w.splatByteAll(' ', v.width - 1 - underline_x);
        try w.print("\x1b[{d};{d}H{s}{s}{s}\x1b[{d};{d}H{s}\x1b[38;2;226;230;233m", .{
            y + 2,
            x + 2,
            if (dotted) "\x1b[24m" else "",
            activity_color,
            activity,
            y + 2,
            x + 5,
            if (dotted) underline else "",
        });
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
        const animation_key = animationKey(e);
        const fallback = e.state == .working and !compacting and !waiting and e.activity.len == 0;
        // Narrow rows keep the text; the pile beside it still moves.
        const herding = compacting and detail_room >= corgi_animation.herd_width;
        const mode: corgi_animation.Mode = if (herding) .herding else if (fallback) .awake else if (e.state == .idle and v.sleeping_corgis) .asleep else .content;
        const presentation = corgi_animation.observe(animation_key, mode, now_ms);
        // Unseen and focused naps stay bright; only the list's dreamer puffs.
        const sleep: corgi_animation.Sleep = .{
            .background = if (e.focused) .{ 35, 40, 47 } else .{ 24, 27, 32 },
            .bright = e.focused or e.attention == .finished,
            .puff_ms = if (dream) |d| (if (d.key == animation_key) d.puff_ms else null) else null,
        };
        if (mode == .herding) {
            try presentation.?.writeHerding(w, detail_room, now_ms);
        } else if (mode != .content) {
            try presentation.?.writeCorgi(w, detail_room, e.state == .working, sleep);
        } else {
            // Lifecycle signals (blocked/ended/etc.) must be immediate.
            // Interrupts already switch straight to the sleeping mode.
            if (e.state != .working) if (presentation) |p| p.skipReveal();
            // No detail stays blank; directoryLabel would print "?" for it.
            const text = if (detail.len == 0) "" else directoryLabel(&clean, detail, null);
            if (presentation != null and presentation.?.reveal_started_ms != null) {
                try presentation.?.writeCorgi(w, detail_room, e.state == .working, sleep);
                try w.print("\x1b[{d};{d}H\x1b[38;2;226;230;233m", .{ y + 2, x + 5 });
                try writeRevealedDetail(w, text, detail_room, presentation.?.revealedColumns(detail_room, now_ms), presentation.?.revealPosition(detail_room, now_ms));
            } else try writeEllipsis(w, text, detail_room);
        }
        if (badge_width > 0) {
            const color = if (e.subagents.blocked > 0) "\x1b[38;2;243;139;168m" else "\x1b[38;2;148;226;213m";
            try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 2, x + v.width - 1 - badge_width, color, badge });
        }
        try w.writeAll("\x1b[24;59m");
        if (ghost) for (0..2) |row| try w.print("\x1b[{d};{d}H\x1b[48;2;137;180;250m \x1b[0m", .{ y + row + 1, x + 1 });
    }
    /// Context appears on the name line only near compaction.
    fn contextFigure(buf: []u8, e: Entry, compacting: bool, background: [3]u8) ?struct { text: []const u8, color: [3]u8 } {
        if (e.state == .done) return null;
        const band = e.context.band() orelse return null;
        if (band == .calm) return null;
        const text = std.fmt.bufPrint(buf, "{d}%", .{@min(e.context.percent(), 999)}) catch unreachable;
        return .{ .text = text, .color = contextColor(band, compacting, background) };
    }
    fn animationKey(e: Entry) u64 {
        return switch (e.target) {
            .pane => |id| @as(u64, @intFromEnum(id)) * 17,
            .native => |id| (@as(u64, @intFromEnum(id)) + 0x100000000) * 17,
            .group => unreachable,
        };
    }
    fn drawGroup(v: View, w: *std.Io.Writer, e: Entry, y: u16) !void {
        const g = e.group;
        const bg = if (e.focused) selected_bg else "\x1b[48;2;24;27;32m";
        try w.print("\x1b[{d};1H\x1b[0m{s}", .{ y + 1, bg });
        try w.splatByteAll(' ', v.width - 1);
        try w.print("\x1b[{d};1H\x1b[38;2;150;158;170m{s}", .{ y + 1, if (g.folded) "▸" else "▾" });
        // Right side: working and attention counts, then the agent count.
        var digits: [24]u8 = undefined;
        var count_buf: [24]u8 = undefined;
        const count = compactCount(&count_buf, g.agents);
        const count_x = (v.width -| 2) -| displayWidth(count);
        var working_buf: [32]u8 = undefined;
        var attention_buf: [32]u8 = undefined;
        const working = if (g.working > 0) try std.fmt.bufPrint(&working_buf, "{s}●", .{compactCount(&digits, g.working)}) else "";
        const attention = if (g.attention > 0) try std.fmt.bufPrint(&attention_buf, "{s}●", .{compactCount(&digits, g.attention)}) else "";
        const both = working.len > 0 and attention.len > 0;
        const status_width = displayWidth(working) + displayWidth(attention) + @as(usize, if (both) 1 else 0);
        const status_x = count_x -| (status_width + @as(usize, if (status_width > 0) 1 else 0));
        try w.print("\x1b[{d};{d}H{s}", .{ y + 1, count_x + 1, count });
        if (status_width > 0) try w.print("\x1b[{d};{d}H\x1b[38;2;249;226;175m{s}{s}\x1b[1;38;2;243;139;168m{s}\x1b[22m", .{ y + 1, status_x + 1, working, if (both) " " else "", attention });
        // Name, then a rule that leaves one space on each side.
        var label: [160]u8 = undefined;
        const text = directoryLabel(&label, e.name, null);
        const name_room = status_x -| 5;
        try w.print("\x1b[{d};3H{s}", .{ y + 1, if (g.current) "\x1b[1;38;2;182;206;240m" else "\x1b[1;38;2;226;230;233m" });
        try writeEllipsis(w, text, name_room);
        const name_end = 2 + @min(displayWidth(text), name_room);
        if (status_x > name_end + 2) {
            // A heavy, bright rule so each header stands out from its agents.
            try w.print("\x1b[{d};{d}H\x1b[22;38;2;150;158;170m", .{ y + 1, name_end + 2 });
            for (name_end + 1..status_x - 1) |_| try w.writeAll("━");
        }
    }
    fn scopeStart(v: View) u16 {
        // Compact headers keep one cell for the name and one for the arrow.
        return if (v.width >= 22) 9 else 8;
    }
    fn scopeArrow(v: View) []const u8 {
        return if (v.width >= 22) " ▾" else "▾";
    }
    fn scopeQualifier(v: View, out: *[163]u8) []const u8 {
        const room = (v.width -| 11) -| (v.scopeStart() - 1 + displayWidth(v.scopeArrow()));
        var label: [160]u8 = undefined;
        var writer = std.Io.Writer.fixed(out);
        writeEllipsis(&writer, directoryLabel(&label, v.scope_label, null), room) catch unreachable;
        return writer.buffered();
    }
    fn drawScope(v: View, w: *std.Io.Writer) !void {
        if (v.middle() >= v.rows - 1) return;
        try w.print("\x1b[{d};2H\x1b[1;38;2;226;230;233m", .{v.middle() + 1});
        // Stop before the New button's leading space.
        const room: usize = v.width -| 11;
        try writeClipped(w, "agents", room);
        var label: [163]u8 = undefined;
        const qualifier = v.scopeQualifier(&label);
        if (qualifier.len > 0) {
            try w.print("\x1b[22;38;2;125;132;143m{s}\x1b[1;38;2;161;194;178m", .{if (v.scopeStart() == 9) ": " else " "});
            try w.writeAll(qualifier);
        }
        try w.print("\x1b[22;38;2;125;132;143m{s}", .{v.scopeArrow()});
    }
    fn line(v: View, w: *std.Io.Writer, y: u16, text: []const u8, style: []const u8) !void {
        if (y >= v.rows) return;
        try w.print("\x1b[{d};2H{s}", .{ y + 1, style });
        try writeClipped(w, text, v.width - 3);
    }
};

/// Context colors for the row figure and the card's meter: grey, amber from
/// 70% of the way to compaction, red from 85%, faded into the background while
/// the agent compacts.
pub fn contextColor(band: context_window.View.Band, compacting: bool, background: [3]u8) [3]u8 {
    const tone: [3]u8 = switch (band) {
        .calm => .{ 166, 173, 200 },
        .near => .{ 250, 179, 135 },
        .high => .{ 243, 139, 168 },
    };
    if (!compacting) return tone;
    var dim: [3]u8 = undefined;
    for (&dim, tone, background) |*out, t, b| out.* = @intCast((@as(u16, t) * 2 + @as(u16, b) * 3) / 5);
    return dim;
}

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

/// Resource hover stays on the third workspace row. Clicks and drags on that
/// row select the workspace, just like its title and status rows.
pub fn resourceAt(v: View, workspaces: []const WorkspaceEntry, x: u16, y: u16) ?WorkspaceEntry {
    if (v.workspaceRows() < 3 or v.width == 0 or x < 1 or x >= v.width - 2 or y < 4 or y >= v.middle() -| 2 or (y - 2) % 3 != 2) return null;
    const i = (y - 2) / 3;
    if (i >= v.workspaceCapacity() or i + v.workspace_offset >= workspaces.len) return null;
    const ws = workspaces[i + v.workspace_offset];
    if (!resourceCardFits(v)) return null;
    for (0..2) |reading| if (shownReading(v.resources, ws.resources, reading)) return ws;
    return null;
}
fn resourceCardFits(v: View) bool {
    return resource_tooltip.geometry(v.cols, v.rows, v.width, 0) != null;
}
/// Whether the row shows CPU (0) or memory (1). Disk I/O is only in the hover card.
fn shownReading(prefs: Resources, work: resources.Work, reading: usize) bool {
    const available = if (reading == 0) work.cpu != null else work.memory != null;
    return prefs.enabled and available;
}
fn drawResources(w: *std.Io.Writer, work: resources.Work, v: View, hovered: bool) !void {
    const width = v.width -| 3;
    const prefs = v.resources;
    const details = resourceCardFits(v) and width >= 2 and (shownReading(prefs, work, 0) or shownReading(prefs, work, 1));
    const hover = details and hovered;
    const normal = if (hover) "\x1b[22;38;2;214;222;232m" else "\x1b[22;38;2;125;137;155m";
    if (hover) try w.writeAll("\x1b[48;2;48;57;70m");
    const readings_width = width - @as(usize, if (details) 2 else 0);
    var buffers: [2][32]u8 = undefined;
    const values = [_][]const u8{
        resources.cpuText(&buffers[0], work.cpu),
        resources.memoryText(&buffers[1], work.memory),
    };
    const names = [_][]const []const u8{ &.{ "CPU", "C" }, &.{ "Memory", "Mem", "M" } };
    for (values, names, 0..) |value, choices, i| {
        const room = if (i == 1) readings_width - readings_width / 2 else readings_width / 2;
        // The longest label that leaves room for a five-character value
        // (1234%, 12.3G) and, after CPU, a one-column gap.
        const label = for (choices) |name| {
            if (room >= name.len + 1 + 5 + @as(usize, if (i == 0) 1 else 0)) break name;
        } else choices[choices.len - 1];
        if (value.len == 0 or !shownReading(prefs, work, i)) {
            try w.splatByteAll(' ', room);
            continue;
        }
        // Only CPU alerts, in an amber softer than the working dot's.
        try w.writeAll(if (i == 0 and work.cpu_pressure) "\x1b[22;38;2;214;190;140m" else normal);
        try w.writeAll(label);
        if (room >= 7) try w.writeByte(' ');
        const used: usize = label.len + @as(usize, if (room >= 7) 1 else 0);
        try writeClipped(w, value, room -| used - @as(usize, if (i == 0) 1 else 0));
        const printed = used + @min(displayWidth(value), room -| used - @as(usize, if (i == 0) 1 else 0));
        try w.splatByteAll(' ', room -| printed);
    }
    if (details) {
        try w.writeAll(normal);
        try w.writeAll(" ›");
    }
    try w.writeAll("\x1b[22m");
}

test "resource row omits unavailable metrics and I/O, and preserves real zeros" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const view = View.init(100, 30, true, 0, 0);
    try drawResources(&output.writer, .{ .id = WorkspaceId.first }, view, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "--") == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, output.written(), 'C') == null);
    try std.testing.expect(std.mem.indexOfScalar(u8, output.written(), 'M') == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "↕") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "›") == null);
    output.clearRetainingCapacity();
    try drawResources(&output.writer, .{ .id = WorkspaceId.first, .known = true, .cpu = 0, .memory = 0, .read = 0, .written = 0 }, view, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "CPU 0%") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Memory 0M") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "›") != null);
    output.clearRetainingCapacity();
    try drawResources(&output.writer, .{ .id = WorkspaceId.first, .known = true, .cpu = 0, .memory = 0, .read = 3_000_000, .written = 1_000_000 }, view, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "↕") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "M/s") == null);
}

test "resource readings turn off as a whole" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const hot: resources.Work = .{ .id = WorkspaceId.first, .known = true, .cpu = 182, .memory = 3 << 30, .read = 0, .written = 0, .cpu_pressure = true };
    var view = View.init(100, 30, true, 0, 0).withWorkspaces(1, 0);
    try drawResources(&output.writer, hot, view, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "CPU 182%") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Memory 3.0G") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[22;38;2;214;190;140mCPU") != null);
    output.clearRetainingCapacity();
    // Narrower sidebars shorten labels rather than clipping values.
    try drawResources(&output.writer, hot, view.withWidth(26), false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "CPU 182%") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Mem 3.0G") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Memory") == null);
    output.clearRetainingCapacity();
    try drawResources(&output.writer, hot, view.withWidth(20), false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "C 182%") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "M 3.0G") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Mem") == null);
    output.clearRetainingCapacity();
    view.resources.enabled = false;
    try drawResources(&output.writer, hot, view, false);
    try std.testing.expect(std.mem.indexOfScalar(u8, output.written(), 'C') == null);
    view.resources.enabled = true;
    const entries = [_]WorkspaceEntry{.{ .id = WorkspaceId.first, .name = "a", .cwd = "", .active = true, .resources = hot }};
    try std.testing.expect(resourceAt(view, &entries, 3, 4) != null);
    var quiet = view;
    quiet.rows = 20;
    try std.testing.expect(resourceAt(quiet, &entries, 3, 4) == null);
    quiet = view;
    quiet.resources.enabled = false;
    try std.testing.expect(resourceAt(quiet, &entries, 3, 4) == null);
}

test "readings off removes the resource row and moves the separator under the status" {
    var view = View.init(100, 30, true, 0, 0);
    view.resources.enabled = false;
    const paged = view.withWorkspaces(8, 99);
    try std.testing.expectEqual(@as(usize, 5), paged.workspaceCapacity());
    try std.testing.expectEqual(@as(usize, 3), paged.workspace_offset);
    try std.testing.expectEqual(Hit{ .workspace = 3 }, paged.hit(24, 2));
    try std.testing.expectEqual(Hit{ .workspace = 3 }, paged.hit(24, 3));
    try std.testing.expectEqual(Hit{ .workspace = 4 }, paged.hit(24, 4));
    try std.testing.expectEqual(Hit{ .workspace = 7 }, paged.hit(24, 11));
    try std.testing.expectEqual(Hit.workspace_next, paged.hit(24, 12));
    try std.testing.expectEqual(@as(usize, 4), paged.workspaceDrop(5, 4).?.index);

    const hot: resources.Work = .{ .id = WorkspaceId.first, .known = true, .cpu = 182, .memory = 3 << 30, .read = 0, .written = 0, .cpu_pressure = true };
    const entries = [_]WorkspaceEntry{
        .{ .id = WorkspaceId.first, .name = "first", .cwd = "", .active = false, .resources = hot, .stats = .{ .tools = 12 } },
        .{ .id = @enumFromInt(2), .name = "second", .cwd = "", .active = true, .resources = hot },
    };
    view = view.withWorkspaces(entries.len, 0);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try view.draw(&output.writer, &.{}, &entries);
    const frame = output.written();
    try std.testing.expect(std.mem.indexOf(u8, frame, "182%") == null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "\x1b[4;2H\x1b[0;38;2;155;163;175;48;2;24;27;32m\x1b[4;58:2::65:70:77m") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "\x1b[4;58:2::65:70:77m⚒12") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "\x1b[5;2H\x1b[1;38;2;182;206;240;48;2;34;44;58msecond") != null);
    // The last workspace has no separator.
    try std.testing.expect(std.mem.indexOf(u8, frame, "\x1b[6;2H\x1b[0;38;2;155;163;175;48;2;34;44;58m\x1b[4;") == null);
    try std.testing.expect(resourceAt(view, &entries, 3, 4) == null);
}

pub fn agentAt(v: View, entries: []const Entry, x: u16, y: u16) ?*const Entry {
    const hit = v.hit(x, y);
    if (hit != .entry or hit.entry >= entries.len) return null;
    const entry = &entries[hit.entry];
    return if (entry.exit == null and entry.target != .group) entry else null;
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
    // Text arrives through std.json, which never yields invalid UTF-8
    // strings; count bytes if that ever changes.
    const view = std.unicode.Utf8View.init(text) catch return text.len;
    var it = view.iterator();
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
        // Same proof as displayWidth above.
        const n = std.unicode.utf8ByteSequenceLength(tail[0]) catch 1;
        width -= vt.unicode.codepointWidth(std.unicode.utf8Decode(tail[0..n]) catch 0);
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

test "all three workspace rows select while bottom controls remain distinct" {
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(2, 0);
    try std.testing.expectEqual(Hit{ .workspace = 0 }, view.hit(24, 2));
    try std.testing.expectEqual(Hit{ .workspace = 0 }, view.hit(24, 3));
    try std.testing.expectEqual(Hit{ .workspace = 0 }, view.hit(24, 4));
    try std.testing.expectEqual(Hit{ .workspace = 1 }, view.hit(24, 5));
    try std.testing.expectEqual(Hit{ .workspace = 1 }, view.hit(24, 6));
    try std.testing.expectEqual(Hit{ .workspace = 1 }, view.hit(24, 7));
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
    const entries = [_]WorkspaceEntry{.{ .id = @enumFromInt(1), .name = "abcdefghijklmnopqrstuvwxyz", .cwd = "/tmp", .active = true, .git_ahead = 123 }};
    try view.draw(&output.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "abcdefghijklmnopqrst") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "abcdefghijklmnopqrstu") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[3;23H\x1b[38;2;166;227;161m↑123") != null);
}

test "active workspace bar follows graphics support independently of the badge" {
    const entries = [_]WorkspaceEntry{ .{ .id = @enumFromInt(1), .name = "Other", .cwd = "/tmp", .active = false }, .{ .id = @enumFromInt(2), .name = "Project", .cwd = "/tmp", .active = true } };
    for ([_]struct { supported: bool, mode: corgi_badge.Mode }{
        .{ .supported = true, .mode = .image },
        .{ .supported = true, .mode = .emoji },
        .{ .supported = true, .mode = .none },
        .{ .supported = false, .mode = .emoji },
        .{ .supported = false, .mode = .none },
    }) |case| {
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        var view = View.init(100, 30, true, 0, 0).withWorkspaces(entries.len, 0);
        view.corgi_badge = case.mode;
        view.supports_kitty_graphics = case.supported;
        try view.draw(&output.writer, &.{}, &entries);
        const bar = if (case.supported) "\x1b[0;38;2;137;180;250;48;2;34;44;58m▌" else "\x1b[0;48;2;137;180;250m ";
        for ([_][]const u8{ "\x1b[6;1H", "\x1b[7;1H", "\x1b[8;1H" }) |row| {
            var buf: [96]u8 = undefined;
            try std.testing.expect(std.mem.indexOf(u8, output.written(), try std.fmt.bufPrint(&buf, "{s}{s}", .{ row, bar })) != null);
        }
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[3;1H\x1b[0;38;2;137;180;250") == null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;182;206;240;48;2;34;44;58mProject") != null);
    }
}

test "subagent badge shares the second row without reserving empty space" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var entry: Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .name = "Long agent title", .provider = .codex, .state = .working, .attention = .none, .activity = "abcdefghijklmnopqrstuv", .subagents = .{ .running = 2, .waiting = true } };
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
    const entries = [_]WorkspaceEntry{.{ .id = @enumFromInt(1), .name = "Project", .cwd = "/tmp", .active = false, .working = 1, .attention = 2, .unread = 3, .stats = .{ .tools = 12, .input = 1200, .output = 300, .tokens_known = true } }};
    try view.draw(&output.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;2H\x1b[0;38;2;155;163;175;48;2;24;27;32m\x1b[22m\x1b[38;2;249;226;175m●1") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;243;139;168m ●2") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;148;226;213m3 unread →") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "⚒12") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;24H\x1b[0;38;2;155;163;175;48;2;24;27;32m⚒12") != null);
    output.clearRetainingCapacity();
    const empty = [_]WorkspaceEntry{.{ .id = @enumFromInt(1), .name = "Project", .cwd = "/tmp", .active = true }};
    try view.draw(&output.writer, &.{}, &empty);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "unread") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "●0") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "⚒0") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;2H\x1b[0;38;2;155;163;175;48;2;34;44;58m\x1b[22m\x1b[38;2;166;227;161m○") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "—") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;25H\x1b[0;38;2;155;163;175;48;2;24;27;32m⚒0") == null);
    output.clearRetainingCapacity();
    var away = empty;
    away[0].active = false;
    away[0].stats = .{ .tools = 1, .input = 100, .output = 20, .tokens_known = true };
    try view.draw(&output.writer, &.{}, &away);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "unread") == null);
    output.clearRetainingCapacity();
    away[0].working = 1;
    away[0].attention = 1;
    away[0].stats = .{ .tools = 999_000, .input = 999_000, .output = 999_000, .tokens_known = true };
    try view.draw(&output.writer, &.{}, &away);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "unread") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[1;38;2;243;139;168m ●1") != null);
}

test "unread label and arrow share their hit area across sidebar widths" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var ws: WorkspaceEntry = .{ .id = @enumFromInt(1), .name = "Project", .cwd = "/tmp", .active = false, .unread = 3, .working = 1, .attention = 2 };
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

test "compaction herds on the second agent row ahead of waiting and summaries" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const entry: Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .name = "Agent title", .provider = .codex, .state = .working, .attention = .none, .compacting = true, .activity = "Old summary", .subagents = .{ .waiting = true } };
    const view = View.init(100, 30, true, 0, 1);
    try view.drawAt(&output.writer, &.{}, &.{}, 0); // Forget herds from earlier draws.
    // The herd starts scattered beside the pile; the corgi pushes it together
    // and curls into the ellipsis, which stays.
    for ([_]i64{ 1000, 1000 + 12 * 110, 1000 + 29 * 110, 60_000 }, [_][]const u8{ "⣿  C o  mp  a ct  i n  g", "Compacting‹o[/\\]~", "Compacting… ", "Compacting… " }) |now, row| {
        output.clearRetainingCapacity();
        try view.drawAt(&output.writer, &.{entry}, &.{}, now);
        const host = try terminal.Terminal.create(100, 30);
        defer host.destroy();
        host.feed(output.written());
        const text = try host.text();
        defer a.free(text);
        try std.testing.expect(std.mem.indexOf(u8, text, row) != null);
        try std.testing.expect(std.mem.indexOf(u8, text, "Old summary") == null);
        try std.testing.expect(std.mem.indexOf(u8, text, "Waiting on agents") == null);
    }
    // Too narrow to herd: the text stays, and the pile still moves.
    output.clearRetainingCapacity();
    try view.withWidth(23).drawAt(&output.writer, &.{entry}, &.{}, 1000);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[18;5H\x1b[38;2;226;230;233mCompacting…") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "⣿") != null);
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
        const candidate = ports.url(&candidate_buf, endpoint, ws.remote_links) orelse continue;
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
        const candidate = ports.url(&candidate_buf, endpoint, ws.remote_links) orelse continue;
        if (std.mem.eql(u8, target, candidate) and endpoint.label_pending) return true;
    }
    return false;
}
fn portPending(ws: WorkspaceEntry) bool {
    for (0..urlCount(ws)) |i| if (workspaceUrlPending(ws, i)) return true;
    return false;
}
/// The link button's name, or null while inference is still naming it.
fn portName(ws: WorkspaceEntry) ?[]const u8 {
    var name = workspaceUrlName(ws, 0);
    // A common name is useful for duplicate app endpoints; distinct apps keep
    // the generic chooser label and their individual names inside the menu.
    for (1..@max(1, urlCount(ws))) |i| if (!std.mem.eql(u8, name, workspaceUrlName(ws, i))) {
        name = "";
        break;
    };
    if (name.len > 0) return name;
    return if (portPending(ws)) null else "Link";
}
fn portLabel(ws: WorkspaceEntry, buf: []u8) []const u8 {
    const count = urlCount(ws);
    const name = portName(ws) orelse "...";
    return if (count == 1) std.fmt.bufPrint(buf, "Open {s} ↗", .{name}) catch "Open Link ↗" else std.fmt.bufPrint(buf, "Open {s} ↗ {d}", .{ name, count }) catch "Open Link ↗";
}
/// A label still `naming` its link starts "Open ...". Keep all three dots in
/// place; only their blue intensity travels gently. Quantized to 80ms so idle
/// viewers do not emit a different frame every poll.
fn writePortLabel(w: *std.Io.Writer, label: []const u8, width: usize, naming: bool, now_ms: i64) !void {
    if (!naming) return writeClipped(w, label, width);
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
    if (v.width == 0 or x < 1 or y < 2 or y >= v.middle() - 2 or (y - 2) % v.workspaceRows() != 0) return null;
    const offset = (y - 2) / v.workspaceRows();
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
        try writePortLabel(w, label, width, portName(ws) == null, os.milliTimestamp());
        if (count == 1) try w.writeAll("\x1b]8;;\x1b\\");
        try w.writeAll("\x1b[24;38;2;155;163;175m");
        if (divider) try w.writeAll("\x1b[4;58:2::65:70:77m");
    }
    return null;
}

/// Hover popover under the agents header for choosing which agents are listed.
pub const ScopeMenu = struct {
    pinned: bool = false,
    hovered: ?Scope = null,
    pub fn bounds(side: View, cols: u16, rows: u16) layout.Rect {
        const y = side.middle() + 1;
        const width = @min(cols -| 1, @max(side.width -| 2, 26));
        const height = @min(4, (rows -| 1) -| y);
        return .{ .x = 1, .y = y, .w = width, .h = @intCast(height) };
    }
    pub fn hit(side: View, cols: u16, rows: u16, x: u16, y: u16) ?Scope {
        const b = bounds(side, cols, rows);
        if (b.h < 4 or x <= b.x or x + 1 >= b.x + b.w or y <= b.y or y + 1 >= b.y + b.h) return null;
        return switch (y - b.y) {
            1 => .workspace,
            2 => .all,
            else => null,
        };
    }
    pub fn draw(menu: ScopeMenu, w: *std.Io.Writer, side: View, cols: u16, rows: u16, workspaces: []const WorkspaceEntry, scope: Scope) !void {
        const b = bounds(side, cols, rows);
        if (b.h < 4 or b.w < 16) return;
        const border = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
        for (0..b.h) |y| {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + 1, border });
            try w.writeAll(if (y == 0) "╭" else if (y == b.h - 1) "╰" else "│");
            if (y == 0 or y == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (y == 0) "╮" else if (y == b.h - 1) "╯" else "│");
        }
        var total: usize = 0;
        var current: usize = 0;
        for (workspaces) |ws| {
            total += ws.agents;
            if (ws.active) current = ws.agents;
        }
        try menu.row(w, b, 1, .workspace, scope, "This workspace", current);
        try menu.row(w, b, 2, .all, scope, "All", total);
        try w.writeAll("\x1b[0m");
    }
    fn row(menu: ScopeMenu, w: *std.Io.Writer, b: layout.Rect, y: u16, option: Scope, scope: Scope, text: []const u8, count: usize) !void {
        const hovered = menu.hovered == option;
        const style = if (hovered) "\x1b[0;38;2;226;230;233;48;2;47;64;59m" else "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
        const line = b.y + y + 1;
        try w.print("\x1b[{d};{d}H{s}", .{ line, b.x + 2, style });
        try w.splatByteAll(' ', b.w - 2);
        if (option == scope) try w.print("\x1b[{d};{d}H\x1b[38;2;166;227;161m✓{s}", .{ line, b.x + 3, style });
        var number_buf: [24]u8 = undefined;
        const number = compactCount(&number_buf, count);
        const count_width = displayWidth(number);
        const right = b.x + b.w - 2 - count_width;
        try w.print("\x1b[{d};{d}H\x1b[38;2;125;132;143m{s}{s}", .{ line, right + 1, number, style });
        try w.print("\x1b[{d};{d}H", .{ line, b.x + 5 });
        try writeEllipsis(w, text, (right -| (b.x + 4)) -| 2);
    }
};

pub const PortMenu = struct {
    workspace: WorkspaceId,
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
            try w.print("\x1b[{d};{d}H{s} {s} \x1b]8;id=corgi-popup-{d}-{d};{s}\x1b\\", .{
                rect.y + 3 + index - offset,
                rect.x + 1,
                if (index == selected) "\x1b[38;2;137;180;250;48;2;49;56;68m" else "\x1b[38;2;137;180;250;48;2;35;40;47m",
                if (index == selected) "›" else " ",
                ws.id,
                index,
                url,
            });
            const name = workspaceUrlName(ws, index);
            var label_buf: [384]u8 = undefined;
            const naming = name.len == 0 and workspaceUrlPending(ws, index);
            const label = if (name.len > 0) try std.fmt.bufPrint(&label_buf, "Open {s} · {s}", .{ name, url }) else if (naming) try std.fmt.bufPrint(&label_buf, "Open ... · {s}", .{url}) else url;
            try writePortLabel(w, label, rect.w - 4, naming, os.milliTimestamp());
            try w.writeAll("\x1b]8;;\x1b\\");
        }
    }
};

test "workspace port labels contain OSC8 URLs selected per viewer" {
    const ifaces = [_]ports.Interface{.{ .name = "tailscale0", .address = "100.80.1.2", .kind = .tailscale }};
    const endpoints = [_]ports.Endpoint{.{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .transport = .tcp, .bind_address = "*", .port = 3000, .scheme = .http, .http_status = 200, .interfaces = &ifaces }};
    const works = [_]ports.Work{.{ .id = @enumFromInt(1), .background = 2, .endpoints = &endpoints }};
    var ws: WorkspaceEntry = .{ .id = @enumFromInt(1), .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } };
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
    const endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = @enumFromInt(1), .name = "dns", .transport = .udp, .bind_address = "127.0.0.1", .port = 5353 },
        .{ .pid = 13, .pane = @enumFromInt(1), .name = "db", .transport = .tcp, .bind_address = "::1", .port = 5432, .ipv6 = true },
    };
    const works = [_]ports.Work{.{ .id = @enumFromInt(1), .endpoints = &endpoints }};
    const ws: WorkspaceEntry = .{ .id = @enumFromInt(1), .name = "test", .cwd = "/tmp", .active = true, .remote_links = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } };
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try drawPorts(&out.writer, ws, 60, false);
    try std.testing.expectEqualStrings("", out.written());
}

test "port hit testing matches clipped labels and outer terminal receives link metadata" {
    const endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 },
        .{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3001, .scheme = .http, .http_status = 200 },
    };
    const works = [_]ports.Work{.{ .id = @enumFromInt(1), .endpoints = &endpoints }};
    const entries = [_]WorkspaceEntry{.{ .id = @enumFromInt(1), .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .processes_available = true, .ports_available = true, .workspaces = &works } }};
    const view = View.init(80, 24, true, 0, 0).withWorkspaces(1, 0);
    var buf: [256]u8 = undefined;
    try std.testing.expect(portLink(view, &entries, 1, 4, &buf) == null);
    try std.testing.expectEqual(@as(WorkspaceId, @enumFromInt(1)), portWorkspace(view, &entries, 12, 2).?.id);
    try std.testing.expect(portWorkspace(view, &entries, 1, 2) == null);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try view.draw(&out.writer, &.{}, &entries);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open Link ↗ 2") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "http://") == null);
    const menu: PortMenu = .{ .workspace = @enumFromInt(1) };
    try menu.draw(&out.writer, entries[0], 80, 24);
    const host = try terminal.Terminal.create(80, 24);
    defer host.destroy();
    host.feed(out.written());
    try host.updateRender();
    try std.testing.expectEqual(@as(usize, 2), host.hyperlinks().len);
    try std.testing.expectEqualStrings("http://localhost:3000", host.hyperlinks()[0].uri);
    const rect = PortMenu.bounds(80, 24);
    try std.testing.expectEqual(@as(usize, 0), menu.hit(entries[0], 80, 24, rect.x + 3, rect.y + 2).?);
    try std.testing.expect(menu.hit(entries[0], 80, 24, 0, 0) == null);
    var single = entries[0];
    const single_works = [_]ports.Work{.{ .id = @enumFromInt(1), .endpoints = endpoints[0..1] }};
    single.ports.workspaces = &single_works;
    try std.testing.expectEqualStrings("http://localhost:3000", portLink(view, &.{single}, 13, 2, &buf).?);
}

test "inferred link names share clipped hit geometry and name chooser destinations" {
    var endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .label = "Finance Dashboard", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 },
        .{ .pid = 13, .pane = @enumFromInt(2), .name = "web", .label = "API Docs", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3001, .scheme = .http, .http_status = 200 },
    };
    var works = [_]ports.Work{.{ .id = @enumFromInt(1), .endpoints = endpoints[0..1] }};
    const ws: WorkspaceEntry = .{ .id = @enumFromInt(1), .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .workspaces = &works } };
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
    try (PortMenu{ .workspace = @enumFromInt(1) }).draw(&out.writer, ws, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open Finance Dashboard · http://localhost:3000") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "Open API Docs · http://localhost:3001") != null);
}

test "only a link still being named animates its placeholder dots" {
    var endpoints = [_]ports.Endpoint{
        .{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .label_pending = true, .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 },
    };
    var works = [_]ports.Work{.{ .id = @enumFromInt(1), .endpoints = &endpoints }};
    const ws: WorkspaceEntry = .{ .id = @enumFromInt(1), .name = "test", .cwd = "/tmp", .active = true, .ports = .{ .workspaces = &works } };
    var buf: [96]u8 = undefined;
    try std.testing.expect(portName(ws) == null);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writePortLabel(&out.writer, portLabel(ws, &buf), 40, portName(ws) == null, 0);
    try std.testing.expect(std.mem.startsWith(u8, out.written(), "Open \x1b[38;2;"));
    try std.testing.expect(std.mem.endsWith(u8, out.written(), " ↗"));
    endpoints[0] = .{ .pid = 12, .pane = @enumFromInt(1), .name = "web", .label = "Docs", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http, .http_status = 200 };
    try std.testing.expectEqualStrings("Docs", portName(ws).?);
    out.clearRetainingCapacity();
    try writePortLabel(&out.writer, portLabel(ws, &buf), 40, portName(ws) == null, 0);
    try std.testing.expectEqualStrings("Open Docs ↗", out.written());
}

test "corgi frames occupy one column per glyph in the terminal" {
    const routines = [_][]const []const u8{ &corgi_frames.wag, &corgi_frames.fetch, &corgi_frames.sniff };
    for (routines) |routine| for (routine) |frame| {
        try std.testing.expectEqual(try std.unicode.utf8CountCodepoints(frame), displayWidth(frame));
        try std.testing.expect(displayWidth(frame) <= 18);
    };
}

test "idle face replaces stale activity while working activity remains useful" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var entry: Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .name = "Agent", .provider = .codex, .state = .idle, .attention = .none, .activity = "Reading source files" };
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

/// Keep the right edge fixed: expansion covers the name, never moves the badge.
fn gitLabel(buf: []u8, ws: WorkspaceEntry, expanded: bool) []const u8 {
    switch (ws.git_push.phase) {
        .pushing => {
            const frames = [_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
            const i: usize = @intCast(@mod(@divFloor(os.milliTimestamp(), 80), frames.len));
            return std.fmt.bufPrint(buf, " Pushing {s}", .{frames[i]}) catch "";
        },
        .succeeded => return " Pushed ✓",
        .failed => return " Retry !",
        .idle => {},
    }
    const count = ws.git_ahead orelse return "";
    if (count == 0) return "";
    var number: [24]u8 = undefined;
    return std.fmt.bufPrint(buf, "{s}↑{s}", .{ if (expanded) " Push " else "", compactCount(&number, count) }) catch "";
}

pub fn gitWorkspace(v: View, workspaces: []const WorkspaceEntry, x: u16, y: u16) ?WorkspaceEntry {
    return gitActionWorkspace(v, workspaces, null, x, y);
}

pub fn gitActionWorkspace(v: View, workspaces: []const WorkspaceEntry, expanded: ?WorkspaceId, x: u16, y: u16) ?WorkspaceEntry {
    if (v.width == 0 or y < 2 or (y - 2) % v.workspaceRows() != 0) return null;
    const hit = v.hit(x, y);
    if (hit != .workspace or hit.workspace >= workspaces.len) return null;
    const ws = workspaces[hit.workspace];
    var buf: [64]u8 = undefined;
    const size = displayWidth(gitLabel(&buf, ws, expanded == ws.id));
    const end = v.width - 2;
    return if (size > 0 and x >= end -| size and x < end) ws else null;
}

pub fn drawGitAction(w: *std.Io.Writer, v: View, workspaces: []const WorkspaceEntry, id: WorkspaceId) !void {
    if (v.width == 0) return;
    for (workspaces[v.workspace_offset..@min(workspaces.len, v.workspace_offset + v.workspaceCapacity())], 0..) |ws, i| {
        if (ws.id != id) continue;
        var buf: [64]u8 = undefined;
        const label = gitLabel(&buf, ws, true);
        if (label.len == 0) return;
        const color = if (ws.git_push.phase == .failed) "243;139;168" else "166;227;161";
        try w.print("\x1b]8;;\x1b\\\x1b[{d};{d}H\x1b[0;1;38;2;{s};48;2;48;62;58m{s}\x1b[0m", .{ 3 + i * v.workspaceRows(), v.width - 1 - displayWidth(label), color, label });
        return;
    }
}

fn drawGitError(w: *std.Io.Writer, message: []const u8, cols: u16, rows: u16, px: u16, py: u16) !void {
    const width: usize = @min(76, cols);
    const room = width - 4;
    var lines: [20][]const u8 = undefined;
    var count: usize = 0;
    var rest = message;
    while (rest.len > 0 and count < @min(lines.len, rows - 5)) {
        var end: usize = 0;
        while (end < rest.len) {
            const next = end + (std.unicode.utf8ByteSequenceLength(rest[end]) catch 1);
            if (displayWidth(rest[0..next]) > room) break;
            end = next;
        }
        if (end < rest.len) if (std.mem.lastIndexOfScalar(u8, rest[0..end], ' ')) |space| {
            if (space > 0) end = space;
        };
        if (end == 0) break;
        lines[count] = rest[0..end];
        count += 1;
        rest = std.mem.trimStart(u8, rest[end..], " ");
    }
    const height = count + 3;
    const x = @min(@as(usize, px) + 2, cols - width);
    const y = @min(@as(usize, py) + 1, rows - 1 - height);
    try w.writeAll("\x1b7\x1b]8;;\x1b\\");
    for (0..height) |row| {
        try w.print("\x1b[{d};{d}H\x1b[0;38;2;243;139;168;48;2;30;30;46m", .{ y + row + 1, x + 1 });
        try w.writeAll(if (row == 0) "╭" else if (row == height - 1) "╰" else "│");
        for (0..width - 2) |_| try w.writeAll(if (row == 0 or row == height - 1) "─" else " ");
        try w.writeAll(if (row == 0) "╮" else if (row == height - 1) "╯" else "│");
    }
    try w.print("\x1b[{d};{d}H\x1b[1mPush failed\x1b[22m", .{ y + 2, x + 3 });
    for (lines[0..count], 0..) |line, i| try w.print("\x1b[{d};{d}H{s}", .{ y + 3 + i, x + 3, line });
    try w.writeAll("\x1b[0m\x1b8");
}

pub fn drawGitTooltip(w: *std.Io.Writer, ws: WorkspaceEntry, cols: u16, rows: u16, px: u16, py: u16) !void {
    if (cols < 24 or rows < 8) return;
    if (ws.git_push.phase == .failed) return drawGitError(w, ws.git_push.message, cols, rows, px, py);
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
        const age = relativeTime(&age_buf, item.timestamp, os.timestamp());
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

test "agents header names its scope and opens the scope menu left of New" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for ([_]u16{ 20, 28, 40 }) |width| {
        var view = View.init(100, 30, true, 0, 0).withWidth(width);
        view.scope_label = "all";
        try std.testing.expectEqual(Hit.none, view.hit(1, view.middle()));
        try std.testing.expectEqual(Hit.none, view.hit(view.scopeStart() - 1, view.middle()));
        try std.testing.expectEqual(Hit.agent_scope, view.hit(view.scopeStart(), view.middle()));
        const end: u16 = if (width == 20) 10 else 14;
        try std.testing.expectEqual(Hit.agent_scope, view.hit(end - 1, view.middle()));
        if (width > 20) try std.testing.expectEqual(Hit.none, view.hit(end, view.middle()));
        try std.testing.expectEqual(Hit.agent_new, view.hit(width - 10, view.middle()));
        view.scope_label = "a workspace with a long name";
        try view.draw(&output.writer, &.{}, &.{});
        const host = try terminal.Terminal.create(100, 30);
        defer host.destroy();
        host.feed(output.written());
        const text = try host.text();
        defer a.free(text);
        var lines = std.mem.splitScalar(u8, text, '\n');
        for (0..view.middle()) |_| _ = lines.next();
        const header = lines.next().?;
        // The label never runs into the New button.
        try std.testing.expect(std.mem.indexOf(u8, header, "agents") != null);
        try std.testing.expect(std.mem.indexOf(u8, header, "New") != null);
        try std.testing.expect(std.mem.indexOf(u8, header, "…") != null);
        output.clearRetainingCapacity();
    }
}

test "scope menu offers only the current workspace and all agents" {
    const workspaces = [_]WorkspaceEntry{
        .{ .id = @enumFromInt(4), .name = "corgi", .cwd = "/tmp", .active = true, .agents = 3, .working = 2, .attention = 1 },
        .{ .id = @enumFromInt(7), .name = "blog", .cwd = "/tmp", .active = false, .agents = 1 },
        .{ .id = @enumFromInt(9), .name = "notes", .cwd = "/tmp", .active = false },
    };
    const view = View.init(100, 30, true, 0, 0).withWorkspaces(3, 0);
    const b = ScopeMenu.bounds(view, 100, 30);
    try std.testing.expectEqual(@as(u16, 4), b.h);
    try std.testing.expectEqual(@as(?Scope, .workspace), ScopeMenu.hit(view, 100, 30, 5, b.y + 1));
    try std.testing.expectEqual(@as(?Scope, .all), ScopeMenu.hit(view, 100, 30, 5, b.y + 2));
    try std.testing.expectEqual(@as(?Scope, null), ScopeMenu.hit(view, 100, 30, 5, b.y + 3));
    try std.testing.expectEqual(@as(?Scope, null), ScopeMenu.hit(view, 100, 30, 5, b.y + 5));
    try std.testing.expectEqual(@as(?Scope, null), ScopeMenu.hit(view, 100, 30, b.x, b.y + 1));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try (ScopeMenu{}).draw(&output.writer, view, 100, 30, &workspaces, .all);
    const host = try terminal.Terminal.create(100, 30);
    defer host.destroy();
    host.feed(output.written());
    const text = try host.text();
    defer a.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    for (0..b.y + 1) |_| _ = lines.next();
    try std.testing.expectEqualStrings(" │   This workspace     3 │", std.mem.trimEnd(u8, lines.next().?, " "));
    try std.testing.expectEqualStrings(" │ ✓ All                4 │", std.mem.trimEnd(u8, lines.next().?, " "));
    try std.testing.expectEqualStrings(" ╰────────────────────────╯", std.mem.trimEnd(u8, lines.next().?, " "));
    for (workspaces) |ws| try std.testing.expect(std.mem.indexOf(u8, text, ws.name) == null);
}

test "grouped list draws one-row headers with a margin guide and measures rows per entry" {
    const entries = [_]Entry{
        .{ .target = .{ .group = @enumFromInt(1) }, .name = "corgi", .provider = .codex, .state = .idle, .attention = .none, .group = .{ .agents = 2, .working = 1, .current = true } },
        .{ .target = .{ .pane = @enumFromInt(1) }, .name = "api refactor", .provider = .codex, .state = .blocked, .attention = .none, .focused = true },
        .{ .target = .{ .pane = @enumFromInt(2) }, .name = "release notes", .provider = .claude, .state = .done, .attention = .none },
        .{ .target = .{ .group = @enumFromInt(2) }, .name = "blog", .provider = .codex, .state = .idle, .attention = .none, .group = .{ .agents = 1, .attention = 1, .folded = true } },
    };
    const view = View.init(100, 30, true, 0, entries.len).withEntries(&entries);
    const top = view.middle() + 2;
    try std.testing.expectEqual(@as(usize, 4), view.capacity);
    for ([_]struct { u16, usize }{ .{ 0, 0 }, .{ 1, 1 }, .{ 2, 1 }, .{ 3, 2 }, .{ 4, 2 }, .{ 5, 3 } }) |case| {
        try std.testing.expectEqual(Hit{ .entry = case[1] }, view.hit(5, top + case[0]));
    }
    try std.testing.expectEqual(Hit.none, view.hit(5, top + 6));
    try std.testing.expect(agentAt(view, &entries, 5, top) == null);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try view.draw(&output.writer, &entries, &.{});
    const host = try terminal.Terminal.create(100, 30);
    defer host.destroy();
    host.feed(output.written());
    const text = try host.text();
    defer a.free(text);
    var lines = std.mem.splitScalar(u8, text, '\n');
    for (0..top) |_| _ = lines.next();
    var rows: [6][]const u8 = undefined;
    for (&rows) |*row| row.* = std.mem.trimEnd(u8, lines.next().?[0..@min(80, lines.peek().?.len)], " ");
    // The focused agent's rail turns heavy but stays continuous.
    const expected = [_][]const u8{
        "▾ corgi ━━━━━━━━━━━━━ 1● 2 │",
        "┣●  api refactor           │",
        "┃   Needs input            │",
        "╰○  release notes          │",
        "    Session ended          │",
        "▸ blog ━━━━━━━━━━━━━━ 1● 1 │",
    };
    for (expected, rows) |want, got| try std.testing.expectEqualStrings(want, got);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[0;38;2;137;180;250m\x1b[48;2;34;44;58m┣") != null);
    // Without Kitty graphics there is no separator; with it, a dotted one under the text.
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4:4m") == null);
    output.clearRetainingCapacity();
    var rich = view;
    rich.corgi_badge = .emoji;
    rich.supports_kitty_graphics = true;
    try rich.draw(&output.writer, &entries, &.{});
    var dotted: [64]u8 = undefined;
    try std.testing.expect(std.mem.indexOf(u8, output.written(), try std.fmt.bufPrint(&dotted, "\x1b[{d};5H\x1b[4:4m", .{top + 3})) != null);
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output.written(), "\x1b[4:4m\x1b[58:2::65:70:77m") / 2);
}

test "grouped scrolling fits more rows when headers are shorter" {
    var entries: [7]Entry = undefined;
    for (&entries, 0..) |*e, i| e.* = .{ .target = if (i % 3 == 0) .{ .group = @enumFromInt(i) } else .{ .pane = @enumFromInt(i) }, .provider = .codex, .state = .idle, .attention = .none };
    // 13 rows leave five list rows: three entries where only two agents fit.
    const view = View.init(100, 13, true, 0, entries.len).withEntries(&entries);
    try std.testing.expectEqual(@as(usize, 3), view.capacity);
    try std.testing.expectEqual(@as(usize, 4), view.maxOffset());
    try std.testing.expectEqual(@as(usize, 1), view.reveal(3));
    try std.testing.expectEqual(@as(usize, 4), View.init(100, 13, true, 99, entries.len).withEntries(&entries).offset);
}

test "agent list shows a scrollbar on the border only when it overflows" {
    var entries: [6]Entry = undefined;
    for (&entries, 0..) |*e, i| e.* = .{ .target = .{ .pane = @enumFromInt(i) }, .provider = .codex, .state = .idle, .attention = .none };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    // 24 rows leave eleven list rows, down to the bottom: five agents.
    const fits = View.init(80, 24, true, 0, 5).withEntries(entries[0..5]);
    try std.testing.expect(fits.thumb() == null);
    try fits.drawAt(&output.writer, entries[0..5], &.{}, 0);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "┃") == null);
    output.clearRetainingCapacity();
    const top = View.init(80, 24, true, 0, entries.len).withEntries(&entries);
    try std.testing.expectEqual(@as(usize, 0), top.thumb().?.start);
    try std.testing.expectEqual(@as(usize, 10), top.thumb().?.len);
    try std.testing.expectEqual(@as(usize, 1), View.init(80, 24, true, 99, entries.len).withEntries(&entries).thumb().?.start);
    try top.drawAt(&output.writer, &entries, &.{}, 0);
    try std.testing.expectEqual(@as(usize, 10), std.mem.count(u8, output.written(), "┃"));
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[14;28H") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "/6") == null);
    try std.testing.expectEqual(Hit{ .entry = 4 }, top.hit(5, top.rows - 2));
    // The search hint takes the bottom row.
    const searching = View.init(80, 24, true, 0, 5).withSearch(.{ .text = "", .cursor = 0 }).withEntries(entries[0..5]);
    try std.testing.expectEqual(@as(usize, 5), searching.capacity);
    try std.testing.expectEqual(Hit.none, searching.hit(5, searching.rows - 1));
}

test "git badge hit area follows sidebar width and workspace scroll" {
    const entries = [_]WorkspaceEntry{
        .{ .id = @enumFromInt(1), .name = "one", .cwd = "/tmp", .active = false },
        .{ .id = @enumFromInt(2), .name = "two", .cwd = "/tmp", .active = true, .git_ahead = 14 },
        .{ .id = @enumFromInt(3), .name = "three", .cwd = "/tmp", .active = false },
    };
    const view = View.init(100, 20, true, 0, 0).withWidth(36).withWorkspaces(3, 1);
    try std.testing.expectEqual(@as(WorkspaceId, @enumFromInt(2)), gitWorkspace(view, &entries, 31, 2).?.id);
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
    const host = try terminal.Terminal.create(100, 30);
    defer host.destroy();
    var entry: Entry = .{ .target = .{ .pane = @enumFromInt(10001) }, .name = "Agent", .provider = .codex, .state = .working, .attention = .none };
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
    defer a.free(mixed);
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
    defer a.free(completed);
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

test "only one sleeping corgi puffs at a time, and turning them off leaves a faint Z" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var entries: [4]Entry = undefined;
    for (&entries, 1..) |*entry, id| entry.* = .{ .target = .{ .pane = @enumFromInt(id) }, .name = "Agent", .provider = .claude, .state = .idle, .attention = .none };
    var view = View.init(100, 30, true, 0, entries.len);
    view.scope_label = "Corgi";
    var puffed = false;
    var now: i64 = 0;
    while (now < corgi_animation.dream_period_ms) : (now += 150) {
        output.clearRetainingCapacity();
        try view.drawAt(&output.writer, &entries, &.{}, now);
        const letters = std.mem.count(u8, output.written(), "ᶻ") + std.mem.count(u8, output.written(), "z");
        try std.testing.expect(letters <= 2);
        puffed = puffed or letters > 0;
    }
    try std.testing.expect(puffed);
    try std.testing.expectEqual(entries.len, std.mem.count(u8, output.written(), "~ᐯ◡ᴥ◡ᐯ"));
    view.sleeping_corgis = false;
    output.clearRetainingCapacity();
    try view.drawAt(&output.writer, &entries, &.{}, 0);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᐯ◡ᴥ◡ᐯ") == null);
    try std.testing.expectEqual(entries.len, std.mem.count(u8, output.written(), "\x1b[22;38;2;70;74;88mᶻ"));
    // Question marks outside escape sequences would be a placeholder label.
    try std.testing.expectEqual(std.mem.count(u8, output.written(), "\x1b[?"), std.mem.count(u8, output.written(), "?"));
}

test "context shows on the name line only near compaction and dims while compacting" {
    const entries = [_]Entry{
        .{ .target = .{ .pane = @enumFromInt(1) }, .name = "migrate checkpoints", .provider = .codex, .state = .working, .attention = .none, .context = .{ .used = 190_000, .window = 258_400, .at = 1 } },
        .{ .target = .{ .pane = @enumFromInt(2) }, .name = "api refactor", .provider = .codex, .state = .working, .attention = .none, .context = .{ .used = 120_000, .window = 258_400, .at = 1 } },
        .{ .target = .{ .pane = @enumFromInt(3) }, .name = "release notes", .provider = .claude, .state = .working, .attention = .none, .compacting = true, .context = .{ .used = 380_000, .window = 1_000_000, .compacts_at = 400_000, .at = 1 } },
    };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try View.init(100, 30, true, 0, entries.len).draw(&output.writer, &entries, &.{});
    const host = try terminal.Terminal.create(100, 30);
    defer host.destroy();
    host.feed(output.written());
    const text = try host.text();
    defer a.free(text);
    // 74% of the window is 74% of the way: amber, and the name gives way.
    try std.testing.expect(std.mem.indexOf(u8, text, "migrate checkpoin… 74%") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;250;179;135m74%") != null);
    // 46% of the way shows nothing.
    try std.testing.expect(std.mem.indexOf(u8, text, "api refactor") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "46%") == null);
    // 38% of a 1M window is 95% of the way to a learned 400k: red, faded toward the row.
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;111;71;86m38%") != null);
}
