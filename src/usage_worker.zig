//! Incremental usage observation off the terminal thread. Opening a file seeds
//! baselines only; old history never appears as new workspace activity.
const std = @import("std");
const agents = @import("agents.zig");
const usage = @import("usage.zig");
const activity_tools = @import("activity_tools.zig");
const codex_files = @import("codex_files.zig");
const a = std.heap.c_allocator;
const max_jobs = @import("layout.zig").max_panes;
const read_budget = 64 * 1024;
const initial_tail = 256 * 1024;
const record_limit = 1024 * 1024;
const Request = struct { actor: u32, workspace: u32, since: i64, agent: agents.Agent };
pub const Result = struct {
    actor: u32,
    workspace: u32,
    since: i64,
    session: [160]u8,
    session_len: usize,
    delta: usage.Counts,
    progress: ?activity_tools.View = null,
    name: codex_files.Name = .{},
    seq: i64 = 0,

    // Only presentation metadata. Hooks remain the lifecycle authority.
    pub fn fallback(result: *const Result, agent: *agents.Agent, now: i64) bool {
        if (!codex_files.available(agent, now) or !eq(agent.sessionId(), result.session[0..result.session_len])) return false;
        if (result.name.len > 0) agent.setName(result.name.bytes[0..result.name.len]);
        const progress = result.progress orelse return false;
        if (agent.state != .working or progress.ended or progress.turn_len == 0) return false;
        // A late file read cannot supply a turn after a newer hook arrived.
        if (agent.turn_len == 0 and agent.last_seq == result.seq) {
            agent.turn_len = agents.clean(&agent.turn, progress.turn[0..progress.turn_len]);
        }
        if (!eq(agent.turnId(), progress.turn[0..progress.turn_len])) return false;
        agent.activity_generation = progress.commentary.hash();
        return true;
    }
};
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    requests: std.ArrayList(Request) = .empty,
    cursor: usize = 0,
    results: [max_jobs]?Result = @splat(null),
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
    pub fn reconcile(w: *Worker, runtime: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.requests.clearRetainingCapacity();
        for (runtime.conversations.items.items) |actor| {
            const agent = &actor.state;
            if (agent.session_len == 0 or (agent.transcript_len == 0 and agent.provider != .codex)) continue;
            const ws = runtime.workspaces.get(actor.workspace) orelse continue;
            w.requests.append(a, .{ .actor = actor.id, .workspace = ws.id, .since = ws.away.since, .agent = agent.* }) catch break;
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
        w.results = @splat(null);
    }
    fn run(w: *Worker) void {
        var index: codex_files.Index = .{};
        defer index.deinit();
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
            w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            if (w.stopping) {
                w.mutex.unlock();
                return;
            }
            const batch_requests = w.batch(&requests);
            w.mutex.unlock();
            index.refresh();
            for (batch_requests) |*req| {
                const entry = watchers.getOrPut(a, req.actor) catch continue;
                if (!entry.found_existing) {
                    const tail = a.create(Tail) catch {
                        _ = watchers.remove(req.actor);
                        continue;
                    };
                    tail.* = .{ .actor = req.actor, .session = req.agent.session, .session_len = req.agent.session_len };
                    entry.value_ptr.* = tail;
                }
                const t = entry.value_ptr.*;
                // A full delivery buffer must not consume and lose usage deltas.
                w.mutex.lock();
                const slot = for (&w.results) |*candidate| {
                    if (candidate.*) |old| {
                        if (old.actor == req.actor) break candidate;
                    }
                } else for (&w.results) |*candidate| {
                    if (candidate.* == null) break candidate;
                } else null;
                w.mutex.unlock();
                if (slot == null) continue;
                const delta = t.poll(req) catch blk: {
                    t.closeFile();
                    t.progress = .{};
                    break :blk usage.Counts{};
                };
                t.releaseFile();
                if (!delta.any() and !delta.tokens_known and !t.progress.dirty and req.agent.provider != .codex) continue;
                w.mutex.lock();
                if (slot) |result| {
                    if (result.* == null or result.*.?.since != req.since or result.*.?.workspace != req.workspace or !eq(result.*.?.session[0..result.*.?.session_len], req.agent.sessionId())) {
                        result.* = .{ .actor = req.actor, .workspace = req.workspace, .since = req.since, .session = req.agent.session, .session_len = req.agent.session_len, .delta = .{} };
                    }
                    result.*.?.delta.add(delta);
                    if (req.agent.provider == .codex) {
                        result.*.?.progress = t.progress.view();
                        result.*.?.name = index.name(req.agent.sessionId());
                        result.*.?.seq = req.agent.last_seq;
                    }
                    if (eq(t.progress.turn[0..t.progress.turn_len], req.agent.turnId())) t.progress.dirty = false;
                }
                w.mutex.unlock();
            }
        }
    }
};
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
pub const Tail = struct {
    actor: u32 = 0,
    session: [160]u8 = @splat(0),
    session_len: usize = 0,
    initial_until: u64 = 0,
    tracker: usage.Tracker = .{},
    progress: activity_tools.Tracker = .{},
    file: ?std.fs.File = null,
    inode: std.fs.File.INode = 0,
    device: u64 = 0,
    offset: u64 = 0,
    partial: std.ArrayList(u8) = .empty,
    discard: bool = false,
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
            if (agent.provider == .codex) try @import("transcript.zig").verifyCodexSession(file, agent.sessionId());
            t.initial_until = stat.size;
            t.offset = stat.size -| initial_tail;
            t.partial.clearRetainingCapacity();
            t.tracker = .{};
            t.progress = .{};
            if (agent.provider == .codex) t.progress.bind(agent.turnId());
            if (t.offset == 0 and agent.provider == .codex) t.tracker.beginCodex("codex");
            t.discard = t.offset > 0;
        }
        t.file = file;
        t.inode = stat.inode;
        t.device = device;
    }
    fn poll(t: *Tail, req: *const Request) !usage.Counts {
        if (t.file == null) try t.open(&req.agent);
        const file = t.file.?;
        const stat = try file.stat();
        const path_stat = try std.posix.fstatat(std.posix.AT.FDCWD, req.agent.transcriptPath(), std.posix.AT.SYMLINK_NOFOLLOW);
        if (!std.posix.S.ISREG(path_stat.mode) or path_stat.ino != t.inode or path_stat.dev != t.device or stat.size < t.offset) return error.Replaced;
        if (stat.size == t.offset) return .{};
        var bytes: [read_budget]u8 = undefined;
        const n = try file.pread(&bytes, t.offset);
        const start_offset = t.offset;
        t.offset += n;
        return t.ingest(req, bytes[0..n], start_offset);
    }
    fn ingest(t: *Tail, req: *const Request, bytes: []const u8, start_offset: u64) !usage.Counts {
        var found: usage.Counts = .{};
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
                if (!t.discard) {
                    if (std.json.parseFromSlice(std.json.Value, a, t.partial.items, .{})) |parsed| {
                        defer parsed.deinit();
                        if (req.agent.provider == .codex) t.progress.ingest(parsed.value, start_offset + start > t.initial_until);
                        const delta = t.tracker.transcript(req.agent.provider, req.agent.sessionId(), parsed.value);
                        const stamp = @import("transcript.zig").timestampMs(agents.str(parsed.value, "timestamp"));
                        if (start_offset + start > t.initial_until and stamp != null and stamp.? > req.since) found.add(delta);
                    } else |_| {}
                }
                t.partial.clearRetainingCapacity();
                t.discard = false;
            }
        }
        return found;
    }
};

test "usage tail frames records, ignores history and advances baselines while watched" {
    var tail: Tail = .{};
    defer tail.close();
    var req: Request = .{ .actor = 1, .workspace = 1, .since = 1000, .agent = .{ .provider = .codex } };
    req.agent.session_len = agents.clean(&req.agent.session, "session");
    const baseline = "{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:00.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":10}}}}\n";
    try std.testing.expect(!(try tail.ingest(&req, baseline, 0)).any());
    const call = "{\"type\":\"response_item\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call1\"}}";
    try std.testing.expect(!(try tail.ingest(&req, call, baseline.len)).any());
    try std.testing.expectEqual(@as(u64, 1), (try tail.ingest(&req, "\n", baseline.len + call.len)).tools);
    try std.testing.expect(!(try tail.ingest(&req, call ++ "\n", 0)).any());
    req.since = 3000;
    const usage_line = "{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:02.500Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":150,\"output_tokens\":20}}}}\n";
    try std.testing.expect(!(try tail.ingest(&req, usage_line, 0)).any());
    const later = "{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:04.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":180,\"output_tokens\":25}}}}\n";
    const delta = try tail.ingest(&req, later, 0);
    try std.testing.expectEqual(@as(u64, 30), delta.input);
    try std.testing.expectEqual(@as(u64, 5), delta.output);
    // Reading an existing file seeds totals without counting historical work.
    tail.initial_until = 10000;
    try std.testing.expect(!(try tail.ingest(&req, later, 0)).any());
}

test "file metadata prefers fresh protocol and rejects other sessions and turns" {
    var agent: agents.Agent = .{ .provider = .codex, .state = .working, .last_seq = 10 };
    agent.session_len = agents.clean(&agent.session, "session");
    agent.turn_len = agents.clean(&agent.turn, "current");
    var progress: activity_tools.View = .{};
    progress.turn_len = agents.clean(&progress.turn, "current");
    progress.commentary.append("Tracing pane focus");
    var result: Result = .{ .actor = 1, .workspace = 1, .since = 0, .session = agent.session, .session_len = agent.session_len, .delta = .{}, .progress = progress, .seq = 10 };
    result.name.len = agents.clean(&result.name.bytes, "File title");
    agent.setName("Protocol title");
    agent.metadata_protocol_at = 100;
    try std.testing.expect(!result.fallback(&agent, 101));
    try std.testing.expectEqualStrings("Protocol title", agent.displayName());
    // Hooks advance last_seq but must not keep protocol metadata fresh.
    agent.last_seq = 6_000_000;
    try std.testing.expect(result.fallback(&agent, 6_000_000));
    try std.testing.expectEqualStrings("File title", agent.displayName());
    try std.testing.expectEqual(agents.State.working, agent.state);
    try std.testing.expectEqual(@as(u64, 0), agent.observation.completed);
    result.progress.?.turn_len = agents.clean(&result.progress.?.turn, "old");
    try std.testing.expect(!result.fallback(&agent, 6_000_000));
    agent.turn_len = 0;
    try std.testing.expect(!result.fallback(&agent, 6_000_000));
    result.seq = agent.last_seq;
    result.progress.?.ended = true;
    try std.testing.expect(!result.fallback(&agent, 6_000_000));
    result.session[0] = 'X';
    result.name.len = agents.clean(&result.name.bytes, "Wrong title");
    try std.testing.expect(!result.fallback(&agent, 6_000_000));
    try std.testing.expectEqualStrings("File title", agent.displayName());
}

test "real file usage reader accepts large Codex metadata and counts later activity" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    var file = try tmp.dir.createFile("usage.jsonl", .{ .read = true });
    defer file.close();
    try file.writeAll("{\"type\":\"session_meta\",\"payload\":{\"id\":\"large-session\",\"instructions\":\"");
    const padding: [24 * 1024]u8 = @splat('x');
    try file.writeAll(&padding);
    try file.writeAll("\"}}\n");
    try @import("transcript.zig").verifyCodexSession(file, "large-session");
    try std.testing.expectError(error.WrongSession, @import("transcript.zig").verifyCodexSession(file, "other-session"));
    const path = try tmp.dir.realpathAlloc(std.testing.allocator, "usage.jsonl");
    defer std.testing.allocator.free(path);
    var req: Request = .{ .actor = 1, .workspace = 1, .since = 1000, .agent = .{ .provider = .codex } };
    req.agent.session_len = agents.clean(&req.agent.session, "large-session");
    @memcpy(req.agent.transcript[0..path.len], path);
    req.agent.transcript_len = path.len;
    var tail: Tail = .{};
    defer tail.close();
    try std.testing.expect(!(try tail.poll(&req)).any());
    // Rotating to other conversations closes the FD but must retain this
    // actor's baseline and byte offset when the worker comes back to it.
    const baseline_offset = tail.offset;
    tail.releaseFile();
    try std.testing.expectEqual(null, tail.file);
    try file.writeAll("{\"type\":\"response_item\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call1\"}}\n");
    try file.writeAll("{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":20}}}}\n");
    const delta = try tail.poll(&req);
    try std.testing.expect(tail.offset > baseline_offset);
    try std.testing.expectEqual(@as(u64, 1), delta.tools);
    try std.testing.expectEqual(@as(u64, 100), delta.input);
    try std.testing.expectEqual(@as(u64, 20), delta.output);
    try std.testing.expect(!(try tail.poll(&req)).any());
}
