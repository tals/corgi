//! Daemon resource ownership, socket dispatch and background observation.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const workspace = @import("workspace.zig");
const runtime = @import("runtime.zig");
const native = @import("native.zig");
const protocol = @import("protocol.zig");
const Theme = @import("theme.zig").Theme;
const Client = @import("peer.zig").Client;
pub const Server = struct {
    const Pane = runtime.Pane;
    runtime: runtime.Runtime = .{},
    preferred_workspace: u32 = 0, // Startup hint only; commands never use it.
    default_folder_pending: bool = true,
    clients: std.ArrayList(Client) = .empty,
    socket: []const u8,
    executable: []const u8,
    theme: Theme = .{},
    dirty: bool = true,
    quit: bool = false,
    bell: bool = false,
    bell_kind: agents.Attention = .none,
    last_bell: i64 = 0,
    bell_seq: u64 = 0,
    next_viewer: u32 = 1,
    last_bell_kind: agents.Attention = .none,
    last_detection: i64 = 0,
    inherited_listener: ?c_int = null,
    reload_executable: ?[]const u8 = null,
    reload_requester: c_int = -1,
    last_recovery: i64 = 0,
    saved_revision: u64 = 0,
    pub fn initialWorkspace(s: *Server) *workspace.Workspace {
        return &s.runtime.workspaces.items.items[s.runtime.workspaces.index(s.preferred_workspace) orelse 0];
    }
    pub fn onlyWorkspace(s: *Server) !*workspace.Workspace {
        if (s.runtime.workspaces.items.items.len != 1) return error.MissingWorkspace;
        return &s.runtime.workspaces.items.items[0];
    }
    pub fn saveWorkspaces(s: *Server) void {
        const path = workspace.Store.statePath(s.socket) catch return;
        defer a.free(path);
        s.runtime.workspaces.save(path, s.initialWorkspace().id) catch |err| std.log.err("saving workspaces: {s}", .{@errorName(err)});
    }
    fn followWorkspaceDirectories(s: *Server) void {
        var changed = false;
        for (s.runtime.workspaces.items.items) |*ws| {
            if (ws.model.count == 0) continue;
            const p = s.pane(ws.model.firstPane(ws.model.tabs[0].root)) orelse continue;
            changed = (ws.follow(p.cwd) catch false) or changed;
        }
        if (changed) {
            s.dirty = true;
            s.saveWorkspaces();
        }
    }
    fn pane(s: *Server, id: layout.Id) ?*Pane {
        return s.runtime.pane(id);
    }
    pub fn notice(_: *Server, msg: []const u8) void {
        std.log.info("{s}", .{msg});
    }
    /// All shared commands have one execution and post-commit path.
    pub fn execute(s: *Server, command: @import("session.zig").Command, allocator: std.mem.Allocator) !@import("session.zig").Result {
        const before = s.runtime.revision;
        const result = try @import("session.zig").execute(&s.runtime, .{ .socket = s.socket, .executable = s.executable, .theme = s.theme }, command, allocator);
        if (s.runtime.revision != before) {
            if (result.pane != 0) s.default_folder_pending = false;
            s.dirty = true;
            s.followWorkspaceDirectories();
            s.saveWorkspaces();
            @import("viewer_protocol.zig").resize(s) catch |err| std.log.warn("resizing panes: {s}", .{@errorName(err)});
        }
        return result;
    }
    pub fn close(s: *Server, id: layout.Id) !void {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        _ = try s.execute(.{ .@"pane.close" = .{ .target = id } }, arena.allocator());
    }
    pub fn visitWorkspace(s: *Server, id: u32) void {
        const index = s.runtime.workspaces.index(id) orelse return;
        if (s.runtime.workspaces.items.items[index].away.visit(std.time.milliTimestamp())) {
            s.runtime.changed();
            s.dirty = true;
        }
    }
    fn workspaceWatched(s: *Server, id: u32) bool {
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead and cl.watched and cl.view_workspace == id and std.time.milliTimestamp() - cl.touched < 1000) return true;
        return false;
    }
    fn paneWatched(s: *Server, id: u32) bool {
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead and cl.watched and cl.view_focus == id and std.time.milliTimestamp() - cl.touched < 1000) return true;
        return false;
    }
    fn queueSession(s: *Server, cl: *Client) !void {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        try cl.queue(try protocol.snapshot(arena.allocator(), &s.runtime));
        cl.snapshot_revision = s.runtime.revision;
        cl.last_snapshot = std.time.milliTimestamp();
    }

    fn runtimeRequest(s: *Server, cl: *Client, v: std.json.Value) !bool {
        const op = agents.str(v, "op");
        if (eq(op, "hello")) {
            try protocol.require(v, null);
            cl.protocol_version = protocol.version;
            try cl.queue(.{ .type = "hello", .protocol = protocol.version, .capabilities = protocol.capabilities, .server_pid = c.getpid(), .build_id = &@import("main.zig").build_id });
            return true;
        }
        var known = false;
        for (protocol.capabilities) |name| if (eq(op, name)) {
            known = true;
            break;
        };
        if (!known) return false;
        try protocol.require(v, cl.protocol_version);
        if (eq(op, "session.snapshot") or eq(op, "session.subscribe")) {
            if (eq(op, "session.subscribe") and cl.viewer) return error.AlreadyAttached;
            try s.queueSession(cl);
            if (eq(op, "session.subscribe")) cl.subscribed = true;
        } else if (eq(op, "pane.surface")) {
            const id = try protocol.id(v, "pane");
            const p = s.pane(id) orelse return error.NoPane;
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            const surface = try @import("surface.zig").capture(arena.allocator(), id, p.terminal);
            try cl.queue(.{ .type = "surface", .protocol = protocol.version, .server_pid = c.getpid(), .revision = s.runtime.revision, .surface = surface });
        }
        return true;
    }

    fn request(s: *Server, cl: *Client, v: std.json.Value) !void {
        if (v != .object) return error.UnknownOperation;
        const operation = agents.str(v, "op");
        if (eq(operation, "server.reload")) {
            try protocol.require(v, cl.protocol_version);
            if (s.reload_executable != null) return error.ReloadInProgress;
            const executable = agents.str(v, "executable");
            if (!std.fs.path.isAbsolute(executable)) return error.InvalidExecutable;
            s.reload_executable = try a.dupe(u8, executable);
            s.reload_requester = cl.fd;
            return;
        }
        if (eq(operation, "recovery.save")) {
            try protocol.require(v, cl.protocol_version);
            try @import("recovery.zig").save(&s.runtime, s.socket);
            const path = try @import("recovery.zig").path(s.socket);
            defer a.free(path);
            try cl.queue(.{ .ok = true, .path = path });
            return;
        }
        if (eq(operation, "session.command")) {
            try protocol.require(v, cl.protocol_version);
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            const parsed = try std.json.parseFromValue(@import("session.zig").Command, arena.allocator(), v.object.get("command") orelse return error.MissingOperation, .{});
            const result = try s.execute(parsed.value, arena.allocator());
            try cl.queue(.{ .ok = true, .result = result });
            return;
        }
        if (try @import("viewer_protocol.zig").handle(s, cl, v)) return;
        if (try @import("viewer_protocol.zig").routeControl(s, cl, v)) return;
        if (eq(operation, "session.locate")) {
            try protocol.require(v, cl.protocol_version);
            try cl.queue(.{ .ok = true, .result = try @import("session.zig").location(&s.runtime, try protocol.id(v, "pane")) });
            return;
        }
        if (eq(operation, "session.list")) {
            try protocol.require(v, cl.protocol_version);
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            try cl.queue(.{ .ok = true, .result = try protocol.snapshot(arena.allocator(), &s.runtime), .viewers = try @import("viewer_protocol.zig").viewers(s, arena.allocator()) });
            return;
        }
        if (try s.runtimeRequest(cl, v)) return;
        const op = operation;
        if (eq(op, "native.start")) {
            if (s.runtime.sessions.items.len >= 16) return error.TooManyNativeSessions;
            const provider = std.meta.stringToEnum(agents.Provider, agents.str(v, "provider")) orelse return error.BadProvider;
            const cwd = agents.str(v, "cwd");
            try s.runtime.sessions.ensureUnusedCapacity(a, 1);
            const ws = if (v.object.get("workspace") != null) try s.runtime.getWorkspace(try protocol.id(v, "workspace")) else try s.onlyWorkspace();
            var session = try native.Session.start(s.runtime.next_session, provider, if (cwd.len > 0) cwd else ws.cwd);
            session.workspace_id = ws.id;
            s.runtime.sessions.appendAssumeCapacity(session);
            s.runtime.next_session += 1;
            s.dirty = true;
            try cl.queue(.{ .ok = true, .session = session.id, .provider = provider });
        } else if (eq(op, "native.list")) {
            const Info = struct { id: u32, pid: i32, session_id: []const u8, provider: agents.Provider, ready: bool, exited: bool, state: agents.State, attention: agents.Attention, observation: agents.observation.State, unread: bool, pending_requests: usize, active_tools: usize, next_seq: u64 };
            var info: std.ArrayList(Info) = .empty;
            defer info.deinit(a);
            for (s.runtime.sessions.items) |session| try info.append(a, .{ .id = session.id, .pid = session.child.id, .session_id = session.resume_hint.session[0..session.resume_hint.len], .provider = session.provider, .ready = session.ready, .exited = session.exited, .state = session.state, .attention = session.attention, .observation = session.observation, .unread = session.observation.unread(), .pending_requests = session.approvals.items.len, .active_tools = session.active_tools.items.len, .next_seq = session.next_seq });
            try cl.queue(.{ .ok = true, .sessions = info.items });
        } else if (std.mem.startsWith(u8, op, "native.")) {
            const id = std.math.cast(u32, number(v, "session", 0)) orelse return error.NoNativeSession;
            for (s.runtime.sessions.items, 0..) |*session, index| if (session.id == id) {
                s.dirty = true;
                if (eq(op, "native.stop")) {
                    session.destroy();
                    _ = s.runtime.sessions.orderedRemove(index);
                    try cl.queue(.{ .ok = true });
                } else if (eq(op, "native.send")) {
                    try session.send(v.object.get("message") orelse return error.InvalidMessage);
                    try cl.queue(.{ .ok = true });
                } else if (eq(op, "native.events")) {
                    const after = std.math.cast(u64, number(v, "after", 0)) orelse 0;
                    var events: std.ArrayList(native.Event) = .empty;
                    defer events.deinit(a);
                    for (session.events.items) |event| if (event.seq > after) try events.append(a, event);
                    try cl.queue(.{ .ok = true, .events = events.items, .pending_requests = session.approvals.items, .next_seq = session.next_seq, .first_seq = if (session.events.items.len > 0) session.events.items[0].seq else session.next_seq });
                    session.observation.acknowledge(session.observation.completed);
                    session.attention = .none;
                } else return error.UnknownOperation;
                return;
            };
            return error.NoNativeSession;
        } else if (eq(op, "theme")) {
            if (!cl.viewer) return error.NotAttached;
            for (s.clients.items) |viewer| if (viewer.viewer and !viewer.dead) {
                if (viewer.fd == cl.fd) s.updateTheme(v);
                break;
            };
            if (cl.viewer) try cl.queue(.{ .ok = true });
        } else if (eq(op, "hook")) {
            const p = s.pane(try protocol.id(v, "pane")) orelse return error.NoPane;
            const provider = std.meta.stringToEnum(agents.Provider, agents.str(v, "provider")) orelse return error.BadProvider;
            const event = v.object.get("event") orelse return error.NoEvent;
            // Bind a newly launched foreground process before applying its
            // first hook, including back-to-back launches in the same pane.
            s.detectPane(p);
            const viewed = s.paneWatched(p.id);
            const ding = p.agent.apply(provider, event, number(v, "seq", std.time.microTimestamp()), viewed);
            if (ding) {
                s.bell = true;
                if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
            }
            s.dirty = true;
            try cl.queue(.{ .ok = true });
        } else if (eq(op, "ping")) try cl.queue(.{ .ok = true, .version = "0.1.0" }) else if (eq(op, "shutdown")) {
            s.quit = true;
            try cl.queue(.{ .ok = true });
        } else return error.UnknownOperation;
    }
    pub fn updateTheme(s: *Server, v: std.json.Value) void {
        const value = v.object.get("theme") orelse return;
        s.theme.merge(Theme.fromJson(value));
        for (s.runtime.panes.items) |p| p.terminal.applyTheme(s.theme);
        s.dirty = true;
    }
    fn detectPane(s: *Server, p: *Pane) void {
        const detection = @import("detection.zig");
        const job = detection.foreground(p.terminal.fd);
        const before = p.agent;
        const previous_pid = p.detection.pid;
        // A disconnected observer must not permanently suppress the
        // existing screen fallback with an old authoritative timestamp.
        if (p.agent.provider == .codex and p.agent.observation.source == .protocol and std.time.microTimestamp() - p.agent.last_seq > 5 * std.time.us_per_s) {
            p.agent.last_seq = 0;
            p.agent.observation.source = .unknown;
        }
        p.resume_hint.observe(&p.agent);
        const live_screen = p.terminal.emulator().*.screens.active.pages.viewport == .active;
        const text = if (job != null and p.agent.last_seq == 0 and live_screen) p.terminal.text() catch null else null;
        defer if (text) |bytes| a.free(bytes);
        const watched = s.paneWatched(p.id);
        const ding = p.detection.update(&p.agent, job, p.terminal.emulator().*.getTitle() orelse "", text orelse "", watched);
        if (job) |foreground| if (foreground.pid != previous_pid and p.agent.session_len == 0) {
            p.resume_hint = .{ .provider = foreground.provider };
        };
        p.resume_hint.observe(&p.agent);
        // A quiet agent can change directory without writing to the PTY.
        const previous_cwd = std.hash.Wyhash.hash(0, p.cwd);
        p.refreshCwd();
        if (previous_cwd != std.hash.Wyhash.hash(0, p.cwd)) s.dirty = true;
        if (!std.meta.eql(before, p.agent)) s.dirty = true;
        if (ding) {
            s.bell = true;
            if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
        }
    }
    pub fn run(s: *Server) !void {
        const observer = try @import("transcript.zig").Worker.start();
        defer observer.stop();
        const usage_worker = @import("usage_worker.zig");
        const usage = try usage_worker.Worker.start();
        defer usage.stop();
        const codex_observer = @import("codex_observer.zig");
        const summaries = try @import("activity_worker.zig").Worker.start();
        defer summaries.stop();
        const codex = try codex_observer.Worker.start();
        defer codex.stop();
        _ = c.signal(c.SIGPIPE, os.sig_ignore);
        const fd = s.inherited_listener orelse try os.listen(s.socket);
        defer {
            _ = c.close(fd);
            std.fs.cwd().deleteFile(s.socket) catch {};
        }
        defer s.runtime.deinit();
        const state_path = try workspace.Store.statePath(s.socket);
        defer a.free(state_path);
        if (s.inherited_listener != null) {
            // Imported state and sockets are ready before ownership commits.
        } else if (try @import("recovery.zig").load(&s.runtime, s.socket, s.executable)) {
            var preferences: workspace.Store = .{};
            defer preferences.deinit();
            s.preferred_workspace = (preferences.load(state_path) catch null) orelse 0;
            s.default_folder_pending = false;
        } else if (try s.runtime.workspaces.load(state_path)) |selected| {
            s.preferred_workspace = selected;
            s.default_folder_pending = false;
        } else {
            _ = try s.runtime.workspaces.add("", ".");
            try s.runtime.workspaces.save(state_path, s.initialWorkspace().id);
        }
        if (s.inherited_listener == null) for ([_][]const u8{ "codex", "claude" }) |provider| {
            @import("integration.zig").install(provider) catch |err| {
                std.log.warn("{s} hook setup: {s}; using automatic detection", .{ provider, @errorName(err) });
                var msg: [180]u8 = undefined;
                s.notice(std.fmt.bufPrint(&msg, "{s} hooks: {s}; automatic detection is active", .{ provider, @errorName(err) }) catch "Hook setup failed; automatic detection is active");
            };
        };
        defer {
            for (s.clients.items) |*cl| cl.deinit();
            s.clients.deinit(a);
        }
        while (!s.quit) {
            var polls: [1 + layout.max_panes + 32]c.struct_pollfd = undefined;
            var count: usize = 1;
            polls[0] = .{ .fd = fd, .events = c.POLLIN, .revents = 0 };
            for (s.runtime.panes.items) |p| {
                polls[count] = .{ .fd = if (p.terminal.exited) -1 else p.terminal.fd, .events = @intCast(c.POLLIN | (if (p.terminal.pending.items.len > 0) c.POLLOUT else 0)), .revents = 0 };
                count += 1;
            }
            for (s.clients.items) |cl| {
                polls[count] = .{ .fd = cl.fd, .events = @intCast(c.POLLIN | (if (cl.output.items.len > cl.sent) c.POLLOUT else 0)), .revents = 0 };
                count += 1;
            }
            _ = c.poll(&polls, @intCast(count), 16);
            // Read every live PTY, even when its tab is hidden. Only visible output dirties the frame.
            for (s.runtime.panes.items, 0..) |*p, i| {
                p.terminal.refreshRedraw(std.time.milliTimestamp());
                if (polls[i + 1].revents != 0) p.refreshCwd();
                p.terminal.flush();
                if (p.terminal.read()) {
                    s.runtime.changed();
                    if (!p.terminal.vt.modes.get(.synchronized_output)) s.dirty = true;
                }
            }
            const now = std.time.milliTimestamp();
            if (now - s.last_detection >= 250) {
                s.last_detection = now;
                for (s.runtime.panes.items) |*p| if (!p.terminal.exited) s.detectPane(p);
                codex.reconcile(s.runtime.panes.items);
                var snapshots: [layout.max_panes]?codex_observer.Snapshot = undefined;
                codex.take(&snapshots);
                for (snapshots) |entry| if (entry) |snap| {
                    if (s.pane(snap.request.pane)) |p| {
                        const prefix = codex_observer.titlePrefix(p.terminal.vt.getTitle() orelse "") orelse continue;
                        if (p.terminal.exited or p.agent.provider != .codex or p.detection.missing != 0 or p.detection.pid != snap.request.pid or p.terminal.title_pid != snap.request.pid or !eq(prefix.text(), snap.request.prefix.text())) continue;
                        if (codex_observer.apply(&p.agent, snap, s.paneWatched(p.id))) {
                            s.bell = true;
                            if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
                        }
                        summaries.submit(p.id, &p.agent, snap.evidence);
                        p.resume_hint.observe(&p.agent);
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                summaries.reconcile(s.runtime.panes.items);
                var summary_results: [layout.max_panes]?@import("activity_worker.zig").Result = undefined;
                summaries.take(&summary_results);
                for (summary_results) |entry| if (entry) |result| {
                    if (s.pane(result.request.pane)) |p| if (!p.terminal.exited and result.apply(&p.agent)) {
                        s.dirty = true;
                        s.runtime.changed();
                    };
                };
                s.followWorkspaceDirectories();
                for (s.runtime.workspaces.items.items) |ws| if (s.workspaceWatched(ws.id)) s.visitWorkspace(ws.id);
                usage.reconcile(&s.runtime);
                var activity: [layout.max_panes]?usage_worker.Result = undefined;
                usage.take(&activity);
                for (activity) |entry| if (entry) |result| {
                    const p = s.pane(result.pane) orelse continue;
                    if (!eq(p.agent.sessionId(), result.session[0..result.session_len])) continue;
                    if (!p.terminal.exited) if (result.progress) |progress| summaries.tools(p.id, &p.agent, progress);
                    const ws = s.runtime.workspaces.owner(p.id) orelse continue;
                    if (ws.id != result.workspace or s.workspaceWatched(ws.id)) continue;
                    if (ws.away.record(result.since, result.delta)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                observer.reconcile(s.runtime.panes.items);
                var completions: [layout.max_panes]?@import("transcript.zig").Result = undefined;
                observer.take(&completions);
                for (completions) |entry| if (entry) |result| {
                    if (s.pane(result.pane)) |p| {
                        const was_pending = p.agent.observation.pending_stop;
                        const ding = p.agent.confirm(result.seq, result.outcome);
                        if (was_pending and !p.agent.observation.pending_stop) {
                            s.runtime.changed();
                            s.dirty = true;
                        }
                        if (ding and !s.paneWatched(p.id)) {
                            s.bell = true;
                            if (s.bell_kind != .needs_input) s.bell_kind = .finished;
                        }
                    }
                };
            }
            for (s.runtime.sessions.items) |*session| {
                const old_seq = session.next_seq;
                const old_state = session.state;
                const old_ready = session.ready;
                const old_attention = session.attention;
                const old_tool = session.toolActive();
                const ding = session.poll() catch |err| blk: {
                    s.notice(@errorName(err));
                    _ = c.kill(-session.child.id, c.SIGTERM);
                    break :blk false;
                };
                if (s.runtime.workspaces.index(session.workspace_id)) |index| {
                    const ws = &s.runtime.workspaces.items.items[index];
                    if (s.workspaceWatched(ws.id)) s.visitWorkspace(ws.id) else if (ws.away.record(ws.away.since, session.usage_pending)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                }
                session.usage_pending = .{};
                if (old_seq != session.next_seq) s.runtime.changed();
                if (session.state != old_state or session.ready != old_ready or session.attention != old_attention or session.toolActive() != old_tool) s.dirty = true;
                if (ding) {
                    s.bell = true;
                    if (s.bell_kind != .needs_input) s.bell_kind = session.attention;
                    var msg: [160]u8 = undefined;
                    s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}  |  corgi native events {d}", .{ @tagName(session.provider), session.id, @tagName(session.state), session.id }));
                }
            }
            // Reap closed panes too, forwarding Git exits to its worker.
            @import("git_status.zig").child_mutex.lock();
            while (true) {
                var status: c_int = 0;
                const pid = c.waitpid(-1, &status, c.WNOHANG);
                if (pid <= 0) break;
                @import("git_status.zig").recordExit(pid, status);
                @import("summary_backend.zig").recordExit(pid, status);
                @import("ports.zig").recordExit(pid, status);
                for (s.runtime.panes.items) |*p| if (p.terminal.pid == pid) {
                    p.terminal.exited = true;
                    p.terminal.exit_status = status;
                    s.dirty = true;
                };
                for (s.runtime.sessions.items) |*session| if (session.child.id == pid) {
                    session.markExited();
                    s.dirty = true;
                };
            }
            @import("git_status.zig").child_mutex.unlock();
            // Both Terminal.read and the general child reaper can detect exit.
            // Remove in a separate pass so adjacent exits aren't skipped.
            var pi: usize = 0;
            while (pi < s.runtime.panes.items.len) {
                if (s.runtime.panes.items[pi].terminal.exited) {
                    try s.close(s.runtime.panes.items[pi].id);
                } else pi += 1;
            }
            var ci: usize = 0;
            while (ci < s.clients.items.len) {
                const cl = &s.clients.items[ci];
                var bytes: [16384]u8 = undefined;
                const n = c.read(cl.fd, &bytes, bytes.len);
                if (n == 0) cl.dead = true;
                if (n > 0) {
                    cl.touched = std.time.milliTimestamp();
                    try cl.input.appendSlice(a, bytes[0..@intCast(n)]);
                    if (cl.input.items.len > 1024 * 1024) cl.dead = true;
                }
                if (cl.input.items.len > 0) {
                    var consumed: usize = 0;
                    while (!cl.dead) {
                        const newline = std.mem.indexOfScalarPos(u8, cl.input.items, consumed, '\n') orelse break;
                        const parsed = std.json.parseFromSlice(std.json.Value, a, cl.input.items[consumed..newline], .{ .max_value_len = 1024 * 1024 }) catch {
                            try cl.queue(.{ .ok = false, .err = "InvalidJson" });
                            consumed = newline + 1;
                            continue;
                        };
                        defer parsed.deinit();
                        s.request(cl, parsed.value) catch |err| {
                            try cl.queue(.{ .ok = false, .err = @errorName(err) });
                        };
                        consumed = newline + 1;
                        if (s.reload_executable != null and s.reload_requester == cl.fd) break;
                    }
                    std.mem.copyForwards(u8, cl.input.items[0 .. cl.input.items.len - consumed], cl.input.items[consumed..]);
                    cl.input.items.len -= consumed;
                }
                if (!cl.viewer and !cl.subscribed and std.time.milliTimestamp() - cl.touched > 5000) cl.dead = true;
                if (cl.dead) {
                    cl.deinit();
                    _ = s.clients.orderedRemove(ci);
                    try @import("viewer_protocol.zig").resize(s);
                    continue;
                }
                ci += 1;
            }
            s.followWorkspaceDirectories();
            if (s.runtime.git_status.tick(&s.runtime.workspaces)) s.dirty = true;
            if (s.runtime.ports.tick(&s.runtime)) s.dirty = true;
            if (s.dirty) {
                s.runtime.changed();
                s.dirty = false;
            }
            if (s.bell and s.bell_kind == .finished) {
                var unread = false;
                for (s.runtime.panes.items) |p| unread = unread or p.agent.observation.unread();
                for (s.runtime.sessions.items) |session| unread = unread or session.attention == .finished;
                if (!unread) {
                    s.bell = false;
                    s.bell_kind = .none;
                }
            }
            if (s.bell and std.time.milliTimestamp() - s.last_bell > 1500) {
                s.bell_seq +%= 1;
                s.last_bell_kind = s.bell_kind;
                s.bell = false;
                s.bell_kind = .none;
                s.last_bell = std.time.milliTimestamp();
            }
            for (s.clients.items) |*cl| {
                if (cl.subscribed and !cl.dead and cl.output.items.len == 0 and
                    cl.snapshot_revision != s.runtime.revision and std.time.milliTimestamp() - cl.last_snapshot >= 30)
                {
                    try s.queueSession(cl);
                }
            }
            for (s.clients.items) |*cl| {
                if (cl.sent < cl.output.items.len) {
                    const pending = cl.output.items[cl.sent..];
                    const written = c.write(cl.fd, pending.ptr, pending.len);
                    if (written > 0) cl.sent += @intCast(written) else if (written < 0 and std.posix.errno(written) != .AGAIN and std.posix.errno(written) != .INTR) cl.dead = true;
                    if (cl.sent == cl.output.items.len) {
                        cl.output.clearRetainingCapacity();
                        cl.sent = 0;
                    }
                }
            }
            if (polls[0].revents & c.POLLIN != 0) {
                const client_fd = c.accept(fd, null, null);
                if (client_fd >= 0) {
                    if (s.clients.items.len == 32) _ = c.close(client_fd) else {
                        os.nonblock(client_fd);
                        os.cloexec(client_fd);
                        try s.clients.append(a, .{ .fd = client_fd, .touched = std.time.milliTimestamp() });
                    }
                }
            }
            if (!s.quit) if (s.reload_executable) |executable| {
                @import("handoff.zig").replace(s, fd, executable, s.reload_requester) catch |err| {
                    for (s.clients.items) |*cl| if (cl.fd == s.reload_requester) try cl.queue(.{ .ok = false, .err = @errorName(err) });
                    a.free(executable);
                    s.reload_executable = null;
                    s.notice(@errorName(err));
                };
            };
            if ((now - s.last_recovery >= 2000 and s.saved_revision != s.runtime.revision) or s.quit) {
                s.last_recovery = now;
                @import("recovery.zig").save(&s.runtime, s.socket) catch |err| {
                    std.log.err("saving recovery: {s}", .{@errorName(err)});
                    s.notice(" Could not save recovery snapshot; see server.log");
                    continue;
                };
                s.saved_revision = s.runtime.revision;
            }
        }
    }
};
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
fn number(v: std.json.Value, key: []const u8, default: i64) i64 {
    if (v != .object) return default;
    const n = v.object.get(key) orelse return default;
    return if (n == .integer) n.integer else default;
}
