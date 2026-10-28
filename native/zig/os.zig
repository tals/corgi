const std = @import("std");
const builtin = @import("builtin");
const corgi_options = @import("corgi_options");
pub const c = @import("c");
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
pub fn milliTimestamp() i64 {
    return std.Io.Timestamp.now(io(), .real).toMilliseconds();
}
pub fn microTimestamp() i64 {
    return std.Io.Timestamp.now(io(), .real).toMicroseconds();
}
/// A cryptographically secure generator, like the old `std.crypto.random`.
pub const random: std.Random = .{ .ptr = undefined, .fillFn = fillRandom };
fn fillRandom(_: *anyopaque, buf: []u8) void {
    io().random(buf);
}
pub fn cloexec(fd: c_int) void {
    _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
}
pub fn env(name: [:0]const u8) ?[]const u8 {
    const p = c.getenv(name) orelse return null;
    return std.mem.span(p);
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
