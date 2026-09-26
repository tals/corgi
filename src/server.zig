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
    command_previews: ?*@import("launch_command.zig").Worker = null,
    launch_previews: ?*@import("agent_launcher.zig").Worker = null,
    onboarding_copy: @import("onboarding_import.zig").Job = .{},
    herdr_import: @import("herdr_adapter.zig").Manager = .{},
    handoff_operation: u64 = 0,
    summaries: ?*@import("activity_worker.zig").Worker = null,
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
    next_active: u64 = 0,
    last_bell_kind: agents.Attention = .none,
    last_detection: i64 = 0,
    last_update_check: i64 = 0,
    staged_buf: [64]u8 = undefined,
    inherited_listener: ?c_int = null,
    reload_executable: ?[]const u8 = null,
    reload_requester: c_int = -1,
    last_recovery: i64 = 0,
    saved_revision: u64 = 0,
    fn publishInference(s: *Server) void {
        const worker = s.summaries orelse return;
        const status = worker.status();
        if (std.meta.eql(s.runtime.inference, status)) return;
        s.runtime.inference = status;
        s.runtime.system_model = status.model;
        s.runtime.changed();
        s.dirty = true;
    }
    pub fn initialWorkspace(s: *Server) *workspace.Workspace {
        return s.runtime.workspaces.get(s.preferred_workspace) orelse &s.runtime.workspaces.items.items[0];
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
    fn codexActor(s: *Server, snap: @import("codex_observer.zig").Snapshot) !?*@import("conversations.zig").Actor {
        const codex_observer = @import("codex_observer.zig");
        return if (snap.request.actor != 0)
            s.runtime.conversations.byId(snap.request.actor) orelse return null
        else blk: {
            const p = s.pane(snap.request.pane) orelse return null;
            const prefix = codex_observer.titlePrefix(p.terminal.vt.getTitle() orelse "") orelse return null;
            if (p.terminal.exited or p.detection.missing != 0 or p.detection.pid != snap.request.pid or
                p.terminal.title_pid != snap.request.pid or p.terminal.title_revision != snap.request.title_revision or
                p.attachment.generation != snap.request.generation or !eq(prefix.text(), snap.request.prefix.text())) return null;
            const selected = try s.runtime.conversations.get(.codex, &snap.session);
            p.attachment.select(selected);
            if (selected.workspace == 0 or s.runtime.workspaces.index(selected.workspace) == null) {
                if (s.runtime.workspaces.owner(p.id)) |ws| selected.workspace = ws.id;
            }
            break :blk selected;
        };
    }
    fn pane(s: *Server, id: layout.Id) ?*Pane {
        return s.runtime.pane(id);
    }
    pub fn notice(_: *Server, msg: []const u8) void {
        std.log.info("{s}", .{msg});
    }
    /// All shared commands have one execution and post-commit path.
    pub fn execute(s: *Server, command: @import("session.zig").Command, allocator: std.mem.Allocator) !@import("session.zig").Result {
        if (s.herdr_import.locked() or s.onboarding_copy.busy()) return error.ImportInProgress;
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

    fn publishLaunchPreview(s: *Server, cl: *Client) !void {
        const subscription = if (cl.launch_preview) |*value| value else return;
        const worker = s.launch_previews orelse return;
        const now = std.time.milliTimestamp();
        if (cl.dead or cl.output.items.len != 0 or now - subscription.checked < 100) return;
        subscription.checked = now;
        const cwd = subscription.cwd[0..subscription.len];
        var preview = worker.preview(cwd);
        // A replacement daemon starts with an empty worker cache. Keep the
        // subscriber's last values visible until the fresh read completes.
        if (preview.pending) {
            preview = subscription.preview;
            preview.pending = true;
        }
        if (std.meta.eql(preview, subscription.preview)) return;
        try cl.queue(.{ .type = "agent.preview", .cwd = cwd, .preview = preview });
        subscription.preview = preview;
    }

    fn runtimeRequest(s: *Server, cl: *Client, v: std.json.Value) !bool {
        const op = agents.str(v, "op");
        if (eq(op, "hello")) {
            try protocol.require(v, null);
            cl.protocol_version = protocol.version;
            try cl.queue(.{ .type = "hello", .protocol = protocol.version, .capabilities = protocol.capabilities, .server_pid = c.getpid(), .build_id = &@import("main.zig").build_id, .executable = s.executable, .release_version = @import("corgi_options").release_version, .update_abi = @import("updates.zig").abi });
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
            if (eq(op, "session.subscribe") and (cl.viewer or cl.launch_preview != null)) return error.AlreadyAttached;
            try s.queueSession(cl);
            if (eq(op, "session.subscribe")) cl.subscribed = true;
        } else if (eq(op, "conversation.list")) {
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            const snapshot = try protocol.snapshot(arena.allocator(), &s.runtime);
            try cl.queue(.{ .ok = true, .conversations = snapshot.conversations });
        } else if (eq(op, "conversation.acknowledge")) {
            const actor = s.runtime.conversations.byId(try protocol.id(v, "conversation")) orelse return error.NoConversation;
            const through = v.object.get("through") orelse return error.InvalidAcknowledgement;
            if (through != .integer or through.integer < 0) return error.InvalidAcknowledgement;
            const stamp = v.object.get("attention_at");
            actor.acknowledge(@intCast(through.integer), if (stamp != null and stamp.? == .integer) stamp.?.integer else null);
            s.runtime.changed();
            s.dirty = true;
            try cl.queue(.{ .ok = true });
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
        if (eq(operation, "git.push")) {
            try protocol.require(v, cl.protocol_version);
            if (s.reload_executable != null) return error.ReloadInProgress;
            const Request = struct { workspace: u32, ref: @import("git_push.zig").RefView };
            const parsed = try std.json.parseFromValue(Request, a, v, .{ .ignore_unknown_fields = true });
            defer parsed.deinit();
            try s.runtime.git_push.start(&s.runtime.workspaces, parsed.value.workspace, parsed.value.ref);
            s.dirty = true;
            try cl.queue(.{ .ok = true });
            return;
        }
        if (std.mem.startsWith(u8, operation, "onboarding.")) {
            try protocol.require(v, cl.protocol_version);
            const operation_value = v.object.get("operation") orelse return error.InvalidImport;
            if (operation_value != .integer or operation_value.integer < 0) return error.InvalidImport;
            const id: u64 = @intCast(operation_value.integer);
            if (eq(operation, "onboarding.status")) {
                if (id == s.handoff_operation and id != 0) {
                    const status = s.herdr_import.status();
                    try cl.queue(.{ .ok = true, .progress = .{ .phase = @tagName(status.phase), .completed = status.completed, .total = status.total, .workspace = status.workspace, .message = status.message } });
                } else if (id == s.onboarding_copy.operation and id != 0) {
                    try cl.queue(.{ .ok = true, .progress = s.onboarding_copy.progress });
                } else return error.NoImport;
                return;
            }
            if (id == 0) return error.InvalidImport;
            // Retrying an acknowledged/lost start response must not duplicate work.
            if ((eq(operation, "onboarding.handoff") and id == s.handoff_operation) or (eq(operation, "onboarding.copy") and id == s.onboarding_copy.operation)) {
                try cl.queue(.{ .ok = true });
                return;
            }
            if (s.reload_executable != null or s.herdr_import.busy() or s.onboarding_copy.busy()) return error.ImportInProgress;
            if (eq(operation, "onboarding.handoff")) {
                const pgid = try protocol.id(v, "viewer_pgid");
                if (pgid > std.math.maxInt(i32)) return error.InvalidImport;
                try s.herdr_import.start(agents.str(v, "socket"), s.executable, s.theme, @intCast(pgid));
                s.handoff_operation = id;
            } else if (eq(operation, "onboarding.copy")) {
                try s.onboarding_copy.start(v, id);
            } else return error.UnknownOperation;
            try cl.queue(.{ .ok = true });
            return;
        }
        if (eq(operation, "server.reload")) {
            try protocol.require(v, cl.protocol_version);
            if (s.herdr_import.busy() or s.onboarding_copy.busy()) return error.ImportInProgress;
            if (s.reload_executable != null) return error.ReloadInProgress;
            if (s.runtime.git_push.busy()) return error.GitPushInProgress;
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
        if (eq(operation, "agent.command.preview")) {
            try protocol.require(v, cl.protocol_version);
            const ws = try s.runtime.getWorkspace(try protocol.id(v, "workspace"));
            const requested = agents.str(v, "cwd");
            const cwd = if (requested.len > 0) requested else ws.cwd;
            if (!std.fs.path.isAbsolute(cwd)) return error.InvalidDirectory;
            const id = try protocol.id(v, "request");
            const worker = s.command_previews orelse return error.Unavailable;
            try cl.queue(.{ .ok = true, .resolution = try worker.request(id, agents.str(v, "command"), cwd) });
            return;
        }
        if (eq(operation, "agent.preview") or eq(operation, "agent.track_usage") or eq(operation, "agent.subscribe")) {
            try protocol.require(v, cl.protocol_version);
            const subscribe = eq(operation, "agent.subscribe");
            if (subscribe and (cl.viewer or cl.subscribed)) return error.AlreadyAttached;
            const ws = try s.runtime.getWorkspace(try protocol.id(v, "workspace"));
            const requested = agents.str(v, "cwd");
            const cwd = if (requested.len > 0) requested else ws.cwd;
            if (!std.fs.path.isAbsolute(cwd) or cwd.len > std.fs.max_path_bytes) return error.InvalidDirectory;
            const preview = if (s.launch_previews) |worker| (if (eq(operation, "agent.track_usage")) worker.trackUsage(cwd) else worker.preview(cwd)) else @import("agent_launcher.zig").Preview{};
            if (subscribe) {
                cl.launch_preview = .{ .len = cwd.len, .preview = preview, .checked = std.time.milliTimestamp() };
                @memcpy(cl.launch_preview.?.cwd[0..cwd.len], cwd);
                try cl.queue(.{ .type = "agent.preview", .cwd = cwd, .preview = preview });
            } else try cl.queue(.{ .ok = true, .preview = preview });
            return;
        }
        if (eq(operation, "inference.configure")) {
            try protocol.require(v, cl.protocol_version);
            const setup = @import("inference_setup.zig");
            const choice = std.meta.stringToEnum(setup.Choice, agents.str(v, "choice")) orelse return error.BadProvider;
            const worker = s.summaries orelse return error.InferenceUnavailable;
            worker.configure(choice);
            const saved = if (setup.path(s.socket)) |file| blk: {
                defer a.free(file);
                setup.save(file, choice) catch break :blk false;
                break :blk true;
            } else |_| false;
            s.publishInference();
            try cl.queue(.{ .ok = true, .saved = saved, .inference = s.runtime.inference });
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
            for (s.runtime.sessions.items) |session| try info.append(a, .{ .id = session.id, .pid = session.child.id, .session_id = session.resume_hint.session[0..session.resume_hint.len], .provider = session.provider, .ready = session.ready, .exited = session.exited, .state = session.status(), .attention = session.attention(), .observation = session.observation(), .unread = session.observation().unread(), .pending_requests = session.approvals.items.len, .active_tools = session.active_tools.items.len, .next_seq = session.next_seq });
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
                    try session.send(&s.runtime.conversations, v.object.get("message") orelse return error.InvalidMessage);
                    try cl.queue(.{ .ok = true });
                } else if (eq(op, "native.events")) {
                    const after = std.math.cast(u64, number(v, "after", 0)) orelse 0;
                    var events: std.ArrayList(native.Event) = .empty;
                    defer events.deinit(a);
                    for (session.events.items) |event| if (event.seq > after) try events.append(a, event);
                    const requests = try session.approvalLines(a);
                    defer a.free(requests);
                    try cl.queue(.{ .ok = true, .events = events.items, .pending_requests = requests, .next_seq = session.next_seq, .first_seq = if (session.events.items.len > 0) session.events.items[0].seq else session.next_seq });
                    session.acknowledge();
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
            const provider = std.meta.stringToEnum(agents.Provider, agents.str(v, "provider")) orelse return error.BadProvider;
            const event = v.object.get("event") orelse return error.NoEvent;
            const hook = agents.providers.Backend.init(provider).hook(event);
            const background = if (v.object.get("background")) |value| value == .bool and value.bool else false;
            if (background) {
                // A daemon-hosted session only updates a conversation some pane
                // already follows (see continued-in handling); it never selects.
                if (hook) |h| if (s.runtime.conversations.find(provider, h.session)) |actor| {
                    const now = std.time.microTimestamp();
                    const ding = actor.observeHook(h, number(v, "seq", now), s.actorWatched(actor.id), now);
                    s.attention(ding, actor.state.state);
                    s.runtime.changed();
                    s.dirty = true;
                };
                try cl.queue(.{ .ok = true });
                return;
            }
            const p = s.pane(try protocol.id(v, "pane")) orelse return error.NoPane;
            // Bind a newly launched foreground process before applying its
            // first hook, including back-to-back launches in the same pane.
            s.detectPane(p);
            const seq = number(v, "seq", std.time.microTimestamp());
            if (seq > p.attachment.hook_seq and hook != null) if (try s.runtime.conversations.routeHook(&p.attachment, provider, hook.?)) |actor| {
                p.attachment.hook_seq = seq;
                if (hook.?.kind == .session_start and provider != .other) s.runtime.last_agent = if (provider == .codex) .codex else .claude;
                if (actor.workspace == 0 or s.runtime.workspaces.index(actor.workspace) == null) {
                    if (s.runtime.workspaces.owner(p.id)) |ws| actor.workspace = ws.id;
                }
                const now = std.time.microTimestamp();
                const ding = actor.observeHook(hook.?, seq, s.actorWatched(actor.id), now);
                s.attention(ding, actor.state.state);
                s.runtime.changed();
                s.dirty = true;
            };
            try cl.queue(.{ .ok = true });
        } else if (eq(op, "ping")) try cl.queue(.{ .ok = true, .version = "0.1.0" }) else if (eq(op, "shutdown")) {
            if (s.herdr_import.busy() or s.onboarding_copy.busy()) return error.ImportInProgress;
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
    /// Backgrounding a Claude conversation continues it under a new session in
    /// Claude's daemon while the pane's client keeps showing it. Its hooks
    /// cannot name that pane, so panes follow the transcript's continued-in.
    fn followContinuation(s: *Server, old: *@import("conversations.zig").Actor, session: []const u8) void {
        if (old.state.provider != .claude or eq(session, old.state.sessionId())) return;
        var followed = false;
        for (s.runtime.panes.items) |*p| {
            if (p.attachment.actor != old) continue;
            const next = s.runtime.conversations.get(.claude, session) catch return;
            if (next.workspace == 0) next.workspace = old.workspace;
            if (next.state.last_seq == 0) {
                // The continuation is usually mid-turn; hooks refine it later.
                next.state.state = if (old.state.state == .done) .idle else old.state.state;
                next.state.cwd = old.state.cwd;
                next.state.cwd_len = old.state.cwd_len;
                const dir = std.fs.path.dirname(old.state.transcriptPath()) orelse "";
                var path: [std.fs.max_path_bytes]u8 = undefined;
                if (dir.len > 0) if (std.fmt.bufPrint(&path, "{s}/{s}.jsonl", .{ dir, session })) |value| {
                    @memcpy(next.state.transcript[0..value.len], value);
                    next.state.transcript_len = value.len;
                } else |_| {};
            }
            p.attachment.select(next);
            followed = true;
        }
        if (!followed) return;
        old.state.state = .done;
        old.state.tool_active = false;
        s.runtime.changed();
        s.dirty = true;
    }
    fn actorWatched(s: *Server, actor: u32) bool {
        for (s.runtime.panes.items) |p| if (p.attachment.actor) |selected| {
            if (selected.id == actor and !p.terminal.exited and s.paneWatched(p.id)) return true;
        };
        return false;
    }
    fn attention(s: *Server, ding: bool, state: agents.State) void {
        if (!ding) return;
        s.bell = true;
        if (s.bell_kind != .needs_input) s.bell_kind = if (state == .blocked) .needs_input else .finished;
    }
    // Resuming a known conversation need not emit a hook before the first
    // prompt. OSC title identity can restore its attachment without observing
    // lifecycle, resetting receipts, or waiting for the app-server transport.
    fn reattachCodex(s: *Server, p: *Pane, pid: c_int) void {
        if (p.attachment.actor != null or p.terminal.exited or pid <= 0 or p.terminal.title_pid != pid) return;
        const prefix = @import("codex_observer.zig").titlePrefix(p.terminal.vt.getTitle() orelse "") orelse return;
        var found: ?*@import("conversations.zig").Actor = null;
        for (s.runtime.conversations.items.items) |actor| {
            if (actor.state.provider != .codex or actor.state.session_len != 36 or !std.mem.startsWith(u8, actor.state.sessionId(), prefix.text())) continue;
            if (found != null) return; // A truncated UUID must resolve uniquely.
            found = actor;
        }
        if (found) |actor| {
            p.attachment.select(actor);
            if (actor.workspace == 0 or s.runtime.workspaces.index(actor.workspace) == null) {
                if (s.runtime.workspaces.owner(p.id)) |ws| actor.workspace = ws.id;
            }
        }
    }
    fn detectPane(s: *Server, p: *Pane) void {
        const detection = @import("detection.zig");
        const job = detection.foreground(p.terminal.fd);
        const before = p.agent().*;
        const old_binding = p.attachment.generation;
        const previous_pid = p.detection.pid;
        if (before.provider != p.agent().provider or !eq(before.sessionId(), p.agent().sessionId())) {
            if (p.agent().provider != .other) s.runtime.last_agent = if (p.agent().provider == .codex) .codex else .claude;
        }
        p.resume_hint.observe(p.agent());
        if (job) |current| {
            if ((previous_pid != 0 and previous_pid != current.pid) or
                (p.attachment.actor != null and p.agent().provider != current.provider))
            {
                p.attachment.detach();
                p.resume_hint = .{ .provider = current.provider };
            }
            // Title selection belongs to the attachment. Losing a known title
            // makes screen attribution unknown, not the previous actor idle.
            if (current.provider == .codex) {
                const prefix = @import("codex_observer.zig").titlePrefix(p.terminal.vt.getTitle() orelse "");
                const hash = if (prefix) |value| std.hash.Wyhash.hash(0, value.text()) else 0;
                if (hash != p.attachment.selection_hash) {
                    if (p.attachment.actor) |actor| {
                        if (prefix == null or !std.mem.startsWith(u8, actor.state.sessionId(), prefix.?.text())) p.attachment.deselect();
                    }
                    p.attachment.generation +%= 1;
                    p.attachment.selection_hash = hash;
                }
                s.reattachCodex(p, current.pid);
            }
        }
        const now = std.time.microTimestamp();
        // Detection owns only provisional screen state. It cannot reset an
        // actor when a process exits or another session occupies the pane.
        const authoritative = if (p.attachment.actor) |actor| actor.authoritative(now) else false;
        p.attachment.provisional.last_seq = if (authoritative) 1 else 0;
        const review = p.agent().permission_review != null;
        // Claude has no interrupt hook; its screen is the only sign a hook-reported turn was aborted.
        const settle = if (p.attachment.actor) |actor| authoritative and actor.state.provider == .claude and actor.state.state == .working and !actor.state.observation.pending_stop else false;
        const compaction = p.agent().provider == .codex and p.agent().state == .working;
        const text = if (job != null and (!authoritative or review or settle or compaction)) p.terminal.liveText() catch null else null;
        defer if (text) |bytes| a.free(bytes);
        var ding = p.detection.update(&p.attachment.provisional, job, p.terminal.vt.getTitle() orelse "", text orelse "", s.paneWatched(p.id));
        // Each new agent process counts once toward automatic inference selection.
        if (job) |current| if (current.pid != previous_pid and current.provider != .other) if (s.summaries) |worker| {
            worker.observeLaunch(if (current.provider == .codex) .codex else .claude);
        };
        if (previous_pid != 0 and p.detection.pid == 0) p.attachment.detach();
        if (p.attachment.actor) |actor| actor.screen(&p.attachment.provisional, ding, now);
        if (compaction and text != null) if (p.attachment.actor) |actor| actor.observeCompactionScreen(detection.screenCompacting(text.?), now);
        const settling = if (p.attachment.actor) |actor| settle and text != null and actor.state.state == .working else false;
        if (!settling) {
            p.detection.idle_since = 0;
        } else if (p.detection.interrupted(p.terminal.vt.getTitle() orelse "", text.?, now)) {
            p.attachment.actor.?.state.abandonTurn(now);
            p.detection.idle_since = 0;
            p.detection.interrupt_key_at = 0;
        }
        if (job != null and review and text != null) {
            ding = p.agent().observePermissionPrompt(detection.screenState(.codex, p.terminal.vt.getTitle() orelse "", text.?) == .blocked, s.paneWatched(p.id), now) or ding;
        }
        p.resume_hint.observe(p.agent());
        const previous_cwd = std.hash.Wyhash.hash(0, p.cwd);
        p.refreshCwd();
        if (previous_cwd != std.hash.Wyhash.hash(0, p.cwd) or !std.meta.eql(before, p.agent().*) or old_binding != p.attachment.generation) {
            s.dirty = true;
            s.runtime.changed();
        }
        s.attention(ding, p.agent().state);
    }
    pub fn run(s: *Server) !void {
        s.command_previews = try @import("launch_command.zig").Worker.start();
        defer {
            s.command_previews.?.stop();
            s.command_previews = null;
        }
        s.launch_previews = try @import("agent_launcher.zig").Worker.start();
        defer {
            s.launch_previews.?.stop();
            s.launch_previews = null;
        }
        const observer = try @import("transcript.zig").Worker.start();
        defer observer.stop();
        const usage_worker = @import("usage_worker.zig");
        const usage = try usage_worker.Worker.start();
        defer usage.stop();
        const codex_observer = @import("codex_observer.zig");
        const setup = @import("inference_setup.zig");
        const settings = setup.path(s.socket) catch null;
        const summaries = try @import("activity_worker.zig").Worker.start(setup.initial(if (settings) |file| setup.load(file) else null));
        if (settings) |file| a.free(file);
        s.summaries = summaries;
        defer {
            s.summaries = null;
            summaries.stop();
        }
        s.publishInference();
        const codex = try codex_observer.Worker.start();
        defer codex.stop();
        _ = c.signal(c.SIGPIPE, os.sig_ignore);
        const fd = s.inherited_listener orelse try os.listen(s.socket);
        defer {
            _ = c.close(fd);
            std.fs.cwd().deleteFile(s.socket) catch {};
        }
        defer s.runtime.deinit();
        defer s.herdr_import.deinit();
        defer s.onboarding_copy.deinit();
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
            if (s.herdr_import.tick(&s.runtime) or s.onboarding_copy.tick(&s.runtime, .{ .workspace = 0, .cwd = "/", .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable })) {
                s.dirty = true;
                s.saveWorkspaces();
            }
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
                codex.reconcile(&s.runtime);
                var snapshots: [layout.max_panes]?codex_observer.Snapshot = undefined;
                codex.take(&snapshots);
                for (snapshots) |entry| if (entry) |snap| {
                    defer snap.deinit();
                    const actor = try s.codexActor(snap) orelse continue;
                    const ding = actor.observeSnapshot(snap, s.actorWatched(actor.id));
                    if (actor.parent == null) s.attention(ding, actor.state.state);
                    s.runtime.conversations.observeChildren(actor, snap);
                    summaries.submit(actor, snap.evidence, s.runtime.panes.items);
                    s.dirty = true;
                    s.runtime.changed();
                };
                summaries.reconcile(s.runtime.conversations.items.items);
                summaries.remember(if (s.runtime.last_agent == .codex) .codex else .claude);
                s.publishInference();
                if (now - s.last_update_check >= 30 * std.time.ms_per_s) {
                    s.last_update_check = now;
                    var scratch: [64]u8 = undefined;
                    const found = @import("updates.zig").stagedVersion(s.executable, &scratch) orelse "";
                    if (!std.mem.eql(u8, found, s.runtime.staged_version)) {
                        @memcpy(s.staged_buf[0..found.len], found);
                        s.runtime.staged_version = s.staged_buf[0..found.len];
                        s.runtime.changed();
                        s.dirty = true;
                    }
                }
                const system_working = summaries.implementation.pool.working.load(.acquire);
                if (s.runtime.system_working != system_working) {
                    s.runtime.system_working = system_working;
                    s.runtime.changed();
                    s.dirty = true;
                }
                const system_usage = summaries.systemUsage(now);
                if (!std.meta.eql(s.runtime.system_usage, system_usage)) {
                    s.runtime.system_usage = system_usage;
                    s.runtime.changed();
                    s.dirty = true;
                }
                if (s.runtime.link_labels.reconcile(&s.runtime, summaries, now)) {
                    s.dirty = true;
                    s.runtime.changed();
                }
                var link_results: [@import("link_labels.zig").capacity]?@import("link_labels.zig").Result = undefined;
                summaries.takeLinks(&link_results);
                for (link_results) |entry| if (entry) |result| {
                    if (s.runtime.link_labels.apply(result, now)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                var summary_results: [layout.max_panes]?@import("activity_worker.zig").Result = undefined;
                summaries.take(&summary_results);
                for (summary_results) |entry| if (entry) |result| {
                    if (s.runtime.conversations.byId(result.request.actor)) |actor| if (result.apply(actor)) {
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
                    const actor = s.runtime.conversations.byId(result.actor) orelse continue;
                    if (!eq(actor.state.sessionId(), result.session[0..result.session_len])) continue;
                    if (!actor.model_from_hook and result.model.len > 0 and !std.meta.eql(actor.model, result.model)) {
                        actor.model = result.model;
                        s.dirty = true;
                        s.runtime.changed();
                    }
                    if (!actor.native_usage and !std.meta.eql(actor.live_usage, result.live)) {
                        actor.live_usage = result.live;
                        s.dirty = true;
                        s.runtime.changed();
                    }
                    if (result.continued.len > 0) s.followContinuation(actor, result.continued.bytes[0..result.continued.len]);
                    const before = actor.state;
                    if (result.progress) |progress| actor.observeTools(progress);
                    if (result.fallback(&actor.state, std.time.microTimestamp())) {
                        summaries.submit(actor, result.progress.?.commentary, s.runtime.panes.items);
                    }
                    if (!std.meta.eql(before, actor.state)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                    if (result.progress) |progress| summaries.tools(actor.id, &actor.state, progress);
                    if (actor.native_usage) continue;
                    const ws = s.runtime.workspaces.get(result.workspace) orelse continue;
                    if (actor.workspace != ws.id or s.workspaceWatched(ws.id)) continue;
                    if (ws.away.record(result.since, result.delta)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                observer.reconcile(s.runtime.conversations.items.items);
                var completions: [layout.max_panes]?@import("transcript.zig").Result = undefined;
                observer.take(&completions);
                for (completions) |entry| if (entry) |result| {
                    if (s.runtime.conversations.byId(result.actor)) |actor| {
                        const was_pending = actor.state.observation.pending_stop;
                        const ding = actor.confirmStop(result.seq, result.outcome, std.time.microTimestamp());
                        if (was_pending and !actor.state.observation.pending_stop) {
                            s.runtime.changed();
                            s.dirty = true;
                        }
                        s.attention(ding and !s.actorWatched(actor.id), actor.state.state);
                    }
                };
            }
            for (s.runtime.sessions.items) |*session| {
                const old_seq = session.next_seq;
                const old_state = session.status();
                const old_ready = session.ready;
                const old_attention = session.attention();
                const old_tool = session.toolActive();
                const ding = session.poll(&s.runtime.conversations) catch |err| blk: {
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
                if (session.status() != old_state or session.ready != old_ready or session.attention() != old_attention or session.toolActive() != old_tool) s.dirty = true;
                if (ding) {
                    s.bell = true;
                    if (s.bell_kind != .needs_input) s.bell_kind = session.attention();
                    var msg: [160]u8 = undefined;
                    s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}  |  corgi native events {d}", .{ @tagName(session.provider), session.id, @tagName(session.status()), session.id }));
                }
            }
            // Reap closed panes too, forwarding Git exits to its worker.
            @import("git_status.zig").child_mutex.lock();
            while (true) {
                var status: c_int = 0;
                const pid = c.waitpid(-1, &status, c.WNOHANG);
                if (pid <= 0) break;
                @import("git_status.zig").recordExit(pid, status);
                s.runtime.git_push.recordExit(pid, status);
                @import("inference.zig").recordExit(pid, status);
                @import("agent_launcher.zig").recordExit(pid, status);
                @import("launch_command.zig").recordExit(pid, status);
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
                if (s.runtime.panes.items[pi].terminal.exited and !s.herdr_import.locked() and !s.onboarding_copy.busy()) {
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
                if (!cl.viewer and !cl.subscribed and cl.launch_preview == null and std.time.milliTimestamp() - cl.touched > 5000) cl.dead = true;
                if (cl.dead) {
                    cl.deinit();
                    _ = s.clients.orderedRemove(ci);
                    try @import("viewer_protocol.zig").resize(s);
                    continue;
                }
                ci += 1;
            }
            s.followWorkspaceDirectories();
            if (s.runtime.git_push.tick(&s.runtime.workspaces, &s.runtime.git_status)) s.dirty = true;
            if (s.runtime.git_status.tick(&s.runtime.workspaces)) s.dirty = true;
            if (s.runtime.ports.tick(&s.runtime)) {
                // Publish newly discovered links with their queued state in
                // the same snapshot, avoiding a brief generic-label flash.
                _ = s.runtime.link_labels.reconcile(&s.runtime, summaries, now);
                s.dirty = true;
            }
            if (s.dirty) {
                s.runtime.changed();
                s.dirty = false;
            }
            if (s.bell and s.bell_kind == .finished) {
                var unread = false;
                for (s.runtime.conversations.items.items) |actor| unread = unread or actor.state.observation.unread();
                for (s.runtime.sessions.items) |session| unread = unread or session.attention() == .finished;
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
                try s.publishLaunchPreview(cl);
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

test "Codex selection rejects delayed ABA observations while detached actors remain addressable" {
    const observer = @import("codex_observer.zig");
    const id = "11111111-1111-4111-8111-111111111111";
    var s: Server = .{ .socket = "/tmp/unused", .executable = "/tmp/corgi" };
    defer s.runtime.deinit();
    const terminal = try @import("terminal.zig").Terminal.create(40, 4);
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 42;
    try s.runtime.panes.append(a, .{ .id = 1, .terminal = terminal, .cwd = try a.dupe(u8, "/tmp"), .detection = .{ .pid = 42 } });
    const p = &s.runtime.panes.items[0];
    var snap: observer.Snapshot = .{ .request = .{ .pane = 1, .pid = 42, .prefix = observer.titlePrefix(id).?, .generation = p.attachment.generation, .title_revision = terminal.title_revision }, .session = id.*, .state = .working, .observed_at = 100 };
    const actor = (try s.codexActor(snap)).?;
    snap.request.generation = p.attachment.generation;
    // CLI redraws may repeat or decorate the same conversation title while an
    // observation is in flight. Only a different identity invalidates it.
    terminal.feed("\x1b]2;codex | " ++ id ++ " | Working\x07");
    terminal.title_pid = 42;
    try std.testing.expectEqual(actor, (try s.codexActor(snap)).?);
    p.attachment.select(try s.runtime.conversations.get(.codex, "22222222-2222-4222-8222-222222222222"));
    p.attachment.select(actor);
    try std.testing.expectEqual(null, try s.codexActor(snap));
    snap.request.generation = p.attachment.generation;
    terminal.feed("\x1b]2;other\x07\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 42;
    try std.testing.expectEqual(null, try s.codexActor(snap));
    snap.request.title_revision = terminal.title_revision;
    try std.testing.expectEqual(actor, (try s.codexActor(snap)).?);
    snap.request.actor = actor.id;
    p.attachment.detach();
    terminal.exited = true;
    try std.testing.expectEqual(actor, (try s.codexActor(snap)).?);
}

test "local Codex reattachment requires current unambiguous identity and preserves observations" {
    const id = "11111111-1111-4111-8111-111111111111";
    var s: Server = .{ .socket = "/tmp/unused", .executable = "/tmp/corgi" };
    defer s.runtime.deinit();
    const terminal = try @import("terminal.zig").Terminal.create(40, 4);
    try s.runtime.panes.append(a, .{ .id = 1, .terminal = terminal, .cwd = try a.dupe(u8, "/tmp") });
    const p = &s.runtime.panes.items[0];
    const actor = try s.runtime.conversations.get(.codex, id);
    actor.state.setName("App server name");
    actor.state.state = .working;
    actor.state.metadata_protocol_at = 123;
    actor.state.observation = .{ .source = .protocol, .completed = 2, .read = 1 };
    const before = actor.state;
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 41;
    s.reattachCodex(p, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.title_pid = 42;
    s.reattachCodex(p, 42);
    try std.testing.expectEqual(actor, p.attachment.actor.?);
    try std.testing.expectEqualDeep(before, actor.state);
    try std.testing.expect(p.attachment.knows(actor.id));
    const generation = p.attachment.generation;
    s.reattachCodex(p, 42);
    try std.testing.expectEqual(generation, p.attachment.generation);

    p.attachment.detach();
    _ = try s.runtime.conversations.get(.codex, "11111111-1111-4111-8111-111111111112");
    terminal.feed("\x1b]2;11111111-1111-4111-8111-11111...\x07");
    terminal.title_pid = 42;
    s.reattachCodex(p, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.feed("\x1b]2;22222222-2222-4222-8222-222222222222\x07");
    terminal.title_pid = 42;
    s.reattachCodex(p, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 42;
    terminal.exited = true;
    s.reattachCodex(p, 42);
    try std.testing.expect(p.attachment.actor == null);
}
test "preview subscriptions schedule stale refreshes and publish completion without another request" {
    var preview: @import("agent_launcher.zig").Preview = .{ .pending = false };
    preview.options[1].model.set("before");
    var worker: @import("agent_launcher.zig").Worker = .{};
    worker.jobs[0] = .{ .len = 1, .preview = preview, .queued = false, .updated = std.time.milliTimestamp() - 60000 };
    worker.jobs[0].?.cwd[0] = '/';
    var s: Server = .{ .socket = "", .executable = "", .launch_previews = &worker };
    var cl: Client = .{ .fd = -1, .launch_preview = .{ .len = 1, .preview = preview } };
    defer cl.output.deinit(a);
    cl.launch_preview.?.cwd[0] = '/';
    try s.publishLaunchPreview(&cl);
    try std.testing.expect(worker.jobs[0].?.queued);
    try std.testing.expect(cl.launch_preview.?.preview.pending);
    try std.testing.expectEqualStrings("before", cl.launch_preview.?.preview.options[1].model.text());
    cl.output.clearRetainingCapacity();
    cl.launch_preview.?.checked = 0;
    worker.jobs[0].?.updated = std.time.milliTimestamp();
    worker.jobs[0].?.preview.pending = false;
    worker.jobs[0].?.preview.options[1].model.set("after");
    try s.publishLaunchPreview(&cl);
    const message = try std.json.parseFromSlice(std.json.Value, a, cl.output.items, .{});
    defer message.deinit();
    try std.testing.expectEqualStrings("agent.preview", agents.str(message.value, "type"));
    try std.testing.expect(!cl.launch_preview.?.preview.pending);
    try std.testing.expectEqualStrings("after", cl.launch_preview.?.preview.options[1].model.text());
    cl.output.clearRetainingCapacity();
    cl.launch_preview.?.checked = 0;
    try s.publishLaunchPreview(&cl);
    try std.testing.expectEqual(@as(usize, 0), cl.output.items.len);
}

fn number(v: std.json.Value, key: []const u8, default: i64) i64 {
    if (v != .object) return default;
    const n = v.object.get(key) orelse return default;
    return if (n == .integer) n.integer else default;
}
