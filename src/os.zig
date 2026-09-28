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
