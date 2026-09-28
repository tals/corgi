//! Single-writer conversation state. Attachments select actors; selection never
//! changes an actor's identity. All methods run on the daemon thread. Workers
//! receive value snapshots and return observations addressed to stable actor IDs.
const std = @import("std");
const agents = @import("agents.zig");
const providers = @import("providers.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const activity_summary = @import("activity_summary.zig");
const activity_timeline = @import("activity_timeline.zig");
const background_tasks = @import("background_tasks.zig");
const detection = @import("detection.zig");
const codex_files = @import("codex_files.zig");
const live_usage = @import("live_usage.zig");
const context_window = @import("context_window.zig");
const codex_observer = @import("codex_observer.zig");
const activity_tools = @import("activity_tools.zig");

pub const max_actors = 1024;
pub const Actor = struct {
    /// Stable for the daemon's lifetime and across checkpoints. Saved and wire
    /// formats carry it as a plain number, where 0 means no conversation.
    pub const Id = enum(u32) {
        _,

        /// Never assigned to an actor.
        pub const none: Id = @enumFromInt(0);
        pub const first: Id = @enumFromInt(1);

        pub fn next(id: Id) Id {
            return @enumFromInt(@intFromEnum(id) + 1);
        }
    };

    id: Id,
    state: agents.Agent,
    parent: ?Id = null,
    pending_native_requests: u32 = 0,
    status_inference: activity_summary.Conversation = .{},
    activity_timeline: activity_timeline.Timeline = .{},
    screen_compacting: bool = false,
    background_tasks: background_tasks.Inventory = .{},
    // Foreground tool calls and background processes have independent lifetimes.
    transcript_tool_active: bool = false,
    prompt_watch: detection.PromptWatch = .{},
    workspace: WorkspaceId = .none,
    observed_at: i64 = 0,
    tracked_since: i64 = 0,
    child_refresh: bool = false,
    children_observed_at: i64 = 0,
    role: [80]u8 = @splat(0),
    role_len: usize = 0,
    model: codex_files.Name = .{},
    // Hooks report the current model on every event; a bounded transcript
    // tail can miss the once-per-turn record, so it only fills gaps.
    model_from_hook: bool = false,
    live_usage: live_usage.View = .{},
    context: context_window.Reading = .{},
    native_usage: bool = false,
    native_meter: live_usage.Codex = .{},

    /// The registry assigns a provider on creation; only a pane's provisional
    /// agent state can lack one.
    pub fn provider(actor: *const Actor) agents.Provider {
        return actor.state.provider.?;
    }
    pub fn usageView(actor: *const Actor, now: i64) live_usage.View {
        return if (actor.native_usage) actor.native_meter.meter.view(now) else actor.live_usage;
    }

    pub fn observeHook(actor: *Actor, event: providers.Hook, seq: i64, watched: bool, now: i64) bool {
        const was_compacting = actor.state.compacting;
        const ding = actor.state.observeHook(actor.provider(), event, seq, watched, now) orelse return false;
        if (actor.state.last_seq == seq) actor.screen_compacting = false;
        if (event.model.len > 0) {
            actor.model.len = agents.clean(&actor.model.bytes, event.model);
            actor.model_from_hook = true;
        }
        actor.compactionChanged(was_compacting, now);
        switch (actor.provider()) {
            .claude => {
                if (background_tasks.Inventory.claude(event.background_tasks, now)) |tasks| actor.background_tasks = tasks;
                if (event.kind == .session_end) actor.background_tasks = .{};
            },
            .codex => {},
        }
        actor.observed_at = @max(actor.observed_at, now);
        return ding;
    }

    fn compactionChanged(actor: *Actor, was_compacting: bool, now: i64) void {
        if (actor.state.compacting == was_compacting) return;
        const ms = @divFloor(now, std.time.us_per_ms);
        if (!actor.state.compacting) actor.activity_timeline.finish(actor.usageView(ms));
        var label: activity_summary.Label = .{};
        const text = if (actor.state.compacting) "Compacting context" else actor.state.activity[0..actor.state.activity_len];
        if (text.len == 0) return;
        label.len = @min(text.len, label.bytes.len);
        while (!std.unicode.utf8ValidateSlice(text[0..label.len])) label.len -= 1;
        @memcpy(label.bytes[0..label.len], text[0..label.len]);
        actor.activity_timeline.checkpoint(actor.state.turnId(), label, actor.usageView(ms), ms);
    }

    /// Live reload restarts the timeline and must retain who can end this phase.
    /// Older checkpoints lack that ownership. Only sessions with no lifecycle
    /// timestamp can safely be assigned to the terminal fallback: a protocol
    /// poll may have replaced the source of a hook-started compaction.
    pub fn restoreCompaction(actor: *Actor, screen_owned: ?bool, now: i64) void {
        if (!actor.state.compacting) return;
        actor.screen_compacting = screen_owned orelse (actor.state.changed_at == 0 and actor.state.observation.source != .hook);
        actor.compactionChanged(false, now);
    }

    /// Some protocols report working but have no compaction flag. A live
    /// terminal status can supplement it without replacing lifecycle state.
    pub fn observeCompactionScreen(actor: *Actor, compacting: ?bool, now: i64) void {
        if (!actor.provider().info().screen.compaction_status or actor.state.state != .working) return;
        const active = compacting orelse return;
        const was_compacting = actor.state.compacting;
        if (active and !was_compacting) {
            actor.state.compacting = true;
            actor.screen_compacting = true;
        } else if (!active and actor.screen_compacting) {
            actor.state.compacting = false;
            actor.screen_compacting = false;
        }
        actor.compactionChanged(was_compacting, now);
    }
    // Initial attachment establishes a baseline; historic completions never ring.
    // Repeated polls and reconnects cannot duplicate a completion for the same turn.
    pub fn observeSnapshot(actor: *Actor, s: codex_observer.Snapshot, watched: bool) bool {
        const agent = &actor.state;
        if (s.observed_at <= agent.last_seq) return false;
        actor.child_refresh = false;
        const binding = agent.last_seq == 0;
        if (agent.session_len != 0 and !std.mem.eql(u8, agent.sessionId(), &s.session)) return false;
        if (binding) {
            agent.reset();
            agent.provider = .codex;
            @memcpy(agent.session[0..36], &s.session);
            agent.session_len = 36;
        }
        if (s.transcript_len > 0) {
            agent.transcript = s.transcript;
            agent.transcript_len = s.transcript_len;
        }
        actor.observed_at = @max(actor.observed_at, s.observed_at);
        actor.background_tasks = s.background_tasks;
        agent.updated_at = s.updated_at;
        agent.metadata_protocol_at = s.observed_at;
        if (s.name_len > 0) {
            agent.name = s.name;
            agent.name_len = s.name_len;
        }
        const old_state = agent.state;
        const was_compacting = agent.compacting;
        agent.state = s.state;
        agent.permission_review = null;
        agent.subagents = s.subagents;
        agent.last_seq = s.observed_at;
        agent.observation.source = .protocol;
        agent.observation.pending_stop = false;
        const same_turn = std.mem.eql(u8, agent.turnId(), s.turn[0..s.turn_len]);
        if (!same_turn or (s.state != .working and s.state != .blocked)) actor.transcript_tool_active = false;
        actor.refreshTranscriptTool();
        agent.tool_len = 0;
        if (!same_turn or old_state != s.state or s.state != .working) {
            agent.activity_len = 0;
            agent.compacting = false;
            actor.screen_compacting = false;
        }
        agent.activity_generation = s.evidence.hash();
        var ding = false;
        if (s.turn_len > 0) {
            @memcpy(agent.turn[0..s.turn_len], s.turn[0..s.turn_len]);
            agent.turn_len = s.turn_len;
            if (s.outcome) |outcome| ding = agent.recordCompletion(agent.turnId(), outcome, .protocol, binding) and outcome == .completed and !watched;
        }
        agent.attention = if (s.state == .blocked and !watched) .needs_input else if (agent.observation.unread()) .finished else .none;
        actor.compactionChanged(was_compacting, s.observed_at);
        return ding or (!binding and s.state == .blocked and old_state != .blocked and !watched);
    }
    pub fn observeTools(actor: *Actor, progress: activity_tools.View) void {
        const agent = &actor.state;
        // Codex tool hooks can end while unified-exec commands keep running;
        // its transcript progress decides which tools are still active.
        switch (actor.provider()) {
            .codex => {},
            .claude => return,
        }
        if (!std.mem.eql(u8, agent.turnId(), progress.turn[0..progress.turn_len])) return;
        actor.transcript_tool_active = !progress.ended and progress.running > 0;
        actor.refreshTranscriptTool();
    }
    fn refreshTranscriptTool(actor: *Actor) void {
        const agent = &actor.state;
        agent.tool_active = (agent.state == .working or agent.state == .blocked) and
            (actor.transcript_tool_active or actor.background_tasks.len > 0);
    }
    pub fn authoritative(actor: *const Actor, now: i64) bool {
        if (actor.state.last_seq == 0) return false;
        return switch (actor.state.observation.source) {
            .hook, .transcript => true,
            // Metadata-only hooks must not refresh an older protocol snapshot.
            .protocol => now - actor.state.last_seq <= 5 * std.time.us_per_s,
            .unknown, .screen => false,
        };
    }
    pub fn screen(actor: *Actor, status: *const agents.Agent, needs_input: bool, now: i64) void {
        if (actor.authoritative(now) or status.observation.source != .screen) return;
        actor.state.state = status.state;
        actor.state.tool_active = status.tool_active;
        actor.state.observation.source = .screen;
        if (needs_input) {
            actor.state.changed_at = now;
            actor.state.attention = .needs_input;
        }
    }
    pub fn confirmStop(actor: *Actor, seq: i64, outcome: agents.observation.Outcome, now: i64) bool {
        return actor.state.confirmStop(seq, outcome, now);
    }
    pub fn acknowledge(actor: *Actor, through: u64, attention_at: ?i64) void {
        if (attention_at) |stamp| if (stamp == actor.state.changed_at) {
            actor.state.attention = .none;
        };
        actor.state.readThrough(through);
    }
};

test "Codex tools survive snapshots but never leak into another turn" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{} };
    var snap: codex_observer.Snapshot = .{
        .request = .{ .prefix = .{} },
        .session = "01901234-1234-1234-1234-123456789abc".*,
        .state = .working,
        .turn_len = 1,
        .observed_at = 1,
    };
    snap.turn[0] = 'a';
    _ = actor.observeSnapshot(snap, true);
    var tools: activity_tools.View = .{ .turn_len = 1, .running = 1 };
    tools.turn[0] = 'a';
    actor.observeTools(tools);
    snap.observed_at += 1;
    _ = actor.observeSnapshot(snap, true);
    try std.testing.expect(actor.state.tool_active);
    tools.running = 0;
    actor.observeTools(tools);
    try std.testing.expect(!actor.state.tool_active);
    snap.background_tasks.append("build", "", "zig build");
    snap.observed_at += 1;
    _ = actor.observeSnapshot(snap, true);
    try std.testing.expect(actor.state.tool_active);
    snap.state = .idle;
    snap.observed_at += 1;
    _ = actor.observeSnapshot(snap, true);
    try std.testing.expect(!actor.state.tool_active);
    snap.state = .working;
    snap.turn[0] = 'b';
    snap.background_tasks = .{};
    snap.observed_at += 1;
    _ = actor.observeSnapshot(snap, true);
    tools.running = 1;
    actor.observeTools(tools);
    try std.testing.expect(!actor.state.tool_active);
}

/// Anonymous screen status is useful even before a provider reveals identity.
/// Screen inference can update the selected actor only while structured evidence is stale.
pub const Attachment = struct {
    actor: ?*Actor = null,
    provisional: agents.Agent = .{},
    generation: u64 = 1,
    selection_hash: u64 = 0,
    hook_seq: i64 = 0,
    // Conversations observed by this process. Old hooks may update them after
    // selection changes, but cannot invent a new session except on SessionStart.
    known: [256]Actor.Id = @splat(.none),
    known_len: usize = 0,

    pub fn agent(binding: *const Attachment) *agents.Agent {
        return if (binding.actor) |actor| &actor.state else @constCast(&binding.provisional);
    }
    pub fn select(binding: *Attachment, actor: *Actor) void {
        if (!binding.knows(actor.id)) {
            if (binding.known_len == binding.known.len) {
                std.mem.copyForwards(Actor.Id, binding.known[0 .. binding.known.len - 1], binding.known[1..]);
                binding.known_len -= 1;
            }
            binding.known[binding.known_len] = actor.id;
            binding.known_len += 1;
        }
        if (binding.actor == actor) return;
        binding.actor = actor;
        binding.generation +%= 1;
    }
    pub fn knows(binding: *const Attachment, id: Actor.Id) bool {
        return std.mem.indexOfScalar(Actor.Id, binding.known[0..binding.known_len], id) != null;
    }
    /// Selection is unknown, but this process can still report known sessions.
    pub fn deselect(binding: *Attachment) void {
        binding.actor = null;
        binding.provisional = .{};
        binding.generation +%= 1;
    }
    /// Process replacement invalidates all source-local associations.
    pub fn detach(binding: *Attachment) void {
        binding.deselect();
        binding.known_len = 0;
        binding.selection_hash = 0;
        binding.hook_seq = 0;
    }
    pub fn matches(binding: *const Attachment, generation: u64, actor: Actor.Id) bool {
        return binding.generation == generation and binding.actor != null and binding.actor.?.id == actor;
    }
};

pub const Registry = struct {
    allocator: std.mem.Allocator = std.heap.c_allocator,
    items: std.ArrayList(*Actor) = .empty,
    next_id: Actor.Id = .first,
    compaction_points: context_window.Points = .{},

    pub fn deinit(registry: *Registry) void {
        for (registry.items.items) |actor| registry.allocator.destroy(actor);
        registry.items.deinit(registry.allocator);
    }
    pub fn find(registry: *const Registry, provider: agents.Provider, session: []const u8) ?*Actor {
        for (registry.items.items) |actor| {
            if (actor.state.provider == provider and std.mem.eql(u8, actor.state.sessionId(), session)) return actor;
        }
        return null;
    }
    pub fn byId(registry: *const Registry, id: Actor.Id) ?*Actor {
        for (registry.items.items) |actor| if (actor.id == id) return actor;
        return null;
    }
    pub fn get(registry: *Registry, provider: agents.Provider, session: []const u8) !*Actor {
        if (session.len == 0 or session.len > 160 or !std.unicode.utf8ValidateSlice(session)) return error.InvalidSession;
        for (session) |ch| if (ch < 32 or ch == 127) return error.InvalidSession;
        if (registry.find(provider, session)) |actor| return actor;
        if (registry.items.items.len == max_actors or @intFromEnum(registry.next_id) == std.math.maxInt(u32)) return error.TooManyConversations;
        const actor = try registry.allocator.create(Actor);
        errdefer registry.allocator.destroy(actor);
        actor.* = .{ .id = registry.next_id, .state = .{ .provider = provider }, .tracked_since = std.time.milliTimestamp() };
        @memcpy(actor.state.session[0..session.len], session);
        actor.state.session_len = session.len;
        try registry.items.append(registry.allocator, actor);
        registry.next_id = registry.next_id.next();
        return actor;
    }
    /// Explicit parent identity is the only way into the child tree. Children
    /// share the registry, so an attached child cannot become a second meter.
    pub fn linkChild(registry: *Registry, parent: *Actor, child: *Actor) bool {
        if (parent.state.provider != child.state.provider) return false;
        if (child.parent) |old| if (old != parent.id) return false;
        var ancestor: ?*Actor = parent;
        for (0..max_actors) |_| {
            const current = ancestor orelse break;
            if (current.id == child.id) return false;
            ancestor = if (current.parent) |id| registry.byId(id) else null;
        } else return false;
        child.parent = parent.id;
        child.workspace = parent.workspace;
        child.tracked_since = parent.tracked_since;
        return true;
    }
    pub fn observeChildren(registry: *Registry, parent: *Actor, snapshot: codex_observer.Snapshot) void {
        if (snapshot.observed_at <= parent.children_observed_at) return;
        if (!snapshot.children_complete) {
            // Retain known identities and usage, but stop claiming a current
            // child census when any discovery page failed.
            parent.children_observed_at = 0;
            return;
        }
        parent.children_observed_at = snapshot.observed_at;
        for (snapshot.children) |meta| {
            const child = registry.get(.codex, &meta.session) catch continue;
            if (!registry.linkChild(parent, child)) continue;
            if (meta.role_len > 0) {
                child.role = meta.role;
                child.role_len = meta.role_len;
            }
            const state = &child.state;
            if (snapshot.observed_at <= state.metadata_protocol_at) continue;
            if (state.state != meta.state or state.updated_at != meta.updated_at or state.last_seq == 0) child.child_refresh = true;
            if (meta.name_len > 0) state.setName(meta.name[0..meta.name_len]);
            if (meta.transcript_len > 0) {
                state.transcript = meta.transcript;
                state.transcript_len = meta.transcript_len;
            }
            state.state = meta.state;
            state.updated_at = meta.updated_at;
            state.metadata_protocol_at = snapshot.observed_at;
            child.observed_at = @max(child.observed_at, snapshot.observed_at);
        }
    }
    /// An initial hook may establish identity when integration was enabled after
    /// startup. Once associated, only SessionStart selects another conversation.
    /// A delayed event from a known conversation does not change UI selection.
    pub fn routeHook(registry: *Registry, binding: *Attachment, provider: agents.Provider, event: providers.Hook) !?*Actor {
        const session = event.session;
        if (session.len == 0) return null;
        if (event.kind == .session_start or
            (binding.actor == null and binding.known_len == 0 and
                (binding.provisional.provider == provider or binding.generation == 1)))
        {
            const actor = try registry.get(provider, session);
            binding.select(actor);
            return actor;
        }
        const actor = registry.find(provider, session) orelse return null;
        if (!binding.knows(actor.id)) return null;
        // A live process no longer shows an ended conversation, so a known one
        // that is still active takes the pane back.
        if (event.kind != .session_end) if (binding.actor) |selected| {
            if (selected != actor and selected.state.state == .done) binding.select(actor);
        };
        return actor;
    }
};

test "child links cannot cross providers reparent or form cycles" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const root = try registry.get(.codex, "root");
    const child = try registry.get(.codex, "child");
    const nested = try registry.get(.codex, "nested");
    const other = try registry.get(.codex, "other");
    const claude = try registry.get(.claude, "root");
    root.workspace = @enumFromInt(7);
    root.tracked_since = 100;
    try std.testing.expect(registry.linkChild(root, child));
    try std.testing.expect(registry.linkChild(child, nested));
    try std.testing.expectEqual(@as(WorkspaceId, @enumFromInt(7)), nested.workspace);
    try std.testing.expectEqual(@as(i64, 100), nested.tracked_since);
    try std.testing.expect(!registry.linkChild(nested, root));
    try std.testing.expect(!registry.linkChild(other, child));
    try std.testing.expect(!registry.linkChild(claude, child));
    try std.testing.expect(!registry.linkChild(root, root));
}

test "compaction hooks partition usage and preserve the summary through repeated or stale events" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .codex, .state = .working } };
    actor.state.setActivity("Reading source");
    actor.activity_timeline.checkpoint("", activity_summary.Label.parse("Reading source").?, .{}, 1);
    actor.live_usage = .{ .known = true, .tokens = .{ .input = 100 } };
    _ = actor.observeHook(.{ .kind = .compact_start, .session = "" }, 1, true, 2000);
    try std.testing.expectEqualStrings("Reading source", actor.state.activity[0..actor.state.activity_len]);
    try std.testing.expectEqualStrings("Compacting context", actor.activity_timeline.points[1].label.text());
    try std.testing.expectEqual(@as(u64, 100), actor.activity_timeline.points[0].usage.tokens.input);
    _ = actor.observeHook(.{ .kind = .compact_start, .session = "" }, 2, true, 3000);
    _ = actor.observeHook(.{ .kind = .compact_end, .session = "" }, 1, true, 4000);
    try std.testing.expect(actor.state.compacting);
    try std.testing.expectEqual(@as(usize, 2), actor.activity_timeline.len);
    try std.testing.expectEqual(@as(i64, 2), actor.activity_timeline.points[1].at);
    actor.live_usage.tokens.input = 160;
    _ = actor.observeHook(.{ .kind = .compact_end, .session = "" }, 3, true, 5000);
    try std.testing.expectEqualStrings("Reading source", actor.activity_timeline.points[2].label.text());
    try std.testing.expectEqual(@as(u64, 60), actor.activity_timeline.points[1].usage.tokens.input);
    try std.testing.expectEqual(@as(u64, 0), actor.activity_timeline.pending(actor.live_usage).tokens.input);
}

test "terminal compaction supplements protocol state without clearing hook compaction" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .codex, .state = .working, .last_seq = 100, .observation = .{ .source = .protocol } } };
    actor.observeCompactionScreen(true, 1000);
    try std.testing.expect(actor.state.compacting);
    try std.testing.expect(actor.authoritative(1001));
    try std.testing.expectEqual(@as(usize, 1), actor.activity_timeline.len);
    actor.observeCompactionScreen(null, 2000);
    try std.testing.expect(actor.state.compacting);
    _ = actor.observeHook(.{ .kind = .session_start, .session = "" }, 101, true, 2100);
    actor.live_usage = .{ .known = true, .tokens = .{ .input = 60 } };
    actor.observeCompactionScreen(false, 3000);
    try std.testing.expect(!actor.state.compacting);
    actor.live_usage.tokens.input = 100;
    try std.testing.expectEqual(@as(u64, 60), actor.activity_timeline.pending(actor.live_usage).tokens.input);
    _ = actor.observeHook(.{ .kind = .compact_start, .session = "" }, 101, true, 4000);
    actor.observeCompactionScreen(false, 5000);
    try std.testing.expect(actor.state.compacting);
    _ = actor.observeHook(.{ .kind = .tool_start, .session = "" }, 102, true, 6000);
    try std.testing.expect(!actor.state.compacting);
}

test "selection preserves conversation receipts and shared acknowledgement" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const a = try registry.get(.codex, "a");
    const b = try registry.get(.codex, "b");
    var first: Attachment = .{};
    var second: Attachment = .{};
    first.select(a);
    second.select(a);
    a.state.observation.finish(.completed, .protocol);
    const old = first.generation;
    first.select(b);
    try std.testing.expect(!first.matches(old, a.id));
    try std.testing.expectEqual(@as(u64, 0), first.agent().observation.completed);
    try std.testing.expect(second.agent().observation.unread());
    a.acknowledge(1, null);
    first.select(a);
    try std.testing.expect(!first.agent().observation.unread());
    try std.testing.expect(!second.agent().observation.unread());
    try std.testing.expect(a != try registry.get(.claude, "a"));
}

test "known background hooks route to their actor and process replacement revokes routing" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var binding: Attachment = .{};
    const a = try registry.get(.claude, "a");
    binding.select(a);
    binding.select(try registry.get(.claude, "b"));
    const event = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"UserPromptSubmit","session_id":"a"}
    , .{});
    defer event.deinit();
    const event_hook = providers.Backend.init(.claude).hook(event.value).?;
    try std.testing.expectEqual(a, (try registry.routeHook(&binding, .claude, event_hook)).?);
    _ = a.observeHook(event_hook, 1, false, 100);
    try std.testing.expectEqual(agents.State.working, a.state.state);
    try std.testing.expectEqualStrings("b", binding.agent().sessionId());
    binding.detach();
    try std.testing.expectEqual(null, try registry.routeHook(&binding, .claude, event_hook));
}

test "a known conversation's live hook replaces an ended selection" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var binding: Attachment = .{};
    const start = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"SessionStart","session_id":"child"}
    , .{});
    defer start.deinit();
    const end = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"SessionEnd","session_id":"child"}
    , .{});
    defer end.deinit();
    const prompt = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"UserPromptSubmit","session_id":"parent"}
    , .{});
    defer prompt.deinit();
    const other = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"UserPromptSubmit","session_id":"other"}
    , .{});
    defer other.deinit();
    const backend = providers.Backend.init(.claude);
    const parent = try registry.get(.claude, "parent");
    binding.select(parent);
    // A session that took the pane over, then ended while the parent lives on.
    const child = (try registry.routeHook(&binding, .claude, backend.hook(start.value).?)).?;
    _ = child.observeHook(backend.hook(end.value).?, 1, false, 100);
    try std.testing.expectEqual(agents.State.done, child.state.state);
    _ = try registry.routeHook(&binding, .claude, backend.hook(end.value).?);
    try std.testing.expectEqual(child, binding.actor.?);
    _ = try registry.get(.claude, "other");
    try std.testing.expectEqual(null, try registry.routeHook(&binding, .claude, backend.hook(other.value).?));
    try std.testing.expectEqual(child, binding.actor.?);
    try std.testing.expectEqual(parent, (try registry.routeHook(&binding, .claude, backend.hook(prompt.value).?)).?);
    try std.testing.expectEqual(parent, binding.actor.?);
}

test "a second attachment does not erase a stop awaiting transcript confirmation" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.claude, "shared");
    const stop = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"Stop","session_id":"shared"}
    , .{});
    defer stop.deinit();
    const stop_hook = providers.Backend.init(.claude).hook(stop.value).?;
    _ = actor.observeHook(stop_hook, 10, false, 100);
    const start = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"SessionStart","session_id":"shared"}
    , .{});
    defer start.deinit();
    const start_hook = providers.Backend.init(.claude).hook(start.value).?;
    var binding: Attachment = .{};
    try std.testing.expectEqual(actor, (try registry.routeHook(&binding, .claude, start_hook)).?);
    _ = actor.observeHook(start_hook, 11, false, 101);
    try std.testing.expect(actor.state.observation.pending_stop);
    try std.testing.expect(actor.confirmStop(10, .completed, 102));
    try std.testing.expectEqual(@as(u64, 1), actor.state.observation.completed);
    try std.testing.expect(!actor.confirmStop(10, .completed, 103));
}

test "first hook establishes identity without process detection but cannot revive a replaced source" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var binding: Attachment = .{};
    const event = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"UserPromptSubmit","session_id":"hook-only"}
    , .{});
    defer event.deinit();
    const event_hook = providers.Backend.init(.claude).hook(event.value).?;
    const actor = (try registry.routeHook(&binding, .claude, event_hook)).?;
    _ = actor.observeHook(event_hook, 1, false, 100);
    try std.testing.expectEqual(agents.State.working, binding.agent().state);
    binding.detach();
    try std.testing.expectEqual(null, try registry.routeHook(&binding, .claude, event_hook));
    try std.testing.expectEqual(@as(usize, 1), registry.items.items.len);
}

test "screen fallback keeps following work after a structured observation expires" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "resumed");
    actor.state.last_seq = 100;
    actor.observed_at = 100;
    actor.state.state = .idle;
    actor.state.observation.source = .protocol;
    var screen_status: agents.Agent = .{ .state = .working, .observation = .{ .source = .screen } };
    actor.screen(&screen_status, false, 200);
    try std.testing.expectEqual(agents.State.idle, actor.state.state);
    const stale = 100 + 6 * std.time.us_per_s;
    screen_status.state = .idle;
    actor.screen(&screen_status, false, stale);
    try std.testing.expect(!actor.authoritative(stale + 1));
    screen_status.state = .working;
    actor.screen(&screen_status, false, stale + 1);
    try std.testing.expectEqual(agents.State.working, actor.state.state);
    screen_status.state = .idle;
    actor.screen(&screen_status, false, stale + 2);
    try std.testing.expectEqual(agents.State.idle, actor.state.state);
    try std.testing.expectEqual(@as(u64, 0), actor.state.observation.completed);
}

test "ignored hooks and attachment metadata cannot refresh protocol lifecycle evidence" {
    var registry: Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "resumed");
    actor.state.state = .idle;
    actor.state.last_seq = 100;
    actor.observed_at = 100;
    actor.state.observation.source = .protocol;
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"hook_event_name":"SessionStart","session_id":"resumed","transcript_path":"/tmp/new-path"}
    , .{});
    defer parsed.deinit();
    var hook = providers.Backend.init(.codex).hook(parsed.value).?;
    _ = actor.observeHook(hook, 99, false, 4 * std.time.us_per_s);
    try std.testing.expectEqual(@as(i64, 100), actor.observed_at);
    try std.testing.expectEqual(@as(usize, 0), actor.state.transcript_len);
    hook.session = "wrong-session";
    _ = actor.observeHook(hook, 101, false, 4 * std.time.us_per_s);
    try std.testing.expectEqual(@as(i64, 100), actor.observed_at);
    hook.session = "resumed";
    _ = actor.observeHook(hook, 101, false, 4 * std.time.us_per_s);
    try std.testing.expectEqualStrings("/tmp/new-path", actor.state.transcript[0..actor.state.transcript_len]);
    try std.testing.expectEqual(@as(i64, 4 * std.time.us_per_s), actor.observed_at);
    try std.testing.expect(!actor.authoritative(6 * std.time.us_per_s));
}

test "snapshot baseline and completion receipts are idempotent" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{} };
    var s: codex_observer.Snapshot = .{
        .request = .{ .pane = @enumFromInt(1), .pid = 1, .prefix = .{} },
        .session = "01901234-1234-1234-1234-123456789abc".*,
        .state = .idle,
        .turn_len = 1,
        .outcome = .completed,
        .observed_at = 1,
    };
    s.turn[0] = 'a';
    try std.testing.expect(!actor.observeSnapshot(s, false));
    try std.testing.expectEqual(@as(u64, 0), actor.state.observation.completed);
    try std.testing.expect(!actor.state.observation.unread());
    s.turn[0] = 'b';
    s.observed_at = 2;
    try std.testing.expect(actor.observeSnapshot(s, false));
    try std.testing.expect(!actor.observeSnapshot(s, false));
    s.observed_at += 1;
    try std.testing.expect(!actor.observeSnapshot(s, false));
    try std.testing.expectEqual(@as(u64, 1), actor.state.observation.completed);
}

test "a snapshot completion records history without overriding active or blocked state" {
    for ([_]agents.State{ .working, .blocked }) |state| {
        var actor: Actor = .{ .id = @enumFromInt(1), .state = .{} };
        var s: codex_observer.Snapshot = .{ .request = .{ .prefix = .{} }, .session = "01901234-1234-1234-1234-123456789abc".*, .state = .working, .turn_len = 1, .observed_at = 1 };
        s.turn[0] = 'a';
        try std.testing.expect(!actor.observeSnapshot(s, false));
        // Thread status and turn history are read separately. The listed turn
        // may already be complete while the thread has moved on to more work.
        s.state = state;
        s.outcome = .completed;
        s.observed_at = 2;
        try std.testing.expect(actor.observeSnapshot(s, false));
        try std.testing.expectEqual(state, actor.state.state);
        try std.testing.expectEqual(@as(u64, 1), actor.state.observation.completed);
        try std.testing.expectEqual(if (state == .blocked) agents.Attention.needs_input else .finished, actor.state.attention);
        actor.acknowledge(1, null);
        s.observed_at = 3;
        try std.testing.expect(!actor.observeSnapshot(s, true));
        try std.testing.expect(!actor.state.observation.unread());
        try std.testing.expectEqual(state, actor.state.state);
    }
}

test "delayed hook endings and transcript confirmations cannot stop resumed work" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .claude } };
    _ = actor.observeHook(.{ .kind = .prompt, .session = "a", .turn = "old" }, 1, false, 10);
    _ = actor.observeHook(.{ .kind = .stop, .session = "a", .turn = "old" }, 2, false, 20);
    try std.testing.expect(actor.state.observation.pending_stop);
    _ = actor.observeHook(.{ .kind = .prompt, .session = "a", .turn = "new" }, 3, false, 30);
    try std.testing.expect(!actor.confirmStop(2, .completed, 40));
    for ([_]@FieldType(providers.Hook, "kind"){ .stop, .interrupt }) |kind| {
        try std.testing.expect(!actor.observeHook(.{ .kind = kind, .session = "a", .turn = "old" }, 4, false, 50));
        try std.testing.expectEqual(agents.State.working, actor.state.state);
        try std.testing.expectEqualStrings("new", actor.state.turnId());
        try std.testing.expectEqual(@as(i64, 30), actor.observed_at);
        try std.testing.expect(!actor.state.observation.pending_stop);
        try std.testing.expectEqual(@as(u64, 0), actor.state.observation.completed);
    }
    _ = actor.observeHook(.{ .kind = .stop, .session = "a", .turn = "new" }, 5, false, 60);
    try std.testing.expect(actor.confirmStop(5, .completed, 70));
    try std.testing.expectEqual(@as(u64, 1), actor.state.observation.completed);
}

test "hook models replace the transcript model and survive events without one" {
    var actor: Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .codex } };
    _ = actor.observeHook(.{ .kind = .prompt, .session = "a", .model = "gpt-6-astra" }, 1, false, 10);
    try std.testing.expectEqualStrings("gpt-6-astra", actor.model.bytes[0..actor.model.len]);
    try std.testing.expect(actor.model_from_hook);
    _ = actor.observeHook(.{ .kind = .tool_start, .session = "a", .tool = "Bash" }, 2, false, 20);
    try std.testing.expectEqualStrings("gpt-6-astra", actor.model.bytes[0..actor.model.len]);
    _ = actor.observeHook(.{ .kind = .prompt, .session = "a", .model = "gpt-6-luna" }, 3, false, 30);
    try std.testing.expectEqualStrings("gpt-6-luna", actor.model.bytes[0..actor.model.len]);
    // Another session's hook is rejected and cannot change the model.
    _ = actor.observeHook(.{ .kind = .prompt, .session = "b", .model = "gpt-6-sol" }, 4, false, 40);
    try std.testing.expectEqualStrings("gpt-6-luna", actor.model.bytes[0..actor.model.len]);
}
