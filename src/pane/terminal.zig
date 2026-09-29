const std = @import("std");
pub const vt = @import("ghostty-vt");
const os = @import("../os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("../layout.zig");
const hyperlink = @import("hyperlinks.zig");
const providers = @import("../providers.zig");
const detection = @import("../detection.zig");
const launch_command = @import("../launch_command.zig");
const Theme = @import("../theme.zig").Theme;
pub const Terminal = struct {
    vt: vt.Terminal,
    stream: vt.TerminalStream,
    render: vt.RenderState = .empty,
    // New terminal instances (including handoff imports) invalidate viewer receipts.
    surface_identity: u64,
    surface_revision: u64 = 0,
    links: hyperlink.Snapshot = .{},
    fd: c_int = -1,
    pid: c_int = -1,
    /// A handoff candidate holds duplicates of fds and pids the source daemon
    /// still owns. Only `Runtime.adopt` makes them ours to signal.
    owner: Owner = .runtime,
    title_pid: c_int = 0,
    title_prefix: ?providers.SessionPrefix = null,
    title_revision: u64 = 0,
    exited: bool = false,
    exit_status: c_int = 0,
    pending: std.ArrayList(u8) = .empty,
    initial_input: ?[]const u8 = null,
    synchronized_since: ?i64 = null,
    restoring: bool = false,
    imported: bool = false,
    redraw_pending: bool = false,
    redraw_restore_at: ?i64 = null,

    pub const Owner = enum { runtime, candidate };

    pub fn applyTheme(t: *Terminal, theme: Theme) void {
        theme.apply(&t.vt);
        t.surface_revision +%= 1;
    }
    const synchronized_timeout_ms = 1000;

    pub fn emulator(t: *Terminal) *vt.Terminal {
        return &t.vt;
    }
    pub fn hyperlinks(t: *Terminal) []const hyperlink.Link {
        return t.links.links;
    }
    pub fn clearSelection(t: *Terminal) !void {
        try t.vt.screens.active.select(null);
    }

    pub fn create(cols: u16, rows: u16) !*Terminal {
        const t = try a.create(Terminal);
        errdefer a.destroy(t);
        t.* = .{ .vt = try vt.Terminal.init(a, .{ .cols = @max(1, cols), .rows = @max(1, rows), .max_scrollback = 10_000 }), .stream = undefined, .surface_identity = std.crypto.random.int(u64) };
        // Answer OSC 10/11 even before a client supplies its host theme. These
        // match RenderState's fallback colors for headless or non-querying hosts.
        t.vt.colors.foreground = .init(.{ .r = 255, .g = 255, .b = 255 });
        t.vt.colors.background = .init(.{ .r = 0, .g = 0, .b = 0 });
        var handler = t.vt.vtHandler();
        handler.effects.write_pty = reply;
        handler.effects.title_changed = titleChanged;
        handler.effects.device_attributes = attributes;
        t.stream = .initAlloc(a, handler);
        return t;
    }
    fn titleChanged(handler: *vt.TerminalStream.Handler) void {
        const t: *Terminal = @fieldParentPtr("vt", handler.terminal);
        const prefix = providers.Codex.titleSession(t.vt.getTitle() orelse "");
        if (!std.meta.eql(t.title_prefix, prefix)) {
            t.title_revision +%= 1;
            t.title_prefix = prefix;
        }
        if (!t.restoring and t.fd >= 0) {
            t.title_pid = if (detection.foreground(t.fd)) |job| job.pid else 0;
        }
    }
    fn reply(handler: *vt.TerminalStream.Handler, bytes: [:0]const u8) void {
        const t: *Terminal = @fieldParentPtr("vt", handler.terminal);
        if (!t.restoring) t.send(bytes) catch {};
    }
    const AttrCallback = @typeInfo(@FieldType(vt.TerminalStream.Handler.Effects, "device_attributes")).optional.child;
    const Attributes = @typeInfo(@typeInfo(AttrCallback).pointer.child).@"fn".return_type.?;
    fn attributes(_: *vt.TerminalStream.Handler) Attributes {
        return .{};
    }
    pub fn select(t: *Terminal, start_x: u16, start_y: u16, end_x: u16, end_y: u16) !void {
        const screen = t.vt.screens.active;
        const start = screen.pages.pin(.{ .viewport = .{ .x = @min(start_x, t.vt.cols - 1), .y = @min(start_y, t.vt.rows - 1) } }) orelse return;
        const end = screen.pages.pin(.{ .viewport = .{ .x = @min(end_x, t.vt.cols - 1), .y = @min(end_y, t.vt.rows - 1) } }) orelse return;
        try screen.select(vt.Selection.init(start, end, false));
    }
    pub fn selectedText(t: *Terminal) ![]const u8 {
        const screen = t.vt.screens.active;
        if (screen.selection) |sel| return screen.selectionString(a, .{ .sel = sel });
        return t.text();
    }
    pub const SearchResult = struct {
        offset: ?usize = null,
        match: ?struct { x: u16, y: u16, end_x: u16, end_y: u16 } = null,
    };
    /// Locate a match for a viewer without changing the terminal's viewport or selection.
    pub fn search(t: *Terminal, needle: []const u8, skip: usize) !SearchResult {
        if (needle.len == 0) return .{};
        const screen = t.vt.screens.active;
        var finder = try vt.search.PageList.init(a, needle, &screen.pages, screen.pages.pages.last orelse return error.EmptyScreen);
        defer finder.deinit();
        var index: usize = 0;
        while (true) {
            while (finder.next()) |sel| {
                if (index == skip) {
                    const point = screen.pages.pointFromPin(.screen, sel.startPin()) orelse return .{};
                    const offset = @min(point.screen.y, screen.pages.total_rows -| t.vt.rows);
                    const end = screen.pages.pointFromPin(.screen, sel.endPin()) orelse point;
                    return .{
                        .offset = offset,
                        .match = .{ .x = point.screen.x, .y = @intCast(point.screen.y - offset), .end_x = end.screen.x, .end_y = @intCast(@min(end.screen.y - offset, t.vt.rows - 1)) },
                    };
                }
                index += 1;
            }
            if (!try finder.feed()) break;
        }
        return .{};
    }
    pub fn spawn(t: *Terminal, cwd: []const u8, socket: []const u8, id: layout.PaneId, executable: []const u8, command: ?[]const u8, interactive_command: bool) !void {
        var ws = std.mem.zeroes(c.struct_winsize);
        ws.ws_col = t.vt.cols;
        ws.ws_row = t.vt.rows;
        const pid = c.forkpty(&t.fd, null, null, &ws);
        if (pid < 0) return error.ForkFailed;
        if (pid == 0) {
            const dir = a.dupeZ(u8, cwd) catch c._exit(127);
            if (c.chdir(dir) != 0) c._exit(127);
            os.setenv("TERM", "xterm-256color") catch c._exit(127);
            os.setenv("COLORTERM", "truecolor") catch c._exit(127);
            os.setenv("CORGI_SOCKET", socket) catch c._exit(127);
            os.setenv("CORGI_BIN", executable) catch c._exit(127);
            // A new interactive pane is not a tool/subagent of the Codex
            // process that may have originally started the daemon.
            _ = c.unsetenv("CODEX_THREAD_ID");
            const path = std.fmt.allocPrint(a, "{s}:{s}", .{ std.fs.path.dirname(executable) orelse ".", os.env("PATH") orelse "/usr/bin:/bin" }) catch c._exit(127);
            os.setenv("PATH", path) catch c._exit(127);
            const pane = std.fmt.allocPrint(a, "{d}", .{@intFromEnum(id)}) catch c._exit(127);
            os.setenv("CORGI_PANE", pane) catch c._exit(127);
            const shell = launch_command.shell();
            if (command) |cmd|
                os.exec(&.{ shell, if (interactive_command) launch_command.flags() else "-lc", cmd }) catch c._exit(127)
            else
                os.exec(&.{ shell, "-l" }) catch c._exit(127);
        }
        t.pid = pid;
        os.nonblock(t.fd);
        os.cloexec(t.fd);
    }
    // Release the process/PTY while retaining the Ghostty screen and scrollback.
    pub fn stop(t: *Terminal) void {
        t.endSynchronizedOutput();
        if (t.fd >= 0) _ = c.close(t.fd);
        if (t.owner == .runtime and t.pid > 0 and !t.exited) {
            _ = c.kill(-t.pid, c.SIGHUP);
            _ = c.kill(t.pid, c.SIGHUP);
        }
        t.fd = -1;
        t.pid = -1;
        t.exited = true;
        t.pending.clearRetainingCapacity();
        if (t.initial_input) |command| a.free(command);
        t.initial_input = null;
    }
    pub fn destroy(t: *Terminal) void {
        t.stop();
        t.pending.deinit(a);
        t.stream.deinit();
        t.links.deinit();
        t.render.deinit(a);
        t.vt.deinit(a);
        a.destroy(t);
    }
    // Replay content into a fresh terminal, without restoring input modes or
    // parser state left behind by the old process (e.g. mouse/alternate screen).
    pub fn snapshot(t: *Terminal) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        if (t.vt.screens.active_key == .alternate) {
            const primary: vt.formatter.ScreenFormatter = .init(t.vt.screens.get(.primary).?, .{ .emit = .vt, .unwrap = true });
            try primary.format(&out.writer);
            try out.writer.writeAll("\x1b[0m\r\n");
        }
        const formatter: vt.formatter.ScreenFormatter = .init(t.vt.screens.active, .{ .emit = .vt, .unwrap = true });
        try formatter.format(&out.writer);
        return out.toOwnedSlice();
    }
    /// Compact best-effort live state, independent of accumulated output volume.
    /// Preserve modes and both screens; parser fragments and some saved state
    /// cannot be reconstructed by VT formatting and require a fresh repaint.
    pub fn liveSnapshot(t: *Terminal) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        if (t.vt.screens.active_key == .alternate) {
            var primary: vt.formatter.ScreenFormatter = .init(t.vt.screens.get(.primary).?, .{ .emit = .vt });
            primary.extra = .all;
            try primary.format(&out.writer);
        }
        var formatter: vt.formatter.TerminalFormatter = .init(&t.vt, .{ .emit = .vt });
        formatter.extra = .all;
        try formatter.format(&out.writer);
        // Tabstop and margin restoration can move the cursor after content.
        var cursor: vt.formatter.ScreenFormatter = .init(t.vt.screens.active, .{ .emit = .vt });
        cursor.content = .none;
        cursor.extra = .none;
        cursor.extra.cursor = true;
        try cursor.format(&out.writer);
        // Never leave the reconstructed display stuck awaiting an old sync end.
        try out.writer.writeAll("\x1b[?2026l");
        if (t.vt.getTitle()) |title| {
            try out.writer.writeAll("\x1b]2;");
            for (title) |ch| if (ch >= 32 and ch != 127) try out.writer.writeByte(ch);
            try out.writer.writeAll("\x1b\\");
        }
        return out.toOwnedSlice();
    }
    /// Called only by the owning runtime, after handoff commits. Give the app
    /// time to observe a changed size before restoring the real dimensions.
    pub fn refreshRedraw(t: *Terminal, now: i64) void {
        std.debug.assert(t.owner == .runtime);
        if (t.fd < 0 or t.exited) {
            t.redraw_pending = false;
            t.redraw_restore_at = null;
            return;
        }
        var ws = std.mem.zeroes(c.struct_winsize);
        ws.ws_col = t.vt.cols;
        ws.ws_row = t.vt.rows;
        if (t.redraw_pending) {
            ws.ws_col = if (ws.ws_col > 1) ws.ws_col - 1 else 2;
            if (c.ioctl(t.fd, c.TIOCSWINSZ, &ws) != 0) return;
            t.redraw_pending = false;
            t.redraw_restore_at = now + 250;
        } else if (t.redraw_restore_at) |deadline| {
            if (now < deadline) return;
            if (c.ioctl(t.fd, c.TIOCSWINSZ, &ws) == 0) t.redraw_restore_at = null;
        }
    }
    pub fn resize(t: *Terminal, cols: u16, rows: u16) !void {
        const w = @max(1, cols);
        const h = @max(1, rows);
        if (t.vt.cols == w and t.vt.rows == h) return;
        try t.vt.resize(a, w, h);
        t.surface_revision +%= 1;
        var ws = std.mem.zeroes(c.struct_winsize);
        ws.ws_col = w;
        ws.ws_row = h;
        if (t.fd >= 0) _ = c.ioctl(t.fd, c.TIOCSWINSZ, &ws);
    }
    pub fn feed(t: *Terminal, bytes: []const u8) void {
        t.stream.nextSlice(bytes);
        if (bytes.len > 0) t.surface_revision +%= 1;
        if (t.vt.modes.get(.synchronized_output)) {
            if (t.synchronized_since == null) t.synchronized_since = std.time.milliTimestamp();
        } else {
            t.synchronized_since = null;
        }
    }
    fn endSynchronizedOutput(t: *Terminal) void {
        t.vt.modes.set(.synchronized_output, false);
        t.surface_revision +%= 1;
        t.synchronized_since = null;
    }
    fn expireSynchronizedOutput(t: *Terminal, now: i64) bool {
        const since = t.synchronized_since orelse return false;
        if (now - since < synchronized_timeout_ms and !t.exited) return false;
        t.endSynchronizedOutput();
        return true;
    }
    // Keep both cells and cursor from the last completed update, including when
    // another pane, UI event, or text capture requests a refresh mid-redraw.
    pub fn updateRender(t: *Terminal) !void {
        if (t.vt.modes.get(.synchronized_output)) return;
        try t.render.update(a, &t.vt);
        try t.links.capture(&t.render);
    }
    // Wait until the interactive shell has installed its line editor. No newline
    // is sent: this is editable input, and only the user can execute it.
    pub fn prefill(t: *Terminal, command: []const u8) !void {
        if (t.initial_input) |old| a.free(old);
        t.initial_input = null;
        if (command.len > 0) t.initial_input = try a.dupe(u8, command);
    }
    fn fillInput(t: *Terminal) void {
        const command = t.initial_input orelse return;
        var attrs: c.struct_termios = undefined;
        if (c.tcgetattr(t.fd, &attrs) != 0 or (attrs.c_lflag & c.ICANON) != 0) return;
        t.send(command) catch return;
        a.free(command);
        t.initial_input = null;
    }
    pub fn send(t: *Terminal, bytes: []const u8) !void {
        if (t.pending.items.len + bytes.len > 1024 * 1024) return error.InputBackpressure;
        try t.pending.appendSlice(a, bytes);
        t.flush();
    }
    pub fn flush(t: *Terminal) void {
        while (t.pending.items.len > 0 and t.fd >= 0) {
            const n = c.write(t.fd, t.pending.items.ptr, t.pending.items.len);
            if (n <= 0) break;
            const used: usize = @intCast(n);
            std.mem.copyForwards(u8, t.pending.items[0 .. t.pending.items.len - used], t.pending.items[used..]);
            t.pending.items.len -= used;
        }
    }
    pub fn read(t: *Terminal) bool {
        var bytes: [16384]u8 = undefined;
        var dirty = false;
        // Bound each pane's slice so a noisy process can't starve hooks or input.
        for (0..8) |_| {
            const n = c.read(t.fd, &bytes, bytes.len);
            if (n <= 0) {
                if (t.imported and (n == 0 or std.posix.errno(n) == .IO)) t.exited = true;
                break;
            }
            t.feed(bytes[0..@intCast(n)]);
            dirty = true;
        }
        if (!t.exited) t.fillInput();
        if (t.expireSynchronizedOutput(std.time.milliTimestamp())) dirty = true;
        return dirty;
    }
    /// True once, when the shell exits. Only this reaps our own shell; an
    /// imported shell belongs to another parent and is probed instead.
    pub fn reap(t: *Terminal) bool {
        if (t.exited or t.pid <= 0) return false;
        var status: c_int = 0;
        const gone = if (t.imported)
            c.kill(t.pid, 0) != 0 and std.posix.errno(-1) == .SRCH
        else
            c.waitpid(t.pid, &status, c.WNOHANG) == t.pid;
        if (!gone) return false;
        t.exited = true;
        t.exit_status = status;
        return true;
    }
    /// Detection reads the active screen independently of viewer scrollback.
    pub fn liveText(t: *Terminal) ![]u8 {
        var out: std.Io.Writer.Allocating = .init(a);
        errdefer out.deinit();
        try t.vt.screens.active.dumpString(&out.writer, .{ .tl = t.vt.screens.active.pages.getTopLeft(.active), .unwrap = false });
        return out.toOwnedSlice();
    }
    pub fn text(t: *Terminal) ![]u8 {
        try t.updateRender();
        var out: std.ArrayList(u8) = .empty;
        errdefer out.deinit(a);
        for (t.render.row_data.items(.cells)) |cells| {
            for (cells.items(.raw), 0..) |cell, i| {
                if (cell.wide == .spacer_tail or cell.wide == .spacer_head) continue;
                var buf: [4]u8 = undefined;
                const cp = cell.codepoint();
                const len = try std.unicode.utf8Encode(if (cp == 0) ' ' else cp, &buf);
                try out.appendSlice(a, buf[0..len]);
                if (cell.content_tag == .codepoint_grapheme) for (cells.items(.grapheme)[i]) |extra| {
                    const n = try std.unicode.utf8Encode(extra, &buf);
                    try out.appendSlice(a, buf[0..n]);
                };
            }
            try out.append(a, '\n');
        }
        return out.toOwnedSlice(a);
    }
};
test "Ghostty keeps fragmented escapes, unicode, alternate screen and resize" {
    const t = try Terminal.create(20, 4);
    defer t.destroy();
    t.feed("hello\x1b[");
    t.feed("2;1Hworld");
    const before = try t.text();
    defer a.free(before);
    try std.testing.expect(std.mem.indexOf(u8, before, "hello") != null);
    try std.testing.expect(std.mem.indexOf(u8, before, "world") != null);
    t.feed("\x1b[?1049halt\x1b[?1049l");
    try t.resize(30, 5);
    const after = try t.text();
    defer a.free(after);
    try std.testing.expect(std.mem.indexOf(u8, after, "hello") != null);
}

test "synchronized redraw retains completed cells and cursor even during text capture" {
    const t = try Terminal.create(40, 8);
    defer t.destroy();
    t.feed("\x1b[5;5HREADY\x1b[5;5H\x1b[?25h");
    const before = try t.text();
    defer a.free(before);
    const cursor = t.render.cursor.viewport;
    t.feed("\x1b[?2026");
    t.feed("h\x1b[2;20HMID_SYNC\x1b[2;20H\x1b[?25l");
    const during = try t.text();
    defer a.free(during);
    try std.testing.expectEqualStrings(before, during);
    try std.testing.expectEqualDeep(cursor, t.render.cursor.viewport);
    try std.testing.expect(t.render.cursor.visible);
    t.feed("\x1b[5;5HDONE_SYNC\x1b[5;5H\x1b[?25h\x1b[?2026");
    try t.updateRender();
    try std.testing.expectEqualDeep(cursor, t.render.cursor.viewport);
    try std.testing.expect(t.render.cursor.visible);
    t.feed("l");
    const after = try t.text();
    defer a.free(after);
    try std.testing.expect(std.mem.indexOf(u8, after, "DONE_SYNC") != null);
    try std.testing.expectEqualDeep(cursor, t.render.cursor.viewport);
    try std.testing.expect(t.render.cursor.visible);
}

test "unfinished synchronized output expires or releases on process exit" {
    const t = try Terminal.create(40, 8);
    defer t.destroy();
    t.feed("\x1b[?2026hTIMEOUT");
    const since = t.synchronized_since.?;
    try std.testing.expect(!t.expireSynchronizedOutput(since + 999));
    try std.testing.expect(t.expireSynchronizedOutput(since + 1000));
    const text = try t.text();
    defer a.free(text);
    try std.testing.expect(std.mem.indexOf(u8, text, "TIMEOUT") != null);
    t.feed("\x1b[?2026hEXIT");
    t.exited = true;
    try std.testing.expect(t.expireSynchronizedOutput(t.synchronized_since.?));
    try std.testing.expect(!t.vt.modes.get(.synchronized_output));
}

test "snapshot restores primary history and alternate output without input modes" {
    const old = try Terminal.create(30, 4);
    defer old.destroy();
    old.feed("EARLY_HISTORY\r\n1\r\n2\r\n3\r\n4\r\n5\r\n");
    old.feed("\x1b[?1049h\x1b[?1000h\x1b[?2004h\x1b[31mALT_OUTPUT\x1b[");
    old.stop();
    const saved = try old.snapshot();
    defer a.free(saved);
    const fresh = try Terminal.create(30, 4);
    defer fresh.destroy();
    fresh.feed(saved);
    fresh.feed("\x1b[0m\r\nNEW_SHELL");
    try std.testing.expectEqual(.primary, fresh.vt.screens.active_key);
    try std.testing.expectEqual(.none, fresh.vt.flags.mouse_event);
    try std.testing.expect(!fresh.vt.modes.get(.bracketed_paste));
    const viewport = fresh.vt.screens.active.pages.viewport;
    const selection = fresh.vt.screens.active.selection;
    try std.testing.expect((try fresh.search("EARLY_HISTORY", 0)).offset != null);
    try std.testing.expect((try fresh.search("ALT_OUTPUT", 0)).offset != null);
    try std.testing.expect((try fresh.search("NEW_SHELL", 0)).offset != null);
    try std.testing.expectEqualDeep(viewport, fresh.vt.screens.active.pages.viewport);
    try std.testing.expectEqualDeep(selection, fresh.vt.screens.active.selection);
}

test "terminal reports host colors and keeps application overrides" {
    const t = try Terminal.create(20, 4);
    defer t.destroy();
    t.feed("\x1b]10;?\x1b\\\x1b]11;?\x1b\\");
    try std.testing.expectEqualStrings("\x1b]10;rgb:ffff/ffff/ffff\x1b\\\x1b]11;rgb:0000/0000/0000\x1b\\", t.pending.items);
    t.pending.clearRetainingCapacity();
    var theme: Theme = .{
        .foreground = .{ .r = 220, .g = 220, .b = 220 },
        .background = .{ .r = 30, .g = 30, .b = 30 },
    };
    theme.palette[2] = .{ .r = 12, .g = 200, .b = 30 };
    theme.apply(&t.vt);
    t.feed("\x1b]10;?\x1b\\\x1b]11;?\x07\x1b]4;2;?\x1b\\");
    try std.testing.expectEqualStrings("\x1b]10;rgb:dcdc/dcdc/dcdc\x1b\\\x1b]11;rgb:1e1e/1e1e/1e1e\x07\x1b]4;2;rgb:0c0c/c8c8/1e1e\x1b\\", t.pending.items);
    try t.render.update(a, &t.vt);
    try std.testing.expectEqual(theme.background.?, t.render.colors.background);
    try std.testing.expectEqual(theme.palette[2].?, t.render.colors.palette[2]);
    // An app can override and reset colors locally without changing the host.
    t.feed("\x1b]11;rgb:01/02/03\x1b\\\x1b]4;2;rgb:04/05/06\x1b\\");
    theme.background = .{ .r = 50, .g = 50, .b = 50 };
    theme.apply(&t.vt);
    try std.testing.expectEqual(vt.color.RGB{ .r = 1, .g = 2, .b = 3 }, t.vt.colors.background.get().?);
    try std.testing.expectEqual(vt.color.RGB{ .r = 4, .g = 5, .b = 6 }, t.vt.colors.palette.current[2]);
    t.feed("\x1b]111\x1b\\\x1b]104;2\x1b\\");
    try std.testing.expectEqual(theme.background.?, t.vt.colors.background.get().?);
    try std.testing.expectEqual(theme.palette[2].?, t.vt.colors.palette.current[2]);
}

test "reap collects the terminal's own shell once and nothing for a stopped one" {
    const t = try Terminal.create(20, 4);
    defer t.destroy();
    // A stopped terminal's pid is -1, which waitpid would take as any child.
    try std.testing.expect(!t.reap());
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) c._exit(3);
    t.pid = pid;
    var info: c.siginfo_t = undefined;
    // Wait for the exit without collecting it.
    try std.testing.expectEqual(@as(c_int, 0), c.waitid(c.P_PID, @intCast(pid), &info, c.WEXITED | c.WNOWAIT));
    try std.testing.expect(t.reap());
    try std.testing.expect(t.exited);
    try std.testing.expectEqual(@as(c_int, 3 << 8), t.exit_status);
    try std.testing.expect(!t.reap());
}

test {
    _ = @import("../keyboard.zig");
}
