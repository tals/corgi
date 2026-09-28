//! Turn-scoped Codex tool evidence, fed by the existing incremental transcript
//! reader. Historical records seed identities but never advance live progress.
const std = @import("std");
const agents = @import("agents.zig");
const summary = @import("activity_summary.zig");
const field = @import("usage.zig").field;
const transcript = @import("transcript.zig");
const Claude = @import("providers/claude.zig").Claude;
const os = @import("os.zig");
const a = os.allocator;
const BoundedText = @import("bounded_text.zig").BoundedText;
pub const View = struct {
    commentary: summary.Text = .{},
    running: usize = 0,
    ended: bool = false,
    turn: BoundedText(160) = .{},
    completed: u64 = 0,
    evidence: summary.Text = .{},
};
/// Tool lines name the work; the summarizer never needs whole scripts. Details
/// keep their first line within this many bytes, and an ellipsis marks a cut.
const detail_limit = 120;
const ellipsis = "…";
const Call = struct {
    id: u64 = 0,
    live: bool = false,
    bytes: [240]u8 = @splat(0),
    len: usize = 0,
    fn text(call: *const Call) []const u8 {
        return call.bytes[0..call.len];
    }
    fn append(call: *Call, value: []const u8) void {
        var n = @min(value.len, call.bytes.len - call.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(value[0..n])) n -= 1;
        @memcpy(call.bytes[call.len..][0..n], value[0..n]);
        call.len += n;
    }
    /// The first line of `value`, such as a description or a shell command
    /// whose heredoc body is dropped.
    fn detail(call: *Call, value: []const u8) void {
        const start = call.len;
        const trimmed = std.mem.trim(u8, value, " \t\r\n");
        const line = trimmed[0 .. std.mem.indexOfAny(u8, trimmed, "\r\n") orelse trimmed.len];
        call.append(std.mem.trimEnd(u8, line, " \t"));
        call.bound(start, line.len < trimmed.len);
    }
    fn bound(call: *Call, start: usize, dropped: bool) void {
        if (call.len > start + detail_limit) {
            var n = start + detail_limit - ellipsis.len;
            while (n > start and !std.unicode.utf8ValidateSlice(call.bytes[start..n])) n -= 1;
            call.len = n;
        } else if (!dropped) return;
        call.append(ellipsis);
    }
    /// Codex code mode wraps tool calls in JavaScript, for example
    /// `text(await tools.exec_command({cmd:"rg x",max_output_tokens:4000}))`.
    /// Keep the commands and patched files; drop the wrapper.
    fn script(call: *Call, code: []const u8) bool {
        const start = call.len;
        var found = false;
        var rest = code;
        while (std.mem.indexOf(u8, rest, "tools.")) |at| {
            if (call.len >= start + detail_limit) break;
            rest = rest[at + "tools.".len ..];
            var n: usize = 0;
            while (n < rest.len and (std.ascii.isAlphanumeric(rest[n]) or rest[n] == '_')) n += 1;
            if (n == 0) continue;
            const name = rest[0..n];
            rest = rest[n..];
            const args = rest[0 .. std.mem.indexOf(u8, rest, "tools.") orelse rest.len];
            if (found) call.append("; ");
            found = true;
            if (std.mem.eql(u8, name, "exec_command")) {
                if (scriptString(args, "cmd")) |cmd| call.appendScriptLine(cmd) else call.append(name);
            } else if (std.mem.eql(u8, name, "apply_patch")) {
                call.append("apply_patch ");
                _ = call.patchFiles(args);
            } else call.append(name);
        }
        if (found) call.bound(start, std.mem.indexOf(u8, rest, "tools.") != null);
        return found;
    }
    /// The first line of a JavaScript string body, unescaped.
    fn appendScriptLine(call: *Call, raw: []const u8) void {
        var line: [detail_limit + 8]u8 = undefined;
        var n: usize = 0;
        var i: usize = 0;
        while (i < raw.len and n < line.len) : (i += 1) {
            var char = raw[i];
            if (char == '\n') break;
            if (char == '\\' and i + 1 < raw.len) {
                i += 1;
                char = switch (raw[i]) {
                    'n', 'r' => break,
                    't' => ' ',
                    else => raw[i],
                };
            }
            line[n] = char;
            n += 1;
        }
        call.append(std.mem.trim(u8, line[0..n], " "));
    }
    /// Files named by an apply_patch body, raw or escaped inside a script.
    fn patchFiles(call: *Call, patch: []const u8) bool {
        var found = false;
        var rest = patch;
        while (std.mem.indexOf(u8, rest, "*** ")) |at| {
            rest = rest[at + "*** ".len ..];
            const verb = for ([_][]const u8{ "Update File: ", "Add File: ", "Delete File: " }) |candidate| {
                if (std.mem.startsWith(u8, rest, candidate)) break candidate;
            } else continue;
            rest = rest[verb.len..];
            const end = std.mem.indexOfAny(u8, rest, "\\\n\"'`") orelse rest.len;
            if (found) call.append(", ");
            call.append(shortPath(rest[0..end]));
            found = true;
            rest = rest[end..];
        }
        return found;
    }
};
/// The body of the JavaScript string assigned to `key` in an object literal.
fn scriptString(args: []const u8, key: []const u8) ?[]const u8 {
    var from: usize = 0;
    while (std.mem.indexOfPos(u8, args, from, key)) |at| {
        from = at + key.len;
        var i = from;
        if (i < args.len and args[i] == '"') i += 1;
        while (i < args.len and args[i] == ' ') i += 1;
        if (i >= args.len or args[i] != ':') continue;
        i += 1;
        while (i < args.len and args[i] == ' ') i += 1;
        if (i >= args.len or std.mem.indexOfScalar(u8, "\"'`", args[i]) == null) continue;
        const quote = args[i];
        const body = args[i + 1 ..];
        var end: usize = 0;
        while (end < body.len and body[end] != quote) : (end += 1) {
            if (body[end] == '\\') end += 1;
        }
        return body[0..@min(end, body.len)];
    }
    return null;
}
/// The last two components of a path; the project prefix is noise.
fn shortPath(path: []const u8) []const u8 {
    const last = std.mem.lastIndexOfScalar(u8, path, '/') orelse return path;
    const parent = std.mem.lastIndexOfScalar(u8, path[0..last], '/') orelse return path;
    return path[parent + 1 ..];
}
pub const Tracker = struct {
    commentary: summary.Text = .{},
    turn: BoundedText(160) = .{},
    ended: bool = false,
    completed: u64 = 0,
    pending: [64]Call = @splat(.{}),
    next_pending: usize = 0,
    seen: [256]u64 = @splat(0),
    next_seen: usize = 0,
    recent: [3]Call = @splat(.{}),
    dirty: bool = false,
    pub fn bind(t: *Tracker, turn: []const u8) void {
        if (turn.len == 0 or std.mem.eql(u8, turn, t.turn.text())) return;
        t.* = .{ .turn = @TypeOf(t.turn).init(turn) catch return, .dirty = true };
    }
    pub fn view(t: *const Tracker) View {
        var out: View = .{ .turn = t.turn, .completed = t.completed, .commentary = t.commentary, .ended = t.ended };
        var active: usize = 0;
        if (!t.ended) for (t.pending) |call| {
            if (call.id == 0) continue;
            out.running += 1;
            // Polling reruns the latest completed call; showing it again adds nothing.
            if (!call.live or std.mem.eql(u8, call.text(), t.recent[2].text())) continue;
            if (active == 0) out.evidence.append("Currently running tools (not yet completed):\n");
            if (active < 4) {
                out.evidence.append(call.bytes[0..call.len]);
                out.evidence.append("\n");
            }
            active += 1;
        };
        if (active > 4) out.evidence.append("Additional tools are running.\n");
        if (t.completed > 0) out.evidence.append("Recent completed tools (oldest to newest):\n");
        for (t.recent) |call| if (call.id != 0) {
            out.evidence.append(call.bytes[0..call.len]);
            out.evidence.append("\n");
        };
        return out;
    }
    pub fn ingest(t: *Tracker, value: std.json.Value, live: bool) void {
        const kind = std.meta.stringToEnum(transcript.RolloutKind, agents.str(value, "type"));
        const payload = field(value, "payload");
        const subtype = std.meta.stringToEnum(transcript.EventKind, agents.str(payload, "type"));
        if (kind == .turn_context or (kind == .event_msg and subtype == .task_started)) {
            t.bind(agents.str(payload, "turn_id"));
            return;
        }
        if (kind == .event_msg and (subtype == .task_complete or subtype == .turn_complete or subtype == .turn_aborted)) {
            const turn = agents.str(payload, "turn_id");
            if (turn.len == 0 or std.mem.eql(u8, turn, t.turn.text())) t.ended = true;
            return;
        }
        if (kind != .response_item or t.turn.len == 0 or t.ended) return;
        if (subtype == .message and std.mem.eql(u8, agents.str(payload, "role"), "assistant") and std.mem.eql(u8, agents.str(payload, "phase"), "commentary")) {
            const content = field(payload, "content");
            if (content == .array) {
                t.commentary = .{};
                t.commentary.append("Latest agent update: ");
                for (content.array.items) |part| {
                    if (std.mem.eql(u8, agents.str(part, "type"), "output_text")) t.commentary.append(agents.str(part, "text"));
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
        if (subtype == .function_call_output or subtype == .custom_tool_call_output) {
            for (&t.pending) |*call| if (call.id == key) {
                t.finish(call.*, live);
                call.* = .{};
                return;
            };
        } else if (subtype == .function_call or subtype == .custom_tool_call or subtype == .local_shell_call or subtype == .web_search_call) {
            var call: Call = .{ .id = key };
            const name = agents.str(payload, "name");
            call.append(if (name.len > 0) name else @tagName(subtype.?));
            call.append(": ");
            const args = agents.str(payload, "arguments");
            const input = if (args.len > 0) args else agents.str(payload, "input");
            if (input.len > 0) {
                if (std.json.parseFromSlice(std.json.Value, a, input, .{})) |parsed| {
                    defer parsed.deinit();
                    const detail = for ([_][]const u8{ "description", "cmd", "command", "code", "query" }) |key_name| {
                        const text = agents.str(parsed.value, key_name);
                        if (text.len > 0) break text;
                    } else input;
                    call.detail(detail);
                } else |_| {
                    // Custom tools take raw text: patches and code-mode scripts.
                    const start = call.len;
                    const patch = std.mem.startsWith(u8, std.mem.trimStart(u8, input, " \t\r\n"), "*** Begin Patch");
                    if (patch and call.patchFiles(input)) {
                        call.bound(start, false);
                    } else if (!call.script(input)) call.detail(input);
                }
            } else if (subtype == .web_search_call) call.detail(agents.str(field(payload, "action"), "query"));
            if (subtype == .web_search_call and std.mem.eql(u8, agents.str(payload, "status"), "completed")) {
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
            call.live = live or (slot.id == key and slot.live);
            if (!std.meta.eql(slot.*, call) and call.live) t.dirty = true;
            slot.* = call;
        }
    }
    /// Claude records carry no turn id; the caller binds the hook turn. Text
    /// is commentary, and a tool completes when its tool_result arrives.
    pub fn ingestClaude(t: *Tracker, value: std.json.Value, live: bool) void {
        if (t.turn.len == 0 or t.ended) return;
        const side = field(value, "isSidechain");
        if (side == .bool and side.bool) return;
        const kind = std.meta.stringToEnum(transcript.ClaudeLine, agents.str(value, "type"));
        if (kind == .system and std.mem.eql(u8, agents.str(value, "subtype"), "turn_duration")) {
            if (live) t.ended = true;
            return;
        }
        const content = field(field(value, "message"), "content");
        if (content != .array) return;
        for (content.array.items) |block| {
            const block_type = std.meta.stringToEnum(Claude.BlockType, agents.str(block, "type"));
            if (kind == .assistant and block_type == .text) {
                const text = std.mem.trim(u8, agents.str(block, "text"), " \t\r\n");
                if (text.len == 0) continue;
                t.commentary = .{};
                t.commentary.append("Latest agent update: ");
                t.commentary.append(text);
                t.dirty = true;
            } else if (kind == .assistant and block_type == .tool_use) {
                const id = agents.str(block, "id");
                if (id.len == 0) continue;
                const key = std.hash.Wyhash.hash(0, id) | 1;
                if (std.mem.indexOfScalar(u64, &t.seen, key) != null) continue;
                var call: Call = .{ .id = key };
                call.append(agents.str(block, "name"));
                call.append(": ");
                const input = field(block, "input");
                for ([_][]const u8{ "description", "command", "file_path", "pattern", "query", "url", "prompt" }) |name| {
                    const detail = agents.str(input, name);
                    if (detail.len == 0) continue;
                    call.detail(if (std.mem.eql(u8, name, "file_path")) shortPath(detail) else detail);
                    break;
                }
                const slot = for (&t.pending) |*pending| {
                    if (pending.id == key) break pending;
                } else blk: {
                    const pending = &t.pending[t.next_pending];
                    t.next_pending = (t.next_pending + 1) % t.pending.len;
                    break :blk pending;
                };
                call.live = live or (slot.id == key and slot.live);
                if (!std.meta.eql(slot.*, call) and call.live) t.dirty = true;
                slot.* = call;
            } else if (kind == .user and block_type == .tool_result) {
                const id = agents.str(block, "tool_use_id");
                if (id.len == 0) continue;
                const key = std.hash.Wyhash.hash(0, id) | 1;
                for (&t.pending) |*call| if (call.id == key) {
                    t.finish(call.*, live);
                    call.* = .{};
                    break;
                };
            }
        }
    }
    fn finish(t: *Tracker, call: Call, live: bool) void {
        t.seen[t.next_seen] = call.id;
        t.next_seen = (t.next_seen + 1) % t.seen.len;
        if (!live) return;
        t.completed +|= 1;
        t.dirty = true;
        // A repeated call (polling) keeps one entry, so the evidence holds still.
        if (!std.mem.eql(u8, t.recent[2].text(), call.text())) {
            t.recent[0] = t.recent[1];
            t.recent[1] = t.recent[2];
        }
        t.recent[2] = call;
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

test "Claude text and completed tools become evidence for the bound turn" {
    var t: Tracker = .{};
    const alloc = std.testing.allocator;
    const assistant = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"text","text":"Tracing the hook router"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"rg routeHook","description":"Find hook routing"}}]}}
    , .{});
    defer assistant.deinit();
    const result = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t1","content":"large output ignored"}]}}
    , .{});
    defer result.deinit();
    const side = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"assistant","isSidechain":true,"message":{"content":[{"type":"text","text":"Subagent chatter"}]}}
    , .{});
    defer side.deinit();
    const done = try std.json.parseFromSlice(std.json.Value, alloc,
        \\{"type":"system","subtype":"turn_duration"}
    , .{});
    defer done.deinit();
    // Unbound trackers ignore evidence; hooks supply Claude's turn.
    t.ingestClaude(assistant.value, true);
    try std.testing.expectEqual(@as(usize, 0), t.commentary.len);
    t.bind("prompt-1");
    t.ingestClaude(assistant.value, true);
    t.ingestClaude(side.value, true);
    try std.testing.expectEqualStrings("Latest agent update: Tracing the hook router", t.commentary.text());
    t.ingestClaude(result.value, true);
    t.ingestClaude(result.value, true);
    try std.testing.expectEqual(@as(u64, 1), t.completed);
    try std.testing.expect(std.mem.indexOf(u8, t.view().evidence.text(), "Bash: Find hook routing") != null);
    t.ingestClaude(done.value, true);
    try std.testing.expect(t.view().ended);
    t.bind("prompt-2");
    try std.testing.expect(!t.view().ended);
    try std.testing.expectEqual(@as(u64, 0), t.completed);
}

test "running tools publish stable evidence before completion for both providers" {
    const cases = .{
        .{
            \\{"type":"response_item","payload":{"type":"function_call","call_id":"c1","name":"exec_command","arguments":"{\"cmd\":\"bun test tests/smoke.test.ts\"}"}}
            ,
            \\{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"done"}}
        },
        .{
            \\{"type":"assistant","message":{"content":[{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"bun test tests/smoke.test.ts"}}]}}
            ,
            \\{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"c1","content":"done"}]}}
        },
    };
    inline for (cases, 0..) |example, provider| {
        const start = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, example[0], .{});
        defer start.deinit();
        const done = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, example[1], .{});
        defer done.deinit();
        var t: Tracker = .{};
        t.bind("turn");
        t.dirty = false;
        if (provider == 0) t.ingest(start.value, false) else t.ingestClaude(start.value, false);
        try std.testing.expect(!t.dirty);
        try std.testing.expectEqual(@as(usize, 0), t.view().evidence.len);
        if (provider == 0) t.ingest(start.value, true) else t.ingestClaude(start.value, true);
        try std.testing.expect(t.dirty);
        const running = t.view();
        try std.testing.expectEqual(@as(u64, 0), running.completed);
        try std.testing.expect(std.mem.indexOf(u8, running.evidence.text(), "Currently running tools") != null);
        try std.testing.expect(std.mem.indexOf(u8, running.evidence.text(), "bun test tests/smoke.test.ts") != null);
        t.dirty = false;
        if (provider == 0) t.ingest(start.value, true) else t.ingestClaude(start.value, true);
        try std.testing.expect(!t.dirty);
        try std.testing.expectEqual(running.evidence.hash(), t.view().evidence.hash());
        if (provider == 0) t.ingest(done.value, true) else t.ingestClaude(done.value, true);
        try std.testing.expect(t.dirty);
        const finished = t.view();
        try std.testing.expect(std.mem.indexOf(u8, finished.evidence.text(), "Currently running tools") == null);
        try std.testing.expect(std.mem.indexOf(u8, finished.evidence.text(), "Recent completed tools") != null);
    }
}

fn testCall(name: []const u8) Call {
    var call: Call = .{ .id = 1 };
    call.append(name);
    call.append(": ");
    return call;
}

test "tool lines keep the command and drop wrappers, scripts and patch bodies" {
    var call = testCall("exec");
    try std.testing.expect(call.script(
        \\text((await tools.exec_command({cmd:"sed -n '1,220p' tests/support.ts",workdir:"/Users/tal/dev/personal/corgi",max_output_tokens:8000})).output)
    ));
    try std.testing.expectEqualStrings("exec: sed -n '1,220p' tests/support.ts", call.text());

    call = testCall("exec");
    try std.testing.expect(call.script(
        \\const r = await Promise.allSettled([
        \\  tools.exec_command({cmd:"rg -n \"focus|blur\" src",max_output_tokens:4000}),
        \\  tools.apply_patch("*** Begin Patch\n*** Update File: /Users/tal/dev/personal/corgi/src/resources.zig\n@@\n-  old\n+  new\n*** End Patch"),
        \\  tools.write_stdin({session_id:17169,chars:""})
        \\]);
    ));
    try std.testing.expectEqualStrings("exec: rg -n \"focus|blur\" src; apply_patch src/resources.zig; write_stdin", call.text());

    call = testCall("exec_command");
    call.detail("python3 - <<'EOF'\nprint('long script')\nEOF");
    try std.testing.expectEqualStrings("exec_command: python3 - <<'EOF'…", call.text());

    call = testCall("apply_patch");
    const start = call.len;
    try std.testing.expect(call.patchFiles("*** Begin Patch\n*** Add File: /repo/docs/notes.md\n+hi\n*** Delete File: /repo/src/old.zig\n*** End Patch"));
    call.bound(start, false);
    try std.testing.expectEqualStrings("apply_patch: docs/notes.md, src/old.zig", call.text());

    call = testCall("Bash");
    call.detail("rg " ++ "x" ** 200);
    try std.testing.expect(std.mem.endsWith(u8, call.text(), ellipsis));
    try std.testing.expectEqual(@as(usize, "Bash: ".len + detail_limit), call.len);
}

test "polling the same call leaves the evidence unchanged" {
    const alloc = std.testing.allocator;
    var t: Tracker = .{};
    t.bind("turn");
    var before: u64 = 0;
    for (0..3) |i| {
        var id: [8]u8 = undefined;
        const call_id = try std.fmt.bufPrint(&id, "poll-{d}", .{i});
        const start = try std.fmt.allocPrint(alloc,
            \\{{"type":"response_item","payload":{{"type":"function_call","call_id":"{s}","name":"exec_command","arguments":"{{\"cmd\":\"lavish-axi poll\"}}"}}}}
        , .{call_id});
        defer alloc.free(start);
        const done = try std.fmt.allocPrint(alloc,
            \\{{"type":"response_item","payload":{{"type":"function_call_output","call_id":"{s}","output":"no feedback"}}}}
        , .{call_id});
        defer alloc.free(done);
        const start_value = try std.json.parseFromSlice(std.json.Value, alloc, start, .{});
        defer start_value.deinit();
        const done_value = try std.json.parseFromSlice(std.json.Value, alloc, done, .{});
        defer done_value.deinit();
        t.ingest(start_value.value, true);
        if (i > 0) try std.testing.expectEqual(before, t.view().evidence.hash());
        t.ingest(done_value.value, true);
        before = t.view().evidence.hash();
    }
    try std.testing.expectEqual(@as(u64, 3), t.completed);
    const evidence = t.view().evidence.text();
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, evidence, "lavish-axi poll"));
}
