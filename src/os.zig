const std = @import("std");
const builtin = @import("builtin");
const corgi_options = @import("corgi_options");
pub const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("pwd.h");
    @cInclude("stdlib.h");
    @cInclude("fcntl.h");
    @cInclude("signal.h");
    @cInclude("termios.h");
    @cInclude("sys/ioctl.h");
    @cInclude("sys/wait.h");
    @cInclude("sys/socket.h");
    @cInclude("sys/un.h");
    @cInclude("sys/stat.h");
    @cInclude("poll.h");
    if (builtin.os.tag == .macos) {
        @cInclude("util.h");
        @cInclude("libproc.h");
        @cInclude("sys/proc_info.h");
        @cInclude("sys/sysctl.h");
    } else @cInclude("pty.h");
});
pub fn sig_ignore(_: c_int) callconv(.c) void {}
/// Process allocator. Under -Dcheck-leaks, tests get the leak-checking
/// allocator instead; a passing suite with it on means no more leaks to fix.
pub const allocator = if (builtin.is_test and corgi_options.check_leaks) std.testing.allocator else std.heap.c_allocator;
/// Never deinitialized, so threads still running at exit can use it.
var threaded: std.Io.Threaded = .init_single_threaded;
/// Gives `io` the process's arguments and environment; `main` calls it first.
pub fn initIo(init: std.process.Init.Minimal) void {
    threaded = .init(allocator, .{ .argv0 = .init(init.args), .environ = init.environ });
}
/// Process I/O.
pub fn io() std.Io {
    if (builtin.is_test) return std.testing.io;
    return threaded.io();
}
/// Wall-clock seconds since the epoch.
pub fn timestamp() i64 {
    return std.Io.Timestamp.now(io(), .real).toSeconds();
}
pub fn milliTimestamp() i64 {
    return std.Io.Timestamp.now(io(), .real).toMilliseconds();
}
pub fn microTimestamp() i64 {
    return std.Io.Timestamp.now(io(), .real).toMicroseconds();
}
pub fn sleep(ns: u64) void {
    io().sleep(.fromNanoseconds(ns), .awake) catch {};
}
/// Elapsed time on the monotonic clock, like the old `std.time.Timer`.
pub const Timer = struct {
    started: std.Io.Timestamp,

    pub fn start() Timer {
        return .{ .started = .now(io(), .awake) };
    }
    /// Nanoseconds since `start`.
    pub fn read(t: Timer) u64 {
        return @intCast(t.started.untilNow(io(), .awake).toNanoseconds());
    }
};
/// A cryptographically secure generator, like the old `std.crypto.random`.
pub const random: std.Random = .{ .ptr = undefined, .fillFn = fillRandom };
fn fillRandom(_: *anyopaque, buf: []u8) void {
    io().random(buf);
}
pub fn writeAll(fd: c_int, bytes: []const u8) !void {
    var offset: usize = 0;
    while (offset < bytes.len) {
        const n = c.write(fd, bytes[offset..].ptr, bytes.len - offset);
        if (n < 0) {
            if (std.posix.errno(n) == .INTR) continue;
            return error.WriteFailed;
        }
        if (n == 0) return error.WriteFailed;
        offset += @intCast(n);
    }
}
pub fn nonblock(fd: c_int) void {
    _ = c.fcntl(fd, c.F_SETFL, c.fcntl(fd, c.F_GETFL, @as(c_int, 0)) | c.O_NONBLOCK);
}
pub fn cloexec(fd: c_int) void {
    _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
}
pub fn env(name: [:0]const u8) ?[]const u8 {
    const p = c.getenv(name) orelse return null;
    return std.mem.span(p);
}
pub fn setenv(name: [:0]const u8, value: []const u8) !void {
    const z = try allocator.dupeZ(u8, value);
    defer allocator.free(z);
    if (c.setenv(name, z, 1) != 0) return error.SetEnvFailed;
}
/// A copy of the environment, for editing a child's.
pub fn environMap(alloc: std.mem.Allocator) !std.process.Environ.Map {
    var len: usize = 0;
    while (std.c.environ[len] != null) len += 1;
    const environ: std.process.Environ = .{ .block = .{ .slice = std.c.environ[0..len :null] } };
    return environ.createMap(alloc);
}
/// `path`'s canonical absolute form, relative to `dir`. Unlike
/// `Dir.realPathFileAlloc`'s, the result has no sentinel to free with it.
pub fn realpathAlloc(alloc: std.mem.Allocator, dir: std.Io.Dir, path: []const u8) ![]u8 {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    return alloc.dupe(u8, buf[0..try dir.realPathFile(io(), path, &buf)]);
}
/// Reads the rest of `file`, failing past `max` bytes.
pub fn readToEndAlloc(file: std.Io.File, alloc: std.mem.Allocator, max: usize) ![]u8 {
    var reader = file.readerStreaming(io(), &.{});
    return reader.interface.allocRemaining(alloc, .limited(max + 1));
}
/// What `std.Io` stats leave out: a file's device and owner.
pub const Stat = struct {
    dev: u64,
    ino: u64,
    mode: u32,
    uid: u32,

    pub fn isDir(s: Stat) bool {
        return s.mode & c.S_IFMT == c.S_IFDIR;
    }
    pub fn isFile(s: Stat) bool {
        return s.mode & c.S_IFMT == c.S_IFREG;
    }
};
/// `path` itself, not what a symlink there points to.
pub fn lstat(path: []const u8) !Stat {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    return statAt(c.AT_FDCWD, try std.fmt.bufPrintZ(&buf, "{s}", .{path}));
}
pub fn fstat(fd: c_int) !Stat {
    return statAt(fd, "");
}
fn statAt(dir: c_int, path: [:0]const u8) !Stat {
    if (builtin.os.tag == .linux) {
        const linux = std.os.linux;
        var x: linux.Statx = undefined;
        const flags: u32 = if (path.len == 0) linux.AT.EMPTY_PATH else linux.AT.SYMLINK_NOFOLLOW;
        const rc = linux.statx(dir, path, flags, .{ .TYPE = true, .MODE = true, .UID = true, .INO = true }, &x);
        if (linux.errno(rc) != .SUCCESS) return error.FileNotFound;
        return .{ .dev = @as(u64, x.dev_major) << 32 | x.dev_minor, .ino = x.ino, .mode = x.mode, .uid = x.uid };
    }
    var st: std.c.Stat = undefined;
    const rc = if (path.len == 0) std.c.fstat(dir, &st) else std.c.fstatat(dir, path, &st, std.c.AT.SYMLINK_NOFOLLOW);
    if (rc != 0) return error.FileNotFound;
    return .{ .dev = @bitCast(@as(i64, st.dev)), .ino = st.ino, .mode = st.mode, .uid = st.uid };
}
pub fn processCwd(pid: c_int) ?[]u8 {
    if (builtin.os.tag == .macos) {
        var info: c.struct_proc_vnodepathinfo = undefined;
        if (c.proc_pidinfo(pid, c.PROC_PIDVNODEPATHINFO, 0, &info, @sizeOf(@TypeOf(info))) != @sizeOf(@TypeOf(info))) return null;
        return allocator.dupe(u8, std.mem.sliceTo(&info.pvi_cdir.vip_path, 0)) catch null;
    } else {
        var path: [64]u8 = undefined;
        const link = std.fmt.bufPrint(&path, "/proc/{d}/cwd", .{pid}) catch return null;
        var buf: [4096]u8 = undefined;
        const len = std.Io.Dir.cwd().readLink(io(), link, &buf) catch return null;
        return allocator.dupe(u8, buf[0..len]) catch null;
    }
}
/// A same-user process's arguments, and on request its executable path
/// and initial environment. Slices borrow the caller's buffer.
pub const ProcessArgs = struct {
    argv: [256][]const u8 = undefined,
    argc: usize = 0,
    exe: []const u8 = "",
    env: [512][]const u8 = undefined,
    env_len: usize = 0,
    /// Every argument the kernel counted fit in `argv`. On Linux, false
    /// also when the buffer cut the command line short or the process
    /// rewrote it.
    complete: bool = false,

    pub fn args(p: *const ProcessArgs) []const []const u8 {
        return p.argv[0..p.argc];
    }
    pub fn environ(p: *const ProcessArgs) []const []const u8 {
        return p.env[0..p.env_len];
    }
    fn addEnv(p: *ProcessArgs, entry: []const u8) void {
        if (entry.len == 0 or p.env_len == p.env.len) return;
        p.env[p.env_len] = entry;
        p.env_len += 1;
    }
};
/// Null when the process is gone, not ours, or has no arguments, and on
/// macOS when its arguments and environment don't fit in `buf`.
/// `.env = true` also reads the executable path and environment.
pub fn processArgs(pid: c_int, buf: []u8, want: struct { env: bool = false }) ?ProcessArgs {
    var out: ProcessArgs = .{};
    if (builtin.os.tag == .macos) {
        var mib = [_]c_int{ c.CTL_KERN, c.KERN_PROCARGS2, pid };
        var len: usize = buf.len;
        if (c.sysctl(&mib, mib.len, buf.ptr, &len, null, 0) != 0 or len < @sizeOf(c_int)) return null;
        // The kernel fills a buffer too small for the area with bytes from
        // elsewhere in it, not its start.
        if (len == buf.len) return null;
        const reported = std.mem.bytesToValue(c_int, buf[0..@sizeOf(c_int)]);
        if (reported <= 0) return null;
        const argc: usize = @intCast(reported);
        var data: []const u8 = buf[@sizeOf(c_int)..len];
        // Executable path, alignment padding, then argv and the environment.
        const end = std.mem.indexOfScalar(u8, data, 0) orelse return null;
        if (want.env) out.exe = data[0..end];
        data = std.mem.trimStart(u8, data[end..], "\x00");
        var it = std.mem.splitScalar(u8, data, 0);
        var seen: usize = 0;
        while (seen < argc) : (seen += 1) {
            const arg = it.next() orelse break;
            if (out.argc == out.argv.len) continue;
            out.argv[out.argc] = arg;
            out.argc += 1;
        }
        out.complete = out.argc == argc;
        if (want.env and seen == argc) while (it.next()) |entry| {
            if (entry.len == 0) break;
            out.addEnv(entry);
        };
    } else if (builtin.os.tag == .linux) {
        var path: [64]u8 = undefined;
        var area = buf;
        if (want.env) {
            // The executable path lives past the argument and environment halves.
            if (buf.len <= std.fs.max_path_bytes) return null;
            area = buf[0 .. buf.len - std.fs.max_path_bytes];
            out.exe = processPath(pid, buf[area.len..][0..std.fs.max_path_bytes]) orelse "";
            area = area[0 .. area.len / 2];
        }
        const len = readFile(std.fmt.bufPrint(&path, "/proc/{d}/cmdline", .{pid}) catch return null, area) catch return null;
        if (len == 0) return null;
        // Arguments end in NUL unless the buffer cut them short or the
        // process rewrote them.
        const whole = len < area.len and area[len - 1] == 0;
        var it = std.mem.splitScalar(u8, area[0..if (whole) len - 1 else len], 0);
        while (it.next()) |arg| {
            if (out.argc == out.argv.len) break;
            out.argv[out.argc] = arg;
            out.argc += 1;
        } else out.complete = whole;
        if (want.env) {
            const rest = buf[area.len .. buf.len - std.fs.max_path_bytes];
            const environ = readFile(std.fmt.bufPrint(&path, "/proc/{d}/environ", .{pid}) catch return null, rest) catch return null;
            var env_it = std.mem.splitScalar(u8, rest[0..environ], 0);
            while (env_it.next()) |entry| out.addEnv(entry);
        }
    } else return null;
    return out;
}
test "a process's own arguments, executable and environment are readable" {
    const buf = try std.testing.allocator.alloc(u8, 1024 * 1024);
    defer std.testing.allocator.free(buf);
    const bare = processArgs(c.getpid(), buf, .{}).?;
    try std.testing.expect(bare.argc > 0);
    try std.testing.expect(bare.complete);
    try std.testing.expectEqualStrings("", bare.exe);
    try std.testing.expectEqual(@as(usize, 0), bare.env_len);

    const full = processArgs(c.getpid(), buf, .{ .env = true }).?;
    try std.testing.expect(full.complete);
    try std.testing.expect(full.exe.len > 0);
    try std.testing.expectEqualStrings(std.fs.path.basename(full.exe), std.fs.path.basename(full.args()[0]));
    const home = env("HOME") orelse return error.SkipZigTest;
    var entry: [4096]u8 = undefined;
    const wanted = try std.fmt.bufPrint(&entry, "HOME={s}", .{home});
    var found = false;
    for (full.environ()) |item| found = found or std.mem.eql(u8, item, wanted);
    try std.testing.expect(found);

    // A buffer one byte short of the command line leaves it incomplete on
    // Linux and unreadable on macOS.
    var used: usize = 0;
    for (bare.args()) |arg| used += arg.len + 1;
    const cut = processArgs(c.getpid(), buf[0 .. used - 1], .{});
    if (builtin.os.tag == .macos) try std.testing.expect(cut == null) else try std.testing.expect(!cut.?.complete);
}
/// The executable a process runs, as the kernel resolved it.
pub fn processPath(pid: c_int, buf: *[std.fs.max_path_bytes]u8) ?[]const u8 {
    if (builtin.os.tag == .macos) {
        const n = c.proc_pidpath(pid, buf, buf.len);
        if (n <= 0) return null;
        return std.mem.sliceTo(buf[0..@intCast(n)], 0);
    } else if (builtin.os.tag == .linux) {
        var link: [64]u8 = undefined;
        const path = std.fmt.bufPrint(&link, "/proc/{d}/exe", .{pid}) catch return null;
        const len = std.Io.Dir.cwd().readLink(io(), path, buf) catch return null;
        return buf[0..len];
    }
    return null;
}
/// A process's parent, its process group, and its terminal's foreground
/// group (`tpgid` is not positive without a controlling terminal).
pub const ProcessJob = struct { ppid: c_int, pgid: c_int, tpgid: c_int };
pub fn processJob(pid: c_int) ?ProcessJob {
    if (builtin.os.tag == .macos) {
        var info: c.proc_bsdinfo = undefined;
        if (c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(c.proc_bsdinfo)) != @sizeOf(c.proc_bsdinfo)) return null;
        return .{ .ppid = @intCast(info.pbi_ppid), .pgid = @intCast(info.pbi_pgid), .tpgid = @intCast(info.e_tpgid) };
    } else if (builtin.os.tag == .linux) {
        var path: [64]u8 = undefined;
        var bytes: [1024]u8 = undefined;
        const stat = bytes[0 .. readFile(std.fmt.bufPrint(&path, "/proc/{d}/stat", .{pid}) catch return null, &bytes) catch return null];
        // The command name may contain spaces; fields resume after its ')'.
        const close = std.mem.lastIndexOfScalar(u8, stat, ')') orelse return null;
        // After the state: ppid pgrp session tty_nr tpgid (-1 without a terminal).
        var it = std.mem.tokenizeScalar(u8, stat[close + 1 ..], ' ');
        _ = it.next();
        var fields: [5]c_int = undefined;
        for (&fields) |*field| field.* = std.fmt.parseInt(c_int, it.next() orelse return null, 10) catch return null;
        return .{ .ppid = fields[0], .pgid = fields[1], .tpgid = fields[4] };
    }
    return null;
}
/// Reads `path` into `buf`, stopping at its end or `buf`'s, which suits
/// /proc files that report no size.
pub fn readFile(path: []const u8, buf: []u8) !usize {
    const file = try std.Io.Dir.cwd().openFile(io(), path, .{});
    defer file.close(io());
    var reader = file.readerStreaming(io(), &.{});
    return reader.interface.readSliceShort(buf);
}
test "a process's parent and executable are readable" {
    try std.testing.expectEqual(c.getppid(), processJob(c.getpid()).?.ppid);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    var self: [std.fs.max_path_bytes]u8 = undefined;
    try std.testing.expectEqualStrings(self[0..try std.process.executablePath(io(), &self)], processPath(c.getpid(), &buf).?);
}
/// Executable regular files named `name` in `path_list` (a PATH value), in
/// order. Empty and relative entries are skipped: the daemon's cwd is not a
/// trusted place.
pub const PathSearch = struct {
    name: []const u8,
    dirs: std.mem.SplitIterator(u8, .scalar),

    pub fn init(path_list: []const u8, name: []const u8) PathSearch {
        return .{ .name = name, .dirs = std.mem.splitScalar(u8, path_list, ':') };
    }
    /// The next match, written to `buf`.
    pub fn next(s: *PathSearch, buf: []u8) ?[:0]const u8 {
        while (s.dirs.next()) |dir| {
            if (!std.fs.path.isAbsolute(dir)) continue;
            const path = std.fmt.bufPrintZ(buf, "{s}/{s}", .{ dir, s.name }) catch continue;
            const stat = std.Io.Dir.cwd().statFile(io(), path, .{}) catch continue;
            if (stat.kind == .file and c.access(path.ptr, c.X_OK) == 0) return path;
        }
        return null;
    }
};
/// The first executable regular file named `name` in PATH.
pub fn findExecutable(name: []const u8, buf: []u8) ?[:0]const u8 {
    var search: PathSearch = .init(env("PATH") orelse "", name);
    return search.next(buf);
}
test "PATH search takes absolute entries only" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.createDir(io(), "tool", .default_dir);
    (try tmp.dir.createFile(io(), "plain", .{ .permissions = .fromMode(0o644) })).close(io());
    for ([_][]const u8{ "a/tool", "b/tool" }) |sub| {
        try tmp.dir.createDir(io(), std.fs.path.dirname(sub).?, .default_dir);
        (try tmp.dir.createFile(io(), sub, .{ .permissions = .fromMode(0o755) })).close(io());
    }
    var dir_buf: [std.fs.max_path_bytes]u8 = undefined;
    const root = dir_buf[0..try tmp.dir.realPathFile(io(), ".", &dir_buf)];
    const alloc = std.testing.allocator;
    const relative = try std.fmt.allocPrint(alloc, ".zig-cache/tmp/{s}/a", .{tmp.sub_path});
    defer alloc.free(relative);
    const path_list = try std.fmt.allocPrint(alloc, "::{s}:{s}:{s}/a:{s}/b", .{ relative, root, root, root });
    defer alloc.free(path_list);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    // The relative entry and the root's directory named `tool` don't count.
    var search: PathSearch = .init(path_list, "tool");
    const first = try std.fmt.allocPrint(alloc, "{s}/a/tool", .{root});
    defer alloc.free(first);
    try std.testing.expectEqualStrings(first, search.next(&buf).?);
    const second = try std.fmt.allocPrint(alloc, "{s}/b/tool", .{root});
    defer alloc.free(second);
    try std.testing.expectEqualStrings(second, search.next(&buf).?);
    try std.testing.expectEqual(null, search.next(&buf));
    // Not executable.
    var plain: PathSearch = .init(path_list, "plain");
    try std.testing.expectEqual(null, plain.next(&buf));
}
/// POSIX single-quoted form of `text`.
pub fn shellQuote(alloc: std.mem.Allocator, text: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(alloc, '\'');
    for (text) |ch| if (ch == '\'') try out.appendSlice(alloc, "'\\''") else try out.append(alloc, ch);
    try out.append(alloc, '\'');
    return out.toOwnedSlice(alloc);
}
/// `args` as one command line, backslash-escaped so fish reads it the same
/// as POSIX shells do. Null when an argument is not UTF-8 or holds a
/// control byte, which no quoting makes safe to type.
pub fn shellEscape(alloc: std.mem.Allocator, args: []const []const u8) !?[]u8 {
    var out: std.Io.Writer.Allocating = .init(alloc);
    defer out.deinit();
    for (args, 0..) |arg, i| {
        if (!std.unicode.utf8ValidateSlice(arg)) return null;
        if (i > 0) try out.writer.writeByte(' ');
        if (arg.len == 0) try out.writer.writeAll("''");
        for (arg) |ch| {
            if (ch < 32 or ch == 127) return null;
            // Unquoted escapes work in fish as well as POSIX shells, including
            // literal backslashes, quotes and expansion syntax in arguments.
            if (!std.ascii.isAlphanumeric(ch) and std.mem.indexOfScalar(u8, "_@%+:,./-", ch) == null and ch < 128) try out.writer.writeByte('\\');
            try out.writer.writeByte(ch);
        }
    }
    return try out.toOwnedSlice();
}
test "shell quoting protects arguments containing shell syntax" {
    const alloc = std.testing.allocator;
    const quoted = try shellQuote(alloc, "/tmp/a'b$(echo bad)/corgi");
    defer alloc.free(quoted);
    try std.testing.expectEqualStrings("'/tmp/a'\\''b$(echo bad)/corgi'", quoted);
    const escaped = (try shellEscape(alloc, &.{ "tig", "a b", "a'b", "a\\b", "$(touch nope)", "" })).?;
    defer alloc.free(escaped);
    try std.testing.expectEqualStrings("tig a\\ b a\\'b a\\\\b \\$\\(touch\\ nope\\) ''", escaped);
    try std.testing.expectEqual(null, try shellEscape(alloc, &.{ "tig", "bad\rcommand" }));
    try std.testing.expectEqual(null, try shellEscape(alloc, &.{ "tig", "bad\xffcommand" }));
}
pub fn exec(args: []const []const u8) !noreturn {
    const pointers = try allocator.allocSentinel(?[*:0]const u8, args.len, null);
    for (args, 0..) |arg, i| pointers[i] = (try allocator.dupeZ(u8, arg)).ptr;
    _ = c.execvp(pointers[0].?, @ptrCast(pointers.ptr));
    return error.ExecFailed;
}
pub fn socketPath() ![]const u8 {
    if (env("CORGI_SOCKET")) |p| return allocator.dupe(u8, p);
    return std.fmt.allocPrint(allocator, "/tmp/corgi-{d}/control.sock", .{c.getuid()});
}
pub fn unixAddress(path: []const u8) !c.struct_sockaddr_un {
    var addr = std.mem.zeroes(c.struct_sockaddr_un);
    if (path.len >= addr.sun_path.len) return error.NameTooLong;
    addr.sun_family = c.AF_UNIX;
    @memcpy(addr.sun_path[0..path.len], path);
    return addr;
}
pub fn unixSocket() !c_int {
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM, 0);
    if (fd < 0) return error.SystemResources;
    cloexec(fd);
    return fd;
}
pub fn connect(path: []const u8) !c_int {
    const addr = try unixAddress(path);
    const fd = try unixSocket();
    errdefer _ = c.close(fd);
    while (c.connect(fd, @ptrCast(&addr), @sizeOf(c.struct_sockaddr_un)) != 0) switch (std.posix.errno(-1)) {
        .INTR => {},
        .NOENT => return error.FileNotFound,
        .CONNREFUSED => return error.ConnectionRefused,
        .ACCES, .PERM => return error.AccessDenied,
        else => return error.ConnectFailed,
    };
    const timeout: c.struct_timeval = .{ .tv_sec = 30, .tv_usec = 0 };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(@TypeOf(timeout)));
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(@TypeOf(timeout)));
    return fd;
}
pub fn privateDirectory(parent: []const u8) !void {
    const z = try allocator.dupeZ(u8, parent);
    defer allocator.free(z);
    const stat = lstat(parent) catch existing: {
        try std.Io.Dir.cwd().createDirPath(io(), parent);
        if (c.chmod(z, 0o700) != 0) return error.UnsafeSocketDirectory;
        break :existing lstat(parent) catch return error.UnsafeSocketDirectory;
    };
    if (stat.uid != c.getuid() or !stat.isDir() or (stat.mode & 0o077) != 0) return error.UnsafeSocketDirectory;
}
pub fn listen(path: []const u8) !c_int {
    const parent = std.fs.path.dirname(path) orelse return error.BadSocketPath;
    try privateDirectory(parent);
    const addr = try unixAddress(path);
    const fd = try unixSocket();
    errdefer _ = c.close(fd);
    // Never unlink a live socket. Stale socket recovery belongs to startup.
    if (c.bind(fd, @ptrCast(&addr), @sizeOf(c.struct_sockaddr_un)) != 0) return switch (std.posix.errno(-1)) {
        .ADDRINUSE => error.AddressInUse,
        .ACCES, .PERM => error.AccessDenied,
        else => error.BindFailed,
    };
    if (c.listen(fd, 32) != 0) return error.ListenFailed;
    nonblock(fd);
    return fd;
}
/// The daemon's socket path, deleted on release only if it is still the
/// socket this daemon bound. A successor may already own the path.
pub const SocketPath = struct {
    path: []const u8,
    inode: ?std.Io.File.INode,

    pub fn claim(path: []const u8) SocketPath {
        return .{ .path = path, .inode = inodeOf(path) };
    }
    pub fn release(p: SocketPath) void {
        const bound = p.inode orelse return;
        if (inodeOf(p.path) == bound) std.Io.Dir.cwd().deleteFile(io(), p.path) catch {};
    }
};
fn inodeOf(path: []const u8) ?std.Io.File.INode {
    const stat = std.Io.Dir.cwd().statFile(io(), path, .{ .follow_symlinks = false }) catch return null;
    return stat.inode;
}
test "release leaves a successor's socket in place" {
    var buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, "/tmp/corgi-socketpath-test-{d}.sock", .{c.getpid()});
    const cwd = std.Io.Dir.cwd();
    cwd.deleteFile(io(), path) catch {};
    (try cwd.createFile(io(), path, .{})).close(io());
    defer cwd.deleteFile(io(), path) catch {};

    const claimed = SocketPath.claim(path);
    // A successor already replaced the file at this path.
    try cwd.deleteFile(io(), path);
    (try cwd.createFile(io(), path, .{})).close(io());
    claimed.release();
    (try cwd.openFile(io(), path, .{})).close(io()); // still there

    const reclaimed = SocketPath.claim(path);
    reclaimed.release();
    try std.testing.expectError(error.FileNotFound, cwd.openFile(io(), path, .{}));
}
pub fn sendJson(fd: c_int, value: anytype) !void {
    const data = try std.json.Stringify.valueAlloc(allocator, value, .{});
    defer allocator.free(data);
    try writeAll(fd, data);
    try writeAll(fd, "\n");
}
pub fn readLine(fd: c_int, max: usize) ![]u8 {
    var data: std.ArrayList(u8) = .empty;
    errdefer data.deinit(allocator);
    while (data.items.len < max) {
        var bytes: [8192]u8 = undefined;
        const n = c.read(fd, &bytes, @min(bytes.len, max - data.items.len));
        if (n <= 0) return error.EndOfStream;
        const chunk = bytes[0..@intCast(n)];
        if (std.mem.indexOfScalar(u8, chunk, '\n')) |end| {
            try data.appendSlice(allocator, chunk[0..end]);
            return data.toOwnedSlice(allocator);
        }
        try data.appendSlice(allocator, chunk);
    }
    return error.MessageTooLarge;
}
