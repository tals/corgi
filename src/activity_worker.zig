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
    pub fn sameTurn(r: *const Request, other: *const Request) bool {
        return r.pane == other.pane and r.provider == other.provider and std.mem.eql(u8, r.session[0..r.session_len], other.session[0..other.session_len]) and std.mem.eql(u8, r.turn[0..r.turn_len], other.turn[0..other.turn_len]);
    }
};
pub const Result = struct {
    request: Request,
    label: summary.Label,
    pub fn apply(r: *const Result, agent: *agents.Agent) bool {
        if (agent.state != .working or agent.provider != r.request.provider or !std.mem.eql(u8, agent.sessionId(), r.request.session[0..r.request.session_len]) or !std.mem.eql(u8, agent.turnId(), r.request.turn[0..r.request.turn_len]) or agent.activity_generation != r.request.evidence.hash()) return false;
        @memcpy(agent.activity[0..r.label.len], r.label.text());
        agent.activity_len = r.label.len;
        return true;
    }
};
const Slot = struct { request: Request, next: i64 = 0, attempted: ?u64 = null, previous: summary.Label = .{}, result: ?Result = null };
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
        if (w.implementation.disabled or agent.state != .working or evidence.len == 0 or agent.turn_len == 0) return;
        const req: Request = .{ .pane = pane, .provider = agent.provider, .session = agent.session, .session_len = agent.session_len, .turn = agent.turn, .turn_len = agent.turn_len, .evidence = evidence };
        w.mutex.lock();
        defer w.mutex.unlock();
        const slot = for (&w.slots) |*s| {
            if (s.*) |v| {
                if (v.request.pane == pane) break s;
            }
        } else for (&w.slots) |*s| {
            if (s.* == null) break s;
        } else return;
        if (slot.* == null or !slot.*.?.request.sameTurn(&req)) slot.* = .{ .request = req } else slot.*.?.request = req;
        w.wake.signal();
    }
    pub fn reconcile(w: *Worker, panes: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        for (&w.slots) |*slot| if (slot.*) |s| {
            const found = for (panes) |p| {
                if (p.id == s.request.pane and !p.terminal.exited and p.agent.state == .working and std.mem.eql(u8, p.agent.sessionId(), s.request.session[0..s.request.session_len]) and std.mem.eql(u8, p.agent.turnId(), s.request.turn[0..s.request.turn_len])) break true;
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
                if (w.slots[i]) |s| if (now >= s.next and (s.attempted == null or s.attempted.? != s.request.evidence.hash())) break i;
            } else null;
            if (selected == null) {
                w.mutex.unlock();
                continue;
            }
            const index = selected.?;
            const request = w.slots[index].?.request;
            const previous = w.slots[index].?.previous;
            w.slots[index].?.attempted = request.evidence.hash();
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
                        if (s.request.evidence.hash() == request.evidence.hash()) s.result = .{ .request = request, .label = value };
                    } else {
                        s.attempted = null;
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
    const r: Result = .{ .request = .{ .pane = 1, .provider = .codex, .session = agent.session, .session_len = 1, .turn = agent.turn, .turn_len = 1, .evidence = text }, .label = summary.Label.parse("Checking input").? };
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
