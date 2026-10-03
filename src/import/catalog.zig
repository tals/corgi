//! Read-only discovery runs in the viewer, away from the daemon PTY loop.
const std = @import("std");
const os = @import("../os.zig");
const a = os.allocator;
const builtin = @import("builtin");
const herdr = @import("herdr.zig");
const layout = @import("../layout.zig");
const import_layout = @import("layout.zig");
const tmux_layout = @import("tmux_layout.zig");
const tmux_resume = @import("tmux_resume.zig");
const cmux_import = @import("cmux.zig");
pub const Source = enum { tmux, herdr, cmux };
pub const available_sources: []const Source = if (builtin.os.tag == .macos) &.{ .tmux, .herdr, .cmux } else &.{ .tmux, .herdr };
pub const Pane = struct {
    id: []const u8,
    name: []const u8,
    cwd: []const u8 = "",
    pid: ?i32 = null,
    url: []const u8 = "",
    x: u16 = 0,
    y: u16 = 0,
    w: u16 = 80,
    h: u16 = 24,
    resume_available: bool = false,
    history: []const u8 = "",
    screen: []const u8 = "",
    restart_command: []const u8 = "",
};
pub const Tab = struct { id: []const u8, name: []const u8, panes: []const Pane, nodes: []const import_layout.Node = &.{} };
pub const Recovery = enum { full, layout, partial, workspace };
pub const Workspace = struct {
    id: []const u8,
    name: []const u8,
    cwd: []const u8 = "",
    socket: []const u8 = "",
    session: usize = 0,
    activity: i64 = 0,
    handoff: bool = false,
    recovery: Recovery = .full,
    recovery_note: []const u8 = "",
    tabs: []const Tab,
};
pub const Catalog = struct { workspaces: []const Workspace = &.{}, message: []const u8 = "", confused: bool = false };
pub const Worker = struct {
    arena: std.heap.ArenaAllocator,
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    stop: std.atomic.Value(bool) = .init(false),
    source: Source,
    catalog: Catalog = .{},
    herdr_scan: ?herdr.Scan = null,
    pub fn start(source: Source) !*Worker {
        if (source == .cmux and builtin.os.tag != .macos) return error.CmuxRequiresMacOS;
        const self = try a.create(Worker);
        self.* = .{ .arena = .init(a), .source = source };
        errdefer a.destroy(self);
        self.thread = try std.Thread.spawn(.{}, run, .{self});
        return self;
    }
    pub fn deinit(self: *Worker) void {
        self.stop.store(true, .release);
        if (self.thread) |t| t.join();
        if (self.herdr_scan) |*scan| scan.deinit();
        self.arena.deinit();
        a.destroy(self);
    }
    fn run(self: *Worker) void {
        self.discover() catch |err| {
            self.catalog = .{ .message = @errorName(err) };
        };
        self.done.store(true, .release);
    }
    fn discover(self: *Worker) !void {
        switch (self.source) {
            .tmux => try self.tmux(),
            .cmux => if (builtin.os.tag == .macos) try self.cmux() else return error.CmuxRequiresMacOS,
            .herdr => {
                self.herdr_scan = try herdr.scanCancelable(&self.stop);
                var list: std.ArrayList(Workspace) = .empty;
                const alloc = self.arena.allocator();
                for (self.herdr_scan.?.sessions, 0..) |session, si| for (session.workspaces) |ws| {
                    var tabs: std.ArrayList(Tab) = .empty;
                    for (ws.tabs) |tab| {
                        var panes: std.ArrayList(Pane) = .empty;
                        for (tab.panes) |p| try panes.append(alloc, .{ .id = p.id, .name = p.name, .cwd = p.cwd, .pid = p.pid, .resume_available = p.resume_hint.session.len > 0 });
                        try tabs.append(alloc, .{ .id = tab.id, .name = tab.name, .panes = try panes.toOwnedSlice(alloc) });
                    }
                    try list.append(alloc, .{
                        .id = ws.id,
                        .name = ws.name,
                        .cwd = ws.cwd,
                        .socket = session.socket,
                        .session = si,
                        .handoff = session.live_handoff,
                        .tabs = try tabs.toOwnedSlice(alloc),
                    });
                };
                self.catalog.workspaces = try list.toOwnedSlice(alloc);
            },
        }
    }
    // Bounded subprocesses. No shell interpretation and no source mutations.
    fn command(self: *Worker, argv: []const []const u8) ![]const u8 {
        return self.commandUntil(argv, os.milliTimestamp() + 5000);
    }
    fn commandUntil(self: *Worker, argv: []const []const u8, until: i64) ![]const u8 {
        if (self.stop.load(.acquire)) return error.SourceCancelled;
        const deadline = @min(until, os.milliTimestamp() + 5000);
        if (os.milliTimestamp() >= deadline) return error.SourceTimedOut;
        const child = try std.process.spawn(os.io(), .{
            .argv = argv,
            .stdin = .ignore,
            .stdout = .pipe,
            .stderr = .ignore,
            .pgid = 0,
        });
        var reaped = false;
        defer {
            _ = os.c.kill(-child.id.?, os.c.SIGKILL);
            if (!reaped) {
                var status: c_int = 0;
                _ = os.c.waitpid(child.id.?, &status, 0);
            }
            if (child.stdout) |file| file.close(os.io());
        }
        const fd = child.stdout.?.handle;
        os.nonblock(fd);
        var bytes: std.ArrayList(u8) = .empty;
        defer bytes.deinit(a);
        var buf: [8192]u8 = undefined;
        var status: c_int = 0;
        while (!self.stop.load(.acquire) and os.milliTimestamp() < deadline) {
            const n = os.c.read(fd, &buf, buf.len);
            if (n > 0) {
                if (bytes.items.len + @as(usize, @intCast(n)) > 4 * 1024 * 1024) return error.SourceTooLarge;
                try bytes.appendSlice(a, buf[0..@intCast(n)]);
            } else if (n < 0 and std.posix.errno(n) != .AGAIN and std.posix.errno(n) != .INTR) return error.SourceUnavailable;
            if (!reaped and os.c.waitpid(child.id.?, &status, os.c.WNOHANG) == child.id.?) {
                reaped = true;
                continue; // A final write may have raced the preceding read.
            }
            // EOF alone is not exit: a broken CLI can close stdout and hang.
            // Drain buffered output even after exit before releasing the result.
            if (reaped and n <= 0) {
                if (status != 0) return error.SourceUnavailable;
                return self.arena.allocator().dupe(u8, bytes.items);
            }
            os.sleep(5 * std.time.ns_per_ms);
        }
        return if (self.stop.load(.acquire)) error.SourceCancelled else error.SourceTimedOut;
    }
    fn tmux(self: *Worker) !void {
        const alloc = self.arena.allocator();
        var sockets: std.ArrayList([]const u8) = .empty;
        if (os.env("TMUX")) |env| {
            var parts = std.mem.splitScalar(u8, env, ',');
            try sockets.append(alloc, parts.next().?);
        }
        const dirpath = try std.fmt.allocPrint(alloc, "{s}/tmux-{d}", .{ os.env("TMUX_TMPDIR") orelse "/tmp", os.c.getuid() });
        if (std.Io.Dir.cwd().openDir(os.io(), dirpath, .{ .iterate = true })) |opened| {
            var dir = opened;
            defer dir.close(os.io());
            var it = dir.iterate();
            while (try it.next(os.io())) |entry| {
                if (entry.kind != .unix_domain_socket) continue;
                const socket = try std.fs.path.join(alloc, &.{ dirpath, entry.name });
                var exists = false;
                for (sockets.items) |other| if (std.mem.eql(u8, other, socket)) {
                    exists = true;
                    break;
                };
                if (!exists) try sockets.append(alloc, socket);
            }
        } else |_| {}
        if (sockets.items.len == 0) return error.NoTmuxSessions;
        const processes = self.command(&.{ "ps", "-axo", "pid=,tpgid=" }) catch "";
        var workspaces: std.ArrayList(Workspace) = .empty;
        for (sockets.items) |socket| {
            const sessions = self.command(&.{ "tmux", "-S", socket, "list-sessions", "-F", "#{session_id}\t#{session_name}\t#{session_activity}" }) catch continue;
            var lines = std.mem.tokenizeScalar(u8, sessions, '\n');
            while (lines.next()) |line| {
                var fields = std.mem.splitScalar(u8, line, '\t');
                const id = fields.next().?;
                const name = fields.next() orelse continue;
                const activity = std.fmt.parseInt(i64, fields.next() orelse "0", 10) catch 0;
                const windows = try self.command(&.{ "tmux", "-S", socket, "list-windows", "-t", id, "-F", "#{window_id}\t#{window_name}" });
                var tabs: std.ArrayList(Tab) = .empty;
                var wl = std.mem.tokenizeScalar(u8, windows, '\n');
                while (wl.next()) |win| {
                    var wf = std.mem.splitScalar(u8, win, '\t');
                    const wid = wf.next().?;
                    const window_name = wf.next() orelse continue;
                    // Read saved geometry in the same command as pane metadata:
                    // a zoomed pane overlaps the hidden panes' live rectangles.
                    const pane_format = "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{?window_zoomed_flag,#{window_layout},}\t#{alternate_on}\t#{history_size}";
                    const content = try self.command(&.{ "tmux", "-S", socket, "list-panes", "-t", wid, "-F", pane_format });
                    var panes: std.ArrayList(Pane) = .empty;
                    var unzoomed: ?tmux_layout.Geometry = null;
                    var pl = std.mem.tokenizeScalar(u8, content, '\n');
                    while (pl.next()) |row| {
                        var f = std.mem.splitScalar(u8, row, '\t');
                        const pid = f.next().?;
                        const pname = f.next() orelse continue;
                        const pane_cwd = f.next() orelse continue;
                        const process = std.fmt.parseInt(i32, f.next() orelse "", 10) catch null;
                        const x = try std.fmt.parseInt(u16, f.next() orelse "0", 10);
                        const y = try std.fmt.parseInt(u16, f.next() orelse "0", 10);
                        const w = try std.fmt.parseInt(u16, f.next() orelse "80", 10);
                        const h = try std.fmt.parseInt(u16, f.next() orelse "24", 10);
                        const saved_layout = f.next() orelse "";
                        const alternate = std.mem.eql(u8, f.next() orelse "0", "1");
                        const history_size = std.fmt.parseInt(usize, f.next() orelse "0", 10) catch 0;
                        if (unzoomed == null and saved_layout.len > 0) unzoomed = try tmux_layout.parse(saved_layout);
                        const foreground = if (process) |root| tmux_resume.foregroundPid(processes, root) else null;
                        const restart = if (foreground) |fg| try tmux_resume.command(alloc, fg) else "";
                        const screen = self.command(&.{ "tmux", "-S", socket, "capture-pane", "-p", "-J", "-S", if (alternate) "0" else "-1000", "-t", pid }) catch "";
                        // tmux retains scrollback in the active grid; -a contains
                        // only the saved shell screen. Reassemble in time order.
                        const history = if (alternate) blk: {
                            const saved = self.command(&.{ "tmux", "-S", socket, "capture-pane", "-p", "-a", "-J", "-t", pid }) catch "";
                            const scrollback = if (history_size > 0) self.command(&.{ "tmux", "-S", socket, "capture-pane", "-p", "-J", "-S", "-1000", "-E", "-1", "-t", pid }) catch "" else "";
                            break :blk try std.fmt.allocPrint(alloc, "{s}{s}", .{ scrollback, saved });
                        } else "";
                        try panes.append(alloc, .{
                            .id = pid,
                            .name = pname,
                            .cwd = pane_cwd,
                            .pid = process,
                            .x = x,
                            .y = y,
                            .w = w,
                            .h = h,
                            .restart_command = restart,
                            .resume_available = restart.len > 0,
                            .screen = tmux_resume.tail(screen, 64 * 1024),
                            .history = tmux_resume.tail(history, 64 * 1024),
                        });
                    }
                    if (unzoomed) |geometry| {
                        if (geometry.count != panes.items.len) return error.TmuxLayoutChanged;
                        for (panes.items) |*pane| {
                            const rect = geometry.find(pane.id) orelse return error.TmuxLayoutChanged;
                            pane.x = rect.x;
                            pane.y = rect.y;
                            pane.w = rect.w;
                            pane.h = rect.h;
                        }
                    }
                    if (panes.items.len > 0) try tabs.append(alloc, .{ .id = wid, .name = window_name, .panes = try panes.toOwnedSlice(alloc) });
                }
                if (tabs.items.len > 0) try workspaces.append(alloc, .{
                    .id = id,
                    .name = name,
                    .socket = socket,
                    .activity = activity,
                    .cwd = tabs.items[0].panes[0].cwd,
                    .tabs = try tabs.toOwnedSlice(alloc),
                });
            }
        }
        std.mem.sort(Workspace, workspaces.items, {}, recentFirst);
        self.catalog.workspaces = try workspaces.toOwnedSlice(alloc);
    }
    fn cmux(self: *Worker) !void {
        const alloc = self.arena.allocator();
        const exe = try cmuxExecutable(alloc);
        const deadline = os.milliTimestamp() + 15000;
        var workspaces: std.ArrayList(Workspace) = .empty;
        const snapshot = try self.cmuxJson(exe, &.{ "tree", "--all" }, deadline);
        var known_list = false;
        if (arrayField(snapshot, "windows")) |windows| {
            known_list = true;
            for (windows) |window| {
                if (arrayField(window, "workspaces")) |entries| {
                    try self.cmuxEntries(exe, entries, false, &workspaces, deadline);
                } else {
                    self.catalog.confused = true;
                    const handle = str(window, "id");
                    if (handle.len > 0) {
                        const listed = try self.cmuxJson(exe, &.{ "list-workspaces", "--window", handle }, deadline);
                        if (arrayField(listed, "workspaces")) |entries| try self.cmuxEntries(exe, entries, true, &workspaces, deadline) else known_list = false;
                    } else known_list = false;
                }
            }
        } else if (arrayField(snapshot, "workspaces")) |entries| {
            known_list = true;
            try self.cmuxEntries(exe, entries, false, &workspaces, deadline);
        }
        if (workspaces.items.len == 0 and self.catalog.confused) known_list = false;
        if (!known_list) {
            self.catalog.confused = true;
            const windows = try self.cmuxJson(exe, &.{"list-windows"}, deadline);
            var listed_all = false;
            if (arrayField(windows, "windows")) |entries| {
                listed_all = true;
                for (entries) |window| {
                    const handle = str(window, "id");
                    if (handle.len == 0) {
                        listed_all = false;
                        continue;
                    }
                    const listed = try self.cmuxJson(exe, &.{ "list-workspaces", "--window", handle }, deadline);
                    if (arrayField(listed, "workspaces")) |ws| try self.cmuxEntries(exe, ws, true, &workspaces, deadline) else listed_all = false;
                }
            }
            if (!listed_all) {
                const listed = try self.cmuxJson(exe, &.{"list-workspaces"}, deadline);
                if (arrayField(listed, "workspaces")) |entries| try self.cmuxEntries(exe, entries, true, &workspaces, deadline);
            }
        }
        self.catalog.workspaces = try workspaces.toOwnedSlice(alloc);
        self.catalog.message = if (self.catalog.confused and self.catalog.workspaces.len == 0)
            "Couldn't read the workspace list. R refreshes; S skips import."
        else
            "Visible splits first; remaining surfaces become additional tabs.";
    }
    // Try UUID output first, then the older CLI's default JSON format. A failure
    // is local to this read; subsequent recovery keeps already discovered work.
    fn cmuxJson(self: *Worker, exe: []const u8, args: []const []const u8, deadline: i64) !std.json.Value {
        const alloc = self.arena.allocator();
        for ([_]bool{ true, false }) |uuids| {
            var argv: std.ArrayList([]const u8) = .empty;
            try argv.append(alloc, exe);
            try argv.appendSlice(alloc, args);
            try argv.appendSlice(alloc, if (uuids) &.{ "--json", "--id-format", "uuids" } else &.{"--json"});
            const bytes = self.commandUntil(argv.items, deadline) catch |err| switch (err) {
                error.SourceCancelled, error.OutOfMemory => return err,
                else => continue,
            };
            const parsed = std.json.parseFromSlice(std.json.Value, alloc, bytes, .{ .allocate = .alloc_always }) catch |err| switch (err) {
                error.OutOfMemory => return err,
                else => continue,
            };
            const value = parsed.value;
            if (value == .object) return value.object.get("result") orelse value;
        }
        return .null;
    }
    fn cmuxEntries(self: *Worker, exe: []const u8, entries: []const std.json.Value, shallow: bool, out: *std.ArrayList(Workspace), deadline: i64) !void {
        const alloc = self.arena.allocator();
        for (entries) |ws| {
            if (self.stop.load(.acquire)) return error.SourceCancelled;
            var details: std.json.Value = .null;
            if (array(ws, "panes").len > 1 and ws == .object and (ws.object.get("layout") orelse .null) == .null) {
                const handle = str(ws, "id");
                if (handle.len > 0) details = try self.cmuxJson(exe, &.{ "list-panes", "--workspace", handle }, deadline);
            }
            const converted = if (shallow and arrayField(ws, "panes") == null and arrayField(ws, "surfaces") == null)
                try cmux_import.workspaceOnly(alloc, ws, "Couldn't read its panes or tabs")
            else
                try cmux_import.convert(alloc, ws, details);
            if (converted) |item| {
                if (item.recovery != .full) self.catalog.confused = true;
                var duplicate = false;
                const identified = str(ws, "id").len > 0 or str(ws, "ref").len > 0 or str(ws, "workspace_id").len > 0;
                for (out.items) |existing| if (identified and std.mem.eql(u8, existing.id, item.id)) {
                    duplicate = true;
                    break;
                };
                if (!duplicate) try out.append(alloc, item);
            } else self.catalog.confused = true;
        }
    }
};
fn recentFirst(_: void, left: Workspace, right: Workspace) bool {
    if (left.activity != right.activity) return left.activity > right.activity;
    const socket_order = std.mem.order(u8, left.socket, right.socket);
    if (socket_order != .eq) return socket_order == .lt;
    return std.mem.lessThan(u8, left.id, right.id);
}

/// Bound terminal text in the existing one-MiB copy request, sharing the budget
/// among selected panes. The catalog itself remains intact for retries.
pub fn copyWorkspaces(alloc: std.mem.Allocator, selected: []const Workspace) ![]const Workspace {
    var count: usize = 0;
    for (selected) |ws| for (ws.tabs) |tab| {
        count += tab.panes.len;
    };
    const limit = 512 * 1024 / @max(1, count) / 2;
    const workspaces = try alloc.dupe(Workspace, selected);
    for (workspaces) |*ws| {
        const tabs = try alloc.dupe(Tab, ws.tabs);
        ws.tabs = tabs;
        for (tabs) |*tab| {
            const panes = try alloc.dupe(Pane, tab.panes);
            tab.panes = panes;
            for (panes) |*pane| {
                pane.history = tmux_resume.tail(pane.history, limit);
                pane.screen = tmux_resume.tail(pane.screen, limit);
            }
        }
    }
    return workspaces;
}

test "tmux groups sort by recent activity across sockets" {
    var groups = [_]Workspace{
        .{ .id = "$0", .name = "old", .socket = "a", .activity = 10, .tabs = &.{} },
        .{ .id = "$0", .name = "new", .socket = "b", .activity = 30, .tabs = &.{} },
        .{ .id = "$1", .name = "middle", .socket = "a", .activity = 20, .tabs = &.{} },
    };
    std.mem.sort(Workspace, &groups, {}, recentFirst);
    try std.testing.expectEqualStrings("new", groups[0].name);
    try std.testing.expectEqualStrings("middle", groups[1].name);
}

test "copy text fits the RPC budget at full pane capacity without changing discovery" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const content = try alloc.alloc(u8, 64 * 1024);
    @memset(content, '\\');
    const command = try alloc.alloc(u8, 2048);
    @memset(command, '\\');
    const panes = try alloc.alloc(Pane, layout.max_panes);
    for (panes) |*pane| pane.* = .{ .id = "%0", .name = "tig", .screen = content, .history = content, .restart_command = command };
    const workspaces = try copyWorkspaces(alloc, &.{.{ .id = "$0", .name = "session", .tabs = &.{.{ .id = "@0", .name = "tab", .panes = panes }} }});
    const json = try std.json.Stringify.valueAlloc(alloc, .{ .op = "onboarding.copy", .source = Source.tmux, .workspaces = workspaces }, .{});
    try std.testing.expect(json.len < 1024 * 1024);
    try std.testing.expectEqual(@as(usize, 64 * 1024), panes[0].screen.len);
    try std.testing.expect(workspaces[0].tabs[0].panes[0].screen.len < panes[0].screen.len);
}

fn cmuxExecutable(alloc: std.mem.Allocator) ![]const u8 {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    if (os.findExecutable("cmux", &buf)) |path| return alloc.dupe(u8, path);
    if (builtin.os.tag == .macos) {
        if (os.env("HOME")) |home| {
            const path = try std.fmt.allocPrintSentinel(alloc, "{s}/Applications/cmux.app/Contents/Resources/bin/cmux", .{home}, 0);
            if (os.c.access(path, os.c.X_OK) == 0) return path;
        }
        const path = "/Applications/cmux.app/Contents/Resources/bin/cmux";
        if (os.c.access(path, os.c.X_OK) == 0) return path;
    }
    return error.CmuxNotFound;
}
fn array(v: std.json.Value, key: []const u8) []const std.json.Value {
    return arrayField(v, key) orelse &.{};
}
fn arrayField(v: std.json.Value, key: []const u8) ?[]const std.json.Value {
    if (v == .object) if (v.object.get(key)) |x| {
        if (x == .array) return x.array.items;
    };
    return null;
}
fn str(v: std.json.Value, key: []const u8) []const u8 {
    if (v == .object) if (v.object.get(key)) |x| {
        if (x == .string) return x.string;
    };
    return "";
}
