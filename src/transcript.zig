//! On-demand completion verification. One worker, bounded reads and framing;
//! no transcript IO or JSON parsing on the terminal interaction thread.
const std = @import("std");
const agents = @import("agents.zig");
const a = std.heap.c_allocator;
const max_jobs = @import("layout.zig").max_panes;
const read_budget = 64 * 1024;
const initial_tail = 256 * 1024;
const record_limit = 64 * 1024;
const Request = struct { actor: u32, agent: agents.Agent };
pub const Result = struct { actor: u32, seq: i64, outcome: agents.observation.Outcome };

pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    passes: @import("passes.zig").Passes = .{},
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
        w.mutex.lock();
        w.stopping = true;
        w.wake.signal();
        w.mutex.unlock();
        w.thread.?.join();
        w.requests.deinit(a);
        a.destroy(w);
    }
    pub fn reconcile(w: *Worker, actors: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.requests.clearRetainingCapacity();
        for (actors) |actor| {
            const agent = &actor.state;
            if (!agent.observation.pending_stop or agent.transcript_len == 0 or agent.session_len == 0) continue;
            w.requests.append(a, .{ .actor = actor.id, .agent = agent.* }) catch break;
        }
        w.wake.signal();
    }
    fn batch(w: *Worker, out: *[max_jobs]Request) []Request {
        const count = @min(out.len, w.requests.items.len);
        for (0..count) |i| out[i] = w.requests.items[(w.cursor + i) % w.requests.items.len];
        if (w.requests.items.len > 0) w.cursor = (w.cursor + count) % w.requests.items.len;
        return out[0..count];
    }
    pub fn take(w: *Worker, out: *[max_jobs]?Result) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        out.* = w.results;
        w.results = .{null} ** max_jobs;
    }
    fn run(w: *Worker) void {
        var watchers: std.AutoHashMapUnmanaged(u32, *Tail) = .empty;
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
            w.mutex.lock();
            if (!w.passes.next()) w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            if (w.stopping) {
                w.mutex.unlock();
                return;
            }
            const batch_requests = w.batch(&requests);
            w.mutex.unlock();
            for (batch_requests) |*req| {
                const entry = watchers.getOrPut(a, req.actor) catch continue;
                if (!entry.found_existing) {
                    const tail = a.create(Tail) catch {
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
                const now = std.time.milliTimestamp();
                if (t.finished or now < t.next_check) continue;
                // Reserve result capacity before advancing this actor's reader.
                w.mutex.lock();
                const slot = for (&w.results) |*candidate| {
                    if (candidate.* == null) break candidate;
                } else null;
                w.mutex.unlock();
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
                    w.mutex.lock();
                    slot.?.* = .{ .actor = req.actor, .seq = req.agent.last_seq, .outcome = value };
                    t.finished = true;
                    w.mutex.unlock();
                }
            }
        }
    }
};

const Tail = struct {
    actor: u32 = 0,
    seq: i64 = 0,
    file: ?std.fs.File = null,
    inode: std.fs.File.INode = 0,
    device: u64 = 0,
    offset: u64 = 0,
    partial: std.ArrayList(u8) = .empty,
    discard: bool = false,
    finished: bool = false,
    next_check: i64 = 0,
    attempts: u32 = 0,
    fn releaseFile(t: *Tail) void {
        if (t.file) |f| f.close();
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
        const fd = try std.posix.open(agent.transcriptPath(), .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NOFOLLOW = true, .NONBLOCK = true }, 0);
        const file: std.fs.File = .{ .handle = fd };
        errdefer file.close();
        const stat = try file.stat();
        if (stat.kind != .file) return error.NotRegular;
        const device: u64 = @intCast((try std.posix.fstat(file.handle)).dev);
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
        const stat = try file.stat();
        const path_stat = try std.posix.fstatat(std.posix.AT.FDCWD, agent.transcriptPath(), std.posix.AT.SYMLINK_NOFOLLOW);
        if (!std.posix.S.ISREG(path_stat.mode) or path_stat.ino != t.inode or path_stat.dev != t.device or stat.size < t.offset) return error.Replaced;
        if (stat.size == t.offset) return null;
        var bytes: [read_budget]u8 = undefined;
        const n = try file.pread(&bytes, t.offset);
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
pub fn verifySession(file: std.fs.File, provider: agents.Provider, session: []const u8) !void {
    switch (provider) {
        .codex => try verifyCodexSession(file, session),
        .claude => {},
    }
}
// Session metadata contains instructions and can exceed 16 KiB. Read through
// the first newline with a bounded allocation, rather than assuming one chunk
// contains the whole identity record.
fn verifyCodexSession(file: std.fs.File, session: []const u8) !void {
    const limit = 1024 * 1024;
    var header: std.ArrayList(u8) = .empty;
    defer header.deinit(a);
    var chunk: [4096]u8 = undefined;
    while (header.items.len < limit) {
        const n = try file.pread(chunk[0..@min(chunk.len, limit - header.items.len)], header.items.len);
        if (n == 0) return error.NoIdentity;
        const end = std.mem.indexOfScalar(u8, chunk[0..n], '\n');
        try header.appendSlice(a, chunk[0 .. end orelse n]);
        if (end != null) {
            const parsed = try std.json.parseFromSlice(std.json.Value, a, header.items, .{});
            defer parsed.deinit();
            const v = parsed.value;
            const payload = if (v == .object) v.object.get("payload") orelse .null else .null;
            if (!eq(agents.str(v, "type"), "session_meta") or !eq(agents.str(payload, "id"), session)) return error.WrongSession;
            return;
        }
    }
    return error.NoIdentity;
}

fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
fn completion(agent: *const agents.Agent, line: []const u8) ?agents.observation.Outcome {
    const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch return null;
    defer parsed.deinit();
    const v = parsed.value;
    if (v != .object) return null;
    // Historical tail records must never be mistaken for this Stop invocation.
    const stamp = timestampMs(agents.str(v, "timestamp")) orelse return null;
    if (stamp < @divTrunc(agent.last_seq, 1000)) return null;
    return switch (agent.provider orelse return null) {
        .codex => codexCompletion(agent, v),
        .claude => claudeCompletion(agent, v),
    };
}
fn codexCompletion(agent: *const agents.Agent, v: std.json.Value) ?agents.observation.Outcome {
    if (!eq(agents.str(v, "type"), "event_msg") or agent.turn_len == 0) return null;
    const p = v.object.get("payload") orelse return null;
    if (!eq(agents.str(p, "turn_id"), agent.turnId())) return null;
    const kind = agents.str(p, "type");
    if (eq(kind, "turn_aborted")) return .interrupted;
    if (!eq(kind, "task_complete") and !eq(kind, "turn_complete")) return null;
    if (p.object.get("error")) |err| if (err != .null) return .failed;
    return .completed;
}
fn claudeCompletion(agent: *const agents.Agent, v: std.json.Value) ?agents.observation.Outcome {
    // end_turn on an assistant message precedes Stop hooks. Only the
    // post-turn system record is evidence; a stop_hook_summary is not.
    if (!eq(agents.str(v, "sessionId"), agent.sessionId()) or !eq(agents.str(v, "type"), "system") or !eq(agents.str(v, "subtype"), "turn_duration")) return null;
    if (v.object.get("isSidechain")) |side| if (side == .bool and side.bool) return null;
    return .completed;
}
pub fn timestampMs(s: []const u8) ?i64 {
    if (s.len < 20 or s[4] != '-' or s[7] != '-' or s[10] != 'T' or s[s.len - 1] != 'Z') return null;
    const year = std.fmt.parseInt(u16, s[0..4], 10) catch return null;
    const month = std.fmt.parseInt(u8, s[5..7], 10) catch return null;
    const day = std.fmt.parseInt(u8, s[8..10], 10) catch return null;
    const hour = std.fmt.parseInt(u8, s[11..13], 10) catch return null;
    const minute = std.fmt.parseInt(u8, s[14..16], 10) catch return null;
    const second = std.fmt.parseInt(u8, s[17..19], 10) catch return null;
    if (year < 1970 or year > 2200 or month < 1 or month > 12 or day < 1 or day > 31 or hour > 23 or minute > 59 or second > 59) return null;
    var days: i64 = 0;
    for (1970..year) |y| days += if (leap(y)) @as(i64, 366) else 365;
    const months = [_]u8{ 31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31 };
    for (0..month - 1) |m| days += months[m] + @as(u8, if (m == 1 and leap(year)) 1 else 0);
    days += day - 1;
    const ms: i64 = if (s.len >= 24 and s[19] == '.') std.fmt.parseInt(u16, s[20..23], 10) catch return null else 0;
    return ((days * 24 + hour) * 3600 + @as(i64, minute) * 60 + second) * 1000 + ms;
}
fn leap(y: usize) bool {
    return y % 4 == 0 and (y % 100 != 0 or y % 400 == 0);
}

test "completion requires matching turn, fresh timestamp and complete JSONL record" {
    var agent: agents.Agent = .{ .provider = .codex, .last_seq = 1000000 };
    agent.turn_len = agents.clean(&agent.turn, "current");
    const good = "{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"task_complete\",\"turn_id\":\"current\"}}";
    var tail: Tail = .{};
    defer tail.close();
    try std.testing.expectEqual(null, try tail.ingest(&agent, good));
    try std.testing.expectEqual(agents.observation.Outcome.completed, (try tail.ingest(&agent, "\n")).?);
    agent.turn_len = agents.clean(&agent.turn, "new");
    try std.testing.expectEqual(null, completion(&agent, good));
    agent.turn_len = agents.clean(&agent.turn, "current");
    agent.last_seq = 3000000;
    try std.testing.expectEqual(null, completion(&agent, good));
    try std.testing.expectEqual(@as(?i64, 0), timestampMs("1970-01-01T00:00:00.000Z"));
}

test "completion scheduling retains detached actors and fairly batches beyond pane capacity" {
    const conversations = @import("conversations.zig");
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var worker: Worker = .{};
    defer worker.requests.deinit(a);
    var attachment: conversations.Attachment = .{};
    for (0..max_jobs + 1) |i| {
        var name: [32]u8 = undefined;
        const actor = try registry.get(.claude, try std.fmt.bufPrint(&name, "session-{d}", .{i}));
        actor.state.observation.pending_stop = true;
        actor.state.transcript_len = agents.clean(&actor.state.transcript, "/tmp/transcript.jsonl");
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
