//! Durable, provider-native JSONL transports. Approval requests are retained
//! separately from the bounded event journal and are never auto-answered.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
pub const Event = struct { seq: u64, line: []const u8 };
pub const Tool = struct {
    id: []const u8,
    thread: []const u8,
    turn: []const u8,
    fn deinit(t: Tool) void {
        a.free(t.id);
        a.free(t.thread);
        a.free(t.turn);
    }
};
pub const Session = struct {
    id: u32,
    provider: agents.Provider,
    cwd: []const u8,
    child: std.process.Child,
    ready: bool = false,
    imported: bool = false,
    resume_hint: @import("checkpoint.zig").Resume = .{},
    workspace_id: u32 = 0,
    exited: bool = false,
    state: agents.State = .initializing,
    attention: agents.Attention = .none,
    observation: agents.observation.State = .{},
    input: std.ArrayList(u8) = .empty,
    output: std.ArrayList(u8) = .empty,
    deferred: std.ArrayList(u8) = .empty,
    events: std.ArrayList(Event) = .empty,
    approvals: std.ArrayList([]const u8) = .empty,
    active_threads: std.StringHashMapUnmanaged([]const u8) = .empty,
    active_tools: std.ArrayList(Tool) = .empty,
    usage_pending: @import("usage.zig").Counts = .{},
    usage_tracker: @import("usage.zig").Tracker = .{},
    journal_bytes: usize = 0,
    next_seq: u64 = 1,
    pub fn start(id: u32, provider: agents.Provider, cwd: []const u8) !Session {
        const directory = try std.fs.cwd().realpathAlloc(a, cwd);
        errdefer a.free(directory);
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(a);
        const bin = try @import("discovery.zig").resolve(provider, cwd);
        defer a.free(bin);
        switch (provider) {
            .codex => try argv.appendSlice(a, &.{ bin, "app-server", "--listen", "stdio://" }),
            .claude => try argv.appendSlice(a, &.{ bin, "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--permission-prompt-tool", "stdio" }),
            .other => return error.BadProvider,
        }
        var child = std.process.Child.init(argv.items, a);
        var env = try std.process.getEnvMap(a);
        defer env.deinit();
        env.remove("CORGI_PANE");
        child.env_map = &env;
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = .Inherit;
        child.cwd = cwd;
        child.pgid = 0;
        try child.spawn();
        try child.waitForSpawn();
        os.nonblock(child.stdout.?.handle);
        os.nonblock(child.stdin.?.handle);
        os.cloexec(child.stdout.?.handle);
        os.cloexec(child.stdin.?.handle);
        var result: Session = .{ .id = id, .provider = provider, .cwd = directory, .child = child, .ready = provider == .claude, .state = if (provider == .claude) .idle else .initializing };
        result.resume_hint.provider = provider;
        if (provider == .codex) try result.queue(.{ .id = "__corgi_init", .method = "initialize", .params = .{ .clientInfo = .{ .name = "corgi", .version = "0.1.0" } } });
        return result;
    }
    pub fn destroy(s: *Session) void {
        a.free(s.cwd);
        if (!s.exited) {
            _ = c.kill(-s.child.id, c.SIGKILL);
            var status: c_int = 0;
            _ = c.waitpid(s.child.id, &status, 0);
        }
        if (s.child.stdin) |f| f.close();
        if (s.child.stdout) |f| f.close();
        for (s.events.items) |event| a.free(event.line);
        for (s.approvals.items) |line| a.free(line);
        var threads = s.active_threads.iterator();
        while (threads.next()) |entry| {
            a.free(entry.key_ptr.*);
            a.free(entry.value_ptr.*);
        }
        s.active_threads.deinit(a);
        s.clearTools(null, null);
        s.active_tools.deinit(a);
        s.events.deinit(a);
        s.approvals.deinit(a);
        s.input.deinit(a);
        s.output.deinit(a);
        s.deferred.deinit(a);
    }
    pub fn markExited(s: *Session) void {
        s.exited = true;
        s.state = .done;
        s.clearTools(null, null);
    }
    pub fn toolActive(s: *const Session) bool {
        if (s.exited) return false;
        if (s.active_tools.items.len > 0) return true;
        for (s.approvals.items) |line| {
            const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch continue;
            defer parsed.deinit();
            const v = parsed.value;
            if (s.provider == .codex) {
                const method = agents.str(v, "method");
                if (eq(method, "item/commandExecution/requestApproval") or eq(method, "item/fileChange/requestApproval") or eq(method, "item/tool/call") or eq(method, "item/tool/requestUserInput")) return true;
            } else if (v == .object) {
                const request = v.object.get("request") orelse continue;
                if (eq(agents.str(request, "subtype"), "can_use_tool")) return true;
            }
        }
        return false;
    }
    fn startTool(s: *Session, id: []const u8, thread: []const u8, turn: []const u8) !void {
        if (id.len == 0 or id.len > 256 or thread.len > 256 or turn.len > 256) return;
        for (s.active_tools.items) |tool| if (eq(tool.id, id) and eq(tool.thread, thread)) return;
        if (s.active_tools.items.len >= 128) return error.TooManyNativeTools;
        const owned_id = try a.dupe(u8, id);
        errdefer a.free(owned_id);
        const owned_thread = try a.dupe(u8, thread);
        errdefer a.free(owned_thread);
        const owned_turn = try a.dupe(u8, turn);
        errdefer a.free(owned_turn);
        try s.active_tools.append(a, .{ .id = owned_id, .thread = owned_thread, .turn = owned_turn });
        s.usage_pending.tools +|= 1;
        s.state = .working;
        s.attention = if (s.observation.unread()) .finished else .none;
    }
    fn finishTool(s: *Session, id: []const u8, thread: []const u8) void {
        for (s.active_tools.items, 0..) |tool, i| {
            if (eq(tool.id, id) and eq(tool.thread, thread)) {
                s.active_tools.swapRemove(i).deinit();
                return;
            }
        }
    }
    fn clearTools(s: *Session, thread: ?[]const u8, turn: ?[]const u8) void {
        var i: usize = 0;
        while (i < s.active_tools.items.len) {
            const tool = s.active_tools.items[i];
            if ((thread == null or eq(tool.thread, thread.?)) and (turn == null or eq(tool.turn, turn.?))) {
                s.active_tools.swapRemove(i).deinit();
            } else i += 1;
        }
    }
    fn observeTools(s: *Session, v: std.json.Value, params: std.json.Value, method: []const u8, kind: []const u8) !void {
        if (s.provider == .codex and params == .object) {
            const thread = agents.str(params, "threadId");
            if (eq(method, "thread/tokenUsage/updated")) {
                const usage = @import("usage.zig");
                s.usage_pending.add(s.usage_tracker.codexNotification(thread, usage.field(params, "tokenUsage"), s.active_threads.contains(thread)));
            }
            if (eq(method, "item/started") or eq(method, "item/completed")) {
                const item = params.object.get("item") orelse return;
                const id = agents.str(item, "id");
                if (eq(method, "item/completed")) {
                    s.finishTool(id, thread);
                } else {
                    const item_kind = agents.str(item, "type");
                    for ([_][]const u8{ "commandExecution", "fileChange", "mcpToolCall", "dynamicToolCall", "collabAgentToolCall", "webSearch", "imageView", "imageGeneration" }) |tool_kind| {
                        if (eq(item_kind, tool_kind)) {
                            try s.startTool(id, thread, agents.str(params, "turnId"));
                            break;
                        }
                    }
                }
            } else if (eq(method, "turn/completed")) {
                const turn = agents.str(params.object.get("turn") orelse .null, "id");
                s.clearTools(thread, if (turn.len > 0) turn else null);
            }
        } else if (s.provider == .claude and v == .object) {
            if (eq(kind, "result")) {
                s.clearTools(null, null);
                return;
            }
            if (!eq(kind, "assistant") and !eq(kind, "user")) return;
            const message = v.object.get("message") orelse return;
            if (message != .object) return;
            if (eq(kind, "assistant")) {
                var delta = s.usage_tracker.claudeMessage(message);
                delta.tools = 0; // startTool owns native tool accounting.
                s.usage_pending.add(delta);
            }
            const content = message.object.get("content") orelse return;
            if (content != .array) return;
            for (content.array.items) |block| {
                const block_kind = agents.str(block, "type");
                if (eq(block_kind, "tool_use")) try s.startTool(agents.str(block, "id"), "", "") else if (eq(block_kind, "tool_result")) s.finishTool(agents.str(block, "tool_use_id"), "");
            }
        }
    }
    fn queue(s: *Session, v: anytype) !void {
        const line = try std.json.Stringify.valueAlloc(a, v, .{});
        defer a.free(line);
        if (s.output.items.len + line.len > 1024 * 1024) return error.NativeBackpressure;
        try s.output.appendSlice(a, line);
        try s.output.append(a, '\n');
    }
    pub fn send(s: *Session, v: std.json.Value) !void {
        if (s.exited) return error.NativeExited;
        if (v != .object) return error.InvalidMessage;
        if (eq(agents.str(v, "id"), "__corgi_init")) return error.ReservedRequestId;
        if (s.ready) try s.queue(v) else {
            const line = try std.json.Stringify.valueAlloc(a, v, .{});
            defer a.free(line);
            if (s.deferred.items.len + line.len > 1024 * 1024) return error.NativeBackpressure;
            try s.deferred.appendSlice(a, line);
            try s.deferred.append(a, '\n');
        }
        // Explicit provider responses remove only their matching pending request.
        const response_id = responseId(s.provider, v);
        if (response_id) |id| {
            var i: usize = 0;
            var removed = false;
            while (i < s.approvals.items.len) {
                const parsed = try std.json.parseFromSlice(std.json.Value, a, s.approvals.items[i], .{});
                defer parsed.deinit();
                if (requestId(s.provider, parsed.value)) |pending_id| {
                    if (std.meta.activeTag(id) == std.meta.activeTag(pending_id) and ((id == .string and eq(id.string, pending_id.string)) or (id == .integer and id.integer == pending_id.integer))) {
                        a.free(s.approvals.orderedRemove(i));
                        removed = true;
                        continue;
                    }
                }
                i += 1;
            }
            if (removed and s.approvals.items.len == 0) {
                s.attention = if (s.observation.unread()) .finished else .none;
                s.state = .working;
            }
        }
    }
    pub fn flush(s: *Session) void {
        if (s.exited) return;
        while (s.output.items.len > 0) {
            const n = c.write(s.child.stdin.?.handle, s.output.items.ptr, s.output.items.len);
            if (n <= 0) break;
            const count: usize = @intCast(n);
            std.mem.copyForwards(u8, s.output.items[0 .. s.output.items.len - count], s.output.items[count..]);
            s.output.items.len -= count;
        }
    }
    pub fn poll(s: *Session) !bool {
        if (s.exited) return false;
        s.flush();
        var ding = false;
        var buf: [16384]u8 = undefined;
        for (0..8) |_| {
            const n = c.read(s.child.stdout.?.handle, &buf, buf.len);
            if (n <= 0) {
                if (s.imported and n == 0) s.markExited();
                break;
            }
            try s.input.appendSlice(a, buf[0..@intCast(n)]);
            if (s.input.items.len > 4 * 1024 * 1024) return error.NativeMessageTooLarge;
            var consumed: usize = 0;
            while (std.mem.indexOfScalarPos(u8, s.input.items, consumed, '\n')) |end| {
                const line = s.input.items[consumed..end];
                const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch {
                    consumed = end + 1;
                    continue;
                };
                defer parsed.deinit();
                const v = parsed.value;
                if (s.provider == .codex and eq(agents.str(v, "id"), "__corgi_init")) {
                    if (v == .object and v.object.contains("error")) return error.NativeInitializeFailed;
                    try s.queue(.{ .method = "initialized" });
                    try s.output.appendSlice(a, s.deferred.items);
                    s.deferred.clearRetainingCapacity();
                    s.ready = true;
                    s.state = .idle;
                }
                const old = s.state;
                const method = agents.str(v, "method");
                const kind = agents.str(v, "type");
                const params = if (v == .object) v.object.get("params") orelse .null else .null;
                const thread_id = agents.str(params, "threadId");
                // Remember concrete provider IDs, never infer a session from cwd.
                var session_id = if (s.provider == .claude) agents.str(v, "session_id") else thread_id;
                if (session_id.len == 0 and s.provider == .codex and v == .object) {
                    const result = v.object.get("result") orelse params;
                    if (result == .object) session_id = agents.str(result.object.get("thread") orelse .null, "id");
                }
                s.resume_hint.provider = s.provider;
                if (session_id.len > 0 and session_id.len <= s.resume_hint.session.len) s.resume_hint.len = agents.clean(&s.resume_hint.session, session_id);
                try s.observeTools(v, params, method, kind);
                if (requestId(s.provider, v) != null) {
                    if (s.approvals.items.len >= 64) return error.TooManyNativeRequests;
                    try s.approvals.append(a, try a.dupe(u8, line));
                    s.state = .blocked;
                    s.attention = .needs_input;
                } else if (eq(method, "turn/started") or eq(kind, "assistant")) {
                    if (thread_id.len > 0) {
                        const turn = agents.str(if (params == .object) params.object.get("turn") orelse .null else .null, "id");
                        if (s.active_threads.fetchRemove(thread_id)) |entry| {
                            a.free(entry.key);
                            a.free(entry.value);
                        }
                        try s.active_threads.put(a, try a.dupe(u8, thread_id), try a.dupe(u8, turn));
                    }
                    s.state = .working;
                    s.attention = if (s.observation.unread()) .finished else .none;
                } else if (eq(method, "turn/completed") or eq(kind, "result")) {
                    const turn = if (params == .object) params.object.get("turn") orelse .null else .null;
                    const turn_id = agents.str(turn, "id");
                    const active_turn = s.active_threads.get(thread_id);
                    const matches = if (s.provider == .codex) active_turn != null and (active_turn.?.len == 0 or eq(active_turn.?, turn_id)) else old == .working or old == .blocked;
                    if (matches) {
                        if (s.active_threads.fetchRemove(thread_id)) |entry| {
                            a.free(entry.key);
                            a.free(entry.value);
                        }
                        const status = agents.str(turn, "status");
                        const failed = if (v.object.get("is_error")) |flag| flag == .bool and flag.bool else false;
                        const outcome: agents.observation.Outcome = if (eq(status, "interrupted")) .interrupted else if (eq(status, "failed") or failed) .failed else .completed;
                        s.observation.finish(outcome, .protocol);
                        s.state = if (s.active_threads.count() > 0) .working else .idle;
                        s.attention = .finished;
                        if (outcome == .completed) ding = true;
                    }
                }
                if (s.approvals.items.len > 0) {
                    s.state = .blocked;
                    s.attention = .needs_input;
                }
                if (s.state != old and s.attention == .needs_input) ding = true;
                while (s.events.items.len > 0 and (s.events.items.len >= 128 or s.journal_bytes + line.len > 4 * 1024 * 1024)) {
                    const discarded = s.events.orderedRemove(0);
                    s.journal_bytes -= discarded.line.len;
                    a.free(discarded.line);
                }
                try s.events.append(a, .{ .seq = s.next_seq, .line = try a.dupe(u8, line) });
                s.journal_bytes += line.len;
                s.next_seq += 1;
                consumed = end + 1;
            }
            std.mem.copyForwards(u8, s.input.items[0 .. s.input.items.len - consumed], s.input.items[consumed..]);
            s.input.items.len -= consumed;
        }
        return ding;
    }
};
fn requestId(provider: agents.Provider, v: std.json.Value) ?std.json.Value {
    if (v != .object) return null;
    if (provider == .codex) {
        if (agents.str(v, "method").len == 0) return null;
        return v.object.get("id");
    }
    if (eq(agents.str(v, "type"), "control_request")) return v.object.get("request_id");
    return null;
}
fn responseId(provider: agents.Provider, v: std.json.Value) ?std.json.Value {
    if (provider == .codex) {
        if (!v.object.contains("result") and !v.object.contains("error")) return null;
        return v.object.get("id");
    }
    if (!eq(agents.str(v, "type"), "control_response")) return null;
    const response = v.object.get("response") orelse return null;
    return if (response == .object) response.object.get("request_id") else null;
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
