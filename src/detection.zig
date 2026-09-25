//! Passive foreground-job discovery. No shell aliases or PATH shims required.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const agents = @import("agents.zig");
const Provider = agents.Provider;
const State = agents.State;
pub const Job = struct { pid: c_int, provider: Provider };

fn name(path: []const u8) Provider {
    const base = std.fs.path.basename(path);
    if (std.mem.eql(u8, base, "codex")) return .codex;
    if (std.mem.eql(u8, base, "claude") or std.mem.eql(u8, base, "claude-code")) return .claude;
    // Claude's daemon launches the versioned native binary directly.
    if (std.mem.indexOf(u8, path, "/claude/versions/") != null) return .claude;
    return .other;
}

// Only executable/script positions count. `sh -c 'codex ...'`, `node -e
// 'codex'`, and an editor opening a file named codex are not agents.
pub fn identify(argv: []const []const u8) Provider {
    if (argv.len == 0) return .other;
    const direct = name(argv[0]);
    if (direct != .other) return direct;
    const exe = std.fs.path.basename(argv[0]);
    const interpreter = std.mem.eql(u8, exe, "node") or std.mem.eql(u8, exe, "bun") or
        std.mem.eql(u8, exe, "sh") or std.mem.eql(u8, exe, "bash") or
        std.mem.eql(u8, exe, "zsh") or std.ascii.startsWithIgnoreCase(exe, "python");
    if (!interpreter or argv.len < 2) return .other;
    var i: usize = 1;
    if (std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    while (i < argv.len and argv[i].len > 0 and argv[i][0] == '-') : (i += 1) {
        if (std.mem.eql(u8, argv[i], "--")) {
            i += 1;
            break;
        }
        // Be conservative with interpreter flags that consume another argument.
        const bun_flag = std.mem.eql(u8, exe, "bun") and (std.mem.eql(u8, argv[i], "--bun") or std.mem.eql(u8, argv[i], "-b"));
        if (!bun_flag and !std.mem.eql(u8, argv[i], "-u") and !std.mem.eql(u8, argv[i], "--no-warnings")) return .other;
    }
    if (i < argv.len and std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    if (i >= argv.len) return .other;
    const script = argv[i];
    const script_name = name(script);
    if (script_name != .other) return script_name;
    if (std.mem.endsWith(u8, script, "/@anthropic-ai/claude-code/cli.js")) return .claude;
    if (std.mem.endsWith(u8, script, "/@openai/codex/bin/codex.js")) return .codex;
    return .other;
}

fn process(pid: c_int) Provider {
    var bytes: [65536]u8 = undefined;
    var data: []const u8 = undefined;
    var max_args: usize = 64;
    if (@import("builtin").os.tag == .macos) {
        var mib = [_]c_int{ c.CTL_KERN, c.KERN_PROCARGS2, pid };
        var len: usize = bytes.len;
        if (c.sysctl(&mib, mib.len, &bytes, &len, null, 0) != 0 or len < @sizeOf(c_int)) return .other;
        const argc = std.mem.bytesToValue(c_int, bytes[0..@sizeOf(c_int)]);
        if (argc <= 0) return .other;
        max_args = @min(max_args, @as(usize, @intCast(argc)));
        data = bytes[@sizeOf(c_int)..len];
        const end = std.mem.indexOfScalar(u8, data, 0) orelse return .other;
        // The kernel starts with the executable path and alignment padding,
        // followed by argc NUL-separated arguments (then environment data).
        data = std.mem.trimStart(u8, data[end..], "\x00");
    } else if (@import("builtin").os.tag == .linux) {
        var path: [64]u8 = undefined;
        const file = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/cmdline", .{pid}) catch return .other, .{}) catch return .other;
        defer file.close();
        const len = file.readAll(&bytes) catch return .other;
        data = bytes[0..len];
    } else return .other;
    var argv: [64][]const u8 = undefined;
    var count: usize = 0;
    var it = std.mem.splitScalar(u8, data, 0);
    while (count < max_args) {
        argv[count] = it.next() orelse break;
        count += 1;
    }
    return identify(argv[0..count]);
}

/// Claude runs hooks without its internal session variables, and its
/// background daemon hands CORGI_PANE from one pane to every session it
/// hosts. The hook's own Claude process is marked, so find the nearest one.
pub fn backgroundAncestor() bool {
    const a = std.heap.c_allocator;
    // Daemon-hosted sessions carry large environments; 64 KiB is not enough.
    const bytes = a.alloc(u8, 1024 * 1024) catch return false;
    defer a.free(bytes);
    var pid: c_int = c.getppid();
    for (0..8) |_| {
        if (pid <= 1) return false;
        if (processBlock(pid, bytes)) |block| if (block.claude()) {
            for (block.env.items[0..block.env.len]) |entry| if (std.mem.eql(u8, entry, "CLAUDE_CODE_SESSION_KIND=bg")) return true;
            return false;
        };
        pid = parent(pid) orelse return false;
    }
    return false;
}

const Block = struct {
    exec: []const u8 = "",
    argv: [64][]const u8 = undefined,
    argc: usize = 0,
    env: struct { items: [512][]const u8 = undefined, len: usize = 0 } = .{},
    /// Claude retitles its processes ("claude bg-spare" as one argv[0]),
    /// so also trust the executable path and argv[0]'s first word.
    fn claude(b: *const Block) bool {
        if (name(b.exec) == .claude) return true;
        if (b.argc == 0) return false;
        if (identify(b.argv[0..b.argc]) == .claude) return true;
        const first = b.argv[0][0 .. std.mem.indexOfScalar(u8, b.argv[0], ' ') orelse b.argv[0].len];
        return name(first) == .claude;
    }
};

/// Arguments and initial environment of a same-user process.
fn processBlock(pid: c_int, bytes: []u8) ?Block {
    var out: Block = .{};
    var argc: usize = 0;
    var data: []const u8 = undefined;
    if (@import("builtin").os.tag == .macos) {
        var mib = [_]c_int{ c.CTL_KERN, c.KERN_PROCARGS2, pid };
        var len: usize = bytes.len;
        if (c.sysctl(&mib, mib.len, bytes.ptr, &len, null, 0) != 0 or len < @sizeOf(c_int)) return null;
        const count = std.mem.bytesToValue(c_int, bytes[0..@sizeOf(c_int)]);
        if (count <= 0) return null;
        argc = @intCast(count);
        data = bytes[@sizeOf(c_int)..len];
        // Executable path, alignment padding, then argv and the environment.
        const end = std.mem.indexOfScalar(u8, data, 0) orelse return null;
        out.exec = data[0..end];
        data = std.mem.trimStart(u8, data[end..], "\x00");
    } else if (@import("builtin").os.tag == .linux) {
        var path: [64]u8 = undefined;
        // The executable path lives past the argument and environment halves.
        const reserve = std.fs.max_path_bytes;
        if (std.posix.readlink(std.fmt.bufPrint(&path, "/proc/{d}/exe", .{pid}) catch return null, bytes[bytes.len - reserve ..])) |exe| out.exec = exe else |_| {}
        const cmdline = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/cmdline", .{pid}) catch return null, .{}) catch return null;
        defer cmdline.close();
        const half = (bytes.len - reserve) / 2;
        const args = bytes[0 .. cmdline.readAll(bytes[0..half]) catch return null];
        var args_it = std.mem.splitScalar(u8, std.mem.trimEnd(u8, args, "\x00"), 0);
        while (args_it.next()) |arg| {
            if (out.argc == out.argv.len) break;
            out.argv[out.argc] = arg;
            out.argc += 1;
        }
        const environ = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/environ", .{pid}) catch return null, .{}) catch return null;
        defer environ.close();
        const env = bytes[half .. half + (environ.readAll(bytes[half .. bytes.len - reserve]) catch return null)];
        var env_it = std.mem.splitScalar(u8, env, 0);
        while (env_it.next()) |entry| {
            if (entry.len == 0 or out.env.len == out.env.items.len) continue;
            out.env.items[out.env.len] = entry;
            out.env.len += 1;
        }
        return if (out.argc > 0) out else null;
    } else return null;
    var it = std.mem.splitScalar(u8, data, 0);
    while (it.next()) |item| {
        if (out.argc < argc and out.argc < out.argv.len) {
            out.argv[out.argc] = item;
            out.argc += 1;
        } else if (out.argc >= argc) {
            if (item.len == 0) break;
            if (out.env.len < out.env.items.len) {
                out.env.items[out.env.len] = item;
                out.env.len += 1;
            }
        } else break;
    }
    return if (out.argc > 0) out else null;
}

fn parent(pid: c_int) ?c_int {
    if (@import("builtin").os.tag == .macos) {
        var info: c.proc_bsdinfo = undefined;
        if (c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(c.proc_bsdinfo)) != @sizeOf(c.proc_bsdinfo)) return null;
        return @intCast(info.pbi_ppid);
    } else if (@import("builtin").os.tag == .linux) {
        var path: [64]u8 = undefined;
        var bytes: [1024]u8 = undefined;
        const file = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/stat", .{pid}) catch return null, .{}) catch return null;
        defer file.close();
        const stat = bytes[0 .. file.readAll(&bytes) catch return null];
        // The command name may contain spaces; fields resume after its ')'.
        const close = std.mem.lastIndexOfScalar(u8, stat, ')') orelse return null;
        var fields = std.mem.tokenizeScalar(u8, stat[close + 1 ..], ' ');
        _ = fields.next();
        return std.fmt.parseInt(c_int, fields.next() orelse return null, 10) catch null;
    }
    return null;
}

pub fn foreground(fd: c_int) ?Job {
    const pgid = c.tcgetpgrp(fd);
    if (pgid <= 0) return null;
    const leader = process(pgid);
    if (leader != .other) return .{ .pid = pgid, .provider = leader };
    if (@import("builtin").os.tag == .macos) {
        var pids: [128]c_int = undefined;
        const n = c.proc_listpids(c.PROC_PGRP_ONLY, @intCast(pgid), &pids, @sizeOf(@TypeOf(pids)));
        if (n <= 0) return null;
        for (pids[0..@min(pids.len, @as(usize, @intCast(n)) / @sizeOf(c_int))]) |pid| {
            if (pid <= 0 or pid == pgid) continue;
            const provider = process(pid);
            if (provider != .other) return .{ .pid = pid, .provider = provider };
        }
    } else if (@import("builtin").os.tag == .linux) {
        var dir = std.fs.openDirAbsolute("/proc", .{ .iterate = true }) catch return null;
        defer dir.close();
        var it = dir.iterate();
        while (it.next() catch null) |entry| {
            const pid = std.fmt.parseInt(c_int, entry.name, 10) catch continue;
            if (pid == pgid or c.getpgid(pid) != pgid) continue;
            const provider = process(pid);
            if (provider != .other) return .{ .pid = pid, .provider = provider };
        }
    }
    return null;
}

// Hook events are authoritative once received. The fallback only uses strong
// UI signals, never inactivity or arbitrary mentions in an agent's response.
pub fn screenState(provider: Provider, title: []const u8, screen: []const u8) ?State {
    if (provider == .codex and std.mem.indexOf(u8, title, "Action Required") != null) return .blocked;
    const visible = std.mem.trimEnd(u8, screen, " \t\r\n");
    var start = visible.len;
    var lines: usize = 0;
    while (start > 0 and lines < 8) {
        start -= 1;
        if (visible[start] == '\n') lines += 1;
    }
    var lower: [8192]u8 = undefined;
    const tail = visible[start..];
    const text = lower[0..@min(tail.len, lower.len)];
    for (text, tail[0..text.len]) |*out, ch| out.* = std.ascii.toLower(ch);
    if ((has(text, "enter to confirm") and has(text, "esc to cancel")) or has(text, "enter to submit answer") or has(text, "enter to submit all")) return .blocked;
    // Title spinners also run during startup, MCP connection and other UI
    // loading. They do not establish an active turn.
    if (has(text, "esc to interrupt")) return .working;
    if (provider == .claude and std.mem.startsWith(u8, title, "✳ ")) return .idle;
    if (provider == .codex) {
        var rows = std.mem.splitScalar(u8, text, '\n');
        while (rows.next()) |row| {
            if (std.mem.startsWith(u8, std.mem.trimStart(u8, row, " "), "›")) return .idle;
        }
    }
    return null;
}
fn has(text: []const u8, needle: []const u8) bool {
    return std.mem.indexOf(u8, text, needle) != null;
}

// Unified exec keeps Codex's status at "Working" while the command runs.
// Its live status row carries a count, sometimes clipped by a narrow pane.
fn screenToolActive(provider: Provider, screen: []const u8) bool {
    if (provider != .codex) return false;
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

pub const Tracker = struct {
    pid: c_int = 0,
    missing: u8 = 0,
    candidate: ?State = null,
    confirmations: u8 = 0,
    ready: bool = false,
    idle_since: i64 = 0,

    /// Claude sends no hook when the user interrupts a turn, so a hook-reported
    /// turn ends once Claude's own idle screen has stayed visible for a while.
    pub fn interrupted(t: *Tracker, title: []const u8, screen: []const u8, now: i64) bool {
        if (screenState(.claude, title, screen) != .idle) {
            t.idle_since = 0;
            return false;
        }
        if (t.idle_since == 0) t.idle_since = now;
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
        agent.changed_at = std.time.microTimestamp();
        agent.activity_len = 0;
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
    try std.testing.expectEqual(Provider.codex, identify(&.{"/opt/bin/codex"}));
    try std.testing.expectEqual(Provider.claude, identify(&.{ "node", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(Provider.claude, identify(&.{ "bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(Provider.codex, identify(&.{ "bun", "/a/node_modules/@openai/codex/bin/codex.js" }));
    try std.testing.expectEqual(Provider.claude, identify(&.{ "bun", "run", "--bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(Provider.codex, identify(&.{ "python3", "/tmp/codex" }));
    try std.testing.expectEqual(Provider.codex, identify(&.{ "/Frameworks/Python", "/tmp/codex" }));
    try std.testing.expectEqual(Provider.other, identify(&.{ "sh", "-c", "codex" }));
    try std.testing.expectEqual(Provider.other, identify(&.{ "node", "-e", "codex" }));
    try std.testing.expectEqual(Provider.other, identify(&.{ "bun", "-e", "codex" }));
    try std.testing.expectEqual(Provider.other, identify(&.{ "vim", "codex" }));
    try std.testing.expectEqual(Provider.claude, identify(&.{ "/Users/a/.local/share/claude/versions/2.1.282", "--session-id", "x" }));
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
    try std.testing.expectEqual(Provider.claude, agent.provider);
    _ = tracker.update(&agent, null, "", "", false);
    try std.testing.expectEqual(Provider.other, agent.provider);
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

test "process ancestry, arguments and initial environment are readable" {
    try std.testing.expectEqual(c.getppid(), parent(c.getpid()).?);
    const bytes = try std.testing.allocator.alloc(u8, 1024 * 1024);
    defer std.testing.allocator.free(bytes);
    const block = processBlock(c.getpid(), bytes).?;
    try std.testing.expect(block.argc > 0);
    const home = std.posix.getenv("HOME") orelse return error.SkipZigTest;
    var entry: [4096]u8 = undefined;
    const wanted = try std.fmt.bufPrint(&entry, "HOME={s}", .{home});
    var found = false;
    for (block.env.items[0..block.env.len]) |item| found = found or std.mem.eql(u8, item, wanted);
    try std.testing.expect(found);
}
