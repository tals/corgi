//! On-demand completion verification. One worker, bounded reads and framing;
//! no transcript IO or JSON parsing on the terminal interaction thread.
const std = @import("std");
const compat = @import("compat.zig");
const conversations = @import("conversations.zig");
const ActorId = conversations.Actor.Id;
const agents = @import("agents.zig");
const common = @import("providers/common.zig");
const Claude = @import("providers/claude.zig").Claude;
const Codex = @import("providers/codex.zig").Codex;
const os = @import("os.zig");
const a = os.allocator;
const max_jobs = @import("layout.zig").max_panes;
const passes = @import("passes.zig");
const log = std.log.scoped(.transcript);
const read_budget = 64 * 1024;
const initial_tail = 256 * 1024;
const record_limit = 64 * 1024;
const Request = struct { actor: ActorId, agent: agents.Agent };
pub const Result = struct { actor: ActorId, seq: i64, outcome: agents.observation.Outcome };

pub const Worker = struct {
    mutex: std.Io.Mutex = .init,
    wake: std.Io.Condition = .init,
    stopping: bool = false,
    passes: passes.Passes = .{},
    requests: std.ArrayList(Request) = .empty,
    cursor: usize = 0,
    results: [max_jobs]?Result = .{null} ** max_jobs,
    thread: ?std.Thread = null,

    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{};
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.mutex.lockUncancelable(os.io());
        w.stopping = true;
        w.wake.signal(os.io());
        w.mutex.unlock(os.io());
        w.thread.?.join();
        w.requests.deinit(a);
        a.destroy(w);
    }
    pub fn reconcile(w: *Worker, actors: anytype) void {
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        w.requests.clearRetainingCapacity();
        for (actors) |actor| {
            const agent = &actor.state;
            if (!agent.observation.pending_stop or agent.transcript.len == 0 or agent.session.len == 0) continue;
            w.requests.append(a, .{ .actor = actor.id, .agent = agent.* }) catch |err| {
                log.warn("queuing completion request: {}", .{err});
                break;
            };
        }
        w.wake.signal(os.io());
    }
    fn batch(w: *Worker, out: *[max_jobs]Request) []Request {
        const count = @min(out.len, w.requests.items.len);
        for (0..count) |i| out[i] = w.requests.items[(w.cursor + i) % w.requests.items.len];
        if (w.requests.items.len > 0) w.cursor = (w.cursor + count) % w.requests.items.len;
        return out[0..count];
    }
    pub fn take(w: *Worker, out: *[max_jobs]?Result) void {
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        out.* = w.results;
        w.results = .{null} ** max_jobs;
    }
    fn run(w: *Worker) void {
        var watchers: std.AutoHashMapUnmanaged(ActorId, *Tail) = .empty;
        defer {
            var values = watchers.valueIterator();
            while (values.next()) |entry| {
                entry.*.close();
                a.destroy(entry.*);
            }
            watchers.deinit(a);
        }
        var requests: [max_jobs]Request = undefined;
        while (true) {
            w.mutex.lockUncancelable(os.io());
            if (!w.passes.next()) compat.timedWait(&w.wake, os.io(), &w.mutex, 250 * std.time.ns_per_ms) catch {};
            if (w.stopping) {
                w.mutex.unlock(os.io());
                return;
            }
            const batch_requests = w.batch(&requests);
            w.mutex.unlock(os.io());
            for (batch_requests) |*req| {
                const entry = watchers.getOrPut(a, req.actor) catch |err| {
                    log.warn("tracking completion tail: {}", .{err});
                    continue;
                };
                if (!entry.found_existing) {
                    const tail = a.create(Tail) catch |err| {
                        log.warn("allocating completion tail: {}", .{err});
                        _ = watchers.remove(req.actor);
                        continue;
                    };
                    tail.* = .{};
                    entry.value_ptr.* = tail;
                }
                const t = entry.value_ptr.*;
                if (t.seq != req.agent.last_seq) {
                    t.close();
                    t.actor = req.actor;
                    t.seq = req.agent.last_seq;
                }
                const now = os.milliTimestamp();
                if (t.finished or now < t.next_check) continue;
                // Reserve result capacity before advancing this actor's reader.
                w.mutex.lockUncancelable(os.io());
                const slot = for (&w.results) |*candidate| {
                    if (candidate.* == null) break candidate;
                } else null;
                w.mutex.unlock(os.io());
                if (slot == null) continue;
                t.attempts +|= 1;
                t.next_check = now + (if (t.attempts < 20) @as(i64, 250) else 2000);
                const outcome = t.poll(&req.agent) catch {
                    t.closeFile();
                    continue;
                };
                // Keep framing/offsets while bounding open file descriptors.
                t.releaseFile();
                if (outcome) |value| {
                    w.mutex.lockUncancelable(os.io());
                    slot.?.* = .{ .actor = req.actor, .seq = req.agent.last_seq, .outcome = value };
                    t.finished = true;
                    w.mutex.unlock(os.io());
                }
            }
        }
    }
};

const Tail = struct {
    actor: ActorId = .none,
    seq: i64 = 0,
    file: ?std.Io.File = null,
    inode: std.Io.File.INode = 0,
    device: u64 = 0,
    offset: u64 = 0,
    partial: std.ArrayList(u8) = .empty,
    discard: bool = false,
    finished: bool = false,
    next_check: i64 = 0,
    attempts: u32 = 0,
    fn releaseFile(t: *Tail) void {
        if (t.file) |f| f.close(os.io());
        t.file = null;
    }
    fn closeFile(t: *Tail) void {
        t.releaseFile();
        t.inode = 0;
        t.device = 0;
        t.offset = 0;
        t.partial.clearRetainingCapacity();
        t.discard = false;
    }
    fn close(t: *Tail) void {
        t.closeFile();
        t.partial.deinit(a);
        t.* = .{};
    }
    fn open(t: *Tail, agent: *const agents.Agent) !void {
        const fd = try std.posix.openat(std.posix.AT.FDCWD, agent.transcriptPath(), .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
        const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
        errdefer file.close(os.io());
        const stat = try file.stat(os.io());
        if (stat.kind != .file) return error.NotRegular;
        const device: u64 = (try os.fstat(file.handle)).dev;
        const resumed = t.inode != 0 and stat.inode == t.inode and device == t.device and stat.size >= t.offset;
        if (!resumed) {
            try verifySession(file, agent.provider orelse return error.NoProvider, agent.sessionId());
            t.partial.clearRetainingCapacity();
            t.offset = stat.size -| initial_tail;
            t.discard = t.offset > 0;
        }
        t.file = file;
        t.inode = stat.inode;
        t.device = device;
    }
    fn poll(t: *Tail, agent: *const agents.Agent) !?agents.observation.Outcome {
        if (t.file == null) try t.open(agent);
        const file = t.file.?;
        const stat = try file.stat(os.io());
        const path_stat = try os.lstat(agent.transcriptPath());
        if (!path_stat.isFile() or path_stat.ino != t.inode or path_stat.dev != t.device or stat.size < t.offset) return error.Replaced;
        if (stat.size == t.offset) return null;
        var bytes: [read_budget]u8 = undefined;
        const n = try file.readPositional(os.io(), &.{&bytes}, t.offset);
        t.offset += n;
        return t.ingest(agent, bytes[0..n]);
    }
    fn ingest(t: *Tail, agent: *const agents.Agent, bytes: []const u8) !?agents.observation.Outcome {
        var found: ?agents.observation.Outcome = null;
        var start: usize = 0;
        while (start < bytes.len) {
            const end = std.mem.indexOfScalarPos(u8, bytes, start, '\n') orelse bytes.len;
            const complete = end < bytes.len;
            const segment = bytes[start..end];
            start = end + @intFromBool(complete);
            if (!t.discard and t.partial.items.len + segment.len > record_limit) {
                t.partial.clearRetainingCapacity();
                t.discard = true;
            }
            if (!t.discard) try t.partial.appendSlice(a, segment);
            if (complete) {
                if (!t.discard) if (completion(agent, t.partial.items)) |value| {
                    found = value;
                };
                t.partial.clearRetainingCapacity();
                t.discard = false;
            }
        }
        return found;
    }
};
/// A transcript that begins with an identity record must name this session.
/// Shared by completion and usage readers.
pub fn verifySession(file: std.Io.File, provider: agents.Provider, session: []const u8) !void {
    switch (provider) {
        .codex => try verifyCodexSession(file, session),
        .claude => {},
    }
}
// Session metadata contains instructions and can exceed 16 KiB. Read through
// the first newline with a bounded allocation, rather than assuming one chunk
// contains the whole identity record.
fn verifyCodexSession(file: std.Io.File, session: []const u8) !void {
    const limit = 1024 * 1024;
    var header: std.ArrayList(u8) = .empty;
    defer header.deinit(a);
    var chunk: [4096]u8 = undefined;
    while (header.items.len < limit) {
        const n = try file.readPositional(os.io(), &.{chunk[0..@min(chunk.len, limit - header.items.len)]}, header.items.len);
        if (n == 0) return error.NoIdentity;
        const end = std.mem.indexOfScalar(u8, chunk[0..n], '\n');
        try header.appendSlice(a, chunk[0 .. end orelse n]);
        if (end != null) {
            const parsed = try std.json.parseFromSlice(std.json.Value, a, header.items, .{});
            defer parsed.deinit();
            const rollout = Codex.Rollout.decode(parsed.value);
            if (rollout.type != .session_meta or !std.mem.eql(u8, agents.str(rollout.payload, "id"), session)) return error.WrongSession;
            return;
        }
    }
    return error.NoIdentity;
}

fn completion(agent: *const agents.Agent, line: []const u8) ?agents.observation.Outcome {
    const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch return null;
    defer parsed.deinit();
    const v = parsed.value;
    if (v != .object) return null;
    // Historical tail records must never be mistaken for this Stop invocation.
    const stamp = common.timestampMs(agents.str(v, "timestamp")) orelse return null;
    if (stamp < @divTrunc(agent.last_seq, 1000)) return null;
    return switch (agent.provider orelse return null) {
        .codex => codexCompletion(agent, v),
        .claude => claudeCompletion(agent, v),
    };
}
fn codexCompletion(agent: *const agents.Agent, v: std.json.Value) ?agents.observation.Outcome {
    const rollout = Codex.Rollout.decode(v);
    if (rollout.type != .event_msg or agent.turn.len == 0) return null;
    if (!std.mem.eql(u8, agents.str(rollout.payload, "turn_id"), agent.turnId())) return null;
    return switch (rollout.payloadType() orelse return null) {
        .turn_aborted => .interrupted,
        .task_complete, .turn_complete => if (common.field(rollout.payload, "error") != .null) .failed else .completed,
        else => null,
    };
}
fn claudeCompletion(agent: *const agents.Agent, v: std.json.Value) ?agents.observation.Outcome {
    // end_turn on an assistant message precedes Stop hooks. Only the
    // post-turn system record is evidence; a stop_hook_summary is not.
    const line = Claude.Line.decode(v) orelse return null;
    if (!std.mem.eql(u8, line.sessionId, agent.sessionId())) return null;
    return switch (line.type orelse return null) {
        .system => if (std.mem.eql(u8, line.subtype, "turn_duration")) .completed else null,
        // Esc during Stop hooks cancels them, and no turn_duration follows.
        // A hook that timed out is cancelled too, but its turn goes on.
        .attachment => blk: {
            const hook = common.field(v, "attachment");
            if (!std.mem.eql(u8, agents.str(hook, "type"), "hook_cancelled")) break :blk null;
            if (std.meta.stringToEnum(common.HookEvent, agents.str(hook, "hookEvent")) != .Stop) break :blk null;
            const timed_out = common.field(hook, "timedOut");
            break :blk if (timed_out == .bool and !timed_out.bool) .interrupted else null;
        },
        else => null,
    };
}

test "completion requires matching turn, fresh timestamp and complete JSONL record" {
    var agent: agents.Agent = .{ .provider = .codex, .last_seq = 1000000 };
    agent.turn = .ascii("current");
    const good = "{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"current\"}}";
    var tail: Tail = .{};
    defer tail.close();
    try std.testing.expectEqual(null, try tail.ingest(&agent, good));
    try std.testing.expectEqual(agents.observation.Outcome.completed, (try tail.ingest(&agent, "\n")).?);
    agent.turn = .ascii("new");
    try std.testing.expectEqual(null, completion(&agent, good));
    agent.turn = .ascii("current");
    agent.last_seq = 3000000;
    try std.testing.expectEqual(null, completion(&agent, good));
}

test "Claude Stop hooks cancelled by Esc end the turn as interrupted" {
    var agent: agents.Agent = .{ .provider = .claude, .last_seq = 1000000 };
    agent.session = .ascii("s");
    const record = "{{\"type\":\"attachment\",\"sessionId\":\"s\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"attachment\":{{\"type\":\"hook_cancelled\",\"hookEvent\":\"{s}\",\"timedOut\":{s}}}}}";
    const cases = [_]struct { line: []const u8, outcome: ?agents.observation.Outcome }{
        .{ .line = std.fmt.comptimePrint(record, .{ "Stop", "false" }), .outcome = .interrupted },
        // A Stop hook that timed out is cancelled too, but its turn goes on.
        .{ .line = std.fmt.comptimePrint(record, .{ "Stop", "true" }), .outcome = null },
        .{ .line = std.fmt.comptimePrint(record, .{ "PostToolUse", "false" }), .outcome = null },
        .{ .line = "{\"type\":\"system\",\"subtype\":\"turn_duration\",\"sessionId\":\"s\",\"timestamp\":\"1970-01-01T00:00:02.000Z\"}", .outcome = .completed },
        .{ .line = "{\"type\":\"system\",\"subtype\":\"stop_hook_summary\",\"sessionId\":\"s\",\"timestamp\":\"1970-01-01T00:00:02.000Z\"}", .outcome = null },
    };
    for (cases) |case| try std.testing.expectEqual(case.outcome, completion(&agent, case.line));
    // A cancellation from before this Stop belongs to an earlier turn.
    agent.last_seq = 3000000;
    try std.testing.expectEqual(null, completion(&agent, cases[0].line));
}

test "completion scheduling retains detached actors and fairly batches beyond pane capacity" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var worker: Worker = .{};
    defer worker.requests.deinit(a);
    var attachment: conversations.Attachment = .{};
    for (0..max_jobs + 1) |i| {
        var name: [32]u8 = undefined;
        const actor = try registry.get(.claude, try std.fmt.bufPrint(&name, "session-{d}", .{i}));
        actor.state.observation.pending_stop = true;
        actor.state.transcript = .ascii("/tmp/transcript.jsonl");
        attachment.select(actor);
    }
    attachment.detach();
    worker.reconcile(registry.items.items);
    try std.testing.expectEqual(max_jobs + 1, worker.requests.items.len);
    var out: [max_jobs]Request = undefined;
    const first_id = worker.batch(&out)[0].actor;
    try std.testing.expectEqual(registry.items.items[0].id, first_id);
    try std.testing.expectEqual(registry.items.items[max_jobs].id, worker.batch(&out)[0].actor);
    try std.testing.expectEqual(null, attachment.actor);
}
