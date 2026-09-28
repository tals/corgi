//! One bounded inference queue shared by providers. Observation and UI never
//! wait for inference. Coalescing and cooldowns prevent unchanged polls billing.
const std = @import("std");
const conversations = @import("conversations.zig");
const ActorId = conversations.Actor.Id;
const clock = @import("clock.zig");
const agents = @import("agents.zig");
const summary = @import("activity_summary.zig");
const backend = @import("summary_backend.zig");
const links = @import("link_labels.zig");
const setup = @import("inference_setup.zig");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const max = layout.max_panes;
const max_slots = conversations.max_actors;
const inference = @import("inference.zig");
const live_usage = @import("live_usage.zig");
const runtime = @import("runtime.zig");
const activity_tools = @import("activity_tools.zig");
/// Per-agent spacing between summaries.
const cooldown_ms = 8000;
/// A burst of tool calls is summarized once it has been quiet this long, and
/// at the latest this long after its first unsummarized change. Commentary
/// changes wait only for the cooldown.
const tool_quiet_ms = 5000;
const tool_wait_ms = 30000;
const retry_ms = 60000;
/// With no viewer attached for `away_after_ms`, each agent is summarized at
/// most once per `away_interval_ms`; attaching restores normal timing.
const away_after_ms = 5 * std.time.ms_per_min;
const away_interval_ms = std.time.ms_per_min;
pub const Request = struct {
    actor: ActorId,
    provider: agents.Provider,
    session: [160]u8,
    session_len: usize,
    turn: [160]u8,
    turn_len: usize,
    evidence: summary.Text,
    panes: [max]layout.PaneId = @splat(.none),
    panes_len: usize = 0,
    name: [160]u8 = @splat(0),
    name_len: usize = 0,
    conversation: summary.Conversation = .{},
    generation: u64 = 0,
    completed_tools: u64 = 0,
    turn_epoch: u32 = 0,
    pub fn sameTurn(r: *const Request, other: *const Request) bool {
        return r.actor == other.actor and r.turn_epoch == other.turn_epoch;
    }
};
pub const Result = struct {
    request: Request,
    label: ?summary.Label,
    /// The summary log's request number, for its outcome record.
    number: u64 = 0,
    pub fn apply(r: *const Result, actor: *conversations.Actor) bool {
        if (actor.id != r.request.actor) return false;
        const agent = &actor.state;
        if (r.stale(agent)) |reason| {
            backend.outcome(r.number, reason);
            return false;
        }
        backend.outcome(r.number, null);
        const label = r.label orelse {
            agent.activity_len = 0;
            agent.activity_inferred = false;
            return true;
        };
        @memcpy(agent.activity[0..label.len], label.text());
        agent.activity_len = label.len;
        agent.activity_inferred = true;
        actor.status_inference.remember(agent.turnId(), r.request.evidence.text(), label);
        const now = std.time.milliTimestamp();
        if (!agent.compacting) actor.activity_timeline.checkpoint(agent.turnId(), label, actor.usageView(now), now);
        return true;
    }
    fn stale(r: *const Result, agent: *const agents.Agent) ?backend.Discard {
        if (agent.state != .working) return .not_working;
        if (agent.turn_epoch != r.request.turn_epoch) return .turn_changed;
        if (agent.activity_generation != r.request.generation) return .evidence_changed;
        return null;
    }
};
const Slot = struct {
    request: Request,
    commentary: summary.Text = .{},
    tool_evidence: summary.Text = .{},
    next: i64 = 0,
    attempted_tools: u64 = 0,
    attempted_evidence: ?u64 = null,
    attempted_commentary: ?u64 = null,
    attempted_at: i64 = 0,
    /// Last tool evidence change, and the first one not yet summarized (0 when none).
    tools_changed_at: i64 = 0,
    tools_pending_since: i64 = 0,
    retry: bool = false,
    active: bool = true,
    result: ?Result = null,
    fn ready(s: *const Slot, now: i64, away: bool) bool {
        if (!s.active or now < s.next or s.request.evidence.len == 0) return false;
        if (s.retry) return true;
        const attempted = s.attempted_evidence orelse return true;
        // Repeating the same calls leaves the evidence, and so the label, unchanged.
        if (attempted == s.request.evidence.hash()) return false;
        if (away and now - s.attempted_at < away_interval_ms) return false;
        if (s.attempted_commentary != s.commentary.hash()) return true;
        return now - s.tools_changed_at >= tool_quiet_ms or now - s.tools_pending_since >= tool_wait_ms;
    }
    fn combine(s: *Slot) void {
        s.request.evidence = s.tool_evidence;
        s.request.evidence.append(s.commentary.text());
    }
    fn updateTools(s: *Slot, evidence: summary.Text, now: i64) void {
        if (!std.mem.eql(u8, s.tool_evidence.text(), evidence.text())) {
            s.tools_changed_at = now;
            if (s.tools_pending_since == 0) s.tools_pending_since = now;
        }
        s.tool_evidence = evidence;
        s.combine();
    }
    /// Record that the current evidence is being summarized.
    fn attempt(s: *Slot, now: i64) void {
        s.attempted_tools = s.request.completed_tools;
        s.attempted_evidence = s.request.evidence.hash();
        s.attempted_commentary = s.commentary.hash();
        s.attempted_at = now;
        s.tools_pending_since = 0;
        s.retry = false;
        s.next = now + cooldown_ms;
    }
};
pub const Checkpoint = struct {
    const Entry = struct { index: usize, slot: Slot };
    const LinkRequest = struct { slot: usize, generation: u64, key: links.Key, evidence: []const u8 };
    slots: []const Entry,
    link_requests: []const LinkRequest = &.{},
    link_results: [links.capacity]?links.Result = @splat(null),
    pool: inference.Checkpoint,
    next_request: u64,
    choice: setup.Choice,
    launches: setup.Launches,
    remembered: setup.Provider,
    active: ?setup.Provider,
    applied: bool,
    locked: bool,
    cursor: usize,
    link_cursor: usize,
    prefer_links: bool,
    next_global: i64,
};
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: std.atomic.Value(bool) = .init(false),
    slots: []?Slot,
    thread: ?std.Thread = null,
    pausing: bool = false,
    paused: bool = false,
    cursor: usize = 0,
    link_cursor: usize = 0,
    prefer_links: bool = true,
    next_global: i64 = 0,
    /// Scheduling decisions made; `poke` waits for the next one.
    passes: u64 = 0,
    implementation: backend.Backend,
    system_meter: live_usage.Meter = .{ .value = .{ .known = true } },
    link_requests: [links.capacity]?links.Request = @splat(null),
    link_results: [links.capacity]?links.Result = @splat(null),
    choice: setup.Choice = .auto,
    launches: setup.Launches = .{},
    remembered: setup.Provider = .codex,
    /// Provider the pool is configured for; applied only by the worker thread.
    active: ?setup.Provider = null,
    applied: bool = false,
    locked: bool = false,
    /// Last time a viewer was attached. Live-only: a new daemon starts observed.
    observed_at: i64 = 0,
    /// The server reports each pass that has an attached viewer.
    pub fn observe(w: *Worker, now: i64) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.observed_at = now;
    }
    /// Viewers and the link cache read this; the pool itself is worker-owned.
    pub fn off(w: *Worker) bool {
        w.mutex.lock();
        defer w.mutex.unlock();
        return w.choice == .off;
    }
    pub fn status(w: *Worker) setup.Status {
        w.mutex.lock();
        defer w.mutex.unlock();
        const provider = if (w.applied) w.active else setup.resolve(w.choice, w.launches, w.remembered);
        var result: setup.Status = .{ .choice = w.choice, .provider = provider, .model = setup.model(provider), .locked = w.locked };
        inline for (comptime std.enums.values(setup.Provider)) |known| {
            @field(result.launches, @tagName(known)) = w.launches.count.get(known);
            @field(result.models, @tagName(known)) = setup.model(known);
        }
        return result;
    }
    pub fn configure(w: *Worker, choice: setup.Choice) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.choice = choice;
        w.applied = false;
        w.locked = false;
        // Failures under the previous provider should not delay the new one.
        for (w.slots) |*entry| if (entry.*) |*slot| if (slot.retry) {
            slot.next = 0;
        };
        w.wake.signal();
    }
    /// Re-evaluate schedules now, e.g. after the test clock moved, and wait
    /// (briefly) until the worker has decided what is due.
    pub fn poke(w: *Worker) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        const before = w.passes;
        w.wake.signal();
        var waited: u64 = 0;
        while (w.passes == before and waited < 2 * std.time.ns_per_s) : (waited += 10 * std.time.ns_per_ms) {
            w.mutex.unlock();
            std.Thread.sleep(10 * std.time.ns_per_ms);
            w.mutex.lock();
        }
    }
    pub fn observeLaunch(w: *Worker, provider: setup.Provider) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.launches.record(provider);
        w.remembered = provider;
    }
    pub fn remember(w: *Worker, provider: setup.Provider) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.remembered = provider;
    }
    /// Worker thread only. Automatic choices re-resolve until a harness answers.
    fn applyChoice(w: *Worker) void {
        w.mutex.lock();
        const wanted = setup.resolve(w.choice, w.launches, w.remembered);
        const change = !w.applied or (!w.locked and wanted != w.active);
        if (change) {
            w.active = wanted;
            w.applied = true;
        }
        w.mutex.unlock();
        if (change) w.implementation.use(wanted);
    }
    pub fn systemUsage(w: *Worker, now: i64) live_usage.View {
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
        return .{ .slots = slots, .implementation = implementation, .observed_at = clock.milliTimestamp() };
    }
    pub fn start(choice: setup.Choice) !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = try init(.{});
        w.choice = choice;
        errdefer a.free(w.slots);
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    /// Finish an already billed request, then park without destroying its
    /// conversation. The server stops publishing new requests while preparing
    /// the handoff. Any failed preparation resumes this same worker.
    pub fn pause(w: *Worker) !void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.pausing = true;
        w.wake.broadcast();
        const deadline = std.time.milliTimestamp() + 47000;
        while (!w.paused) {
            const remaining = deadline - std.time.milliTimestamp();
            if (remaining <= 0) {
                w.pausing = false;
                w.wake.broadcast();
                return error.ReloadInferenceBusy;
            }
            w.wake.timedWait(&w.mutex, @as(u64, @intCast(remaining)) * std.time.ns_per_ms) catch {};
        }
    }
    pub fn unpause(w: *Worker) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.pausing = false;
        w.wake.broadcast();
    }
    /// Capturing a paused worker does not consume pending results or retry work.
    pub fn capture(w: *Worker, alloc: std.mem.Allocator) !Checkpoint {
        w.mutex.lock();
        defer w.mutex.unlock();
        if (!w.paused) return error.InferenceBusy;
        var slots: std.ArrayList(Checkpoint.Entry) = .empty;
        for (w.slots, 0..) |slot, i| if (slot) |entry| try slots.append(alloc, .{ .index = i, .slot = entry });
        var link_requests: std.ArrayList(Checkpoint.LinkRequest) = .empty;
        for (w.link_requests) |entry| if (entry) |request| try link_requests.append(alloc, .{
            .slot = request.slot,
            .generation = request.generation,
            .key = request.key,
            .evidence = try alloc.dupe(u8, request.evidence[0..request.len]),
        });
        return .{
            .slots = try slots.toOwnedSlice(alloc),
            .link_requests = try link_requests.toOwnedSlice(alloc),
            .link_results = w.link_results,
            .pool = try w.implementation.pool.capture(alloc),
            .next_request = w.implementation.next_request,
            .choice = w.choice,
            .launches = w.launches,
            .remembered = w.remembered,
            .active = w.active,
            .applied = w.applied,
            .locked = w.locked,
            .cursor = w.cursor,
            .link_cursor = w.link_cursor,
            .prefer_links = w.prefer_links,
            .next_global = w.next_global,
        };
    }
    /// Allocate and restore before candidate readiness; activate only after
    /// ownership commits. Pre-commit errors must exit without destructors.
    pub fn restore(saved: Checkpoint) !*Worker {
        if (saved.slots.len > max_slots or saved.link_requests.len > links.capacity or saved.cursor >= max_slots or saved.link_cursor >= links.capacity) return error.InvalidCheckpoint;
        const w = try a.create(Worker);
        w.* = try init(.{});
        w.choice = saved.choice;
        w.launches = saved.launches;
        w.remembered = saved.remembered;
        w.active = saved.active;
        w.applied = saved.applied;
        w.locked = saved.locked;
        w.cursor = saved.cursor;
        w.link_cursor = saved.link_cursor;
        w.prefer_links = saved.prefer_links;
        w.next_global = saved.next_global;
        w.implementation.next_request = saved.next_request;
        for (saved.slots) |entry| {
            if (entry.index >= w.slots.len or w.slots[entry.index] != null) return error.InvalidCheckpoint;
            try validateRequest(entry.slot.request);
            if (entry.slot.commentary.len > entry.slot.commentary.bytes.len or entry.slot.tool_evidence.len > entry.slot.tool_evidence.bytes.len) return error.InvalidCheckpoint;
            if (entry.slot.result) |result| {
                try validateRequest(result.request);
                if (result.label) |label| if (label.len > label.bytes.len) return error.InvalidCheckpoint;
            }
            w.slots[entry.index] = entry.slot;
        }
        for (saved.link_requests) |request| {
            if (request.slot >= links.capacity or request.evidence.len > @sizeOf(@FieldType(links.Request, "evidence")) or w.link_requests[request.slot] != null) return error.InvalidCheckpoint;
            var restored: links.Request = .{ .slot = request.slot, .generation = request.generation, .key = request.key, .len = request.evidence.len };
            @memcpy(restored.evidence[0..restored.len], request.evidence);
            w.link_requests[request.slot] = restored;
        }
        for (saved.link_results, 0..) |entry, i| if (entry) |result| {
            if (result.slot != i) return error.InvalidCheckpoint;
            if (result.name) |name| try links.validateName(name);
            w.link_results[i] = result;
        };
        try w.implementation.pool.restore(saved.pool);
        w.system_meter = saved.pool.system_usage.meter;
        return w;
    }
    pub fn activate(w: *Worker) !void {
        std.debug.assert(w.thread == null);
        w.thread = try std.Thread.spawn(.{}, run, .{w});
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
    pub fn submit(w: *Worker, owner: *const conversations.Actor, evidence: summary.Text, panes: []const runtime.Pane) void {
        const actor = owner.id;
        const agent = &owner.state;
        if ((agent.state != .working and agent.state != .blocked) or agent.turn_len == 0) return;
        var req: Request = .{
            .actor = actor,
            .provider = owner.provider(),
            .session = agent.session,
            .session_len = agent.session_len,
            .turn = agent.turn,
            .turn_len = agent.turn_len,
            .turn_epoch = agent.turn_epoch,
            .evidence = evidence,
            .generation = agent.activity_generation,
            .conversation = owner.status_inference,
            .name = agent.name,
            .name_len = agent.name_len,
        };
        for (panes) |pane| if (pane.attachment.actor == owner and req.panes_len < req.panes.len) {
            req.panes[req.panes_len] = pane.id;
            req.panes_len += 1;
        };
        w.mutex.lock();
        defer w.mutex.unlock();
        if (w.choice == .off) return;
        const slot = for (w.slots) |*s| {
            if (s.*) |v| {
                if (v.request.actor == actor) break s;
            }
        } else for (w.slots) |*s| {
            if (s.* == null) break s;
        } else return;
        if (slot.* == null or !slot.*.?.request.sameTurn(&req)) slot.* = .{ .request = req };
        slot.*.?.request.panes = req.panes;
        slot.*.?.request.panes_len = req.panes_len;
        slot.*.?.request.name = req.name;
        slot.*.?.request.name_len = req.name_len;
        slot.*.?.request.conversation = owner.status_inference;
        slot.*.?.active = agent.state == .working;
        slot.*.?.commentary = evidence;
        slot.*.?.request.generation = agent.activity_generation;
        slot.*.?.combine();
        w.wake.signal();
    }
    pub fn tools(w: *Worker, actor: ActorId, agent: *const agents.Agent, progress: activity_tools.View) void {
        if (!std.mem.eql(u8, agent.turnId(), progress.turn.text())) return;
        w.mutex.lock();
        defer w.mutex.unlock();
        for (w.slots) |*entry| if (entry.*) |*slot| {
            if (slot.request.actor != actor or slot.request.turn_epoch != agent.turn_epoch) continue;
            // Cumulative counts survive watched-workspace counter resets. If a
            // transcript is replaced, restart the count instead of replaying it.
            if (progress.completed < slot.request.completed_tools) {
                slot.attempted_tools = 0;
                slot.retry = false;
            }
            slot.request.completed_tools = progress.completed;
            slot.updateTools(progress.evidence, clock.milliTimestamp());
            w.wake.signal();
            return;
        };
    }
    pub fn reconcile(w: *Worker, actors: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        for (w.slots) |*slot| if (slot.*) |s| {
            const found = for (actors) |actor| {
                if (actor.id == s.request.actor and (actor.state.state == .working or actor.state.state == .blocked) and
                    actor.state.turn_epoch == s.request.turn_epoch)
                {
                    slot.*.?.active = actor.state.state == .working;
                    slot.*.?.request.conversation = actor.status_inference;
                    break true;
                }
            } else false;
            if (found) continue;
            if (s.result) |result| backend.outcome(result.number, .not_working);
            slot.* = null;
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
        while (!w.stopping.load(.acquire)) {
            w.mutex.lock();
            while (w.pausing and !w.stopping.load(.acquire)) {
                w.paused = true;
                w.wake.broadcast();
                w.wake.wait(&w.mutex);
            }
            w.paused = false;
            w.mutex.unlock();
            if (w.stopping.load(.acquire)) break;
            w.applyChoice();
            w.implementation.pool.refreshUsage();
            w.mutex.lock();
            w.locked = w.locked or w.implementation.pool.started;
            w.system_meter = w.implementation.pool.system_usage.meter;
            if (w.choice == .off) {
                // Settle requests queued before inference was turned off.
                for (&w.link_requests, &w.link_results) |*request, *result| if (request.*) |r| {
                    result.* = .{ .slot = r.slot, .generation = r.generation, .key = r.key, .name = null };
                    request.* = null;
                };
                w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
                w.mutex.unlock();
                continue;
            }
            w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            if (w.pausing or w.stopping.load(.acquire)) {
                w.mutex.unlock();
                continue;
            }
            const now = clock.milliTimestamp();
            const away = now - w.observed_at >= away_after_ms;
            const selected: ?usize = if (now < w.next_global) null else for (0..max_slots) |n| {
                const i = (w.cursor + n) % max_slots;
                if (w.slots[i]) |s| if (s.ready(now, away)) break i;
            } else null;
            const selected_link: ?usize = if (now < w.next_global) null else for (0..links.capacity) |n| {
                const i = (w.link_cursor + n) % links.capacity;
                if (w.link_requests[i] != null) break i;
            } else null;
            w.passes +%= 1;
            if (selected_link != null and (w.prefer_links or selected == null)) {
                const index = selected_link.?;
                const request = w.link_requests[index].?;
                w.link_requests[index] = null;
                w.link_cursor = (index + 1) % links.capacity;
                w.prefer_links = false;
                w.next_global = now + 1000;
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
            w.prefer_links = true;
            const slot = &w.slots[index].?;
            const request = slot.request;
            const tools_since_last = request.completed_tools -| slot.attempted_tools;
            slot.attempt(now);
            w.cursor = (index + 1) % max_slots;
            w.next_global = now + 1000;
            w.mutex.unlock();
            var key_buffer: [32]u8 = undefined;
            const key = request.conversation.key(request.actor, &key_buffer);
            var history: [4][]const u8 = undefined;
            for (request.conversation.recent[0..request.conversation.len], 0..) |*entry, i| history[i] = entry.text();
            const turn = request.turn[0..request.turn_len];
            const attempt = w.implementation.infer(.{
                .provider = @tagName(request.provider),
                .turn = &summary.turnTag(turn),
                .evidence = request.evidence.text(),
                .history = history[0..request.conversation.len],
            }, turn, key, .{
                .actor = request.actor,
                .panes = request.panes[0..request.panes_len],
                .agent_name = request.name[0..request.name_len],
                .session = request.session[0..request.session_len],
                .tools_since_last = tools_since_last,
            }, &w.stopping);
            w.mutex.lock();
            w.system_meter = w.implementation.pool.system_usage.meter;
            // A removed slot means the agent stopped working in this turn.
            var discard: ?backend.Discard = .not_working;
            var superseded: u64 = 0;
            if (w.slots[index]) |*s| {
                if (!s.request.sameTurn(&request)) {
                    discard = .turn_changed;
                } else if (attempt.decision) |decision| {
                    // New tool completions must not starve a busy agent of
                    // summaries. Reject only a changed commentary generation;
                    // later tool waves remain queued behind the cooldown.
                    if (s.request.generation != request.generation) {
                        discard = .evidence_changed;
                    } else {
                        if (s.result) |old| superseded = old.number;
                        s.result = .{ .request = request, .label = decision.label, .number = attempt.request };
                        discard = null;
                    }
                } else {
                    s.retry = true;
                    s.next = clock.milliTimestamp() + retry_ms;
                }
            }
            w.mutex.unlock();
            if (superseded != 0) backend.outcome(superseded, .superseded);
            if (attempt.decision != null) if (discard) |reason| backend.outcome(attempt.request, reason);
        }
    }
};

test "late results cannot overwrite another turn or changed evidence" {
    var actor: conversations.Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .codex, .state = .working, .session_len = 1 } };
    const agent = &actor.state;
    agent.session[0] = 's';
    agent.setTurn("t");
    var text: summary.Text = .{};
    text.append("Checking input");
    agent.activity_generation = text.hash();
    const r: Result = .{ .request = .{
        .actor = @enumFromInt(1),
        .provider = .codex,
        .session = agent.session,
        .session_len = 1,
        .turn = agent.turn,
        .turn_len = 1,
        .turn_epoch = agent.turn_epoch,
        .evidence = text,
        .generation = text.hash(),
    }, .label = summary.Label.parse("Checking input").? };
    try std.testing.expect(r.apply(&actor));
    agent.activity_generation +%= 1;
    try std.testing.expect(!r.apply(&actor));
    agent.activity_generation = text.hash();
    agent.state = .idle;
    try std.testing.expect(!r.apply(&actor));
    agent.state = .working;
    try std.testing.expect(r.apply(&actor));
    agent.beginTurn("u");
    try std.testing.expect(!r.apply(&actor));
    // Returning to the old id is still a later turn.
    agent.setTurn("t");
    try std.testing.expect(!r.apply(&actor));
}

fn testText(value: []const u8) summary.Text {
    var text: summary.Text = .{};
    text.append(value);
    return text;
}

test "commentary refreshes after the cooldown and tool bursts wait until quiet" {
    var s: Slot = .{ .request = .{ .actor = @enumFromInt(1), .provider = .codex, .session = @splat(0), .session_len = 0, .turn = @splat(0), .turn_len = 0, .evidence = .{} } };
    try std.testing.expect(!s.ready(0, false));
    s.commentary = testText("Planning the fix");
    s.combine();
    // The first evidence in a turn needs no tool threshold.
    try std.testing.expect(s.ready(0, false));
    s.attempt(0);
    try std.testing.expect(!s.ready(9000, false));
    s.commentary = testText("Adding the tests");
    s.combine();
    try std.testing.expect(!s.ready(cooldown_ms - 1, false));
    try std.testing.expect(s.ready(cooldown_ms, false));
    s.attempt(10_000);
    // A tool-only change waits for the burst to go quiet...
    s.updateTools(testText("exec: rg focus src\n"), 11_000);
    s.updateTools(testText("exec: rg focus src\nexec: zig build test\n"), 17_000);
    try std.testing.expect(!s.ready(21_999, false));
    try std.testing.expect(s.ready(22_000, false));
    s.attempt(22_000);
    // ...but a burst that never pauses still refreshes after the maximum wait.
    var at: i64 = 23_000;
    var flip = false;
    while (at < 23_000 + tool_wait_ms) : (at += 2000) {
        flip = !flip;
        s.updateTools(testText(if (flip) "exec: a\n" else "exec: b\n"), at);
        try std.testing.expect(!s.ready(at, false));
    }
    try std.testing.expect(s.ready(at, false));
    s.attempt(at);
    // Repeating the summarized calls changes nothing.
    s.updateTools(s.tool_evidence, at + 1000);
    try std.testing.expect(!s.ready(at + tool_wait_ms, false));
    s.retry = true;
    s.next = at + retry_ms;
    try std.testing.expect(!s.ready(at + retry_ms - 1, false));
    try std.testing.expect(s.ready(at + retry_ms, false));
    s.active = false;
    try std.testing.expect(!s.ready(at + retry_ms, false));
}

test "without a viewer each agent is summarized at most once a minute" {
    var s: Slot = .{ .request = .{ .actor = @enumFromInt(1), .provider = .codex, .session = @splat(0), .session_len = 0, .turn = @splat(0), .turn_len = 0, .evidence = .{} } };
    s.commentary = testText("Planning the fix");
    s.combine();
    try std.testing.expect(s.ready(0, true));
    s.attempt(0);
    s.commentary = testText("Adding the tests");
    s.combine();
    try std.testing.expect(s.ready(cooldown_ms, false));
    try std.testing.expect(!s.ready(away_interval_ms - 1, true));
    try std.testing.expect(s.ready(away_interval_ms, true));
}

test "summary slots belong to conversations shared by multiple or detached attachments" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "shared");
    actor.state.state = .working;
    actor.state.setTurn("turn-1");
    var first: conversations.Attachment = .{};
    var second: conversations.Attachment = .{};
    first.select(actor);
    second.select(actor);
    const worker = try std.testing.allocator.create(Worker);
    defer std.testing.allocator.destroy(worker);
    worker.* = try Worker.init(.{});
    defer a.free(worker.slots);
    worker.submit(first.actor.?, .{}, &.{});
    worker.submit(second.actor.?, .{}, &.{});
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
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    const actor = try registry.get(.codex, "shared");
    actor.state.state = .working;
    actor.state.setTurn("turn-1");
    var evidence: summary.Text = .{};
    evidence.append("Tracing focus changes");
    actor.state.activity_generation = evidence.hash();
    const worker = try std.testing.allocator.create(Worker);
    defer std.testing.allocator.destroy(worker);
    worker.* = try Worker.init(.{});
    defer a.free(worker.slots);
    worker.submit(actor, evidence, &.{});
    const first = worker.slots[0].?.request;
    const result: Result = .{ .request = first, .label = summary.Label.parse("Tracing pane focus").? };
    try std.testing.expect(result.apply(actor));
    try std.testing.expectEqual(@as(usize, 1), actor.activity_timeline.len);
    actor.state.state = .idle;
    worker.reconcile(registry.items.items);
    try std.testing.expect(worker.slots[0] == null);
    actor.state.state = .working;
    actor.state.setTurn("turn-2");
    worker.submit(actor, evidence, &.{});
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
    for (0..10) |_| actor.status_inference.remember("turn-2", "New evidence", result.label.?);
    try std.testing.expectEqual(@as(usize, 4), actor.status_inference.len);
}

test "inference completing during compaction waits to resume its timeline phase" {
    var actor: conversations.Actor = .{ .id = @enumFromInt(1), .state = .{ .provider = .codex, .state = .working } };
    _ = actor.observeHook(.{ .kind = .compact_start, .session = "" }, 1, true, 1000);
    const result: Result = .{ .request = .{
        .actor = @enumFromInt(1),
        .provider = .codex,
        .session = actor.state.session,
        .session_len = 0,
        .turn = actor.state.turn,
        .turn_len = 0,
        .turn_epoch = actor.state.turn_epoch,
        .evidence = .{},
    }, .label = summary.Label.parse("Running tests").? };
    try std.testing.expect(result.apply(&actor));
    try std.testing.expectEqual(@as(usize, 1), actor.activity_timeline.len);
    try std.testing.expectEqualStrings("Compacting context", actor.activity_timeline.points[0].label.text());
    _ = actor.observeHook(.{ .kind = .compact_end, .session = "" }, 2, true, 2000);
    try std.testing.expectEqualStrings("Running tests", actor.activity_timeline.points[1].label.text());
}

fn validateRequest(request: Request) !void {
    if (request.session_len > request.session.len or request.turn_len > request.turn.len or
        request.evidence.len > request.evidence.bytes.len or request.panes_len > request.panes.len or
        request.name_len > request.name.len or request.conversation.len > request.conversation.recent.len or
        request.conversation.previous.len > request.conversation.previous.bytes.len) return error.InvalidCheckpoint;
    for (request.conversation.recent) |entry| if (entry.len > entry.bytes.len) return error.InvalidCheckpoint;
}

test "worker live checkpoint preserves queued link evidence and unconsumed results" {
    var worker = try Worker.init(.{});
    defer a.free(worker.slots);
    worker.paused = true;
    const key: links.Key = .{ .workspace = @enumFromInt(1), .pane = @enumFromInt(3), .pid = 7, .port = 3000, .scheme = .http, .address = 9 };
    const evidence = "{\"terminal\":\"Finance dashboard ready\"}";
    var request: links.Request = .{ .slot = 4, .generation = 8, .key = key, .len = evidence.len };
    @memcpy(request.evidence[0..request.len], evidence);
    worker.link_requests[4] = request;
    worker.link_results[5] = .{ .slot = 5, .generation = 9, .key = key, .name = links.Name.parse("Finance") };
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const saved = try worker.capture(arena.allocator());
    const json = try std.json.Stringify.valueAlloc(arena.allocator(), saved, .{});
    const parsed = try std.json.parseFromSlice(Checkpoint, arena.allocator(), json, .{});
    const restored = try Worker.restore(parsed.value);
    defer {
        restored.implementation.deinit();
        a.free(restored.slots);
        a.destroy(restored);
    }
    const pending = restored.link_requests[4].?;
    try std.testing.expectEqualStrings(evidence, pending.evidence[0..pending.len]);
    try std.testing.expectEqual(@as(u64, 8), pending.generation);
    var results: [links.capacity]?links.Result = undefined;
    restored.takeLinks(&results);
    try std.testing.expectEqualStrings("Finance", results[5].?.name.?.text());
    try std.testing.expectEqual(@as(u64, 9), results[5].?.generation);
    restored.takeLinks(&results);
    try std.testing.expect(results[5] == null);
    try std.testing.expect(restored.link_requests[4] != null);
}
