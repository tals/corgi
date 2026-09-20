//! Herdr-style background refresh: checkout deduplication, negative caching,
//! and immutable ref fingerprints so unchanged histories are never recounted.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const workspace = @import("workspace.zig");

// The server's general reaper may collect a Git child before its worker does.
pub var child_mutex: std.Thread.Mutex = .{};
var child_pid: c_int = 0;
var child_status: ?c_int = null;
pub fn recordExit(pid: c_int, status: c_int) void {
    if (pid == child_pid) child_status = status;
}

pub const Tracker = struct {
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
    next_refresh: i64 = 0,
    jobs: std.ArrayList(Job) = .empty,
    cache: std.StringHashMapUnmanaged(Cache) = .empty,
    const Job = struct { id: u32, cwd: []const u8, ahead: ?u64 = null };
    const Cache = struct { refs: []const u8, ahead: ?u64, seen: i64 };

    pub fn deinit(t: *Tracker) void {
        t.stopping.store(true, .release);
        if (t.thread) |thread| thread.join();
        t.clearJobs();
        t.jobs.deinit(a);
        var it = t.cache.iterator();
        while (it.next()) |entry| {
            a.free(entry.key_ptr.*);
            a.free(entry.value_ptr.refs);
        }
        t.cache.deinit(a);
    }
    fn clearJobs(t: *Tracker) void {
        for (t.jobs.items) |job| a.free(job.cwd);
        t.jobs.clearRetainingCapacity();
    }
    pub fn tick(t: *Tracker, store: *workspace.Store) bool {
        var changed = false;
        if (t.thread) |thread| {
            if (!t.done.load(.acquire)) return false;
            thread.join();
            t.thread = null;
            for (t.jobs.items) |job| {
                const i = store.index(job.id) orelse continue;
                const ws = &store.items.items[i];
                if (!std.mem.eql(u8, ws.cwd, job.cwd)) continue;
                changed = changed or ws.git_ahead != job.ahead;
                ws.git_ahead = job.ahead;
            }
            t.clearJobs();
        }
        const now = std.time.milliTimestamp();
        if (now < t.next_refresh) return changed;
        t.next_refresh = now + 3000;
        for (store.items.items) |ws| {
            const cwd = a.dupe(u8, ws.cwd) catch break;
            t.jobs.append(a, .{ .id = ws.id, .cwd = cwd }) catch {
                a.free(cwd);
                break;
            };
        }
        t.done.store(false, .release);
        t.thread = std.Thread.spawn(.{}, run, .{t}) catch blk: {
            t.clearJobs();
            break :blk null;
        };
        return changed;
    }
    fn run(t: *Tracker) void {
        defer t.done.store(true, .release);
        // Evict unused checkouts and negative entries to keep a long-lived server bounded.
        const now = std.time.milliTimestamp();
        while (true) {
            var it = t.cache.iterator();
            const key = while (it.next()) |entry| {
                if (now - entry.value_ptr.seen > 60000) break entry.key_ptr.*;
            } else break;
            const removed = t.cache.fetchRemove(key).?;
            a.free(removed.key);
            a.free(removed.value.refs);
        }
        for (t.jobs.items) |*job| {
            if (t.stopping.load(.acquire)) break;
            job.ahead = t.refresh(job.cwd, now) catch null;
        }
    }
    fn refresh(t: *Tracker, cwd: []const u8, now: i64) !?u64 {
        if (t.cache.get(cwd)) |cached| {
            if (cached.refs.len == 0 and now - cached.seen < 30000) return cached.ahead;
        }
        // A filesystem walk is cheap and recognizes linked worktrees (.git files).
        // Let Git resolve the actual refs/config, including includes and reftables.
        var root: []const u8 = cwd;
        while (true) {
            const marker = try std.fs.path.join(a, &.{ root, ".git" });
            defer a.free(marker);
            if (std.fs.cwd().access(marker, .{})) |_| break else |_| {}
            root = std.fs.path.dirname(root) orelse return t.save(cwd, "", null, now);
        }
        const key = try std.fs.cwd().realpathAlloc(a, root);
        defer a.free(key);
        if (t.cache.get(key)) |cached| {
            if (cached.seen == now or (cached.refs.len == 0 and now - cached.seen < 30000)) return cached.ahead;
        }
        const refs = command(root, &.{ "rev-parse", "--verify", "HEAD" }) orelse return t.save(key, "", null, now);
        defer a.free(refs);
        const upstream = command(root, &.{ "rev-parse", "--verify", "@{upstream}" }) orelse return t.save(key, refs, null, now);
        defer a.free(upstream);
        const fingerprint = try std.fmt.allocPrint(a, "{s}..{s}", .{ upstream, refs });
        defer a.free(fingerprint);
        if (t.cache.getPtr(key)) |cached| {
            if (std.mem.eql(u8, cached.refs, fingerprint) and cached.ahead != null) {
                cached.seen = now;
                return cached.ahead;
            }
        }
        const count = command(root, &.{ "rev-list", "--count", fingerprint }) orelse return t.save(key, fingerprint, null, now);
        defer a.free(count);
        return t.save(key, fingerprint, std.fmt.parseInt(u64, count, 10) catch null, now);
    }
    fn save(t: *Tracker, key: []const u8, refs: []const u8, ahead: ?u64, now: i64) !?u64 {
        const copy = try a.dupe(u8, refs);
        errdefer a.free(copy);
        const owned_key = try a.dupe(u8, key);
        errdefer a.free(owned_key);
        const entry = try t.cache.getOrPut(a, owned_key);
        if (entry.found_existing) {
            a.free(owned_key);
            a.free(entry.value_ptr.refs);
        }
        entry.value_ptr.* = .{ .refs = copy, .ahead = ahead, .seen = now };
        return ahead;
    }
};

// No shell, network fetch, index scan, or unbounded child wait. A slow checkout
// cannot freeze input; wrappers and their descendants get a two-second deadline.
fn command(cwd: []const u8, args: []const []const u8) ?[]const u8 {
    var argv: std.ArrayList([]const u8) = .empty;
    defer argv.deinit(a);
    argv.appendSlice(a, &.{ "git", "--no-optional-locks", "-C", cwd }) catch return null;
    argv.appendSlice(a, args) catch return null;
    var child = std.process.Child.init(argv.items, a);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    child_mutex.lock();
    child.spawn() catch {
        child_mutex.unlock();
        return null;
    };
    child_pid = child.id;
    child_status = null;
    child_mutex.unlock();
    var reaped = false;
    defer {
        child_mutex.lock();
        defer child_mutex.unlock();
        if (!reaped and child_status == null) {
            _ = c.kill(-child.id, c.SIGKILL);
            var status: c_int = 0;
            _ = c.waitpid(child.id, &status, 0);
        }
        child_pid = 0;
        child_status = null;
        if (child.stdout) |file| file.close();
    }
    child.waitForSpawn() catch return null;
    const fd = child.stdout.?.handle;
    os.nonblock(fd);
    var buf: [4096]u8 = undefined;
    var len: usize = 0;
    var timer = std.time.Timer.start() catch return null;
    while (timer.read() < 2 * std.time.ns_per_s) {
        if (len == buf.len) return null;
        const n = c.read(fd, buf[len..].ptr, buf.len - len);
        if (n > 0) len += @intCast(n);
        var status: c_int = 0;
        child_mutex.lock();
        const exited = if (child_status) |saved| blk: {
            status = saved;
            break :blk true;
        } else c.waitpid(child.id, &status, c.WNOHANG) == child.id;
        child_mutex.unlock();
        if (exited) {
            reaped = true;
            if (status != 0) return null;
            if (len < buf.len) {
                const tail = c.read(fd, buf[len..].ptr, buf.len - len);
                if (tail > 0) len += @intCast(tail);
            }
            if (len == buf.len) return null;
            return a.dupe(u8, std.mem.trim(u8, buf[0..len], " \t\r\n")) catch null;
        }
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return null;
}

fn testGit(cwd: []const u8, args: []const []const u8) !void {
    const result = command(cwd, args) orelse return error.GitFailed;
    a.free(result);
}

test "upstream counts follow commits and packed refs, deduplicate subdirectories and isolate worktrees" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(root);
    try testGit(root, &.{ "init", "-b", "main" });
    try testGit(root, &.{ "config", "user.name", "Corgi Test" });
    try testGit(root, &.{ "config", "user.email", "test@example.invalid" });
    try testGit(root, &.{ "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "base" });
    try testGit(root, &.{ "branch", "upstream" });
    try testGit(root, &.{ "branch", "--set-upstream-to=upstream" });
    var tracker: Tracker = .{};
    defer tracker.deinit();
    try std.testing.expectEqual(@as(?u64, 0), try tracker.refresh(root, 1000));
    try testGit(root, &.{ "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "ahead" });
    try std.testing.expectEqual(@as(?u64, 1), try tracker.refresh(root, 4000));
    try testGit(root, &.{ "pack-refs", "--all", "--prune" });
    try std.testing.expectEqual(@as(?u64, 1), try tracker.refresh(root, 7000));
    // A sentinel proves the unchanged-ref path reuses the cached count.
    tracker.cache.getPtr(root).?.ahead = 42;
    try std.testing.expectEqual(@as(?u64, 42), try tracker.refresh(root, 10000));
    try tmp.dir.makeDir("nested");
    const nested = try std.fs.path.join(a, &.{ root, "nested" });
    defer a.free(nested);
    try std.testing.expectEqual(@as(?u64, 42), try tracker.refresh(nested, 10000));
    try std.testing.expectEqual(@as(u32, 1), tracker.cache.count());
    try testGit(root, &.{ "worktree", "add", "-b", "other", "linked", "upstream" });
    const linked = try std.fs.path.join(a, &.{ root, "linked" });
    defer a.free(linked);
    try testGit(linked, &.{ "branch", "--set-upstream-to=upstream" });
    try std.testing.expectEqual(@as(?u64, 0), try tracker.refresh(linked, 13000));
    try testGit(root, &.{ "branch", "-f", "upstream", "HEAD" });
    try std.testing.expectEqual(@as(?u64, 0), try tracker.refresh(root, 16000));
    try testGit(root, &.{ "branch", "--unset-upstream" });
    try std.testing.expectEqual(@as(?u64, null), try tracker.refresh(root, 19000));
    try testGit(root, &.{ "checkout", "--detach" });
    try std.testing.expectEqual(@as(?u64, null), try tracker.refresh(root, 50000));
}

test "background result cannot follow a workspace into a different directory" {
    var store: workspace.Store = .{};
    defer store.deinit();
    const id = try store.add("", ".");
    var tracker: Tracker = .{};
    defer tracker.deinit();
    try tracker.jobs.append(a, .{ .id = id, .cwd = try a.dupe(u8, "/old"), .ahead = 8 });
    tracker.thread = try std.Thread.spawn(.{}, struct {
        fn finish(t: *Tracker) void {
            t.done.store(true, .release);
        }
    }.finish, .{&tracker});
    while (!tracker.done.load(.acquire)) std.Thread.sleep(std.time.ns_per_ms);
    tracker.next_refresh = std.math.maxInt(i64);
    try std.testing.expect(!tracker.tick(&store));
    try std.testing.expectEqual(@as(?u64, null), store.current().git_ahead);
}
