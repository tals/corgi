//! Incremental usage observation off the terminal thread. Opening a file seeds
//! baselines only; old history never appears as new workspace activity.
const std = @import("std");
const agents = @import("agents.zig");
const usage = @import("usage.zig");
const activity_tools = @import("activity_tools.zig");
const a = std.heap.c_allocator;
const max_jobs = @import("layout.zig").max_panes;
const read_budget = 64 * 1024;
const initial_tail = 256 * 1024;
const record_limit = 1024 * 1024;
const Request = struct { pane: u32, workspace: u32, since: i64, agent: agents.Agent };
pub const Result = struct { pane: u32, workspace: u32, since: i64, session: [160]u8, session_len: usize, delta: usage.Counts, progress: ?activity_tools.View = null };
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    requests: [max_jobs]Request = undefined,
    count: usize = 0,
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
        a.destroy(w);
    }
    pub fn reconcile(w: *Worker, runtime: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.count = 0;
        for (runtime.panes.items) |p| {
            if (p.agent.transcript_len == 0 or p.agent.session_len == 0) continue;
            const ws = runtime.workspaces.owner(p.id) orelse continue;
            w.requests[w.count] = .{ .pane = p.id, .workspace = ws.id, .since = ws.away.since, .agent = p.agent };
            w.count += 1;
            if (w.count == max_jobs) break;
        }
        w.wake.signal();
    }
    pub fn take(w: *Worker, out: *[max_jobs]?Result) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        out.* = w.results;
        w.results = @splat(null);
    }
    fn run(w: *Worker) void {
        var watchers: [max_jobs]Tail = @splat(.{});
        defer for (&watchers) |*t| t.close();
        var requests: [max_jobs]Request = undefined;
        while (true) {
            w.mutex.lock();
            w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            if (w.stopping) {
                w.mutex.unlock();
                return;
            }
            const count = w.count;
            @memcpy(requests[0..count], w.requests[0..count]);
            w.mutex.unlock();
            for (&watchers) |*t| {
                const exists = for (requests[0..count]) |*req| {
                    if (req.pane == t.pane and eq(req.agent.sessionId(), t.session[0..t.session_len])) break true;
                } else false;
                if (!exists) t.close();
            }
            for (requests[0..count]) |*req| {
                const t = for (&watchers) |*candidate| {
                    if (candidate.pane == req.pane) break candidate;
                } else for (&watchers) |*candidate| {
                    if (candidate.pane == 0) break candidate;
                } else continue;
                if (t.pane == 0) {
                    t.pane = req.pane;
                    t.session = req.agent.session;
                    t.session_len = req.agent.session_len;
                }
                const delta = t.poll(req) catch {
                    t.closeFile();
                    continue;
                };
                if (!delta.any() and !delta.tokens_known and !t.progress.dirty) continue;
                w.mutex.lock();
                const slot = for (&w.results) |*entry| {
                    if (entry.*) |old| {
                        if (old.pane == req.pane) break entry;
                    }
                } else for (&w.results) |*entry| {
                    if (entry.* == null) break entry;
                } else null;
                if (slot) |entry| {
                    if (entry.* == null or entry.*.?.since != req.since or entry.*.?.workspace != req.workspace or !eq(entry.*.?.session[0..entry.*.?.session_len], req.agent.sessionId())) {
                        entry.* = .{ .pane = req.pane, .workspace = req.workspace, .since = req.since, .session = req.agent.session, .session_len = req.agent.session_len, .delta = .{} };
                    }
                    entry.*.?.delta.add(delta);
                    if (req.agent.provider == .codex) entry.*.?.progress = t.progress.view();
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
    pane: u32 = 0,
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
    fn closeFile(t: *Tail) void {
        if (t.file) |f| f.close();
        t.file = null;
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
        if (agent.provider == .codex) try @import("transcript.zig").verifyCodexSession(file, agent.sessionId());
        t.file = file;
        t.inode = stat.inode;
        t.device = @intCast((try std.posix.fstat(file.handle)).dev);
        t.initial_until = stat.size;
        t.offset = stat.size -| initial_tail;
        t.tracker = .{};
        t.progress = .{};
        if (agent.provider == .codex) t.progress.bind(agent.turnId());
        if (t.offset == 0 and agent.provider == .codex) t.tracker.beginCodex("codex");
        t.discard = t.offset > 0;
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
    var req: Request = .{ .pane = 1, .workspace = 1, .since = 1000, .agent = .{ .provider = .codex } };
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
    var req: Request = .{ .pane = 1, .workspace = 1, .since = 1000, .agent = .{ .provider = .codex } };
    req.agent.session_len = agents.clean(&req.agent.session, "large-session");
    @memcpy(req.agent.transcript[0..path.len], path);
    req.agent.transcript_len = path.len;
    var tail: Tail = .{};
    defer tail.close();
    try std.testing.expect(!(try tail.poll(&req)).any());
    try file.writeAll("{\"type\":\"response_item\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"function_call\",\"call_id\":\"call1\"}}\n");
    try file.writeAll("{\"type\":\"event_msg\",\"timestamp\":\"1970-01-01T00:00:02.000Z\",\"payload\":{\"type\":\"token_count\",\"info\":{\"total_token_usage\":{\"input_tokens\":100,\"output_tokens\":20}}}}\n");
    const delta = try tail.poll(&req);
    try std.testing.expectEqual(@as(u64, 1), delta.tools);
    try std.testing.expectEqual(@as(u64, 100), delta.input);
    try std.testing.expectEqual(@as(u64, 20), delta.output);
    try std.testing.expect(!(try tail.poll(&req)).any());
}
