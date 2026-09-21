//! One bounded inference queue shared by providers. Observation and UI never
//! wait for inference. Coalescing and cooldowns prevent unchanged polls billing.
const std = @import("std");
const agents = @import("agents.zig");
const summary = @import("activity_summary.zig");
const backend = @import("summary_backend.zig");
const a = std.heap.c_allocator;
const max = @import("layout.zig").max_panes;
pub const Request = struct {
    pane: u32,
    provider: agents.Provider,
    session: [160]u8,
    session_len: usize,
    turn: [160]u8,
    turn_len: usize,
    evidence: summary.Text,
    generation: u64 = 0,
    completed_tools: u64 = 0,
    pub fn sameTurn(r: *const Request, other: *const Request) bool {
        return r.pane == other.pane and r.provider == other.provider and std.mem.eql(u8, r.session[0..r.session_len], other.session[0..other.session_len]) and std.mem.eql(u8, r.turn[0..r.turn_len], other.turn[0..other.turn_len]);
    }
};
pub const Result = struct {
    request: Request,
    label: summary.Label,
    pub fn apply(r: *const Result, agent: *agents.Agent) bool {
        if (agent.state != .working or agent.provider != r.request.provider or !std.mem.eql(u8, agent.sessionId(), r.request.session[0..r.request.session_len]) or !std.mem.eql(u8, agent.turnId(), r.request.turn[0..r.request.turn_len]) or agent.activity_generation != r.request.generation) return false;
        @memcpy(agent.activity[0..r.label.len], r.label.text());
        agent.activity_len = r.label.len;
        return true;
    }
};
const Slot = struct {
    request: Request,
    commentary: summary.Text = .{},
    tool_evidence: summary.Text = .{},
    next: i64 = 0,
    attempted_tools: u64 = 0,
    retry: bool = false,
    active: bool = true,
    previous: summary.Label = .{},
    result: ?Result = null,
    fn ready(s: *const Slot, now: i64) bool {
        return s.active and now >= s.next and (s.retry or s.request.completed_tools -| s.attempted_tools >= 3);
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
    slots: [max]?Slot = @splat(null),
    thread: ?std.Thread = null,
    implementation: backend.Backend,
    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{ .implementation = backend.Backend.configured() };
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.stopping.store(true, .release);
        w.mutex.lock();
        w.wake.signal();
        w.mutex.unlock();
        w.thread.?.join();
        a.destroy(w);
    }
    pub fn submit(w: *Worker, pane: u32, agent: *const agents.Agent, evidence: summary.Text) void {
        if (w.implementation.disabled or (agent.state != .working and agent.state != .blocked) or agent.turn_len == 0) return;
        const req: Request = .{ .pane = pane, .provider = agent.provider, .session = agent.session, .session_len = agent.session_len, .turn = agent.turn, .turn_len = agent.turn_len, .evidence = evidence, .generation = agent.activity_generation };
        w.mutex.lock();
        defer w.mutex.unlock();
        const slot = for (&w.slots) |*s| {
            if (s.*) |v| {
                if (v.request.pane == pane) break s;
            }
        } else for (&w.slots) |*s| {
            if (s.* == null) break s;
        } else return;
        if (slot.* == null or !slot.*.?.request.sameTurn(&req)) slot.* = .{ .request = req };
        slot.*.?.active = agent.state == .working;
        slot.*.?.commentary = evidence;
        slot.*.?.request.generation = agent.activity_generation;
        slot.*.?.combine();
        w.wake.signal();
    }
    pub fn tools(w: *Worker, pane: u32, agent: *const agents.Agent, progress: @import("activity_tools.zig").View) void {
        if (!std.mem.eql(u8, agent.turnId(), progress.turn[0..progress.turn_len])) return;
        w.mutex.lock();
        defer w.mutex.unlock();
        for (&w.slots) |*entry| if (entry.*) |*slot| {
            if (slot.request.pane != pane or !std.mem.eql(u8, slot.request.session[0..slot.request.session_len], agent.sessionId()) or !std.mem.eql(u8, slot.request.turn[0..slot.request.turn_len], agent.turnId())) continue;
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
    pub fn reconcile(w: *Worker, panes: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        for (&w.slots) |*slot| if (slot.*) |s| {
            const found = for (panes) |p| {
                if (p.id == s.request.pane and !p.terminal.exited and (p.agent.state == .working or p.agent.state == .blocked) and std.mem.eql(u8, p.agent.sessionId(), s.request.session[0..s.request.session_len]) and std.mem.eql(u8, p.agent.turnId(), s.request.turn[0..s.request.turn_len])) {
                    slot.*.?.active = p.agent.state == .working;
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
        for (&w.slots, 0..) |*s, i| if (s.*) |*slot| {
            out[i] = slot.result;
            slot.result = null;
        };
    }
    fn run(w: *Worker) void {
        var cursor: usize = 0;
        var next_global: i64 = 0;
        while (!w.stopping.load(.acquire)) {
            w.mutex.lock();
            w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            const now = std.time.milliTimestamp();
            const selected: ?usize = if (now < next_global) null else for (0..max) |n| {
                const i = (cursor + n) % max;
                if (w.slots[i]) |s| if (s.ready(now)) break i;
            } else null;
            if (selected == null) {
                w.mutex.unlock();
                continue;
            }
            const index = selected.?;
            const request = w.slots[index].?.request;
            const previous = w.slots[index].?.previous;
            w.slots[index].?.attempted_tools = request.completed_tools;
            w.slots[index].?.retry = false;
            w.slots[index].?.next = now + 20000;
            cursor = (index + 1) % max;
            next_global = now + 5000;
            w.mutex.unlock();
            const label = w.implementation.infer(.{ .provider = @tagName(request.provider), .evidence = request.evidence.text(), .previous = previous.text() }, &w.stopping);
            w.mutex.lock();
            if (w.slots[index]) |*s| {
                if (s.request.sameTurn(&request)) {
                    if (label) |value| {
                        s.previous = value;
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
    var agent: agents.Agent = .{ .provider = .codex, .state = .working, .session_len = 1, .turn_len = 1 };
    agent.session[0] = 's';
    agent.turn[0] = 't';
    var text: summary.Text = .{};
    text.append("Checking input");
    agent.activity_generation = text.hash();
    const r: Result = .{ .request = .{ .pane = 1, .provider = .codex, .session = agent.session, .session_len = 1, .turn = agent.turn, .turn_len = 1, .evidence = text, .generation = text.hash() }, .label = summary.Label.parse("Checking input").? };
    try std.testing.expect(r.apply(&agent));
    agent.turn[0] = 'u';
    try std.testing.expect(!r.apply(&agent));
    agent.turn[0] = 't';
    agent.activity_generation +%= 1;
    try std.testing.expect(!r.apply(&agent));
    agent.activity_generation = text.hash();
    agent.state = .idle;
    try std.testing.expect(!r.apply(&agent));
}

test "tool waves delay first inference and enforce cooldown without losing pending work" {
    var s: Slot = .{ .request = .{ .pane = 1, .provider = .codex, .session = @splat(0), .session_len = 0, .turn = @splat(0), .turn_len = 0, .evidence = .{} } };
    try std.testing.expect(!s.ready(0));
    s.request.completed_tools = 2;
    try std.testing.expect(!s.ready(100000));
    s.request.completed_tools = 3;
    try std.testing.expect(s.ready(100000));
    s.attempted_tools = 3;
    s.next = 120000;
    s.request.completed_tools = 6;
    try std.testing.expect(!s.ready(119999));
    try std.testing.expect(s.ready(120000));
    s.attempted_tools = 6;
    try std.testing.expect(!s.ready(200000));
    s.retry = true;
    s.next = 260000;
    try std.testing.expect(!s.ready(259999));
    try std.testing.expect(s.ready(260000));
    s.active = false;
    try std.testing.expect(!s.ready(300000));
}
