//! Read-only discovery runs in the viewer, away from the daemon PTY loop.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const herdr = @import("herdr_adapter.zig");
pub const Source = enum { tmux, herdr, cmux };
pub const Pane = struct { id: []const u8, name: []const u8, cwd: []const u8 = "", pid: ?i32 = null, url: []const u8 = "", x: u16 = 0, y: u16 = 0, w: u16 = 80, h: u16 = 24, resume_available: bool = false };
pub const Tab = struct { id: []const u8, name: []const u8, panes: []const Pane };
pub const Workspace = struct { id: []const u8, name: []const u8, cwd: []const u8 = "", socket: []const u8 = "", session: usize = 0, handoff: bool = false, tabs: []const Tab };
pub const Catalog = struct { workspaces: []const Workspace = &.{}, message: []const u8 = "" };
pub const Worker = struct {
    arena: std.heap.ArenaAllocator,
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    stop: std.atomic.Value(bool) = .init(false),
    source: Source,
    catalog: Catalog = .{},
    herdr_scan: ?herdr.Scan = null,
    pub fn start(source: Source) !*Worker {
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
            .cmux => try self.cmux(),
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
        var child = std.process.Child.init(argv, a);
        child.stdin_behavior = .Ignore;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Ignore;
        try child.spawn();
        var reaped = false;
        defer if (!reaped) {
            _ = child.kill() catch {};
        };
        const fd = child.stdout.?.handle;
        os.nonblock(fd);
        var bytes: std.ArrayList(u8) = .empty;
        defer bytes.deinit(a);
        const deadline = std.time.milliTimestamp() + 5000;
        var buf: [8192]u8 = undefined;
        while (!self.stop.load(.acquire) and std.time.milliTimestamp() < deadline) {
            const n = os.c.read(fd, &buf, buf.len);
            if (n > 0) {
                if (bytes.items.len + @as(usize, @intCast(n)) > 4 * 1024 * 1024) return error.SourceTooLarge;
                try bytes.appendSlice(a, buf[0..@intCast(n)]);
            } else if (n == 0) {
                const result = try child.wait();
                reaped = true;
                if (result != .Exited or result.Exited != 0) return error.SourceUnavailable;
                return self.arena.allocator().dupe(u8, bytes.items);
            } else if (std.posix.errno(n) != .AGAIN and std.posix.errno(n) != .INTR) return error.SourceUnavailable;
            std.Thread.sleep(5 * std.time.ns_per_ms);
        }
        return error.SourceTimedOut;
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
        const bytes = try self.command(&.{ "cmux", "tree", "--all", "--json", "--id-format", "uuids" });
        const parsed = try std.json.parseFromSlice(std.json.Value, alloc, bytes, .{ .allocate = .alloc_always });
        var workspaces: std.ArrayList(Workspace) = .empty;
        for (array(parsed.value, "windows")) |window| for (array(window, "workspaces")) |ws| {
            var tabs: std.ArrayList(Tab) = .empty;
            for (array(ws, "panes")) |pane| {
                var panes: std.ArrayList(Pane) = .empty;
                for (array(pane, "surfaces")) |surface| try panes.append(alloc, .{ .id = str(surface, "id"), .name = title(surface), .cwd = cwd(surface), .url = str(surface, "url") });
                if (panes.items.len > 0) try tabs.append(alloc, .{ .id = str(pane, "id"), .name = title(pane), .panes = try panes.toOwnedSlice(alloc) });
            }
            if (tabs.items.len > 0) try workspaces.append(alloc, .{ .id = str(ws, "id"), .name = title(ws), .cwd = cwd(ws), .tabs = try tabs.toOwnedSlice(alloc) });
        };
        self.catalog.workspaces = try workspaces.toOwnedSlice(alloc);
        self.catalog.message = "cmux surfaces become Corgi tabs; browser links are saved.";
    }
};
fn array(v: std.json.Value, key: []const u8) []const std.json.Value {
    if (v == .object) if (v.object.get(key)) |x| {
        if (x == .array) return x.array.items;
    };
    return &.{};
}
fn str(v: std.json.Value, key: []const u8) []const u8 {
    if (v == .object) if (v.object.get(key)) |x| {
        if (x == .string) return x.string;
    };
    return "";
}
fn title(v: std.json.Value) []const u8 {
    for ([_][]const u8{ "title", "name", "ref", "id" }) |key| {
        const s = str(v, key);
        if (s.len > 0) return s;
    }
    return "Untitled";
}
fn cwd(v: std.json.Value) []const u8 {
    for ([_][]const u8{ "cwd", "current_directory", "requested_working_directory", "working_directory" }) |key| {
        const s = str(v, key);
        if (s.len > 0) return s;
    }
    return "";
}
