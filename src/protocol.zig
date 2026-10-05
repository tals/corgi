//! Versioned runtime data. No viewer focus, menus, or screen coordinates belong
//! in a session snapshot. Clients keep selection by the stable IDs below.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const layout = @import("layout.zig");
const surface = @import("pane.zig").surface;
const agents = @import("agents.zig");
const providers = @import("providers.zig");
const native = @import("native.zig");
const NativeId = native.Session.Id;
const agent_order = @import("agent_order.zig");
const git_push = @import("trackers.zig").git_push;
const tokens = @import("usage.zig").tokens;
const live_usage = @import("usage.zig").live;
const context_window = @import("usage.zig").context_window;
const background_tasks = @import("activity.zig").background_tasks;
const inference_setup = @import("inference.zig").setup;
const launch_command = @import("launch.zig").command;
const History = @import("launch.zig").history.History;
const ports = @import("trackers.zig").ports;
const resources = @import("trackers.zig").resources;
const Theme = @import("theme.zig").Theme;
const Terminal = @import("pane.zig").Terminal;
const catalog = @import("import.zig").catalog;
const herdr = @import("import.zig").herdr;
const viewer_version = @import("viewer_version.zig");
const options = @import("corgi_options");

pub const version: u32 = 1;

/// Error names in a reply's `err` that clients branch on. Renaming one of
/// these is a protocol change.
pub const Rejection = error{
    StaleLayout,
    NoPane,
    AmbiguousViewer,
    NoViewer,
    UnsupportedViewerProtocol,
    UnsupportedProtocol,
    ProtocolRequired,
    GitPreviewChanged,
    GitPushInProgress,
    ReloadInProgress,
    NoWorkspace,
    NothingToPush,
    TooManyPushes,
};
/// A reply's `err` as a `Rejection`; any other name is `ServerRejected`.
pub fn rejection(name: []const u8) (Rejection || error{ServerRejected}) {
    inline for (@typeInfo(Rejection).error_set.?) |e| {
        if (std.mem.eql(u8, name, e.name)) return @field(Rejection, e.name);
    }
    return error.ServerRejected;
}

/// Every request the server accepts. The tag is the wire `"op"`; the payload's
/// fields sit beside `op` in the same object. A new op does not compile until
/// it declares its payload here, its envelope in `check`, and what it must
/// not overlap in `exclusion`.
pub const Request = union(enum) {
    hello,
    @"session.command": SessionCommand,
    @"session.locate": struct { pane: layout.PaneId },
    @"session.list",
    @"session.snapshot",
    @"session.subscribe",
    /// A viewer's second connection. The daemon writes a line to it whenever
    /// that viewer's next `viewer.sync` could differ, so the viewer need not
    /// poll; one that cannot watch keeps syncing on its frame clock.
    @"viewer.watch": struct { viewer: u32 },
    @"agent.subscribe": Launch,
    @"viewer.open": Open,
    @"viewer.sync": Sync,
    @"viewer.search": Search,
    @"pane.acknowledge": Acknowledge,
    @"conversation.list",
    @"conversation.acknowledge": struct { conversation: ActorId, through: u64, attention_at: ?i64 = null },
    @"pane.surface": struct { pane: layout.PaneId },
    @"server.reload": struct { executable: []const u8 = "" },
    @"recovery.save",
    @"inference.configure": struct { choice: inference_setup.Choice },
    @"git.push": struct { workspace: WorkspaceId, ref: git_push.RefView },
    @"onboarding.status": struct { operation: u64 },
    @"onboarding.handoff": struct { operation: u64, viewer_pgid: i32, socket: []const u8 = "" },
    @"onboarding.copy": Copy,
    @"agent.command.preview": struct { workspace: WorkspaceId, cwd: []const u8 = "", request: u64, command: []const u8 = "" },
    @"agent.preview": Launch,
    @"agent.track_usage": Launch,
    /// Conversations the launcher can resume. With `follow` on an
    /// `agent.subscribe` connection, the daemon pushes `agent.history`
    /// updates instead of replying: the whole list, then what changes.
    @"agent.history": struct { follow: bool = false },
    @"viewer.list",
    /// `pane` is the caller's pane, for the actions that return to it.
    action: struct { name: []const u8 = "", value: []const u8 = "", viewer: ?u32 = null, pane: ?layout.PaneId = null },
    focus: struct { pane: layout.PaneId, viewer: ?u32 = null },
    @"workspace.switch": struct { workspace: WorkspaceId, viewer: ?u32 = null },
    @"native.start": struct { provider: agents.Provider, cwd: []const u8 = "", workspace: ?WorkspaceId = null },
    @"native.list",
    @"native.stop": struct { session: NativeId },
    @"native.send": struct { session: NativeId, message: std.json.Value },
    @"native.events": struct { session: NativeId, after: u64 = 0 },
    /// `theme` is the viewer's host colors.
    theme: struct { theme: Lenient(Theme) = .{} },
    /// `event` is the provider's own hook payload; its backend decodes it.
    /// A background hook comes from a session no pane runs. `pid` is the
    /// agent process that ran the hook, 0 when unknown.
    hook: struct { provider: agents.Provider, event: std.json.Value, pane: layout.PaneId = .none, seq: ?i64 = null, background: bool = false, pid: i32 = 0 },
    ping,
    shutdown,
    @"test.settle",
    @"test.advance": struct { ms: i64 },

    /// A launcher's folder; an empty `cwd` is the workspace's.
    pub const Launch = struct { workspace: WorkspaceId, cwd: []const u8 = "" };
    /// Commands are written by agents and scripts, so an unknown field inside
    /// one stays an error (UnknownField).
    pub const SessionCommand = struct {
        command: Command,
        pub fn jsonParseFromValue(arena: std.mem.Allocator, v: std.json.Value, _: std.json.ParseOptions) std.json.ParseFromValueError!SessionCommand {
            if (v != .object) return error.UnexpectedToken;
            const command = v.object.get("command") orelse return error.MissingField;
            return .{ .command = try std.json.innerParseFromValue(Command, arena, command, .{}) };
        }
    };
    /// A viewer attaching. `theme` holds its terminal's colors.
    pub const Open = struct { cwd: []const u8 = "", onboarding: bool = false, theme: Lenient(Theme) = .{} };
    /// A viewer's poll: the panes it shows, and the controls it has handled.
    pub const Sync = struct {
        interests: []const Interest,
        session_hash: ?u64 = null,
        focus: ?layout.PaneId = null,
        watched: bool = true,
        workspace: WorkspaceId = .none,
        ack: u64 = 0,
        active: bool = false,
        resource_detail: ?WorkspaceId = null,
        resources: bool = true,
        resources_hash: ?u64 = null,
    };
    pub const Search = struct { pane: layout.PaneId, needle: []const u8, skip: usize = 0 };
    /// A viewer acknowledges only what it showed, for the binding it showed.
    pub const Acknowledge = struct {
        pane: layout.PaneId,
        session: []const u8 = "",
        through: u64 = 0,
        binding: ?u64 = null,
        conversation: ?ActorId = null,
        attention_at: ?i64 = null,
    };
    /// An import plan: the source's workspaces and, for Herdr, the session
    /// they come from. `operation` names it for retries and status polls.
    pub const Copy = struct {
        operation: u64,
        source: catalog.Source,
        workspaces: []const catalog.Workspace,
        herdr_session: ?herdr.SourceSession = null,
        selected: []const []const u8 = &.{},
    };
};
/// Tag names are the exact wire strings (`@tagName` round-trips through `parse`).
pub const Op = std.meta.Tag(Request);
pub fn Payload(comptime op: Op) type {
    return @FieldType(Request, @tagName(op));
}

/// A request as a client writes it: `op`, the versions `check(op)` asks
/// for, then the payload's fields beside them. A null the daemon defaults to
/// anyway stays out, as it did in hand-written requests, so a daemon from
/// before typed payloads reads it as absent.
pub fn Envelope(comptime op: Op) type {
    return struct {
        payload: Payload(op),

        pub fn jsonStringify(e: @This(), w: *std.json.Stringify) std.Io.Writer.Error!void {
            try w.beginObject();
            try w.objectField("op");
            try w.write(@tagName(op));
            if (comptime check(op) != .none) {
                try w.objectField("protocol");
                try w.write(version);
            }
            if (comptime check(op) == .viewer) {
                try w.objectField("viewer_protocol");
                try w.write(viewer_version.version);
            }
            if (Payload(op) != void) inline for (std.meta.fields(Payload(op))) |field| {
                const value = @field(e.payload, field.name);
                const absent = comptime @typeInfo(field.type) == .optional and
                    if (field.defaultValue()) |default| default == null else false;
                if (!absent or value != null) {
                    try w.objectField(field.name);
                    try w.write(value);
                }
            };
            try w.endObject();
        }
    };
}

/// A successful reply as the daemon writes it: `ok`, then the reply's fields.
pub fn Ok(comptime op: Op) type {
    return struct {
        reply: Reply(op),

        pub fn jsonStringify(o: @This(), w: *std.json.Stringify) std.Io.Writer.Error!void {
            try w.beginObject();
            try w.objectField("ok");
            try w.write(true);
            inline for (std.meta.fields(Reply(op))) |field| {
                try w.objectField(field.name);
                try w.write(@field(o.reply, field.name));
            }
            try w.endObject();
        }
    };
}

/// What the daemon answers to `op` besides `ok` and `err`. Unknown fields
/// are ignored, so a newer daemon may add some.
pub fn Reply(comptime op: Op) type {
    return switch (op) {
        .hello => Hello,
        // The viewer's mirror decodes the snapshot into its own storage.
        .@"session.snapshot" => std.json.Value,
        .@"session.command", .@"session.locate" => struct { result: Result },
        .@"viewer.open" => Opened,
        .@"viewer.sync" => View(std.json.Value, std.json.Value),
        .@"viewer.search" => Terminal.SearchResult,
        .@"agent.command.preview" => struct { resolution: launch_command.Resolution },
        .@"agent.history" => struct { history: History },
        .@"inference.configure" => struct { saved: bool = false, inference: inference_setup.Status = .{} },
        .@"onboarding.status" => struct { progress: OnboardingProgress },
        else => struct {},
    };
}

/// A value a request may carry malformed, such as a viewer's colors. It
/// reads as null instead of failing the request.
pub fn Lenient(comptime T: type) type {
    return struct {
        value: ?T = null,

        pub const Json = ?T;
        pub fn jsonStringify(l: @This(), w: *std.json.Stringify) std.Io.Writer.Error!void {
            try w.write(l.value);
        }
        pub fn jsonParseFromValue(arena: std.mem.Allocator, v: std.json.Value, parse_options: std.json.ParseOptions) std.json.ParseFromValueError!@This() {
            return .{ .value = std.json.innerParseFromValue(?T, arena, v, parse_options) catch null };
        }
    };
}

/// The `viewer.open` reply.
pub const Opened = struct {
    viewer_protocol: u32 = viewer_version.version,
    bell_seq: u64,
    workspace: WorkspaceId,
};

/// The `viewer.sync` reply. The daemon writes `session` and `resources` from
/// JSON it has already serialized (to hash it), and the viewer reads them as
/// `std.json.Value`, so each side names how it holds them. Null when
/// unchanged since the hash the viewer sent.
pub fn View(comptime Session: type, comptime Resources: type) type {
    return struct {
        type: []const u8 = "view",
        viewer_protocol: u32 = viewer_version.version,
        session: ?Session = null,
        session_hash: u64,
        resources: ?Resources = null,
        resources_hash: u64 = 0,
        surfaces: []const surface.View,
        bell_seq: u64,
        bell_kind: agents.Attention,
        controls: []const Control,
        viewer: u32,
        detach: bool,
    };
}

/// The `hello` reply. A client may be talking to an older or newer daemon
/// (see updates.zig), so every field has a default.
pub const Hello = struct {
    type: []const u8 = "hello",
    protocol: u32 = 0,
    capabilities: []const []const u8 = &.{},
    server_pid: i32 = 0,
    build_id: []const u8 = "",
    executable: []const u8 = "",
    release_version: []const u8 = "",
    update_abi: []const u8 = "",
};

/// The op of a request object, or null. Test-only ops are unknown in
/// release builds.
pub fn parse(v: std.json.Value) ?Op {
    const op = std.meta.stringToEnum(Op, agents.str(v, "op")) orelse return null;
    return switch (op) {
        .@"test.settle", .@"test.advance" => if (options.test_build) op else null,
        else => op,
    };
}

/// What a request must carry before the server reads it.
pub const Check = enum {
    /// Local controls, hooks and tooling.
    none,
    /// `protocol` on this request; it starts negotiation.
    negotiate,
    /// `protocol` here or from an earlier `hello`.
    runtime,
    /// `viewer_protocol` first, then `protocol`.
    viewer,
};
pub fn check(op: Op) Check {
    return switch (op) {
        .hello => .negotiate,
        .@"viewer.open", .@"viewer.sync" => .viewer,
        .@"session.command",
        .@"session.locate",
        .@"session.list",
        .@"session.snapshot",
        .@"session.subscribe",
        .@"viewer.watch",
        .@"agent.subscribe",
        .@"viewer.search",
        .@"pane.acknowledge",
        .@"conversation.list",
        .@"conversation.acknowledge",
        .@"pane.surface",
        .@"server.reload",
        .@"recovery.save",
        .@"inference.configure",
        .@"git.push",
        .@"onboarding.status",
        .@"onboarding.handoff",
        .@"onboarding.copy",
        .@"agent.command.preview",
        .@"agent.preview",
        .@"agent.track_usage",
        .@"agent.history",
        => .runtime,
        .@"viewer.list",
        .action,
        .focus,
        .@"workspace.switch",
        .@"native.start",
        .@"native.list",
        .@"native.stop",
        .@"native.send",
        .@"native.events",
        .theme,
        .hook,
        .ping,
        .shutdown,
        .@"test.settle",
        .@"test.advance",
        => .none,
    };
}
/// `hello` lists every op that speaks the runtime protocol.
pub const capabilities = list: {
    var names: []const []const u8 = &.{};
    for (std.enums.values(Op)) |op| switch (check(op)) {
        .runtime, .viewer => names = names ++ .{@tagName(op)},
        .none, .negotiate => {},
    };
    break :list names[0..names.len].*;
};

/// Which in-flight daemon transaction a request must not overlap.
/// `Server.admit` owns the predicates; this only classifies.
pub const Exclusion = enum {
    none,
    /// Mutates layout. Refused while an import owns panes.
    layout,
    /// Starts an import. Refused while one runs or a reload is pending.
    import,
    /// Refused while a reload is pending.
    push,
    /// Replaces the daemon. Waits for imports, reloads and pushes.
    reload,
    /// Stops the daemon. Waits for imports.
    shutdown,
};

pub fn exclusion(op: Op) Exclusion {
    return switch (op) {
        .@"session.command" => .layout,
        .@"onboarding.handoff", .@"onboarding.copy" => .import,
        .@"git.push" => .push,
        .@"server.reload" => .reload,
        .shutdown => .shutdown,
        .hello,
        .@"session.locate",
        .@"session.list",
        .@"session.snapshot",
        .@"session.subscribe",
        .@"viewer.watch",
        .@"agent.subscribe",
        .@"viewer.open",
        .@"viewer.sync",
        .@"viewer.search",
        .@"pane.acknowledge",
        .@"conversation.list",
        .@"conversation.acknowledge",
        .@"pane.surface",
        .@"recovery.save",
        .@"inference.configure",
        .@"onboarding.status",
        .@"agent.command.preview",
        .@"agent.preview",
        .@"agent.track_usage",
        .@"agent.history",
        .@"viewer.list",
        .action,
        .focus,
        .@"workspace.switch",
        .@"native.start",
        .@"native.list",
        .@"native.stop",
        .@"native.send",
        .@"native.events",
        .theme,
        .hook,
        .ping,
        .@"test.settle",
        .@"test.advance",
        => .none,
    };
}

/// Reads `op`'s payload from `v` after `check` has passed. Unknown fields are
/// ignored at this level: `op`, `protocol` and `viewer_protocol` sit beside
/// the payload, and a newer client may send more.
pub fn decode(arena: std.mem.Allocator, op: Op, v: std.json.Value) std.json.ParseFromValueError!Request {
    switch (op) {
        inline else => |tag| {
            const name = @tagName(tag);
            return switch (Payload(tag)) {
                void => @unionInit(Request, name, {}),
                else => |T| @unionInit(Request, name, try std.json.parseFromValueLeaky(T, arena, v, .{ .ignore_unknown_fields = true })),
            };
        },
    }
}

pub fn require(v: std.json.Value, negotiated: ?u32) !void {
    const requested = v.object.get("protocol");
    const selected = if (requested) |value| blk: {
        if (value != .integer) return error.UnsupportedProtocol;
        break :blk std.math.cast(u32, value.integer) orelse return error.UnsupportedProtocol;
    } else negotiated orelse return error.ProtocolRequired;
    if (selected != version) return error.UnsupportedProtocol;
}

/// A nonzero wire id as one of the typed ids (`Actor.Id`, `Workspace.Id`, ...).
pub fn typedId(comptime T: type, v: std.json.Value, field: []const u8) !T {
    return @enumFromInt(try id(v, field));
}
pub fn id(v: std.json.Value, field: []const u8) !u32 {
    const value = v.object.get(field) orelse return error.MissingTarget;
    if (value != .integer) return error.InvalidTarget;
    const n = std.math.cast(u32, value.integer) orelse return error.InvalidTarget;
    if (n == 0) return error.InvalidTarget;
    return n;
}

pub const GitCommit = struct { timestamp: i64 = 0, hash: []const u8, subject: []const u8, author: []const u8, date: []const u8 };
pub const Workspace = struct {
    id: WorkspaceId,
    name: []const u8,
    custom_name: []const u8,
    cwd: []const u8,
    model: layout.Model,
    agent_order: []const agent_order.Target = &.{},
    /// The agent `New` repeats here; null follows `Snapshot.last_agent`.
    last_agent: ?agents.Provider = null,
    /// Closed agents `undo-close` can reopen here.
    closed_agents: usize = 0,
    git_commits: []const GitCommit = &.{},
    git_ahead: ?u64 = null,
    git_ref: git_push.RefView = .{},
    git_push: git_push.View = .{},
    stats: tokens.Counts = .{},
};
pub const Agent = struct {
    conversation: ActorId = .none,
    subagents: agents.Subagents = .{},
    name: []const u8 = "",
    observation: agents.observation.State = .{},
    recent_activity: []const u8 = "",
    changed_at: i64 = 0,
    /// Null when the pane is not running a known agent.
    provider: ?agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    session: []const u8,
    activity: []const u8,
    cwd: []const u8,
    tool_active: bool,
    compacting: bool = false,
    paused: bool = false,

    pub fn providerName(agent: Agent) []const u8 {
        return if (agent.provider) |provider| @tagName(provider) else "agent";
    }
};
pub const Pane = struct {
    binding: u64 = 0,
    name: []const u8 = "",
    id: layout.PaneId,
    workspace: WorkspaceId,
    tab: layout.TabId,
    cwd: []const u8,
    pid: i32,
    cols: u16,
    rows: u16,
    exited: bool,
    agent: Agent,
    /// The command a reopened agent runs, until it draws over its old screen.
    restoring: []const u8 = "",
};
pub const Native = struct {
    agent: ?Agent = null,
    observation: agents.observation.State = .{},
    id: NativeId,
    workspace: WorkspaceId,
    provider: agents.Provider,
    cwd: []const u8,
    ready: bool,
    exited: bool,
    state: agents.State,
    attention: agents.Attention,
    tool_active: bool,
    compacting: bool = false,
};
pub const Conversation = struct {
    pub const ActivityPoint = struct { at: i64, activity: []const u8, usage: live_usage.View };
    pub const Timeline = struct { points: []const ActivityPoint = &.{}, pending: live_usage.View = .{} };
    background_tasks: background_tasks.View = .{},
    id: ActorId,
    timeline: Timeline = .{},
    /// The first-party model id; Bedrock and Vertex spellings are resolved.
    model: []const u8 = "",
    /// Its display name, such as "Opus 5.5"; empty for an unknown shape.
    model_name: []const u8 = "",
    parent: ?ActorId = null,
    workspace: WorkspaceId = .none,
    observed_at: i64 = 0,
    attachments: u32 = 0,
    role: []const u8 = "",
    usage: live_usage.View = .{},
    context: context_window.View = .{},
    children_observed_at: i64 = 0,
    agent: Agent,

    /// The model's name, or its id from a daemon that sends no name.
    pub fn modelLabel(c: Conversation) []const u8 {
        return if (c.model_name.len > 0) c.model_name else c.model;
    }
};
pub const Snapshot = struct {
    release_version: []const u8 = "",
    release_commit: []const u8 = "",
    staged_version: []const u8 = "",
    system_model: []const u8 = "",
    system_model_name: []const u8 = "",
    inference: inference_setup.Status = .{},
    system_working: bool = false,
    system_usage: live_usage.View = .{},
    last_agent: agents.Provider = .codex,
    agent_yolo: providers.Each(bool, false) = .{},
    agent_hidden: providers.Each(bool, false) = .{},
    agent_commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    conversations: []const Conversation = &.{},
    ports: ports.Snapshot = .{},
    resources: resources.Snapshot = .{},
    type: []const u8 = "session",
    protocol: u32 = version,
    server_pid: i32,
    revision: u64,
    workspaces: []Workspace,
    panes: []const Pane,
    native_sessions: []const Native,
    closed_panes: usize,
};
/// How far an import has come, for `onboarding.status`.
pub const OnboardingProgress = struct {
    phase: Phase = .idle,
    completed: usize = 0,
    total: usize = 0,
    workspace: ?WorkspaceId = null,
    message: []const u8 = "",

    /// A copy is `copying` until it ends; the others are a Herdr handoff's.
    pub const Phase = enum(u8) { idle, connecting, receiving, preparing, committing, copying, complete, failed };
};
/// A pane a viewer shows, at its size. The daemon sizes each pane for the
/// most recently used viewer showing it.
pub const Interest = struct { pane: layout.PaneId, cols: u16, rows: u16, offset: ?usize = null, known: ?surface.Stamp = null };
/// A request queued for one viewer, delivered in `viewer.sync` until acknowledged by `seq`.
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
const PaneTarget = struct { target: layout.PaneId };
const TabTarget = struct { target: layout.TabId };
const PaneRename = struct { target: layout.PaneId, name: []const u8 };
const TabRename = struct { target: layout.TabId, name: []const u8 };
pub const Beside = struct { other: layout.PaneId, direction: layout.Direction = .right };
pub const Destination = union(enum) { before: layout.TabId, after: layout.TabId, workspace: WorkspaceId };
/// The `session.command` request: one edit to shared session state.
pub const Command = union(enum) {
    @"agent.move": struct { workspace: WorkspaceId, target: agent_order.Target, before: ?agent_order.Target = null },
    @"agent.command": struct {
        index: usize,
        command: []const u8,
        hidden: bool = false,
        name: ?[]const u8 = null,
        original: ?[]const u8 = null,
        semantics: ?launch_command.Semantics = null,
        resolve: bool = true,
        cwd: ?[]const u8 = null,
    },
    @"agent.command.create": struct { workspace: WorkspaceId, cwd: []const u8 = "", index: usize },
    @"agent.visibility": struct { hidden: providers.Each(bool, false) },
    @"agent.yolo": struct { provider: providers.Provider, enabled: bool },
    @"agent.create": struct { workspace: WorkspaceId, cwd: []const u8 = "", provider: ?providers.Provider = null },
    /// Continue `provider`'s conversation `session` in a new tab, in the
    /// folder it ran in.
    @"agent.resume": struct { workspace: WorkspaceId, cwd: []const u8, provider: providers.Provider, session: []const u8 },
    @"pane.create": struct {
        workspace: WorkspaceId,
        from: ?layout.PaneId = null,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.split": struct {
        target: layout.PaneId,
        direction: layout.Direction = .right,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.close": PaneTarget,
    @"tab.close": TabTarget,
    @"pane.restore": struct { workspace: WorkspaceId },
    @"workspace.create": struct { name: []const u8 = "", cwd: []const u8 },
    @"workspace.edit": struct {
        target: WorkspaceId,
        name: ?[]const u8 = null,
        cwd: ?[]const u8 = null,
    },
    @"workspace.close": struct { target: WorkspaceId, close_contents: bool = false },
    @"workspace.move": struct { target: WorkspaceId, before: WorkspaceId },
    @"pane.rename": PaneRename,
    @"tab.rename": TabRename,
    @"pane.swap": struct { target: layout.PaneId, other: layout.PaneId },
    @"pane.resize": struct {
        target: layout.PaneId,
        axis: layout.Axis,
        ratio: u16,
    },
    @"split.resize": struct { target: layout.PaneId, direction: layout.Direction },
    @"split.ratio": struct {
        target: layout.PaneId,
        other: layout.PaneId,
        ratio: u16,
        expected: u64,
    },
    @"pane.move": struct {
        target: layout.PaneId,
        destination: union(enum) { beside: Beside, new_tab: []const u8 },
    },
    @"tab.move": struct { target: layout.TabId, destination: Destination },
    @"tab.merge": struct {
        target: layout.TabId,
        other: layout.PaneId,
        direction: layout.Direction = .right,
    },
    @"pane.read": struct {
        target: layout.PaneId,
        lines: usize = 100,
        view: enum { history, screen } = .history,
    },
    @"pane.send": struct {
        target: layout.PaneId,
        text: []const u8,
        enter: bool = false,
    },
    @"pane.keys": struct { target: layout.PaneId, text: []const u8 },
    @"pane.input": struct { target: layout.PaneId, data: []const u8 },
};
/// The `session.command` reply: where the edit landed.
pub const Result = struct {
    pane: layout.PaneId = .none,
    tab: layout.TabId = .none,
    workspace: WorkspaceId = .none,
    text: ?[]const u8 = null,
    closed_panes: []const layout.PaneId = &.{},
};

/// Freshness stamps in a viewer's snapshot are rounded down to this.
pub const stamp_bucket = 5 * std.time.us_per_s;

test "every op decodes a sample request" {
    const samples: std.enums.EnumArray(Op, []const u8) = .init(.{
        .hello = "{}",
        .@"session.command" = "{\"command\":{\"pane.close\":{\"target\":1}}}",
        .@"session.locate" = "{\"pane\":1}",
        .@"session.list" = "{}",
        .@"session.snapshot" = "{}",
        .@"session.subscribe" = "{}",
        .@"viewer.watch" = "{\"viewer\":1}",
        .@"agent.subscribe" = "{\"workspace\":1,\"cwd\":\"/tmp\"}",
        .@"viewer.open" = "{\"viewer_protocol\":3,\"cwd\":\"/tmp\",\"onboarding\":true,\"theme\":{}}",
        .@"viewer.sync" = "{\"viewer_protocol\":3,\"interests\":[{\"pane\":1,\"cols\":80,\"rows\":24}],\"ack\":2}",
        .@"viewer.search" = "{\"pane\":1,\"needle\":\"x\",\"skip\":1}",
        .@"pane.acknowledge" = "{\"pane\":1,\"session\":\"s\",\"through\":2,\"binding\":1,\"conversation\":0,\"attention_at\":-1}",
        .@"conversation.list" = "{}",
        .@"conversation.acknowledge" = "{\"conversation\":1,\"through\":2,\"attention_at\":3}",
        .@"pane.surface" = "{\"pane\":1}",
        .@"server.reload" = "{\"executable\":\"/usr/local/bin/corgi\"}",
        .@"recovery.save" = "{}",
        .@"inference.configure" = "{\"choice\":\"claude\"}",
        .@"git.push" = "{\"workspace\":1,\"ref\":{\"branch\":\"main\"}}",
        .@"onboarding.status" = "{\"operation\":1}",
        .@"onboarding.handoff" = "{\"operation\":1,\"viewer_pgid\":2,\"socket\":\"/tmp/herdr.sock\"}",
        .@"onboarding.copy" = "{\"operation\":1,\"source\":\"tmux\",\"workspaces\":[]}",
        .@"agent.command.preview" = "{\"workspace\":1,\"request\":3,\"command\":\"claude\"}",
        .@"agent.preview" = "{\"workspace\":1}",
        .@"agent.track_usage" = "{\"workspace\":1}",
        .@"agent.history" = "{}",
        .@"viewer.list" = "{}",
        .action = "{\"name\":\"relaunch\",\"value\":\"/usr/local/bin/corgi\",\"pane\":1}",
        .focus = "{\"pane\":1,\"viewer\":2}",
        .@"workspace.switch" = "{\"workspace\":1,\"viewer\":null}",
        .@"native.start" = "{\"provider\":\"codex\",\"cwd\":\"/tmp\",\"workspace\":1}",
        .@"native.list" = "{}",
        .@"native.stop" = "{\"session\":1}",
        .@"native.send" = "{\"session\":1,\"message\":{\"text\":\"hi\"}}",
        .@"native.events" = "{\"session\":1,\"after\":4}",
        .theme = "{\"theme\":{\"foreground\":{\"r\":1,\"g\":2,\"b\":3}}}",
        .hook = "{\"provider\":\"claude\",\"pane\":1,\"seq\":5,\"background\":false,\"event\":{\"hook_event_name\":\"Stop\"}}",
        .ping = "{}",
        .shutdown = "{}",
        .@"test.settle" = "{}",
        .@"test.advance" = "{\"ms\":1000}",
    });
    for (std.enums.values(Op)) |op| {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, samples.get(op), .{});
        defer parsed.deinit();
        const request = decode(parsed.arena.allocator(), op, parsed.value) catch |err| {
            std.debug.print("{s}: {}\n", .{ @tagName(op), err });
            return err;
        };
        try std.testing.expectEqual(op, std.meta.activeTag(request));
    }
}

test "a client's envelope writes what the hand-written requests did" {
    const Case = struct { json: []const u8, envelope: []const u8 };
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const mem = arena.allocator();
    const pane: layout.PaneId = @enumFromInt(3);
    for ([_]Case{
        .{ .json = "{\"op\":\"hello\",\"protocol\":1}", .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.hello){ .payload = {} }, .{}) },
        .{ .json = "{\"op\":\"shutdown\"}", .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.shutdown){ .payload = {} }, .{}) },
        .{
            .json = "{\"op\":\"server.reload\",\"protocol\":1,\"executable\":\"/bin/corgi\"}",
            .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.@"server.reload"){ .payload = .{ .executable = "/bin/corgi" } }, .{}),
        },
        .{
            .json = "{\"op\":\"session.command\",\"protocol\":1,\"command\":{\"pane.close\":{\"target\":3}}}",
            .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.@"session.command"){ .payload = .{ .command = .{ .@"pane.close" = .{ .target = pane } } } }, .{}),
        },
        .{
            .json = "{\"op\":\"viewer.open\",\"protocol\":1,\"viewer_protocol\":3,\"cwd\":\"/tmp\",\"theme\":null,\"onboarding\":true}",
            .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.@"viewer.open"){ .payload = .{ .cwd = "/tmp", .onboarding = true } }, .{}),
        },
        .{
            .json = "{\"op\":\"focus\",\"pane\":3,\"viewer\":2}",
            .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.focus){ .payload = .{ .pane = pane, .viewer = 2 } }, .{}),
        },
        .{
            .json = "{\"op\":\"workspace.switch\",\"workspace\":1}",
            .envelope = try std.json.Stringify.valueAlloc(mem, Envelope(.@"workspace.switch"){ .payload = .{ .workspace = @enumFromInt(1) } }, .{}),
        },
    }) |case| {
        const expected = try std.json.parseFromSliceLeaky(std.json.Value, mem, case.json, .{});
        const actual = try std.json.parseFromSliceLeaky(std.json.Value, mem, case.envelope, .{});
        if (!sameJson(expected, actual)) {
            std.debug.print("expected {s}\n     got {s}\n", .{ case.json, case.envelope });
            return error.TestExpectedEqual;
        }
    }
}

/// Equal JSON values; object keys in any order.
fn sameJson(x: std.json.Value, y: std.json.Value) bool {
    if (std.meta.activeTag(x) != std.meta.activeTag(y)) return false;
    return switch (x) {
        .object => |o| o.count() == y.object.count() and for (o.keys(), o.values()) |k, v| {
            if (!sameJson(v, y.object.get(k) orelse return false)) break false;
        } else true,
        .array => |l| l.items.len == y.array.items.len and for (l.items, y.array.items) |i, j| {
            if (!sameJson(i, j)) break false;
        } else true,
        .string => |t| std.mem.eql(u8, t, y.string),
        .number_string => |t| std.mem.eql(u8, t, y.number_string),
        else => std.meta.eql(x, y),
    };
}

test "a malformed theme reads as none instead of failing the request" {
    for ([_][]const u8{ "{\"theme\":{\"foreground\":7}}", "{\"theme\":\"dark\"}", "{}" }) |json| {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, json, .{});
        defer parsed.deinit();
        const request = try decode(parsed.arena.allocator(), .theme, parsed.value);
        try std.testing.expectEqual(null, request.theme.theme.value);
    }
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"theme\":{\"foreground\":{\"r\":1,\"g\":2,\"b\":3}}}", .{});
    defer parsed.deinit();
    const request = try decode(parsed.arena.allocator(), .theme, parsed.value);
    try std.testing.expectEqual(@as(u8, 2), request.theme.theme.value.?.foreground.?.g);
}

test "a reply's err names a rejection a client can switch on" {
    try std.testing.expectEqual(error.StaleLayout, rejection("StaleLayout"));
    try std.testing.expectEqual(error.GitPushInProgress, rejection("GitPushInProgress"));
    try std.testing.expectEqual(error.ServerRejected, rejection("InvalidJson"));
    try std.testing.expectEqual(error.ServerRejected, rejection(""));
}

test "the ops that wait for an import, a reload or a push" {
    var listed: std.ArrayList(u8) = .empty;
    defer listed.deinit(std.testing.allocator);
    for (std.enums.values(Op)) |op| if (exclusion(op) != .none) {
        try listed.print(std.testing.allocator, "{s} {s}\n", .{ @tagName(op), @tagName(exclusion(op)) });
    };
    try std.testing.expectEqualStrings(
        \\session.command layout
        \\server.reload reload
        \\git.push push
        \\onboarding.handoff import
        \\onboarding.copy import
        \\shutdown shutdown
        \\
    , listed.items);
}

test "a session command stays strict inside a lenient request" {
    const Case = struct { json: []const u8, err: ?std.json.ParseFromValueError = null };
    for ([_]Case{
        .{ .json = "{\"op\":\"session.command\",\"newer\":1,\"command\":{\"pane.close\":{\"target\":3}}}" },
        .{ .json = "{\"op\":\"session.command\",\"command\":{\"pane.close\":{\"target\":3,\"newer\":1}}}", .err = error.UnknownField },
        .{ .json = "{\"op\":\"session.command\",\"command\":{\"pane.move\":{\"target\":3}}}", .err = error.MissingField },
        .{ .json = "{\"op\":\"session.command\"}", .err = error.MissingField },
    }) |case| {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, case.json, .{});
        defer parsed.deinit();
        const decoded = decode(parsed.arena.allocator(), .@"session.command", parsed.value);
        if (case.err) |err| {
            try std.testing.expectError(err, decoded);
        } else {
            const target = (try decoded).@"session.command".command.@"pane.close".target;
            try std.testing.expectEqual(@as(layout.PaneId, @enumFromInt(3)), target);
        }
    }
}

test "shared arrangement round trip is independent of viewer selection" {
    var original: layout.Model = .{};
    const first = try original.newTab("first");
    const split = try original.split(first, .horizontal);
    _ = try original.newTab("second");
    var selection: layout.Selection = .{};
    selection.reconcile(&original);
    try selection.focus(&original, first);
    selection.tab().zoom = true;
    original.moveTab(original.tabs[1].id, 0);
    try original.close(split);
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const encoded = try std.json.Stringify.valueAlloc(arena.allocator(), original, .{});
    const parsed = try std.json.parseFromSlice(layout.Model, arena.allocator(), encoded, .{});
    const restored = parsed.value;
    selection.reconcile(&restored);
    try std.testing.expectEqual(first, selection.tab().focus);
    try std.testing.expectEqual(@as(usize, 1), selection.active);
    try std.testing.expect(selection.tab().zoom);
}
