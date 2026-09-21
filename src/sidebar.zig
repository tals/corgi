const std = @import("std");
const agents = @import("agents.zig");
const layout = @import("layout.zig");
const vt = @import("ghostty-vt");

pub const max_entries = layout.max_panes + 16;
pub const Target = union(enum) { pane: u32, native: u32 };
pub const Entry = struct {
    name: []const u8 = "",
    target: Target,
    provider: agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    focused: bool = false,
    cwd: []const u8 = "",
    tool_active: bool = false,
    unread: bool = false,
    activity: []const u8 = "",

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

pub const WorkspaceEntry = struct { git_ahead: ?u64 = null, id: u32, name: []const u8, cwd: []const u8, active: bool, working: usize = 0, unread: usize = 0, attention: usize = 0, stats: @import("usage.zig").Counts = .{} };
pub const Hit = union(enum) { none, toggle, previous, next, entry: usize, workspace_new, workspace_previous, workspace_next, workspace: usize };
pub const View = struct {
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
        const metadata_width = displayWidth(compactCount(&buf, ws.stats.tools)) + 1;
        const attention_width = if (ws.attention > 0) displayWidth(compactCount(&buf, ws.attention)) + 1 else 0;
        const working_width = if (ws.working > 0) displayWidth(compactCount(&buf, ws.working)) + 1 else 1;
        const room = ((v.width -| 3) -| (metadata_width + 1)) -| (unread_width + 1);
        const slot = @max(3, working_width);
        const working = if (slot + attention_width <= room) slot else 0;
        const status_width = working + @min(attention_width, room - working);
        const start = 1 + status_width + @as(usize, if (working > 0 or attention_width > 0) 1 else 0);
        return .{ .start = start, .end = start + unread_width };
    }
    pub fn unreadHit(v: View, ws: WorkspaceEntry, x: u16, y: u16) bool {
        if (ws.unread == 0 or y < 3 or (y - 2) % 3 != 1) return false;
        const range = v.unreadRange(ws);
        return x >= range.start and x < range.end;
    }
    pub fn draw(v: View, w: *std.Io.Writer, entries: []const Entry, workspaces: []const WorkspaceEntry) !void {
        const thinking_frames = [_][]const u8{ "⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏" };
        const thinking_frame: usize = @intCast(@mod(@divFloor(std.time.milliTimestamp(), 80), thinking_frames.len));
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
        try w.print("\x1b[1;{d}H{s} < ", .{ v.width - 4, panel });
        try v.line(w, 0, "workspaces", "\x1b[1;38;2;226;230;233m");
        try w.print("\x1b[1;{d}H\x1b[0;1;38;2;161;194;178;48;2;35;40;47m[ + ]{s}", .{ v.width - 10, panel });
        for (workspaces[v.workspace_offset..@min(workspaces.len, v.workspace_offset + v.workspaceCapacity())], 0..) |ws, index| {
            const y: u16 = @intCast(2 + index * 3);
            const style = if (ws.active) "\x1b[1;38;2;161;194;178;48;2;35;40;47m" else panel;
            try w.print("\x1b[{d};1H{s}", .{ y + 1, style });
            try w.splatByteAll(' ', v.width - 1);
            var label: [std.fs.max_path_bytes + 1]u8 = undefined;
            var badge_buf: [32]u8 = undefined;
            const badge = if (ws.git_ahead) |n| if (n > 0) try std.fmt.bufPrint(&badge_buf, "↑{d}", .{n}) else "" else "";
            const badge_width = displayWidth(badge);
            try w.print("\x1b[{d};2H{s}", .{ y + 1, style });
            try writeClipped(w, directoryLabel(&label, ws.name, null), v.width - 3 - (if (badge_width > 0) badge_width + 1 else 0));
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
            const left_room = (v.width - 3) -| (metadata_width + 1);
            var room: usize = left_room -| (unread_width + 1);
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
            if (has_status) try w.writeByte(' ');
            try w.print("\x1b[{d};{d}H", .{ y + 2, v.unreadRange(ws).start + 1 });
            var unread_room = unread_width;
            try statusPart(w, unread, if (ws.unread > 0) "\x1b[1;38;2;148;226;213m" else panel, &unread_room);
            try w.print("\x1b[{d};{d}H{s}{s}", .{ y + 2, v.width - 1 - metadata_width, panel, metadata });
            try w.writeAll(panel);
        }
        if (v.workspace_count > v.workspaceCapacity()) {
            try w.print("\x1b[{d};{d}H{s} <  > ", .{ v.middle() - 1, v.width - 7, panel });
        }
        try w.print("\x1b[{d};2H{s}\x1b[38;2;55;61;70m", .{ v.middle(), panel });
        for (0..v.width - 3) |_| try w.writeAll("─");
        if (entries.len == 0) {
            try v.line(w, v.middle() + 2, "No agents yet", panel);
            try v.line(w, v.middle() + 4, "Launch inside a pane:", panel);
            try v.line(w, v.middle() + 5, "codex  or  claude", panel);
        }
        for (entries[v.offset..@min(entries.len, v.offset + v.capacity)], 0..) |e, index| {
            const y: u16 = @intCast(v.middle() + 2 + index * 2);
            const bg = if (e.focused) "\x1b[48;2;35;40;47m" else "\x1b[48;2;24;27;32m";
            for (0..2) |row| {
                if (y + row >= v.rows - 2) break;
                try w.print("\x1b[{d};1H\x1b[0m{s}", .{ y + row + 1, bg });
                try w.splatByteAll(' ', v.width - 1);
            }
            const dot = e.indicator();
            try w.print("\x1b[{d};2H\x1b[22m{s}{s}\x1b[{d};5H\x1b[1;38;2;226;230;233m", .{ y + 1, dot.color, dot.icon, y + 1 });
            const room = v.width - 6;
            const divider = index + 1 < @min(entries.len - v.offset, v.capacity);
            const underline = if (divider) "\x1b[4;58:2::65:70:77m" else "";
            const activity = if (e.tool_active and (e.state == .working or e.state == .blocked)) "🔧" else if (e.state == .working) thinking_frames[thinking_frame] else "";
            var name: [160]u8 = undefined;
            const provider = if (e.name.len > 0) directoryLabel(&name, e.name, null) else @tagName(e.provider);
            try w.print("\x1b[{d};5H\x1b[22;38;2;226;230;233m", .{y + 1});
            try writeEllipsis(w, provider, room);
            // Underline the existing second row, including its padding, without
            // consuming another terminal row or changing the entry hit area.
            try w.print("\x1b[{d};2H{s}", .{ y + 2, underline });
            try w.splatByteAll(' ', v.width - 3);
            try w.print("\x1b[{d};2H\x1b[22;38;2;125;132;143m{s}\x1b[{d};5H\x1b[38;2;226;230;233m", .{ y + 2, activity, y + 2 });
            var clean: [512]u8 = undefined;
            const detail = if (e.activity.len > 0) e.activity else switch (e.state) {
                .working => "Working",
                .blocked => "Needs input",
                .initializing => "Starting session",
                .done => "Session ended",
                else => "Ready",
            };
            try writeEllipsis(w, directoryLabel(&clean, detail, null), room);
            try w.writeAll("\x1b[24;59m");
        }
        if (v.count > v.capacity) {
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

fn displayWidth(text: []const u8) usize {
    var it = (std.unicode.Utf8View.init(text) catch unreachable).iterator();
    var width: usize = 0;
    while (it.nextCodepoint()) |cp| width += vt.unicode.codepointWidth(cp);
    return width;
}
fn writeClipped(w: *std.Io.Writer, text: []const u8, room: usize) !void {
    var it = (try std.unicode.Utf8View.init(text)).iterator();
    var used: usize = 0;
    while (it.nextCodepointSlice()) |bytes| {
        used += vt.unicode.codepointWidth(try std.unicode.utf8Decode(bytes));
        if (used > room) break;
        try w.writeAll(bytes);
    }
}

fn writeEllipsis(w: *std.Io.Writer, text: []const u8, room: usize) !void {
    if (displayWidth(text) <= room) return w.writeAll(text);
    if (room == 0) return;
    try writeClipped(w, text, room - 1);
    try w.writeAll("…");
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
fn directoryLabel(out: []u8, cwd: []const u8, home_dir: ?[]const u8) []const u8 {
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
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "0⚒") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "  \x1b[22m\x1b[38;2;166;227;161m○") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "—") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[4;25H\x1b[0;38;2;155;163;175;48;2;24;27;32m0⚒") != null);
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
