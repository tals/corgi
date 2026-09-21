//! Title-selected, read-only daemon observation. Never resumes or subscribes a
//! thread, and never changes the CLI transport or launch configuration.
const std = @import("std");
const os = @import("os.zig");
const agents = @import("agents.zig");
const Client = @import("codex_socket.zig").Client;
const a = os.allocator;
const max = @import("layout.zig").max_panes;
const eq = std.mem.eql;
pub const Prefix = struct {
    bytes: [36]u8 = .{0} ** 36,
    len: usize = 0,
    pub fn text(p: *const Prefix) []const u8 {
        return p.bytes[0..p.len];
    }
};
// Codex's 32-character title field contains 29 UUID characters plus "...".
// Accept only a complete UUID or that exact truncated form, not arbitrary text.
pub fn titlePrefix(title: []const u8) ?Prefix {
    var words = std.mem.tokenizeAny(u8, title, " |\t");
    var found: ?Prefix = null;
    while (words.next()) |word| {
        const n: usize = if (word.len == 36) 36 else if (word.len == 32 and std.mem.endsWith(u8, word, "...")) 29 else continue;
        var valid = true;
        for (word[0..n], 0..) |ch, i| {
            if (i == 8 or i == 13 or i == 18 or i == 23) {
                if (ch != '-') valid = false;
            } else if (!std.ascii.isHex(ch)) valid = false;
        }
        if (!valid) continue;
        if (found != null) return null;
        var p: Prefix = .{ .len = n };
        @memcpy(p.bytes[0..n], word[0..n]);
        found = p;
    }
    return found;
}
pub const Request = struct { pane: u32, pid: c_int, prefix: Prefix };
pub const Snapshot = struct {
    evidence: @import("activity_summary.zig").Text = .{},
    name: [160]u8 = @splat(0),
    name_len: usize = 0,
    request: Request,
    session: [36]u8,
    state: agents.State,
    transcript: [std.fs.max_path_bytes]u8 = @splat(0),
    transcript_len: usize = 0,
    turn: [128]u8 = .{0} ** 128,
    turn_len: usize = 0,
    outcome: ?agents.observation.Outcome = null,
    observed_at: i64,
};
fn field(v: std.json.Value, key: []const u8) std.json.Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
fn result(v: std.json.Value) std.json.Value {
    return field(v, "result");
}
fn unique(ids: []const std.json.Value, prefix: *const Prefix) ?[36]u8 {
    var found: ?[36]u8 = null;
    for (ids) |id| {
        if (id != .string or id.string.len != 36 or !std.mem.startsWith(u8, id.string, prefix.text())) continue;
        if (found != null) return null;
        found = id.string[0..36].*;
    }
    return found;
}
fn snapshot(client: *Client, req: Request, session: [36]u8) !Snapshot {
    const meta = try client.call("thread/read", .{ .threadId = &session, .includeTurns = false });
    defer meta.deinit();
    const thread = field(result(meta.value), "thread");
    if (!eq(u8, agents.str(thread, "id"), &session)) return error.WrongThread;
    const status = field(thread, "status");
    const kind = agents.str(status, "type");
    var state: agents.State = if (eq(u8, kind, "active")) .working else if (eq(u8, kind, "idle")) .idle else .initializing;
    const flags = field(status, "activeFlags");
    if (flags == .array) for (flags.array.items) |flag| {
        if (flag == .string and (eq(u8, flag.string, "waitingOnApproval") or eq(u8, flag.string, "waitingOnUserInput"))) state = .blocked;
    };
    var out: Snapshot = .{ .request = req, .session = session, .state = state, .observed_at = std.time.microTimestamp() };
    var named: agents.Agent = .{};
    named.setName(agents.str(thread, "name"));
    out.name = named.name;
    out.name_len = named.name_len;
    const path = agents.str(thread, "path");
    if (std.fs.path.isAbsolute(path) and path.len <= out.transcript.len) {
        @memcpy(out.transcript[0..path.len], path);
        out.transcript_len = path.len;
    }
    const turns = try client.call("thread/turns/list", .{ .threadId = &session, .limit = 1, .sortDirection = "desc", .itemsView = "summary" });
    defer turns.deinit();
    const data = field(result(turns.value), "data");
    if (data == .array and data.array.items.len > 0) {
        const turn = data.array.items[0];
        out.evidence = @import("activity_summary.zig").codex(turn);
        const id = agents.str(turn, "id");
        if (id.len > 0 and id.len <= out.turn.len) {
            @memcpy(out.turn[0..id.len], id);
            out.turn_len = id.len;
            const ts = agents.str(turn, "status");
            out.outcome = if (eq(u8, ts, "completed")) .completed else if (eq(u8, ts, "interrupted")) .interrupted else if (eq(u8, ts, "failed")) .failed else null;
        }
    }
    return out;
}
// Initial attachment establishes a baseline; historic completions never ring.
// Repeated polls and reconnects cannot duplicate a completion for the same turn.
pub fn apply(agent: *agents.Agent, s: Snapshot, watched: bool) bool {
    if (s.observed_at <= agent.last_seq) return false;
    const binding = !eq(u8, agent.sessionId(), &s.session);
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
    agent.name = s.name;
    agent.name_len = s.name_len;
    const old_state = agent.state;
    agent.state = s.state;
    agent.last_seq = s.observed_at;
    agent.observation.source = .protocol;
    agent.observation.pending_stop = false;
    agent.tool_active = false;
    agent.tool_len = 0;
    const same_turn = eq(u8, agent.turnId(), s.turn[0..s.turn_len]);
    if (!same_turn or old_state != s.state or s.state != .working) agent.activity_len = 0;
    agent.activity_generation = s.evidence.hash();
    var ding = false;
    if (s.turn_len > 0) {
        @memcpy(agent.turn[0..s.turn_len], s.turn[0..s.turn_len]);
        agent.turn_len = s.turn_len;
        if (s.outcome) |outcome| {
            if (!eq(u8, s.turn[0..s.turn_len], agent.last_finished_turn[0..agent.last_finished_turn_len])) {
                @memcpy(agent.last_finished_turn[0..s.turn_len], s.turn[0..s.turn_len]);
                agent.last_finished_turn_len = s.turn_len;
                if (!binding) {
                    agent.observation.finish(outcome, .protocol);
                    ding = outcome == .completed and !watched;
                }
            }
        }
    }
    agent.attention = if (s.state == .blocked and !watched) .needs_input else if (agent.observation.unread()) .finished else .none;
    return ding or (!binding and s.state == .blocked and old_state != .blocked and !watched);
}
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    requests: [max]Request = undefined,
    count: usize = 0,
    results: [max]?Snapshot = .{null} ** max,
    thread: ?std.Thread = null,
    socket: []const u8,
    pub fn start() !*Worker {
        const home = os.env("HOME") orelse return error.NoHome;
        const root = os.env("CODEX_HOME") orelse try std.fs.path.join(a, &.{ home, ".codex" });
        defer if (os.env("CODEX_HOME") == null) a.free(root);
        const path = try std.fs.path.join(a, &.{ root, "app-server-control/app-server-control.sock" });
        errdefer a.free(path);
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{ .socket = path };
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.mutex.lock();
        w.stopping = true;
        w.wake.signal();
        w.mutex.unlock();
        w.thread.?.join();
        a.free(w.socket);
        a.destroy(w);
    }
    pub fn reconcile(w: *Worker, panes: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.count = 0;
        for (panes) |p| {
            if (p.terminal.exited or p.agent.provider != .codex or p.detection.pid <= 0 or p.detection.missing != 0 or p.terminal.title_pid != p.detection.pid) continue;
            const prefix = titlePrefix(p.terminal.vt.getTitle() orelse "") orelse continue;
            w.requests[w.count] = .{ .pane = p.id, .pid = p.detection.pid, .prefix = prefix };
            w.count += 1;
            if (w.count == max) break;
        }
    }
    pub fn take(w: *Worker, out: *[max]?Snapshot) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        out.* = w.results;
        w.results = .{null} ** max;
    }
    fn stopped(w: *Worker) bool {
        w.mutex.lock();
        defer w.mutex.unlock();
        return w.stopping;
    }
    fn run(w: *Worker) void {
        while (true) {
            var requests: [max]Request = undefined;
            w.mutex.lock();
            w.wake.timedWait(&w.mutex, 500 * std.time.ns_per_ms) catch {};
            if (w.stopping) {
                w.mutex.unlock();
                return;
            }
            const count = w.count;
            @memcpy(requests[0..count], w.requests[0..count]);
            w.mutex.unlock();
            if (count == 0) continue;
            var client = Client.open(w.socket) catch continue;
            defer client.close();
            // Loaded threads include untouched new sessions absent from disk.
            // Collect every page before resolving, so collisions fail closed.
            var ids: std.ArrayList(std.json.Value) = .empty;
            defer {
                for (ids.items) |id| a.free(id.string);
                ids.deinit(a);
            }
            w.collect(&client, &ids) catch continue;
            for (requests[0..count], 0..) |req, i| {
                if (w.stopped()) return;
                const session = unique(ids.items, &req.prefix) orelse continue;
                const s = snapshot(&client, req, session) catch break;
                w.mutex.lock();
                w.results[i] = s;
                w.mutex.unlock();
            }
        }
    }
    fn collect(w: *Worker, client: *Client, ids: *std.ArrayList(std.json.Value)) !void {
        var cursor: ?[]const u8 = null;
        defer if (cursor) |p| a.free(p);
        for (0..32) |_| {
            if (w.stopped()) return error.Stopped;
            const page = try client.call("thread/loaded/list", .{ .cursor = cursor, .limit = 100 });
            defer page.deinit();
            const data = field(result(page.value), "data");
            if (data != .array) return error.BadResponse;
            for (data.array.items) |id| if (id == .string) {
                const copy = try a.dupe(u8, id.string);
                errdefer a.free(copy);
                try ids.append(a, .{ .string = copy });
            };
            const next = field(result(page.value), "nextCursor");
            if (next == .null) return;
            if (next != .string) return error.BadResponse;
            if (cursor) |p| a.free(p);
            cursor = null;
            cursor = try a.dupe(u8, next.string);
        }
        return error.TooManyThreads;
    }
};

test "title UUID parsing handles truncation and refuses ambiguity" {
    const id = "01901234-1234-1234-1234-123456789abc";
    try std.testing.expectEqualStrings(id, titlePrefix("codex | " ++ id ++ " | Ready").?.text());
    try std.testing.expectEqualStrings(id[0..29], titlePrefix("codex | 01901234-1234-1234-1234-12345...").?.text());
    try std.testing.expect(titlePrefix("project 01901234") == null);
    try std.testing.expect(titlePrefix(id ++ " " ++ id) == null);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, "[\"01901234-1234-1234-1234-123456789abc\",\"01901234-1234-1234-1234-123456789def\"]", .{});
    defer parsed.deinit();
    var prefix = titlePrefix("01901234-1234-1234-1234-12345...").?;
    try std.testing.expect(unique(parsed.value.array.items, &prefix) == null);
}
test "snapshot baseline and completion receipts are idempotent" {
    var agent: agents.Agent = .{};
    var s: Snapshot = .{ .request = .{ .pane = 1, .pid = 1, .prefix = .{} }, .session = "01901234-1234-1234-1234-123456789abc".*, .state = .idle, .turn_len = 1, .outcome = .completed, .observed_at = 1 };
    s.turn[0] = 'a';
    try std.testing.expect(!apply(&agent, s, false));
    s.turn[0] = 'b';
    s.observed_at = 2;
    try std.testing.expect(apply(&agent, s, false));
    try std.testing.expect(!apply(&agent, s, false));
    try std.testing.expectEqual(@as(u64, 1), agent.observation.completed);
}
