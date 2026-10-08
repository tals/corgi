//! Watch folders for changed files: FSEvents on macOS, inotify on Linux.
//! One thread waits, for as long as nothing changes; changes arrive as paths
//! under the roots it was given.
//! Elsewhere `init` fails, and callers look at the files on a timer instead.
//!
//! The macOS backend follows the Zig standard library's `std.Build.Watch`
//! FSEvents code: it loads CoreServices at run time, so there is no link
//! dependency, and runs the stream's callbacks on its own serial queue.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const a = os.allocator;

/// A folder to watch and how many levels of subfolders below it. FSEvents
/// always watches the whole tree; inotify needs a watch per folder.
pub const Root = struct { path: []const u8, depth: u8 };

/// Paths that changed since the last wait, in the spelling of their root.
pub const Changes = struct {
    paths: std.StringArrayHashMapUnmanaged(void) = .empty,
    /// Events were dropped: anything under the roots may have changed.
    overflow: bool = false,

    pub fn deinit(c: *Changes) void {
        c.clear();
        c.paths.deinit(a);
    }
    pub fn clear(c: *Changes) void {
        for (c.paths.keys()) |path| a.free(path);
        c.paths.clearRetainingCapacity();
        c.overflow = false;
    }
    fn add(c: *Changes, path: []const u8) void {
        if (c.paths.contains(path)) return;
        const owned = a.dupe(u8, path) catch {
            c.overflow = true;
            return;
        };
        c.paths.put(a, owned, {}) catch {
            a.free(owned);
            c.overflow = true;
        };
    }
    /// Move everything in `other` here, leaving it empty.
    fn take(c: *Changes, other: *Changes) void {
        for (other.paths.keys()) |path| c.add(path);
        c.overflow = c.overflow or other.overflow;
        other.clear();
    }
};

pub const Watcher = switch (builtin.os.tag) {
    .macos => FsEvents,
    .linux => Inotify,
    else => Unsupported,
};

const Unsupported = struct {
    pub fn init(_: []const Root, _: u32) error{Unsupported}!*Unsupported {
        return error.Unsupported;
    }
    pub fn deinit(_: *Unsupported) void {}
    pub fn wait(_: *Unsupported, _: ?u32, _: *Changes) void {}
    pub fn interrupt(_: *Unsupported) void {}
};

// ---------- macOS ----------

const FsEvents = struct {
    core_services: std.DynLib,
    fns: Symbols,
    queue: dispatch_queue_t,
    semaphore: dispatch_semaphore_t,
    stream: FSEventStreamRef,
    paths: CFArrayRef,
    /// Each root as given, and as FSEvents spells it (symlinks resolved).
    roots: []const [2][]const u8,
    mutex: std.Io.Mutex = .init,
    pending: Changes = .{},

    const Symbols = struct {
        FSEventStreamCreate: *const fn (CFAllocatorRef, FSEventStreamCallback, ?*const FSEventStreamContext, CFArrayRef, FSEventStreamEventId, CFTimeInterval, FSEventStreamCreateFlags) callconv(.c) ?FSEventStreamRef,
        FSEventStreamSetDispatchQueue: *const fn (FSEventStreamRef, dispatch_queue_t) callconv(.c) void,
        FSEventStreamStart: *const fn (FSEventStreamRef) callconv(.c) bool,
        FSEventStreamStop: *const fn (FSEventStreamRef) callconv(.c) void,
        FSEventStreamInvalidate: *const fn (FSEventStreamRef) callconv(.c) void,
        FSEventStreamRelease: *const fn (FSEventStreamRef) callconv(.c) void,
        CFRelease: *const fn (*const anyopaque) callconv(.c) void,
        CFArrayCreate: *const fn (CFAllocatorRef, [*]const usize, CFIndex, ?*const anyopaque) callconv(.c) ?CFArrayRef,
        CFStringCreateWithCString: *const fn (CFAllocatorRef, [*:0]const u8, u32) callconv(.c) ?CFStringRef,
        kCFTypeArrayCallBacks: *const anyopaque,
    };

    pub fn init(roots: []const Root, latency_ms: u32) !*FsEvents {
        var core_services = std.DynLib.open("/System/Library/Frameworks/CoreServices.framework/CoreServices") catch return error.Unsupported;
        errdefer core_services.close();
        var fns: Symbols = undefined;
        inline for (@typeInfo(Symbols).@"struct".fields) |f| {
            @field(fns, f.name) = core_services.lookup(f.type, f.name) orelse return error.Unsupported;
        }
        var spellings: std.ArrayList([2][]const u8) = .empty;
        defer spellings.deinit(a);
        errdefer for (spellings.items) |pair| {
            a.free(pair[0]);
            a.free(pair[1]);
        };
        var strings: std.ArrayList(usize) = .empty;
        defer {
            for (strings.items) |string| fns.CFRelease(@ptrFromInt(string));
            strings.deinit(a);
        }
        for (roots) |root| {
            const real = os.realpathAlloc(a, .cwd(), root.path) catch continue;
            errdefer a.free(real);
            const spelled = try a.dupe(u8, root.path);
            errdefer a.free(spelled);
            const z = try a.dupeZ(u8, real);
            defer a.free(z);
            const string = fns.CFStringCreateWithCString(null, z, cf_string_utf8) orelse return error.OutOfMemory;
            try strings.append(a, @intFromPtr(string));
            try spellings.append(a, .{ spelled, real });
        }
        if (strings.items.len == 0) return error.NothingToWatch;
        const paths = fns.CFArrayCreate(null, strings.items.ptr, @intCast(strings.items.len), fns.kCFTypeArrayCallBacks) orelse return error.OutOfMemory;
        errdefer fns.CFRelease(paths);
        const w = try a.create(FsEvents);
        errdefer a.destroy(w);
        w.* = .{
            .core_services = core_services,
            .fns = fns,
            .queue = dispatch_queue_create("corgi.fs-watch", null),
            .semaphore = dispatch_semaphore_create(0),
            .stream = undefined,
            .paths = paths,
            .roots = &.{},
        };
        errdefer {
            dispatch_release(w.queue);
            dispatch_release(w.semaphore);
        }
        const context: FSEventStreamContext = .{ .version = 0, .info = w, .retain = null, .release = null, .copy_description = null };
        const latency = @as(f64, @floatFromInt(latency_ms)) / 1000;
        w.stream = fns.FSEventStreamCreate(null, &callback, &context, paths, .since_now, latency, .{ .file_events = true }) orelse return error.Unsupported;
        errdefer fns.FSEventStreamRelease(w.stream);
        fns.FSEventStreamSetDispatchQueue(w.stream, w.queue);
        w.roots = try spellings.toOwnedSlice(a);
        if (!fns.FSEventStreamStart(w.stream)) {
            fns.FSEventStreamInvalidate(w.stream);
            for (w.roots) |pair| {
                a.free(pair[0]);
                a.free(pair[1]);
            }
            a.free(w.roots);
            return error.Unsupported;
        }
        return w;
    }
    pub fn deinit(w: *FsEvents) void {
        w.fns.FSEventStreamStop(w.stream);
        w.fns.FSEventStreamInvalidate(w.stream);
        w.fns.FSEventStreamRelease(w.stream);
        w.fns.CFRelease(w.paths);
        dispatch_release(w.queue);
        dispatch_release(w.semaphore);
        w.core_services.close();
        for (w.roots) |pair| {
            a.free(pair[0]);
            a.free(pair[1]);
        }
        a.free(w.roots);
        w.pending.deinit();
        a.destroy(w);
    }
    /// Wait up to `timeout_ms`, or until something changes or `interrupt`,
    /// and add the changes to `out`.
    pub fn wait(w: *FsEvents, timeout_ms: ?u32, out: *Changes) void {
        const until = if (timeout_ms) |ms| dispatch_time(.now, @as(i64, ms) * std.time.ns_per_ms) else .forever;
        _ = dispatch_semaphore_wait(w.semaphore, until);
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        out.take(&w.pending);
    }
    /// End a `wait` on another thread.
    pub fn interrupt(w: *FsEvents) void {
        _ = dispatch_semaphore_signal(w.semaphore);
    }
    /// `path` as the caller spelled its root.
    fn respell(w: *const FsEvents, path: []const u8, buffer: []u8) ?[]const u8 {
        for (w.roots) |pair| {
            const real = pair[1];
            if (!std.mem.startsWith(u8, path, real) or (path.len > real.len and path[real.len] != '/')) continue;
            return std.fmt.bufPrint(buffer, "{s}{s}", .{ pair[0], path[real.len..] }) catch null;
        }
        return null;
    }
    fn callback(_: *const anyopaque, info: ?*anyopaque, count: usize, event_paths: *anyopaque, flags: [*]const FSEventStreamEventFlags, _: [*]const u64) callconv(.c) void {
        const w: *FsEvents = @ptrCast(@alignCast(info.?));
        const paths: [*]const [*:0]const u8 = @ptrCast(@alignCast(event_paths));
        w.mutex.lockUncancelable(os.io());
        for (paths[0..count], flags[0..count]) |raw, flag| {
            if (flag.history_done) continue;
            if (flag.must_scan_sub_dirs or flag.user_dropped or flag.kernel_dropped) {
                w.pending.overflow = true;
                continue;
            }
            var buffer: [std.fs.max_path_bytes]u8 = undefined;
            if (w.respell(std.mem.span(raw), &buffer)) |path| w.pending.add(path);
        }
        w.mutex.unlock(os.io());
        _ = dispatch_semaphore_signal(w.semaphore);
    }

    const CFAllocatorRef = ?*const anyopaque;
    const CFArrayRef = *const anyopaque;
    const CFStringRef = *const anyopaque;
    const CFIndex = isize;
    const CFTimeInterval = f64;
    const cf_string_utf8: u32 = 0x08000100;
    const FSEventStreamRef = *anyopaque;
    const FSEventStreamEventId = enum(u64) { since_now = std.math.maxInt(u64), _ };
    const FSEventStreamCallback = *const fn (*const anyopaque, ?*anyopaque, usize, *anyopaque, [*]const FSEventStreamEventFlags, [*]const u64) callconv(.c) void;
    const FSEventStreamContext = extern struct {
        version: CFIndex,
        info: ?*anyopaque,
        retain: ?*const anyopaque,
        release: ?*const anyopaque,
        copy_description: ?*const anyopaque,
    };
    const FSEventStreamCreateFlags = packed struct(u32) {
        use_cf_types: bool = false,
        no_defer: bool = false,
        watch_root: bool = false,
        ignore_self: bool = false,
        file_events: bool = false,
        _: u27 = 0,
    };
    const FSEventStreamEventFlags = packed struct(u32) {
        must_scan_sub_dirs: bool,
        user_dropped: bool,
        kernel_dropped: bool,
        event_ids_wrapped: bool,
        history_done: bool,
        root_changed: bool,
        mount: bool,
        unmount: bool,
        _: u24 = 0,
    };
    const dispatch_queue_t = *anyopaque;
    const dispatch_semaphore_t = *anyopaque;
    const dispatch_time_t = enum(u64) { now = 0, forever = std.math.maxInt(u64), _ };
    extern fn dispatch_queue_create(label: [*:0]const u8, attr: ?*anyopaque) dispatch_queue_t;
    extern fn dispatch_semaphore_create(value: isize) dispatch_semaphore_t;
    extern fn dispatch_semaphore_wait(semaphore: dispatch_semaphore_t, timeout: dispatch_time_t) isize;
    extern fn dispatch_semaphore_signal(semaphore: dispatch_semaphore_t) isize;
    extern fn dispatch_time(base: dispatch_time_t, delta_ns: i64) dispatch_time_t;
    extern fn dispatch_release(object: *anyopaque) void;
};

// ---------- Linux ----------

const Inotify = struct {
    fd: i32,
    /// `interrupt` writes here to end a `wait`.
    wake: [2]i32,
    /// Each watch's folder and how many levels below it to watch.
    folders: std.AutoHashMapUnmanaged(i32, Folder) = .empty,
    /// Raised when the kernel refused a watch; changes there go unseen.
    full: bool = false,

    const Folder = struct { path: []const u8, depth: u8 };
    const linux = std.os.linux;
    const mask = linux.IN.MODIFY | linux.IN.CLOSE_WRITE | linux.IN.CREATE | linux.IN.DELETE | linux.IN.MOVED_FROM |
        linux.IN.MOVED_TO | linux.IN.DELETE_SELF | linux.IN.ONLYDIR;

    pub fn init(roots: []const Root, _: u32) !*Inotify {
        const rc = linux.inotify_init1(linux.IN.NONBLOCK | linux.IN.CLOEXEC);
        if (linux.errno(rc) != .SUCCESS) return error.Unsupported;
        const fd: i32 = @intCast(rc);
        errdefer _ = os.c.close(fd);
        var wake: [2]i32 = undefined;
        if (linux.errno(linux.pipe2(&wake, .{ .NONBLOCK = true, .CLOEXEC = true })) != .SUCCESS) return error.SystemResources;
        errdefer for (wake) |end| {
            _ = os.c.close(end);
        };
        const w = try a.create(Inotify);
        w.* = .{ .fd = fd, .wake = wake };
        errdefer w.deinit();
        for (roots) |root| w.watch(root.path, root.depth);
        if (w.folders.count() == 0) return error.NothingToWatch;
        if (w.full) return error.TooManyFolders;
        return w;
    }
    pub fn deinit(w: *Inotify) void {
        _ = os.c.close(w.fd);
        for (w.wake) |end| _ = os.c.close(end);
        var it = w.folders.valueIterator();
        while (it.next()) |folder| a.free(folder.path);
        w.folders.deinit(a);
        a.destroy(w);
    }
    /// Watch `path` and its subfolders `depth` levels down.
    fn watch(w: *Inotify, path: []const u8, depth: u8) void {
        var z: [std.fs.max_path_bytes]u8 = undefined;
        const rc = linux.inotify_add_watch(w.fd, std.fmt.bufPrintZ(&z, "{s}", .{path}) catch return, mask);
        switch (linux.errno(rc)) {
            .SUCCESS => {},
            .NOSPC, .NOMEM => {
                w.full = true;
                return;
            },
            else => return,
        }
        const wd: i32 = @intCast(rc);
        const owned = a.dupe(u8, path) catch return;
        const entry = w.folders.getOrPut(a, wd) catch {
            a.free(owned);
            return;
        };
        // The kernel reuses a descriptor for a folder it already watches.
        if (entry.found_existing) a.free(entry.value_ptr.path);
        entry.value_ptr.* = .{ .path = owned, .depth = depth };
        if (depth == 0) return;
        var dir = std.Io.Dir.openDirAbsolute(os.io(), path, .{ .iterate = true }) catch return;
        defer dir.close(os.io());
        var it = dir.iterate();
        while (it.next(os.io()) catch null) |child| {
            if (child.kind != .directory) continue;
            var buffer: [std.fs.max_path_bytes]u8 = undefined;
            const sub = std.fmt.bufPrint(&buffer, "{s}/{s}", .{ path, child.name }) catch continue;
            w.watch(sub, depth - 1);
        }
    }
    pub fn wait(w: *Inotify, timeout_ms: ?u32, out: *Changes) void {
        var fds = [_]std.posix.pollfd{
            .{ .fd = w.fd, .events = std.posix.POLL.IN, .revents = 0 },
            .{ .fd = w.wake[0], .events = std.posix.POLL.IN, .revents = 0 },
        };
        const timeout: i32 = if (timeout_ms) |ms| @intCast(@min(ms, std.math.maxInt(i32))) else -1;
        _ = std.posix.poll(&fds, timeout) catch return;
        var drained: [16]u8 = undefined;
        while (std.posix.read(w.wake[0], &drained)) |n| {
            if (n == 0) break;
        } else |_| {}
        var buffer: [16 * 1024]u8 align(@alignOf(linux.inotify_event)) = undefined;
        while (true) {
            const n = std.posix.read(w.fd, &buffer) catch return;
            if (n == 0) return;
            var offset: usize = 0;
            while (offset + @sizeOf(linux.inotify_event) <= n) {
                const event: *const linux.inotify_event = @ptrCast(@alignCast(&buffer[offset]));
                offset += @sizeOf(linux.inotify_event) + event.len;
                w.handle(event, out);
            }
        }
    }
    /// End a `wait` on another thread.
    pub fn interrupt(w: *Inotify) void {
        _ = os.c.write(w.wake[1], "x", 1);
    }
    fn handle(w: *Inotify, event: *const linux.inotify_event, out: *Changes) void {
        if (event.mask & linux.IN.Q_OVERFLOW != 0) {
            out.overflow = true;
            return;
        }
        const folder = w.folders.get(event.wd) orelse return;
        if (event.mask & (linux.IN.IGNORED | linux.IN.DELETE_SELF) != 0) {
            if (w.folders.fetchRemove(event.wd)) |gone| a.free(gone.value.path);
            return;
        }
        const name = event.getName() orelse return;
        var buffer: [std.fs.max_path_bytes]u8 = undefined;
        const path = std.fmt.bufPrint(&buffer, "{s}/{s}", .{ folder.path, name }) catch return;
        // A new folder gets watches; whatever it already holds counts as changed.
        if (event.mask & linux.IN.ISDIR != 0 and event.mask & (linux.IN.CREATE | linux.IN.MOVED_TO) != 0 and folder.depth > 0) {
            w.watch(path, folder.depth - 1);
        }
        out.add(path);
    }
};

test "a file written under a watched folder is reported in its root's spelling" {
    if (Watcher == Unsupported) return error.SkipZigTest;
    var tmp = std.testing.tmpDir(.{ .iterate = true });
    defer tmp.cleanup();
    try tmp.dir.createDirPath(os.io(), "projects/one");
    var buffer: [std.fs.max_path_bytes]u8 = undefined;
    const base = buffer[0..try tmp.dir.realPathFile(os.io(), ".", &buffer)];
    const root = try std.fmt.allocPrint(a, "{s}/projects", .{base});
    defer a.free(root);
    const w = try Watcher.init(&.{.{ .path = root, .depth = 2 }}, 50);
    defer w.deinit();
    // FSEvents starts reporting a moment after the stream starts.
    os.sleep(200 * std.time.ns_per_ms);
    try tmp.dir.createDirPath(os.io(), "projects/two");
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "projects/one/a.jsonl", .data = "{}\n" });
    try tmp.dir.writeFile(os.io(), .{ .sub_path = "projects/two/b.jsonl", .data = "{}\n" });
    const a_path = try std.fmt.allocPrint(a, "{s}/one/a.jsonl", .{root});
    defer a.free(a_path);
    const b_path = try std.fmt.allocPrint(a, "{s}/two/b.jsonl", .{root});
    defer a.free(b_path);
    const two_path = try std.fmt.allocPrint(a, "{s}/two", .{root});
    defer a.free(two_path);
    var changes: Changes = .{};
    defer changes.deinit();
    // inotify may report the new folder instead of the file it raced to
    // watch; whoever reads the changes scans a new folder.
    const done = struct {
        fn check(c: *const Changes, first: []const u8, second: []const u8, folder: []const u8) bool {
            return c.paths.contains(first) and (c.paths.contains(second) or c.paths.contains(folder));
        }
    }.check;
    var waited: u32 = 0;
    while (waited < 5000 and !done(&changes, a_path, b_path, two_path)) : (waited += 100) w.wait(100, &changes);
    try std.testing.expect(done(&changes, a_path, b_path, two_path));
}
