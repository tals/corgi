//! Herdr-style background refresh: checkout deduplication, negative caching,
//! and immutable ref fingerprints so unchanged histories are never recounted.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const PushRef = @import("git_push.zig").Ref;
pub const Commit = struct {
    hash: [12]u8 = @splat(0),
    hash_len: u8 = 0,
    subject: [240]u8 = @splat(0),
    subject_len: u16 = 0,
    author: [80]u8 = @splat(0),
    author_len: u8 = 0,
    timestamp: i64 = 0,
    date: [16]u8 = @splat(0),
    date_len: u8 = 0,
};
pub const Commits = struct {
    items: [12]Commit = @splat(.{}),
    len: u8 = 0,
};
// Commit metadata is untrusted terminal text. Keep valid UTF-8 and remove controls.
pub fn clean(dest: []u8, source: []const u8) usize {
    var used: usize = 0;
    var rest = source;
    while (rest.len > 0) {
        const n = std.unicode.utf8ByteSequenceLength(rest[0]) catch 1;
        const cp = if (n <= rest.len) std.unicode.utf8Decode(rest[0..n]) catch 0 else 0;
        const valid = cp >= 32 and !(cp >= 127 and cp <= 159);
        const size = if (valid) n else 1;
        if (used + size > dest.len) break;
        if (valid) @memcpy(dest[used..][0..size], rest[0..size]) else dest[used] = ' ';
        used += size;
        rest = rest[@min(n, rest.len)..];
    }
    return used;
}
fn parseCommits(raw: []const u8) Commits {
    var result: Commits = .{};
    var fields = std.mem.splitScalar(u8, raw, 0);
    while (result.len < result.items.len) {
        const hash = fields.next() orelse break;
        const author = fields.next() orelse break;
        const date = fields.next() orelse break;
        const timestamp = fields.next() orelse break;
        const subject = fields.next() orelse break;
        const item = &result.items[result.len];
        item.hash_len = @intCast(clean(&item.hash, std.mem.trim(u8, hash, "\r\n")));
        item.author_len = @intCast(clean(&item.author, author));
        item.timestamp = std.fmt.parseInt(i64, timestamp, 10) catch 0;
        item.date_len = @intCast(clean(&item.date, date));
        item.subject_len = @intCast(clean(&item.subject, subject));
        result.len += 1;
    }
    return result;
}
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;

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
    const Job = struct { id: WorkspaceId, cwd: []const u8, ahead: ?u64 = null, commits: Commits = .{}, ref: PushRef = .{} };
    const Cache = struct { refs: []const u8, ahead: ?u64, seen: i64, commits: Commits = .{}, ref: PushRef = .{} };

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
    /// A scan is running or its result has not been applied yet.
    pub fn busy(t: *const Tracker) bool {
        return t.thread != null;
    }
    pub fn tick(t: *Tracker, store: *workspace.Store) bool {
        var changed = false;
        if (t.thread) |thread| {
            if (!t.done.load(.acquire)) return false;
            thread.join();
            t.thread = null;
            for (t.jobs.items) |job| {
                const ws = store.get(job.id) orelse continue;
                if (!std.mem.eql(u8, ws.cwd, job.cwd)) continue;
                changed = changed or ws.git_ahead != job.ahead;
                changed = changed or !std.meta.eql(ws.git_ref, job.ref);
                if (!ws.git_ref.view().sameBranch(job.ref.view())) ws.git_push = .{};
                if (!std.meta.eql(ws.git_ref, job.ref) and ws.git_push.phase == .failed) ws.git_push = .{};
                ws.git_ref = job.ref;
                changed = changed or !std.meta.eql(ws.git_commits, job.commits);
                ws.git_ahead = job.ahead;
                ws.git_commits = job.commits;
            }
            t.clearJobs();
        }
        const now = @import("clock.zig").milliTimestamp();
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
        const now = @import("clock.zig").milliTimestamp();
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
            job.ahead = t.refreshInto(job.cwd, now, &job.commits, &job.ref) catch null;
        }
    }
    fn refresh(t: *Tracker, cwd: []const u8, now: i64) !?u64 {
        var commits: Commits = .{};
        var ref: PushRef = .{};
        return t.refreshInto(cwd, now, &commits, &ref);
    }
    fn cachedResult(cached: Cache, commits: *Commits, ref: *PushRef) ?u64 {
        commits.* = cached.commits;
        ref.* = cached.ref;
        return cached.ahead;
    }
    fn refreshInto(t: *Tracker, cwd: []const u8, now: i64, commits: *Commits, ref: *PushRef) !?u64 {
        commits.* = .{};
        ref.* = .{};
        if (t.cache.get(cwd)) |cached| {
            if (cached.refs.len == 0 and now - cached.seen < 30000) return cachedResult(cached, commits, ref);
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
            if (cached.seen == now or (cached.refs.len == 0 and now - cached.seen < 30000)) return cachedResult(cached, commits, ref);
        }
        const refs = command(root, &.{ "rev-parse", "--verify", "HEAD" }) orelse return t.save(key, "", null, now);
        defer a.free(refs);
        const branch = command(root, &.{ "symbolic-ref", "--quiet", "HEAD" }) orelse return t.save(key, refs, null, now);
        defer a.free(branch);
        const tracking = command(root, &.{ "for-each-ref", "--format=%(upstream:remotename)%00%(upstream:remoteref)", branch }) orelse return t.save(key, refs, null, now);
        defer a.free(tracking);
        var fields = std.mem.splitScalar(u8, tracking, 0);
        const remote = fields.next() orelse "";
        const destination = fields.next() orelse "";
        ref.* = PushRef.init(key, refs, branch, remote, destination);
        const upstream = command(root, &.{ "rev-parse", "--verify", "@{upstream}" }) orelse return t.save(key, refs, null, now);
        defer a.free(upstream);
        const fingerprint = try std.fmt.allocPrint(a, "{s}..{s}", .{ upstream, refs });
        defer a.free(fingerprint);
        if (t.cache.getPtr(key)) |cached| {
            if (std.mem.eql(u8, cached.refs, fingerprint) and cached.ahead != null) {
                cached.seen = now;
                cached.ref = ref.*;
                return cachedResult(cached.*, commits, ref);
            }
        }
        const count = command(root, &.{ "rev-list", "--count", fingerprint }) orelse return t.save(key, fingerprint, null, now);
        defer a.free(count);
        const ahead = std.fmt.parseInt(u64, count, 10) catch null;
        if (ahead != null and ahead.? > 0) {
            if (command(root, &.{ "log", "--no-show-signature", "--no-decorate", "--encoding=UTF-8", "--date=format:%Y-%m-%d %H:%M", "--format=%h%x00%an%x00%ad%x00%at%x00%s%x00", "-12", fingerprint, "--" })) |log| {
                defer a.free(log);
                commits.* = parseCommits(log);
            }
        }
        const saved = try t.save(key, fingerprint, ahead, now);
        t.cache.getPtr(key).?.commits = commits.*;
        t.cache.getPtr(key).?.ref = ref.*;
        return saved;
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
    var buf: [65536]u8 = undefined;
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
    try std.testing.expectEqual(@as(u8, 1), tracker.cache.get(root).?.commits.len);
    const commit = tracker.cache.get(root).?.commits.items[0];
    try std.testing.expectEqualStrings("ahead", commit.subject[0..commit.subject_len]);
    try std.testing.expectEqualStrings("Corgi Test", commit.author[0..commit.author_len]);
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
    try std.testing.expect(store.get(id).?.git_ahead == null);
}

test "commit metadata strips terminal controls and preserves Unicode" {
    const commits = parseCommits("abc1234\x00Zoë\x00" ++ "2026-09-23 08:30\x001790166600\x00fix 日本語\x1b[31m\x00\n");
    try std.testing.expectEqual(@as(u8, 1), commits.len);
    const item = commits.items[0];
    try std.testing.expectEqualStrings("Zoë", item.author[0..item.author_len]);
    try std.testing.expectEqualStrings("fix 日本語 [31m", item.subject[0..item.subject_len]);
}
