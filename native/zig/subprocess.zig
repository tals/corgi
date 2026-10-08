//! Bounded child processes for workers. A run waits in one poll on the
//! child's pipes, its exit and the caller's `Quit`, so nothing wakes on a
//! timer. The child leads its own process group: a deadline or a quit kills
//! the group, while a child that exits leaves what it started running, such
//! as git's fsmonitor daemon. Runs reap their own pids.
const std = @import("std");
const builtin = @import("builtin");
const posix = std.posix;
const os = @import("os.zig");
const c = os.c;

pub const Term = std.process.Child.Term;
pub const Options = struct {
    cwd: ?[]const u8 = null,
    env: ?*const std.process.Environ.Map = null,
    /// Written to stdin before any output is read, then closed; it must fit
    /// in a pipe.
    input: ?[]const u8 = null,
    timeout_ms: u32,
    /// Stdout past this fails the run; stderr keeps its last `max_output` bytes.
    max_output: usize = 64 * 1024,
    stderr: bool = false,
    /// Once signalled, the run kills its child and returns `error.Cancelled`.
    quit: ?*const Quit = null,
};
pub const Output = struct {
    term: Term,
    stdout: []u8,
    stderr: []u8,

    pub fn ok(o: Output) bool {
        return o.term == .exited and o.term.exited == 0;
    }
    pub fn deinit(o: Output, alloc: std.mem.Allocator) void {
        alloc.free(o.stdout);
        alloc.free(o.stderr);
    }
};
pub const Error = std.process.SpawnError || posix.PollError || posix.ReadError ||
    error{ TimedOut, Cancelled, OutputTooLarge, NoChildProcess, SystemResources };

/// A worker's quit pipe, like Ghostty's reader thread has. `signal` from any
/// thread ends the run in flight and every later run given this `Quit`;
/// nothing drains it.
pub const Quit = struct {
    /// -1 until `init`; poll skips a negative fd.
    read: posix.fd_t = -1,
    write: posix.fd_t = -1,

    pub fn init() error{SystemResources}!Quit {
        var fds: [2]c_int = undefined;
        if (c.pipe(&fds) != 0) return error.SystemResources;
        for (fds) |fd| {
            os.cloexec(fd);
            os.nonblock(fd);
        }
        return .{ .read = fds[0], .write = fds[1] };
    }
    pub fn deinit(q: Quit) void {
        _ = c.close(q.read);
        _ = c.close(q.write);
    }
    pub fn signal(q: Quit) void {
        _ = c.write(q.write, "x", 1);
    }
};

pub fn run(alloc: std.mem.Allocator, argv: []const []const u8, opts: Options) Error!Output {
    if (opts.quit) |quit| {
        var fds = [1]posix.pollfd{pollIn(quit.read)};
        if (try posix.poll(&fds, 0) > 0) return error.Cancelled;
    }
    const timer: os.Timer = .start();
    const limit = @as(u64, opts.timeout_ms) * std.time.ns_per_ms;
    var child = try std.process.spawn(os.io(), .{
        .argv = argv,
        .cwd = if (opts.cwd) |dir| .{ .path = dir } else .inherit,
        .environ_map = opts.env,
        .stdin = if (opts.input != null) .pipe else .ignore,
        .stdout = .pipe,
        .stderr = if (opts.stderr) .pipe else .ignore,
        .pgid = 0,
    });
    const pid = child.id.?;
    var reaped = false;
    defer {
        if (!reaped) {
            _ = c.kill(-pid, c.SIGKILL);
            _ = reap(pid) catch 0;
        }
        inline for (.{ &child.stdin, &child.stdout, &child.stderr }) |pipe| if (pipe.*) |file| file.close(os.io());
    }
    const exit_fd = try exitFd(pid);
    defer if (exit_fd) |fd| {
        _ = c.close(fd);
    };
    if (opts.input) |input| {
        // The child may exit or close stdin without reading it all.
        os.writeAll(child.stdin.?.handle, input) catch {};
        child.stdin.?.close(os.io());
        child.stdin = null;
    }
    var fds = [4]posix.pollfd{
        pollIn(child.stdout.?.handle),
        pollIn(if (child.stderr) |file| file.handle else null),
        pollIn(exit_fd),
        pollIn(if (opts.quit) |quit| quit.read else null),
    };
    for (fds[0..2]) |p| if (p.fd >= 0) os.nonblock(p.fd);
    var out: std.ArrayList(u8) = .empty;
    defer out.deinit(alloc);
    var err: std.ArrayList(u8) = .empty;
    defer err.deinit(alloc);
    // No exit fd: the child exited before one could watch it.
    while (exit_fd != null) {
        const elapsed = timer.read();
        if (elapsed >= limit) return error.TimedOut;
        const left_ms = (limit - elapsed + std.time.ns_per_ms - 1) / std.time.ns_per_ms;
        _ = try posix.poll(&fds, std.math.lossyCast(i32, left_ms));
        if (fds[3].revents != 0) return error.Cancelled;
        try collect(alloc, &fds, &out, &err, opts.max_output);
        if (fds[2].revents != 0) break;
    }
    reaped = true;
    const status = try reap(pid);
    // What the child wrote just before it exited is still in the pipes.
    try collect(alloc, &fds, &out, &err, opts.max_output);
    const stdout = try out.toOwnedSlice(alloc);
    errdefer alloc.free(stdout);
    return .{ .term = std.Io.Threaded.statusToTerm(status), .stdout = stdout, .stderr = try err.toOwnedSlice(alloc) };
}

fn pollIn(fd: ?posix.fd_t) posix.pollfd {
    return .{ .fd = fd orelse -1, .events = posix.POLL.IN, .revents = 0 };
}
/// An fd that turns readable once `pid` exits: a pidfd on Linux, a kqueue
/// watching for its exit on macOS. Null when it has exited already.
fn exitFd(pid: posix.pid_t) error{SystemResources}!?posix.fd_t {
    switch (builtin.os.tag) {
        .linux => {
            const rc = std.os.linux.pidfd_open(pid, 0);
            if (std.os.linux.errno(rc) != .SUCCESS) return error.SystemResources;
            return @intCast(rc);
        },
        .macos => {
            const kq = std.c.kqueue();
            if (kq < 0) return error.SystemResources;
            const changes = [1]std.c.Kevent{.{
                .ident = @intCast(pid),
                .filter = std.c.EVFILT.PROC,
                .flags = std.c.EV.ADD | std.c.EV.ONESHOT,
                .fflags = std.c.NOTE.EXIT,
                .data = 0,
                .udata = 0,
            }};
            var events: [1]std.c.Kevent = undefined;
            switch (posix.errno(std.c.kevent(kq, &changes, 1, &events, 0, null))) {
                .SUCCESS => return kq,
                // A child that has exited can no longer be watched.
                .SRCH => {
                    _ = c.close(kq);
                    return null;
                },
                else => {
                    _ = c.close(kq);
                    return error.SystemResources;
                },
            }
        },
        else => @compileError("unsupported platform"),
    }
}
/// The wait status of `pid`, which has exited or been killed.
fn reap(pid: posix.pid_t) error{NoChildProcess}!u32 {
    var status: c_int = 0;
    while (true) switch (posix.errno(c.waitpid(pid, &status, 0))) {
        .SUCCESS => return @bitCast(status),
        .INTR => continue,
        else => return error.NoChildProcess,
    };
}
/// Reads what both pipes hold. Stdout past `max` fails the run; stderr keeps
/// its last `max` bytes.
fn collect(alloc: std.mem.Allocator, fds: *[4]posix.pollfd, out: *std.ArrayList(u8), err: *std.ArrayList(u8), max: usize) Error!void {
    try drain(alloc, &fds[0], out);
    if (out.items.len > max) return error.OutputTooLarge;
    try drain(alloc, &fds[1], err);
    if (err.items.len > max) {
        const extra = err.items.len - max;
        std.mem.copyForwards(u8, err.items[0..max], err.items[extra..]);
        err.shrinkRetainingCapacity(max);
    }
}
/// Reads what the pipe holds without blocking; the fd becomes -1 at end of
/// file. A few reads at most, so a child that writes without end cannot keep
/// the run from its deadline or its quit.
fn drain(alloc: std.mem.Allocator, p: *posix.pollfd, into: *std.ArrayList(u8)) Error!void {
    if (p.fd < 0) return;
    var buf: [16384]u8 = undefined;
    for (0..16) |_| {
        const n = posix.read(p.fd, &buf) catch |err| switch (err) {
            error.WouldBlock => return,
            else => |e| return e,
        };
        if (n == 0) {
            p.fd = -1;
            return;
        }
        try into.appendSlice(alloc, buf[0..n]);
    }
}

const testing = std.testing;
fn sh(script: []const u8, opts: Options) Error!Output {
    return run(testing.allocator, &.{ "/bin/sh", "-c", script }, opts);
}
fn parsePid(text: []const u8) !posix.pid_t {
    return std.fmt.parseInt(posix.pid_t, std.mem.trim(u8, text, "\n"), 10);
}
/// A background child the group kill ended; its new parent reaps it soon.
fn expectKilled(pid: posix.pid_t) !void {
    for (0..200) |_| {
        if (c.kill(pid, 0) != 0) return;
        os.sleep(10 * std.time.ns_per_ms);
    }
    return error.BackgroundChildSurvived;
}

test "exit codes and signals come back as terms" {
    const done = try sh("printf done", .{ .timeout_ms = 5000 });
    defer done.deinit(testing.allocator);
    try testing.expect(done.ok());
    try testing.expectEqualStrings("done", done.stdout);
    const failed = try sh("exit 3", .{ .timeout_ms = 5000 });
    defer failed.deinit(testing.allocator);
    try testing.expect(!failed.ok());
    try testing.expectEqual(Term{ .exited = 3 }, failed.term);
    const killed = try sh("kill -9 $$", .{ .timeout_ms = 5000 });
    defer killed.deinit(testing.allocator);
    try testing.expectEqual(Term{ .signal = .KILL }, killed.term);
    try testing.expectError(error.FileNotFound, run(testing.allocator, &.{"/nonexistent/corgi-test"}, .{ .timeout_ms = 5000 }));
    const root = try run(testing.allocator, &.{"pwd"}, .{ .timeout_ms = 5000, .cwd = "/" });
    defer root.deinit(testing.allocator);
    try testing.expectEqualStrings("/\n", root.stdout);
}

test "exit, not the end of the output, ends a run" {
    // Closing stdout early is not an exit.
    const closed = try sh("exec >&-; sleep 0.2; exit 4", .{ .timeout_ms = 5000 });
    defer closed.deinit(testing.allocator);
    try testing.expectEqual(Term{ .exited = 4 }, closed.term);
    // A background child holding stdout open does not hold up the run.
    const timer: os.Timer = .start();
    const held = try sh("sleep 2 & printf done", .{ .timeout_ms = 5000 });
    defer held.deinit(testing.allocator);
    try testing.expectEqualStrings("done", held.stdout);
    try testing.expect(timer.read() < std.time.ns_per_s);
}

test "the deadline kills the whole group" {
    var tmp = testing.tmpDir(.{});
    defer tmp.cleanup();
    const dir = try os.realpathAlloc(testing.allocator, tmp.dir, ".");
    defer testing.allocator.free(dir);
    const timer: os.Timer = .start();
    // The background sleep holds no pipe: only the group kill ends it.
    try testing.expectError(error.TimedOut, sh("sleep 5 >/dev/null & echo $! > pid; sleep 5", .{ .timeout_ms = 500, .cwd = dir }));
    try testing.expect(timer.read() < 2 * std.time.ns_per_s);
    var buf: [32]u8 = undefined;
    try expectKilled(try parsePid(try tmp.dir.readFile(os.io(), "pid", &buf)));
}

test "a child that exits leaves what it started running" {
    // Such as git's fsmonitor daemon, which stays in git's process group.
    const out = try sh("sleep 5 >/dev/null & echo $!", .{ .timeout_ms = 5000 });
    defer out.deinit(testing.allocator);
    const pid = try parsePid(out.stdout);
    defer _ = c.kill(pid, c.SIGKILL);
    try testing.expectEqual(0, c.kill(pid, 0));
}

test "a quit ends the run in flight and every later run" {
    const quit: Quit = try .init();
    defer quit.deinit();
    const stopper = try std.Thread.spawn(.{}, struct {
        fn stop(q: Quit) void {
            os.sleep(50 * std.time.ns_per_ms);
            q.signal();
        }
    }.stop, .{quit});
    defer stopper.join();
    const timer: os.Timer = .start();
    try testing.expectError(error.Cancelled, sh("sleep 5", .{ .timeout_ms = 5000, .quit = &quit }));
    try testing.expect(timer.read() < 2 * std.time.ns_per_s);
    try testing.expectError(error.Cancelled, sh("printf late", .{ .timeout_ms = 5000, .quit = &quit }));
}

test "stdout past the cap fails, stderr keeps its tail" {
    try testing.expectError(error.OutputTooLarge, sh("yes", .{ .timeout_ms = 5000, .max_output = 1000 }));
    const out = try sh("printf out; yes err | head -c 5000 >&2; printf last >&2", .{ .timeout_ms = 5000, .max_output = 64, .stderr = true });
    defer out.deinit(testing.allocator);
    try testing.expectEqualStrings("out", out.stdout);
    try testing.expectEqual(64, out.stderr.len);
    try testing.expect(std.mem.endsWith(u8, out.stderr, "err\nlast"));
}

test "output written just before exit is kept, past a full pipe" {
    const out = try sh("head -c 300000 /dev/zero | tr '\\000' x; printf end", .{ .timeout_ms = 5000, .max_output = 1 << 20 });
    defer out.deinit(testing.allocator);
    try testing.expect(out.ok());
    try testing.expectEqual(300003, out.stdout.len);
    try testing.expect(std.mem.endsWith(u8, out.stdout, "xend"));
}

test "input reaches the child" {
    const out = try run(testing.allocator, &.{"cat"}, .{ .timeout_ms = 5000, .input = "Accept: application/json\n" });
    defer out.deinit(testing.allocator);
    try testing.expectEqualStrings("Accept: application/json\n", out.stdout);
}
