const std = @import("std");
pub const observation = @import("observation.zig");
pub const State = enum { unknown, initializing, idle, working, blocked, done };
pub const Attention = enum { none, finished, needs_input };
pub const Provider = enum { claude, codex, other };
pub const Agent = struct {
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
    cwd: [std.fs.max_path_bytes]u8 = .{0} ** std.fs.max_path_bytes,
    cwd_len: usize = 0,
    last_seq: i64 = 0,
    changed_at: i64 = 0,
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
    pub fn label(a: *const Agent) []const u8 {
        if (a.provider == .codex) switch (a.state) {
            .blocked => return "Needs input",
            .idle => return "◡‿◡",
            .done => return "Session ended",
            .initializing => return "Starting session",
            else => {},
        };
        return a.activity[0..a.activity_len];
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
    pub fn confirm(a: *Agent, seq: i64, outcome: observation.Outcome) bool {
        if (!a.observation.pending_stop or a.last_seq != seq) return false;
        a.observation.pending_stop = false;
        if (a.turn_len > 0 and eq(a.turnId(), a.last_finished_turn[0..a.last_finished_turn_len])) {
            a.state = .idle;
            a.activity_len = 0;
            a.tool_active = false;
            return false;
        }
        a.last_finished_turn_len = clean(&a.last_finished_turn, a.turnId());
        a.finished_since_activity = true;
        a.observation.finish(outcome, .transcript);
        a.state = .idle;
        a.tool_active = false;
        a.tool_len = 0;
        a.activity_len = 0;
        a.changed_at = std.time.microTimestamp();
        a.attention = .finished;
        return outcome == .completed;
    }
    pub fn apply(a: *Agent, provider: Provider, value: std.json.Value, seq: i64, watched: bool) bool {
        if (value != .object or seq <= a.last_seq) return false;
        // A child agent must not overwrite its parent's lifecycle or identity.
        if (str(value, "agent_id").len != 0) return false;
        const event = str(value, "hook_event_name");
        if (std.mem.startsWith(u8, event, "Subagent")) return false;
        const session = str(value, "session_id");
        const start = std.mem.eql(u8, event, "SessionStart");
        const reported_turn = str(value, "turn_id");
        // A repeated end signal must not revive a completed turn or replace
        // a newer turn currently running in the same session.
        if ((eq(event, "Stop") or eq(event, "Interrupt")) and reported_turn.len > 0 and
            eq(session, a.sessionId()) and eq(reported_turn, a.last_finished_turn[0..a.last_finished_turn_len])) return false;
        if ((eq(event, "Stop") or eq(event, "Interrupt")) and reported_turn.len == 0 and
            eq(session, a.sessionId()) and a.finished_since_activity) return false;
        if (!start and a.session_len > 0 and session.len > 0 and !std.mem.eql(u8, a.sessionId(), session)) return false;
        const asking = eq(event, "PreToolUse") and (eq(str(value, "tool_name"), "AskUserQuestion") or eq(str(value, "tool_name"), "request_user_input"));
        const next: State = if (start) .idle else if (asking) .blocked else if (eq(event, "UserPromptSubmit") or eq(event, "PreToolUse") or eq(event, "PostToolUse") or eq(event, "PostToolUseFailure") or eq(event, "PreCompact") or eq(event, "PostCompact")) .working else if (eq(event, "PermissionRequest")) .blocked else if (eq(event, "Notification")) blk: {
            const kind = str(value, "notification_type");
            if (eq(kind, "permission_prompt") or eq(kind, "idle_prompt") or eq(kind, "elicitation_dialog")) break :blk .blocked;
            return false;
        } else if (eq(event, "Stop") or eq(event, "Interrupt")) .idle else if (eq(event, "SessionEnd")) .done else return false;
        if (start and session.len > 0 and !eq(a.sessionId(), session)) {
            const receipts = a.observation;
            a.* = .{};
            // Receipt numbers remain monotonic across processes in the same pane.
            a.observation.completed = receipts.completed;
            a.observation.read = receipts.read;
        }
        if (start or next == .working or next == .blocked) a.finished_since_activity = false;
        const path = str(value, "transcript_path");
        if (std.fs.path.isAbsolute(path) and path.len <= a.transcript.len) {
            @memcpy(a.transcript[0..path.len], path);
            a.transcript_len = path.len;
        }
        const turn = str(value, "turn_id");
        if (turn.len > 0 and turn.len <= a.turn.len) a.turn_len = clean(&a.turn, turn);
        a.last_seq = seq;
        a.provider = provider;
        if (session.len > 0) a.session_len = clean(&a.session, session);
        const old = a.state;
        a.observation.source = .hook;
        a.observation.pending_stop = eq(event, "Stop");
        a.state = if (a.observation.pending_stop) .working else next;
        a.changed_at = seq;
        const tool = str(value, "tool_name");
        const cwd = str(value, "cwd");
        if (start) a.cwd_len = 0;
        if (std.fs.path.isAbsolute(cwd) and cwd.len <= a.cwd.len) {
            @memcpy(a.cwd[0..cwd.len], cwd);
            a.cwd_len = cwd.len;
        }
        if (eq(event, "PreToolUse") or eq(event, "PermissionRequest")) {
            a.tool_active = true;
            if (tool.len > 0) a.tool_len = clean(&a.tool, tool);
        } else if (eq(event, "Notification") and eq(str(value, "notification_type"), "permission_prompt")) {
            a.tool_active = true;
        } else if (eq(event, "PostToolUse") or eq(event, "PostToolUseFailure")) {
            if (tool.len == 0 or eq(tool, a.toolLabel())) {
                a.tool_len = 0;
                a.tool_active = false;
            }
        } else if (next != .blocked) {
            a.tool_len = 0;
            a.tool_active = false;
        }
        if (eq(event, "PostToolUse") or eq(event, "PostToolUseFailure")) {
            var detail: [160]u8 = undefined;
            a.recent_len = clean(&a.recent, std.fmt.bufPrint(&detail, "{s}: {s}", .{ if (eq(event, "PostToolUseFailure")) "failed" else "used", tool }) catch tool);
        }
        const activity = if (a.observation.pending_stop) "checking completion" else if (tool.len > 0 and a.tool_active) tool else if (next == .working) "thinking" else "";
        const description = str(value.object.get("tool_input") orelse .null, "description");
        if (a.tool_active and description.len > 0) {
            var detail: [160]u8 = undefined;
            a.activity_len = clean(&a.activity, std.fmt.bufPrint(&detail, "{s}: {s}", .{ tool, description[0..@min(description.len, 100)] }) catch activity);
        } else a.activity_len = clean(&a.activity, activity);
        if (start or next == .working) a.attention = if (a.observation.unread()) .finished else .none;
        if (a.observation.pending_stop) return false;
        if (eq(event, "Interrupt") and (old == .working or old == .blocked)) {
            a.finished_since_activity = true;
            a.observation.finish(.interrupted, .hook);
            a.last_finished_turn_len = clean(&a.last_finished_turn, a.turnId());
            a.attention = .finished;
            return false; // Interrupted turns have receipts, never a success chime.
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
    const alloc = std.testing.allocator;
    const working = try std.json.parseFromSlice(std.json.Value, alloc, "{\"hook_event_name\":\"UserPromptSubmit\",\"session_id\":\"a\"}", .{});
    defer working.deinit();
    const blocked = try std.json.parseFromSlice(std.json.Value, alloc, "{\"hook_event_name\":\"PermissionRequest\",\"session_id\":\"a\"}", .{});
    defer blocked.deinit();
    const stopped = try std.json.parseFromSlice(std.json.Value, alloc, "{\"hook_event_name\":\"Stop\",\"session_id\":\"a\"}", .{});
    defer stopped.deinit();
    try std.testing.expect(!a.apply(.claude, working.value, 1, false));
    try std.testing.expect(a.apply(.claude, blocked.value, 2, false));
    try std.testing.expect(!a.apply(.claude, blocked.value, 3, false));
    try std.testing.expect(!a.apply(.claude, working.value, 2, false));
    try std.testing.expectEqual(Attention.needs_input, a.attention);
    a.acknowledge();
    try std.testing.expectEqual(State.blocked, a.state);
    _ = a.apply(.claude, working.value, 4, false);
    try std.testing.expect(!a.apply(.claude, stopped.value, 5, false));
    try std.testing.expectEqual(State.working, a.state);
    try std.testing.expect(a.confirm(5, .completed));
    try std.testing.expectEqual(Attention.finished, a.attention);
    _ = a.apply(.claude, working.value, 6, false);
    try std.testing.expect(!a.apply(.claude, stopped.value, 7, true));
}
test "subagent and stale-session hooks cannot corrupt parent state" {
    var a: Agent = .{};
    a.session_len = clean(&a.session, "parent");
    const v = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"hook_event_name\":\"Stop\",\"session_id\":\"child\"}", .{});
    defer v.deinit();
    try std.testing.expect(!a.apply(.codex, v.value, 10, false));
    try std.testing.expectEqual(State.unknown, a.state);
}
