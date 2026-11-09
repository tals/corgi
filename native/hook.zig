//! `corgi-hook hook <provider>`: forwards a provider hook event to the
//! daemon as one HTTP POST over its Unix socket. Claude Code and Codex wait
//! for hooks around every tool call, so this stays a small native program
//! instead of starting the Bun application. It decides what `corgi hook`
//! decides (integration.zig) and always exits 0: a hook must never fail
//! the agent.
const std = @import("std");
const deps = @import("hook_deps");
const os = deps.os;
const detection = deps.detection;
const c = os.c;
const a = os.allocator;

pub fn main(init: std.process.Init) void {
    os.initIo(init.minimal);
    // A daemon that closes mid-request must not kill the hook.
    const ignore: std.posix.Sigaction = .{ .handler = .{ .handler = std.posix.SIG.IGN }, .mask = std.posix.sigemptyset(), .flags = 0 };
    std.posix.sigaction(std.posix.SIG.PIPE, &ignore, null);
    run(init) catch {};
}

/// Any well-formed provider id, as `Provider.register` requires; the daemon
/// decides whether it is one.
fn providerName(arg: []const u8) bool {
    if (arg.len == 0 or arg.len > 32) return false;
    for (arg) |ch| if (!std.ascii.isLower(ch) and !std.ascii.isDigit(ch)) return false;
    return true;
}

test "a provider id is lowercase letters and digits" {
    for ([_][]const u8{ "claude", "opencode2", "pi" }) |id| try std.testing.expect(providerName(id));
    for ([_][]const u8{ "", "Claude", "../x", "gemini_cli", "abcdefghijklmnopqrstuvwxyz0123456" }) |id| try std.testing.expect(!providerName(id));
}

fn run(init: std.process.Init) !void {
    const args = try init.minimal.args.toSlice(a);
    if (args.len != 3 or !std.mem.eql(u8, args[1], "hook")) return;
    const provider = args[2];
    if (!providerName(provider)) return;
    // Only Claude's and Codex's hooks need more than forwarding.
    const is_claude = std.mem.eql(u8, provider, "claude");
    const is_codex = std.mem.eql(u8, provider, "codex");
    const pane = std.fmt.parseInt(u32, os.env("CORGI_PANE") orelse return, 10) catch return;
    const socket = os.env("CORGI_SOCKET") orelse return;

    var input: std.ArrayList(u8) = .empty;
    var buf: [8192]u8 = undefined;
    while (input.items.len < 1024 * 1024) {
        const n = c.read(0, &buf, buf.len);
        if (n <= 0) break;
        try input.appendSlice(a, buf[0..@intCast(n)]);
    }
    const parsed = std.json.parseFromSlice(std.json.Value, a, input.items, .{}) catch return;
    // Codex tools/subagents inherit the pane environment. Their sessions
    // must not take ownership of the parent terminal's sidebar entry.
    if (is_codex) if (os.env("CODEX_THREAD_ID")) |parent| {
        const session = switch (parsed.value) {
            .object => |o| if (o.get("session_id")) |v| switch (v) {
                .string => |s| s,
                else => "",
            } else "",
            else => "",
        };
        if (parent.len > 0 and !std.mem.eql(u8, parent, session)) return;
    };
    // Claude's background daemon inherits the environment of whichever pane
    // first spawned it, and so does a `claude -p` an agent runs from a tool.
    const origin: detection.HookOrigin = if (is_claude) detection.hookOrigin() else .{};
    const background = is_claude and (std.mem.eql(u8, os.env("CLAUDE_CODE_SESSION_KIND") orelse "", "bg") or origin.background);
    const body = try std.json.Stringify.valueAlloc(a, .{
        .op = "hook",
        .protocol = 2,
        .provider = provider,
        .event = parsed.value,
        .pane = pane,
        .seq = os.microTimestamp(),
        .background = background,
        .pid = origin.pid,
    }, .{});

    const dir = std.fs.path.dirname(socket) orelse ".";
    const backoff = try std.fmt.allocPrintSentinel(a, "{s}/hooks.backoff", .{dir}, 0);
    // A hook that recently found Corgi wedged skips it rather than slow the agent.
    const started = os.microTimestamp();
    if (backingOff(backoff, started)) return;
    const head = try std.fmt.allocPrint(a, "POST /rpc HTTP/1.1\r\nHost: corgi\r\nContent-Type: application/json\r\nContent-Length: {d}\r\nConnection: close\r\n\r\n", .{body.len});
    switch (deliver(socket, head, body, started)) {
        .delivered => _ = c.unlink(backoff.ptr),
        .absent => {},
        .timed_out => |stage| trouble(dir, backoff, provider, eventName(parsed.value), stage, started),
    }
}

/// How long a hook may hold up its agent: a daemon answers within `normal_us`,
/// and one that is reloading or starting, shown by its start lock, within `reload_us`.
const normal_us: i64 = 2 * std.time.us_per_s;
const reload_us: i64 = 3 * std.time.us_per_s;
/// How long hooks skip a daemon after one timed out.
const backoff_us: i64 = 30 * std.time.us_per_s;

const Stage = enum { connect, send, reply, reload };
const Outcome = union(enum) { delivered, absent, timed_out: Stage };
const Attempt = union(enum) { delivered, refused, timed_out: Stage };

/// Sends the event, waiting for the daemon's reply so it has the event before
/// the agent goes on. The daemon ignores a repeat by `seq`.
fn deliver(socket: []const u8, head: []const u8, body: []const u8, started: i64) Outcome {
    var rechecked = false;
    while (true) switch (attempt(socket, head, body, started)) {
        .delivered => return .delivered,
        .timed_out => |stage| return .{ .timed_out = if (starting(socket)) .reload else stage },
        // No daemon, or one that dropped the connection unanswered.
        .refused => {
            if (starting(socket)) {
                if (os.microTimestamp() >= started + reload_us) return .{ .timed_out = .reload };
                _ = c.usleep(50 * std.time.us_per_ms);
            } else if (rechecked) return .absent else rechecked = true; // A daemon may have started meanwhile.
        },
    };
}

fn attempt(socket: []const u8, head: []const u8, body: []const u8, started: i64) Attempt {
    const addr = os.unixAddress(socket) catch return .refused;
    const fd = os.unixSocket() catch return .refused;
    defer _ = c.close(fd);
    // Connecting to a daemon whose queue is full waits, on Linux; so does
    // sending more than its buffer holds.
    const deadline = started + if (starting(socket)) reload_us else normal_us;
    if (!limit(fd, c.SO_SNDTIMEO, deadline)) return .{ .timed_out = .connect };
    while (c.connect(fd, @ptrCast(&addr), @sizeOf(c.struct_sockaddr_un)) != 0) switch (std.posix.errno(-1)) {
        .INTR => {},
        .AGAIN, .TIMEDOUT => return .{ .timed_out = .connect },
        else => return .refused,
    };
    for ([_][]const u8{ head, body }) |bytes| switch (sendAll(fd, bytes, deadline)) {
        .done => {},
        .timed_out => return .{ .timed_out = .send },
        .failed => return .refused,
    };
    // A reloading daemon holds the request and answers once the new one has it.
    var buf: [4096]u8 = undefined;
    // Ok or an error reply means the daemon has the event; a full daemon's
    // 503 doesn't, and it's sent again while a reload holds the lock. The
    // status line may come in pieces.
    var status: [status_len]u8 = undefined;
    var have: usize = 0;
    while (true) {
        const reloading = starting(socket);
        if (!limit(fd, c.SO_RCVTIMEO, started + if (reloading) reload_us else normal_us)) return .{ .timed_out = if (reloading) .reload else .reply };
        const n = c.read(fd, &buf, buf.len);
        if (n > 0) {
            const part = @min(status.len - have, @as(usize, @intCast(n)));
            @memcpy(status[have..][0..part], buf[0..part]);
            have += part;
            continue;
        }
        if (n < 0) switch (std.posix.errno(n)) {
            .INTR => continue,
            .AGAIN => if (have < status.len) continue,
            else => {},
        };
        return if (have == status.len and taken(&status)) .delivered else .refused;
    }
}

/// A reply's start, through its status code.
const status_len = "HTTP/1.1 200 ".len;

/// Whether an HTTP reply says the daemon took the request.
fn taken(reply: []const u8) bool {
    return std.mem.startsWith(u8, reply, "HTTP/1.1 200 ") or std.mem.startsWith(u8, reply, "HTTP/1.1 400 ");
}

/// Sets `option` to the time left until `deadline`; false once none is left.
fn limit(fd: c_int, option: c_int, deadline: i64) bool {
    const left = deadline - os.microTimestamp();
    if (left <= 0) return false;
    // Zero would mean no limit at all.
    const timeout: c.struct_timeval = .{ .tv_sec = @intCast(@divTrunc(left, std.time.us_per_s)), .tv_usec = @intCast(@max(1, @rem(left, std.time.us_per_s))) };
    _ = c.setsockopt(fd, c.SOL_SOCKET, option, &timeout, @sizeOf(@TypeOf(timeout)));
    return true;
}

/// Whether a daemon holds `socket`'s start lock: it's starting or reloading.
/// The lock goes with the last process holding it, so a crash can't leave it.
fn starting(socket: []const u8) bool {
    const path = std.fmt.allocPrintSentinel(a, "{s}.start.lock", .{socket}, 0) catch return false;
    defer a.free(path);
    const fd = c.open(path.ptr, c.O_RDONLY | c.O_CLOEXEC);
    if (fd < 0) return false;
    defer _ = c.close(fd);
    if (c.flock(fd, c.LOCK_SH | c.LOCK_NB) != 0) return true;
    _ = c.flock(fd, c.LOCK_UN);
    return false;
}

/// What `hooks.backoff` holds: timeouts in a row since one got through, and
/// until when hooks skip the daemon.
const Backoff = struct { strikes: u32 = 0, until: i64 = 0 };

fn readBackoff(path: [:0]const u8) Backoff {
    const fd = c.open(path.ptr, c.O_RDONLY | c.O_CLOEXEC);
    if (fd < 0) return .{};
    defer _ = c.close(fd);
    return parseBackoff(fd);
}

fn parseBackoff(fd: c_int) Backoff {
    var buf: [64]u8 = undefined;
    const n = c.pread(fd, &buf, buf.len, 0);
    if (n <= 0) return .{};
    var words = std.mem.tokenizeAny(u8, buf[0..@intCast(n)], " \n");
    const strikes = std.fmt.parseInt(u32, words.next() orelse return .{}, 10) catch return .{};
    const until = std.fmt.parseInt(i64, words.next() orelse return .{}, 10) catch return .{};
    return .{ .strikes = strikes, .until = until };
}

/// Whether hooks are skipping the daemon.
fn backingOff(path: [:0]const u8, now: i64) bool {
    return now < readBackoff(path).until;
}

/// How long a hook waits for another to finish counting, which only reads
/// and writes a line; one stuck at it costs a count, not the agent's time.
const strike_wait_us: i64 = 100 * std.time.us_per_ms;

/// Counts a timeout in hooks.backoff; until when hooks skip the daemon, or 0.
/// Hooks that time out together each count, one at a time.
fn strike(path: [:0]const u8, now: i64) i64 {
    const fd = c.open(path.ptr, c.O_RDWR | c.O_CREAT | c.O_CLOEXEC, @as(c_uint, 0o600));
    if (fd < 0) return 0;
    // Closing lets go of the lock.
    defer _ = c.close(fd);
    while (c.flock(fd, c.LOCK_EX | c.LOCK_NB) != 0) {
        if (os.microTimestamp() >= now + strike_wait_us) return 0;
        _ = c.usleep(std.time.us_per_ms);
    }
    const strikes = parseBackoff(fd).strikes + 1;
    const until = if (strikes >= 2) now + backoff_us else 0;
    var buf: [64]u8 = undefined;
    const state = std.fmt.bufPrint(&buf, "{d} {d}\n", .{ strikes, until }) catch return until;
    // Written over the old state, then cut to length: readers take only its first two words.
    _ = c.pwrite(fd, state.ptr, state.len, 0);
    _ = c.ftruncate(fd, @intCast(state.len));
    return until;
}

/// Notes in hooks.log, beside server.log, that the daemon didn't answer in
/// time. The second time in a row, hooks skip it for a while.
fn trouble(dir: []const u8, backoff: [:0]const u8, provider: []const u8, event: []const u8, stage: Stage, started: i64) void {
    const now = os.microTimestamp();
    const until = strike(backoff, now);
    const log = std.fmt.allocPrintSentinel(a, "{s}/hooks.log", .{dir}, 0) catch return;
    if (size(log) > 256 * 1024) {
        const old = std.fmt.allocPrintSentinel(a, "{s}.1", .{log}, 0) catch return;
        _ = std.c.rename(log.ptr, old.ptr);
    }
    const what = switch (stage) {
        .connect => "connecting timed out",
        .send => "sending timed out",
        .reply => "no reply",
        .reload => "the reload or start didn't finish",
    };
    const seconds: u64 = @intCast(@divTrunc(now, std.time.us_per_s));
    const day = (std.time.epoch.EpochSeconds{ .secs = seconds }).getEpochDay();
    const year_day = day.calculateYearDay();
    const month_day = year_day.calculateMonthDay();
    const time = (std.time.epoch.EpochSeconds{ .secs = seconds }).getDaySeconds();
    const then = if (until > 0) std.fmt.allocPrint(a, "hooks skip Corgi for {d} s", .{@divTrunc(backoff_us, std.time.us_per_s)}) catch return else "hooks keep trying";
    const line = std.fmt.allocPrint(a, "{d:0>4}-{d:0>2}-{d:0>2}T{d:0>2}:{d:0>2}:{d:0>2}Z pid {d}: {s} {s}: {s} after {d} ms; {s}\n", .{
        year_day.year,          month_day.month.numeric(),                    month_day.day_index + 1,
        time.getHoursIntoDay(), time.getMinutesIntoHour(),                    time.getSecondsIntoMinute(),
        c.getpid(),             provider,                                     event,
        what,                   @divTrunc(now - started, std.time.us_per_ms), then,
    }) catch return;
    const fd = c.open(log.ptr, c.O_WRONLY | c.O_APPEND | c.O_CREAT | c.O_CLOEXEC, @as(c_uint, 0o600));
    if (fd >= 0) {
        _ = c.write(fd, line.ptr, line.len);
        _ = c.close(fd);
    }
}

/// The size of the file at `path`; 0 if there's none.
fn size(path: [:0]const u8) i64 {
    const fd = c.open(path.ptr, c.O_RDONLY | c.O_CLOEXEC);
    if (fd < 0) return 0;
    defer _ = c.close(fd);
    return @max(0, c.lseek(fd, 0, c.SEEK_END));
}

/// The provider's name for the hook, as Claude and Codex send it.
fn eventName(event: std.json.Value) []const u8 {
    const object = switch (event) {
        .object => |o| o,
        else => return "event",
    };
    return switch (object.get("hook_event_name") orelse return "event") {
        .string => |s| s,
        else => "event",
    };
}

const Sent = enum { done, timed_out, failed };
/// Writes `bytes` by `deadline`: a daemon that reads slowly takes each part
/// within what time is left, not a fresh timeout.
fn sendAll(fd: c_int, bytes: []const u8, deadline: i64) Sent {
    var rest = bytes;
    while (rest.len > 0) {
        if (!limit(fd, c.SO_SNDTIMEO, deadline)) return .timed_out;
        const n = c.write(fd, rest.ptr, rest.len);
        if (n < 0) switch (std.posix.errno(n)) {
            .INTR => continue,
            .AGAIN => return .timed_out,
            else => return .failed,
        };
        rest = rest[@intCast(n)..];
    }
    return .done;
}
