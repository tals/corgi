//! One bounded inference queue shared by providers. Observation and UI never
//! wait for inference. Coalescing and cooldowns prevent unchanged polls billing.
const std = @import("std");
const agents = @import("agents.zig");
const summary = @import("activity_summary.zig");
const backend = @import("summary_backend.zig");
const links = @import("link_labels.zig");
const a = std.heap.c_allocator;
const max = @import("layout.zig").max_panes;
const max_slots = @import("conversations.zig").max_actors;
pub const Request = struct {
    actor: u32,
    provider: agents.Provider,
    session: [160]u8,
    session_len: usize,
    turn: [160]u8,
    turn_len: usize,
    evidence: summary.Text,
    conversation: summary.Conversation = .{},
    generation: u64 = 0,
    completed_tools: u64 = 0,
    pub fn sameTurn(r: *const Request, other: *const Request) bool {
        return r.actor == other.actor and r.provider == other.provider and std.mem.eql(u8, r.session[0..r.session_len], other.session[0..other.session_len]) and std.mem.eql(u8, r.turn[0..r.turn_len], other.turn[0..other.turn_len]);
    }
};
pub const Result = struct {
    request: Request,
    label: summary.Label,
    pub fn apply(r: *const Result, actor: *@import("conversations.zig").Actor) bool {
        if (actor.id != r.request.actor) return false;
        const agent = &actor.state;
        if (agent.state != .working or agent.provider != r.request.provider or !std.mem.eql(u8, agent.sessionId(), r.request.session[0..r.request.session_len]) or !std.mem.eql(u8, agent.turnId(), r.request.turn[0..r.request.turn_len]) or agent.activity_generation != r.request.generation) return false;
        @memcpy(agent.activity[0..r.label.len], r.label.text());
        agent.activity_len = r.label.len;
        agent.activity_inferred = true;
        actor.status_inference.remember(agent.turnId(), r.request.evidence.text(), r.label);
        const now = std.time.milliTimestamp();
        actor.activity_timeline.checkpoint(agent.turnId(), r.label, actor.usageView(now), now);
        return true;
    }
};
const Slot = struct {
    request: Request,
    commentary: summary.Text = .{},
    tool_evidence: summary.Text = .{},
    next: i64 = 0,
    attempted_tools: u64 = 0,
    attempted_evidence: ?u64 = null,
    retry: bool = false,
    active: bool = true,
    result: ?Result = null,
    fn ready(s: *const Slot, now: i64) bool {
        return s.active and now >= s.next and s.request.evidence.len > 0 and
            (s.retry or s.attempted_evidence == null or s.attempted_evidence.? != s.request.evidence.hash() or s.request.completed_tools > s.attempted_tools);
    }
    fn combine(s: *Slot) void {
        s.request.evidence = s.tool_evidence;
        s.request.evidence.append(s.commentary.text());
    }
};
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: std.atomic.Value(bool) = .init(false),
    slots: []?Slot,
    thread: ?std.Thread = null,
    implementation: backend.Backend,
    system_meter: @import("live_usage.zig").Meter = .{ .value = .{ .known = true } },
    link_requests: [links.capacity]?links.Request = @splat(null),
    link_results: [links.capacity]?links.Result = @splat(null),
    pub fn systemUsage(w: *Worker, now: i64) @import("live_usage.zig").View {
        w.mutex.lock();
        defer w.mutex.unlock();
        return w.system_meter.view(now);
    }
    pub fn submitLink(w: *Worker, request: links.Request) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.link_requests[request.slot] = request;
        w.wake.signal();
    }
    pub fn cancelLink(w: *Worker, slot: usize, generation: u64) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        if (w.link_requests[slot]) |request| if (request.generation == generation) {
            w.link_requests[slot] = null;
        };
        if (w.link_results[slot]) |result| if (result.generation == generation) {
            w.link_results[slot] = null;
        };
    }
    pub fn takeLinks(w: *Worker, out: *[links.capacity]?links.Result) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        out.* = w.link_results;
        w.link_results = @splat(null);
    }
    fn init(implementation: backend.Backend) !Worker {
        const slots = try a.alloc(?Slot, max_slots);
        @memset(slots, null);
        return .{ .slots = slots, .implementation = implementation };
    }
    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = try init(backend.Backend.configured());
        errdefer a.free(w.slots);
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.stopping.store(true, .release);
        w.mutex.lock();
        w.wake.signal();
        w.mutex.unlock();
        w.thread.?.join();
        a.free(w.slots);
        a.destroy(w);
    }
    pub fn submit(w: *Worker, owner: *const @import("conversations.zig").Actor, evidence: summary.Text) void {
        const actor = owner.id;
        const agent = &owner.state;
        if (w.implementation.pool.config.disabled or (agent.state != .working and agent.state != .blocked) or agent.turn_len == 0) return;
        const req: Request = .{ .actor = actor, .provider = agent.provider, .session = agent.session, .session_len = agent.session_len, .turn = agent.turn, .turn_len = agent.turn_len, .evidence = evidence, .generation = agent.activity_generation, .conversation = owner.status_inference };
        w.mutex.lock();
        defer w.mutex.unlock();
        const slot = for (w.slots) |*s| {
            if (s.*) |v| {
                if (v.request.actor == actor) break s;
            }
        } else for (w.slots) |*s| {
            if (s.* == null) break s;
        } else return;
        if (slot.* == null or !slot.*.?.request.sameTurn(&req)) slot.* = .{ .request = req };
        slot.*.?.request.conversation = owner.status_inference;
        slot.*.?.active = agent.state == .working;
        slot.*.?.commentary = evidence;
        slot.*.?.request.generation = agent.activity_generation;
        slot.*.?.combine();
        w.wake.signal();
    }
    pub fn tools(w: *Worker, actor: u32, agent: *const agents.Agent, progress: @import("activity_tools.zig").View) void {
        if (!std.mem.eql(u8, agent.turnId(), progress.turn[0..progress.turn_len])) return;
        w.mutex.lock();
        defer w.mutex.unlock();
        for (w.slots) |*entry| if (entry.*) |*slot| {
            if (slot.request.actor != actor or !std.mem.eql(u8, slot.request.session[0..slot.request.session_len], agent.sessionId()) or !std.mem.eql(u8, slot.request.turn[0..slot.request.turn_len], agent.turnId())) continue;
            // Cumulative counts survive watched-workspace counter resets. If a
            // transcript is replaced, seed a fresh wave instead of replaying it.
            if (progress.completed < slot.request.completed_tools) {
                slot.attempted_tools = 0;
                slot.retry = false;
            }
            slot.request.completed_tools = progress.completed;
            slot.tool_evidence = progress.evidence;
            slot.combine();
            w.wake.signal();
            return;
        };
    }
    pub fn reconcile(w: *Worker, actors: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        for (w.slots) |*slot| if (slot.*) |s| {
            const found = for (actors) |actor| {
                if (actor.id == s.request.actor and (actor.state.state == .working or actor.state.state == .blocked) and std.mem.eql(u8, actor.state.sessionId(), s.request.session[0..s.request.session_len]) and std.mem.eql(u8, actor.state.turnId(), s.request.turn[0..s.request.turn_len])) {
                    slot.*.?.active = actor.state.state == .working;
                    slot.*.?.request.conversation = actor.status_inference;
                    break true;
                }
            } else false;
            if (!found) slot.* = null;
        };
    }
    pub fn take(w: *Worker, out: *[max]?Result) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        out.* = @splat(null);
        var count: usize = 0;
        for (w.slots) |*s| if (s.*) |*slot| {
            if (slot.result == null) continue;
            if (count == out.len) break;
            out[count] = slot.result;
            count += 1;
            slot.result = null;
        };
    }
    fn run(w: *Worker) void {
        defer w.implementation.deinit();
        var cursor: usize = 0;
        var link_cursor: usize = 0;
        var prefer_links = true;
        var next_global: i64 = 0;
        while (!w.stopping.load(.acquire)) {
            w.implementation.pool.refreshUsage();
            w.mutex.lock();
            w.system_meter = w.implementation.pool.system_usage.meter;
            w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            const now = std.time.milliTimestamp();
            const selected: ?usize = if (now < next_global) null else for (0..max_slots) |n| {
                const i = (cursor + n) % max_slots;
                if (w.slots[i]) |s| if (s.ready(now)) break i;
            } else null;
            const selected_link: ?usize = if (now < next_global) null else for (0..links.capacity) |n| {
                const i = (link_cursor + n) % links.capacity;
                if (w.link_requests[i] != null) break i;
            } else null;
            if (selected_link != null and (prefer_links or selected == null)) {
                const index = selected_link.?;
                const request = w.link_requests[index].?;
                w.link_requests[index] = null;
                link_cursor = (index + 1) % links.capacity;
                prefer_links = false;
                next_global = now + 1000;
                w.mutex.unlock();
                const result = links.infer(&w.implementation.pool, request, &w.stopping);
                w.mutex.lock();
                w.system_meter = w.implementation.pool.system_usage.meter;
                w.link_results[index] = result;
                w.mutex.unlock();
                continue;
            }
            if (selected == null) {
                w.mutex.unlock();
                continue;
            }
            const index = selected.?;
            prefer_links = true;
            const request = w.slots[index].?.request;
            const previous = request.conversation.previous;
            w.slots[index].?.attempted_tools = request.completed_tools;
            w.slots[index].?.attempted_evidence = request.evidence.hash();
            w.slots[index].?.retry = false;
            w.slots[index].?.next = now + 8000;
            cursor = (index + 1) % max_slots;
            next_global = now + 1000;
            w.mutex.unlock();
            var key_buffer: [32]u8 = undefined;
            const key = request.conversation.key(request.actor, &key_buffer);
            var history: [4][]const u8 = undefined;
            for (request.conversation.recent[0..request.conversation.len], 0..) |*entry, i| history[i] = entry.text();
            const label = w.implementation.infer(.{ .provider = @tagName(request.provider), .evidence = request.evidence.text(), .previous = previous.text(), .turn = request.turn[0..request.turn_len], .history = history[0..request.conversation.len] }, key, &w.stopping);
            w.mutex.lock();
            w.system_meter = w.implementation.pool.system_usage.meter;
            if (w.slots[index]) |*s| {
                if (s.request.sameTurn(&request)) {
                    if (label) |value| {
                        // New tool completions must not starve a busy agent of
                        // summaries. Reject only a changed commentary generation;
                        // later tool waves remain queued behind the cooldown.
                        if (s.request.generation == request.generation) s.result = .{ .request = request, .label = value };
                    } else {
                        s.retry = true;
                        s.next = std.time.milliTimestamp() + 60000;
                    }
                }
            }
            w.mutex.unlock();
        }
    }
};

test "late results cannot overwrite another turn or changed evidence" {
    var actor: @import("conversations.zig").Actor = .{ .id = 1, .state = .{ .provider = .codex, .state = .working, .session_len = 1, .turn_len = 1 } };
    const agent = &actor.state;
    agent.session[0] = 's';
    agent.turn[0] = 't';
    var text: summary.Text = .{};
    text.append("Checking input");
    agent.activity_generation = text.hash();
    const r: Result = .{ .request = .{ .actor = 1, .provider = .codex, .session = agent.session, .session_len = 1, .turn = agent.turn, .turn_len = 1, .evidence = text, .generation = text.hash() }, .label = summary.Label.parse("Checking input").? };
    try std.testing.expect(r.apply(&actor));
    agent.turn[0] = 'u';
    try std.testing.expect(!r.apply(&actor));
    agent.turn[0] = 't';
    agent.activity_generation +%= 1;
    try std.testing.expect(!r.apply(&actor));
    agent.activity_generation = text.hash();
    agent.state = .idle;
    try std.testing.expect(!r.apply(&actor));
}

test "fresh evidence triggers inference without a tool threshold and coalesces during cooldown" {
    var s: Slot = .{ .request = .{ .actor = 1, .provider = .codex, .session = @splat(0), .session_len = 0, .turn = @splat(0), .turn_len = 0, .evidence = .{} } };
    try std.testing.expect(!s.ready(0));
    s.request.evidence.append("Planning the fix");
    try std.testing.expect(s.ready(0));
    s.attempted_evidence = s.request.evidence.hash();
    s.next = 8000;
    try std.testing.expect(!s.ready(9000));
    s.request.evidence.append(" with tests");
    try std.testing.expect(!s.ready(7999));
    try std.testing.expect(s.ready(8000));
    s.attempted_evidence = s.request.evidence.hash();
    // Even identical commands can represent new progress.
    s.request.completed_tools = 1;
    try std.testing.expect(s.ready(8000));
    s.attempted_tools = 1;
    try std.testing.expect(!s.ready(9000));
    s.retry = true;
    s.next = 60000;
    try std.testing.expect(!s.ready(59999));
    try std.testing.expect(s.ready(60000));
    s.active = false;
    try std.testing.expect(!s.ready(60000));
}

test "summary slots belong to conversations shared by multiple or detached attachments" {
    const conversations = @import("conversations.zig");
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "shared");
    actor.state.state = .working;
    actor.state.turn_len = agents.clean(&actor.state.turn, "turn-1");
    var first: conversations.Attachment = .{};
    var second: conversations.Attachment = .{};
    first.select(actor);
    second.select(actor);
    const worker = try std.testing.allocator.create(Worker);
    defer std.testing.allocator.destroy(worker);
    worker.* = try Worker.init(.{});
    defer a.free(worker.slots);
    worker.submit(first.actor.?, .{});
    worker.submit(second.actor.?, .{});
    var count: usize = 0;
    for (worker.slots) |slot| if (slot != null) {
        count += 1;
    };
    try std.testing.expectEqual(@as(usize, 1), count);
    first.detach();
    second.detach();
    worker.reconcile(registry.items.items);
    try std.testing.expect(worker.slots[0] != null);
    try std.testing.expectEqual(actor.id, worker.slots[0].?.request.actor);
    actor.state.state = .idle;
    worker.reconcile(registry.items.items);
    try std.testing.expect(worker.slots[0] == null);
}

test "actor inference context survives turns and detachment but rejects stale results" {
    const conversations = @import("conversations.zig");
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "shared");
    actor.state.state = .working;
    actor.state.turn_len = agents.clean(&actor.state.turn, "turn-1");
    var evidence: summary.Text = .{};
    evidence.append("Tracing focus changes");
    actor.state.activity_generation = evidence.hash();
    const worker = try std.testing.allocator.create(Worker);
    defer std.testing.allocator.destroy(worker);
    worker.* = try Worker.init(.{});
    defer a.free(worker.slots);
    worker.submit(actor, evidence);
    const first = worker.slots[0].?.request;
    const result: Result = .{ .request = first, .label = summary.Label.parse("Tracing pane focus").? };
    try std.testing.expect(result.apply(actor));
    try std.testing.expectEqual(@as(usize, 1), actor.activity_timeline.len);
    actor.state.state = .idle;
    worker.reconcile(registry.items.items);
    try std.testing.expect(worker.slots[0] == null);
    actor.state.state = .working;
    actor.state.turn_len = agents.clean(&actor.state.turn, "turn-2");
    worker.submit(actor, evidence);
    const second = worker.slots[0].?.request;
    var key1: [32]u8 = undefined;
    var key2: [32]u8 = undefined;
    try std.testing.expectEqualStrings(first.conversation.key(actor.id, &key1), second.conversation.key(actor.id, &key2));
    try std.testing.expectEqual(@as(usize, 1), second.conversation.len);
    try std.testing.expectEqualStrings("Tracing pane focus", second.conversation.previous.text());
    try std.testing.expect(!result.apply(actor));
    try std.testing.expectEqual(@as(usize, 1), actor.activity_timeline.len);
    try std.testing.expectEqual(@as(usize, 1), actor.status_inference.len);
    const other = try registry.get(.codex, "different");
    try std.testing.expect(!std.mem.eql(u8, second.conversation.key(actor.id, &key1), other.status_inference.key(other.id, &key2)));
    for (0..10) |_| actor.status_inference.remember("turn-2", "New evidence", result.label);
    try std.testing.expectEqual(@as(usize, 4), actor.status_inference.len);
}
