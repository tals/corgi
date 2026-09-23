//! Single-writer, two-phase daemon replacement. The forked candidate inherits
//! only allowlisted descriptors and cannot read/write them before commit. Any
//! pre-commit failure kills only the candidate; the source keeps serving.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const cp = @import("checkpoint.zig");
const binary = @import("replay.zig");
const controller = @import("controller.zig");
const Server = @import("server.zig").Server;
const SavedClient = struct {
    fd: i32,
    input: []const u8,
    output: []const u8,
    viewer: bool,
    viewer_id: u32,
    can_relaunch: bool = false,
    view_workspace: u32,
    view_focus: ?u32,
    interests: []const controller.Interest,
    watched: bool,
    controls: []const controller.Control,
    next_control: u64,
    last_control: u64,
    protocol_version: ?u32,
    subscribed: bool,
    snapshot_revision: ?u64,
    touched: i64,
};
const Manifest = struct {
    version: u32 = 1,
    terminal_abi: u64 = @import("corgi_options").terminal_checkpoint_abi,
    listener: i32,
    requester: i32,
    runtime: cp.State,
    clients: []const SavedClient,
    theme: @import("theme.zig").Theme,
    width: u16,
    height: u16,
    default_folder_pending: bool,
    next_viewer: u32,
    bell_seq: u64,
    last_bell: i64,
    last_bell_kind: @import("agents.zig").Attention,
};
fn timeout(fd: c_int) void {
    const value: c.struct_timeval = .{ .tv_sec = 15, .tv_usec = 0 };
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_RCVTIMEO, &value, @sizeOf(@TypeOf(value)));
    _ = c.setsockopt(fd, c.SOL_SOCKET, c.SO_SNDTIMEO, &value, @sizeOf(@TypeOf(value)));
}
fn inherit(fd: c_int) void {
    if (fd >= 0) _ = c.fcntl(fd, c.F_SETFD, @as(c_int, 0));
}
pub fn replace(s: *Server, listener: c_int, executable: []const u8, requester: c_int) !noreturn {
    // Keep the saved context current even if the machine fails during reload.
    try @import("recovery.zig").save(&s.runtime, s.socket);
    const deadline = std.time.milliTimestamp() + 1500;
    while (true) {
        var pending = false;
        for (s.runtime.panes.items) |p| {
            p.terminal.flush();
            pending = pending or p.terminal.pending.items.len > 0;
        }
        for (s.runtime.sessions.items) |*n| {
            n.flush();
            pending = pending or (!n.exited and n.output.items.len > 0);
        }
        if (!pending) break;
        if (std.time.milliTimestamp() >= deadline) return error.ReloadInputBackpressure;
        _ = c.poll(null, 0, 5);
    }
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const clients = try alloc.alloc(SavedClient, s.clients.items.len);
    for (s.clients.items, clients) |cl, *out| out.* = .{ .fd = cl.fd, .input = try binary.encode(alloc, cl.input.items), .output = try binary.encode(alloc, cl.output.items[cl.sent..]), .viewer = cl.viewer, .viewer_id = cl.viewer_id, .can_relaunch = cl.can_relaunch, .view_workspace = cl.view_workspace, .view_focus = cl.view_focus, .interests = cl.interests[0..cl.interest_count], .watched = cl.watched, .controls = cl.controls.items, .next_control = cl.next_control, .last_control = cl.last_control, .protocol_version = cl.protocol_version, .subscribed = cl.subscribed, .snapshot_revision = cl.snapshot_revision, .touched = cl.touched };
    const manifest: Manifest = .{ .listener = listener, .requester = requester, .runtime = try cp.capture(alloc, &s.runtime, true), .clients = clients, .theme = s.theme, .width = s.width, .height = s.height, .default_folder_pending = s.default_folder_pending, .next_viewer = s.next_viewer, .bell_seq = s.bell_seq, .last_bell = s.last_bell, .last_bell_kind = s.last_bell_kind };
    const bytes = try std.json.Stringify.valueAlloc(alloc, manifest, .{});
    if (bytes.len > 256 * 1024 * 1024) return error.CheckpointTooLarge;
    const name = try std.fmt.allocPrint(alloc, "{s}.handoff-{d}-{x}", .{ s.socket, c.getpid(), std.crypto.random.int(u64) });
    const file = try std.fs.cwd().createFile(name, .{ .mode = 0o600, .read = true, .exclusive = true });
    defer file.close();
    // Anonymous after creation: it cannot survive a crash or be mistaken for a
    // disk recovery file containing usable descriptors.
    try std.fs.cwd().deleteFile(name);
    try file.writeAll(bytes);
    try file.seekTo(0);
    var pair: [2]c_int = undefined;
    if (c.socketpair(c.AF_UNIX, c.SOCK_STREAM, 0, &pair) != 0) return error.SocketPairFailed;
    defer _ = c.close(pair[0]);
    defer _ = c.close(pair[1]);
    os.cloexec(pair[0]);
    os.cloexec(pair[1]);
    timeout(pair[0]);
    timeout(pair[1]);
    const state_arg = try std.fmt.allocPrint(alloc, "{d}", .{file.handle});
    const control_arg = try std.fmt.allocPrint(alloc, "{d}", .{pair[1]});
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = c.close(pair[0]);
        inherit(file.handle);
        inherit(pair[1]);
        inherit(listener);
        for (s.clients.items) |cl| inherit(cl.fd);
        for (s.runtime.panes.items) |p| inherit(p.terminal.fd);
        for (s.runtime.sessions.items) |n| {
            if (n.child.stdin) |f| inherit(f.handle);
            if (n.child.stdout) |f| inherit(f.handle);
        }
        os.exec(&.{ executable, "__handoff", state_arg, control_arg }) catch c._exit(127);
    }
    errdefer {
        _ = c.kill(pid, c.SIGKILL);
        var status: c_int = 0;
        _ = c.waitpid(pid, &status, 0);
    }
    // Close the local duplicate so failed exec/import produces EOF immediately.
    _ = c.close(pair[1]);
    pair[1] = -1;
    const ready = os.readLine(pair[0], 1024) catch return error.ReloadCandidateFailed;
    defer a.free(ready);
    if (!std.mem.eql(u8, ready, "ready")) {
        std.log.err("reload candidate: {s}", .{ready});
        return error.ReloadCandidateFailed;
    }
    try os.writeAll(pair[0], "commit\n");
    // Commit is the irreversible ownership point. Do not run destructive runtime
    // cleanup or unlink the shared listener. The candidate already has everything.
    c._exit(0);
}
pub fn importAndRun(socket: []const u8, executable: []const u8, state_fd: c_int, control_fd: c_int) noreturn {
    _ = c.signal(c.SIGPIPE, os.sig_ignore);
    importInner(socket, executable, state_fd, control_fd) catch |err| {
        os.writeAll(control_fd, @errorName(err)) catch {};
        os.writeAll(control_fd, "\n") catch {};
        // Never kill processes or close their PTYs through runtime destructors
        // before ownership has committed. _exit only closes our duplicates.
        c._exit(1);
    };
    c._exit(0);
}
fn importInner(socket: []const u8, executable: []const u8, state_fd: c_int, control_fd: c_int) !void {
    os.cloexec(state_fd);
    os.cloexec(control_fd);
    var s: Server = undefined;
    {
        const file: std.fs.File = .{ .handle = state_fd };
        const bytes = try file.readToEndAlloc(a, 256 * 1024 * 1024);
        defer a.free(bytes);
        file.close();
        const parsed = try std.json.parseFromSlice(Manifest, a, bytes, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const m = parsed.value;
        if (m.version != 1 or m.terminal_abi != @import("corgi_options").terminal_checkpoint_abi or m.clients.len > 32) return error.IncompatibleCheckpoint;
        s = .{ .socket = socket, .executable = executable, .inherited_listener = m.listener, .theme = m.theme, .width = m.width, .height = m.height, .default_folder_pending = m.default_folder_pending, .next_viewer = m.next_viewer, .bell_seq = m.bell_seq, .last_bell = m.last_bell, .last_bell_kind = m.last_bell_kind };
        os.cloexec(m.listener);
        try cp.restore(&s.runtime, m.runtime, true, socket, executable);
        for (m.clients) |saved| {
            if (saved.interests.len > @import("layout.zig").max_panes) return error.InvalidCheckpoint;
            var cl: controller.Client = .{ .fd = saved.fd, .viewer = saved.viewer, .viewer_id = saved.viewer_id, .can_relaunch = saved.can_relaunch, .view_workspace = saved.view_workspace, .view_focus = saved.view_focus, .watched = saved.watched, .next_control = saved.next_control, .last_control = saved.last_control, .protocol_version = saved.protocol_version, .subscribed = saved.subscribed, .snapshot_revision = saved.snapshot_revision, .touched = std.time.milliTimestamp() };
            cl.input = .fromOwnedSlice(try binary.decode(a, saved.input));
            cl.output = .fromOwnedSlice(try binary.decode(a, saved.output));
            cl.interest_count = saved.interests.len;
            @memcpy(cl.interests[0..cl.interest_count], saved.interests);
            for (saved.controls) |control| {
                var item = control;
                item.name = try a.dupe(u8, control.name);
                item.value = try a.dupe(u8, control.value);
                try cl.controls.append(a, item);
            }
            os.cloexec(cl.fd);
            try s.clients.append(a, cl);
        }
        // Queue success only in the candidate, before readiness (allocation can fail).
        for (s.clients.items) |*cl| if (cl.fd == m.requester) try cl.queue(.{ .ok = true, .server_pid = c.getpid(), .panes = s.runtime.panes.items.len });
        try os.writeAll(control_fd, "ready\n");
        const commit = try os.readLine(control_fd, 32);
        defer a.free(commit);
        if (!std.mem.eql(u8, commit, "commit")) return error.ReloadNotCommitted;
        _ = c.close(control_fd);
    }
    // All subsequent cleanup belongs to the new owner.
    try s.run();
}
