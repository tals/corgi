//! Title-selected, read-only daemon observation. Never resumes or subscribes a
//! thread, and never changes the CLI transport or launch configuration.
const std = @import("std");
const conversations = @import("conversations.zig");
const ActorId = conversations.Actor.Id;
const os = @import("os.zig");
const agents = @import("agents.zig");
const providers = @import("providers.zig");
const Client = @import("codex_socket.zig").Client;
const a = os.allocator;
const layout = @import("layout.zig");
const max = layout.max_panes;
const background_tasks = @import("background_tasks.zig");
const activity_summary = @import("activity_summary.zig");
const passes = @import("passes.zig");
const BoundedText = @import("bounded_text.zig").BoundedText;
const SessionPrefix = providers.SessionPrefix;
const Codex = providers.Codex;
pub const Request = struct { pane: layout.PaneId = .none, pid: c_int = 0, prefix: SessionPrefix, actor: ActorId = .none, generation: u64 = 0, title_revision: u64 = 0 };
pub const Snapshot = struct {
    background_tasks: background_tasks.Inventory = .{},
    children: []const Child = &.{},
    children_complete: bool = false,
    subagents: agents.Subagents = .{},
    evidence: activity_summary.Text = .{},
    name: agents.Text = .{},
    request: Request,
    session: [36]u8,
    state: agents.State,
    transcript: agents.Path = .{},
    turn: BoundedText(128) = .{},
    outcome: ?agents.observation.Outcome = null,
    observed_at: i64,
    updated_at: i64 = 0,
    pub fn deinit(s: Snapshot) void {
        if (s.children.len > 0) a.free(s.children);
    }
};
pub const Child = struct {
    session: [36]u8,
    name: BoundedText(160) = .{},
    role: BoundedText(80) = .{},
    transcript: agents.Path = .{},
    state: agents.State = .unknown,
    updated_at: i64 = 0,
};
fn field(v: std.json.Value, key: []const u8) std.json.Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
fn result(v: std.json.Value) std.json.Value {
    return field(v, "result");
}
fn unique(ids: []const std.json.Value, prefix: *const SessionPrefix) ?[36]u8 {
    var found: ?[36]u8 = null;
    for (ids) |id| {
        if (id != .string or id.string.len != 36 or !std.mem.startsWith(u8, id.string, prefix.text())) continue;
        if (found != null) return null;
        found = id.string[0..36].*;
    }
    return found;
}
// Codex app-server thread `status.type` values.
const ThreadStatus = enum { active, idle, notLoaded, systemError };
// `status.activeFlags` entries that mean the thread needs a human.
const ActiveFlag = enum { waitingOnApproval, waitingOnUserInput };
fn needsInput(status: std.json.Value) bool {
    const flags = field(status, "activeFlags");
    if (flags == .array) for (flags.array.items) |flag| {
        if (flag == .string and std.meta.stringToEnum(ActiveFlag, flag.string) != null) return true;
    };
    return false;
}
// Child census and child snapshots must agree, or each poll flips the child
// between states. A thread the daemon has not loaded (e.g. an old subagent of
// a resumed session) or that stopped on a system error is not running.
fn threadState(status: std.json.Value) agents.State {
    const kind = std.meta.stringToEnum(ThreadStatus, agents.str(status, "type")) orelse return .unknown;
    return switch (kind) {
        .active => if (needsInput(status)) .blocked else .working,
        .idle, .notLoaded, .systemError => .idle,
    };
}
const Children = struct { status: agents.Subagents = .{}, any: bool = false, entries: std.ArrayList(Child) = .empty };
fn countChild(out: *Children, thread: std.json.Value, parent: []const u8) !void {
    // Validate the relation even if an older daemon ignores the filter.
    if (!std.mem.eql(u8, agents.str(thread, "parentThreadId"), parent)) return;
    out.any = true;
    const status = field(thread, "status");
    const kind = std.meta.stringToEnum(ThreadStatus, agents.str(status, "type"));
    const id = agents.str(thread, "id");
    for (out.entries.items) |entry| if (std.mem.eql(u8, &entry.session, id)) return;
    if (kind == .active) {
        if (needsInput(status)) out.status.blocked +|= 1 else out.status.running +|= 1;
    }
    const parsed_id = Codex.titleSession(id) orelse return;
    if (parsed_id.len != 36 or std.mem.eql(u8, id, parent)) return;
    if (out.entries.items.len >= conversations.max_actors) return error.TooManyThreads;
    var child: Child = .{ .session = parsed_id.bytes, .state = threadState(status) };
    const name = agents.str(thread, "name");
    child.name = .ascii(if (name.len > 0) name else agents.str(thread, "agentNickname"));
    child.role = .ascii(agents.str(thread, "agentRole"));
    const path = agents.str(thread, "path");
    if (std.fs.path.isAbsolute(path)) child.transcript = agents.Path.init(path) catch .{};
    const updated = field(thread, "updatedAt");
    if (updated == .integer) child.updated_at = updated.integer;
    try out.entries.append(a, child);
}
fn children(client: *Client, session: []const u8) !Children {
    var out: Children = .{};
    errdefer out.entries.deinit(a);
    var cursor: ?[]const u8 = null;
    defer if (cursor) |p| a.free(p);
    const deadline = std.time.milliTimestamp() + 1000;
    for (0..32) |_| {
        if (std.time.milliTimestamp() >= deadline) return error.Timeout;
        const page = try client.call("thread/list", .{ .parentThreadId = session, .sourceKinds = &.{"subAgent"}, .useStateDbOnly = true, .limit = 100, .cursor = cursor });
        defer page.deinit();
        const data = field(result(page.value), "data");
        if (data != .array) return error.BadResponse;
        for (data.array.items) |thread| try countChild(&out, thread, session);
        const next = field(result(page.value), "nextCursor");
        if (next == .null) return out;
        if (next != .string) return error.BadResponse;
        if (cursor) |p| a.free(p);
        cursor = null;
        cursor = try a.dupe(u8, next.string);
    }
    return error.TooManyThreads;
}
fn isActiveWait(entry: std.json.Value, turn: []const u8, session: []const u8) bool {
    if (!std.mem.eql(u8, agents.str(entry, "turnId"), turn)) return false;
    const item = field(entry, "item");
    return std.mem.eql(u8, agents.str(item, "type"), "collabAgentToolCall") and
        std.mem.eql(u8, agents.str(item, "tool"), "wait") and
        std.mem.eql(u8, agents.str(item, "status"), "inProgress") and
        std.mem.eql(u8, agents.str(item, "senderThreadId"), session);
}
fn waiting(client: *Client, session: []const u8, turn: []const u8) !bool {
    var cursor: ?[]const u8 = null;
    defer if (cursor) |p| a.free(p);
    const deadline = std.time.milliTimestamp() + 1000;
    for (0..32) |_| {
        if (std.time.milliTimestamp() >= deadline) return error.Timeout;
        const page = try client.call("thread/items/list", .{ .threadId = session, .turnId = turn, .limit = 100, .sortDirection = "desc", .cursor = cursor });
        defer page.deinit();
        const data = field(result(page.value), "data");
        if (data != .array) return error.BadResponse;
        for (data.array.items) |entry| if (isActiveWait(entry, turn, session)) return true;
        const next = field(result(page.value), "nextCursor");
        if (next == .null) return false;
        if (next != .string) return error.BadResponse;
        if (cursor) |p| a.free(p);
        cursor = null;
        cursor = try a.dupe(u8, next.string);
    }
    return error.TooManyItems;
}
fn snapshot(client: *Client, req: Request, session: [36]u8) !Snapshot {
    const meta = try client.call("thread/read", .{ .threadId = &session, .includeTurns = false });
    defer meta.deinit();
    const thread = field(result(meta.value), "thread");
    if (!std.mem.eql(u8, agents.str(thread, "id"), &session)) return error.WrongThread;
    var state = threadState(field(thread, "status"));
    if (state == .unknown) state = .initializing;
    var out: Snapshot = .{ .request = req, .session = session, .state = state, .observed_at = std.time.microTimestamp() };
    const updated = field(thread, "updatedAt");
    if (updated == .integer and updated.integer > 0) out.updated_at = updated.integer;
    out.name = .initTruncated(agents.str(thread, "name"));
    const path = agents.str(thread, "path");
    if (std.fs.path.isAbsolute(path)) out.transcript = agents.Path.init(path) catch .{};
    const turns = try client.call("thread/turns/list", .{ .threadId = &session, .limit = 1, .sortDirection = "desc", .itemsView = "summary" });
    defer turns.deinit();
    const data = field(result(turns.value), "data");
    if (data == .array and data.array.items.len > 0) {
        const turn = data.array.items[0];
        out.evidence = activity_summary.codex(turn);
        const id = agents.str(turn, "id");
        if (id.len > 0) if (@TypeOf(out.turn).init(id)) |value| {
            out.turn = value;
            out.outcome = std.meta.stringToEnum(agents.observation.Outcome, agents.str(turn, "status"));
        } else |_| {};
    }
    // These optional reads must not suppress parent status/completion on older
    // daemons or a failed page. Never publish a partial child count as exact.
    out.background_tasks = backgroundTasks(client, &session, out.observed_at) catch .{};
    if (out.background_tasks.len > 0) {
        const commentary = out.evidence;
        out.evidence = .{};
        out.evidence.append("Currently running background tasks:\n");
        for (out.background_tasks.items[0..@min(4, out.background_tasks.len)]) |task| {
            out.evidence.append(task.label.text());
            out.evidence.append("\n");
        }
        out.evidence.append(commentary.text());
    }
    var child = children(client, &session) catch return out;
    defer child.entries.deinit(a);
    out.children = try child.entries.toOwnedSlice(a);
    out.children_complete = true;
    out.subagents = child.status;
    if (child.any and state == .working and out.turn.len > 0 and out.outcome == null) {
        out.subagents.waiting = waiting(client, &session, out.turn.text()) catch false;
    }
    return out;
}

fn backgroundTasks(client: *Client, session: []const u8, now: i64) !background_tasks.Inventory {
    var out: background_tasks.Inventory = .{ .observed_at = now, .live = true };
    // A bounded page is sufficient for the tooltip; explicitly mark overflow.
    const response = try client.call("thread/backgroundTerminals/list", .{ .threadId = session, .limit = background_tasks.capacity });
    defer response.deinit();
    const body = result(response.value);
    const data = field(body, "data");
    if (data != .array) return error.BadResponse;
    for (data.array.items) |item| out.append(agents.str(item, "processId"), "", agents.str(item, "command"));
    out.truncated = out.truncated or field(body, "nextCursor") != .null;
    return out;
}
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    passes: passes.Passes = .{},
    requests: [max]Request = undefined,
    count: usize = 0,
    cursor: usize = 0,
    results: [max]?Snapshot = .{null} ** max,
    thread: ?std.Thread = null,
    socket: []const u8,
    pub fn start() !*Worker {
        const root = try Codex.info.configDir(a);
        defer a.free(root);
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
        for (w.results) |entry| if (entry) |s| s.deinit();
        a.free(w.socket);
        a.destroy(w);
    }
    pub fn reconcile(w: *Worker, runtime: anytype) void {
        w.mutex.lock();
        defer w.mutex.unlock();
        w.count = 0;
        for (runtime.panes.items) |p| {
            if (p.terminal.exited or p.agent().provider != .codex or p.detection.pid <= 0 or p.detection.missing != 0 or p.terminal.title_pid != p.detection.pid) continue;
            const prefix = Codex.titleSession(p.terminal.vt.getTitle() orelse "") orelse continue;
            w.requests[w.count] = .{ .pane = p.id, .pid = p.detection.pid, .prefix = prefix, .generation = p.attachment.generation, .title_revision = p.terminal.title_revision };
            w.count += 1;
            if (w.count == max) break;
        }
        // Explicitly identified background conversations remain observable after
        // the terminal selects another session. Never infer these from cwd.
        const actors = runtime.conversations.items.items;
        for (0..actors.len) |offset| {
            if (w.count == max) break;
            const actor = actors[(w.cursor + offset) % actors.len];
            if (actor.state.provider != .codex or actor.state.session.len != 36 or
                (actor.state.state != .working and actor.state.state != .blocked and !actor.child_refresh)) continue;
            const selected = for (runtime.panes.items) |p| {
                if (!p.terminal.exited and p.attachment.actor == actor) break true;
            } else false;
            if (selected) continue;
            w.requests[w.count] = .{ .actor = actor.id, .prefix = .initTruncated(actor.state.sessionId()) };
            w.count += 1;
        }
        if (actors.len > 0) w.cursor = (w.cursor + 1) % actors.len;
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
            if (!w.passes.next()) w.wake.timedWait(&w.mutex, 500 * std.time.ns_per_ms) catch {};
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
                const session = if (req.actor != ActorId.none) req.prefix.bytes else unique(ids.items, &req.prefix) orelse continue;
                const s = snapshot(&client, req, session) catch continue;
                w.mutex.lock();
                if (w.results[i]) |old| old.deinit();
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
    try std.testing.expectEqualStrings(id, Codex.titleSession("codex | " ++ id ++ " | Ready").?.text());
    try std.testing.expectEqualStrings(id[0..29], Codex.titleSession("codex | 01901234-1234-1234-1234-12345...").?.text());
    try std.testing.expect(Codex.titleSession("project 01901234") == null);
    try std.testing.expect(Codex.titleSession(id ++ " " ++ id) == null);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, "[\"01901234-1234-1234-1234-123456789abc\",\"01901234-1234-1234-1234-123456789def\"]", .{});
    defer parsed.deinit();
    var prefix = Codex.titleSession("01901234-1234-1234-1234-12345...").?;
    try std.testing.expect(unique(parsed.value.array.items, &prefix) == null);
}
test "unloaded child threads read as idle" {
    const cases = [_]struct { json: []const u8, state: agents.State }{
        .{ .json = "{\"type\":\"notLoaded\"}", .state = .idle },
        .{ .json = "{\"type\":\"systemError\"}", .state = .idle },
        .{ .json = "{\"type\":\"idle\"}", .state = .idle },
        .{ .json = "{\"type\":\"active\",\"activeFlags\":[]}", .state = .working },
        .{ .json = "{\"type\":\"active\",\"activeFlags\":[\"waitingOnApproval\"]}", .state = .blocked },
        .{ .json = "{\"type\":\"future\"}", .state = .unknown },
    };
    for (cases) |case| {
        const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, case.json, .{});
        defer parsed.deinit();
        try std.testing.expectEqual(case.state, threadState(parsed.value));
    }
}
