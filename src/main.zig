const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
const integration = @import("integration.zig");
const updates = @import("updates.zig");
pub var build_id: [64]u8 = undefined;
pub fn main() void {
    run() catch |err| {
        if (err == error.AmbiguousViewer) {
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
    const no_update = args.len == 2 and eq(args[1], "--no-update");
    const cmd = if (no_update) "attach" else if (args.len > 1) args[1] else "attach";
    if (try updates.internal(args)) return;
    if (eq(cmd, "__claude-credentials")) {
        if (args.len != 3) return error.Usage;
        const mode = std.meta.stringToEnum(@import("claude_credentials.zig").Interaction, args[2]) orelse return error.Usage;
        return @import("claude_credentials.zig").serve(mode);
    }
    const path = try os.socketPath();
    defer a.free(path);
    const exe = try std.fs.selfExePathAlloc(a);
    defer a.free(exe);
    if (eq(cmd, "__update-start")) return ensureServer(path, exe);
    if (eq(cmd, "update")) return updates.command(args[2..], path, exe);
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
            return request(path, .{ .op = "action", .name = "relaunch", .value = exe, .pane = try std.fmt.parseInt(u32, pane, 10) });
        }
        return @import("client.zig").attach(path);
    }
    if (@import("cli.zig").handles(args)) {
        @import("cli.zig").run(path, args) catch |err| {
            @import("cli.zig").failure(@errorName(err), if (err == error.Usage or err == error.InvalidCharacter or err == error.Overflow or err == error.InvalidKey or err == error.NoCallerPane or err == error.MissingWorkspace) 2 else 1) catch {};
        };
        return;
    }
    if (eq(cmd, "--help") or eq(cmd, "help")) {
        try os.writeAll(1, help);
        return os.writeAll(1, @import("cli.zig").help);
    }
    if (eq(cmd, "--version")) return os.writeAll(1, "corgi " ++ @import("corgi_options").release_version ++ " (" ++ @import("corgi_options").release_commit ++ ")\n");
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
    if (eq(cmd, "checkpoint")) return request(path, .{ .op = "recovery.save", .protocol = 1 });
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
    if (eq(cmd, "native")) {
        if (args.len < 3) return error.Usage;
        if (eq(args[2], "start")) {
            if (args.len != 4 and (args.len != 6 or !eq(args[4], "--workspace"))) return error.Usage;
            try ensureServer(path, exe);
            const cwd = try std.process.getCwdAlloc(a);
            defer a.free(cwd);
            if (args.len == 6) return request(path, .{ .op = "native.start", .provider = args[3], .cwd = cwd, .workspace = try std.fmt.parseInt(u32, args[5], 10) });
            return request(path, .{ .op = "native.start", .provider = args[3], .cwd = cwd });
        }
        if (eq(args[2], "list")) return request(path, .{ .op = "native.list" });
        if (args.len < 4) return error.Usage;
        const id = try std.fmt.parseInt(u32, args[3], 10);
        if (eq(args[2], "events")) return request(path, .{ .op = "native.events", .session = id, .after = if (args.len > 4) try std.fmt.parseInt(u64, args[4], 10) else 0 });
        if (eq(args[2], "stop")) return request(path, .{ .op = "native.stop", .session = id });
        if (eq(args[2], "send") and args.len == 5) {
            const msg = try std.json.parseFromSlice(std.json.Value, a, args[4], .{});
            defer msg.deinit();
            return request(path, .{ .op = "native.send", .session = id, .message = msg.value });
        }
        return error.Usage;
    }
    if (eq(cmd, "attach") or eq(cmd, "start")) {
        if (!(args.len == 3 and eq(args[2], "--update-routed"))) try updates.startup(path, exe, cmd, no_update);
        try ensureServer(path, exe);
        updates.background(path, exe) catch {};
    }
    if (eq(cmd, "attach")) return @import("client.zig").attach(path);
    if (eq(cmd, "start")) return;
    if (eq(cmd, "ping") or eq(cmd, "shutdown")) return request(path, .{ .op = cmd });
    if (eq(cmd, "action")) {
        if (args.len < 3) return error.Usage;
        return request(path, .{ .op = "action", .name = args[2], .value = if (args.len > 3) args[3] else "" });
    }
    if (eq(cmd, "rpc")) {
        if (args.len != 3) return error.Usage;
        const parsed = try std.json.parseFromSlice(std.json.Value, a, args[2], .{});
        defer parsed.deinit();
        return request(path, parsed.value);
    }
    return error.UnknownCommand;
}
fn reload(path: []const u8, executable: []const u8) !void {
    return request(path, .{ .op = "server.reload", .protocol = 1, .executable = executable });
}
fn request(path: []const u8, value: anytype) !void {
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    var connection: @import("rpc.zig").Connection = .{ .fd = fd };
    const parsed = try connection.request(value);
    defer parsed.deinit();
    const err = agents.str(parsed.value, "err");
    if (err.len > 0) {
        if (eq(err, "AmbiguousViewer")) return error.AmbiguousViewer;
        std.debug.print("{s}\n", .{err});
        return error.ServerRejected;
    }
    const output = try std.json.Stringify.valueAlloc(a, parsed.value, .{});
    defer a.free(output);
    try os.writeAll(1, output);
    try os.writeAll(1, "\n");
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
    const log_path = try std.fmt.allocPrintSentinel(a, "{s}/server.log", .{parent}, 0);
    defer a.free(log_path);
    const log_start = if (std.fs.cwd().statFile(log_path)) |st| st.size else |_| 0;
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = c.setsid();
        const grandchild = c.fork();
        if (grandchild < 0) c._exit(127);
        if (grandchild > 0) c._exit(0);
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
    reportServerLog(log_path, log_start);
    return error.ServerStartFailed;
}
/// Show what the detached server wrote during this launch attempt.
fn reportServerLog(log_path: []const u8, start: u64) void {
    const file = std.fs.cwd().openFile(log_path, .{}) catch {
        std.debug.print("corgi: server did not start and wrote no log at {s}\n", .{log_path});
        return;
    };
    defer file.close();
    const size = (file.stat() catch return).size;
    const max = 8 * 1024;
    const from = if (size < start) 0 else @max(start, size -| max);
    file.seekTo(from) catch return;
    const bytes = file.readToEndAlloc(a, max) catch return;
    defer a.free(bytes);
    const trimmed = std.mem.trim(u8, bytes, " \r\n");
    if (trimmed.len == 0) {
        std.debug.print("corgi: server did not start and logged nothing (see {s})\n", .{log_path});
        return;
    }
    std.debug.print("corgi: server did not start; {s}:\n{s}\n", .{ log_path, trimmed });
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
const help =
    \\corgi — a small Ghostty-powered agent terminal
    \\
    \\  corgi                         start / attach
    \\  corgi dev                     reload if changed; attach or relaunch viewer
    \\  corgi --no-update             attach without activating a staged update
    \\  corgi update                  download and safely apply an update
    \\  corgi update status|rollback|--check|--download-only
    \\  corgi update auto on|off      control automatic updates
    \\  corgi start                   start detached runtime
    \\  corgi action NAME [VALUE]     zoom, rename, next, prev, tab,
    \\                                   focus, swap, resize, move-tab,
    \\                                   attention, mute, close-tab, undo-close
    \\  corgi agent claude|codex ...   optional discovered-binary launcher
    \\  corgi hooks claude|codex       print hook configuration
    \\  corgi which codex             show automatically selected executable
    \\  corgi native start PROVIDER [--workspace ID]
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
    \\g find agent, [/] previous/next agent, Tab last agent (current workspace),
    \\u undo close, s scroll/copy, a attention, b agent sidebar, m mute, q detach, ? help.
    \\
    \\CORGI_SOCKET selects a runtime. Workspaces group tabs and panes; no worktrees.
    \\
;
test {
    _ = @import("updates.zig");
    _ = @import("agent_navigation.zig");
    _ = @import("link_tooltip.zig");
    _ = @import("checkpoint_probe.zig");
    _ = @import("checkpoint_test.zig");
    _ = @import("runtime.zig");
    _ = @import("protocol.zig");
    _ = @import("surface.zig");
    _ = @import("sidebar.zig");
    _ = @import("model_prices.zig");
    _ = @import("name_dialog.zig");
    _ = @import("commands.zig");
    _ = @import("discovery.zig");
    _ = @import("layout.zig");
    _ = @import("agents.zig");
    _ = @import("conversations.zig");
    _ = @import("server.zig");
    _ = @import("native.zig");
    _ = @import("transcript.zig");
    _ = @import("usage.zig");
    _ = @import("live_usage.zig");
    _ = @import("subagent_tooltip.zig");
    _ = @import("preferences.zig");
    _ = @import("usage_worker.zig");
    _ = @import("codex_observer.zig");
    _ = @import("activity_worker.zig");
    _ = @import("activity_tools.zig");
    _ = @import("activity_summary.zig");
    _ = @import("activity_timeline.zig");
    _ = @import("inference_usage.zig");
    _ = @import("inference_setup.zig");
    _ = @import("corgi_setup.zig");
    _ = @import("terminal.zig");
    _ = @import("integration.zig");
    _ = @import("detection.zig");
}
