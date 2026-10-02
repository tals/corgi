//! Conversations a launcher can resume: Claude transcripts and Codex threads
//! that hold a prompt, newest first. The launcher preview worker reads them on
//! request; viewers filter them, so typing a search never waits on the daemon.
const std = @import("std");
const os = @import("../os.zig");
const a = os.allocator;
const json = @import("../json.zig");
const field = json.field;
const str = json.str;
const Provider = @import("../providers.zig").Provider;
const Claude = @import("../providers/claude.zig").Claude;
const Codex = @import("../providers/codex.zig").Codex;
const inference = @import("../inference.zig");
const log = std.log.scoped(.launch_history);

pub const Entry = struct {
    provider: Provider,
    session: []const u8,
    /// The provider's title for it; empty when it has none.
    title: []const u8 = "",
    /// The first and the last thing the user said.
    first: []const u8 = "",
    last: []const u8 = "",
    cwd: []const u8,
    branch: []const u8 = "",
    /// Seconds.
    updated_at: i64 = 0,
    /// The last turn stopped before the agent finished it.
    interrupted: bool = false,
    /// It only asked for a commit, like `$commit-all`.
    chore: bool = false,
};
pub const History = struct {
    pending: bool = true,
    entries: []const Entry = &.{},
};
/// What one read keeps. Older Codex threads stay out of reach of the
/// launcher; its Codex picker still lists them.
pub const capacity = 1000;
const title_bytes = 120;
const prompt_bytes = 200;
/// Transcripts reach tens of MB; titles and the last prompt sit near the end.
/// A tail without a prompt doubles until it holds one or reaches the limit.
const head_bytes = 128 * 1024;
const tail_bytes = 64 * 1024;
const long_tail_bytes = 2 * 1024 * 1024;

/// Per-file summaries, reread only when a file changes. Owned by one thread.
pub const Cache = struct {
    files: std.StringHashMapUnmanaged(Cached) = .empty,

    const Stamp = struct { inode: std.fs.File.INode = 0, size: u64 = 0, mtime: i128 = 0 };
    /// A Codex summary holds only what its rollout says: `last` and
    /// `interrupted`. `thread/list` supplies the rest fresh.
    const Cached = struct { stamp: Stamp, entry: ?Entry, seen: bool = true };

    pub fn deinit(c: *Cache) void {
        var it = c.files.iterator();
        while (it.next()) |kv| {
            if (kv.value_ptr.entry) |entry| free(entry);
            a.free(kv.key_ptr.*);
        }
        c.files.deinit(a);
    }
    fn stamp(stat: std.fs.File.Stat) Stamp {
        return .{ .inode = stat.inode, .size = stat.size, .mtime = stat.mtime };
    }
    /// What `path` said when it last looked like `stat`, if it was read then.
    fn lookup(c: *Cache, path: []const u8, stat: std.fs.File.Stat) ?*const Cached {
        const cached = c.files.getPtr(path) orelse return null;
        cached.seen = true;
        return if (std.meta.eql(cached.stamp, stamp(stat))) cached else null;
    }
    /// Keep `entry`, which the cache now owns, as what `path` says. Returns
    /// what it kept: null when there was no room, and `entry` is freed.
    fn store(c: *Cache, path: []const u8, stat: std.fs.File.Stat, entry: ?Entry) ?Entry {
        if (c.files.getPtr(path)) |cached| {
            if (cached.entry) |old| free(old);
            cached.* = .{ .stamp = stamp(stat), .entry = entry };
            return entry;
        }
        const key = a.dupe(u8, path) catch {
            if (entry) |e| free(e);
            return null;
        };
        c.files.put(a, key, .{ .stamp = stamp(stat), .entry = entry }) catch {
            a.free(key);
            if (entry) |e| free(e);
            return null;
        };
        return entry;
    }
    /// Forget files that were not looked up since the last sweep.
    fn sweep(c: *Cache) void {
        var stale: std.ArrayList([]const u8) = .empty;
        defer stale.deinit(a);
        var it = c.files.iterator();
        while (it.next()) |kv| {
            if (!kv.value_ptr.seen) stale.append(a, kv.key_ptr.*) catch return;
            kv.value_ptr.seen = false;
        }
        for (stale.items) |key| {
            const removed = c.files.fetchRemove(key).?;
            if (removed.value.entry) |entry| free(entry);
            a.free(removed.key);
        }
    }
};

fn free(e: Entry) void {
    for ([_][]const u8{ e.session, e.title, e.first, e.last, e.cwd, e.branch }) |text| a.free(text);
}
/// `e` with its own strings, display text cut to one line.
fn copy(alloc: std.mem.Allocator, e: Entry) !Entry {
    var out = e;
    out.session = try alloc.dupe(u8, e.session);
    errdefer alloc.free(out.session);
    out.title = try clip(alloc, e.title, title_bytes);
    errdefer alloc.free(out.title);
    out.first = try clip(alloc, e.first, prompt_bytes);
    errdefer alloc.free(out.first);
    out.last = try clip(alloc, e.last, prompt_bytes);
    errdefer alloc.free(out.last);
    out.cwd = try alloc.dupe(u8, e.cwd);
    errdefer alloc.free(out.cwd);
    out.branch = try clip(alloc, e.branch, 80);
    return out;
}

/// One line of display text: whitespace runs become a space, control bytes
/// go, and it is cut to `limit` bytes at a UTF-8 boundary.
fn clip(alloc: std.mem.Allocator, text: []const u8, limit: usize) ![]const u8 {
    var out: std.ArrayList(u8) = .empty;
    errdefer out.deinit(alloc);
    var space = false;
    for (text) |ch| {
        if (ch == ' ' or ch == '\t' or ch == '\n' or ch == '\r') {
            space = out.items.len > 0;
            continue;
        }
        if (ch < 32 or ch == 127) continue;
        if (out.items.len + @intFromBool(space) >= limit) break;
        if (space) try out.append(alloc, ' ');
        space = false;
        try out.append(alloc, ch);
    }
    var len = out.items.len;
    while (len > 0 and !std.unicode.utf8ValidateSlice(out.items[0..len])) len -= 1;
    out.shrinkRetainingCapacity(len);
    return out.toOwnedSlice(alloc);
}

/// A request that only asks for a commit.
fn chore(first: []const u8, title: []const u8) bool {
    const prompt = std.mem.trim(u8, first, " .!");
    if (std.ascii.startsWithIgnoreCase(prompt, "$commit")) return true;
    for ([_][]const u8{ "commit", "commit it", "commit all", "commit all changes", "commit pending changes", "commit all pending changes" }) |known| {
        if (std.ascii.eqlIgnoreCase(prompt, known)) return true;
    }
    return std.ascii.startsWithIgnoreCase(title, "commit all") or std.ascii.startsWithIgnoreCase(title, "commit pending");
}

/// Text a user typed, as opposed to what a client wrote into the prompt.
fn typed(text: []const u8) bool {
    const t = std.mem.trimLeft(u8, text, " \n\t");
    if (t.len == 0) return false;
    const injected = [_][]const u8{
        "<command-",   "<local-command",       "<system-reminder",                "<task-notification", "<bash-",
        "Caveat:",     "[Request interrupted", "This session is being continued", "/",                  "\u{25ef}",
        "# AGENTS.md", "<environment_context", "<user_instructions",              "<turn_aborted",      "<user_shell_command",
    };
    for (injected) |prefix| if (std.mem.startsWith(u8, t, prefix)) return false;
    return true;
}
fn interruption(text: []const u8) bool {
    return std.mem.startsWith(u8, std.mem.trimLeft(u8, text, " \n\t"), "[Request interrupted");
}

/// The complete lines in `bytes`. A tail that starts mid-file skips its first
/// partial line; the last line counts only when it ends.
fn lines(bytes: []const u8, mid_file: bool) std.mem.SplitIterator(u8, .scalar) {
    var start: usize = 0;
    if (mid_file) start = if (std.mem.indexOfScalar(u8, bytes, '\n')) |i| i + 1 else bytes.len;
    const end = if (std.mem.lastIndexOfScalar(u8, bytes, '\n')) |i| @max(i, start) else start;
    return std.mem.splitScalar(u8, bytes[start..end], '\n');
}

// ---------- Claude ----------

const ClaudeTail = struct {
    title: []const u8 = "",
    named: []const u8 = "",
    renamed: []const u8 = "",
    last: []const u8 = "",
    interrupted: bool = false,
    branch: []const u8 = "",
    continued: bool = false,
};

/// A user line's text, or null for tool results and messages a client wrote.
fn claudeText(arena: std.mem.Allocator, v: std.json.Value) ?[]const u8 {
    const line = Claude.Line.decode(v) orelse return null;
    if (line.type != .user or json.boolean(v, "isMeta") or field(v, "toolUseResult") != .null) return null;
    const content = field(line.message, "content");
    if (content == .string) return content.string;
    if (content != .array) return null;
    var out: std.ArrayList(u8) = .empty;
    for (content.array.items) |block| {
        const kind = std.meta.stringToEnum(Claude.BlockType, str(block, "type")) orelse continue;
        if (kind != .text) return null;
        if (out.items.len > 0) out.append(arena, ' ') catch return null;
        out.appendSlice(arena, str(block, "text")) catch return null;
    }
    return out.items;
}

/// The conversation `head` and `tail` of one transcript describe, or null when
/// it cannot be resumed from the launcher: an SDK run, or continued under
/// another session.
fn claudeEntry(arena: std.mem.Allocator, session: []const u8, head: []const u8, tail: []const u8, tail_mid_file: bool, mtime: i64) ?Entry {
    var entry: Entry = .{ .provider = .claude, .session = session, .cwd = "", .updated_at = mtime };
    var it = lines(head, false);
    while (it.next()) |line| {
        if (std.mem.indexOf(u8, line, "\"type\":\"user\"") == null or std.mem.indexOf(u8, line, "\"tool_result\"") != null) continue;
        const v = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch continue;
        if (std.mem.eql(u8, str(v, "entrypoint"), "sdk-cli")) return null;
        if (entry.cwd.len == 0) entry.cwd = str(v, "cwd");
        const text = claudeText(arena, v) orelse continue;
        if (!typed(text)) continue;
        entry.first = text;
        break;
    }
    var t: ClaudeTail = .{};
    it = lines(tail, tail_mid_file);
    while (it.next()) |line| {
        const kind = for ([_][]const u8{ "\"type\":\"user\"", "\"type\":\"ai-title\"", "\"type\":\"agent-name\"", "\"type\":\"custom-title\"", "\"type\":\"continued-in\"" }) |marker| {
            if (std.mem.indexOf(u8, line, marker) != null) break marker;
        } else continue;
        if (std.mem.eql(u8, kind, "\"type\":\"user\"") and std.mem.indexOf(u8, line, "\"tool_result\"") != null) continue;
        const v = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch continue;
        const line_type = Claude.Line.decode(v) orelse continue;
        switch (line_type.type orelse continue) {
            .@"ai-title" => t.title = str(v, "aiTitle"),
            .@"agent-name" => t.named = str(v, "agentName"),
            .@"custom-title" => t.renamed = str(v, "customTitle"),
            .@"continued-in" => t.continued = true,
            .user => {
                if (std.mem.eql(u8, str(v, "entrypoint"), "sdk-cli")) return null;
                if (str(v, "gitBranch").len > 0) t.branch = str(v, "gitBranch");
                if (entry.cwd.len == 0) entry.cwd = str(v, "cwd");
                const text = claudeText(arena, v) orelse continue;
                if (interruption(text)) {
                    t.interrupted = true;
                } else if (typed(text)) {
                    t.last = text;
                    t.interrupted = false;
                }
            },
            else => {},
        }
    }
    if (t.continued or entry.cwd.len == 0) return null;
    entry.title = if (t.renamed.len > 0) t.renamed else if (t.named.len > 0) t.named else t.title;
    // Empty when the tail holds no prompt; the caller may read further back.
    entry.last = t.last;
    entry.interrupted = t.interrupted;
    entry.branch = t.branch;
    return entry;
}

/// What one transcript says, owned by the caller.
fn readClaude(path: []const u8, stat: std.fs.File.Stat) ?Entry {
    const session = std.fs.path.stem(path);
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const file = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file.close();
    const head = readAt(arena.allocator(), file, 0, @min(stat.size, head_bytes)) catch return null;
    const mtime: i64 = @intCast(@divTrunc(stat.mtime, std.time.ns_per_s));
    var span: u64 = tail_bytes;
    while (true) {
        const start = stat.size -| span;
        const tail = readAt(arena.allocator(), file, start, stat.size - start) catch return null;
        var entry = claudeEntry(arena.allocator(), session, head, tail, start > 0, mtime) orelse return null;
        // A long tool-heavy turn can push the last prompt out of the tail.
        if (entry.last.len == 0 and start > 0 and span < long_tail_bytes) {
            span *= 2;
            continue;
        }
        if (entry.last.len == 0) entry.last = entry.first;
        if (entry.first.len == 0) entry.first = entry.last;
        if (entry.first.len == 0) return null;
        entry.chore = chore(entry.first, entry.title);
        return copy(a, entry) catch null;
    }
}

fn readAt(alloc: std.mem.Allocator, file: std.fs.File, offset: u64, len: u64) ![]u8 {
    const bytes = try alloc.alloc(u8, len);
    const n = try file.preadAll(bytes, offset);
    return bytes[0..n];
}

/// Every Claude transcript under `<config>/projects`, copied into `arena`.
fn claudeEntries(arena: std.mem.Allocator, cache: *Cache, out: *std.ArrayList(Entry)) !void {
    const root = Claude.info.configDir(a) catch return;
    defer a.free(root);
    const projects_path = try std.fs.path.join(a, &.{ root, "projects" });
    defer a.free(projects_path);
    var projects = std.fs.openDirAbsolute(projects_path, .{ .iterate = true }) catch return;
    defer projects.close();
    var it = projects.iterate();
    while (it.next() catch null) |project| {
        if (project.kind != .directory) continue;
        var dir = projects.openDir(project.name, .{ .iterate = true }) catch continue;
        defer dir.close();
        var files = dir.iterate();
        while (files.next() catch null) |file| {
            if (file.kind != .file or !std.mem.endsWith(u8, file.name, ".jsonl")) continue;
            const stat = dir.statFile(file.name) catch continue;
            const path = try std.fs.path.join(a, &.{ projects_path, project.name, file.name });
            defer a.free(path);
            const entry = if (cache.lookup(path, stat)) |hit| hit.entry else cache.store(path, stat, readClaude(path, stat));
            if (entry) |e| try out.append(arena, try copy(arena, e));
        }
    }
}

// ---------- Codex ----------

const CodexTail = struct { last: []const u8 = "", interrupted: bool = false };

fn codexTail(arena: std.mem.Allocator, tail: []const u8, mid_file: bool) CodexTail {
    var t: CodexTail = .{};
    var it = lines(tail, mid_file);
    while (it.next()) |line| {
        const user = std.mem.indexOf(u8, line, "\"role\":\"user\"") != null;
        if (!user and std.mem.indexOf(u8, line, "\"turn_aborted\"") == null) continue;
        const v = std.json.parseFromSliceLeaky(std.json.Value, arena, line, .{}) catch continue;
        const record = Codex.Rollout.decode(v);
        switch (record.payloadType() orelse continue) {
            .turn_aborted => t.interrupted = true,
            .message => {
                if (record.type != .response_item or !std.mem.eql(u8, str(record.payload, "role"), "user")) continue;
                var text: std.ArrayList(u8) = .empty;
                for (json.list(record.payload, "content")) |part| {
                    if (text.items.len > 0) text.append(arena, ' ') catch break;
                    text.appendSlice(arena, str(part, "text")) catch break;
                }
                if (!typed(text.items)) continue;
                t.last = text.items;
                t.interrupted = false;
            },
            else => {},
        }
    }
    return t;
}

/// What a rollout's tail says, owned by the caller: only `last` and
/// `interrupted` are set.
fn readCodex(path: []const u8, stat: std.fs.File.Stat) ?Entry {
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const file = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file.close();
    var span: u64 = tail_bytes;
    while (true) {
        const start = stat.size -| span;
        const tail = readAt(arena.allocator(), file, start, stat.size - start) catch return null;
        const t = codexTail(arena.allocator(), tail, start > 0);
        if (t.last.len == 0 and start > 0 and span < long_tail_bytes) {
            span *= 2;
            continue;
        }
        return copy(a, .{ .provider = .codex, .session = "", .cwd = "", .last = t.last, .interrupted = t.interrupted }) catch null;
    }
}

/// Interactive Codex threads, newest first, through the App Server, copied
/// into `arena`.
fn codexEntries(arena: std.mem.Allocator, pool: *inference.Pool, cache: *Cache, out: *std.ArrayList(Entry), stopping: *const std.atomic.Value(bool)) !void {
    var cursor: ?[]u8 = null;
    defer if (cursor) |value| a.free(value);
    var count: usize = 0;
    while (count < capacity and !stopping.load(.acquire)) {
        const page = pool.listThreads(cursor, stopping) catch |err| {
            log.warn("listing Codex threads failed: {}", .{err});
            return;
        };
        defer page.deinit();
        const result = field(page.value, "result");
        for (json.list(result, "data")) |item| {
            count += 1;
            var entry: Entry = .{
                .provider = .codex,
                .session = str(item, "id"),
                .title = str(item, "name"),
                .first = str(item, "preview"),
                .cwd = str(item, "cwd"),
                .branch = str(field(item, "gitInfo"), "branch"),
                .updated_at = json.int(item, "updatedAt") orelse 0,
            };
            const path = str(item, "path");
            if (entry.first.len == 0 or entry.session.len == 0 or entry.cwd.len == 0) continue;
            entry.last = entry.first;
            if (std.fs.path.isAbsolute(path)) if (std.fs.cwd().statFile(path)) |stat| {
                const tail = if (cache.lookup(path, stat)) |hit| hit.entry else cache.store(path, stat, readCodex(path, stat));
                if (tail) |t| {
                    if (t.last.len > 0) entry.last = t.last;
                    entry.interrupted = t.interrupted;
                }
            } else |_| {};
            entry.chore = chore(entry.first, entry.title);
            try out.append(arena, try copy(arena, entry));
        }
        const next = str(result, "nextCursor");
        if (next.len == 0) return;
        if (cursor) |value| a.free(value);
        cursor = try a.dupe(u8, next);
    }
}

// ---------- Reading ----------

/// A conversation whose folder is gone cannot be resumed: a Claude session
/// resumes only from its own folder.
const Folders = struct {
    known: std.StringHashMapUnmanaged(bool) = .empty,

    fn deinit(f: *Folders) void {
        f.known.deinit(a);
    }
    fn exists(f: *Folders, cwd: []const u8) bool {
        if (f.known.get(cwd)) |ok| return ok;
        const ok = if (std.fs.openDirAbsolute(cwd, .{})) |dir| blk: {
            var d = dir;
            d.close();
            break :blk true;
        } else |_| false;
        f.known.put(a, cwd, ok) catch {};
        return ok;
    }
};

fn newer(_: void, x: Entry, y: Entry) bool {
    return x.updated_at > y.updated_at;
}

/// Every resumable conversation, newest first, in `arena`.
pub fn read(arena: std.mem.Allocator, pool: *inference.Pool, cache: *Cache, stopping: *const std.atomic.Value(bool)) !History {
    var found: std.ArrayList(Entry) = .empty;
    try claudeEntries(arena, cache, &found);
    try codexEntries(arena, pool, cache, &found, stopping);
    cache.sweep();
    var folders: Folders = .{};
    defer folders.deinit();
    var kept: usize = 0;
    for (found.items) |entry| {
        if (!folders.exists(entry.cwd)) continue;
        found.items[kept] = entry;
        kept += 1;
    }
    std.mem.sort(Entry, found.items[0..kept], {}, newer);
    return .{ .pending = false, .entries = found.items[0..@min(kept, capacity)] };
}

/// Reads conversations on its own thread, so a slow or stuck App Server
/// never holds up launcher previews. Its App Server lives only for a read.
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    /// The conversations read last, in `arena`; how many reads finished, and
    /// the read a viewer waits for.
    history: History = .{},
    arena: ?std.heap.ArenaAllocator = null,
    done: u64 = 0,
    wanted: u64 = 0,
    done_at: i64 = 0,

    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{};
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.stopping.store(true, .release);
        w.wake.signal();
        w.thread.?.join();
        if (w.arena) |*arena| arena.deinit();
        a.destroy(w);
    }
    /// The read to wait for: the last one when it is recent, else the next.
    pub fn request(w: *Worker) u64 {
        w.mutex.lock();
        defer w.mutex.unlock();
        if (w.done > 0 and std.time.milliTimestamp() - w.done_at < 3000) return w.done;
        if (w.wanted <= w.done) w.wanted = w.done + 1;
        w.wake.signal();
        return w.wanted;
    }
    /// The last read and its number, held until `release`. Pending while
    /// read `wanted` is still to come.
    pub fn latest(w: *Worker, wanted: u64) struct { history: History, read: u64 } {
        w.mutex.lock();
        var history = w.history;
        if (w.done < wanted) history.pending = true;
        return .{ .history = history, .read = w.done };
    }
    pub fn release(w: *Worker) void {
        w.mutex.unlock();
    }
    fn run(w: *Worker) void {
        var cache: Cache = .{};
        defer cache.deinit();
        while (true) {
            w.mutex.lock();
            while (w.wanted <= w.done and !w.stopping.load(.acquire)) w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
            const wanted = w.wanted;
            w.mutex.unlock();
            if (w.stopping.load(.acquire)) return;
            var pool: inference.Pool = .{ .config = .{ .timeout_ms = 5000 } };
            var arena: std.heap.ArenaAllocator = .init(a);
            const result = read(arena.allocator(), &pool, &cache, &w.stopping) catch |err| blk: {
                log.warn("reading conversations failed: {}", .{err});
                break :blk History{ .pending = false };
            };
            pool.deinit();
            w.mutex.lock();
            defer w.mutex.unlock();
            if (w.arena) |*old| old.deinit();
            w.arena = arena;
            w.history = result;
            w.done = wanted;
            w.done_at = std.time.milliTimestamp();
        }
    }
};

test "a Claude transcript yields its title, prompts, branch and interruption" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const transcript =
        \\{"type":"user","cwd":"/work","gitBranch":"main","entrypoint":"cli","message":{"role":"user","content":"<command-name>/clear</command-name>"}}
        \\{"type":"user","cwd":"/work","gitBranch":"main","message":{"role":"user","content":"fix the   sidebar\nflicker"}}
        \\{"type":"assistant","message":{"content":[{"type":"text","text":"On it."}]}}
        \\{"type":"user","cwd":"/work","gitBranch":"main","message":{"role":"user","content":[{"type":"tool_result","content":"ok"}]},"toolUseResult":{}}
        \\{"type":"ai-title","aiTitle":"Sidebar flicker"}
        \\{"type":"user","cwd":"/work","gitBranch":"topic","message":{"role":"user","content":[{"type":"text","text":"does it work on linux?"}]}}
        \\{"type":"user","cwd":"/work","gitBranch":"topic","message":{"role":"user","content":[{"type":"text","text":"[Request interrupted by user]"}]}}
        \\
    ;
    const entry = claudeEntry(arena.allocator(), "s1", transcript, transcript, false, 50).?;
    try std.testing.expectEqualStrings("Sidebar flicker", entry.title);
    try std.testing.expectEqualStrings("fix the   sidebar\nflicker", entry.first);
    try std.testing.expectEqualStrings("does it work on linux?", entry.last);
    try std.testing.expectEqualStrings("topic", entry.branch);
    try std.testing.expectEqualStrings("/work", entry.cwd);
    try std.testing.expect(entry.interrupted);
    try std.testing.expectEqual(@as(i64, 50), entry.updated_at);
    const owned = try copy(a, entry);
    defer free(owned);
    try std.testing.expectEqualStrings("fix the sidebar flicker", owned.first);
}

test "Claude transcripts from the SDK or continued elsewhere are skipped" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const empty =
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"<local-command-stdout>ok</local-command-stdout>"}}
        \\
    ;
    const promptless = claudeEntry(arena.allocator(), "s", empty, empty, false, 0).?;
    try std.testing.expectEqualStrings("", promptless.first);
    try std.testing.expectEqualStrings("", promptless.last);
    const sdk =
        \\{"type":"user","cwd":"/w","entrypoint":"sdk-cli","message":{"role":"user","content":"Reply with just: ok"}}
        \\
    ;
    try std.testing.expect(claudeEntry(arena.allocator(), "s", sdk, sdk, false, 0) == null);
    const moved =
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"hello"}}
        \\{"type":"continued-in","continuedInSessionId":"other"}
        \\
    ;
    try std.testing.expect(claudeEntry(arena.allocator(), "s", moved, moved, false, 0) == null);
    // A rename wins over the generated title.
    const renamed =
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"$commit-all"}}
        \\{"type":"ai-title","aiTitle":"Commit all changes"}
        \\{"type":"custom-title","customTitle":"Release prep"}
        \\
    ;
    const entry = claudeEntry(arena.allocator(), "s", renamed, renamed, false, 0).?;
    try std.testing.expectEqualStrings("Release prep", entry.title);
    try std.testing.expect(chore(entry.first, entry.title));
}

test "a tail that starts mid-line skips the partial line" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const head =
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"first"}}
        \\
    ;
    const tail =
        \\ext":"cut"}]}}
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"latest"}}
        \\{"type":"user","cwd":"/w","message":{"role":"user","content":"unfinished
    ;
    const entry = claudeEntry(arena.allocator(), "s", head, tail, true, 0).?;
    try std.testing.expectEqualStrings("first", entry.first);
    try std.testing.expectEqualStrings("latest", entry.last);
}

test "a Codex rollout tail yields the last typed prompt and an abort" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const tail =
        \\{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"# AGENTS.md instructions"}]}}
        \\{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"why is it slow?"}]}}
        \\{"type":"event_msg","payload":{"type":"turn_aborted","reason":"interrupted"}}
        \\
    ;
    const t = codexTail(arena.allocator(), tail, false);
    try std.testing.expectEqualStrings("why is it slow?", t.last);
    try std.testing.expect(t.interrupted);
    const resumed = codexTail(arena.allocator(), tail ++
        \\{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"try again"}]}}
        \\
    , false);
    try std.testing.expectEqualStrings("try again", resumed.last);
    try std.testing.expect(!resumed.interrupted);
}

test "commit chores" {
    try std.testing.expect(chore("$commit-all", ""));
    try std.testing.expect(chore("Commit pending changes.", ""));
    try std.testing.expect(chore("anything", "Commit all changes"));
    try std.testing.expect(!chore("ok fixup the previous commit", "Commit message improvements"));
}

test "clip keeps one line within its byte limit at a UTF-8 boundary" {
    const out = try clip(a, "  a\tb\n\nc\x1b é", 7);
    defer a.free(out);
    try std.testing.expectEqualStrings("a b c ", out[0..6]);
    try std.testing.expect(std.unicode.utf8ValidateSlice(out));
    try std.testing.expect(out.len <= 7);
}
