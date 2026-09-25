//! Turn-scoped Codex tool evidence, fed by the existing incremental transcript
//! reader. Historical records seed identities but never advance live progress.
const std = @import("std");
const agents = @import("agents.zig");
const summary = @import("activity_summary.zig");
const field = @import("usage.zig").field;
const eq = std.mem.eql;
pub const View = struct {
    commentary: summary.Text = .{},
    ended: bool = false,
    turn: [160]u8 = @splat(0),
    turn_len: usize = 0,
    completed: u64 = 0,
    evidence: summary.Text = .{},
};
const Call = struct {
    id: u64 = 0,
    bytes: [240]u8 = @splat(0),
    len: usize = 0,
    fn append(call: *Call, text: []const u8) void {
        var n = @min(text.len, call.bytes.len - call.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(text[0..n])) n -= 1;
        @memcpy(call.bytes[call.len..][0..n], text[0..n]);
        call.len += n;
    }
};
pub const Tracker = struct {
    commentary: summary.Text = .{},
    turn: [160]u8 = @splat(0),
    turn_len: usize = 0,
    ended: bool = false,
    completed: u64 = 0,
    pending: [64]Call = @splat(.{}),
    next_pending: usize = 0,
    seen: [256]u64 = @splat(0),
    next_seen: usize = 0,
    recent: [3]Call = @splat(.{}),
    dirty: bool = false,
    pub fn bind(t: *Tracker, turn: []const u8) void {
        if (turn.len == 0 or turn.len > t.turn.len or eq(u8, turn, t.turn[0..t.turn_len])) return;
        t.* = .{};
        @memcpy(t.turn[0..turn.len], turn);
        t.turn_len = turn.len;
        t.dirty = true;
    }
    pub fn view(t: *const Tracker) View {
        var out: View = .{ .turn = t.turn, .turn_len = t.turn_len, .completed = t.completed, .commentary = t.commentary, .ended = t.ended };
        if (t.completed > 0) out.evidence.append("Recent completed tools (oldest to newest):\n");
        for (t.recent) |call| if (call.id != 0) {
            out.evidence.append(call.bytes[0..call.len]);
            out.evidence.append("\n");
        };
        return out;
    }
    pub fn ingest(t: *Tracker, value: std.json.Value, live: bool) void {
        const kind = agents.str(value, "type");
        const payload = field(value, "payload");
        const subtype = agents.str(payload, "type");
        if (eq(u8, kind, "turn_context") or (eq(u8, kind, "event_msg") and eq(u8, subtype, "task_started"))) {
            t.bind(agents.str(payload, "turn_id"));
            return;
        }
        if (eq(u8, kind, "event_msg") and (eq(u8, subtype, "task_complete") or eq(u8, subtype, "turn_complete") or eq(u8, subtype, "turn_aborted"))) {
            const turn = agents.str(payload, "turn_id");
            if (turn.len == 0 or eq(u8, turn, t.turn[0..t.turn_len])) t.ended = true;
            return;
        }
        if (!eq(u8, kind, "response_item") or t.turn_len == 0 or t.ended) return;
        if (eq(u8, subtype, "message") and eq(u8, agents.str(payload, "role"), "assistant") and eq(u8, agents.str(payload, "phase"), "commentary")) {
            const content = field(payload, "content");
            if (content == .array) {
                t.commentary = .{};
                t.commentary.append("Latest agent update: ");
                for (content.array.items) |part| {
                    if (eq(u8, agents.str(part, "type"), "output_text")) t.commentary.append(agents.str(part, "text"));
                }
                t.dirty = true;
            }
            return;
        }
        const raw_id = agents.str(payload, "call_id");
        const id = if (raw_id.len > 0) raw_id else agents.str(payload, "id");
        if (id.len == 0) return;
        const key = std.hash.Wyhash.hash(0, id) | 1;
        for (t.seen) |seen| if (seen == key) return;
        if (eq(u8, subtype, "function_call_output") or eq(u8, subtype, "custom_tool_call_output")) {
            for (&t.pending) |*call| if (call.id == key) {
                t.finish(call.*, live);
                call.* = .{};
                return;
            };
        } else if (eq(u8, subtype, "function_call") or eq(u8, subtype, "custom_tool_call") or eq(u8, subtype, "local_shell_call") or eq(u8, subtype, "web_search_call")) {
            var call: Call = .{ .id = key };
            const name = agents.str(payload, "name");
            call.append(if (name.len > 0) name else subtype);
            call.append(": ");
            const args = agents.str(payload, "arguments");
            const input = if (args.len > 0) args else agents.str(payload, "input");
            if (input.len > 0) {
                if (std.json.parseFromSlice(std.json.Value, std.heap.c_allocator, input, .{})) |parsed| {
                    defer parsed.deinit();
                    const detail = for ([_][]const u8{ "description", "cmd", "command", "code", "query" }) |key_name| {
                        const text = agents.str(parsed.value, key_name);
                        if (text.len > 0) break text;
                    } else input;
                    call.append(detail);
                } else |_| call.append(input);
            } else if (eq(u8, subtype, "web_search_call")) call.append(agents.str(field(payload, "action"), "query"));
            if (eq(u8, subtype, "web_search_call") and eq(u8, agents.str(payload, "status"), "completed")) {
                t.finish(call, live);
                return;
            }
            const slot = for (&t.pending) |*pending| {
                if (pending.id == key) break pending;
            } else blk: {
                const pending = &t.pending[t.next_pending];
                t.next_pending = (t.next_pending + 1) % t.pending.len;
                break :blk pending;
            };
            slot.* = call;
        }
    }
    fn finish(t: *Tracker, call: Call, live: bool) void {
        t.seen[t.next_seen] = call.id;
        t.next_seen = (t.next_seen + 1) % t.seen.len;
        if (!live) return;
        t.completed +|= 1;
        t.recent[0] = t.recent[1];
        t.recent[1] = t.recent[2];
        t.recent[2] = call;
        t.dirty = true;
    }
};

test "completed tools are deduplicated, historical calls do not advance waves, and turns reset" {
    var t: Tracker = .{};
    t.bind("a");
    const alloc = std.testing.allocator;
    const call = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"exec_command","arguments":"{\"cmd\":\"rg focus src\"}"}}
    , .{});
    defer call.deinit();
    const output = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"large output ignored"}}
    , .{});
    defer output.deinit();
    t.ingest(call.value, false);
    t.ingest(output.value, false);
    try std.testing.expectEqual(@as(u64, 0), t.completed);
    t.ingest(output.value, true);
    try std.testing.expectEqual(@as(u64, 0), t.completed);
    t.bind("b");
    t.ingest(call.value, true);
    try std.testing.expectEqual(@as(u64, 0), t.completed);
    t.ingest(output.value, true);
    t.ingest(output.value, true);
    try std.testing.expectEqual(@as(u64, 1), t.completed);
    const view = t.view();
    try std.testing.expect(std.mem.indexOf(u8, view.evidence.text(), "rg focus src") != null);
    t.bind("c");
    try std.testing.expectEqual(@as(u64, 0), t.completed);
    t.ingest(output.value, true);
    try std.testing.expectEqual(@as(u64, 0), t.completed);
}
