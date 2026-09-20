const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
const integration = @import("integration.zig");
pub var build_id: [64]u8 = undefined;
pub fn main() void {
    run() catch |err| {
        if (err == error.ReloadProtocolUnavailable) {
            std.debug.print("corgi: this daemon predates live handoff. Save work and perform one ordinary restart from outside Corgi. The current daemon and panes were left running.\n", .{});
        } else if (err == error.ViewerProtocolUnavailable) {
            std.debug.print("corgi: this daemon needs one update to support local viewers. Save work and restart it from outside Corgi; later UI changes only need a new viewer.\n", .{});
        } else if (err == error.DetachAndReattachViewerOnce) {
            std.debug.print("corgi: this viewer predates automatic relaunch. Detach once with Ctrl-B q, then run ./go.sh from the outer terminal. Your panes remain running.\n", .{});
        } else if (err == error.AmbiguousViewer) {
            std.debug.print("corgi: multiple viewers are focused on this pane. Detach the intended viewer with Ctrl-B q and run ./go.sh from its terminal.\n", .{});
        } else if (err == error.NestedCorgi) {
            std.debug.print("corgi: cannot attach inside a Corgi pane; detach first or use another terminal.\n", .{});
        } else {
            std.debug.print("corgi: {s}\n", .{@errorName(err)});
        }
        std.process.exit(1);
    };
}
fn run() !void {
    const args = try std.process.argsAlloc(a);
    defer std.process.argsFree(a, args);
    const cmd = if (args.len > 1) args[1] else "attach";
    const path = try os.socketPath();
    defer a.free(path);
    const exe = try std.fs.selfExePathAlloc(a);
    defer a.free(exe);
    if (eq(std.fs.path.basename(args[0]), "codex")) try integration.launch("codex", args[1..], exe);
    if (eq(cmd, "attach") and os.env("CORGI_PANE") != null) return error.NestedCorgi;
    if (eq(cmd, "serve") or eq(cmd, "__handoff") or eq(cmd, "dev")) {
        var file = try std.fs.openFileAbsolute(exe, .{});
        defer file.close();
        var hash = std.crypto.hash.sha2.Sha256.init(.{});
        var buffer: [65536]u8 = undefined;
        while (true) {
            const n = try file.read(&buffer);
            if (n == 0) break;
            hash.update(buffer[0..n]);
        }
        build_id = std.fmt.bytesToHex(hash.finalResult(), .lower);
    }
    if (eq(cmd, "dev")) {
        try ensureServer(path, exe);
        const fd = try os.connect(path);
        defer _ = c.close(fd);
        var conn: @import("rpc.zig").Connection = .{ .fd = fd };
        const hello = try conn.call(.{ .op = "hello", .protocol = 1 });
        defer hello.deinit();
        if (!eq(agents.str(hello.value, "build_id"), &build_id)) try reload(path, exe);
        if (os.env("CORGI_PANE")) |pane| {
            return request(path, .{ .op = "action", .name = "relaunch", .value = exe, .pane = try std.fmt.parseInt(u32, pane, 10) }, false);
        }
        return @import("client.zig").attach(path);
    }
    if (eq(cmd, "--help") or eq(cmd, "help")) return os.writeAll(1, help);
    if (eq(cmd, "--version")) return os.writeAll(1, "corgi 0.1.0 (Ghostty VT; Zig 0.15.2)\n");
    if (eq(cmd, "which")) {
        if (args.len != 3) return error.Usage;
        const provider = std.meta.stringToEnum(agents.Provider, args[2]) orelse return error.BadProvider;
        const binary = try @import("discovery.zig").resolve(provider, null);
        defer a.free(binary);
        try os.writeAll(1, binary);
        return os.writeAll(1, "\n");
    }
    if (@import("corgi_options").viewer_test_driver and eq(cmd, "__viewer-test")) return @import("viewer_test.zig").run(path);
    if (eq(cmd, "__handoff")) {
        if (args.len != 4) return error.Usage;
        @import("handoff.zig").importAndRun(path, exe, try std.fmt.parseInt(c_int, args[2], 10), try std.fmt.parseInt(c_int, args[3], 10));
    }
    if (eq(cmd, "reload")) {
        if (args.len > 3) return error.Usage;
        return reload(path, if (args.len == 3) args[2] else exe);
    }
    if (eq(cmd, "checkpoint")) return request(path, .{ .op = "recovery.save", .protocol = 1 }, false);
    if (eq(cmd, "serve")) {
        var server: @import("server.zig").Server = .{ .socket = path, .executable = exe };
        return server.run();
    }
    if (eq(cmd, "hook")) {
        if (args.len != 3) return error.Usage;
        integration.hook(args[2], path) catch {};
        return;
    }
    if (eq(cmd, "hooks")) {
        if (args.len != 3) return error.Usage;
        const config = try integration.config(args[2], exe);
        defer a.free(config);
        try os.writeAll(1, config);
        return os.writeAll(1, "\n");
    }
    if (eq(cmd, "agent")) {
        if (args.len < 3) return error.Usage;
        try integration.launch(args[2], args[3..], exe);
    }
    if (eq(cmd, "workspace")) {
        if (args.len < 3) return error.Usage;
        try ensureServer(path, exe);
        if (eq(args[2], "list")) return request(path, .{ .op = "workspace.list" }, false);
        if (eq(args[2], "new")) {
            if (args.len < 4 or args.len > 5) return error.Usage;
            const cwd = if (args.len == 5) try @import("workspace.zig").Store.directory(args[4]) else try a.dupe(u8, "");
            defer a.free(cwd);
            return request(path, .{ .op = "workspace.new", .name = args[3], .cwd = cwd }, false);
        }
        if (args.len < 4) return error.Usage;
        const id = try std.fmt.parseInt(u32, args[3], 10);
        if (eq(args[2], "switch")) return request(path, .{ .op = "workspace.switch", .workspace = id }, false);
        if (eq(args[2], "close")) return request(path, .{ .op = "workspace.close", .workspace = id }, false);
        if (eq(args[2], "edit") and args.len == 6) {
            const cwd = try @import("workspace.zig").Store.directory(args[5]);
            defer a.free(cwd);
            return request(path, .{ .op = "workspace.edit", .workspace = id, .name = args[4], .cwd = cwd }, false);
        }
        return error.Usage;
    }
    if (eq(cmd, "native")) {
        if (args.len < 3) return error.Usage;
        if (eq(args[2], "start")) {
            if (args.len != 4) return error.Usage;
            try ensureServer(path, exe);
            const cwd = try std.process.getCwdAlloc(a);
            defer a.free(cwd);
            return request(path, .{ .op = "native.start", .provider = args[3], .cwd = cwd }, false);
        }
        if (eq(args[2], "list")) return request(path, .{ .op = "native.list" }, false);
        if (args.len < 4) return error.Usage;
        const id = try std.fmt.parseInt(u32, args[3], 10);
        if (eq(args[2], "events")) return request(path, .{ .op = "native.events", .session = id, .after = if (args.len > 4) try std.fmt.parseInt(u64, args[4], 10) else 0 }, false);
        if (eq(args[2], "stop")) return request(path, .{ .op = "native.stop", .session = id }, false);
        if (eq(args[2], "send") and args.len == 5) {
            const msg = try std.json.parseFromSlice(std.json.Value, a, args[4], .{});
            defer msg.deinit();
            return request(path, .{ .op = "native.send", .session = id, .message = msg.value }, false);
        }
        return error.Usage;
    }
    if (eq(cmd, "attach") or eq(cmd, "start") or eq(cmd, "new") or eq(cmd, "split")) try ensureServer(path, exe);
    if (eq(cmd, "attach")) return @import("client.zig").attach(path);
    if (eq(cmd, "start")) return;
    if (eq(cmd, "list") or eq(cmd, "ping") or eq(cmd, "shutdown")) return request(path, .{ .op = cmd }, false);
    if (eq(cmd, "new") or eq(cmd, "split")) {
        const split = eq(cmd, "split");
        const command_index: usize = if (split) 3 else 2;
        const command = if (args.len > command_index) args[command_index] else "";
        return request(path, .{ .op = cmd, .axis = if (split and args.len > 2) args[2] else "right", .command = command }, false);
    }
    if (eq(cmd, "focus") or eq(cmd, "close") or eq(cmd, "read") or eq(cmd, "send")) {
        if (args.len < 3) return error.Usage;
        const id = try std.fmt.parseInt(u32, args[2], 10);
        if (eq(cmd, "send") and args.len < 4) return error.Usage;
        return request(path, .{ .op = cmd, .pane = id, .text = if (args.len > 3) args[3] else "", .enter = args.len > 4 and eq(args[4], "--enter") }, eq(cmd, "read"));
    }
    if (eq(cmd, "action")) {
        if (args.len < 3) return error.Usage;
        return request(path, .{ .op = "action", .name = args[2], .value = if (args.len > 3) args[3] else "" }, false);
    }
    if (eq(cmd, "rpc")) {
        if (args.len != 3) return error.Usage;
        const parsed = try std.json.parseFromSlice(std.json.Value, a, args[2], .{});
        defer parsed.deinit();
        return request(path, parsed.value, false);
    }
    return error.UnknownCommand;
}
fn reload(path: []const u8, executable: []const u8) !void {
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    var conn: @import("rpc.zig").Connection = .{ .fd = fd };
    const hello = try conn.call(.{ .op = "hello", .protocol = 1 });
    defer hello.deinit();
    const caps = if (hello.value == .object) hello.value.object.get("capabilities") orelse return error.ReloadProtocolUnavailable else return error.ReloadProtocolUnavailable;
    if (caps != .array) return error.ReloadProtocolUnavailable;
    const supported = for (caps.array.items) |cap| {
        if (cap == .string and eq(cap.string, "server.reload")) break true;
    } else false;
    if (!supported) return error.ReloadProtocolUnavailable;
    // Keep the server's specific rejection (backpressure, checkpoint limit, etc.).
    try os.sendJson(fd, .{ .op = "server.reload", .protocol = 1, .executable = executable });
    const line = try os.readLine(fd, 1024 * 1024);
    defer a.free(line);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
    defer parsed.deinit();
    const err = agents.str(parsed.value, "err");
    if (err.len > 0) {
        std.debug.print("corgi: reload failed ({s}); the current daemon and processes remain running.\n", .{err});
        return error.ReloadFailed;
    }
    try os.writeAll(1, line);
    try os.writeAll(1, "\n");
}
fn request(path: []const u8, value: anytype, plain: bool) !void {
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    try os.sendJson(fd, value);
    const line = try os.readLine(fd, 4 * 1024 * 1024);
    defer a.free(line);
    const parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
    defer parsed.deinit();
    const err = agents.str(parsed.value, "err");
    if (err.len > 0) {
        if (eq(err, "DetachAndReattachViewerOnce")) return error.DetachAndReattachViewerOnce;
        if (eq(err, "AmbiguousViewer")) return error.AmbiguousViewer;
        std.debug.print("{s}\n", .{err});
        return error.ServerRejected;
    }
    try os.writeAll(1, if (plain) agents.str(parsed.value, "text") else line);
    if (!plain) try os.writeAll(1, "\n");
}
fn ensureServer(path: []const u8, exe: []const u8) !void {
    if (os.connect(path)) |fd| {
        _ = c.close(fd);
        return;
    } else |_| {}
    const parent = std.fs.path.dirname(path) orelse return error.BadSocketPath;
    try os.privateDirectory(parent);
    const lock_path = try std.fmt.allocPrint(a, "{s}/start.lock", .{parent});
    defer a.free(lock_path);
    const lock = try std.fs.cwd().createFile(lock_path, .{ .truncate = false, .mode = 0o600 });
    defer lock.close();
    try lock.lock(.exclusive);
    defer lock.unlock();
    if (os.connect(path)) |fd| {
        _ = c.close(fd);
        return;
    } else |_| {}
    std.fs.cwd().deleteFile(path) catch |err| if (err != error.FileNotFound) return err;
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = c.setsid();
        const grandchild = c.fork();
        if (grandchild < 0) c._exit(127);
        if (grandchild > 0) c._exit(0);
        const log_path = std.fmt.allocPrintSentinel(a, "{s}/server.log", .{parent}, 0) catch c._exit(127);
        const log = c.open(log_path, c.O_WRONLY | c.O_CREAT | c.O_APPEND, @as(c_uint, 0o600));
        const devnull = c.open("/dev/null", c.O_RDONLY);
        _ = c.dup2(devnull, 0);
        _ = c.dup2(log, 1);
        _ = c.dup2(log, 2);
        if (log > 2) _ = c.close(log);
        if (devnull > 2) _ = c.close(devnull);
        _ = c.close(lock.handle);
        os.exec(&.{ exe, "serve" }) catch c._exit(127);
    }
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
    for (0..100) |_| {
        if (os.connect(path)) |fd| {
            _ = c.close(fd);
            return;
        } else |_| {}
        std.Thread.sleep(20 * std.time.ns_per_ms);
    }
    return error.ServerStartFailed;
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
const help =
    \\corgi — a small Ghostty-powered agent terminal
    \\
    \\  corgi                         start / attach
    \\  corgi dev                     reload if changed; attach or relaunch viewer
    \\  corgi start                   start detached runtime
    \\  corgi new [shell-command]     create tab
    \\  corgi split right|down [cmd]  split focused pane
    \\  corgi list                    JSON pane and agent inventory
    \\  corgi focus|close|read ID      manage / capture pane
    \\  corgi send ID TEXT [--enter]   literal input
    \\  corgi workspace list|new NAME [DIR]|switch ID
    \\  corgi workspace edit ID NAME DIR|close ID (empty only)
    \\  corgi action NAME [VALUE]     zoom, rename, next, prev, tab,
    \\                                   focus, swap, resize, move-tab,
    \\                                   attention, mute, close-tab, undo-close
    \\  corgi agent claude|codex ...   optional discovered-binary launcher
    \\  corgi hooks claude|codex       print hook configuration
    \\  corgi which codex             show automatically selected executable
    \\  corgi native start PROVIDER    durable native JSONL session
    \\  corgi native list              list native sessions
    \\  corgi native send ID JSON      provider request / approval response
    \\  corgi native events ID [SEQ]   bounded journal + pending requests
    \\  corgi native stop ID           stop native session
    \\  corgi rpc JSON                local JSON control protocol
    \\  corgi reload [ABSOLUTE_EXE]    replace daemon, preserve live processes
    \\  corgi checkpoint               save recovery context now
    \\  corgi shutdown                terminate runtime and its panes
    \\
    \\Keys: Ctrl-B opens a clickable command menu; then c tab, v/- split,
    \\hjkl focus, HJKL swap, z zoom,
    \\r resize, T rename, n/p tabs, 1–9 jump, x close, X close tab,
    \\u undo close, [ scroll/copy, a attention, b agent sidebar, m mute, q detach, ? help.
    \\
    \\CORGI_SOCKET selects a runtime. Workspaces group tabs and panes; no worktrees.
    \\
;
test {
    _ = @import("checkpoint_probe.zig");
    _ = @import("replay_test.zig");
    _ = @import("runtime.zig");
    _ = @import("protocol.zig");
    _ = @import("surface.zig");
    _ = @import("sidebar.zig");
    _ = @import("name_dialog.zig");
    _ = @import("commands.zig");
    _ = @import("discovery.zig");
    _ = @import("layout.zig");
    _ = @import("agents.zig");
    _ = @import("transcript.zig");
    _ = @import("usage.zig");
    _ = @import("usage_worker.zig");
    _ = @import("codex_observer.zig");
    _ = @import("terminal.zig");
    _ = @import("integration.zig");
    _ = @import("detection.zig");
}
