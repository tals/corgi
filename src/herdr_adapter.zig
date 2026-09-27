//! Herdr's Unix API and cooperative PTY handoff. Nothing in discovery mutates
//! Herdr. The importer owns no process until Herdr sends `committed`.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const Value = std.json.Value;
const Runtime = @import("runtime.zig").Runtime;
const Terminal = @import("terminal.zig").Terminal;
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const Resume = @import("checkpoint.zig").Resume;
const Theme = @import("theme.zig").Theme;
const max_manifest = 16 * 1024 * 1024;

pub const SourcePane = struct { id: []const u8, name: []const u8, cwd: []const u8, pid: ?i32 = null, resume_hint: Resume = .{} };
pub const SourceTab = struct { id: []const u8, name: []const u8, panes: []const SourcePane, root: Value };
pub const SourceWorkspace = struct { id: []const u8, name: []const u8, cwd: []const u8, tabs: []const SourceTab };
pub const SourceSession = struct { socket: []const u8, name: []const u8, live_handoff: bool, workspaces: []const SourceWorkspace };
pub const Scan = struct {
    arena: std.heap.ArenaAllocator,
    sessions: []const SourceSession,
    pub fn deinit(self: *Scan) void {
        self.arena.deinit();
        self.* = undefined;
    }
};

fn field(value: Value, key: []const u8) Value {
    return if (value == .object) value.object.get(key) orelse .null else .null;
}
fn string(value: Value) []const u8 {
    return if (value == .string) value.string else "";
}
fn list(value: Value) []Value {
    return if (value == .array) value.array.items else &.{};
}
fn number(value: Value) i64 {
    return switch (value) {
        .integer => value.integer,
        else => 0,
    };
}
fn yes(value: Value) bool {
    return value == .bool and value.bool;
}
fn textField(value: Value, key: []const u8) []const u8 {
    return string(field(value, key));
}
fn equal(value: Value, key: []const u8, expected: []const u8) bool {
    return std.mem.eql(u8, textField(value, key), expected);
}
fn timeout(fd: c_int, seconds: i64) void {
    const t: c.struct_timeval = .{ .tv_sec = @intCast(seconds), .tv_usec = 0 };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &t, @sizeOf(@TypeOf(t)));
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &t, @sizeOf(@TypeOf(t)));
}

// Never overread a newline: the next byte can carry SCM_RIGHTS ancillary data.
fn line(fd: c_int, alloc: std.mem.Allocator, limit: usize) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    while (out.items.len < limit) {
        var bytes: [8192]u8 = undefined;
        const n = c.recv(fd, &bytes, @min(bytes.len, limit - out.items.len), c.MSG_PEEK);
        if (n < 0) switch (std.posix.errno(n)) {
            .INTR => continue,
            .AGAIN => return error.HerdrTimedOut,
            else => return error.HerdrReadFailed,
        };
        if (n == 0) return error.HerdrDisconnected;
        const peek = bytes[0..@intCast(n)];
        const end = std.mem.indexOfScalar(u8, peek, '\n');
        const count = if (end) |i| i + 1 else peek.len;
        var read: usize = 0;
        while (read < count) {
            const got = c.read(fd, bytes[read..].ptr, count - read);
            if (got < 0) switch (std.posix.errno(got)) {
                .INTR => continue,
                .AGAIN => return error.HerdrTimedOut,
                else => return error.HerdrReadFailed,
            };
            if (got == 0) return error.HerdrDisconnected;
            read += @intCast(got);
        }
        try out.appendSlice(alloc, bytes[0 .. count - @intFromBool(end != null)]);
        if (end != null) return out.toOwnedSlice(alloc);
    }
    return error.HerdrMessageTooLarge;
}

fn rpc(alloc: std.mem.Allocator, socket: []const u8, method: []const u8, params: anytype) !Value {
    const fd = try os.connect(socket);
    defer _ = c.close(fd);
    timeout(fd, 3);
    try os.sendJson(fd, .{ .id = "corgi:onboarding", .method = method, .params = params });
    const bytes = try line(fd, alloc, max_manifest);
    const parsed = try std.json.parseFromSlice(Value, alloc, bytes, .{ .allocate = .alloc_always });
    // Callers use an arena, which owns the parsed tree and bytes together.
    if (field(parsed.value, "error") != .null) return error.HerdrRequestFailed;
    const result = field(parsed.value, "result");
    if (result != .object) return error.InvalidHerdrResponse;
    return result;
}

fn resumeRef(value: Value) Resume {
    var out: Resume = .{};
    if (!equal(value, "kind", "id")) return out;
    const agent = textField(value, "agent");
    out.provider = @import("providers.zig").Provider.named(agent);
    const id = textField(value, "value");
    if (out.provider == null or id.len == 0 or id.len > out.session.len or !std.unicode.utf8ValidateSlice(id)) return .{};
    for (id) |ch| if (ch < 32 or ch == 127) return .{};
    @memcpy(out.session[0..id.len], id);
    out.len = id.len;
    return out;
}

/// Run in the onboarding discovery worker, never on the daemon event loop.
pub fn scan() !Scan {
    return scanCancelable(null);
}

/// Local presence check only; connecting to sessions remains discovery-worker work.
pub fn detected() bool {
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    var dirs = std.mem.splitScalar(u8, os.env("PATH") orelse "", ':');
    while (dirs.next()) |dir| {
        const path = std.fmt.bufPrintZ(&buffer, "{s}/herdr", .{if (dir.len == 0) "." else dir}) catch continue;
        const stat = std.fs.cwd().statFile(path) catch continue;
        if (stat.kind == .file and c.access(path, c.X_OK) == 0) return true;
    }
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const paths = socketCandidates(arena.allocator()) catch return false;
    for (paths) |candidate| {
        const stat = std.fs.cwd().statFile(candidate.path) catch continue;
        if (stat.kind == .unix_domain_socket) return true;
    }
    return false;
}

const SocketCandidate = struct { path: []const u8, name: []const u8 };
fn socketCandidates(alloc: std.mem.Allocator) ![]const SocketCandidate {
    var paths: std.ArrayList(SocketCandidate) = .empty;
    if (os.env("HERDR_SOCKET_PATH")) |path| try paths.append(alloc, .{ .path = try alloc.dupe(u8, path), .name = "Herdr" });
    const root = if (os.env("XDG_CONFIG_HOME")) |path| path else try std.fs.path.join(alloc, &.{ os.env("HOME") orelse return error.NoHome, ".config" });
    for ([_][]const u8{ "herdr", "herdr-dev" }) |app| {
        const dirpath = try std.fs.path.join(alloc, &.{ root, app });
        try paths.append(alloc, .{ .path = try std.fs.path.join(alloc, &.{ dirpath, "herdr.sock" }), .name = app });
        var dir = std.fs.cwd().openDir(try std.fs.path.join(alloc, &.{ dirpath, "sessions" }), .{ .iterate = true }) catch continue;
        defer dir.close();
        var entries = dir.iterate();
        while (try entries.next()) |entry| if (entry.kind == .directory and paths.items.len < 64) {
            try paths.append(alloc, .{ .path = try std.fs.path.join(alloc, &.{ dirpath, "sessions", entry.name, "herdr.sock" }), .name = try alloc.dupe(u8, entry.name) });
        };
    }
    return paths.toOwnedSlice(alloc);
}

pub fn scanCancelable(cancel: ?*const std.atomic.Value(bool)) !Scan {
    var arena = std.heap.ArenaAllocator.init(a);
    errdefer arena.deinit();
    const alloc = arena.allocator();
    const deadline = std.time.milliTimestamp() + 15000;
    var sessions: std.ArrayList(SourceSession) = .empty;
    const paths = try socketCandidates(alloc);
    for (paths, 0..) |candidate, index| {
        if (scanStopped(cancel, deadline)) break;
        var duplicate = false;
        for (paths[0..index]) |other| if (std.mem.eql(u8, candidate.path, other.path)) {
            duplicate = true;
            break;
        };
        if (duplicate) continue;
        const result = scanSession(alloc, candidate.path, candidate.name, cancel, deadline) catch continue;
        try sessions.append(alloc, result);
    }
    return .{ .arena = arena, .sessions = try sessions.toOwnedSlice(alloc) };
}

fn scanStopped(cancel: ?*const std.atomic.Value(bool), deadline: i64) bool {
    return (if (cancel) |flag| flag.load(.acquire) else false) or std.time.milliTimestamp() >= deadline;
}

fn scanSession(alloc: std.mem.Allocator, socket: []const u8, name: []const u8, cancel: ?*const std.atomic.Value(bool), deadline: i64) !SourceSession {
    const pong = try rpc(alloc, socket, "ping", .{});
    const snapshot = field(try rpc(alloc, socket, "session.snapshot", .{}), "snapshot");
    if (snapshot != .object) return error.InvalidHerdrResponse;
    var workspaces: std.ArrayList(SourceWorkspace) = .empty;
    for (list(field(snapshot, "workspaces"))) |ws| {
        const ws_id = textField(ws, "workspace_id");
        var tabs: std.ArrayList(SourceTab) = .empty;
        var cwd: []const u8 = "";
        for (list(field(snapshot, "tabs"))) |tab| {
            if (scanStopped(cancel, deadline)) return error.HerdrDiscoveryCancelled;
            if (!equal(tab, "workspace_id", ws_id)) continue;
            const tab_id = textField(tab, "tab_id");
            var panes: std.ArrayList(SourcePane) = .empty;
            for (list(field(snapshot, "panes"))) |pane| {
                if (scanStopped(cancel, deadline)) return error.HerdrDiscoveryCancelled;
                if (!equal(pane, "tab_id", tab_id)) continue;
                const pane_id = textField(pane, "pane_id");
                var dir = textField(pane, "foreground_cwd");
                if (dir.len == 0) dir = textField(pane, "cwd");
                if (cwd.len == 0) cwd = dir;
                var label = textField(pane, "label");
                if (label.len == 0) label = textField(pane, "agent");
                if (label.len == 0) label = textField(pane, "terminal_title_stripped");
                const process_result = rpc(alloc, socket, "pane.process_info", .{ .pane_id = pane_id }) catch .null;
                const process = field(process_result, "process_info");
                var pid: i64 = 0;
                for (list(field(process, "foreground_processes"))) |foreground| {
                    if (pid <= 0) pid = number(field(foreground, "pid"));
                    if (label.len == 0) label = textField(foreground, "name");
                }
                if (pid <= 0) pid = number(field(process, "shell_pid"));
                if (label.len == 0) label = "Terminal";
                try panes.append(alloc, .{ .id = pane_id, .name = label, .cwd = dir, .pid = if (pid > 0 and pid <= std.math.maxInt(i32)) @intCast(pid) else null, .resume_hint = resumeRef(field(pane, "agent_session")) });
            }
            const exported = try rpc(alloc, socket, "layout.export", .{ .tab_id = tab_id });
            const root_node = field(field(exported, "layout"), "root");
            if (root_node != .object) return error.InvalidHerdrLayout;
            try tabs.append(alloc, .{ .id = tab_id, .name = textField(tab, "label"), .panes = try panes.toOwnedSlice(alloc), .root = root_node });
        }
        try workspaces.append(alloc, .{ .id = ws_id, .name = textField(ws, "label"), .cwd = cwd, .tabs = try tabs.toOwnedSlice(alloc) });
    }
    return .{ .socket = socket, .name = name, .live_handoff = yes(field(field(pong, "capabilities"), "live_handoff")), .workspaces = try workspaces.toOwnedSlice(alloc) };
}

/// Copy starts ordinary new shells, preserves resume references as suggestions,
/// and never runs arbitrary source commands or resumes an agent automatically.
pub fn copy(r: *Runtime, source: SourceSession, selected: []const []const u8, defaults: Runtime.Create) !u32 {
    const old_len = r.workspaces.items.items.len;
    const old_panes = r.panes.items.len;
    errdefer {
        while (r.panes.items.len > old_panes) {
            const p = r.panes.pop().?;
            p.terminal.destroy();
            a.free(p.cwd);
        }
        while (r.workspaces.items.items.len > old_len) a.free(r.workspaces.items.pop().?.cwd);
        r.changed();
    }
    var first: u32 = 0;
    for (source.workspaces) |ws| {
        var chosen = false;
        for (selected) |id| if (std.mem.eql(u8, id, ws.id)) {
            chosen = true;
            break;
        };
        if (!chosen) continue;
        const ws_id = try r.workspaces.add(ws.name, if (ws.cwd.len > 0) ws.cwd else defaults.cwd);
        if (first == 0) first = ws_id;
        for (ws.tabs) |tab| {
            var options = defaults;
            options.workspace = ws_id;
            options.title = tab.name;
            try copyTab(r, tab, options);
        }
    }
    if (first == 0) return error.NothingSelected;
    r.changed();
    return first;
}

fn clearTree(model: *layout.Model, node_index: u8) void {
    const node = model.nodes[node_index] orelse return;
    if (node == .split) {
        clearTree(model, node.split.first);
        clearTree(model, node.split.second);
    }
    model.nodes[node_index] = null;
}

fn copiedTree(model: *layout.Model, node: Value, sources: []const SourcePane, ids: []const u32, used: []bool, depth: usize) anyerror!u8 {
    if (depth > layout.max_panes) return error.InvalidHerdrLayout;
    if (equal(node, "type", "pane")) {
        for (sources, ids, 0..) |source, id, i| if (equal(node, "pane_id", source.id)) {
            if (used[i]) return error.DuplicateHerdrPane;
            used[i] = true;
            return model.alloc(.{ .pane = id });
        };
        return error.InvalidHerdrLayout;
    }
    if (!equal(node, "type", "split")) return error.InvalidHerdrLayout;
    if (!equal(node, "direction", "right") and !equal(node, "direction", "down")) return error.InvalidHerdrLayout;
    return model.alloc(.{ .split = .{
        .axis = if (equal(node, "direction", "right")) .horizontal else .vertical,
        .ratio = ratio(field(node, "ratio")),
        .first = try copiedTree(model, field(node, "first"), sources, ids, used, depth + 1),
        .second = try copiedTree(model, field(node, "second"), sources, ids, used, depth + 1),
    } });
}

fn copyTab(r: *Runtime, tab: SourceTab, defaults: Runtime.Create) !void {
    if (tab.panes.len == 0 or tab.panes.len > layout.max_panes) return error.InvalidHerdrLayout;
    var ids: [layout.max_panes]u32 = undefined;
    for (tab.panes, 0..) |source, i| {
        var opts = defaults;
        opts.cwd = if (source.cwd.len > 0) source.cwd else defaults.cwd;
        opts.command = null;
        opts.interactive_command = false;
        opts.split = if (i == 0) null else .{ .pane = ids[0], .axis = .horizontal };
        const id = try r.create(opts);
        ids[i] = id;
        const pane = r.pane(id).?;
        pane.label.set(source.name);
        pane.resume_hint = source.resume_hint;
        const command = try source.resume_hint.command(a);
        defer a.free(command);
        if (command.len > 0) {
            pane.terminal.feed("\r\n# Resume your imported agent when ready:\r\n# ");
            pane.terminal.feed(command);
            pane.terminal.feed("\r\n");
        }
    }
    const ws = try r.getWorkspace(defaults.workspace);
    const index = ws.model.tabForPane(ids[0]) orelse return error.InvalidHerdrLayout;
    var model = ws.model;
    clearTree(&model, model.tabs[index].root);
    var used: [layout.max_panes]bool = @splat(false);
    model.tabs[index].root = try copiedTree(&model, tab.root, tab.panes, ids[0..tab.panes.len], used[0..tab.panes.len], 0);
    for (used[0..tab.panes.len]) |found| if (!found) return error.UnmappedHerdrTerminal;
    model.revision +%= 1;
    ws.model = model;
}

pub const Phase = enum(u8) { idle, connecting, receiving, preparing, committing, complete, failed };
pub const Progress = struct { phase: Phase = .idle, completed: usize = 0, total: usize = 0, workspace: ?u32 = null, message: []const u8 = "" };

/// Own on the daemon event loop. While locked(), reject layout mutation,
/// daemon reload and shutdown until tick() finishes the ownership transaction.
pub const Manager = struct {
    job: ?*Job = null,
    pub fn start(self: *Manager, source_socket: []const u8, executable: []const u8, theme: Theme, viewer_pgid: ?i32) !void {
        if (self.job) |job| {
            const phase = job.phase.load(.acquire);
            if ((phase != .complete and phase != .failed) or (phase == .complete and !job.adopted)) return error.HandoffInProgress;
            self.deinit();
        }
        const job = try a.create(Job);
        errdefer a.destroy(job);
        const source = try a.dupe(u8, source_socket);
        errdefer a.free(source);
        const exe = try a.dupe(u8, executable);
        errdefer a.free(exe);
        job.* = .{ .source = source, .executable = exe, .theme = theme, .viewer_pgid = viewer_pgid };
        job.thread = try std.Thread.spawn(.{}, Job.run, .{job});
        self.job = job;
    }
    pub fn locked(self: *const Manager) bool {
        const job = self.job orelse return false;
        return job.reserved and !job.adopted;
    }
    pub fn busy(self: *const Manager) bool {
        return self.active();
    }
    pub fn active(self: *const Manager) bool {
        const phase = self.status().phase;
        return phase != .idle and phase != .failed and phase != .complete;
    }
    pub fn status(self: *const Manager) Progress {
        const job = self.job orelse return .{};
        const actual = job.phase.load(.acquire);
        const phase: Phase = if (actual == .complete and !job.adopted) .committing else actual;
        return .{ .phase = phase, .completed = if (phase == .complete) job.total.load(.monotonic) else 0, .total = job.total.load(.monotonic), .workspace = if (job.adopted) job.first_workspace else null, .message = if (phase == .failed) job.failure else switch (phase) {
            .connecting => "Connecting to Herdr",
            .receiving => "Receiving live terminals",
            .preparing => "Preparing your workspaces",
            .committing => if (job.uncertain.load(.monotonic)) "Waiting for Herdr ownership confirmation" else "Moving terminal ownership",
            .complete => "Processes are running in Corgi",
            else => "",
        } };
    }
    pub fn tick(self: *Manager, r: *Runtime) bool {
        const job = self.job orelse return false;
        const phase = job.phase.load(.acquire);
        if (phase == .preparing and !job.reserved and !job.cancel.load(.acquire)) {
            job.prepare(r) catch |err| {
                job.preparation_failure = err;
                job.cancel.store(true, .release);
                return false;
            };
            job.reserved = true;
            job.approved.store(true, .release);
        }
        if (phase == .complete and !job.adopted) {
            // Every allocation and ID assignment happened before `ready`.
            // Until this point no Corgi reader could touch a transferred PTY.
            for (job.staged.panes.items, 0..) |*p, i| {
                p.terminal.fd = job.fds[i];
                job.fds[i] = -1;
                p.terminal.pid = job.pids[i];
                p.terminal.imported = true;
                p.terminal.redraw_pending = true;
                os.nonblock(p.terminal.fd);
                r.panes.appendAssumeCapacity(p.*);
            }
            for (job.staged.workspaces.items.items) |ws| r.workspaces.items.appendAssumeCapacity(ws);
            job.staged.panes.clearRetainingCapacity();
            job.staged.workspaces.items.clearRetainingCapacity();
            job.adopted = true;
            r.changed();
            return true;
        }
        if (phase == .failed) job.reserved = false;
        return false;
    }
    pub fn deinit(self: *Manager) void {
        const job = self.job orelse return;
        job.cancel.store(true, .release);
        if (job.thread) |thread| thread.join();
        // Shutdown can reach this defer between the commit message and the
        // next event-loop tick. Finish ownership adoption first; never treat
        // committed masters as disposable candidate duplicates. The runtime
        // then performs the same explicit shutdown as for its other panes.
        if (job.phase.load(.acquire) == .complete and !job.adopted) {
            if (job.target) |target| _ = self.tick(target);
        }
        // fd/pid are only put in live Terminal objects by tick after commit.
        job.staged.deinit();
        for (job.fds) |fd| if (fd >= 0) {
            _ = c.close(fd);
        };
        a.free(job.fds);
        a.free(job.pids);
        a.free(job.source);
        a.free(job.executable);
        a.destroy(job);
        self.job = null;
    }
};

const Job = struct {
    source: []const u8,
    executable: []const u8,
    theme: Theme,
    viewer_pgid: ?i32,
    thread: ?std.Thread = null,
    phase: std.atomic.Value(Phase) = .init(.connecting),
    total: std.atomic.Value(usize) = .init(0),
    cancel: std.atomic.Value(bool) = .init(false),
    approved: std.atomic.Value(bool) = .init(false),
    uncertain: std.atomic.Value(bool) = .init(false),
    failure: []const u8 = "",
    preparation_failure: ?anyerror = null,
    staged: Runtime = .{},
    fds: []i32 = &.{},
    pids: []i32 = &.{},
    reserved: bool = false,
    adopted: bool = false,
    first_workspace: ?u32 = null,
    target: ?*Runtime = null,

    fn run(job: *Job) void {
        job.transfer() catch |err| {
            job.failure = if (job.cancel.load(.acquire)) @errorName(job.preparation_failure orelse err) else @errorName(err);
            for (job.fds) |*fd| {
                if (fd.* >= 0) _ = c.close(fd.*);
                fd.* = -1;
            }
            job.phase.store(.failed, .release);
        };
    }
    fn prepare(job: *Job, r: *Runtime) !void {
        if (r.panes.items.len + job.staged.panes.items.len > layout.max_panes) return error.TooManyPanes;
        if (r.workspaces.items.items.len + job.staged.workspaces.items.items.len > workspace.max_workspaces) return error.TooManyWorkspaces;
        if (r.workspaces.next_id > std.math.maxInt(u32) - job.staged.workspaces.items.items.len) return error.TooManyWorkspaces;
        try r.panes.ensureUnusedCapacity(a, job.staged.panes.items.len);
        try r.workspaces.items.ensureUnusedCapacity(a, job.staged.workspaces.items.items.len);
        const pane_offset = r.workspaces.next_pane_id;
        if (pane_offset > std.math.maxInt(u32) - job.staged.workspaces.next_pane_id) return error.TooManyPanes;
        for (job.staged.panes.items) |*p| {
            p.id += pane_offset;
            if (p.resume_hint.provider) |provider| if (p.resume_hint.len > 0) {
                const actor = try r.conversations.get(provider, p.resume_hint.session[0..p.resume_hint.len]);
                if (actor.state.last_seq == 0 and actor.state.state == .unknown) {
                    actor.state.state = p.attachment.provisional.state;
                    // Source hooks keep their original environment. Treat the
                    // captured lifecycle as an initial observation, allowing
                    // Corgi's screen/transcript observer to refine it normally.
                    actor.state.observation.source = .screen;
                }
                p.attachment.select(actor);
            };
        }
        for (job.staged.workspaces.items.items) |*ws| {
            ws.id = r.workspaces.next_id;
            r.workspaces.next_id += 1;
            if (job.first_workspace == null) job.first_workspace = ws.id;
            for (&ws.model.nodes) |*slot| if (slot.*) |node| if (node == .pane) {
                slot.*.?.pane += pane_offset;
            };
            for (ws.model.tabs[0..ws.model.count]) |*tab| tab.id += pane_offset;
            ws.model.next_id += pane_offset;
        }
        r.workspaces.next_pane_id += job.staged.workspaces.next_pane_id;
        job.target = r;
    }
    fn transfer(job: *Job) !void {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const alloc = arena.allocator();
        const pong = try rpc(alloc, job.source, "ping", .{});
        if (!yes(field(field(pong, "capabilities"), "live_handoff"))) return error.HerdrHandoffUnsupported;
        const dir = try std.fmt.allocPrint(alloc, "/tmp/corgi-{d}/herdr-{x}", .{ c.getuid(), std.crypto.random.int(u64) });
        try os.privateDirectory(dir);
        defer std.fs.cwd().deleteTree(dir) catch {};
        const bridge_path = try std.fs.path.join(alloc, &.{ dir, "bridge.sock" });
        const launcher = try std.fs.path.join(alloc, &.{ dir, "import" });
        const token = try std.fmt.allocPrint(alloc, "{x}{x}", .{ std.crypto.random.int(u64), std.crypto.random.int(u64) });
        const listener = try os.listen(bridge_path);
        defer _ = c.close(listener);
        const script = try std.fmt.allocPrint(alloc, "#!/bin/sh\nexec {s} __herdr_import {s} {s} \"$@\"\n", .{ try shellQuote(alloc, job.executable), try shellQuote(alloc, bridge_path), try shellQuote(alloc, token) });
        {
            const file = try std.fs.cwd().createFile(launcher, .{ .mode = 0o700, .exclusive = true });
            defer file.close();
            try file.writeAll(script);
        }
        const request = try os.connect(job.source);
        defer _ = c.close(request);
        timeout(request, 35);
        try os.sendJson(request, .{ .id = "corgi:handoff", .method = "server.live_handoff", .params = .{ .import_exe = launcher } });
        const bridge = try acceptBridge(listener, request, &job.cancel);
        defer _ = c.close(bridge);
        timeout(bridge, 35);
        if (!std.mem.eql(u8, try line(bridge, alloc, 256), token)) return error.InvalidHandoffToken;
        const donor_pid = try std.fmt.parseInt(i32, try line(bridge, alloc, 32), 10);
        if (donor_pid <= 1) return error.InvalidHerdrProcess;
        const source_fds = try receiveFds(bridge, 1);
        defer a.free(source_fds);
        const source = source_fds[0];
        defer _ = c.close(source);
        timeout(source, 30);
        job.phase.store(.receiving, .release);
        const bytes = try line(source, alloc, max_manifest);
        const parsed = try std.json.parseFromSlice(Value, alloc, bytes, .{ .allocate = .alloc_always });
        const manifest = parsed.value;
        if (number(field(manifest, "version")) != 1 or field(manifest, "expected_version") != .null or field(manifest, "expected_protocol") != .null) return error.UnsupportedHerdrManifest;
        const panes = list(field(manifest, "panes"));
        if (panes.len == 0 or panes.len > layout.max_panes) return error.TooManyPanes;
        try job.restoreManifest(manifest);
        job.total.store(panes.len, .monotonic);
        try os.writeAll(source, "validated\n");
        job.fds = try receiveFds(source, panes.len);
        for (job.fds, 0..) |fd, i| {
            if (c.isatty(fd) != 1) return error.InvalidHerdrTerminalDescriptor;
            const foreground = c.tcgetpgrp(fd);
            if (job.viewer_pgid) |viewer| if (viewer > 0 and foreground == viewer) return error.CannotHandoffCurrentConsole;
            if (foreground > 0 and corgiProcess(foreground, job.executable)) return error.CannotHandoffCurrentConsole;
            if (@import("detection.zig").foreground(fd)) |process| {
                const p = &job.staged.panes.items[i];
                p.detection.pid = process.pid;
                p.detection.ready = p.attachment.provisional.state != .unknown;
            }
        }
        job.phase.store(.preparing, .release);
        const deadline = std.time.milliTimestamp() + 15000;
        while (!job.approved.load(.acquire)) {
            if (job.cancel.load(.acquire)) return error.HandoffCancelled;
            if (std.time.milliTimestamp() >= deadline) return error.HandoffPreparationTimedOut;
            _ = c.poll(null, 0, 5);
        }
        if (job.cancel.load(.acquire)) return error.HandoffCancelled;
        job.phase.store(.committing, .release);
        try os.writeAll(source, "restored\nready\n");
        try job.waitCommitted(source, request, donor_pid);
        // Irreversible point. No cancellation/fallible work after this message.
        job.phase.store(.complete, .release);
        os.writeAll(source, "owned\n") catch {};
        os.writeAll(bridge, "done\n") catch {};
        // Merely keeping request open through commit lets the source write its
        // success. It must not delay event-loop adoption or a later import.
    }
    fn waitCommitted(job: *Job, source: i32, request: i32, donor_pid: i32) !void {
        // All memory is reserved before readiness. In particular, OOM cannot
        // turn a received commit into pre-commit cleanup of the last PTY master.
        var commit: [64]u8 = undefined;
        var commit_len: usize = 0;
        var reply: [16384]u8 = undefined;
        var reply_len: usize = 0;
        var source_closed = false;
        var request_closed = false;
        var next_reconcile: i64 = 0;
        while (true) {
            var fds = [_]c.struct_pollfd{
                .{ .fd = if (source_closed) -1 else source, .events = c.POLLIN, .revents = 0 },
                .{ .fd = if (request_closed) -1 else request, .events = c.POLLIN, .revents = 0 },
            };
            _ = c.poll(&fds, fds.len, 100);
            if (fds[0].revents != 0) {
                const n = c.recv(source, commit[commit_len..].ptr, commit.len - commit_len, c.MSG_DONTWAIT);
                if (n > 0) {
                    commit_len += @intCast(n);
                    if (std.mem.indexOfScalar(u8, commit[0..commit_len], '\n')) |end| {
                        if (std.mem.eql(u8, commit[0..end], "committed")) return;
                        source_closed = true;
                    } else if (commit_len == commit.len) source_closed = true;
                } else if (n == 0 or (std.posix.errno(n) != .AGAIN and std.posix.errno(n) != .INTR)) source_closed = true;
            }
            if (fds[1].revents != 0) {
                const n = c.recv(request, reply[reply_len..].ptr, reply.len - reply_len, c.MSG_DONTWAIT);
                if (n > 0) {
                    reply_len += @intCast(n);
                    if (std.mem.indexOfScalar(u8, reply[0..reply_len], '\n')) |end| {
                        // The initiating RPC is a second authoritative result:
                        // Herdr answers only after preserving or rolling back.
                        var memory: [65536]u8 = undefined;
                        var fixed = std.heap.FixedBufferAllocator.init(&memory);
                        if (std.json.parseFromSlice(Value, fixed.allocator(), reply[0..end], .{})) |parsed| {
                            if (field(parsed.value, "error") != .null) return error.HerdrHandoffRolledBack;
                            if (equal(field(parsed.value, "result"), "type", "ok")) return;
                        } else |_| {}
                        request_closed = true;
                    } else if (reply_len == reply.len) request_closed = true;
                } else if (n == 0 or (std.posix.errno(n) != .AGAIN and std.posix.errno(n) != .INTR)) request_closed = true;
            }
            if (source_closed or request_closed) job.uncertain.store(true, .monotonic);
            if (!source_closed or !request_closed) continue;
            // Never close potentially sole PTY masters on an ambiguous socket
            // failure. A dead donor cannot be another reader; salvage its PTYs.
            if (c.kill(donor_pid, 0) != 0 and std.posix.errno(-1) == .SRCH) return;
            const now = std.time.milliTimestamp();
            if (now < next_reconcile) continue;
            next_reconcile = now + 1000;
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            // ping is answered by Herdr's API thread, even during a handoff.
            // A full snapshot requires its main loop: it can answer again only
            // after rollback. A committed source exits instead of resuming it.
            if (rpc(arena.allocator(), job.source, "session.snapshot", .{})) |_| return error.HerdrHandoffRolledBack else |_| {}
        }
    }
    fn restoreManifest(job: *Job, manifest: Value) !void {
        const snapshots = list(field(field(manifest, "snapshot"), "workspaces"));
        if (snapshots.len == 0 or snapshots.len > workspace.max_workspaces) return error.TooManyWorkspaces;
        const states = list(field(manifest, "panes"));
        job.pids = try a.alloc(i32, states.len);
        var seen: [layout.max_panes]bool = @splat(false);
        for (states, 0..) |state, i| {
            const pid = number(field(state, "child_pid"));
            if (pid <= 0 or pid > std.math.maxInt(i32)) return error.InvalidHerdrProcess;
            job.pids[i] = @intCast(pid);
            const cols = number(field(state, "cols"));
            const rows = number(field(state, "rows"));
            if (cols < 1 or cols > 4096 or rows < 1 or rows > 4096) return error.InvalidHerdrTerminalSize;
            const source_id = number(field(state, "pane_id"));
            if (source_id < 0 or source_id > std.math.maxInt(u32)) return error.InvalidHerdrLayout;
            for (states[0..i]) |other| if (number(field(other, "pane_id")) == source_id) return error.DuplicateHerdrPane;
            const terminal = try Terminal.create(@intCast(cols), @intCast(rows));
            errdefer terminal.destroy();
            terminal.applyTheme(job.theme);
            terminal.restoring = true;
            seedTerminal(terminal, state);
            terminal.restoring = false;
            const cwd = try a.dupe(u8, "/");
            errdefer a.free(cwd);
            try job.staged.panes.append(a, .{ .id = @intCast(i + 1), .terminal = terminal, .cwd = cwd });
        }
        job.staged.workspaces.next_pane_id = @intCast(states.len + 1);
        for (snapshots) |snapshot| {
            const cwd = textField(snapshot, "identity_cwd");
            if (!std.fs.path.isAbsolute(cwd)) return error.InvalidHerdrDirectory;
            // A live shell may be in a deleted directory. Preserve its path;
            // unlike a copied layout, ownership transfer does not chdir/spawn.
            var ws: workspace.Workspace = .{ .id = job.staged.workspaces.next_id, .cwd = try a.dupe(u8, cwd) };
            errdefer a.free(ws.cwd);
            const name = textField(snapshot, "custom_name");
            ws.name_len = @min(name.len, ws.name_buf.len);
            for (name[0..ws.name_len], 0..) |ch, i| ws.name_buf[i] = if (ch >= 32 and ch < 127) ch else '_';
            const tabs = list(field(snapshot, "tabs"));
            if (tabs.len == 0 or tabs.len > layout.max_tabs) return error.TooManyTabs;
            for (tabs) |tab| {
                const root = try restoreTree(&ws.model, field(tab, "layout"), states, &seen, 0);
                var out: layout.Tab = .{ .id = job.staged.workspaces.next_pane_id, .root = root };
                job.staged.workspaces.next_pane_id += 1;
                out.rename(textField(tab, "custom_name"));
                ws.model.tabs[ws.model.count] = out;
                ws.model.count += 1;
                const pane_map = field(tab, "panes");
                if (pane_map != .object) return error.InvalidHerdrLayout;
                var entries = pane_map.object.iterator();
                while (entries.next()) |entry| {
                    const source_id = try std.fmt.parseInt(u32, entry.key_ptr.*, 10);
                    const index = stateIndex(states, source_id) orelse return error.InvalidHerdrLayout;
                    const p = &job.staged.panes.items[index];
                    const pane_cwd = textField(entry.value_ptr.*, "cwd");
                    if (!std.fs.path.isAbsolute(pane_cwd)) return error.InvalidHerdrDirectory;
                    const owned_cwd = try a.dupe(u8, pane_cwd);
                    a.free(p.cwd);
                    p.cwd = owned_cwd;
                    p.label.set(textField(entry.value_ptr.*, "label"));
                    p.resume_hint = resumeRef(field(entry.value_ptr.*, "agent_session"));
                    const status = textField(field(field(states[index], "agent_state"), "authority"), "state");
                    p.attachment.provisional.provider = p.resume_hint.provider;
                    p.attachment.provisional.state = if (std.mem.eql(u8, status, "Working")) .working else if (std.mem.eql(u8, status, "Blocked")) .blocked else if (std.mem.eql(u8, status, "Idle")) .idle else .unknown;
                    p.attachment.provisional.observation.source = .screen;
                }
            }
            ws.model.next_id = job.staged.workspaces.next_pane_id;
            try job.staged.workspaces.items.append(a, ws);
            job.staged.workspaces.next_id += 1;
        }
        for (seen[0..states.len]) |found| if (!found) return error.UnmappedHerdrTerminal;
    }
};

fn stateIndex(states: []Value, id: u32) ?usize {
    for (states, 0..) |state, i| if (number(field(state, "pane_id")) == id) return i;
    return null;
}
fn ratio(value: Value) u16 {
    const n: f64 = switch (value) {
        .float => value.float,
        .integer => @floatFromInt(value.integer),
        else => 0.5,
    };
    return if (std.math.isFinite(n)) @intFromFloat(@min(900, @max(100, n * 1000))) else 500;
}
fn restoreTree(model: *layout.Model, node: Value, states: []Value, seen: *[layout.max_panes]bool, depth: usize) anyerror!u8 {
    if (depth > layout.max_panes) return error.InvalidHerdrLayout;
    const leaf = field(node, "Pane");
    if (leaf == .integer) {
        if (leaf.integer < 0 or leaf.integer > std.math.maxInt(u32)) return error.InvalidHerdrLayout;
        const index = stateIndex(states, @intCast(leaf.integer)) orelse return error.InvalidHerdrLayout;
        if (seen[index]) return error.DuplicateHerdrPane;
        seen[index] = true;
        return model.alloc(.{ .pane = @intCast(index + 1) });
    }
    const split = field(node, "Split");
    if (split != .object or (!equal(split, "direction", "Horizontal") and !equal(split, "direction", "Vertical"))) return error.InvalidHerdrLayout;
    return model.alloc(.{ .split = .{ .axis = if (equal(split, "direction", "Horizontal")) .horizontal else .vertical, .ratio = ratio(field(split, "ratio")), .first = try restoreTree(model, field(split, "first"), states, seen, depth + 1), .second = try restoreTree(model, field(split, "second"), states, seen, depth + 1) } });
}
fn seedTerminal(t: *Terminal, state: Value) void {
    t.feed(textField(state, "initial_history_ansi"));
    const input = field(state, "input_state");
    const modes = .{ .{ "alternate_screen", "\x1b[?1049h" }, .{ "application_cursor", "\x1b[?1h" }, .{ "bracketed_paste", "\x1b[?2004h" }, .{ "focus_reporting", "\x1b[?1004h" }, .{ "mouse_alternate_scroll", "\x1b[?1007h" }, .{ "modify_other_keys", "\x1b[>4;2m" }, .{ "color_scheme_reporting", "\x1b[?2031h" } };
    inline for (modes) |mode| if (yes(field(input, mode[0]))) t.feed(mode[1]);
    const mouse = textField(input, "mouse_protocol_mode");
    const mouse_modes = .{ .{ "press", "\x1b[?9h" }, .{ "press_release", "\x1b[?1000h" }, .{ "button_motion", "\x1b[?1002h" }, .{ "any_motion", "\x1b[?1003h" } };
    inline for (mouse_modes) |mode| if (std.mem.eql(u8, mouse, mode[0])) t.feed(mode[1]);
    const encoding = textField(input, "mouse_protocol_encoding");
    const encodings = .{ .{ "utf8", "\x1b[?1005h" }, .{ "sgr", "\x1b[?1006h" }, .{ "sgr_pixels", "\x1b[?1016h" } };
    inline for (encodings) |mode| if (std.mem.eql(u8, encoding, mode[0])) t.feed(mode[1]);
    const keyboard = textField(state, "keyboard_protocol_ansi");
    if (keyboard.len > 0) t.feed(keyboard) else {
        var buf: [40]u8 = undefined;
        const flags = number(field(state, "keyboard_protocol_flags"));
        if (flags > 0 and flags <= 65535) t.feed(std.fmt.bufPrint(&buf, "\x1b[>{d}u", .{flags}) catch "");
    }
    const title = textField(state, "terminal_title");
    if (title.len > 0) {
        t.feed("\x1b]2;");
        for (title) |ch| if (ch >= 32 and ch != 127) t.feed(&.{ch});
        t.feed("\x1b\\");
    }
}

fn shellQuote(alloc: std.mem.Allocator, value: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(alloc, '\'');
    for (value) |ch| if (ch == '\'') try out.appendSlice(alloc, "'\\''") else try out.append(alloc, ch);
    try out.append(alloc, '\'');
    return out.toOwnedSlice(alloc);
}

fn corgiProcess(pid: i32, executable: []const u8) bool {
    var bytes: [std.fs.max_path_bytes]u8 = undefined;
    const path = if (@import("builtin").os.tag == .macos) blk: {
        const n = c.proc_pidpath(pid, &bytes, bytes.len);
        if (n <= 0) return false;
        break :blk std.mem.sliceTo(bytes[0..@intCast(n)], 0);
    } else blk: {
        var link: [64]u8 = undefined;
        const filename = std.fmt.bufPrint(&link, "/proc/{d}/exe", .{pid}) catch return false;
        break :blk std.posix.readlink(filename, &bytes) catch return false;
    };
    return std.mem.eql(u8, path, executable) or std.mem.eql(u8, std.fs.path.basename(path), "corgi");
}
fn acceptBridge(listener: i32, request: i32, cancel: *std.atomic.Value(bool)) !i32 {
    const deadline = std.time.milliTimestamp() + 30000;
    while (std.time.milliTimestamp() < deadline) {
        if (cancel.load(.acquire)) return error.HandoffCancelled;
        var pollfds = [_]c.struct_pollfd{ .{ .fd = listener, .events = c.POLLIN, .revents = 0 }, .{ .fd = request, .events = c.POLLIN, .revents = 0 } };
        _ = c.poll(&pollfds, pollfds.len, 50);
        if (pollfds[0].revents & c.POLLIN != 0) {
            const fd = c.accept(listener, null, null);
            if (fd >= 0) {
                errdefer _ = c.close(fd);
                os.cloexec(fd);
                // macOS inherits O_NONBLOCK from the listener. The handshake
                // reads below must wait for the helper, bounded by SO_RCVTIMEO.
                const flags = c.fcntl(fd, c.F_GETFL, @as(c_int, 0));
                if (flags < 0 or c.fcntl(fd, c.F_SETFL, flags & ~@as(c_int, c.O_NONBLOCK)) < 0) return error.HandoffSocketSetupFailed;
                return fd;
            }
        }
        if (pollfds[1].revents & (c.POLLIN | c.POLLHUP | c.POLLERR) != 0) return error.HerdrHandoffRejected;
    }
    return error.HandoffImporterTimedOut;
}

const control_align = if (@import("builtin").os.tag == .macos) 4 else @sizeOf(usize);
fn aligned(n: usize) usize {
    return std.mem.alignForward(usize, n, control_align);
}
fn sendFd(socket: i32, fd: i32) !void {
    var control: [128]u8 align(@alignOf(c.struct_cmsghdr)) = @splat(0);
    const header: *c.struct_cmsghdr = @ptrCast(&control);
    const offset = aligned(@sizeOf(c.struct_cmsghdr));
    header.* = .{ .cmsg_len = @intCast(offset + @sizeOf(i32)), .cmsg_level = c.SOL_SOCKET, .cmsg_type = c.SCM_RIGHTS };
    @memcpy(control[offset..][0..4], std.mem.asBytes(&fd));
    var marker = [_]u8{'F'};
    var iov: c.struct_iovec = .{ .iov_base = &marker, .iov_len = 1 };
    var msg = std.mem.zeroes(c.struct_msghdr);
    msg.msg_iov = &iov;
    msg.msg_iovlen = 1;
    msg.msg_control = &control;
    msg.msg_controllen = @intCast(offset + aligned(4));
    if (c.sendmsg(socket, &msg, 0) != 1) return error.HandoffDescriptorSendFailed;
}
fn receiveFds(socket: i32, expected: usize) ![]i32 {
    const result = try a.alloc(i32, expected);
    var count: usize = 0;
    errdefer {
        for (result[0..count]) |fd| {
            _ = c.close(fd);
        }
        a.free(result);
    }
    while (count < expected) {
        var control: [1024]u8 align(@alignOf(c.struct_cmsghdr)) = @splat(0);
        var marker: [1]u8 = undefined;
        var iov: c.struct_iovec = .{ .iov_base = &marker, .iov_len = 1 };
        var msg = std.mem.zeroes(c.struct_msghdr);
        msg.msg_iov = &iov;
        msg.msg_iovlen = 1;
        msg.msg_control = &control;
        msg.msg_controllen = control.len;
        const read = c.recvmsg(socket, &msg, 0);
        if (read < 0 and std.posix.errno(read) == .INTR) continue;
        if (read <= 0) return error.HandoffDescriptorsMissing;
        var offset: usize = 0;
        const before = count;
        var invalid = msg.msg_flags & c.MSG_CTRUNC != 0 or marker[0] != 'F';
        while (offset + @sizeOf(c.struct_cmsghdr) <= msg.msg_controllen) {
            const header: *const c.struct_cmsghdr = @ptrCast(@alignCast(control[offset..].ptr));
            const start = offset + aligned(@sizeOf(c.struct_cmsghdr));
            if (header.cmsg_len < aligned(@sizeOf(c.struct_cmsghdr)) or offset + header.cmsg_len > msg.msg_controllen) {
                invalid = true;
                break;
            }
            if (header.cmsg_level == c.SOL_SOCKET and header.cmsg_type == c.SCM_RIGHTS) {
                var at = start;
                while (at + 4 <= offset + header.cmsg_len) : (at += 4) {
                    const fd = std.mem.bytesToValue(i32, control[at..][0..4]);
                    os.cloexec(fd);
                    if (count < expected) {
                        result[count] = fd;
                        count += 1;
                    } else {
                        _ = c.close(fd);
                        invalid = true;
                    }
                }
            }
            offset += aligned(header.cmsg_len);
        }
        if (invalid or count == before) return error.InvalidHandoffDescriptors;
    }
    return result;
}

/// Internal helper spawned by unmodified Herdr via its `import_exe` option.
/// Pass args *after* `__herdr_import`; this helper never owns a process or reads
/// a PTY. It hands its authenticated source socket to the existing Corgi daemon.
pub fn importBridge(args: []const []const u8) !void {
    if (args.len != 6 or !std.mem.eql(u8, args[2], "server") or !std.mem.eql(u8, args[3], "--handoff-import")) return error.InvalidHerdrImporterArguments;
    _ = c.signal(c.SIGPIPE, os.sig_ignore);
    const bridge = try os.connect(args[0]);
    defer _ = c.close(bridge);
    timeout(bridge, 60);
    const source = try os.connect(args[4]);
    defer _ = c.close(source);
    try os.writeAll(source, args[5]);
    try os.writeAll(source, "\n");
    try os.writeAll(bridge, args[1]);
    try os.writeAll(bridge, "\n");
    var pid: [32]u8 = undefined;
    try os.writeAll(bridge, try std.fmt.bufPrint(&pid, "{d}\n", .{c.getppid()}));
    try sendFd(bridge, source);
    const done = try line(bridge, a, 64);
    defer a.free(done);
    if (!std.mem.eql(u8, done, "done")) return error.HandoffNotCommitted;
}
