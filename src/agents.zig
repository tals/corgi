const std = @import("std");
pub const observation = @import("observation.zig");
pub const State = enum { unknown, initializing, idle, working, blocked, done };
pub const Attention = enum { none, finished, needs_input };
pub const providers = @import("providers.zig");
pub const Provider = providers.Provider;
pub const Subagents = struct {
    running: u32 = 0,
    blocked: u32 = 0,
    waiting: bool = false,
};
pub const Agent = struct {
    subagents: Subagents = .{},
    name: [160]u8 = @splat(0),
    name_len: usize = 0,
    observation: observation.State = .{},
    transcript: [std.fs.max_path_bytes]u8 = .{0} ** std.fs.max_path_bytes,
    transcript_len: usize = 0,
    turn: [160]u8 = .{0} ** 160,
    turn_len: usize = 0,
    last_finished_turn: [160]u8 = .{0} ** 160,
    last_finished_turn_len: usize = 0,
    finished_since_activity: bool = false,
    recent: [160]u8 = .{0} ** 160,
    recent_len: usize = 0,
    provider: Provider = .other,
    state: State = .unknown,
    attention: Attention = .none,
    session: [160]u8 = .{0} ** 160,
    session_len: usize = 0,
    activity: [160]u8 = .{0} ** 160,
    activity_len: usize = 0,
    activity_generation: u64 = 0,
    tool: [160]u8 = .{0} ** 160,
    tool_len: usize = 0,
    tool_active: bool = false,
    compacting: bool = false,
    cwd: [std.fs.max_path_bytes]u8 = .{0} ** std.fs.max_path_bytes,
    cwd_len: usize = 0,
    last_seq: i64 = 0,
    changed_at: i64 = 0,
    updated_at: i64 = 0,
    pub fn setName(a: *Agent, value: []const u8) void {
        var n = @min(value.len, a.name.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(value[0..n])) n -= 1;
        @memcpy(a.name[0..n], value[0..n]);
        a.name_len = n;
    }
    pub fn displayName(a: *const Agent) []const u8 {
        return a.name[0..a.name_len];
    }
    pub fn sessionId(a: *const Agent) []const u8 {
        return a.session[0..a.session_len];
    }
    pub fn toolLabel(a: *const Agent) []const u8 {
        return a.tool[0..a.tool_len];
    }
    pub fn directory(a: *const Agent) []const u8 {
        return a.cwd[0..a.cwd_len];
    }
    pub fn reset(a: *Agent) void {
        const receipts = a.observation;
        const recent = a.recent;
        const recent_len = a.recent_len;
        a.* = .{};
        a.observation.completed = receipts.completed;
        a.observation.read = receipts.read;
        a.recent = recent;
        a.recent_len = recent_len;
        a.attention = if (a.observation.unread()) .finished else .none;
    }
    pub fn acknowledge(a: *Agent) void {
        a.attention = .none;
        a.readThrough(a.observation.completed);
    }
    pub fn readThrough(a: *Agent, through: u64) void {
        a.observation.acknowledge(through);
        if (a.attention == .needs_input) return;
        a.attention = if (a.observation.unread()) .finished else .none;
    }
    pub fn turnId(a: *const Agent) []const u8 {
        return a.turn[0..a.turn_len];
    }
    pub fn transcriptPath(a: *const Agent) []const u8 {
        return a.transcript[0..a.transcript_len];
    }
    pub fn recentLabel(a: *const Agent) []const u8 {
        return a.recent[0..a.recent_len];
    }
    pub fn finishedTurn(a: *const Agent, turn: []const u8) bool {
        return if (turn.len > 0) eq(turn, a.last_finished_turn[0..a.last_finished_turn_len]) else a.finished_since_activity;
    }
    pub fn beginTurn(a: *Agent, turn: []const u8) void {
        if (turn.len > 0) a.turn_len = clean(&a.turn, turn);
        a.finished_since_activity = false;
        a.observation.pending_stop = false;
        a.state = .working;
        a.attention = if (a.observation.unread()) .finished else .none;
    }
    /// Snapshots can record history without ending the currently active turn.
    /// A baseline remembers the turn but creates neither a receipt nor a chime.
    pub fn recordCompletion(a: *Agent, turn: []const u8, outcome: observation.Outcome, source: observation.Source, baseline: bool) bool {
        if (a.finishedTurn(turn)) return false;
        a.last_finished_turn_len = clean(&a.last_finished_turn, turn);
        if (baseline) return false;
        a.observation.finish(outcome, source);
        a.attention = .finished;
        return true;
    }
    pub fn endTurn(a: *Agent, turn: []const u8, outcome: observation.Outcome, source: observation.Source, now: i64) bool {
        if (turn.len > 0 and a.turn_len > 0 and !eq(turn, a.turnId())) return false;
        const recorded = a.recordCompletion(if (turn.len > 0) turn else a.turnId(), outcome, source, false);
        a.finished_since_activity = true;
        a.observation.pending_stop = false;
        a.state = .idle;
        a.compacting = false;
        a.activity_len = 0;
        a.tool_len = 0;
        a.tool_active = false;
        if (recorded) a.changed_at = now;
        return recorded and outcome == .completed;
    }
    pub fn confirmStop(a: *Agent, seq: i64, outcome: observation.Outcome, now: i64) bool {
        if (!a.observation.pending_stop or a.last_seq != seq) return false;
        return a.endTurn(a.turnId(), outcome, .transcript, now);
    }
    /// Null rejects the observation; an accepted observation returns whether to ring.
    pub fn observeHook(a: *Agent, provider: Provider, hook: providers.Hook, seq: i64, watched: bool, now: i64) ?bool {
        if (seq <= a.last_seq) return null;
        const event = hook.kind;
        const session = hook.session;
        const start = event == .session_start;
        const reported_turn = hook.turn;
        // A conversation actor never changes identity. The attachment router
        // finds or creates a different actor when the provider selects a session.
        if (a.session_len > 0 and session.len > 0 and !eq(a.sessionId(), session)) return null;
        if (a.provider != .other and a.provider != provider) return null;
        // A repeated end signal must not revive a completed turn or replace
        // a newer turn currently running in the same session.
        if (event == .stop or event == .interrupt) {
            if (a.finishedTurn(reported_turn)) return null;
            if (reported_turn.len > 0 and a.turn_len > 0 and !eq(reported_turn, a.turnId())) return null;
        }
        const path = hook.transcript;
        if (std.fs.path.isAbsolute(path) and path.len <= a.transcript.len) {
            @memcpy(a.transcript[0..path.len], path);
            a.transcript_len = path.len;
        }
        // Another attachment may announce the same conversation. Refresh its
        // transcript without resetting an active turn or pending confirmation.
        if (start and a.state != .unknown and a.state != .done) return false;
        const next: State = switch (event) {
            .session_start, .stop, .interrupt => .idle,
            .tool_start => if (hook.asking) .blocked else .working,
            .prompt, .tool_finish, .tool_failure, .compact_start, .compact_end => .working,
            .permission, .notification => .blocked,
            .session_end => .done,
        };
        if (start or next == .working or next == .blocked) a.finished_since_activity = false;
        const turn = hook.turn;
        if (turn.len > 0 and turn.len <= a.turn.len) a.turn_len = clean(&a.turn, turn);
        a.last_seq = seq;
        a.provider = provider;
        if (session.len > 0 and session.len <= a.session.len) {
            @memcpy(a.session[0..session.len], session);
            a.session_len = session.len;
        }
        const old = a.state;
        a.observation.source = .hook;
        a.observation.pending_stop = event == .stop;
        a.state = if (a.observation.pending_stop) .working else next;
        a.changed_at = now;
        a.compacting = event == .compact_start;
        const tool = hook.tool;
        const cwd = hook.cwd;
        if (start) a.cwd_len = 0;
        if (std.fs.path.isAbsolute(cwd) and cwd.len <= a.cwd.len) {
            @memcpy(a.cwd[0..cwd.len], cwd);
            a.cwd_len = cwd.len;
        }
        if (event == .tool_start or event == .permission) {
            a.tool_active = true;
            if (tool.len > 0) a.tool_len = clean(&a.tool, tool);
        } else if (hook.permission_notification) {
            a.tool_active = true;
        } else if (event == .tool_finish or event == .tool_failure) {
            if (tool.len == 0 or eq(tool, a.toolLabel())) {
                a.tool_len = 0;
                a.tool_active = false;
            }
        } else if (next != .blocked) {
            a.tool_len = 0;
            a.tool_active = false;
        }
        if (event == .tool_finish or event == .tool_failure) {
            var detail: [160]u8 = undefined;
            a.recent_len = clean(&a.recent, std.fmt.bufPrint(&detail, "{s}: {s}", .{ if (event == .tool_failure) "failed" else "used", tool }) catch tool);
        }
        // Hooks update lifecycle and tool indicators; only the summary worker
        // supplies activity text. Keep that summary through tool transitions.
        if (start or event == .prompt or event == .interrupt or event == .session_end)
            a.activity_len = 0;
        if (start or next == .working) a.attention = if (a.observation.unread()) .finished else .none;
        if (a.observation.pending_stop) return false;
        if (event == .interrupt and (old == .working or old == .blocked)) {
            return a.endTurn(a.turnId(), .interrupted, .hook, now);
        }
        if (old == next) return false;
        if (next == .blocked) {
            if (!watched) a.attention = .needs_input;
            return true;
        }
        return false;
    }
};
fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
pub fn str(v: std.json.Value, key: []const u8) []const u8 {
    if (v != .object) return "";
    const item = v.object.get(key) orelse return "";
    return if (item == .string) item.string else "";
}
pub fn clean(out: []u8, input: []const u8) usize {
    const n = @min(out.len, input.len);
    for (input[0..n], 0..) |ch, i| out[i] = if (ch >= 32 and ch < 127) ch else ' ';
    return n;
}
test "attention is edge triggered, sticky, ordered, and separate from activity" {
    var a: Agent = .{};
    const working: providers.Hook = .{ .kind = .prompt, .session = "a" };
    const blocked: providers.Hook = .{ .kind = .permission, .session = "a" };
    const stopped: providers.Hook = .{ .kind = .stop, .session = "a" };
    try std.testing.expect(!a.observeHook(.claude, working, 1, false, 1).?);
    try std.testing.expect(a.observeHook(.claude, blocked, 2, false, 2).?);
    try std.testing.expect(!a.observeHook(.claude, blocked, 3, false, 3).?);
    try std.testing.expectEqual(null, a.observeHook(.claude, working, 2, false, 4));
    try std.testing.expectEqual(Attention.needs_input, a.attention);
    a.acknowledge();
    try std.testing.expectEqual(State.blocked, a.state);
    _ = a.observeHook(.claude, working, 4, false, 5);
    try std.testing.expect(!a.observeHook(.claude, stopped, 5, false, 6).?);
    try std.testing.expectEqual(State.working, a.state);
    try std.testing.expect(a.confirmStop(5, .completed, 7));
    try std.testing.expectEqual(Attention.finished, a.attention);
    _ = a.observeHook(.claude, working, 6, false, 8);
    try std.testing.expect(!a.observeHook(.claude, stopped, 7, true, 9).?);
}
test "stale-session hooks cannot corrupt parent state" {
    var a: Agent = .{};
    a.session_len = clean(&a.session, "parent");
    try std.testing.expectEqual(null, a.observeHook(.codex, .{ .kind = .stop, .session = "child" }, 10, false, 10));
    try std.testing.expectEqual(State.unknown, a.state);
}

test "working hooks leave activity empty for the viewer animation" {
    var agent: Agent = .{};
    _ = agent.observeHook(.codex, .{ .kind = .prompt, .session = "parent" }, 1, false, 1);
    try std.testing.expectEqual(State.working, agent.state);
    try std.testing.expectEqual(@as(usize, 0), agent.activity_len);
    _ = agent.observeHook(.codex, .{ .kind = .tool_start, .session = "parent", .tool = "Bash" }, 2, false, 2);
    try std.testing.expect(agent.tool_active);
    try std.testing.expectEqual(@as(usize, 0), agent.activity_len);
    _ = agent.observeHook(.codex, .{ .kind = .tool_finish, .session = "parent", .tool = "Bash" }, 3, false, 3);
    try std.testing.expectEqual(State.working, agent.state);
    try std.testing.expectEqual(@as(usize, 0), agent.activity_len);
    agent.activity_len = clean(&agent.activity, "Tracing pane focus");
    _ = agent.observeHook(.codex, .{ .kind = .tool_start, .session = "parent", .tool = "Bash", .description = "Run command" }, 4, false, 4);
    try std.testing.expectEqualStrings("Tracing pane focus", agent.activity[0..agent.activity_len]);
    _ = agent.observeHook(.codex, .{ .kind = .tool_finish, .session = "parent", .tool = "Bash" }, 5, false, 5);
    try std.testing.expectEqualStrings("Tracing pane focus", agent.activity[0..agent.activity_len]);
    _ = agent.observeHook(.codex, .{ .kind = .prompt, .session = "parent" }, 6, false, 6);
    try std.testing.expectEqual(@as(usize, 0), agent.activity_len);
}

test "compaction remains set until a subsequent lifecycle hook" {
    var agent: Agent = .{};
    var seq: i64 = 1;
    for ([_]@FieldType(providers.Hook, "kind"){ .compact_end, .tool_start, .interrupt, .stop, .session_end }) |event| {
        _ = agent.observeHook(.codex, .{ .kind = .compact_start, .session = "parent" }, seq, false, seq);
        agent.subagents.waiting = true;
        agent.activity_len = clean(&agent.activity, "Old summary");
        try std.testing.expect(agent.compacting);
        _ = agent.observeHook(.codex, .{ .kind = event, .session = "parent" }, seq + 1, false, seq + 1);
        try std.testing.expect(!agent.compacting);
        seq += 2;
    }
}

test "conversation state rejects identity replacement and uses a controlled clock" {
    const working: providers.Hook = .{ .kind = .prompt, .session = "a", .turn = "turn-a" };
    const replacement: providers.Hook = .{ .kind = .session_start, .session = "b" };
    const stop: providers.Hook = .{ .kind = .stop, .session = "a", .turn = "turn-a" };
    var agent: Agent = .{};
    _ = agent.observeHook(.claude, working, 10, false, 500);
    try std.testing.expectEqual(@as(i64, 500), agent.changed_at);
    try std.testing.expectEqual(null, agent.observeHook(.claude, replacement, 11, false, 600));
    try std.testing.expectEqualStrings("a", agent.sessionId());
    try std.testing.expectEqual(State.working, agent.state);
    try std.testing.expectEqual(@as(i64, 10), agent.last_seq);
    try std.testing.expectEqual(null, agent.observeHook(.codex, stop, 12, false, 650));
    _ = agent.observeHook(.claude, stop, 13, false, 700);
    try std.testing.expect(agent.confirmStop(13, .completed, 800));
    try std.testing.expectEqual(@as(i64, 800), agent.changed_at);
    try std.testing.expectEqual(@as(u64, 1), agent.observation.completed);
    try std.testing.expect(!agent.confirmStop(13, .completed, 900));
    try std.testing.expectEqual(@as(u64, 1), agent.observation.completed);
}
