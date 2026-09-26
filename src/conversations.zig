//! Single-writer conversation state. Attachments select actors; selection never
//! changes an actor's identity. All methods run on the daemon thread. Workers
//! receive value snapshots and return observations addressed to stable actor IDs.
const std = @import("std");
const agents = @import("agents.zig");
const providers = @import("providers.zig");

pub const max_actors = 1024;
pub const Actor = struct {
    id: u32,
    state: agents.Agent,
    parent: ?u32 = null,
    pending_native_requests: u32 = 0,
    status_inference: @import("activity_summary.zig").Conversation = .{},
    activity_timeline: @import("activity_timeline.zig").Timeline = .{},
    background_tasks: @import("background_tasks.zig").Inventory = .{},
    workspace: u32 = 0,
    observed_at: i64 = 0,
    tracked_since: i64 = 0,
    child_refresh: bool = false,
    children_observed_at: i64 = 0,
    role: [80]u8 = @splat(0),
    role_len: usize = 0,
    model: @import("codex_files.zig").Name = .{},
    live_usage: @import("live_usage.zig").View = .{},
    native_usage: bool = false,
    native_meter: @import("live_usage.zig").Codex = .{},

    pub fn usageView(actor: *const Actor, now: i64) @import("live_usage.zig").View {
        return if (actor.native_usage) actor.native_meter.meter.view(now) else actor.live_usage;
    }

    pub fn observeHook(actor: *Actor, event: providers.Hook, seq: i64, watched: bool, now: i64) bool {
        const ding = actor.state.observeHook(actor.state.provider, event, seq, watched, now) orelse return false;
        if (actor.state.provider == .claude) {
            if (@import("background_tasks.zig").Inventory.claude(event.background_tasks, now)) |tasks| actor.background_tasks = tasks;
            if (event.kind == .session_end) actor.background_tasks = .{};
        }
        actor.observed_at = @max(actor.observed_at, now);
        return ding;
    }
    // Initial attachment establishes a baseline; historic completions never ring.
    // Repeated polls and reconnects cannot duplicate a completion for the same turn.
    pub fn observeSnapshot(actor: *Actor, s: @import("codex_observer.zig").Snapshot, watched: bool) bool {
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
        agent.state = s.state;
        agent.permission_review = null;
        agent.subagents = s.subagents;
        agent.last_seq = s.observed_at;
        agent.observation.source = .protocol;
        agent.observation.pending_stop = false;
        agent.tool_active = false;
        agent.tool_len = 0;
        const same_turn = std.mem.eql(u8, agent.turnId(), s.turn[0..s.turn_len]);
        if (!same_turn or old_state != s.state or s.state != .working) {
            agent.activity_len = 0;
            agent.compacting = false;
        }
        agent.activity_generation = s.evidence.hash();
        var ding = false;
        if (s.turn_len > 0) {
            @memcpy(agent.turn[0..s.turn_len], s.turn[0..s.turn_len]);
            agent.turn_len = s.turn_len;
            if (s.outcome) |outcome| ding = agent.recordCompletion(agent.turnId(), outcome, .protocol, binding) and outcome == .completed and !watched;
        }
        agent.attention = if (s.state == .blocked and !watched) .needs_input else if (agent.observation.unread()) .finished else .none;
        return ding or (!binding and s.state == .blocked and old_state != .blocked and !watched);
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
    known: [256]u32 = @splat(0),
    known_len: usize = 0,

    pub fn agent(binding: *const Attachment) *agents.Agent {
        return if (binding.actor) |actor| &actor.state else @constCast(&binding.provisional);
    }
    pub fn select(binding: *Attachment, actor: *Actor) void {
        if (!binding.knows(actor.id)) {
            if (binding.known_len == binding.known.len) {
                std.mem.copyForwards(u32, binding.known[0 .. binding.known.len - 1], binding.known[1..]);
                binding.known_len -= 1;
            }
            binding.known[binding.known_len] = actor.id;
            binding.known_len += 1;
        }
        if (binding.actor == actor) return;
        binding.actor = actor;
        binding.generation +%= 1;
    }
    pub fn knows(binding: *const Attachment, id: u32) bool {
        return std.mem.indexOfScalar(u32, binding.known[0..binding.known_len], id) != null;
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
    pub fn matches(binding: *const Attachment, generation: u64, actor: u32) bool {
        return binding.generation == generation and binding.actor != null and binding.actor.?.id == actor;
    }
};

pub const Registry = struct {
    allocator: std.mem.Allocator = std.heap.c_allocator,
    items: std.ArrayList(*Actor) = .empty,
    next_id: u32 = 1,

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
    pub fn byId(registry: *const Registry, id: u32) ?*Actor {
        for (registry.items.items) |actor| if (actor.id == id) return actor;
        return null;
    }
    pub fn get(registry: *Registry, provider: agents.Provider, session: []const u8) !*Actor {
        if (provider == .other or session.len == 0 or session.len > 160 or !std.unicode.utf8ValidateSlice(session)) return error.InvalidSession;
        for (session) |ch| if (ch < 32 or ch == 127) return error.InvalidSession;
        if (registry.find(provider, session)) |actor| return actor;
        if (registry.items.items.len == max_actors or registry.next_id == std.math.maxInt(u32)) return error.TooManyConversations;
        const actor = try registry.allocator.create(Actor);
        errdefer registry.allocator.destroy(actor);
        actor.* = .{ .id = registry.next_id, .state = .{ .provider = provider }, .tracked_since = std.time.milliTimestamp() };
        @memcpy(actor.state.session[0..session.len], session);
        actor.state.session_len = session.len;
        try registry.items.append(registry.allocator, actor);
        registry.next_id += 1;
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
    pub fn observeChildren(registry: *Registry, parent: *Actor, snapshot: @import("codex_observer.zig").Snapshot) void {
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
        return if (binding.knows(actor.id)) actor else null;
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
    root.workspace = 7;
    root.tracked_since = 100;
    try std.testing.expect(registry.linkChild(root, child));
    try std.testing.expect(registry.linkChild(child, nested));
    try std.testing.expectEqual(@as(u32, 7), nested.workspace);
    try std.testing.expectEqual(@as(i64, 100), nested.tracked_since);
    try std.testing.expect(!registry.linkChild(nested, root));
    try std.testing.expect(!registry.linkChild(other, child));
    try std.testing.expect(!registry.linkChild(claude, child));
    try std.testing.expect(!registry.linkChild(root, root));
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
    var actor: Actor = .{ .id = 1, .state = .{} };
    var s: @import("codex_observer.zig").Snapshot = .{ .request = .{ .pane = 1, .pid = 1, .prefix = .{} }, .session = "01901234-1234-1234-1234-123456789abc".*, .state = .idle, .turn_len = 1, .outcome = .completed, .observed_at = 1 };
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
        var actor: Actor = .{ .id = 1, .state = .{} };
        var s: @import("codex_observer.zig").Snapshot = .{ .request = .{ .prefix = .{} }, .session = "01901234-1234-1234-1234-123456789abc".*, .state = .working, .turn_len = 1, .observed_at = 1 };
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
    var actor: Actor = .{ .id = 1, .state = .{ .provider = .claude } };
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
