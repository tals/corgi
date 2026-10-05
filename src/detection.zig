//! Passive foreground-job discovery. No shell aliases or PATH shims required.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const c = os.c;
const agents = @import("agents.zig");
const Provider = agents.Provider;
const State = agents.State;
pub const Job = struct { pid: c_int, provider: Provider };

fn name(path: []const u8) ?Provider {
    if (Provider.named(std.fs.path.basename(path))) |provider| return provider;
    for (Provider.all) |provider| {
        for (provider.info().install_markers) |marker| if (std.mem.indexOf(u8, path, marker) != null) return provider;
    }
    return null;
}

// Only executable/script positions count. `sh -c 'codex ...'`, `node -e
// 'codex'`, and an editor opening a file named codex are not agents.
pub fn identify(argv: []const []const u8) ?Provider {
    if (argv.len == 0) return null;
    if (name(argv[0])) |direct| return direct;
    const exe = std.fs.path.basename(argv[0]);
    const interpreter = std.mem.eql(u8, exe, "node") or std.mem.eql(u8, exe, "bun") or
        std.mem.eql(u8, exe, "sh") or std.mem.eql(u8, exe, "bash") or
        std.mem.eql(u8, exe, "zsh") or std.ascii.startsWithIgnoreCase(exe, "python");
    if (!interpreter or argv.len < 2) return null;
    var i: usize = 1;
    if (std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    while (i < argv.len and argv[i].len > 0 and argv[i][0] == '-') : (i += 1) {
        if (std.mem.eql(u8, argv[i], "--")) {
            i += 1;
            break;
        }
        // Be conservative with interpreter flags that consume another argument.
        const bun_flag = std.mem.eql(u8, exe, "bun") and (std.mem.eql(u8, argv[i], "--bun") or std.mem.eql(u8, argv[i], "-b"));
        if (!bun_flag and !std.mem.eql(u8, argv[i], "-u") and !std.mem.eql(u8, argv[i], "--no-warnings")) return null;
    }
    if (i < argv.len and std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    if (i >= argv.len) return null;
    const script = argv[i];
    if (name(script)) |script_name| return script_name;
    for (Provider.all) |provider| {
        for (provider.info().scripts) |suffix| if (std.mem.endsWith(u8, script, suffix)) return provider;
    }
    return null;
}

fn process(pid: c_int) ?Provider {
    var bytes: [65536]u8 = undefined;
    const p = os.processArgs(pid, &bytes, .{}) orelse return null;
    return identify(p.args());
}

/// Holds a Claude process's arguments and environment. Daemon-hosted
/// sessions carry large environments; 64 KiB is not enough.
pub const process_buffer = 1024 * 1024;

/// The Claude process a hook runs under, 0 when none was found, and
/// whether its session runs in the background.
pub const HookOrigin = struct { pid: c_int = 0, background: bool = false };

/// Claude runs hooks without its internal session variables, and its
/// background daemon hands CORGI_PANE from one pane to every session it
/// hosts. So does a `claude -p` that an agent's tool starts, but tools run
/// detached from the terminal. Only the pane's foreground Claude owns
/// CORGI_PANE, so find the hook's nearest Claude process and check it.
pub fn hookOrigin() HookOrigin {
    const a = os.allocator;
    const bytes = a.alloc(u8, process_buffer) catch return .{};
    defer a.free(bytes);
    var pid: c_int = c.getppid();
    for (0..8) |_| {
        if (pid <= 1) return .{};
        if (os.processArgs(pid, bytes, .{ .env = true })) |p| if (claudeProcess(&p)) {
            for (p.environ()) |entry| if (std.mem.eql(u8, entry, "CLAUDE_CODE_SESSION_KIND=bg")) return .{ .pid = pid, .background = true };
            return .{ .pid = pid, .background = backgroundJob(pid) };
        };
        pid = (os.processJob(pid) orelse return .{}).ppid;
    }
    return .{};
}

/// Whether `pid` still runs Claude. `buf` holds `process_buffer` bytes.
pub fn claudeRunning(pid: c_int, buf: []u8) bool {
    if (pid <= 1) return false;
    const p = os.processArgs(pid, buf, .{}) orelse return false;
    return claudeProcess(&p);
}

/// Claude retitles its processes ("claude bg-spare" as one argv[0]),
/// so also trust the executable path and argv[0]'s first word.
fn claudeProcess(p: *const os.ProcessArgs) bool {
    if (name(p.exe) == .claude) return true;
    const argv = p.args();
    if (argv.len == 0) return false;
    if (identify(argv) == .claude) return true;
    const first = argv[0][0 .. std.mem.indexOfScalar(u8, argv[0], ' ') orelse argv[0].len];
    return name(first) == .claude;
}

/// Whether the process is known to run outside its terminal's foreground
/// job, including without a controlling terminal at all.
fn backgroundJob(pid: c_int) bool {
    const info = os.processJob(pid) orelse return false;
    return info.tpgid <= 0 or info.pgid != info.tpgid;
}

pub fn foreground(fd: c_int) ?Job {
    const pgid = c.tcgetpgrp(fd);
    if (pgid <= 0) return null;
    if (process(pgid)) |leader| return .{ .pid = pgid, .provider = leader };
    if (builtin.os.tag == .macos) {
        var pids: [128]c_int = undefined;
        const n = c.proc_listpids(c.PROC_PGRP_ONLY, @intCast(pgid), &pids, @sizeOf(@TypeOf(pids)));
        if (n <= 0) return null;
        for (pids[0..@min(pids.len, @as(usize, @intCast(n)) / @sizeOf(c_int))]) |pid| {
            if (pid <= 0 or pid == pgid) continue;
            if (process(pid)) |provider| return .{ .pid = pid, .provider = provider };
        }
    } else if (builtin.os.tag == .linux) {
        var dir = std.Io.Dir.openDirAbsolute(os.io(), "/proc", .{ .iterate = true }) catch return null;
        defer dir.close(os.io());
        var it = dir.iterate();
        while (it.next(os.io()) catch null) |entry| {
            const pid = std.fmt.parseInt(c_int, entry.name, 10) catch continue;
            if (pid == pgid or c.getpgid(pid) != pgid) continue;
            if (process(pid)) |provider| return .{ .pid = pid, .provider = provider };
        }
    }
    return null;
}

// Hook events are authoritative once received. The fallback only uses strong
// UI signals, never inactivity or arbitrary mentions in an agent's response.
pub fn screenState(provider: Provider, title: []const u8, screen: []const u8) ?State {
    const signals = provider.info().screen;
    if (signals.blocked_title) |blocked| if (std.mem.indexOf(u8, title, blocked) != null) return .blocked;
    var lower: [8192]u8 = undefined;
    const text = lowerTail(&lower, screen);
    if ((has(text, "enter to confirm") and has(text, "esc to cancel")) or has(text, "enter to submit answer") or has(text, "enter to submit all")) return .blocked;
    // Title spinners also run during startup, MCP connection and other UI
    // loading. They do not establish an active turn.
    if (has(text, "esc to interrupt")) return .working;
    if (signals.idle_title) |idle| if (std.mem.startsWith(u8, title, idle)) return .idle;
    if (signals.idle_prompt) |prompt| {
        var rows = std.mem.splitScalar(u8, text, '\n');
        while (rows.next()) |row| {
            if (std.mem.startsWith(u8, std.mem.trimStart(u8, row, " "), prompt)) return .idle;
        }
    }
    return null;
}
fn has(text: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, text, needle) != null;
}
/// The last eight visible rows, lowercased, where status and key hints live.
fn lowerTail(buffer: *[8192]u8, screen: []const u8) []const u8 {
    const visible = std.mem.trimEnd(u8, screen, " \t\r\n");
    var start = visible.len;
    var lines: usize = 0;
    while (start > 0 and lines < 8) {
        start -= 1;
        if (visible[start] == '\n') lines += 1;
    }
    const tail = visible[start..];
    const text = buffer[0..@min(tail.len, buffer.len)];
    for (text, tail[0..text.len]) |*out, ch| out.* = std.ascii.toLower(ch);
    return text;
}

const Composer = enum { covered, open, unknown };
/// Claude's composer is a `❯` input between two rules. Its prompts (tool
/// permissions, questions, other dialogs) replace it until they are answered.
fn claudeComposer(screen: []const u8) Composer {
    var after_rule = false;
    var input = false;
    var found = false;
    var rows = std.mem.splitScalar(u8, screen, '\n');
    while (rows.next()) |row| {
        if (rule(row)) {
            if (input) found = true;
            input = false;
            after_rule = true;
            continue;
        }
        // Wrapped input continues until the closing rule.
        if (after_rule) input = std.mem.startsWith(u8, std.mem.trimStart(u8, row, " "), "❯");
        after_rule = false;
    }
    if (!found) return .covered;
    // Key hints mean something other than the composer has focus.
    var lower: [8192]u8 = undefined;
    const text = lowerTail(&lower, screen);
    for ([_][]const u8{ "esc to cancel", "enter to select", "enter to confirm", "enter to submit" }) |hint| {
        if (has(text, hint)) return .unknown;
    }
    return .open;
}
fn rule(row: []const u8) bool {
    var rest = std.mem.trim(u8, row, " ");
    if (rest.len < 10 * "─".len) return false;
    while (std.mem.startsWith(u8, rest, "─")) rest = rest["─".len..];
    return rest.len == 0;
}

/// Only the live status beside the interrupt hint establishes compaction.
/// Missing status (including partial redraws) is not evidence that it ended.
pub fn screenCompacting(screen: []const u8) ?bool {
    const visible = std.mem.trimEnd(u8, screen, " \t\r\n");
    var rows = std.mem.splitBackwardsScalar(u8, visible, '\n');
    var count: usize = 0;
    while (rows.next()) |row| {
        if (count == 8) break;
        count += 1;
        const hint = std.mem.indexOf(u8, row, "esc to interrupt") orelse continue;
        const status = std.mem.trimStart(u8, row[0..hint], " ");
        for ([_][]const u8{ "Compacting context", "Compacting conversation" }) |label| {
            for ([_][]const u8{ "", "• ", "◦ ", "· " }) |prefix| {
                if (!std.mem.startsWith(u8, status, prefix)) continue;
                const rest = status[prefix.len..];
                if (std.mem.startsWith(u8, rest, label) and rest.len > label.len and rest[label.len] == ' ') return true;
            }
        }
        return false;
    }
    return null;
}

// A live status row can count background terminals, sometimes clipped by a
// narrow pane, while the lifecycle status stays "Working".
fn screenToolActive(provider: Provider, screen: []const u8) bool {
    if (!provider.info().screen.background_status) return false;
    const visible = std.mem.trimEnd(u8, screen, " \t\r\n");
    var rows = std.mem.splitBackwardsScalar(u8, visible, '\n');
    var count: usize = 0;
    while (rows.next()) |row| {
        if (count == 8) break;
        count += 1;
        const hint = std.mem.indexOf(u8, row, "esc to interrupt)") orelse continue;
        if (has(row[0..hint], "Waiting for background terminal")) return true;
        const suffix = std.mem.trim(u8, row[hint + "esc to interrupt)".len ..], " ");
        if (!std.mem.startsWith(u8, suffix, "· ")) continue;
        const value = suffix["· ".len..];
        const end = std.mem.indexOfScalar(u8, value, ' ') orelse continue;
        const running = std.fmt.parseInt(u32, value[0..end], 10) catch continue;
        if (running == 0) continue;
        const label = std.mem.trimEnd(u8, value[end + 1 ..], " ");
        if (std.mem.startsWith(u8, label, "background terminal")) return true;
        if (std.mem.endsWith(u8, label, "…")) {
            const prefix = label[0 .. label.len - "…".len];
            if (prefix.len >= "background t".len and std.mem.startsWith(u8, "background terminals running", prefix)) return true;
        }
    }
    return false;
}

const interrupt_delay = 1500 * std.time.us_per_ms;
// After the user presses an interrupt key, a briefly stable idle screen is enough.
const requested_interrupt_delay = 250 * std.time.us_per_ms;
const interrupt_key_window = 5 * std.time.us_per_s;

/// Whether terminal input contains Esc or Ctrl-C, in legacy or Kitty encoding.
fn interruptKey(bytes: []const u8) bool {
    if (std.mem.eql(u8, bytes, "\x1b") or std.mem.indexOfScalar(u8, bytes, 3) != null) return true;
    for ([_][]const u8{ "\x1b[27", "\x1b[99;5" }) |prefix| {
        var rest = bytes;
        while (std.mem.indexOf(u8, rest, prefix)) |at| {
            rest = rest[at + prefix.len ..];
            const end = std.mem.indexOfNone(u8, rest, "0123456789;:") orelse break;
            // CSI 27;…~ is xterm's modifyOtherKeys wrapper for arbitrary keys.
            if (rest[end] == 'u' and (end == 0 or rest[0] == ';' or rest[0] == ':')) return true;
        }
    }
    return false;
}

/// Claude sends no hook when a person answers a prompt, and a dialog outside
/// a tool call is followed by no hook at all. A hook-reported block ends once
/// its prompt has covered the composer and the composer is back: working if
/// the turn goes on, otherwise idle. Only live screens hold this evidence, so
/// it is not saved.
pub const PromptWatch = struct {
    seen: bool = false,
    covered: u8 = 0,
    open: u8 = 0,

    pub fn answered(w: *PromptWatch, blocked: bool, screen: []const u8) ?State {
        if (!blocked) {
            w.* = .{};
            return null;
        }
        // The blocking hook can arrive before its prompt is drawn, and a frame
        // can be caught mid-redraw, so each side must hold for two polls.
        switch (claudeComposer(screen)) {
            .covered => {
                w.covered +|= 1;
                w.open = 0;
                if (w.covered >= 2) w.seen = true;
                return null;
            },
            .unknown => {
                w.covered = 0;
                w.open = 0;
                return null;
            },
            .open => {
                w.covered = 0;
                if (!w.seen) return null;
                w.open +|= 1;
                if (w.open < 2) return null;
                w.* = .{};
                return if (screenState(.claude, "", screen) == .working) .working else .idle;
            },
        }
    }
};

pub const Tracker = struct {
    pid: c_int = 0,
    missing: u8 = 0,
    candidate: ?State = null,
    confirmations: u8 = 0,
    ready: bool = false,
    idle_since: i64 = 0,
    interrupt_key_at: i64 = 0,

    pub fn observeInput(t: *Tracker, bytes: []const u8, now: i64) void {
        if (interruptKey(bytes)) t.interrupt_key_at = now;
    }

    /// Claude sends no hook when the user interrupts a turn, so a hook-reported
    /// turn ends once Claude's own idle screen has stayed visible for a while,
    /// or only briefly when it follows a recent Esc or Ctrl-C.
    pub fn interrupted(t: *Tracker, title: []const u8, screen: []const u8, now: i64) bool {
        if (screenState(.claude, title, screen) != .idle) {
            t.idle_since = 0;
            return false;
        }
        if (t.idle_since == 0) t.idle_since = now;
        if (t.interrupt_key_at != 0 and now - t.interrupt_key_at <= interrupt_key_window) {
            if (now - @max(t.idle_since, t.interrupt_key_at) >= requested_interrupt_delay) return true;
        }
        return now - t.idle_since >= interrupt_delay;
    }

    pub fn update(t: *Tracker, agent: *agents.Agent, job: ?Job, title: []const u8, screen: []const u8, watched: bool) bool {
        const current = job orelse {
            // Don't erase hook-only integrations we have never observed as a
            // foreground process. Two missing polls absorb exec transitions.
            if (t.pid != 0) {
                t.missing += 1;
                if (t.missing >= 2) {
                    agent.reset();
                    t.* = .{};
                }
            }
            return false;
        };
        t.missing = 0;
        if (t.pid != current.pid or agent.provider != current.provider) {
            if (t.pid != 0 or agent.provider != current.provider) agent.reset();
            t.pid = current.pid;
            t.candidate = null;
            t.confirmations = 0;
            t.ready = false;
            agent.provider = current.provider;
            if (agent.last_seq == 0) agent.state = .initializing;
        }
        if (agent.last_seq != 0) return false;
        const next = screenState(current.provider, title, screen) orelse {
            t.candidate = null;
            t.confirmations = 0;
            return false;
        };
        // Before the first stable prompt, even an interrupt hint can belong
        // to startup. Real turn hooks bypass this conservative fallback.
        if (next == .working and !t.ready) {
            t.candidate = null;
            t.confirmations = 0;
            return false;
        }
        if (t.candidate != next) {
            t.candidate = next;
            t.confirmations = 0;
        }
        t.confirmations +|= 1;
        if (t.confirmations < (if (next == .idle) @as(u8, 3) else 2)) return false;
        agent.tool_active = next == .working and screenToolActive(current.provider, screen);
        if (agent.state == next) return false;
        if (next == .idle) t.ready = true;
        agent.state = next;
        agent.changed_at = os.microTimestamp();
        agent.activity = .{};
        agent.observation.source = .screen;
        if (next == .working) agent.attention = if (agent.observation.unread()) .finished else .none;
        if (next == .blocked) {
            if (!watched) agent.attention = .needs_input;
            return true;
        }
        return false;
    }
};

test "identify actual executables and scripts, not arguments or shell text" {
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{"/opt/bin/codex"}));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "node", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "bun", "/a/node_modules/@openai/codex/bin/codex.js" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "bun", "run", "--bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "python3", "/tmp/codex" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "/Frameworks/Python", "/tmp/codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "sh", "-c", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "node", "-e", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "bun", "-e", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "vim", "codex" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "/Users/a/.local/share/claude/versions/2.1.282", "--session-id", "x" }));
}

test "compaction requires a live status row and ignores quoted or historical text" {
    try std.testing.expectEqual(true, screenCompacting("• Compacting context (12s • esc to interrupt)\n› ").?);
    try std.testing.expectEqual(true, screenCompacting("◦ Compacting conversation (esc to interrupt)\n› ").?);
    try std.testing.expectEqual(false, screenCompacting("• Compacting context (esc to interrupt)\nWorking (esc to interrupt)").?);
    try std.testing.expectEqual(false, screenCompacting("I saw Compacting context (esc to interrupt)").?);
    try std.testing.expectEqual(null, screenCompacting("Compacting context\n› "));
    try std.testing.expectEqual(null, screenCompacting("• Compacting context (esc to interrupt)\n1\n2\n3\n4\n5\n6\n7\n8"));
}

test "claude interrupts need a stable idle title without an interrupt hint" {
    var tracker: Tracker = .{};
    const idle = "> \n  ? for shortcuts";
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, 100));
    try std.testing.expect(!tracker.interrupted("⠋ Task", idle, 100 + interrupt_delay));
    try std.testing.expect(!tracker.interrupted("✳ Task", "✻ Working (esc to interrupt)", 200 + interrupt_delay));
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, 300 + interrupt_delay));
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, 299 + 2 * interrupt_delay));
    try std.testing.expect(tracker.interrupted("✳ Task", idle, 300 + 2 * interrupt_delay));
}

test "an interrupt key shortens the stable idle wait" {
    var tracker: Tracker = .{};
    const idle = "> \n  ? for shortcuts";
    tracker.observeInput("\x1b", 1000);
    try std.testing.expect(!tracker.interrupted("⠋ Task", "✻ Working (esc to interrupt)", 1000 + 100));
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, 1000 + 200));
    try std.testing.expect(tracker.interrupted("✳ Task", idle, 1000 + 200 + requested_interrupt_delay));
    // A stale key falls back to the long wait.
    tracker = .{};
    tracker.observeInput("\x03", 1000);
    const late = 1000 + interrupt_key_window + 1;
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, late));
    try std.testing.expect(!tracker.interrupted("✳ Task", idle, late + requested_interrupt_delay));
}

// Claude Code 2.1.283 screens, as rendered in both of its TUI modes.
const claude_screens = struct {
    const line = "─" ** 40;
    const idle = "⏺ Done.\n\n" ++ line ++ "\n❯ \n" ++ line ++ "\n  ⏸ manual mode on · ? for shortcuts · ← 2 agents";
    const typed = line ++ "\n❯ a long reply that\n  wraps\n" ++ line ++ "\n  ⏸ manual mode on";
    const working = "✢ Honking… (1s · thinking)\n" ++ line ++ "\n❯ \n" ++ line ++ "\n  ⏸ manual mode on · esc to interrupt · ← 2 agents";
    const permission = "⏺ Sleeping\n" ++ line ++ "\n Bash command\n\n   sleep 25\n\n Do you want to proceed?\n ❯ 1. Yes\n   2. Yes, and always allow\n   3. No\n\n Esc to cancel · Tab to amend";
    const question = line ++ "\n ☐ Color\n\nPick a color\n\n❯ 1. Red\n  2. Blue\n  3. Type something.\n" ++ line ++ "\n  4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel";
    // The option below the question's rule, selected, is not a composer.
    const question_last = line ++ "\n ☐ Color\n\nPick a color\n\n  1. Red\n  2. Blue\n  3. Type something.\n" ++ line ++ "\n❯ 4. Chat about this\n\nEnter to select · ↑/↓ to navigate · Esc to cancel";
};

test "Claude's prompts cover its composer" {
    const s = claude_screens;
    for ([_][]const u8{ s.idle, s.typed, s.working }) |screen| try std.testing.expectEqual(Composer.open, claudeComposer(screen));
    for ([_][]const u8{ s.permission, s.question, s.question_last, "" }) |screen| try std.testing.expectEqual(Composer.covered, claudeComposer(screen));
    // Key hints beside a composer mean something else has focus.
    try std.testing.expectEqual(Composer.unknown, claudeComposer(s.line ++ "\n❯ make\n" ++ s.line ++ "\n  enter to select · esc to cancel"));
}

test "a hook-reported Claude block ends once its prompt was seen and answered" {
    const s = claude_screens;
    var t: PromptWatch = .{};
    // The blocking hook can precede its prompt, and one frame may be mid-redraw.
    try std.testing.expectEqual(null, t.answered(true, s.working));
    try std.testing.expectEqual(null, t.answered(true, s.permission));
    try std.testing.expectEqual(null, t.answered(true, s.working));
    try std.testing.expectEqual(null, t.answered(true, s.working));
    try std.testing.expectEqual(null, t.answered(true, s.permission));
    try std.testing.expectEqual(null, t.answered(true, s.permission));
    try std.testing.expectEqual(null, t.answered(true, s.working));
    try std.testing.expectEqual(State.working, t.answered(true, s.working).?);
    // A dialog after the turn leaves an idle composer.
    for (0..2) |_| try std.testing.expectEqual(null, t.answered(true, s.question));
    try std.testing.expectEqual(null, t.answered(true, s.typed));
    try std.testing.expectEqual(State.idle, t.answered(true, s.idle).?);
    // A block that a hook ends forgets its prompt.
    for (0..2) |_| _ = t.answered(true, s.question);
    try std.testing.expectEqual(null, t.answered(false, ""));
    for (0..3) |_| try std.testing.expectEqual(null, t.answered(true, s.idle));
}

test "recognize interrupt keys in legacy and Kitty encodings" {
    for ([_][]const u8{ "\x1b", "\x03", "\x1b[27u", "\x1b[27;1u", "\x1b[27;1:1u", "\x1b[99;5u", "a\x1b[27u" }) |bytes| {
        try std.testing.expect(interruptKey(bytes));
    }
    for ([_][]const u8{ "", "a", "\x1b[A", "\x1bb", "\x1b[27;5;97~", "\x1b[270u", "\x1b[99u" }) |bytes| {
        try std.testing.expect(!interruptKey(bytes));
    }
}

test "fallback debounces attention, yields to hooks, and clears exited agents" {
    var tracker: Tracker = .{};
    var agent: agents.Agent = .{};
    const job: Job = .{ .pid = 123, .provider = .claude };
    try std.testing.expect(!tracker.update(&agent, job, "⠋ Task", "", false));
    try std.testing.expect(!tracker.update(&agent, job, "⠋ Task", "", false));
    try std.testing.expectEqual(State.initializing, agent.state);
    for (0..4) |_| _ = tracker.update(&agent, job, "⠋ Starting", "Initializing (esc to interrupt)", false);
    try std.testing.expectEqual(State.initializing, agent.state);
    for (0..3) |_| _ = tracker.update(&agent, job, "✳ Ready", "", false);
    // A spinner alone stays idle even after startup.
    for (0..3) |_| _ = tracker.update(&agent, job, "⠋ Loading", "", false);
    try std.testing.expectEqual(State.idle, agent.state);
    for (0..2) |_| _ = tracker.update(&agent, job, "⠋ Task", "Working (esc to interrupt)", false);
    try std.testing.expectEqual(State.working, agent.state);
    try std.testing.expect(!tracker.update(&agent, job, "✳ Task", "", false));
    try std.testing.expect(!tracker.update(&agent, job, "✳ Task", "", false));
    try std.testing.expect(!tracker.update(&agent, job, "✳ Task", "", false));
    try std.testing.expectEqual(agents.Attention.none, agent.attention);
    agent.last_seq = 1;
    agent.state = .blocked;
    for (0..4) |_| _ = tracker.update(&agent, job, "⠋ Task", "", false);
    try std.testing.expectEqual(State.blocked, agent.state);
    _ = tracker.update(&agent, null, "", "", false);
    try std.testing.expectEqual(@as(?Provider, .claude), agent.provider);
    _ = tracker.update(&agent, null, "", "", false);
    try std.testing.expectEqual(@as(?Provider, null), agent.provider);
    try std.testing.expectEqual(@as(i64, 0), agent.last_seq);
}

test "Codex fallback tracks tools without a lifecycle state transition" {
    var tracker: Tracker = .{};
    var agent: agents.Agent = .{};
    const job: Job = .{ .pid = 123, .provider = .codex };
    for (0..3) |_| _ = tracker.update(&agent, job, "", "› ", true);
    const working = "• Working (20s • esc to interrupt)\n› Ask Codex to do anything";
    for (0..2) |_| _ = tracker.update(&agent, job, "", working, true);
    try std.testing.expectEqual(State.working, agent.state);
    try std.testing.expect(!agent.tool_active);
    for ([_][]const u8{
        "• Working (20s • esc to interrupt) · 1 background terminal running\n› Ask Codex to do anything",
        "• Working (20s • esc to interrupt) · 3 background t…\n› Ask Codex to do anything",
        "• Waiting for background terminal (20s • esc to interrupt)\n› Ask Codex to do anything",
    }) |screen| {
        _ = tracker.update(&agent, job, "", screen, true);
        try std.testing.expect(agent.tool_active);
        _ = tracker.update(&agent, job, "", working, true);
        try std.testing.expect(!agent.tool_active);
    }
    try std.testing.expect(!screenToolActive(.codex, "• Working (20s • esc to interrupt) · 0 background terminals running"));
    try std.testing.expect(!screenToolActive(.claude, "• Working (20s • esc to interrupt) · 1 background terminal running"));
    try std.testing.expect(!screenToolActive(.codex, "A response mentions 1 background terminal running\n" ++ working));
    const tool = "• Working (20s • esc to interrupt) · 1 background t…";
    _ = tracker.update(&agent, job, "", tool, true);
    for (0..3) |_| _ = tracker.update(&agent, job, "", "› ", true);
    try std.testing.expect(!agent.tool_active);
    agent.last_seq = 1;
    agent.state = .working;
    for (0..3) |_| _ = tracker.update(&agent, job, "", tool, true);
    try std.testing.expect(!agent.tool_active);
}

test "a retitled Claude process is still Claude" {
    var p: os.ProcessArgs = .{ .exe = "/usr/bin/node" };
    p.argv[0] = "claude bg-spare";
    p.argc = 1;
    try std.testing.expect(claudeProcess(&p));
    p.argv[0] = "node";
    try std.testing.expect(!claudeProcess(&p));
    p.exe = "/opt/claude/bin/claude";
    try std.testing.expect(claudeProcess(&p));
}

test "a detached process is a background job and a terminal's foreground is not" {
    var byte: [1]u8 = undefined;
    var ready: [2]c_int = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.pipe(&ready));
    defer _ = c.close(ready[0]);
    // Agent tools start commands like this, in a new session without a terminal.
    const detached = c.fork();
    if (detached == 0) {
        _ = c.setsid();
        _ = c.write(ready[1], "x", 1);
        while (true) _ = c.pause();
    }
    _ = c.close(ready[1]);
    if (detached < 0) return error.ForkFailed;
    defer _ = c.waitpid(detached, null, 0);
    defer _ = c.kill(detached, c.SIGKILL);
    try std.testing.expectEqual(@as(isize, 1), c.read(ready[0], &byte, 1));
    try std.testing.expect(backgroundJob(detached));

    var fd: c_int = undefined;
    const leader = c.forkpty(&fd, null, null, null);
    if (leader == 0) {
        _ = c.write(1, "x", 1);
        while (true) _ = c.pause();
    }
    if (leader < 0) return error.ForkFailed;
    defer _ = c.close(fd);
    defer _ = c.waitpid(leader, null, 0);
    defer _ = c.kill(leader, c.SIGKILL);
    try std.testing.expectEqual(@as(isize, 1), c.read(fd, &byte, 1));
    try std.testing.expect(!backgroundJob(leader));
}
