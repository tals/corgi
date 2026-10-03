//! Conversations a launcher can resume: Claude transcripts and Codex threads
//! that hold a prompt, newest first. The launcher preview worker reads them on
//! request; viewers filter them, so typing a search never waits on the daemon.
const std = @import("std");
const compat = @import("../compat.zig");
const os = @import("../os.zig");
const a = os.allocator;
const json = @import("../json.zig");
const field = json.field;
const str = json.str;
const Provider = @import("../providers.zig").Provider;
const Claude = @import("../providers/claude.zig").Claude;
const Codex = @import("../providers/codex.zig").Codex;
const inference = @import("../inference.zig");
const fs_watch = @import("../fs_watch.zig");
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

    const Stamp = struct { inode: std.Io.File.INode = 0, size: u64 = 0, mtime: i128 = 0 };
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
    fn stamp(stat: std.Io.File.Stat) Stamp {
        return .{ .inode = stat.inode, .size = stat.size, .mtime = stat.mtime.toNanoseconds() };
    }
    /// What `path` said when it last looked like `stat`, if it was read then.
    fn lookup(c: *Cache, path: []const u8, stat: std.Io.File.Stat) ?*const Cached {
        const cached = c.files.getPtr(path) orelse return null;
        cached.seen = true;
        return if (std.meta.eql(cached.stamp, stamp(stat))) cached else null;
    }
    /// Keep `entry`, which the cache now owns, as what `path` says. Returns
    /// what it kept: null when there was no room, and `entry` is freed.
    fn store(c: *Cache, path: []const u8, stat: std.Io.File.Stat, entry: ?Entry) ?Entry {
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

/// `e` with its own copies of its strings.
pub fn clone(alloc: std.mem.Allocator, e: Entry) !Entry {
    var out = e;
    inline for (.{ "session", "title", "first", "last", "cwd", "branch" }) |name| {
        @field(out, name) = try alloc.dupe(u8, @field(e, name));
    }
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
    const t = std.mem.trimStart(u8, text, " \n\t");
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
    return std.mem.startsWith(u8, std.mem.trimStart(u8, text, " \n\t"), "[Request interrupted");
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
fn readClaude(path: []const u8, stat: std.Io.File.Stat) ?Entry {
    const session = std.fs.path.stem(path);
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const file = std.Io.Dir.openFileAbsolute(os.io(), path, .{}) catch return null;
    defer file.close(os.io());
    const head = readAt(arena.allocator(), file, 0, @min(stat.size, head_bytes)) catch return null;
    const mtime = stat.mtime.toSeconds();
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

fn readAt(alloc: std.mem.Allocator, file: std.Io.File, offset: u64, len: u64) ![]u8 {
    const bytes = try alloc.alloc(u8, len);
    const n = try file.readPositionalAll(os.io(), bytes, offset);
    return bytes[0..n];
}

/// One Claude transcript, from the cache while unchanged; null when it is
/// gone or cannot be resumed.
fn claudeFile(cache: *Cache, path: []const u8) ?Entry {
    const stat = std.Io.Dir.cwd().statFile(os.io(), path, .{}) catch return null;
    if (stat.kind != .file) return null;
    return if (cache.lookup(path, stat)) |hit| hit.entry else cache.store(path, stat, readClaude(path, stat));
}

/// The Claude transcripts in one project folder, copied into `arena`.
fn claudeProject(arena: std.mem.Allocator, cache: *Cache, folder: []const u8, out: *std.ArrayList(Entry)) !void {
    var dir = std.Io.Dir.openDirAbsolute(os.io(), folder, .{ .iterate = true }) catch return;
    defer dir.close(os.io());
    var files = dir.iterate();
    while (files.next(os.io()) catch null) |file| {
        if (file.kind != .file or !std.mem.endsWith(u8, file.name, ".jsonl")) continue;
        const path = try std.fs.path.join(a, &.{ folder, file.name });
        defer a.free(path);
        if (claudeFile(cache, path)) |e| try out.append(arena, try copy(arena, e));
    }
}

/// Every Claude transcript under `projects`, copied into `arena`.
fn claudeEntries(arena: std.mem.Allocator, cache: *Cache, projects: []const u8, out: *std.ArrayList(Entry)) !void {
    var dir = std.Io.Dir.openDirAbsolute(os.io(), projects, .{ .iterate = true }) catch return;
    defer dir.close(os.io());
    var it = dir.iterate();
    while (it.next(os.io()) catch null) |project| {
        if (project.kind != .directory) continue;
        const folder = try std.fs.path.join(a, &.{ projects, project.name });
        defer a.free(folder);
        try claudeProject(arena, cache, folder, out);
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
fn readCodex(path: []const u8, stat: std.Io.File.Stat) ?Entry {
    var arena: std.heap.ArenaAllocator = .init(a);
    defer arena.deinit();
    const file = std.Io.Dir.openFileAbsolute(os.io(), path, .{}) catch return null;
    defer file.close(os.io());
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

/// Each Codex rollout's path and the thread it holds, so a changed rollout
/// can be reread without asking the App Server.
const Rollouts = struct {
    sessions: std.StringHashMapUnmanaged([]const u8) = .empty,

    fn deinit(r: *Rollouts) void {
        var it = r.sessions.iterator();
        while (it.next()) |kv| {
            a.free(kv.key_ptr.*);
            a.free(kv.value_ptr.*);
        }
        r.sessions.deinit(a);
    }
    fn note(r: *Rollouts, path: []const u8, session: []const u8) !void {
        if (r.sessions.contains(path)) return;
        const owned_path = try a.dupe(u8, path);
        errdefer a.free(owned_path);
        const owned_session = try a.dupe(u8, session);
        errdefer a.free(owned_session);
        try r.sessions.put(a, owned_path, owned_session);
    }
};

/// Interactive Codex threads, newest first, through the App Server, copied
/// into `arena`; at most `pages` pages of 100. False when the App Server
/// could not list them.
fn codexEntries(arena: std.mem.Allocator, cache: *Cache, rollouts: *Rollouts, pages: usize, out: *std.ArrayList(Entry), stopping: *const std.atomic.Value(bool)) !bool {
    var pool: inference.Pool = .{ .config = .{ .timeout_ms = 5000 } };
    defer pool.deinit();
    var cursor: ?[]u8 = null;
    defer if (cursor) |value| a.free(value);
    for (0..pages) |_| {
        if (stopping.load(.acquire)) return false;
        const page = pool.listThreads(cursor, stopping) catch |err| {
            log.warn("listing Codex threads failed: {}", .{err});
            return false;
        };
        defer page.deinit();
        const result = field(page.value, "result");
        for (json.list(result, "data")) |item| {
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
            if (std.fs.path.isAbsolute(path)) if (std.Io.Dir.cwd().statFile(os.io(), path, .{})) |stat| {
                try rollouts.note(path, entry.session);
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
        if (next.len == 0) return true;
        if (cursor) |value| a.free(value);
        cursor = try a.dupe(u8, next);
    }
    return true;
}

// ---------- Keeping the list ----------

/// A conversation whose folder is gone cannot be resumed: a Claude session
/// resumes only from its own folder.
const Folders = struct {
    known: std.StringHashMapUnmanaged(bool) = .empty,

    fn deinit(f: *Folders) void {
        f.known.deinit(a);
    }
    fn exists(f: *Folders, cwd: []const u8) bool {
        if (f.known.get(cwd)) |ok| return ok;
        const ok = if (std.Io.Dir.openDirAbsolute(os.io(), cwd, .{})) |dir| blk: {
            var d = dir;
            d.close(os.io());
            break :blk true;
        } else |_| false;
        f.known.put(a, cwd, ok) catch {};
        return ok;
    }
    /// Keep the entries whose folder exists.
    fn keep(f: *Folders, entries: []Entry) []Entry {
        var kept: usize = 0;
        for (entries) |entry| {
            if (!f.exists(entry.cwd)) continue;
            entries[kept] = entry;
            kept += 1;
        }
        return entries[0..kept];
    }
};

fn newer(_: void, x: Entry, y: Entry) bool {
    return x.updated_at > y.updated_at;
}

/// Where conversations are written: `<claude config>/projects`, the Codex
/// home with `session_index.jsonl`, and its `sessions` tree. Empty when
/// unknown.
const Roots = struct {
    claude: []const u8 = "",
    codex: []const u8 = "",
    codex_sessions: []const u8 = "",

    fn init() Roots {
        var r: Roots = .{};
        if (Claude.info.configDir(a)) |config| {
            defer a.free(config);
            r.claude = std.fs.path.join(a, &.{ config, "projects" }) catch "";
        } else |_| {}
        if (Codex.info.configDir(a)) |home| {
            r.codex = home;
            r.codex_sessions = std.fs.path.join(a, &.{ home, "sessions" }) catch "";
        } else |_| {}
        return r;
    }
    fn deinit(r: Roots) void {
        for ([_][]const u8{ r.claude, r.codex, r.codex_sessions }) |path| a.free(path);
    }
    fn watch(r: Roots) ?*fs_watch.Watcher {
        const roots = [_]fs_watch.Root{
            .{ .path = r.claude, .depth = 1 },
            .{ .path = r.codex, .depth = 0 },
            .{ .path = r.codex_sessions, .depth = 3 },
        };
        var some: [roots.len]fs_watch.Root = undefined;
        var n: usize = 0;
        for (roots) |root| if (root.path.len > 0) {
            some[n] = root;
            n += 1;
        };
        return fs_watch.Watcher.init(some[0..n], settle_ms) catch |err| {
            log.warn("watching conversations failed, rereading every {d} minutes: {}", .{ unwatched_ms / std.time.ms_per_min, err });
            return null;
        };
    }
    fn under(root: []const u8, path: []const u8) bool {
        return root.len > 0 and path.len > root.len and std.mem.startsWith(u8, path, root) and path[root.len] == '/';
    }
};
/// A busy transcript changes many times a second; it is read once writes settle.
const settle_ms = 1000;
/// Without a watcher, everything is reread this often.
const unwatched_ms = 5 * std.time.ms_per_min;

/// Every resumable conversation the daemon knows, owned, with the revision
/// that last changed each, so a viewer gets only what changed.
const Store = struct {
    items: std.StringArrayHashMapUnmanaged(Item) = .empty,
    /// Conversations taken out and when; the oldest are forgotten first.
    gone: std.ArrayList(Gone) = .empty,
    revision: u64 = 0,
    /// Viewers behind this revision may have missed a removal.
    forgot: u64 = 0,

    const Item = struct { entry: Entry, revision: u64 };
    const Gone = struct { provider: Provider, session: []const u8, revision: u64 };
    const max_gone = 256;

    fn deinit(s: *Store) void {
        for (s.items.keys(), s.items.values()) |k, item| {
            a.free(k);
            free(item.entry);
        }
        s.items.deinit(a);
        for (s.gone.items) |g| a.free(g.session);
        s.gone.deinit(a);
    }
    fn key(buffer: []u8, provider: Provider, session: []const u8) []const u8 {
        return std.fmt.bufPrint(buffer, "{t}:{s}", .{ provider, session }) catch "";
    }
    fn get(s: *const Store, provider: Provider, session: []const u8) ?*const Entry {
        var buffer: [512]u8 = undefined;
        return if (s.items.getPtr(key(&buffer, provider, session))) |item| &item.entry else null;
    }
    /// Keep a copy of `e`; nothing changes when it is already kept as is.
    fn put(s: *Store, e: Entry) !void {
        var buffer: [512]u8 = undefined;
        const k = key(&buffer, e.provider, e.session);
        if (k.len == 0) return;
        if (s.items.getPtr(k)) |item| {
            if (same(item.entry, e)) return;
            const fresh = try copy(a, e);
            free(item.entry);
            s.revision += 1;
            item.* = .{ .entry = fresh, .revision = s.revision };
            return;
        }
        const owned = try a.dupe(u8, k);
        errdefer a.free(owned);
        const fresh = try copy(a, e);
        errdefer free(fresh);
        try s.items.put(a, owned, .{ .entry = fresh, .revision = s.revision + 1 });
        s.revision += 1;
    }
    fn remove(s: *Store, provider: Provider, session: []const u8) void {
        var buffer: [512]u8 = undefined;
        const removed = s.items.fetchSwapRemove(key(&buffer, provider, session)) orelse return;
        defer a.free(removed.key);
        s.forget(removed.value.entry);
    }
    /// Note `e` as gone and free it.
    fn forget(s: *Store, e: Entry) void {
        defer free(e);
        s.revision += 1;
        if (s.gone.items.len == max_gone) {
            const oldest = s.gone.orderedRemove(0);
            s.forgot = oldest.revision;
            a.free(oldest.session);
        }
        const session = a.dupe(u8, e.session) catch {
            s.forgot = s.revision;
            return;
        };
        s.gone.append(a, .{ .provider = e.provider, .session = session, .revision = s.revision }) catch {
            a.free(session);
            s.forgot = s.revision;
        };
    }
    /// Hold exactly `found` for each provider in `read`; others keep theirs.
    fn replace(s: *Store, found: []const Entry, read: std.EnumSet(Provider)) !void {
        var seen: std.StringHashMapUnmanaged(void) = .empty;
        defer {
            var it = seen.keyIterator();
            while (it.next()) |k| a.free(k.*);
            seen.deinit(a);
        }
        for (found) |e| {
            try s.put(e);
            var buffer: [512]u8 = undefined;
            const k = key(&buffer, e.provider, e.session);
            if (!seen.contains(k)) try seen.put(a, try a.dupe(u8, k), {});
        }
        var i: usize = 0;
        while (i < s.items.count()) {
            const item = s.items.values()[i];
            if (!read.contains(item.entry.provider) or seen.contains(s.items.keys()[i])) {
                i += 1;
                continue;
            }
            const k = s.items.keys()[i];
            s.items.swapRemoveAt(i);
            a.free(k);
            s.forget(item.entry);
        }
    }
};
fn same(x: Entry, y: Entry) bool {
    inline for (std.meta.fields(Entry)) |f| {
        const equal = if (f.type == []const u8) std.mem.eql(u8, @field(x, f.name), @field(y, f.name)) else @field(x, f.name) == @field(y, f.name);
        if (!equal) return false;
    }
    return true;
}

/// What a viewer needs to catch up: the whole list, or what changed after
/// the revision it has.
pub const Update = struct {
    /// The daemon's list this came from; another daemon's revisions mean nothing here.
    epoch: u64,
    revision: u64,
    /// `entries` replace everything the viewer had.
    full: bool,
    entries: []const Entry = &.{},
    removed: []const Removed = &.{},
    pub const Removed = struct { provider: Provider, session: []const u8 };
};

/// Keeps every resumable conversation current on its own thread: one read
/// at start, then only the files a watcher reports changed. A slow or stuck
/// Codex App Server never holds up launcher previews; it runs only while
/// the worker lists threads.
pub const Worker = struct {
    mutex: std.Io.Mutex = .init,
    stopping: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    /// What the worker waits on, so `stop` can end the wait.
    watcher: ?*fs_watch.Watcher = null,
    wake: std.Io.Condition = .init,
    store: Store = .{},
    /// The first read finished.
    ready: bool = false,
    epoch: u64,

    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{ .epoch = os.random.int(u64) | 1 };
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.mutex.lockUncancelable(os.io());
        w.stopping.store(true, .release);
        if (w.watcher) |x| x.interrupt();
        w.wake.signal(os.io());
        w.mutex.unlock(os.io());
        w.thread.?.join();
        w.store.deinit();
        a.destroy(w);
    }
    /// Every conversation, newest first, copied into `alloc`.
    pub fn snapshot(w: *Worker, alloc: std.mem.Allocator) !History {
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        var entries: std.ArrayList(Entry) = .empty;
        for (w.store.items.values()) |item| try entries.append(alloc, try copy(alloc, item.entry));
        std.mem.sort(Entry, entries.items, {}, newer);
        return .{ .pending = !w.ready, .entries = entries.items[0..@min(entries.items.len, capacity)] };
    }
    /// What a viewer that has `epoch` at `revision` lacks, copied into
    /// `alloc`; null when it has everything.
    pub fn update(w: *Worker, alloc: std.mem.Allocator, epoch: u64, revision: u64) !?Update {
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        if (!w.ready) return null;
        const full = epoch != w.epoch or revision < w.store.forgot;
        if (!full and revision >= w.store.revision) return null;
        var entries: std.ArrayList(Entry) = .empty;
        for (w.store.items.values()) |item| if (full or item.revision > revision) {
            try entries.append(alloc, try copy(alloc, item.entry));
        };
        var removed: std.ArrayList(Update.Removed) = .empty;
        if (!full) for (w.store.gone.items) |g| if (g.revision > revision) {
            try removed.append(alloc, .{ .provider = g.provider, .session = try alloc.dupe(u8, g.session) });
        };
        if (full) std.mem.sort(Entry, entries.items, {}, newer);
        const kept = if (full) @min(entries.items.len, capacity) else entries.items.len;
        return .{ .epoch = w.epoch, .revision = w.store.revision, .full = full, .entries = entries.items[0..kept], .removed = removed.items };
    }

    fn run(w: *Worker) void {
        const roots = Roots.init();
        defer roots.deinit();
        var cache: Cache = .{};
        defer cache.deinit();
        var rollouts: Rollouts = .{};
        defer rollouts.deinit();
        // Watch before reading, so a file written during the read is not missed.
        _ = w.setWatcher(roots.watch());
        defer if (w.setWatcher(null)) |x| x.deinit();
        w.readAll(roots, &cache, &rollouts);
        var changes: fs_watch.Changes = .{};
        defer changes.deinit();
        var settling_since: i64 = 0;
        while (!w.stopping.load(.acquire)) {
            const x = w.watcher orelse {
                // Without a watcher, read everything now and then.
                w.mutex.lockUncancelable(os.io());
                if (!w.stopping.load(.acquire)) compat.timedWait(&w.wake, os.io(), &w.mutex, unwatched_ms * std.time.ns_per_ms) catch {};
                w.mutex.unlock(os.io());
                if (w.stopping.load(.acquire)) return;
                _ = w.setWatcher(roots.watch());
                w.readAll(roots, &cache, &rollouts);
                continue;
            };
            // Sleep until something changes; once it does, until writes settle.
            const settled = settling_since + settle_ms - os.milliTimestamp();
            x.wait(if (settling_since == 0) null else @intCast(std.math.clamp(settled, 0, settle_ms)), &changes);
            if (changes.overflow) {
                changes.clear();
                settling_since = 0;
                w.readAll(roots, &cache, &rollouts);
                continue;
            }
            if (changes.paths.count() == 0) continue;
            const now = os.milliTimestamp();
            if (settling_since == 0) settling_since = now;
            if (now - settling_since < settle_ms) continue;
            w.readChanged(roots, &cache, &rollouts, &changes);
            changes.clear();
            settling_since = 0;
        }
    }
    /// Swap the watcher `stop` interrupts; returns the old one.
    fn setWatcher(w: *Worker, watcher: ?*fs_watch.Watcher) ?*fs_watch.Watcher {
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        const old = w.watcher;
        w.watcher = watcher;
        // A stop before this watcher existed could not interrupt it.
        if (watcher) |x| if (w.stopping.load(.acquire)) x.interrupt();
        return old;
    }
    /// Read everything, keeping what a provider had when it cannot be read.
    fn readAll(w: *Worker, roots: Roots, cache: *Cache, rollouts: *Rollouts) void {
        var arena: std.heap.ArenaAllocator = .init(a);
        defer arena.deinit();
        var found: std.ArrayList(Entry) = .empty;
        var read: std.EnumSet(Provider) = .initOne(.claude);
        claudeEntries(arena.allocator(), cache, roots.claude, &found) catch |err| {
            log.warn("reading Claude conversations failed: {}", .{err});
            read.remove(.claude);
        };
        if (codexEntries(arena.allocator(), cache, rollouts, capacity / 100, &found, &w.stopping) catch false) read.insert(.codex);
        cache.sweep();
        var folders: Folders = .{};
        defer folders.deinit();
        const kept = folders.keep(found.items);
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        w.store.replace(kept, read) catch |err| log.warn("keeping conversations failed: {}", .{err});
        w.ready = true;
    }
    /// Reread what the watcher reported. Only the worker writes the store,
    /// so it reads it here without the lock.
    fn readChanged(w: *Worker, roots: Roots, cache: *Cache, rollouts: *Rollouts, changes: *const fs_watch.Changes) void {
        var arena: std.heap.ArenaAllocator = .init(a);
        defer arena.deinit();
        const alloc = arena.allocator();
        var found: std.ArrayList(Entry) = .empty;
        var gone: std.ArrayList(Update.Removed) = .empty;
        var list_codex = false;
        for (changes.paths.keys()) |path| {
            if (Roots.under(roots.claude, path)) {
                const parent = std.fs.path.dirname(path) orelse continue;
                if (std.mem.eql(u8, parent, roots.claude)) {
                    // A project folder: new, or written before a watch reached it.
                    claudeProject(alloc, cache, path, &found) catch continue;
                } else if (std.mem.endsWith(u8, path, ".jsonl") and std.mem.eql(u8, std.fs.path.dirname(parent) orelse "", roots.claude)) {
                    if (claudeFile(cache, path)) |e| {
                        found.append(alloc, copy(alloc, e) catch continue) catch continue;
                    } else gone.append(alloc, .{ .provider = .claude, .session = std.fs.path.stem(path) }) catch continue;
                }
            } else if (Roots.under(roots.codex, path)) {
                if (rollouts.sessions.get(path)) |session| {
                    const stat = std.Io.Dir.cwd().statFile(os.io(), path, .{}) catch {
                        gone.append(alloc, .{ .provider = .codex, .session = session }) catch {};
                        continue;
                    };
                    const kept = w.store.get(.codex, session) orelse {
                        list_codex = true;
                        continue;
                    };
                    var e = kept.*;
                    const tail = if (cache.lookup(path, stat)) |hit| hit.entry else cache.store(path, stat, readCodex(path, stat));
                    if (tail) |t| {
                        if (t.last.len > 0) e.last = t.last;
                        e.interrupted = t.interrupted;
                    }
                    e.updated_at = @max(e.updated_at, stat.mtime.toSeconds());
                    found.append(alloc, copy(alloc, e) catch continue) catch continue;
                } else if (Roots.under(roots.codex_sessions, path) or std.mem.eql(u8, std.fs.path.basename(path), "session_index.jsonl")) {
                    // A new thread, or a rename.
                    list_codex = true;
                }
            }
        }
        if (list_codex) _ = codexEntries(alloc, cache, rollouts, 1, &found, &w.stopping) catch false;
        var folders: Folders = .{};
        defer folders.deinit();
        const kept = folders.keep(found.items);
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        for (kept) |e| w.store.put(e) catch |err| log.warn("keeping a conversation failed: {}", .{err});
        for (gone.items) |g| w.store.remove(g.provider, g.session);
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

test "a viewer gets everything once, then only what changed, and everything from another daemon" {
    var w: Worker = .{ .epoch = 5, .ready = true };
    defer w.store.deinit();
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const first: Entry = .{ .provider = .claude, .session = "a", .title = "First", .cwd = "/w", .updated_at = 1 };
    const second: Entry = .{ .provider = .codex, .session = "b", .title = "Second", .cwd = "/w", .updated_at = 2 };
    try w.store.replace(&.{ first, second }, .initFull());
    const full = (try w.update(alloc, 0, 0)).?;
    try std.testing.expect(full.full);
    try std.testing.expectEqualStrings("Second", full.entries[0].title);
    try std.testing.expect(try w.update(alloc, full.epoch, full.revision) == null);
    // The same entry again changes nothing.
    try w.store.put(first);
    try std.testing.expect(try w.update(alloc, full.epoch, full.revision) == null);
    var used = first;
    used.last = "one more thing";
    used.updated_at = 9;
    try w.store.put(used);
    w.store.remove(.codex, "b");
    const delta = (try w.update(alloc, full.epoch, full.revision)).?;
    try std.testing.expect(!delta.full);
    try std.testing.expectEqual(@as(usize, 1), delta.entries.len);
    try std.testing.expectEqualStrings("one more thing", delta.entries[0].last);
    try std.testing.expectEqualStrings("b", delta.removed[0].session);
    try std.testing.expect((try w.update(alloc, 4, delta.revision)).?.full);
    // A read that could not list Codex leaves Codex's conversations alone.
    try w.store.put(second);
    try w.store.replace(&.{}, .initOne(.claude));
    try std.testing.expect(w.store.get(.codex, "b") != null);
    try std.testing.expect(w.store.get(.claude, "a") == null);
}
