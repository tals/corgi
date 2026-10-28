//! Fixed-size FFI over platform socket, terminal and process APIs.
const std = @import("std");
const builtin = @import("builtin");
const c = @import("c");

fn errno() c_int {
    return @intFromEnum(std.posix.errno(-1));
}

fn controlData(header: [*c]c.struct_cmsghdr) [*]u8 {
    return @as([*]u8, @ptrCast(header)) + c.CMSG_LEN(0);
}

pub export fn probe_pair(fds: [*]c_int) c_int {
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, fds) != 0) return -1;
    for (fds[0..2]) |fd| _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    return 0;
}

pub export fn probe_pty(fds: [*]c_int) c_int {
    var ws: c.struct_winsize = .{ .ws_row = 40, .ws_col = 120, .ws_xpixel = 0, .ws_ypixel = 0 };
    if (c.openpty(&fds[0], &fds[1], null, null, &ws) != 0) return -1;
    for (fds[0..2]) |fd| _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    _ = c.fcntl(fds[0], c.F_SETFL, @as(c_int, c.O_NONBLOCK));
    return 0;
}

pub export fn probe_nonblock(fd: c_int) c_int {
    return c.fcntl(fd, c.F_SETFL, c.fcntl(fd, c.F_GETFL) | @as(c_int, c.O_NONBLOCK));
}

pub export fn probe_close(fd: c_int) c_int {
    return c.close(fd);
}

pub export fn probe_read(fd: c_int, data: ?*anyopaque, cap: c_int) c_int {
    const n = c.read(fd, data, @intCast(cap));
    return if (n < 0) -errno() else @intCast(n);
}

pub export fn probe_peek(fd: c_int, data: ?*anyopaque, cap: c_int) c_int {
    const n = c.recv(fd, data, @intCast(cap), c.MSG_PEEK);
    return if (n < 0) -errno() else @intCast(n);
}

pub export fn probe_isatty(fd: c_int) c_int {
    return c.isatty(fd);
}

pub export fn probe_write(fd: c_int, data: ?*const anyopaque, len: c_int) c_int {
    const n = c.write(fd, data, @intCast(len));
    return if (n < 0) -errno() else @intCast(n);
}

pub export fn probe_resize(fd: c_int, cols: c_int, rows: c_int) c_int {
    var ws: c.struct_winsize = .{ .ws_row = @intCast(rows), .ws_col = @intCast(cols), .ws_xpixel = 0, .ws_ypixel = 0 };
    return c.ioctl(fd, c.TIOCSWINSZ, &ws);
}

/// Columns, rows, then the window's pixels across and down (0 when unknown).
pub export fn probe_winsize_pixels(fd: c_int, size: [*]u16) c_int {
    var ws: c.struct_winsize = undefined;
    if (c.ioctl(fd, c.TIOCGWINSZ, &ws) != 0) return -errno();
    size[0..4].* = .{ ws.ws_col, ws.ws_row, ws.ws_xpixel, ws.ws_ypixel };
    return 0;
}

pub export fn probe_winsize(fd: c_int, size: [*]u16) c_int {
    var ws: c.struct_winsize = undefined;
    if (c.ioctl(fd, c.TIOCGWINSZ, &ws) != 0) return -errno();
    size[0..2].* = .{ ws.ws_col, ws.ws_row };
    return 0;
}

// Test fixture children execute async-signal-safe libc calls, never JS.
pub export fn probe_fixture_children(pids: [*]c_int) c_int {
    const exited = c.fork();
    if (exited == 0) c._exit(0);
    if (exited < 0) return -errno();
    var status: c.siginfo_t = undefined;
    if (c.waitid(c.P_PID, @intCast(exited), &status, c.WEXITED | c.WNOWAIT) != 0) return -errno();
    const running = c.fork();
    if (running == 0) while (true) {
        _ = c.pause();
    };
    if (running < 0) {
        _ = c.waitpid(exited, null, 0);
        return -errno();
    }
    pids[0..2].* = .{ exited, running };
    return 0;
}

pub export fn probe_wait_child(pid: c_int) c_int {
    return c.waitpid(pid, null, 0);
}

pub export fn probe_fixture_exit(code: c_int) c_int {
    const pid = c.fork();
    if (pid == 0) c._exit(code);
    if (pid < 0) return -errno();
    var status: c.siginfo_t = undefined;
    if (c.waitid(c.P_PID, @intCast(pid), &status, c.WEXITED | c.WNOWAIT) != 0) return -errno();
    return pid;
}

pub export fn probe_foreground(fd: c_int) c_int {
    return c.tcgetpgrp(fd);
}

pub export fn probe_getpgrp() c_int {
    return c.getpgrp();
}

pub export fn probe_dup_above(fd: c_int, minimum: c_int) c_int {
    return c.fcntl(fd, c.F_DUPFD_CLOEXEC, minimum);
}

/// The account's login shell, from Directory Services, NSS or /etc/passwd.
pub export fn probe_login_shell(buffer: [*]u8, cap: c_int) c_int {
    const user = c.getpwuid(c.getuid());
    if (user == null or user.*.pw_shell == null) return -c.ENOENT;
    const shell = std.mem.span(user.*.pw_shell);
    if (shell.len >= @as(usize, @intCast(cap))) return -c.ENAMETOOLONG;
    @memcpy(buffer[0..shell.len], shell);
    return @intCast(shell.len);
}

pub export fn probe_send(sock: c_int, fds: [*]const c_int, count: c_int) c_int {
    if (count < 1 or count > 64) return -1;
    var payload: u8 = 'F';
    var io: c.struct_iovec = .{ .iov_base = &payload, .iov_len = 1 };
    var control: [c.CMSG_SPACE(64 * @sizeOf(c_int))]u8 align(@alignOf(c.struct_cmsghdr)) = @splat(0);
    var msg = std.mem.zeroes(c.struct_msghdr);
    msg.msg_iov = &io;
    msg.msg_iovlen = 1;
    msg.msg_control = &control;
    const bytes = @as(usize, @intCast(count)) * @sizeOf(c_int);
    msg.msg_controllen = @intCast(c.CMSG_SPACE(bytes));
    const header = c.CMSG_FIRSTHDR(&msg);
    header.*.cmsg_level = c.SOL_SOCKET;
    header.*.cmsg_type = c.SCM_RIGHTS;
    header.*.cmsg_len = @intCast(c.CMSG_LEN(bytes));
    @memcpy(controlData(header)[0..bytes], @as([*]const u8, @ptrCast(fds))[0..bytes]);
    return if (c.sendmsg(sock, &msg, c.MSG_NOSIGNAL) == 1) 0 else -errno();
}

pub export fn probe_recv(sock: c_int, fds: [*]c_int, cap: c_int) c_int {
    var payload: u8 = undefined;
    var io: c.struct_iovec = .{ .iov_base = &payload, .iov_len = 1 };
    var control: [c.CMSG_SPACE(64 * @sizeOf(c_int))]u8 align(@alignOf(c.struct_cmsghdr)) = @splat(0);
    var msg = std.mem.zeroes(c.struct_msghdr);
    msg.msg_iov = &io;
    msg.msg_iovlen = 1;
    msg.msg_control = &control;
    msg.msg_controllen = control.len;
    if (c.recvmsg(sock, &msg, 0) != 1) return -errno();
    if (msg.msg_flags & c.MSG_CTRUNC != 0) return -1;
    const header = c.CMSG_FIRSTHDR(&msg);
    if (header == null or header.*.cmsg_level != c.SOL_SOCKET or header.*.cmsg_type != c.SCM_RIGHTS) return -1;
    const count = (header.*.cmsg_len - c.CMSG_LEN(0)) / @sizeOf(c_int);
    const received: [*]c_int = @ptrCast(@alignCast(controlData(header)));
    if (@as(c_int, @intCast(count)) > cap) {
        for (received[0..count]) |fd| _ = c.close(fd);
        return -1;
    }
    @memcpy(fds[0..count], received[0..count]);
    for (fds[0..count]) |fd| _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    return @intCast(count);
}

pub export fn probe_connect(path: [*:0]const u8) c_int {
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM, 0);
    if (fd < 0) return -errno();
    _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    var addr = std.mem.zeroes(c.struct_sockaddr_un);
    addr.sun_family = c.AF_UNIX;
    const name = std.mem.span(path);
    if (name.len >= addr.sun_path.len) {
        _ = c.close(fd);
        return -c.ENAMETOOLONG;
    }
    @memcpy(addr.sun_path[0..name.len], name);
    if (c.connect(fd, @ptrCast(&addr), @sizeOf(@TypeOf(addr))) != 0) {
        const err = errno();
        _ = c.close(fd);
        return -err;
    }
    return fd;
}

pub export fn probe_listen(path: [*:0]const u8) c_int {
    const fd = c.socket(c.AF_UNIX, c.SOCK_STREAM, 0);
    if (fd < 0) return -errno();
    _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    var addr = std.mem.zeroes(c.struct_sockaddr_un);
    addr.sun_family = c.AF_UNIX;
    const name = std.mem.span(path);
    if (name.len >= addr.sun_path.len) {
        _ = c.close(fd);
        return -1;
    }
    @memcpy(addr.sun_path[0..name.len], name);
    if (c.bind(fd, @ptrCast(&addr), @sizeOf(@TypeOf(addr))) != 0 or c.listen(fd, 8) != 0) {
        const err = errno();
        _ = c.close(fd);
        return -err;
    }
    return fd;
}

pub export fn probe_accept(fd: c_int) c_int {
    const peer = c.accept(fd, null, null);
    if (peer >= 0) _ = c.fcntl(peer, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    return peer;
}

pub export fn probe_pipe(fds: [*]c_int) c_int {
    if (c.pipe(fds) != 0) return -errno();
    for (fds[0..2]) |fd| _ = c.fcntl(fd, c.F_SETFD, @as(c_int, c.FD_CLOEXEC));
    return 0;
}

/// Process-group inventory; provider policy stays in TypeScript.
pub export fn probe_group_pids(pgid: c_int, pids: [*]c_int, cap: c_int) c_int {
    if (builtin.os.tag == .macos) {
        const bytes = c.proc_listpids(c.PROC_PGRP_ONLY, @bitCast(pgid), pids, cap * @as(c_int, @sizeOf(c_int)));
        return if (bytes < 0) -errno() else @divTrunc(bytes, @sizeOf(c_int));
    } else if (builtin.os.tag == .linux) {
        if (pgid <= 0 or cap < 0) return -c.EINVAL;
        const directory = c.opendir("/proc") orelse return -errno();
        defer _ = c.closedir(directory);
        var count: usize = 0;
        while (count < @as(usize, @intCast(cap))) {
            const entry = c.readdir(directory);
            if (entry == null) break;
            var end: [*c]u8 = undefined;
            const pid = c.strtol(@ptrCast(&entry.*.d_name), &end, 10);
            if (end[0] != 0 or pid <= 0 or pid > std.math.maxInt(c_int)) continue;
            if (c.getpgid(@intCast(pid)) == pgid) {
                pids[count] = @intCast(pid);
                count += 1;
            }
        }
        return @intCast(count);
    } else return -c.ENOSYS;
}

/// Parent PID, process group and foreground process group.
pub export fn probe_process_job(pid: c_int, values: [*]c_int) c_int {
    if (builtin.os.tag != .macos) return -c.ENOSYS;
    var bsd: c.struct_proc_bsdinfo = undefined;
    if (c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &bsd, @sizeOf(@TypeOf(bsd))) != @sizeOf(@TypeOf(bsd))) return -1;
    values[0..3].* = .{ @bitCast(bsd.pbi_ppid), @bitCast(bsd.pbi_pgid), @bitCast(bsd.e_tpgid) };
    return 0;
}

pub export fn probe_process_args(pid: c_int, buffer: [*]u8, cap: usize) i64 {
    if (builtin.os.tag != .macos) return -c.ENOSYS;
    var mib = [_]c_int{ c.CTL_KERN, c.KERN_PROCARGS2, pid };
    var size = cap;
    if (c.sysctl(&mib, mib.len, buffer, &size, null, 0) != 0) return -1;
    return @intCast(size);
}

pub export fn probe_macos_process(pid: c_int, values: [*]u64, cwd: [*]u8, exe: [*]u8, args: [*]u8, cap: c_int) c_int {
    if (builtin.os.tag != .macos) return 0;
    var flags: c_int = 0;
    var bsd: c.struct_proc_bsdinfo = undefined;
    if (c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &bsd, @sizeOf(@TypeOf(bsd))) == @sizeOf(@TypeOf(bsd))) {
        values[0] = bsd.pbi_ppid;
        values[1] = bsd.pbi_pgid;
        values[2] = bsd.pbi_start_tvsec * 1000000 + bsd.pbi_start_tvusec;
        flags |= 1;
    }
    var path: c.struct_proc_vnodepathinfo = undefined;
    if (c.proc_pidinfo(pid, c.PROC_PIDVNODEPATHINFO, 0, &path, @sizeOf(@TypeOf(path))) == @sizeOf(@TypeOf(path))) {
        const name = std.mem.sliceTo(&path.pvi_cdir.vip_path, 0);
        if (name.len < @as(usize, @intCast(cap))) {
            @memcpy(cwd[0..name.len], name);
            cwd[name.len] = 0;
            flags |= 4;
        }
    }
    if (c.proc_pidpath(pid, exe, @intCast(@min(cap, c.PROC_PIDPATHINFO_MAXSIZE))) > 0) flags |= 8;
    var mib = [_]c_int{ c.CTL_KERN, c.KERN_PROCARGS2, pid };
    var size: usize = @intCast(cap);
    if (c.sysctl(&mib, mib.len, args, &size, null, 0) == 0) flags |= 16;
    return flags;
}

/// A process's working directory, NUL-terminated, or -1.
pub export fn probe_process_cwd(pid: c_int, cwd: [*]u8, cap: c_int) c_int {
    if (builtin.os.tag != .macos) return -1;
    var path: c.struct_proc_vnodepathinfo = undefined;
    if (c.proc_pidinfo(pid, c.PROC_PIDVNODEPATHINFO, 0, &path, @sizeOf(@TypeOf(path))) != @sizeOf(@TypeOf(path))) return -1;
    const name = std.mem.sliceTo(&path.pvi_cdir.vip_path, 0);
    if (name.len >= @as(usize, @intCast(cap))) return -1;
    @memcpy(cwd[0..name.len], name);
    cwd[name.len] = 0;
    return @intCast(name.len);
}

/// Whether fd takes output now, waiting up to `ms` (0 polls once).
pub export fn probe_writable(fd: c_int, ms: c_int) c_int {
    var p: c.struct_pollfd = .{ .fd = fd, .events = c.POLLOUT, .revents = 0 };
    return @intFromBool(c.poll(&p, 1, ms) > 0 and p.revents & c.POLLOUT != 0);
}
