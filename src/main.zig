const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
const integration = @import("integration.zig");
const updates = @import("updates.zig");
const viewer_version = @import("viewer_version.zig");
const herdr_adapter = @import("herdr_adapter.zig");
const claude_credentials = @import("claude_credentials.zig");
const rpc = @import("rpc.zig");
const protocol = @import("protocol.zig");
const client = @import("client.zig");
const cli = @import("cli.zig");
const options = @import("corgi_options");
const discovery = @import("discovery.zig");
const handoff = @import("handoff.zig");
const Server = @import("server.zig").Server;
const viewer_test = @import("viewer_test.zig");
pub var build_id: [64]u8 = undefined;
/// A no-op in the daemon, CLI and hook, where client.cleanup has nothing to
/// restore; in the viewer it leaves the terminal usable instead of raw.
pub const panic = std.debug.FullPanic(restoreThenPanic);
fn restoreThenPanic(msg: []const u8, first_trace_addr: ?usize) noreturn {
    client.cleanup();
    std.debug.defaultPanic(msg, first_trace_addr);
}
fn providerArg(name: []const u8) !agents.Provider {
    return std.meta.stringToEnum(agents.Provider, name) orelse error.BadProvider;
}
const Command = enum {
    __herdr_import,
    @"__claude-credentials",
    @"__update-start",
    update,
    attach,
    serve,
    __handoff,
    dev,
    @"--help",
    help,
    @"--version",
    which,
    @"__viewer-test",
    reload,
    checkpoint,
    hook,
    hooks,
    agent,
    native,
    start,
    onboard,
    ping,
    shutdown,
    action,
    rpc,
};
const NativeCommand = enum { start, list, events, stop, send };
pub fn main() void {
    run() catch |err| {
        if (err == error.IncompatibleViewerProtocol) {
            std.debug.print("corgi: this viewer is incompatible with the server (requires viewer protocol {d}). The server may have changed during a restart. Reattach using the same Corgi version as the server.\n", .{viewer_version.version});
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
    const no_update = args.len == 2 and std.mem.eql(u8, args[1], "--no-update");
    const cmd = if (no_update) "attach" else if (args.len > 1) args[1] else "attach";
    const command = std.meta.stringToEnum(Command, cmd);
    if (command == .__herdr_import) return herdr_adapter.importBridge(args[2..]);
    if (try updates.internal(args)) return;
    if (command == .@"__claude-credentials") {
        if (args.len != 3) return error.Usage;
        const mode = std.meta.stringToEnum(claude_credentials.Interaction, args[2]) orelse return error.Usage;
        return claude_credentials.serve(mode);
    }
    const path = try os.socketPath();
    defer a.free(path);
    const exe = try std.fs.selfExePathAlloc(a);
    defer a.free(exe);
    if (command == .@"__update-start") return ensureServer(path, exe);
    if (command == .update) return updates.command(args[2..], path, exe);
    if (std.meta.stringToEnum(agents.Provider, std.fs.path.basename(args[0]))) |provider| try integration.launch(provider, args[1..], exe);
    if (command == .attach and os.env("CORGI_PANE") != null) return error.NestedCorgi;
    if (command == .serve or command == .__handoff or command == .dev) {
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
    if (command == .dev) {
        try ensureServer(path, exe);
        const fd = try os.connect(path);
        defer _ = c.close(fd);
        var conn: rpc.Connection = .{ .fd = fd };
        const hello = try conn.call(.{ .op = "hello", .protocol = 1 });
        defer hello.deinit();
        if (!std.mem.eql(u8, agents.str(hello.value, "build_id"), &build_id)) try reload(path, exe);
        if (os.env("CORGI_PANE")) |pane| {
            return request(path, .{ .op = "action", .name = "relaunch", .value = exe, .pane = try std.fmt.parseInt(u32, pane, 10) });
        }
        return client.attach(path);
    }
    if (cli.handles(args)) {
        cli.run(path, args) catch |err| {
            cli.failure(@errorName(err), usageStatus(err)) catch {};
        };
        return;
    }
    if (command == .@"--help" or command == .help) {
        try os.writeAll(1, help);
        return os.writeAll(1, cli.help);
    }
    if (command == .@"--version") return os.writeAll(1, "corgi " ++ options.release_version ++ " (" ++ options.release_commit ++ ")\n");
    if (command == .which) {
        if (args.len != 3) return error.Usage;
        const provider = try providerArg(args[2]);
        const binary = try discovery.resolve(provider, null);
        defer a.free(binary);
        try os.writeAll(1, binary);
        return os.writeAll(1, "\n");
    }
    if (options.viewer_test_driver and command == .@"__viewer-test") return viewer_test.run(path);
    switch (command orelse return error.UnknownCommand) {
        .__handoff => {
            if (args.len != 4) return error.Usage;
            handoff.importAndRun(path, exe, try std.fmt.parseInt(c_int, args[2], 10), try std.fmt.parseInt(c_int, args[3], 10));
        },
        .reload => {
            if (args.len > 3) return error.Usage;
            return reload(path, if (args.len == 3) args[2] else exe);
        },
        .checkpoint => return request(path, .{ .op = "recovery.save", .protocol = 1 }),
        .serve => {
            var server: Server = .{ .socket = path, .executable = exe };
            return server.run();
        },
        .hook => {
            if (args.len != 3) return error.Usage;
            integration.hook(providerArg(args[2]) catch return, path) catch {};
            return;
        },
        .hooks => {
            if (args.len != 3) return error.Usage;
            const config = try integration.config(try providerArg(args[2]), exe);
            defer a.free(config);
            try os.writeAll(1, config);
            return os.writeAll(1, "\n");
        },
        .agent => {
            if (args.len < 3) return error.Usage;
            try integration.launch(try providerArg(args[2]), args[3..], exe);
        },
        .native => {
            if (args.len < 3) return error.Usage;
            const sub = std.meta.stringToEnum(NativeCommand, args[2]) orelse return error.Usage;
            switch (sub) {
                .start => {
                    if (args.len != 4 and (args.len != 6 or !std.mem.eql(u8, args[4], "--workspace"))) return error.Usage;
                    try ensureServer(path, exe);
                    const cwd = try std.process.getCwdAlloc(a);
                    defer a.free(cwd);
                    if (args.len == 6) return request(path, .{ .op = "native.start", .provider = args[3], .cwd = cwd, .workspace = try std.fmt.parseInt(u32, args[5], 10) });
                    return request(path, .{ .op = "native.start", .provider = args[3], .cwd = cwd });
                },
                .list => return request(path, .{ .op = "native.list" }),
                .events => {
                    if (args.len < 4) return error.Usage;
                    const id = try std.fmt.parseInt(u32, args[3], 10);
                    return request(path, .{ .op = "native.events", .session = id, .after = if (args.len > 4) try std.fmt.parseInt(u64, args[4], 10) else 0 });
                },
                .stop => {
                    if (args.len < 4) return error.Usage;
                    const id = try std.fmt.parseInt(u32, args[3], 10);
                    return request(path, .{ .op = "native.stop", .session = id });
                },
                .send => {
                    if (args.len != 5) return error.Usage;
                    const id = try std.fmt.parseInt(u32, args[3], 10);
                    const msg = try std.json.parseFromSlice(std.json.Value, a, args[4], .{});
                    defer msg.deinit();
                    return request(path, .{ .op = "native.send", .session = id, .message = msg.value });
                },
            }
        },
        .attach => {
            if (!(args.len == 3 and std.mem.eql(u8, args[2], "--update-routed"))) try updates.startup(path, exe, cmd, no_update);
            try ensureServer(path, exe);
            updates.background(path, exe) catch {};
            return client.attach(path);
        },
        .start => {
            if (!(args.len == 3 and std.mem.eql(u8, args[2], "--update-routed"))) try updates.startup(path, exe, cmd, no_update);
            try ensureServer(path, exe);
            updates.background(path, exe) catch {};
            return;
        },
        .onboard => {
            if (args.len != 2) return error.Usage;
            if (os.env("CORGI_PANE")) |pane| {
                return request(path, .{ .op = "action", .name = "onboard", .pane = try std.fmt.parseInt(u32, pane, 10) });
            }
            if (c.isatty(0) == 0 or c.isatty(1) == 0) return error.TerminalRequired;
            try ensureServer(path, exe);
            return client.onboard(path);
        },
        .ping => return request(path, .{ .op = "ping" }),
        .shutdown => {
            try request(path, .{ .op = "shutdown" });
            // The daemon stops listening before its slower teardown. Waiting for
            // that lets an immediate start get a fresh daemon, not the exiting one.
            for (0..500) |_| {
                const fd = os.connect(path) catch return;
                _ = c.close(fd);
                std.Thread.sleep(10 * std.time.ns_per_ms);
            }
            return error.ShutdownTimedOut;
        },
        .action => {
            if (args.len < 3) return error.Usage;
            return request(path, .{ .op = "action", .name = args[2], .value = if (args.len > 3) args[3] else "" });
        },
        .rpc => {
            if (args.len != 3) return error.Usage;
            const parsed = try std.json.parseFromSlice(std.json.Value, a, args[2], .{});
            defer parsed.deinit();
            return request(path, parsed.value);
        },
        else => return error.UnknownCommand,
    }
}
/// The CLI's own usage errors report as a client mistake, not a server failure.
fn usageStatus(err: anyerror) u8 {
    return switch (err) {
        error.Usage, error.InvalidCharacter, error.Overflow, error.InvalidKey, error.NoCallerPane, error.MissingWorkspace => 2,
        else => 1,
    };
}
fn reload(path: []const u8, executable: []const u8) !void {
    return request(path, .{ .op = "server.reload", .protocol = 1, .executable = executable });
}
fn request(path: []const u8, value: anytype) !void {
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    var connection: rpc.Connection = .{ .fd = fd };
    const parsed = try connection.request(value);
    defer parsed.deinit();
    const err = agents.str(parsed.value, "err");
    if (err.len > 0) {
        if (std.meta.stringToEnum(protocol.Rejection, err) == .AmbiguousViewer) return error.AmbiguousViewer;
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
    // The first child reports the daemon's pid, so a daemon that exits while
    // starting is reported at once instead of after the whole wait.
    var started: [2]c_int = undefined;
    if (c.pipe(&started) != 0) return error.ForkFailed;
    defer _ = c.close(started[0]);
    const pid = c.fork();
    if (pid == 0) {
        _ = c.setsid();
        const grandchild = c.fork();
        if (grandchild < 0) c._exit(127);
        if (grandchild > 0) {
            _ = c.write(started[1], &grandchild, @sizeOf(c.pid_t));
            c._exit(0);
        }
        _ = c.close(started[0]);
        _ = c.close(started[1]);
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
    _ = c.close(started[1]);
    if (pid < 0) return error.ForkFailed;
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
    var daemon: c.pid_t = 0;
    if (c.read(started[0], &daemon, @sizeOf(c.pid_t)) != @sizeOf(c.pid_t)) daemon = 0;
    // A loaded machine can take seconds to bind the socket.
    for (0..500) |_| {
        if (os.connect(path)) |fd| {
            _ = c.close(fd);
            return;
        } else |_| {}
        if (daemon > 0 and c.kill(daemon, 0) != 0) break;
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
const help =
    \\corgi — a small Ghostty-powered agent terminal
    \\
    \\  corgi                         start / attach
    \\  corgi onboard                 open onboarding, even after setup
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
    // Every file under src/, sorted. "every source file is in the test root"
    // below fails when one is missing.
    _ = @import("account_cache.zig");
    _ = @import("account_preview.zig");
    _ = @import("activity_prompt.zig");
    _ = @import("activity_summary.zig");
    _ = @import("activity_timeline.zig");
    _ = @import("activity_tools.zig");
    _ = @import("activity_worker.zig");
    _ = @import("agent_drag.zig");
    _ = @import("agent_launcher.zig");
    _ = @import("agent_navigation.zig");
    _ = @import("agent_order.zig");
    _ = @import("agents.zig");
    _ = @import("background_tasks.zig");
    _ = @import("base64.zig");
    _ = @import("bounded_text.zig");
    _ = @import("checkpoint.zig");
    _ = @import("checkpoint_probe.zig");
    _ = @import("checkpoint_test.zig");
    _ = @import("claude_credentials.zig");
    _ = @import("cli.zig");
    _ = @import("client.zig");
    _ = @import("clock.zig");
    _ = @import("cmux_import.zig");
    _ = @import("cmux_import_test.zig");
    _ = @import("codex_files.zig");
    _ = @import("codex_observer.zig");
    _ = @import("codex_socket.zig");
    _ = @import("commands.zig");
    _ = @import("context_window.zig");
    _ = @import("controller.zig");
    _ = @import("conversations.zig");
    _ = @import("corgi_animation.zig");
    _ = @import("corgi_badge.zig");
    _ = @import("corgi_frames.zig");
    _ = @import("corgi_setup.zig");
    _ = @import("detection.zig");
    _ = @import("discovery.zig");
    _ = @import("failure.zig");
    _ = @import("ghostty_integration.zig");
    _ = @import("git_push.zig");
    _ = @import("git_status.zig");
    _ = @import("handoff.zig");
    _ = @import("herdr_adapter.zig");
    _ = @import("hyperlinks.zig");
    _ = @import("import_catalog.zig");
    _ = @import("import_layout.zig");
    _ = @import("inference.zig");
    _ = @import("inference_setup.zig");
    _ = @import("inference_usage.zig");
    _ = @import("integration.zig");
    _ = @import("json.zig");
    _ = @import("keyboard.zig");
    _ = @import("keymap.zig");
    _ = @import("keys.zig");
    _ = @import("launch_command.zig");
    _ = @import("launch_preview_stream.zig");
    _ = @import("launcher_usage.zig");
    _ = @import("layout.zig");
    _ = @import("limit_history.zig");
    _ = @import("link_labels.zig");
    _ = @import("link_tooltip.zig");
    _ = @import("live_usage.zig");
    _ = @import("mirror.zig");
    _ = @import("model_prices.zig");
    _ = @import("name_dialog.zig");
    _ = @import("native.zig");
    _ = @import("navigation.zig");
    _ = @import("observation.zig");
    _ = @import("onboarding.zig");
    _ = @import("onboarding_import.zig");
    _ = @import("os.zig");
    _ = @import("pane_label.zig");
    _ = @import("passes.zig");
    _ = @import("peer.zig");
    _ = @import("ports.zig");
    _ = @import("preferences.zig");
    _ = @import("protocol.zig");
    _ = @import("providers.zig");
    _ = @import("providers/claude.zig");
    _ = @import("providers/codex.zig");
    _ = @import("providers/common.zig");
    _ = @import("recovery.zig");
    _ = @import("render.zig");
    _ = @import("resource_os.zig");
    _ = @import("resource_tooltip.zig");
    _ = @import("resources.zig");
    _ = @import("rpc.zig");
    _ = @import("runtime.zig");
    _ = @import("server.zig");
    _ = @import("session.zig");
    _ = @import("shortcut_help.zig");
    _ = @import("sidebar.zig");
    _ = @import("sidebar_rows.zig");
    _ = @import("sound.zig");
    _ = @import("state_migrations.zig");
    _ = @import("state_steps.zig");
    _ = @import("subagent_tooltip.zig");
    _ = @import("summary_backend.zig");
    _ = @import("surface.zig");
    _ = @import("terminal.zig");
    _ = @import("theme.zig");
    _ = @import("tmux_layout.zig");
    _ = @import("tmux_resume.zig");
    _ = @import("transcript.zig");
    _ = @import("updates.zig");
    _ = @import("url_opener.zig");
    _ = @import("usage.zig");
    _ = @import("usage_worker.zig");
    _ = @import("viewer.zig");
    _ = @import("viewer_protocol.zig");
    _ = @import("viewer_test.zig");
    _ = @import("viewer_version.zig");
    _ = @import("workspace.zig");
    _ = @import("workspace_drag.zig");
}

test "every source file is in the test root" {
    const root = @embedFile("main.zig");
    var dir = try std.fs.cwd().openDir("src", .{ .iterate = true });
    defer dir.close();
    var walker = try dir.walk(std.testing.allocator);
    defer walker.deinit();
    while (try walker.next()) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.path, ".zig")) continue;
        if (std.mem.eql(u8, entry.path, "main.zig")) continue;
        var buf: [256]u8 = undefined;
        const line = try std.fmt.bufPrint(&buf, "_ = @import(\"{s}\");", .{entry.path});
        if (std.mem.indexOf(u8, root, line) == null) {
            std.debug.print("missing from the test root in main.zig: {s}\n", .{entry.path});
            return error.UnlistedSourceFile;
        }
    }
}
