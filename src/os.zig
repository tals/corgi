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
pub fn processCwd(pid: c_int) ?[]u8 {
    if (builtin.os.tag == .macos) {
        var info: c.struct_proc_vnodepathinfo = undefined;
        if (c.proc_pidinfo(pid, c.PROC_PIDVNODEPATHINFO, 0, &info, @sizeOf(@TypeOf(info))) != @sizeOf(@TypeOf(info))) return null;
        return allocator.dupe(u8, std.mem.sliceTo(&info.pvi_cdir.vip_path, 0)) catch null;
    } else {
        var path: [64]u8 = undefined;
        const link = std.fmt.bufPrint(&path, "/proc/{d}/cwd", .{pid}) catch return null;
        var buf: [4096]u8 = undefined;
        const dir = std.fs.cwd().readLink(link, &buf) catch return null;
        return allocator.dupe(u8, dir) catch null;
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
        const cmdline = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/cmdline", .{pid}) catch return null, .{}) catch return null;
        defer cmdline.close();
        const len = cmdline.readAll(area) catch return null;
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
            const environ = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/environ", .{pid}) catch return null, .{}) catch return null;
            defer environ.close();
            var env_it = std.mem.splitScalar(u8, rest[0 .. environ.readAll(rest) catch return null], 0);
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
    try std.testing.expectEqualStrings(std.mem.span(std.os.argv[0]), full.args()[0]);
    const home = std.posix.getenv("HOME") orelse return error.SkipZigTest;
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
        return std.posix.readlink(path, buf) catch null;
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
        const file = std.fs.cwd().openFile(std.fmt.bufPrint(&path, "/proc/{d}/stat", .{pid}) catch return null, .{}) catch return null;
        defer file.close();
        const stat = bytes[0 .. file.readAll(&bytes) catch return null];
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
test "a process's parent and executable are readable" {
    try std.testing.expectEqual(c.getppid(), processJob(c.getpid()).?.ppid);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    var self: [std.fs.max_path_bytes]u8 = undefined;
    try std.testing.expectEqualStrings(try std.fs.selfExePath(&self), processPath(c.getpid(), &buf).?);
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
pub fn connect(path: []const u8) !c_int {
    const addr = try std.net.Address.initUnix(path);
    const fd = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0);
    errdefer std.posix.close(fd);
    try std.posix.connect(fd, &addr.any, addr.getOsSockLen());
    const timeout: c.struct_timeval = .{ .tv_sec = 30, .tv_usec = 0 };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &timeout, @sizeOf(@TypeOf(timeout)));
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &timeout, @sizeOf(@TypeOf(timeout)));
    return fd;
}
pub fn privateDirectory(parent: []const u8) !void {
    const z = try allocator.dupeZ(u8, parent);
    defer allocator.free(z);
    const existing = std.posix.fstatat(std.posix.AT.FDCWD, parent, std.posix.AT.SYMLINK_NOFOLLOW) catch null;
    const existed = existing != null;
    if (!existed) {
        try std.fs.cwd().makePath(parent);
        if (c.chmod(z, 0o700) != 0) return error.UnsafeSocketDirectory;
    }
    const stat = std.posix.fstatat(std.posix.AT.FDCWD, parent, std.posix.AT.SYMLINK_NOFOLLOW) catch return error.UnsafeSocketDirectory;
    if (stat.uid != c.getuid() or (stat.mode & c.S_IFMT) != c.S_IFDIR or (stat.mode & 0o077) != 0) return error.UnsafeSocketDirectory;
}
pub fn listen(path: []const u8) !c_int {
    const parent = std.fs.path.dirname(path) orelse return error.BadSocketPath;
    try privateDirectory(parent);
    const addr = try std.net.Address.initUnix(path);
    const fd = try std.posix.socket(std.posix.AF.UNIX, std.posix.SOCK.STREAM | std.posix.SOCK.CLOEXEC, 0);
    errdefer std.posix.close(fd);
    // Never unlink a live socket. Stale socket recovery belongs to startup.
    try std.posix.bind(fd, &addr.any, addr.getOsSockLen());
    try std.posix.listen(fd, 32);
    nonblock(fd);
    return fd;
}
/// The daemon's socket path, deleted on release only if it is still the
/// socket this daemon bound. A successor may already own the path.
pub const SocketPath = struct {
    path: []const u8,
    inode: ?std.posix.ino_t,

    pub fn claim(path: []const u8) SocketPath {
        return .{ .path = path, .inode = inodeOf(path) };
    }
    pub fn release(p: SocketPath) void {
        const bound = p.inode orelse return;
        if (inodeOf(p.path) == bound) std.fs.cwd().deleteFile(p.path) catch {};
    }
};
fn inodeOf(path: []const u8) ?std.posix.ino_t {
    const stat = std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch return null;
    return stat.ino;
}
test "release leaves a successor's socket in place" {
    var buf: [64]u8 = undefined;
    const path = try std.fmt.bufPrint(&buf, "/tmp/corgi-socketpath-test-{d}.sock", .{c.getpid()});
    std.fs.cwd().deleteFile(path) catch {};
    (try std.fs.cwd().createFile(path, .{})).close();
    defer std.fs.cwd().deleteFile(path) catch {};

    const claimed = SocketPath.claim(path);
    // A successor already replaced the file at this path.
    try std.fs.cwd().deleteFile(path);
    (try std.fs.cwd().createFile(path, .{})).close();
    claimed.release();
    (try std.fs.cwd().openFile(path, .{})).close(); // still there

    const reclaimed = SocketPath.claim(path);
    reclaimed.release();
    try std.testing.expectError(error.FileNotFound, std.fs.cwd().openFile(path, .{}));
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
