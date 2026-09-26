//! Read-only discovery runs in the viewer, away from the daemon PTY loop.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const herdr = @import("herdr_adapter.zig");
pub const Source = enum { tmux, herdr, cmux };
pub const available_sources: []const Source = if (@import("builtin").os.tag == .macos) &.{ .tmux, .herdr, .cmux } else &.{ .tmux, .herdr };
pub const Pane = struct { id: []const u8, name: []const u8, cwd: []const u8 = "", pid: ?i32 = null, url: []const u8 = "", x: u16 = 0, y: u16 = 0, w: u16 = 80, h: u16 = 24, resume_available: bool = false };
pub const Tab = struct { id: []const u8, name: []const u8, panes: []const Pane, nodes: []const @import("import_layout.zig").Node = &.{} };
pub const Recovery = enum { full, layout, partial, workspace };
pub const Workspace = struct { id: []const u8, name: []const u8, cwd: []const u8 = "", socket: []const u8 = "", session: usize = 0, handoff: bool = false, recovery: Recovery = .full, recovery_note: []const u8 = "", tabs: []const Tab };
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
        if (source == .cmux and @import("builtin").os.tag != .macos) return error.CmuxRequiresMacOS;
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
            .cmux => if (@import("builtin").os.tag == .macos) try self.cmux() else return error.CmuxRequiresMacOS,
            .herdr => {
                self.herdr_scan = try herdr.scanCancelable(&self.stop);
                var list: std.ArrayList(Workspace) = .empty;
                const alloc = self.arena.allocator();
                for (self.herdr_scan.?.sessions, 0..) |session, si| for (session.workspaces) |ws| {
                    var tabs: std.ArrayList(Tab) = .empty;
                    for (ws.tabs) |tab| {
                        var panes: std.ArrayList(Pane) = .empty;
                        for (tab.panes) |p| try panes.append(alloc, .{ .id = p.id, .name = p.name, .cwd = p.cwd, .pid = p.pid, .resume_available = p.resume_hint.len > 0 });
                        try tabs.append(alloc, .{ .id = tab.id, .name = tab.name, .panes = try panes.toOwnedSlice(alloc) });
                    }
                    try list.append(alloc, .{ .id = ws.id, .name = ws.name, .cwd = ws.cwd, .socket = session.socket, .session = si, .handoff = session.live_handoff, .tabs = try tabs.toOwnedSlice(alloc) });
                };
                self.catalog.workspaces = try list.toOwnedSlice(alloc);
            },
        }
    }
    // Bounded subprocesses. No shell interpretation and no source mutations.
    fn command(self: *Worker, argv: []const []const u8) ![]const u8 {
        return self.commandUntil(argv, std.time.milliTimestamp() + 5000);
    }
    fn commandUntil(self: *Worker, argv: []const []const u8, until: i64) ![]const u8 {
        if (self.stop.load(.acquire)) return error.SourceCancelled;
        const deadline = @min(until, std.time.milliTimestamp() + 5000);
        if (std.time.milliTimestamp() >= deadline) return error.SourceTimedOut;
        var child = std.process.Child.init(argv, a);
        child.stdin_behavior = .Ignore;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Ignore;
        child.pgid = 0;
        try child.spawn();
        var reaped = false;
        defer {
            _ = os.c.kill(-child.id, os.c.SIGKILL);
            if (!reaped) {
                var status: c_int = 0;
                _ = os.c.waitpid(child.id, &status, 0);
            }
            if (child.stdout) |file| file.close();
        }
        try child.waitForSpawn();
        const fd = child.stdout.?.handle;
        os.nonblock(fd);
        var bytes: std.ArrayList(u8) = .empty;
        defer bytes.deinit(a);
        var buf: [8192]u8 = undefined;
        var status: c_int = 0;
        while (!self.stop.load(.acquire) and std.time.milliTimestamp() < deadline) {
            const n = os.c.read(fd, &buf, buf.len);
            if (n > 0) {
                if (bytes.items.len + @as(usize, @intCast(n)) > 4 * 1024 * 1024) return error.SourceTooLarge;
                try bytes.appendSlice(a, buf[0..@intCast(n)]);
            } else if (n < 0 and std.posix.errno(n) != .AGAIN and std.posix.errno(n) != .INTR) return error.SourceUnavailable;
            if (!reaped and os.c.waitpid(child.id, &status, os.c.WNOHANG) == child.id) {
                reaped = true;
                continue; // A final write may have raced the preceding read.
            }
            // EOF alone is not exit: a broken CLI can close stdout and hang.
            // Drain buffered output even after exit before releasing the result.
            if (reaped and n <= 0) {
                if (status != 0) return error.SourceUnavailable;
                return self.arena.allocator().dupe(u8, bytes.items);
            }
            std.Thread.sleep(5 * std.time.ns_per_ms);
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
        if (std.fs.cwd().openDir(dirpath, .{ .iterate = true })) |opened| {
            var dir = opened;
            defer dir.close();
            var it = dir.iterate();
            while (try it.next()) |entry| {
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
        var workspaces: std.ArrayList(Workspace) = .empty;
        for (sockets.items) |socket| {
            const sessions = self.command(&.{ "tmux", "-S", socket, "list-sessions", "-F", "#{session_id}\t#{session_name}" }) catch continue;
            var lines = std.mem.tokenizeScalar(u8, sessions, '\n');
            while (lines.next()) |line| {
                var fields = std.mem.splitScalar(u8, line, '\t');
                const id = fields.next().?;
                const name = fields.next() orelse continue;
                const windows = try self.command(&.{ "tmux", "-S", socket, "list-windows", "-t", id, "-F", "#{window_id}\t#{window_name}" });
                var tabs: std.ArrayList(Tab) = .empty;
                var wl = std.mem.tokenizeScalar(u8, windows, '\n');
                while (wl.next()) |win| {
                    var wf = std.mem.splitScalar(u8, win, '\t');
                    const wid = wf.next().?;
                    const window_name = wf.next() orelse continue;
                    // Read saved geometry in the same command as pane metadata:
                    // a zoomed pane overlaps the hidden panes' live rectangles.
                    const content = try self.command(&.{ "tmux", "-S", socket, "list-panes", "-t", wid, "-F", "#{pane_id}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_pid}\t#{pane_left}\t#{pane_top}\t#{pane_width}\t#{pane_height}\t#{?window_zoomed_flag,#{window_layout},}" });
                    var panes: std.ArrayList(Pane) = .empty;
                    var unzoomed: ?@import("tmux_layout.zig").Geometry = null;
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
                        if (unzoomed == null and saved_layout.len > 0) unzoomed = try @import("tmux_layout.zig").parse(saved_layout);
                        try panes.append(alloc, .{ .id = pid, .name = pname, .cwd = pane_cwd, .pid = process, .x = x, .y = y, .w = w, .h = h });
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
                if (tabs.items.len > 0) try workspaces.append(alloc, .{ .id = id, .name = name, .socket = socket, .cwd = tabs.items[0].panes[0].cwd, .tabs = try tabs.toOwnedSlice(alloc) });
            }
        }
        self.catalog.workspaces = try workspaces.toOwnedSlice(alloc);
    }
    fn cmux(self: *Worker) !void {
        const alloc = self.arena.allocator();
        const exe = try cmuxExecutable(alloc);
        const deadline = std.time.milliTimestamp() + 15000;
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
        self.catalog.message = if (self.catalog.confused and self.catalog.workspaces.len == 0) "Couldn't read the workspace list. R refreshes; S skips import." else "Visible splits first; remaining surfaces become additional tabs.";
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
            const converted = if (shallow and arrayField(ws, "panes") == null and arrayField(ws, "surfaces") == null) try @import("cmux_import.zig").workspaceOnly(alloc, ws, "Couldn't read its panes or tabs") else try @import("cmux_import.zig").convert(alloc, ws, details);
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
fn cmuxExecutable(alloc: std.mem.Allocator) ![]const u8 {
    var dirs = std.mem.splitScalar(u8, os.env("PATH") orelse "", ':');
    while (dirs.next()) |dir| {
        const path = try std.fmt.allocPrintSentinel(alloc, "{s}/cmux", .{if (dir.len == 0) "." else dir}, 0);
        if (os.c.access(path, os.c.X_OK) == 0) return path;
    }
    if (@import("builtin").os.tag == .macos) {
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
