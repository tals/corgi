//! Daemon resource ownership, socket dispatch and background observation.
const std = @import("std");
const Actor = @import("conversations.zig").Actor;
const ActorId = Actor.Id;
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const runtime = @import("runtime.zig");
const native = @import("native.zig");
const NativeId = native.Session.Id;
const protocol = @import("protocol.zig");
const Op = protocol.Op;
const Theme = @import("theme.zig").Theme;
const Client = @import("peer.zig").Client;
const launch_command = @import("launch_command.zig");
const launch_preview = @import("launch_preview.zig");
const onboarding_import = @import("onboarding_import.zig");
const herdr_adapter = @import("herdr_adapter.zig");
const activity_worker = @import("activity_worker.zig");
const transcript = @import("transcript.zig");
const usage_worker = @import("usage_worker.zig");
const codex_observer = @import("codex_observer.zig");
const Codex = @import("providers.zig").Codex;
const session_command = @import("session.zig");
const recovery = @import("recovery.zig");
const inference_setup = @import("inference_setup.zig");
const viewer_protocol = @import("viewer_protocol.zig");
const migrations = @import("state_migrations.zig");
const viewer_version = @import("viewer_version.zig");
const surface = @import("surface.zig");
const passes = @import("passes.zig");
const updates = @import("updates.zig");
const detection = @import("detection.zig");
const inference = @import("inference.zig");
const link_labels = @import("link_labels.zig");
const clock = @import("clock.zig");
const integration = @import("integration.zig");
const handoff = @import("handoff.zig");
const Terminal = @import("terminal.zig").Terminal;
const Failure = @import("failure.zig").Failure;
const log = std.log.scoped(.server);
pub const Server = struct {
    const Pane = runtime.Pane;
    runtime: runtime.Runtime = .{},
    command_previews: ?*launch_command.Worker = null,
    launch_previews: ?*launch_preview.Worker = null,
    onboarding_copy: onboarding_import.Job = .{},
    herdr_import: herdr_adapter.Manager = .{},
    handoff_operation: u64 = 0,
    import_starter: ?struct { id: WorkspaceId, revision: u64 } = null,
    summaries: ?*activity_worker.Worker = null,
    /// Polling workers a `test.settle` waits for; set while the daemon runs.
    workers: ?struct {
        transcripts: *transcript.Worker,
        usage: *usage_worker.Worker,
        codex: *codex_observer.Worker,
    } = null,
    /// Test builds: clients waiting for every worker to finish a later pass
    /// and for the daemon to apply its results.
    settles: std.ArrayList(struct { fd: c_int, targets: [3]u64, collected: bool = false }) = .empty,
    preferred_workspace: WorkspaceId = .none, // Startup hint only; commands never use it.
    default_folder_pending: bool = true,
    clients: std.ArrayList(Client) = .empty,
    socket: []const u8,
    executable: []const u8,
    /// Hex SHA-256 of `executable`; `corgi dev` reloads when it differs.
    build_id: [64]u8,
    release: updates.Release = .built,
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
    recovery_failure: Failure = .{},
    workspace_save_failure: Failure = .{},
    /// The attached viewers' resource preference, kept after they detach.
    resource_readings: bool = true,
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
        const path = workspace.Store.statePath(s.socket) catch |err| {
            log.warn("workspace state path: {}", .{err});
            return;
        };
        defer a.free(path);
        s.runtime.workspaces.save(path, s.initialWorkspace().id) catch |err| {
            if (s.workspace_save_failure.changed(err)) log.err("saving workspaces: {}", .{err});
            return;
        };
        if (s.workspace_save_failure.clear()) log.info("workspace save succeeded again", .{});
    }
    fn rememberImportStarter(s: *Server) void {
        s.import_starter = null;
        if (s.runtime.workspaces.items.items.len != 1 or s.runtime.sessions.items.len != 0) return;
        const ws = &s.runtime.workspaces.items.items[0];
        if (ws.model.count == 0 and ws.name_len == 0) s.import_starter = .{ .id = ws.id, .revision = ws.model.revision };
    }
    fn finishImport(s: *Server, destination: ?WorkspaceId) void {
        const starter = s.import_starter orelse return;
        s.import_starter = null;
        const target = destination orelse return;
        if (s.runtime.workspaces.index(target) == null or starter.id == target) return;
        const ws = s.runtime.workspaces.get(starter.id) orelse return;
        // Another viewer can use or rename the starter while Herdr connects.
        if (ws.model.count != 0 or ws.name_len != 0 or ws.model.revision != starter.revision) return;
        s.runtime.closeWorkspace(starter.id, false) catch |err| {
            log.warn("closing import starter workspace: {}", .{err});
            return;
        };
        s.default_folder_pending = false;
        s.preferred_workspace = target;
        for (s.clients.items) |*cl| if (cl.view_workspace == starter.id) {
            cl.view_workspace = target;
        };
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
    fn codexActor(s: *Server, snap: codex_observer.Snapshot) !?*Actor {
        return if (snap.request.actor != ActorId.none)
            s.runtime.conversations.byId(snap.request.actor) orelse return null
        else blk: {
            const p = s.pane(snap.request.pane) orelse return null;
            const prefix = Codex.titleSession(p.terminal.vt.getTitle() orelse "") orelse return null;
            if (p.terminal.exited or p.detection.missing != 0 or p.detection.pid != snap.request.pid or
                p.terminal.title_pid != snap.request.pid or p.terminal.title_revision != snap.request.title_revision or
                p.attachment.generation != snap.request.generation or !std.mem.eql(u8, prefix.text(), snap.request.prefix.text())) return null;
            const selected = try s.runtime.conversations.get(.codex, &snap.session);
            p.attachment.select(selected);
            if (selected.workspace == WorkspaceId.none or s.runtime.workspaces.index(selected.workspace) == null) {
                if (s.runtime.workspaces.owner(p.id)) |ws| selected.workspace = ws.id;
            }
            break :blk selected;
        };
    }
    fn pane(s: *Server, id: layout.PaneId) ?*Pane {
        return s.runtime.pane(id);
    }
    fn nativeSession(s: *Server, id: NativeId) !usize {
        for (s.runtime.sessions.items, 0..) |session, index| if (session.id == id) return index;
        return error.NoNativeSession;
    }
    pub fn notice(_: *Server, msg: []const u8) void {
        log.info("{s}", .{msg});
    }
    pub const Excluded = error{ ImportInProgress, ReloadInProgress, GitPushInProgress };
    /// The one place the import, reload and push locks are read.
    pub fn admit(s: *const Server, exclusion: protocol.Exclusion) Excluded!void {
        const importing = s.herdr_import.busy() or s.onboarding_copy.busy();
        switch (exclusion) {
            .none => {},
            // Narrower than `importing`: an adopted Herdr import no longer owns panes.
            .layout => if (s.herdr_import.locked() or s.onboarding_copy.busy()) return error.ImportInProgress,
            .import => if (importing or s.reload_executable != null) return error.ImportInProgress,
            .push => if (s.reload_executable != null) return error.ReloadInProgress,
            .reload => {
                if (importing) return error.ImportInProgress;
                if (s.reload_executable != null) return error.ReloadInProgress;
                if (s.runtime.git_push.busy()) return error.GitPushInProgress;
            },
            .shutdown => if (importing) return error.ImportInProgress,
        }
    }
    /// Retrying an onboarding start whose reply was lost must not start the
    /// work twice, and is answered before the import lock refuses it.
    fn repeatsOperation(s: *const Server, req: protocol.Request) error{InvalidImport}!bool {
        const operation, const current = switch (req) {
            .@"onboarding.handoff" => |q| .{ q.operation, s.handoff_operation },
            .@"onboarding.copy" => |q| .{ q.operation, s.onboarding_copy.operation },
            else => return false,
        };
        if (operation == 0) return error.InvalidImport;
        return operation == current;
    }
    /// All shared commands have one execution and post-commit path.
    pub fn execute(s: *Server, command: protocol.Command, allocator: std.mem.Allocator) !protocol.Result {
        // viewer.open's first pane and the pane-exit sweep reach here without a request.
        try s.admit(.layout);
        const before = s.runtime.revision;
        const result = try session_command.execute(&s.runtime, .{ .socket = s.socket, .executable = s.executable, .theme = s.theme }, command, allocator);
        if (s.runtime.revision != before) {
            if (result.pane != layout.PaneId.none) s.default_folder_pending = false;
            s.dirty = true;
            s.followWorkspaceDirectories();
            s.saveWorkspaces();
            viewer_protocol.resize(s) catch |err| log.warn("resizing panes: {}", .{err});
        }
        return result;
    }
    pub fn close(s: *Server, id: layout.PaneId) !void {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        _ = try s.execute(.{ .@"pane.close" = .{ .target = id } }, arena.allocator());
    }
    pub fn visitWorkspace(s: *Server, id: WorkspaceId) void {
        const index = s.runtime.workspaces.index(id) orelse return;
        if (s.runtime.workspaces.items.items[index].away.visit(std.time.milliTimestamp())) {
            s.runtime.changed();
            s.dirty = true;
        }
    }
    fn workspaceWatched(s: *Server, id: WorkspaceId) bool {
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead and cl.watched and cl.view_workspace == id and std.time.milliTimestamp() - cl.touched < 1000) return true;
        return false;
    }
    fn paneWatched(s: *Server, id: layout.PaneId) bool {
        for (s.clients.items) |cl| if (cl.viewer and !cl.dead and cl.watched and cl.view_focus == id and std.time.milliTimestamp() - cl.touched < 1000) return true;
        return false;
    }
    fn queueSession(s: *Server, cl: *Client) !void {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        cl.queue(try session_command.snapshot(arena.allocator(), &s.runtime));
        cl.snapshot_revision = s.runtime.revision;
        cl.last_snapshot = std.time.milliTimestamp();
    }

    fn publishLaunchPreview(s: *Server, cl: *Client) void {
        const subscription = if (cl.launch_preview) |*value| value else return;
        const worker = s.launch_previews orelse return;
        const now = std.time.milliTimestamp();
        if (cl.dead or cl.output.items.len != 0 or now - subscription.checked < 100) return;
        subscription.checked = now;
        const cwd = subscription.cwd.text();
        var preview = worker.preview(cwd);
        // A replacement daemon starts with an empty worker cache. Keep the
        // subscriber's last values visible until the fresh read completes.
        if (preview.pending) {
            preview = subscription.preview;
            preview.pending = true;
        }
        if (std.meta.eql(preview, subscription.preview)) return;
        cl.queue(.{ .type = "agent.preview", .cwd = cwd, .preview = preview });
        subscription.preview = preview;
    }

    fn request(s: *Server, cl: *Client, arena: std.mem.Allocator, v: std.json.Value) !void {
        if (v != .object) return error.UnknownOperation;
        const op = protocol.parse(v) orelse return error.UnknownOperation;
        switch (protocol.check(op)) {
            .none => {},
            .negotiate => try protocol.require(v, null),
            .runtime => try protocol.require(v, cl.protocol_version),
            // An old viewer gets the version it needs, not an error it cannot
            // decode. Checked before the payload, whose shape may differ.
            .viewer => {
                if (!viewer_version.compatible(v)) return cl.queue(.{ .err = "UnsupportedViewerProtocol", .viewer_protocol = viewer_version.version });
                try protocol.require(v, cl.protocol_version);
            },
        }
        const req = try protocol.decode(arena, op, v);
        if (try s.repeatsOperation(req)) return cl.queue(.{ .ok = true });
        try s.admit(protocol.exclusion(op));
        switch (req) {
            .hello => {
                cl.protocol_version = protocol.version;
                cl.queue(protocol.Hello{
                    .protocol = protocol.version,
                    .capabilities = &protocol.capabilities,
                    .server_pid = c.getpid(),
                    .build_id = &s.build_id,
                    .executable = s.executable,
                    .release_version = s.release.version,
                    .update_abi = updates.abi,
                });
            },
            .@"git.push" => |q| {
                try s.runtime.git_push.start(&s.runtime.workspaces, q.workspace, q.ref);
                s.dirty = true;
                cl.queue(.{ .ok = true });
            },
            .@"onboarding.status" => |q| {
                if (q.operation == s.handoff_operation and q.operation != 0) {
                    cl.reply(.@"onboarding.status", .{ .progress = s.herdr_import.status() });
                } else if (q.operation == s.onboarding_copy.operation and q.operation != 0) {
                    cl.reply(.@"onboarding.status", .{ .progress = s.onboarding_copy.progress });
                } else return error.NoImport;
            },
            .@"onboarding.handoff" => |q| {
                if (q.viewer_pgid <= 0) return error.InvalidImport;
                try s.herdr_import.start(q.socket, s.executable, s.theme, q.viewer_pgid);
                s.handoff_operation = q.operation;
                s.rememberImportStarter();
                cl.queue(.{ .ok = true });
            },
            .@"onboarding.copy" => |q| {
                try s.onboarding_copy.start(q);
                s.rememberImportStarter();
                cl.queue(.{ .ok = true });
            },
            .@"server.reload" => |q| {
                if (!std.fs.path.isAbsolute(q.executable)) return error.InvalidExecutable;
                s.reload_executable = try a.dupe(u8, q.executable);
                s.reload_requester = cl.fd;
            },
            .@"recovery.save" => {
                try recovery.save(&s.runtime, s.socket);
                const path = try recovery.path(s.socket);
                defer a.free(path);
                cl.queue(.{ .ok = true, .path = path });
            },
            .@"agent.command.preview" => |q| {
                const ws = try s.runtime.getWorkspace(q.workspace);
                const cwd = if (q.cwd.len > 0) q.cwd else ws.cwd;
                if (!std.fs.path.isAbsolute(cwd)) return error.InvalidDirectory;
                const worker = s.command_previews orelse return error.Unavailable;
                cl.reply(.@"agent.command.preview", .{ .resolution = try worker.request(q.request, q.command, cwd) });
            },
            .@"agent.preview", .@"agent.track_usage", .@"agent.subscribe" => |q| {
                const subscribe = op == .@"agent.subscribe";
                if (subscribe and (cl.viewer or cl.subscribed)) return error.AlreadyAttached;
                const ws = try s.runtime.getWorkspace(q.workspace);
                const cwd = if (q.cwd.len > 0) q.cwd else ws.cwd;
                if (!std.fs.path.isAbsolute(cwd)) return error.InvalidDirectory;
                const dir = agents.Path.init(cwd) catch return error.InvalidDirectory;
                const preview = if (s.launch_previews) |worker| (if (op == .@"agent.track_usage") worker.trackUsage(cwd) else worker.preview(cwd)) else launch_preview.Preview{};
                if (subscribe) {
                    cl.launch_preview = .{ .cwd = dir, .preview = preview, .checked = std.time.milliTimestamp() };
                    cl.queue(.{ .type = "agent.preview", .cwd = cwd, .preview = preview });
                } else cl.queue(.{ .ok = true, .preview = preview });
            },
            .@"inference.configure" => |q| {
                const worker = s.summaries orelse return error.InferenceUnavailable;
                worker.configure(q.choice);
                const saved = if (inference_setup.path(s.socket)) |file| blk: {
                    defer a.free(file);
                    inference_setup.save(file, q.choice) catch break :blk false;
                    break :blk true;
                } else |_| false;
                s.publishInference();
                cl.reply(.@"inference.configure", .{ .saved = saved, .inference = s.runtime.inference });
            },
            .@"session.command" => |q| cl.reply(.@"session.command", .{ .result = try s.execute(q.command, arena) }),
            .@"viewer.open" => |q| try viewer_protocol.open(s, cl, q),
            .@"viewer.sync" => |q| try viewer_protocol.sync(s, cl, arena, q),
            .@"viewer.search" => |q| try viewer_protocol.search(s, cl, q),
            .@"pane.acknowledge" => |q| try viewer_protocol.acknowledge(s, cl, q),
            .@"viewer.list" => cl.queue(.{ .ok = true, .viewers = try viewer_protocol.viewers(s, arena) }),
            .action => |q| try viewer_protocol.action(s, cl, q),
            .focus => |q| try viewer_protocol.focus(s, cl, q),
            .@"workspace.switch" => |q| try viewer_protocol.switchWorkspace(s, cl, q),
            .@"session.locate" => |q| cl.reply(.@"session.locate", .{ .result = try session_command.location(&s.runtime, q.pane) }),
            .@"session.list" => {
                cl.queue(.{ .ok = true, .result = try session_command.snapshot(arena, &s.runtime), .viewers = try viewer_protocol.viewers(s, arena) });
            },
            .@"session.snapshot", .@"session.subscribe" => {
                if (op == .@"session.subscribe" and (cl.viewer or cl.launch_preview != null)) return error.AlreadyAttached;
                try s.queueSession(cl);
                if (op == .@"session.subscribe") cl.subscribed = true;
            },
            .@"conversation.list" => {
                const snapshot = try session_command.snapshot(arena, &s.runtime);
                cl.queue(.{ .ok = true, .conversations = snapshot.conversations });
            },
            .@"conversation.acknowledge" => |q| {
                const actor = s.runtime.conversations.byId(q.conversation) orelse return error.NoConversation;
                actor.acknowledge(q.through, q.attention_at);
                s.runtime.changed();
                s.dirty = true;
                cl.queue(.{ .ok = true });
            },
            .@"pane.surface" => |q| {
                const p = s.pane(q.pane) orelse return error.NoPane;
                const captured = try surface.capture(arena, q.pane, p.terminal);
                cl.queue(.{ .type = "surface", .protocol = protocol.version, .server_pid = c.getpid(), .revision = s.runtime.revision, .surface = captured });
            },
            .@"native.start" => |q| {
                if (s.runtime.sessions.items.len >= 16) return error.TooManyNativeSessions;
                try s.runtime.sessions.ensureUnusedCapacity(a, 1);
                const ws = if (q.workspace) |id| try s.runtime.getWorkspace(id) else try s.onlyWorkspace();
                var session = try native.Session.start(s.runtime.next_session, q.provider, if (q.cwd.len > 0) q.cwd else ws.cwd);
                session.workspace_id = ws.id;
                s.runtime.sessions.appendAssumeCapacity(session);
                s.runtime.next_session = s.runtime.next_session.next();
                s.dirty = true;
                cl.queue(.{ .ok = true, .session = session.id, .provider = q.provider });
            },
            .@"native.list" => {
                const Info = struct {
                    id: NativeId,
                    pid: i32,
                    session_id: []const u8,
                    provider: agents.Provider,
                    ready: bool,
                    exited: bool,
                    state: agents.State,
                    attention: agents.Attention,
                    observation: agents.observation.State,
                    unread: bool,
                    pending_requests: usize,
                    active_tools: usize,
                    next_seq: u64,
                };
                var info: std.ArrayList(Info) = .empty;
                defer info.deinit(a);
                for (s.runtime.sessions.items) |session| try info.append(a, .{
                    .id = session.id,
                    .pid = session.child.id,
                    .session_id = session.resume_hint.session.text(),
                    .provider = session.provider,
                    .ready = session.ready,
                    .exited = session.exited,
                    .state = session.status(),
                    .attention = session.attention(),
                    .observation = session.observation(),
                    .unread = session.observation().unread(),
                    .pending_requests = session.approvals.items.len,
                    .active_tools = session.active_tools.items.len,
                    .next_seq = session.next_seq,
                });
                cl.queue(.{ .ok = true, .sessions = info.items });
            },
            .@"native.stop" => |q| {
                const index = try s.nativeSession(q.session);
                s.dirty = true;
                s.runtime.sessions.items[index].destroy();
                _ = s.runtime.sessions.orderedRemove(index);
                cl.queue(.{ .ok = true });
            },
            .@"native.send" => |q| {
                const session = &s.runtime.sessions.items[try s.nativeSession(q.session)];
                s.dirty = true;
                try session.send(&s.runtime.conversations, q.message);
                cl.queue(.{ .ok = true });
            },
            .@"native.events" => |q| {
                const session = &s.runtime.sessions.items[try s.nativeSession(q.session)];
                s.dirty = true;
                var events: std.ArrayList(native.Event) = .empty;
                for (session.events.items) |event| if (event.seq > q.after) try events.append(arena, event);
                const requests = try session.approvalLines(arena);
                cl.queue(.{
                    .ok = true,
                    .events = events.items,
                    .pending_requests = requests,
                    .next_seq = session.next_seq,
                    .first_seq = if (session.events.items.len > 0) session.events.items[0].seq else session.next_seq,
                });
                session.acknowledge();
            },
            .theme => |q| {
                if (!cl.viewer) return error.NotAttached;
                for (s.clients.items) |viewer| if (viewer.viewer and !viewer.dead) {
                    if (viewer.fd == cl.fd) s.updateTheme(q.theme.value);
                    break;
                };
                if (cl.viewer) cl.queue(.{ .ok = true });
            },
            .hook => |q| {
                const hook = agents.providers.Backend.init(q.provider).hook(q.event);
                if (q.background) {
                    // A daemon-hosted session only updates a conversation some pane
                    // already follows (see continued-in handling); it never selects.
                    if (hook) |h| if (s.runtime.conversations.find(q.provider, h.session)) |actor| {
                        const now = std.time.microTimestamp();
                        const from = Lifecycle.of(actor);
                        const ding = actor.observeHook(h, q.seq orelse now, s.actorWatched(actor.id), now);
                        logHook(actor, from, q.event, null);
                        s.attention(ding, actor.state.state);
                        s.runtime.changed();
                        s.dirty = true;
                    };
                    cl.queue(.{ .ok = true });
                    return;
                }
                const p = s.pane(q.pane) orelse return error.NoPane;
                // Bind a newly launched foreground process before applying its
                // first hook, including back-to-back launches in the same pane.
                s.detectPane(p);
                const seq = q.seq orelse std.time.microTimestamp();
                if (seq > p.attachment.hook_seq and hook != null) if (try s.runtime.conversations.routeHook(&p.attachment, q.provider, hook.?)) |actor| {
                    p.attachment.hook_seq = seq;
                    if (hook.?.kind == .session_start) s.runtime.last_agent = q.provider;
                    if (actor.workspace == WorkspaceId.none or s.runtime.workspaces.index(actor.workspace) == null) {
                        if (s.runtime.workspaces.owner(p.id)) |ws| actor.workspace = ws.id;
                    }
                    const now = std.time.microTimestamp();
                    const from = Lifecycle.of(actor);
                    const ding = actor.observeHook(hook.?, seq, s.actorWatched(actor.id), now);
                    logHook(actor, from, q.event, p.id);
                    s.attention(ding, actor.state.state);
                    s.runtime.changed();
                    s.dirty = true;
                };
                cl.queue(.{ .ok = true });
            },
            .ping => cl.queue(.{ .ok = true, .version = "0.1.0" }),
            .shutdown => {
                s.quit = true;
                cl.queue(.{ .ok = true });
            },
            .@"test.settle" => {
                // Replied from the main loop once the daemon has caught up.
                const w = s.workers orelse return error.NotRunning;
                try s.settles.append(a, .{ .fd = cl.fd, .targets = .{ passes.settle(w.transcripts), passes.settle(w.usage), passes.settle(w.codex) } });
            },
            .@"test.advance" => |q| {
                if (q.ms < 0) return error.InvalidField;
                clock.advance(q.ms);
                if (s.summaries) |worker| worker.poke();
                cl.queue(.{ .ok = true });
            },
        }
    }
    /// `theme` is a viewer's host colors, or null when it sent none or sent them malformed.
    pub fn updateTheme(s: *Server, theme: ?Theme) void {
        s.theme.merge(theme orelse return);
        for (s.runtime.panes.items) |p| p.terminal.applyTheme(s.theme);
        s.dirty = true;
    }
    /// Backgrounding a Claude conversation continues it under a new session in
    /// Claude's daemon while the pane's client keeps showing it. Its hooks
    /// cannot name that pane, so panes follow the transcript's continued-in.
    fn followContinuation(s: *Server, old: *Actor, session: []const u8) void {
        switch (old.provider()) {
            .claude => {},
            .codex => return,
        }
        if (std.mem.eql(u8, session, old.state.sessionId())) return;
        var followed = false;
        for (s.runtime.panes.items) |*p| {
            if (p.attachment.actor != old) continue;
            const next = s.runtime.conversations.get(.claude, session) catch |err| {
                log.warn("following continuation to session {s}: {}", .{ session, err });
                return;
            };
            if (next.workspace == WorkspaceId.none) next.workspace = old.workspace;
            if (next.state.last_seq == 0) {
                // The continuation is usually mid-turn; hooks refine it later.
                next.state.state = if (old.state.state == .done) .idle else old.state.state;
                next.state.cwd = old.state.cwd;
                const dir = std.fs.path.dirname(old.state.transcriptPath()) orelse "";
                var path: [agents.Path.capacity]u8 = undefined;
                if (dir.len > 0) if (std.fmt.bufPrint(&path, "{s}/{s}.jsonl", .{ dir, session })) |value| {
                    next.state.transcript = .initTruncated(value);
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
    fn actorWatched(s: *Server, actor: ActorId) bool {
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
    /// Runs after each collection cycle. Once every worker has finished a pass
    /// that began after the request, one more cycle collects its results. Port
    /// and git scans in progress are applied first too; pushes are not awaited.
    fn progressSettles(s: *Server) void {
        const w = s.workers orelse return;
        var i: usize = 0;
        while (i < s.settles.items.len) {
            const pending = &s.settles.items[i];
            if (!pending.collected or s.runtime.ports.busy() or s.runtime.git_status.busy()) {
                pending.collected = pending.collected or (passes.reached(w.transcripts, pending.targets[0]) and
                    passes.reached(w.usage, pending.targets[1]) and passes.reached(w.codex, pending.targets[2]));
                i += 1;
                continue;
            }
            if (s.summaries) |summaries| summaries.poke();
            for (s.clients.items) |*cl| if (cl.fd == pending.fd) cl.queue(.{ .ok = true });
            _ = s.settles.swapRemove(i);
        }
    }
    fn reattachFromTitle(s: *Server, p: *Pane, provider: agents.Provider, pid: c_int) void {
        if (p.attachment.actor != null or p.terminal.exited or pid <= 0 or p.terminal.title_pid != pid) return;
        const prefix = provider.backend().titleSession(p.terminal.vt.getTitle() orelse "") orelse return;
        var found: ?*Actor = null;
        for (s.runtime.conversations.items.items) |actor| {
            if (actor.provider() != provider or actor.state.session.len != 36 or !std.mem.startsWith(u8, actor.state.sessionId(), prefix.text())) continue;
            if (found != null) return; // A truncated UUID must resolve uniquely.
            found = actor;
        }
        if (found) |actor| {
            p.attachment.select(actor);
            if (actor.workspace == WorkspaceId.none or s.runtime.workspaces.index(actor.workspace) == null) {
                if (s.runtime.workspaces.owner(p.id)) |ws| actor.workspace = ws.id;
            }
        }
    }
    fn detectPane(s: *Server, p: *Pane) void {
        const job = detection.foreground(p.terminal.fd);
        const before = p.agent().*;
        const old_binding = p.attachment.generation;
        const previous_pid = p.detection.pid;
        if (before.provider != p.agent().provider or !std.mem.eql(u8, before.sessionId(), p.agent().sessionId())) {
            if (p.agent().provider) |provider| s.runtime.last_agent = provider;
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
            // Codex titles name the session, so a resumed conversation can
            // reattach before its first hook.
            const title_identity = switch (current.provider) {
                .codex => true,
                .claude => false,
            };
            if (title_identity) {
                const prefix = current.provider.backend().titleSession(p.terminal.vt.getTitle() orelse "");
                const hash = if (prefix) |value| std.hash.Wyhash.hash(0, value.text()) else 0;
                if (hash != p.attachment.selection_hash) {
                    if (p.attachment.actor) |actor| {
                        if (prefix == null or !std.mem.startsWith(u8, actor.state.sessionId(), prefix.?.text())) p.attachment.deselect();
                    }
                    p.attachment.generation +%= 1;
                    p.attachment.selection_hash = hash;
                }
                s.reattachFromTitle(p, current.provider, current.pid);
            }
        }
        const now = clock.microTimestamp();
        // Detection owns only provisional screen state. It cannot reset an
        // actor when a process exits or another session occupies the pane.
        const authoritative = if (p.attachment.actor) |actor| actor.authoritative(now) else false;
        p.attachment.provisional.last_seq = if (authoritative) 1 else 0;
        const review = p.agent().permission_review != null;
        // Claude has no interrupt hook; its screen is the only sign a hook-reported turn was aborted.
        const interrupt_hook = if (p.attachment.actor) |actor| switch (actor.provider()) {
            .codex => true,
            .claude => false,
        } else true;
        const settle = if (p.attachment.actor) |actor| authoritative and !interrupt_hook and actor.state.state == .working and !actor.state.observation.pending_stop else false;
        // Nor does Claude report that a person answered its prompt.
        const answering = if (p.attachment.actor) |actor| authoritative and !interrupt_hook and actor.state.state == .blocked else false;
        const compaction = if (p.agent().provider) |provider| provider.info().screen.compaction_status and p.agent().state == .working else false;
        const text = if (job != null and (!authoritative or review or settle or answering or compaction)) p.terminal.liveText() catch null else null;
        defer if (text) |bytes| a.free(bytes);
        var ding = p.detection.update(&p.attachment.provisional, job, p.terminal.vt.getTitle() orelse "", text orelse "", s.paneWatched(p.id));
        // Each new agent process counts once toward automatic inference selection.
        if (job) |current| if (current.pid != previous_pid) if (s.summaries) |worker| {
            worker.observeLaunch(current.provider);
        };
        if (previous_pid != 0 and p.detection.pid == 0) p.attachment.detach();
        if (p.attachment.actor) |actor| actor.screen(&p.attachment.provisional, ding, now);
        if (compaction and text != null) if (p.attachment.actor) |actor| actor.observeCompactionScreen(detection.screenCompacting(text.?), now);
        const settling = if (p.attachment.actor) |actor| settle and text != null and actor.state.state == .working else false;
        if (!settling) {
            p.detection.idle_since = 0;
        } else if (p.detection.interrupted(p.terminal.vt.getTitle() orelse "", text.?, now)) {
            const actor = p.attachment.actor.?;
            const from = Lifecycle.of(actor);
            actor.state.abandonTurn(now);
            logState(actor, from, p.id, "screen", "interrupted");
            p.detection.idle_since = 0;
            p.detection.interrupt_key_at = 0;
        }
        if (p.attachment.actor) |actor| if (actor.prompt_watch.answered(answering and text != null, text orelse "")) |next| {
            const from = Lifecycle.of(actor);
            actor.state.observeAnswer(next, now);
            logState(actor, from, p.id, "screen", "prompt answered");
        };
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
        s.release = .of(s.executable);
        s.command_previews = try launch_command.Worker.start();
        defer {
            s.command_previews.?.stop();
            s.command_previews = null;
        }
        s.launch_previews = try launch_preview.Worker.start();
        defer {
            s.launch_previews.?.stop();
            s.launch_previews = null;
        }
        const observer = try transcript.Worker.start();
        defer observer.stop();
        const usage = try usage_worker.Worker.start();
        defer usage.stop();
        const settings = inference_setup.path(s.socket) catch |err| blk: {
            log.warn("inference settings path: {}", .{err});
            break :blk null;
        };
        const summaries = if (s.summaries) |inherited| blk: {
            try inherited.activate();
            break :blk inherited;
        } else try activity_worker.Worker.start(inference_setup.initial(if (settings) |file| inference_setup.load(file) else null));
        if (settings) |file| a.free(file);
        s.summaries = summaries;
        defer {
            s.summaries = null;
            summaries.stop();
        }
        s.publishInference();
        const codex = try codex_observer.Worker.start();
        defer codex.stop();
        s.workers = .{ .transcripts = observer, .usage = usage, .codex = codex };
        defer {
            s.workers = null;
            s.settles.deinit(a);
        }
        _ = c.signal(c.SIGPIPE, os.sig_ignore);
        const fd = s.inherited_listener orelse try os.listen(s.socket);
        const socket_path: os.SocketPath = .claim(s.socket);
        defer s.runtime.deinit();
        defer s.herdr_import.deinit();
        defer s.onboarding_copy.deinit();
        const state_path = try workspace.Store.statePath(s.socket);
        defer a.free(state_path);
        if (s.inherited_listener != null) {
            // Imported state and sockets are ready before ownership commits.
        } else if (try recovery.load(&s.runtime, s.socket, s.executable)) {
            var preferences: workspace.Store = .{};
            defer preferences.deinit();
            s.preferred_workspace = (preferences.load(state_path) catch |err| blk: {
                log.warn("loading preferred workspace: {}", .{err});
                break :blk null;
            }) orelse .none;
            s.default_folder_pending = false;
        } else if (try s.runtime.workspaces.load(state_path)) |selected| {
            s.preferred_workspace = selected;
            s.default_folder_pending = false;
        } else {
            _ = try s.runtime.workspaces.add("", ".");
            try s.runtime.workspaces.save(state_path, s.initialWorkspace().id);
        }
        if (s.inherited_listener == null) for (agents.Provider.all) |provider| {
            integration.install(provider) catch |err| {
                log.warn("{t} hook setup: {}; using automatic detection", .{ provider, err });
                var msg: [180]u8 = undefined;
                s.notice(std.fmt.bufPrint(&msg, "{t} hooks: {s}; automatic detection is active", .{ provider, @errorName(err) }) catch "Hook setup failed; automatic detection is active");
            };
        };
        defer {
            for (s.clients.items) |*cl| cl.deinit();
            s.clients.deinit(a);
        }
        // Runs before the slower teardown above: a daemon started after
        // shutdown replied may already own this path.
        defer {
            _ = c.close(fd);
            socket_path.release();
        }
        while (!s.quit) {
            const handed_off = s.herdr_import.tick(&s.runtime);
            const copied = s.onboarding_copy.tick(&s.runtime, .{ .workspace = .none, .cwd = "/", .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
            if (handed_off) s.finishImport(s.herdr_import.status().workspace);
            if (copied and s.onboarding_copy.progress.phase == .complete) s.finishImport(s.onboarding_copy.progress.workspace);
            if (handed_off or copied) {
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
                if (p.terminal.reap()) {
                    s.runtime.changed();
                    s.dirty = true;
                }
            }
            const now = std.time.milliTimestamp();
            if (now - s.last_detection >= 250 or s.settles.items.len > 0) {
                s.last_detection = now;
                for (s.runtime.panes.items) |*p| if (!p.terminal.exited) s.detectPane(p);
                codex.reconcile(&s.runtime);
                var snapshots: [layout.max_panes]?codex_observer.Snapshot = undefined;
                codex.take(&snapshots);
                for (snapshots) |entry| if (entry) |snap| {
                    defer snap.deinit();
                    const actor = (s.codexActor(snap) catch |err| {
                        // A full registry must not end the daemon; see conversations.max_actors.
                        log.warn("tracking Codex session: {}", .{err});
                        continue;
                    }) orelse continue;
                    const applied = clock.microTimestamp();
                    const ding = actor.observeSnapshot(snap, s.actorWatched(actor.id), applied);
                    if (actor.parent == null) s.attention(ding, actor.state.state);
                    s.runtime.conversations.observeChildren(actor, snap, applied);
                    summaries.submit(actor, snap.evidence, null, s.runtime.panes.items);
                    s.dirty = true;
                    s.runtime.changed();
                };
                summaries.reconcile(s.runtime.conversations.items.items);
                for (s.clients.items) |client| if (client.viewer and !client.dead) {
                    summaries.observe(clock.milliTimestamp());
                    break;
                };
                summaries.remember(s.runtime.last_agent);
                s.publishInference();
                if (now - s.last_update_check >= 30 * std.time.ms_per_s) {
                    s.last_update_check = now;
                    var scratch: [64]u8 = undefined;
                    const found = updates.stagedVersion(s.release, s.executable, &scratch) orelse "";
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
                var link_results: [link_labels.capacity]?link_labels.Result = undefined;
                summaries.takeLinks(&link_results);
                for (link_results) |entry| if (entry) |result| {
                    if (s.runtime.link_labels.apply(result, now)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                var summary_results: [layout.max_panes]?activity_worker.Result = undefined;
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
                    if (!std.meta.eql(actor.context, result.context)) {
                        actor.context = result.context;
                        const model = result.context.model;
                        s.runtime.conversations.compaction_points.learn(model.text(), result.context.auto_compaction);
                        s.dirty = true;
                        s.runtime.changed();
                    }
                    if (result.continued.len > 0) s.followContinuation(actor, result.continued.text());
                    const before = actor.state;
                    if (result.progress) |progress| actor.observeTools(progress);
                    if (result.fallback(&actor.state, clock.microTimestamp())) {
                        summaries.submit(actor, result.progress.?.commentary, result.progress, s.runtime.panes.items);
                    } else if (result.progress) |progress| summaries.tools(actor.id, &actor.state, progress);
                    if (!std.meta.eql(before, actor.state)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                    if (actor.native_usage) continue;
                    const ws = s.runtime.workspaces.get(result.workspace) orelse continue;
                    if (actor.workspace != ws.id or s.workspaceWatched(ws.id)) continue;
                    if (ws.away.record(result.since, result.delta)) {
                        s.dirty = true;
                        s.runtime.changed();
                    }
                };
                observer.reconcile(s.runtime.conversations.items.items);
                var completions: [layout.max_panes]?transcript.Result = undefined;
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
                s.progressSettles();
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
                    // Sized for the longest provider name, two u32s and the longest state tag.
                    s.notice(std.fmt.bufPrint(&msg, " {s} native session {d}: {s}  |  corgi native events {d}", .{
                        @tagName(session.provider),
                        @intFromEnum(session.id),
                        @tagName(session.status()),
                        @intFromEnum(session.id),
                    }) catch unreachable);
                }
            }
            // Each child is reaped by its owner; workers wait for their own.
            for (s.runtime.sessions.items) |*session| if (session.reap()) {
                s.dirty = true;
            };
            s.runtime.reapStopped();
            // Remove in a separate pass so adjacent exits aren't skipped.
            const closable = if (s.admit(.layout)) |_| true else |_| false;
            var pi: usize = 0;
            while (pi < s.runtime.panes.items.len) {
                const p = &s.runtime.panes.items[pi];
                if (closable and p.terminal.exited) {
                    s.close(p.id) catch |err| {
                        log.warn("removing exited pane {d}: {}", .{ @intFromEnum(p.id), err });
                        pi += 1; // Leave it for the next pass rather than spin.
                    };
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
                    cl.input.appendSlice(a, bytes[0..@intCast(n)]) catch {
                        cl.dead = true;
                    };
                    if (cl.input.items.len > 1024 * 1024) cl.dead = true;
                }
                if (cl.input.items.len > 0) {
                    var consumed: usize = 0;
                    while (!cl.dead) {
                        const newline = std.mem.indexOfScalarPos(u8, cl.input.items, consumed, '\n') orelse break;
                        const parsed = std.json.parseFromSlice(std.json.Value, a, cl.input.items[consumed..newline], .{ .max_value_len = 1024 * 1024 }) catch {
                            cl.queue(.{ .ok = false, .err = "InvalidJson" });
                            consumed = newline + 1;
                            continue;
                        };
                        defer parsed.deinit();
                        s.request(cl, parsed.arena.allocator(), parsed.value) catch |err| {
                            cl.queue(.{ .ok = false, .err = @errorName(err) });
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
                    viewer_protocol.resize(s) catch |err| log.warn("resizing panes: {}", .{err});
                    continue;
                }
                ci += 1;
            }
            s.followWorkspaceDirectories();
            var resource_detail = false;
            var viewers = false;
            var sampled = false;
            for (s.clients.items) |client| if (client.viewer and !client.dead) {
                viewers = true;
                sampled = sampled or client.resources;
                resource_detail = resource_detail or (client.watched and client.resource_detail != null);
            };
            // Sample while any attached viewer shows readings. Without viewers,
            // keep their last choice: CLI snapshots get fresh totals unless
            // readings were turned off, which stops sampling entirely.
            if (viewers) s.resource_readings = sampled;
            if (if (s.resource_readings) s.runtime.resources.tick(&s.runtime, resource_detail) else s.runtime.resources.stop()) s.dirty = true;
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
                s.publishLaunchPreview(cl);
                if (cl.subscribed and !cl.dead and cl.output.items.len == 0 and
                    cl.snapshot_revision != s.runtime.revision and std.time.milliTimestamp() - cl.last_snapshot >= 30)
                {
                    s.queueSession(cl) catch |err| {
                        log.warn("snapshot for client {d}: {}", .{ cl.fd, err });
                        cl.dead = true;
                    };
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
                        s.clients.append(a, .{ .fd = client_fd, .touched = std.time.milliTimestamp() }) catch {
                            _ = c.close(client_fd);
                        };
                    }
                }
            }
            if (!s.quit) if (s.reload_executable) |executable| {
                handoff.replace(s, fd, executable, s.reload_requester) catch |err| {
                    for (s.clients.items) |*cl| if (cl.fd == s.reload_requester) cl.queue(.{ .ok = false, .err = @errorName(err) });
                    a.free(executable);
                    s.reload_executable = null;
                    s.notice(@errorName(err));
                };
            };
            if ((now - s.last_recovery >= 2000 and s.saved_revision != s.runtime.revision) or s.quit) {
                s.last_recovery = now;
                recovery.save(&s.runtime, s.socket) catch |err| {
                    if (s.recovery_failure.changed(err)) {
                        log.err("saving recovery: {}", .{err});
                        s.notice(" Could not save recovery snapshot; see server.log");
                    }
                    continue;
                };
                if (s.recovery_failure.clear()) log.info("recovery snapshot saved again", .{});
                s.saved_revision = s.runtime.revision;
            }
        }
    }
};

test "the daemon loop body has no try: one client's or pane's error must not end run()" {
    const src = @embedFile("server.zig");
    const marker = "while (!s.quit) {";
    const start = (std.mem.indexOf(u8, src, marker) orelse return error.LoopMarkerNotFound) + marker.len;
    const end = std.mem.indexOf(u8, src[start..], "\n    }\n};").? + start;
    var i: usize = 0;
    while (std.mem.indexOfPos(u8, src[0..end], start + i, "try")) |at| {
        const before = if (at == 0) 0 else src[at - 1];
        const after = src[at + 3];
        const word = (std.ascii.isAlphanumeric(before) or before == '_') or (std.ascii.isAlphanumeric(after) or after == '_');
        if (!word) {
            std.debug.print("try inside the daemon loop body at byte {d}\n", .{at});
            return error.TryInLoopBody;
        }
        i = at - start + 3;
    }
}

test "the runtime wire matches protocol.version" {
    const name = "fixtures/protocol.schema";
    // The viewer protocol version covers viewer.open and viewer.sync (viewer.schema).
    const viewer = [_]type{ protocol.Request.Open, protocol.Request.Sync, protocol.Reply(.@"viewer.open"), protocol.Reply(.@"viewer.sync") };
    try migrations.expectWireSchema(Wire, &viewer, "src/" ++ name, @embedFile(name), "protocol.version");
}

/// What a client of `protocol.version` sends and reads.
const Wire = struct {
    requests: protocol.Request,
    snapshot: protocol.Snapshot,
    replies: Replies,
    /// What `agent.subscribe` pushes; the viewer's launcher decodes it.
    launch_preview: launch_preview.Preview,
};
/// One field per op whose reply says more than `ok`.
const Replies = replies: {
    var fields: []const std.builtin.Type.StructField = &.{};
    for (std.enums.values(protocol.Op)) |op| {
        const R = protocol.Reply(op);
        if (@typeInfo(R) == .@"struct" and @typeInfo(R).@"struct".fields.len == 0) continue;
        fields = fields ++ [_]std.builtin.Type.StructField{.{ .name = @tagName(op), .type = R, .default_value_ptr = null, .is_comptime = false, .alignment = @alignOf(R) }};
    }
    break :replies @Type(.{ .@"struct" = .{ .layout = .auto, .fields = fields, .decls = &.{}, .is_tuple = false } });
};

test "every protocol.Rejection can still be returned by a request" {
    // Server.request's own inferred error set is anyerror today: it dispatches
    // into onboarding_import/herdr_adapter/layout.copyTree, which still return
    // anyerror! (reliability-06-wire-errors step 5, not done). Once those are
    // named, @typeInfo(E).error_set stops being null and this starts checking
    // each name for real; until then it only proves the set still resolves.
    const E = @typeInfo(@typeInfo(@TypeOf(Server.request)).@"fn".return_type.?).error_union.error_set;
    const set = @typeInfo(E).error_set orelse return;
    inline for (@typeInfo(protocol.Rejection).error_set.?) |f| {
        comptime var found = false;
        inline for (set) |e| {
            if (comptime std.mem.eql(u8, e.name, f.name)) found = true;
        }
        if (!found) @compileError("protocol.Rejection." ++ f.name ++ " is no longer returned by Server.request");
    }
}

test "a viewer's protocol version is checked before its request is decoded" {
    var s: Server = .{ .socket = "", .executable = "", .build_id = @splat('0') };
    defer s.runtime.deinit();
    var cl: Client = .{ .fd = -1 };
    defer cl.output.deinit(a);
    const old = try std.json.parseFromSlice(std.json.Value, a, "{\"op\":\"viewer.sync\",\"protocol\":1,\"viewer_protocol\":4,\"interests\":\"x\"}", .{});
    defer old.deinit();
    try s.request(&cl, old.arena.allocator(), old.value);
    try std.testing.expectEqualStrings("{\"err\":\"UnsupportedViewerProtocol\",\"viewer_protocol\":3}\n", cl.output.items);
    const current = try std.json.parseFromSlice(std.json.Value, a, "{\"op\":\"viewer.sync\",\"protocol\":1,\"viewer_protocol\":3,\"interests\":\"x\"}", .{});
    defer current.deinit();
    try std.testing.expectError(error.UnexpectedToken, s.request(&cl, current.arena.allocator(), current.value));
}

/// What a sidebar entry shows of an agent's lifecycle.
const Lifecycle = struct {
    state: agents.State,
    attention: agents.Attention,
    fn of(actor: *const Actor) Lifecycle {
        return .{ .state = actor.state.state, .attention = actor.state.attention };
    }
};
/// One line per lifecycle change, so a state that looks stuck can be traced
/// to the hook or screen observation that set it.
fn logState(actor: *const Actor, from: Lifecycle, pane: ?layout.PaneId, cause: []const u8, detail: []const u8) void {
    const to = Lifecycle.of(actor);
    if (std.meta.eql(from, to)) return;
    std.log.scoped(.agent_state).info("{f}", .{std.json.fmt(.{
        .actor = @intFromEnum(actor.id),
        .pane = if (pane) |id| @intFromEnum(id) else null,
        .session = actor.state.sessionId(),
        .cause = cause,
        .detail = detail,
        .from = from.state,
        .to = to.state,
        .attention = to.attention,
    }, .{})});
}
/// Background hooks have no pane.
fn logHook(actor: *const Actor, from: Lifecycle, event: std.json.Value, pane: ?layout.PaneId) void {
    const name = agents.str(event, "hook_event_name");
    const notification = agents.str(event, "notification_type");
    var buffer: [200]u8 = undefined;
    const detail = std.fmt.bufPrint(&buffer, "{s} {s}", .{ name, if (notification.len > 0) notification else agents.str(event, "tool_name") }) catch name;
    logState(actor, from, pane, "hook", std.mem.trimEnd(u8, detail, " "));
}

test "Codex selection rejects delayed ABA observations while detached actors remain addressable" {
    const id = "11111111-1111-4111-8111-111111111111";
    var s: Server = .{ .socket = "/tmp/unused", .executable = "/tmp/corgi", .build_id = @splat('0') };
    defer s.runtime.deinit();
    const terminal = try Terminal.create(40, 4);
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 42;
    try s.runtime.panes.append(a, .{ .id = @enumFromInt(1), .terminal = terminal, .cwd = try a.dupe(u8, "/tmp"), .detection = .{ .pid = 42 } });
    const p = &s.runtime.panes.items[0];
    var snap: codex_observer.Snapshot = .{
        .request = .{
            .pane = @enumFromInt(1),
            .pid = 42,
            .prefix = Codex.titleSession(id).?,
            .generation = p.attachment.generation,
            .title_revision = terminal.title_revision,
        },
        .session = id.*,
        .state = .working,
        .observed_at = 100,
    };
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
    var s: Server = .{ .socket = "/tmp/unused", .executable = "/tmp/corgi", .build_id = @splat('0') };
    defer s.runtime.deinit();
    const terminal = try Terminal.create(40, 4);
    try s.runtime.panes.append(a, .{ .id = @enumFromInt(1), .terminal = terminal, .cwd = try a.dupe(u8, "/tmp") });
    const p = &s.runtime.panes.items[0];
    const actor = try s.runtime.conversations.get(.codex, id);
    actor.state.setName("App server name");
    actor.state.state = .working;
    actor.state.metadata_protocol_at = 123;
    actor.state.observation = .{ .source = .protocol, .completed = 2, .read = 1 };
    const before = actor.state;
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 41;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.title_pid = 42;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expectEqual(actor, p.attachment.actor.?);
    try std.testing.expectEqualDeep(before, actor.state);
    try std.testing.expect(p.attachment.knows(actor.id));
    const generation = p.attachment.generation;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expectEqual(generation, p.attachment.generation);

    p.attachment.detach();
    _ = try s.runtime.conversations.get(.codex, "11111111-1111-4111-8111-111111111112");
    terminal.feed("\x1b]2;11111111-1111-4111-8111-11111...\x07");
    terminal.title_pid = 42;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.feed("\x1b]2;22222222-2222-4222-8222-222222222222\x07");
    terminal.title_pid = 42;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expect(p.attachment.actor == null);
    terminal.feed("\x1b]2;" ++ id ++ "\x07");
    terminal.title_pid = 42;
    terminal.exited = true;
    s.reattachFromTitle(p, .codex, 42);
    try std.testing.expect(p.attachment.actor == null);
}
test "preview subscriptions schedule stale refreshes and publish completion without another request" {
    var preview: launch_preview.Preview = .{ .pending = false };
    preview.options.getPtr(.claude).model = .ascii("before");
    var worker: launch_preview.Worker = .{};
    worker.jobs[0] = .{ .cwd = .initTruncated("/"), .preview = preview, .queued = false, .updated = std.time.milliTimestamp() - 60000 };
    var s: Server = .{ .socket = "", .executable = "", .build_id = @splat('0'), .launch_previews = &worker };
    var cl: Client = .{ .fd = -1, .launch_preview = .{ .cwd = .initTruncated("/"), .preview = preview } };
    defer cl.output.deinit(a);
    s.publishLaunchPreview(&cl);
    try std.testing.expect(worker.jobs[0].?.queued);
    try std.testing.expect(cl.launch_preview.?.preview.pending);
    try std.testing.expectEqualStrings("before", cl.launch_preview.?.preview.options.get(.claude).model.text());
    cl.output.clearRetainingCapacity();
    cl.launch_preview.?.checked = 0;
    worker.jobs[0].?.updated = std.time.milliTimestamp();
    worker.jobs[0].?.preview.pending = false;
    worker.jobs[0].?.preview.options.getPtr(.claude).model = .ascii("after");
    s.publishLaunchPreview(&cl);
    const message = try std.json.parseFromSlice(std.json.Value, a, cl.output.items, .{});
    defer message.deinit();
    try std.testing.expectEqualStrings("agent.preview", agents.str(message.value, "type"));
    try std.testing.expect(!cl.launch_preview.?.preview.pending);
    try std.testing.expectEqualStrings("after", cl.launch_preview.?.preview.options.get(.claude).model.text());
    cl.output.clearRetainingCapacity();
    cl.launch_preview.?.checked = 0;
    s.publishLaunchPreview(&cl);
    try std.testing.expectEqual(@as(usize, 0), cl.output.items.len);
}
