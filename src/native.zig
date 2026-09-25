//! Durable, provider-native JSONL transports. Approval requests are retained
//! separately from the bounded event journal and are never auto-answered.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
const conversations = @import("conversations.zig");
const providers = @import("providers.zig");
pub const Event = struct { seq: u64, line: []const u8 };
pub const PendingRequest = struct { line: []const u8, actor: ?*conversations.Actor };
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
    attachment: conversations.Attachment = .{},
    members: std.ArrayList(*conversations.Actor) = .empty,
    requests_released: bool = false,
    input: std.ArrayList(u8) = .empty,
    output: std.ArrayList(u8) = .empty,
    deferred: std.ArrayList(u8) = .empty,
    events: std.ArrayList(Event) = .empty,
    approvals: std.ArrayList(PendingRequest) = .empty,
    active_threads: std.StringHashMapUnmanaged([]const u8) = .empty,
    active_tools: std.ArrayList(Tool) = .empty,
    usage_pending: @import("usage.zig").Counts = .{},
    usage_tracker: @import("usage.zig").Tracker = .{},
    journal_bytes: usize = 0,
    next_seq: u64 = 1,
    pub fn agent(s: *Session) *agents.Agent {
        return s.attachment.agent();
    }
    pub fn status(s: *const Session) agents.State {
        if (s.exited) return .done;
        if (!s.ready) return .initializing;
        var result = s.attachment.provisional.state;
        for (s.members.items) |owner| {
            if (owner.state.state == .blocked) return .blocked;
            if (owner.state.state == .working) result = .working;
        }
        if (result == .working or result == .blocked) return result;
        return if (s.attachment.actor) |owner| owner.state.state else result;
    }
    pub fn attention(s: *const Session) agents.Attention {
        var result = s.attachment.provisional.attention;
        for (s.members.items) |owner| {
            if (owner.state.attention == .needs_input) return .needs_input;
            if (owner.state.attention == .finished) result = .finished;
        }
        return result;
    }
    pub fn observation(s: *const Session) agents.observation.State {
        var result = s.attachment.provisional.observation;
        for (s.members.items) |owner| {
            result.completed +|= owner.state.observation.completed;
            result.read +|= owner.state.observation.read;
            result.pending_stop = result.pending_stop or owner.state.observation.pending_stop;
            result.source = owner.state.observation.source;
            result.outcome = owner.state.observation.outcome;
        }
        return result;
    }
    pub fn acknowledge(s: *Session) void {
        s.attachment.provisional.acknowledge();
        for (s.members.items) |owner| owner.state.acknowledge();
    }
    fn remember(s: *Session, owner: *conversations.Actor) !void {
        for (s.members.items) |member| if (member == owner) return;
        if (s.members.items.len >= 256) return error.TooManyNativeConversations;
        try s.members.append(a, owner);
    }
    pub fn approvalLines(s: *const Session, alloc: std.mem.Allocator) ![]const []const u8 {
        const lines = try alloc.alloc([]const u8, s.approvals.items.len);
        for (s.approvals.items, lines) |request, *line| line.* = request.line;
        return lines;
    }
    fn hasApproval(s: *const Session, actor: ?*conversations.Actor) bool {
        if (actor) |owner| return owner.pending_native_requests > 0;
        for (s.approvals.items) |request| if (request.actor == actor) return true;
        return false;
    }
    fn releaseRequests(s: *Session) void {
        if (s.requests_released) return;
        s.requests_released = true;
        for (s.approvals.items) |request| if (request.actor) |owner| {
            owner.pending_native_requests -|= 1;
            if (owner.pending_native_requests > 0) {
                owner.state.state = .blocked;
                owner.state.attention = .needs_input;
            } else if (owner.state.attention == .needs_input) {
                owner.state.attention = if (owner.state.observation.unread()) .finished else .none;
            }
        };
    }
    fn syncTools(s: *const Session, target: *agents.Agent) void {
        target.tool_active = false;
        for (s.active_tools.items) |tool| if (eq(tool.thread, target.sessionId())) {
            target.tool_active = true;
            return;
        };
        for (s.approvals.items) |request| {
            const request_target = if (request.actor) |actor| &actor.state else &s.attachment.provisional;
            if (request_target != target) continue;
            const parsed = std.json.parseFromSlice(std.json.Value, a, request.line, .{}) catch continue;
            defer parsed.deinit();
            if (providers.Backend.init(s.provider).nativeEvent(parsed.value).tool_request) {
                target.tool_active = true;
                return;
            }
        }
    }
    pub const Options = struct {
        args: ?[]const []const u8 = null,
        executable: ?[]const u8 = null,
        inference: bool = false,
    };
    pub fn start(id: u32, provider: agents.Provider, cwd: []const u8) !Session {
        return startWithOptions(id, provider, cwd, .{});
    }
    /// The inference worker uses the same native transport with a private
    /// conversation registry and an explicitly restricted harness invocation.
    pub fn startWithOptions(id: u32, provider: agents.Provider, cwd: []const u8, options: Options) !Session {
        const directory = try std.fs.cwd().realpathAlloc(a, cwd);
        errdefer a.free(directory);
        var argv: std.ArrayList([]const u8) = .empty;
        defer argv.deinit(a);
        const bin = if (options.executable) |path| try a.dupe(u8, path) else try @import("discovery.zig").resolve(provider, cwd);
        defer a.free(bin);
        try argv.append(a, bin);
        try argv.appendSlice(a, options.args orelse try providers.Backend.init(provider).nativeArgs());
        var child = std.process.Child.init(argv.items, a);
        var env = try std.process.getEnvMap(a);
        defer env.deinit();
        env.remove("CORGI_PANE");
        if (options.inference) {
            for ([_][]const u8{ "CORGI_SOCKET", "CORGI_NATIVE_SESSION", "CMUX_SURFACE_ID", "CMUX_WORKSPACE_ID", "CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT" }) |key| env.remove(key);
            try env.put("CMUX_CODEX_HOOKS_DISABLED", "1");
        }
        child.env_map = &env;
        child.stdin_behavior = .Pipe;
        child.stdout_behavior = .Pipe;
        child.stderr_behavior = if (options.inference) .Ignore else .Inherit;
        child.cwd = cwd;
        child.pgid = 0;
        try child.spawn();
        errdefer {
            _ = c.kill(-child.id, c.SIGKILL);
            _ = c.waitpid(child.id, null, 0);
            if (child.stdin) |file| file.close();
            if (child.stdout) |file| file.close();
        }
        try child.waitForSpawn();
        os.nonblock(child.stdout.?.handle);
        os.nonblock(child.stdin.?.handle);
        os.cloexec(child.stdout.?.handle);
        os.cloexec(child.stdin.?.handle);
        var result: Session = .{ .id = id, .provider = provider, .cwd = directory, .child = child, .ready = provider == .claude, .attachment = .{ .provisional = .{ .provider = provider, .state = if (provider == .claude) .idle else .initializing } } };
        result.resume_hint.provider = provider;
        if (provider == .codex) try result.queue(.{ .id = "__corgi_init", .method = "initialize", .params = .{ .clientInfo = .{ .name = "corgi", .version = "0.1.0" } } });
        return result;
    }
    pub fn destroy(s: *Session) void {
        s.releaseRequests();
        a.free(s.cwd);
        if (!s.exited) {
            _ = c.kill(-s.child.id, c.SIGKILL);
            var exit_status: c_int = 0;
            _ = c.waitpid(s.child.id, &exit_status, 0);
        }
        if (s.child.stdin) |f| f.close();
        if (s.child.stdout) |f| f.close();
        for (s.events.items) |event| a.free(event.line);
        for (s.approvals.items) |request| a.free(request.line);
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
        s.members.deinit(a);
        s.input.deinit(a);
        s.output.deinit(a);
        s.deferred.deinit(a);
    }
    pub fn markExited(s: *Session) void {
        s.releaseRequests();
        s.exited = true;
        // Losing one transport does not end a conversation observed elsewhere.
        s.attachment.provisional.state = .done;
        s.clearTools(null, null);
    }
    pub fn toolActive(s: *const Session) bool {
        if (s.exited) return false;
        if (s.active_tools.items.len > 0) return true;
        for (s.approvals.items) |request| {
            const parsed = std.json.parseFromSlice(std.json.Value, a, request.line, .{}) catch continue;
            defer parsed.deinit();
            if (providers.Backend.init(s.provider).nativeEvent(parsed.value).tool_request) return true;
        }
        return false;
    }
    fn startTool(s: *Session, target: *agents.Agent, id: []const u8, thread: []const u8, turn: []const u8) !void {
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
        target.state = .working;
        target.attention = if (target.observation.unread()) .finished else .none;
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
    fn observeTools(s: *Session, target: *agents.Agent, v: std.json.Value, params: std.json.Value, method: []const u8, kind: []const u8) !void {
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
                            try s.startTool(target, id, thread, agents.str(params, "turnId"));
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
                s.clearTools(target.sessionId(), null);
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
                if (eq(block_kind, "tool_use")) try s.startTool(target, agents.str(block, "id"), target.sessionId(), "") else if (eq(block_kind, "tool_result")) s.finishTool(agents.str(block, "tool_use_id"), target.sessionId());
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
    pub fn send(s: *Session, _: *conversations.Registry, v: std.json.Value) !void {
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
        // The pending request supplies its immutable conversation binding. A
        // response to A must never clear B's attention after a selection change.
        const response_id = providers.Backend.init(s.provider).responseId(v);
        if (response_id) |id| {
            var i: usize = 0;
            while (i < s.approvals.items.len) {
                const parsed = try std.json.parseFromSlice(std.json.Value, a, s.approvals.items[i].line, .{});
                defer parsed.deinit();
                if (providers.Backend.init(s.provider).requestId(parsed.value)) |pending_id| {
                    if (sameId(id, pending_id)) {
                        const actor = s.approvals.items[i].actor;
                        const target = if (actor) |owner| &owner.state else &s.attachment.provisional;
                        a.free(s.approvals.orderedRemove(i).line);
                        if (actor) |owner| owner.pending_native_requests -|= 1;
                        if (!s.hasApproval(actor)) {
                            target.attention = if (target.observation.unread()) .finished else .none;
                            target.state = .working;
                        } else {
                            target.state = .blocked;
                            target.attention = .needs_input;
                        }
                        s.syncTools(target);
                        continue;
                    }
                }
                i += 1;
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
    pub fn poll(s: *Session, registry: *conversations.Registry) !bool {
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
                ding = (try s.ingest(registry, s.input.items[consumed..end])) or ding;
                consumed = end + 1;
            }
            std.mem.copyForwards(u8, s.input.items[0 .. s.input.items.len - consumed], s.input.items[consumed..]);
            s.input.items.len -= consumed;
        }
        return ding;
    }

    /// Decode provider facts and apply them to their conversation, independent
    /// of which thread this transport most recently opened.
    pub fn ingest(s: *Session, registry: *conversations.Registry, line: []const u8) !bool {
        if (line.len > 4 * 1024 * 1024) return error.NativeMessageTooLarge;
        const parsed = std.json.parseFromSlice(std.json.Value, a, line, .{}) catch return false;
        defer parsed.deinit();
        const v = parsed.value;
        const event = providers.Backend.init(s.provider).nativeEvent(v);
        if (event.initialize) {
            if (event.initialization_failed) return error.NativeInitializeFailed;
            try s.queue(.{ .method = "initialized" });
            try s.output.appendSlice(a, s.deferred.items);
            s.deferred.clearRetainingCapacity();
            s.ready = true;
            s.attachment.provisional.state = .idle;
        }
        const actor = if (event.session.len > 0) try registry.get(s.provider, event.session) else s.attachment.actor;
        if (actor) |owner| {
            if (s.provider == .codex) {
                if (!owner.native_usage) {
                    // Once a native stream owns accounting, the file reader
                    // cannot charge the same requests a second time. Preserve
                    // observed totals, then baseline the first native sample.
                    owner.native_usage = true;
                    owner.native_meter.meter.value = owner.live_usage;
                    owner.native_meter.meter.value.recent_tokens = 0;
                    // Reload restores active turns but intentionally starts new
                    // meters. Their first report may replay the previous request.
                    owner.native_meter.baseline_next = owner.live_usage.known or s.active_threads.contains(owner.state.sessionId());
                    if (owner.native_meter.baseline_next) owner.native_meter.meter.value.partial = true;
                }
                const field = @import("usage.zig").field;
                const thread = if (field(field(v, "params"), "thread") != .null) field(field(v, "params"), "thread") else field(field(v, "result"), "thread");
                const parent_id = agents.str(thread, "parentThreadId");
                if (registry.find(.codex, parent_id)) |parent| _ = registry.linkChild(parent, owner);
                const role = agents.str(thread, "agentRole");
                if (role.len > 0) owner.role_len = agents.clean(&owner.role, role);
            }
            try s.remember(owner);
            owner.observed_at = std.time.microTimestamp();
            if (owner.workspace == 0) owner.workspace = s.workspace_id;
            if (s.attachment.actor == null) {
                if (owner.state.state == .unknown) {
                    const session = owner.state.session;
                    const session_len = owner.state.session_len;
                    owner.state = s.attachment.provisional;
                    owner.state.provider = s.provider;
                    owner.state.session = session;
                    owner.state.session_len = session_len;
                }
                s.attachment.provisional = .{ .provider = s.provider, .state = if (s.ready) .idle else .initializing };
                for (s.approvals.items) |*pending| if (pending.actor == null) {
                    pending.actor = owner;
                    owner.pending_native_requests += 1;
                };
                for (s.active_tools.items) |*tool| if (tool.thread.len == 0) {
                    a.free(tool.thread);
                    tool.thread = try a.dupe(u8, owner.state.sessionId());
                };
            }
            const method = agents.str(v, "method");
            const explicit_selection = eq(method, "thread/started") or
                (s.provider == .codex and v == .object and v.object.contains("result") and event.session.len > 0);
            if (s.attachment.actor == null or (explicit_selection and owner.parent == null)) s.attachment.select(owner);
            if (s.attachment.actor == owner) s.resume_hint.observe(&owner.state);
        }
        const target = if (actor) |owner| &owner.state else &s.attachment.provisional;
        target.provider = s.provider;
        if (target.state == .unknown and s.ready) target.state = .idle;
        const old = target.state;
        var ding = false;
        const method = agents.str(v, "method");
        const kind = agents.str(v, "type");
        const params = if (v == .object) v.object.get("params") orelse .null else .null;
        const reported_turn = if (event.turn.len > 0) event.turn else agents.str(params, "turnId");
        const completed_turn = reported_turn.len > 0 and target.finishedTurn(reported_turn);
        const stale_turn = completed_turn or (event.phase != .working and reported_turn.len > 0 and target.turn_len > 0 and !eq(reported_turn, target.turnId()));
        if (!stale_turn or event.phase == .completed) try s.observeTools(target, v, params, method, kind);
        if (actor) |owner| if (s.provider == .codex and eq(method, "thread/tokenUsage/updated")) {
            owner.native_meter.native(@import("usage.zig").field(params, "tokenUsage"), s.active_threads.contains(event.session), std.time.milliTimestamp());
        };
        if (event.request_id != null) {
            // Replayed protocol requests refer to the same pending operation.
            const duplicate = for (s.approvals.items) |pending| {
                if (pending.actor != actor) continue;
                const decoded = try std.json.parseFromSlice(std.json.Value, a, pending.line, .{});
                defer decoded.deinit();
                if (providers.Backend.init(s.provider).requestId(decoded.value)) |id| {
                    if (sameId(event.request_id.?, id)) break true;
                }
            } else false;
            if (!duplicate) {
                if (s.approvals.items.len >= 64) return error.TooManyNativeRequests;
                try s.approvals.ensureUnusedCapacity(a, 1);
                s.approvals.appendAssumeCapacity(.{ .line = try a.dupe(u8, line), .actor = actor });
                if (actor) |owner| owner.pending_native_requests += 1;
            }
            target.beginTurn("");
            target.state = .blocked;
            target.attention = .needs_input;
        } else if (event.phase == .working) {
            if (!completed_turn) {
                if (event.thread.len > 0) {
                    if (s.active_threads.fetchRemove(event.thread)) |entry| {
                        a.free(entry.key);
                        a.free(entry.value);
                    }
                    try s.active_threads.put(a, try a.dupe(u8, event.thread), try a.dupe(u8, event.turn));
                }
                target.beginTurn(event.turn);
            }
        } else if (event.phase == .completed) {
            const active_turn = s.active_threads.get(event.thread);
            const matches = if (s.provider == .codex)
                !stale_turn and ((active_turn != null and (active_turn.?.len == 0 or eq(active_turn.?, event.turn))) or target.state == .working or target.state == .blocked)
            else
                !target.finished_since_activity and (old == .working or old == .blocked);
            if (active_turn != null and (event.turn.len == 0 or active_turn.?.len == 0 or eq(active_turn.?, event.turn))) {
                if (s.active_threads.fetchRemove(event.thread)) |entry| {
                    a.free(entry.key);
                    a.free(entry.value);
                }
            }
            if (matches) ding = target.endTurn(event.turn, event.outcome, .protocol, std.time.microTimestamp());
        }
        if (!stale_turn and s.hasApproval(actor)) {
            target.state = .blocked;
            target.attention = .needs_input;
        }
        if (!stale_turn and (event.phase != .none or event.request_id != null or eq(method, "item/started") or eq(method, "item/completed") or eq(kind, "user"))) s.syncTools(target);
        if (!stale_turn and (target.state != old or event.phase != .none or event.request_id != null)) {
            target.last_seq = std.time.microTimestamp();
            target.changed_at = target.last_seq;
            target.observation.source = .protocol;
        }
        if (target.state != old and target.attention == .needs_input) ding = true;
        while (s.events.items.len > 0 and (s.events.items.len >= 128 or s.journal_bytes + line.len > 4 * 1024 * 1024)) {
            const discarded = s.events.orderedRemove(0);
            s.journal_bytes -= discarded.line.len;
            a.free(discarded.line);
        }
        try s.events.append(a, .{ .seq = s.next_seq, .line = try a.dupe(u8, line) });
        s.journal_bytes += line.len;
        s.next_seq += 1;
        return ding;
    }
};
fn sameId(x: std.json.Value, y: std.json.Value) bool {
    return std.meta.activeTag(x) == std.meta.activeTag(y) and
        ((x == .string and eq(x.string, y.string)) or (x == .integer and x.integer == y.integer));
}

fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

fn testSession(provider: agents.Provider) !Session {
    return .{
        .id = 1,
        .provider = provider,
        .cwd = try a.dupe(u8, "/tmp"),
        .child = std.process.Child.init(&.{}, a),
        .ready = true,
        .attachment = .{ .provisional = .{ .provider = provider, .state = .idle } },
    };
}

test "native conversations retain independent turns and receipts across selection" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var transport = try testSession(.codex);
    defer {
        transport.exited = true;
        transport.destroy();
    }
    _ = try transport.ingest(&registry,
        \\{"method":"turn/started","params":{"threadId":"a","turn":{"id":"a1"}}}
    );
    _ = try transport.ingest(&registry,
        \\{"id":2,"result":{"thread":{"id":"b"}}}
    );
    _ = try transport.ingest(&registry,
        \\{"method":"turn/started","params":{"threadId":"b","turn":{"id":"b1"}}}
    );
    const first = registry.find(.codex, "a").?;
    const second = registry.find(.codex, "b").?;
    try std.testing.expectEqual(second, transport.attachment.actor.?);
    try std.testing.expect(try transport.ingest(&registry,
        \\{"method":"turn/completed","params":{"threadId":"a","turn":{"id":"a1","status":"completed"}}}
    ));
    try std.testing.expectEqual(second, transport.attachment.actor.?);
    try std.testing.expectEqual(agents.State.working, second.state.state);
    try std.testing.expectEqual(@as(u64, 1), first.state.observation.completed);
    try std.testing.expectEqual(@as(u64, 0), second.state.observation.completed);
    try std.testing.expectEqual(agents.State.working, transport.status());
    try std.testing.expect(!try transport.ingest(&registry,
        \\{"method":"turn/completed","params":{"threadId":"a","turn":{"id":"a1","status":"completed"}}}
    ));
    try std.testing.expectEqual(@as(u64, 1), transport.observation().completed);
    transport.acknowledge();
    try std.testing.expect(!first.state.observation.unread());
}

test "native children retain parent selection and own usage across duplicate sources" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var transport = try testSession(.codex);
    defer {
        transport.exited = true;
        transport.destroy();
    }
    _ = try transport.ingest(&registry,
        \\{"method":"thread/started","params":{"thread":{"id":"parent"}}}
    );
    _ = try transport.ingest(&registry,
        \\{"method":"thread/started","params":{"thread":{"id":"child","parentThreadId":"parent","agentRole":"Explorer"}}}
    );
    const parent = registry.find(.codex, "parent").?;
    const child = registry.find(.codex, "child").?;
    try std.testing.expectEqual(parent, transport.attachment.actor.?);
    try std.testing.expectEqual(parent.id, child.parent.?);
    try std.testing.expectEqualStrings("Explorer", child.role[0..child.role_len]);
    _ = try transport.ingest(&registry,
        \\{"method":"turn/started","params":{"threadId":"child","turn":{"id":"work"}}}
    );
    const usage_event =
        \\{"method":"thread/tokenUsage/updated","params":{"threadId":"child","tokenUsage":{"total":{"inputTokens":1200,"cachedInputTokens":850,"outputTokens":120},"last":{"inputTokens":100,"cachedInputTokens":50,"outputTokens":20}}}}
    ;
    _ = try transport.ingest(&registry, usage_event);
    _ = try transport.ingest(&registry, usage_event);
    try std.testing.expectEqual(@as(u64, 120), child.native_meter.meter.value.tokens.total());
    try std.testing.expectEqual(@as(u64, 50), child.native_meter.meter.value.tokens.cached_input);
    try std.testing.expectEqual(@as(u64, 0), parent.native_meter.meter.value.tokens.total());
    // A late inactive snapshot from another transport cannot lower the high-water
    // mark and make a repeated current notification count as another request.
    var second = try testSession(.codex);
    defer {
        second.exited = true;
        second.destroy();
    }
    _ = try second.ingest(&registry,
        \\{"method":"thread/tokenUsage/updated","params":{"threadId":"child","tokenUsage":{"total":{"inputTokens":10,"cachedInputTokens":0,"outputTokens":1}}}}
    );
    _ = try transport.ingest(&registry, usage_event);
    try std.testing.expectEqual(@as(u64, 120), child.native_meter.meter.value.tokens.total());
    const prior = try registry.get(.codex, "file-observed");
    prior.live_usage = .{ .known = true, .tokens = .{ .input = 100, .output = 20 } };
    _ = try transport.ingest(&registry,
        \\{"method":"turn/started","params":{"threadId":"file-observed","turn":{"id":"work"}}}
    );
    _ = try transport.ingest(&registry,
        \\{"method":"thread/tokenUsage/updated","params":{"threadId":"file-observed","tokenUsage":{"total":{"inputTokens":100,"outputTokens":20},"last":{"inputTokens":100,"outputTokens":20}}}}
    );
    try std.testing.expectEqual(@as(u64, 120), prior.native_meter.meter.value.tokens.total());
    try std.testing.expect(prior.native_meter.meter.value.partial);
    _ = try transport.ingest(&registry,
        \\{"method":"thread/tokenUsage/updated","params":{"threadId":"file-observed","tokenUsage":{"total":{"inputTokens":130,"outputTokens":25},"last":{"inputTokens":30,"outputTokens":5}}}}
    );
    try std.testing.expectEqual(@as(u64, 155), prior.native_meter.meter.value.tokens.total());
}

test "native approval replies target their original conversation and duplicates stay singular" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var transport = try testSession(.codex);
    defer {
        transport.exited = true;
        transport.destroy();
    }
    const request =
        \\{"id":9,"method":"item/commandExecution/requestApproval","params":{"threadId":"a"}}
    ;
    _ = try transport.ingest(&registry, request);
    _ = try transport.ingest(&registry, request);
    try std.testing.expectEqual(@as(usize, 1), transport.approvals.items.len);
    const lines = try transport.approvalLines(std.testing.allocator);
    defer std.testing.allocator.free(lines);
    try std.testing.expectEqualStrings(request, lines[0]);
    _ = try transport.ingest(&registry,
        \\{"id":2,"result":{"thread":{"id":"b"}}}
    );
    _ = try transport.ingest(&registry,
        \\{"id":10,"method":"item/tool/requestUserInput","params":{"threadId":"b"}}
    );
    const reply = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"id":9,"result":{"decision":"accept"}}
    , .{});
    defer reply.deinit();
    try std.testing.expectEqual(registry.find(.codex, "a").?, transport.approvals.items[0].actor.?);
    try transport.send(&registry, reply.value);
    try std.testing.expectEqual(agents.State.working, registry.find(.codex, "a").?.state.state);
    try std.testing.expectEqual(agents.State.blocked, registry.find(.codex, "b").?.state.state);
    try std.testing.expectEqual(agents.Attention.needs_input, transport.attention());
    try std.testing.expectEqual(@as(usize, 1), transport.approvals.items.len);
    try std.testing.expectEqualStrings("b", transport.agent().sessionId());
}

test "native duplicate sources share receipts and stale completions preserve the newer turn" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var first = try testSession(.codex);
    var second = try testSession(.codex);
    defer {
        first.exited = true;
        second.exited = true;
        first.destroy();
        second.destroy();
    }
    const started =
        \\{"method":"turn/started","params":{"threadId":"shared","turn":{"id":"old"}}}
    ;
    const completed =
        \\{"method":"turn/completed","params":{"threadId":"shared","turn":{"id":"old"}}}
    ;
    _ = try first.ingest(&registry, started);
    _ = try second.ingest(&registry, started);
    try std.testing.expect(try first.ingest(&registry, completed));
    try std.testing.expect(!try second.ingest(&registry, completed));
    try std.testing.expectEqual(@as(u64, 1), first.agent().observation.completed);
    _ = try first.ingest(&registry,
        \\{"method":"turn/started","params":{"threadId":"shared","turn":{"id":"new"}}}
    );
    _ = try first.ingest(&registry,
        \\{"method":"item/started","params":{"threadId":"shared","turnId":"new","item":{"id":"new-tool","type":"commandExecution"}}}
    );
    try std.testing.expectEqual(@as(usize, 1), first.active_tools.items.len);
    try std.testing.expect(first.agent().tool_active);
    // A genuinely new turn accepts tools; replaying the completed turn does not.
    _ = try first.ingest(&registry, started);
    _ = try first.ingest(&registry,
        \\{"method":"item/started","params":{"threadId":"shared","turnId":"old","item":{"id":"stale-tool","type":"commandExecution"}}}
    );
    try std.testing.expectEqual(@as(usize, 1), first.active_tools.items.len);
    try std.testing.expectEqualStrings("new-tool", first.active_tools.items[0].id);
    try std.testing.expect(!try first.ingest(&registry, completed));
    try std.testing.expect(first.agent().tool_active);
    try std.testing.expectEqualStrings("new", first.active_threads.get("shared").?);
    try std.testing.expectEqual(agents.State.working, first.agent().state);
    second.markExited();
    try std.testing.expectEqual(agents.State.working, first.agent().state);
}

test "requests on two transports retain actor attention until both are resolved or disconnected" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var first = try testSession(.codex);
    var second = try testSession(.codex);
    defer {
        first.exited = true;
        second.exited = true;
        first.destroy();
        second.destroy();
    }
    // Request IDs are local to a transport, even when they coincide.
    const request =
        \\{"id":9,"method":"item/commandExecution/requestApproval","params":{"threadId":"shared"}}
    ;
    _ = try first.ingest(&registry, request);
    _ = try second.ingest(&registry, request);
    const actor = registry.find(.codex, "shared").?;
    try std.testing.expectEqual(@as(u32, 2), actor.pending_native_requests);
    const reply = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"id":9,"result":{"decision":"accept"}}
    , .{});
    defer reply.deinit();
    try first.send(&registry, reply.value);
    try std.testing.expectEqual(@as(u32, 1), actor.pending_native_requests);
    try std.testing.expectEqual(agents.State.blocked, actor.state.state);
    try std.testing.expectEqual(agents.Attention.needs_input, actor.state.attention);
    _ = try first.ingest(&registry, request);
    first.markExited();
    try std.testing.expectEqual(@as(u32, 1), actor.pending_native_requests);
    try std.testing.expectEqual(agents.Attention.needs_input, actor.state.attention);
    first.markExited();
    try std.testing.expectEqual(@as(u32, 1), actor.pending_native_requests);
    second.markExited();
    try std.testing.expectEqual(@as(u32, 0), actor.pending_native_requests);
    try std.testing.expectEqual(agents.Attention.none, actor.state.attention);
}

test "native events snapshots and hooks share exactly one receipt regardless of arrival order" {
    const session = "01901234-1234-1234-1234-123456789abc";
    for ([_]agents.observation.Outcome{ .completed, .interrupted, .failed }) |outcome| {
        for ([_]bool{ false, true }) |native_first| {
            var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
            defer registry.deinit();
            var transport = try testSession(.codex);
            defer {
                transport.exited = true;
                transport.destroy();
            }
            _ = try transport.ingest(&registry,
                \\{"method":"turn/started","params":{"threadId":"01901234-1234-1234-1234-123456789abc","turn":{"id":"t"}}}
            );
            const actor = transport.attachment.actor.?;
            const completion = try std.json.Stringify.valueAlloc(std.testing.allocator, .{ .method = "turn/completed", .params = .{ .threadId = session, .turn = .{ .id = "t", .status = @tagName(outcome) } } }, .{});
            defer std.testing.allocator.free(completion);
            if (native_first) try std.testing.expectEqual(outcome == .completed, try transport.ingest(&registry, completion));
            var snapshot: @import("codex_observer.zig").Snapshot = .{ .request = .{ .prefix = .{} }, .session = session.*, .state = .idle, .turn_len = 1, .outcome = outcome, .observed_at = actor.state.last_seq + 1 };
            snapshot.turn[0] = 't';
            try std.testing.expectEqual(!native_first and outcome == .completed, actor.observeSnapshot(snapshot, false));
            try std.testing.expect(!try transport.ingest(&registry, completion));
            try std.testing.expect(!actor.observeHook(.{ .kind = .stop, .session = session, .turn = "t" }, actor.state.last_seq + 1, false, actor.observed_at + 1));
            try std.testing.expect(!actor.state.observation.pending_stop);
            try std.testing.expectEqual(@as(u64, 1), actor.state.observation.completed);
            try std.testing.expectEqual(outcome, actor.state.observation.outcome);
            try std.testing.expectEqual(agents.State.idle, actor.state.state);
            try std.testing.expectEqual(@as(u32, 0), transport.active_threads.count());
        }
    }
}

test "Claude results without turn IDs deduplicate until the next activity" {
    var registry: conversations.Registry = .{ .allocator = std.testing.allocator };
    defer registry.deinit();
    var transport = try testSession(.claude);
    defer {
        transport.exited = true;
        transport.destroy();
    }
    for (1..3) |completed| {
        _ = try transport.ingest(&registry,
            \\{"type":"assistant","session_id":"a","message":{"content":[]}}
        );
        try std.testing.expect(try transport.ingest(&registry,
            \\{"type":"result","session_id":"a","subtype":"success"}
        ));
        try std.testing.expect(!try transport.ingest(&registry,
            \\{"type":"result","session_id":"a","subtype":"success"}
        ));
        try std.testing.expectEqual(@as(u64, completed), transport.agent().observation.completed);
    }
}
