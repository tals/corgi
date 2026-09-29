const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const agents = @import("agents.zig");
const integration = @import("integration.zig");
const updates = @import("updates.zig");
const viewer_version = @import("viewer_version.zig");
const herdr_adapter = @import("import.zig").herdr;
const claude_credentials = @import("claude_credentials.zig");
const rpc = @import("rpc.zig");
const protocol = @import("protocol.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const NativeId = @import("native.zig").Session.Id;
const client = @import("client.zig");
const preferences = @import("preferences.zig");
const cli = @import("cli.zig");
const options = @import("corgi_options");
const discovery = @import("discovery.zig");
const handoff = @import("persist.zig").handoff;
const Server = @import("server.zig").Server;
const viewer_test = @import("viewer_test.zig");
const keymap = @import("keymap.zig");
const bindings = @import("bindings.zig");
const Action = @import("action.zig").Action;
/// A no-op in the daemon, CLI and hook, where client.cleanup has nothing to
/// restore; in the viewer it leaves the terminal usable instead of raw.
pub const panic = std.debug.FullPanic(restoreThenPanic);
fn restoreThenPanic(msg: []const u8, first_trace_addr: ?usize) noreturn {
    client.cleanup();
    std.debug.defaultPanic(msg, first_trace_addr);
}
/// Where std.log goes. Only the daemon turns it on: its stderr is server.log,
/// while the viewer's, the CLI's and `corgi hook`'s is someone's terminal.
var log_sink: enum { none, stderr } = .none;
pub const std_options: std.Options = .{ .logFn = logFn };
fn logFn(
    comptime level: std.log.Level,
    comptime scope: @Type(.enum_literal),
    comptime format: []const u8,
    args: anytype,
) void {
    switch (log_sink) {
        .none => {},
        .stderr => std.log.defaultLog(level, scope, format, args),
    }
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
    keys,
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
            const prefs = preferences.load();
            std.debug.print("corgi: multiple viewers are focused on this pane. Detach the intended viewer with {s} {f} and run ./go.sh from its terminal.\n", .{
                keymap.prefixName(prefs.prefix),
                bindings.first(prefs.preset, .detach, true).?,
            });
        } else if (err == error.NestedCorgi) {
            std.debug.print("corgi: cannot attach inside a Corgi pane; detach first or use another terminal.\n", .{});
        } else {
            std.debug.print("corgi: {s}\n", .{@errorName(err)});
        }
        std.process.exit(1);
    };
}
/// Hex SHA-256 of the executable; `corgi dev` reloads when the daemon's differs.
fn buildId(exe: []const u8) ![64]u8 {
    var file = try std.fs.openFileAbsolute(exe, .{});
    defer file.close();
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var buffer: [65536]u8 = undefined;
    while (true) {
        const n = try file.read(&buffer);
        if (n == 0) break;
        hash.update(buffer[0..n]);
    }
    return std.fmt.bytesToHex(hash.finalResult(), .lower);
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
    if (command == .dev) {
        const build_id = try buildId(exe);
        try ensureServer(path, exe);
        const fd = try os.connect(path);
        defer _ = c.close(fd);
        var conn: rpc.Connection = .{ .fd = fd };
        const hello = try conn.call(.hello, {});
        defer hello.deinit();
        if (!std.mem.eql(u8, hello.value.build_id, &build_id)) try reload(path, exe);
        if (os.env("CORGI_PANE")) |pane| {
            return request(path, .action, .{ .name = "relaunch", .value = exe, .pane = @enumFromInt(try std.fmt.parseInt(u32, pane, 10)) });
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
    if (command == .keys) {
        if (args.len > 3) return error.Usage;
        var chosen: [1]keymap.Preset = undefined;
        const presets: []const keymap.Preset = if (args.len == 3) blk: {
            chosen[0] = std.meta.stringToEnum(keymap.Preset, args[2]) orelse return error.Usage;
            break :blk &chosen;
        } else std.enums.values(keymap.Preset);
        var out: std.Io.Writer.Allocating = .init(a);
        defer out.deinit();
        try bindings.writeTable(&out.writer, presets);
        return os.writeAll(1, out.written());
    }
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
            log_sink = .stderr;
            handoff.importAndRun(path, exe, try buildId(exe), try std.fmt.parseInt(c_int, args[2], 10), try std.fmt.parseInt(c_int, args[3], 10));
        },
        .reload => {
            if (args.len > 3) return error.Usage;
            return reload(path, if (args.len == 3) args[2] else exe);
        },
        .checkpoint => return request(path, .@"recovery.save", {}),
        .serve => {
            log_sink = .stderr;
            var server: Server = .{ .socket = path, .executable = exe, .build_id = try buildId(exe) };
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
                    const provider = try providerArg(args[3]);
                    const workspace: ?WorkspaceId = if (args.len == 6) @enumFromInt(try std.fmt.parseInt(u32, args[5], 10)) else null;
                    try ensureServer(path, exe);
                    const cwd = try std.process.getCwdAlloc(a);
                    defer a.free(cwd);
                    return request(path, .@"native.start", .{ .provider = provider, .cwd = cwd, .workspace = workspace });
                },
                .list => return request(path, .@"native.list", {}),
                .events => {
                    if (args.len < 4) return error.Usage;
                    const id: NativeId = @enumFromInt(try std.fmt.parseInt(u32, args[3], 10));
                    return request(path, .@"native.events", .{ .session = id, .after = if (args.len > 4) try std.fmt.parseInt(u64, args[4], 10) else 0 });
                },
                .stop => {
                    if (args.len < 4) return error.Usage;
                    const id: NativeId = @enumFromInt(try std.fmt.parseInt(u32, args[3], 10));
                    return request(path, .@"native.stop", .{ .session = id });
                },
                .send => {
                    if (args.len != 5) return error.Usage;
                    const id: NativeId = @enumFromInt(try std.fmt.parseInt(u32, args[3], 10));
                    const msg = try std.json.parseFromSlice(std.json.Value, a, args[4], .{});
                    defer msg.deinit();
                    return request(path, .@"native.send", .{ .session = id, .message = msg.value });
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
                return request(path, .action, .{ .name = "onboard", .pane = @enumFromInt(try std.fmt.parseInt(u32, pane, 10)) });
            }
            if (c.isatty(0) == 0 or c.isatty(1) == 0) return error.TerminalRequired;
            try ensureServer(path, exe);
            return client.onboard(path);
        },
        .ping => return request(path, .ping, {}),
        .shutdown => {
            try request(path, .shutdown, {});
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
            return request(path, .action, .{ .name = args[2], .value = if (args.len > 3) args[3] else "" });
        },
        .rpc => {
            if (args.len != 3) return error.Usage;
            const parsed = try std.json.parseFromSlice(std.json.Value, a, args[2], .{});
            defer parsed.deinit();
            return printReply(path, parsed.value);
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
    return request(path, .@"server.reload", .{ .executable = executable });
}
/// Sends `op` and prints the daemon's reply as it arrives.
fn request(path: []const u8, comptime op: protocol.Op, payload: protocol.Payload(op)) !void {
    return printReply(path, protocol.Envelope(op){ .payload = payload });
}
/// Sends `value` as is, as `corgi rpc` does, and prints the reply.
fn printReply(path: []const u8, value: anytype) !void {
    const fd = try os.connect(path);
    defer _ = c.close(fd);
    var connection: rpc.Connection = .{ .fd = fd };
    const parsed = try connection.request(value);
    defer parsed.deinit();
    const err = agents.str(parsed.value, "err");
    if (err.len > 0) {
        if (protocol.rejection(err) == error.AmbiguousViewer) return error.AmbiguousViewer;
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
/// The names `corgi action` takes, wrapped at 80 columns. `relaunch` is left
/// out: Corgi sends it itself after an update.
const action_names = names: {
    var text: []const u8 = "Actions:";
    var column = text.len;
    var first = true;
    for (std.meta.tags(std.meta.Tag(Action))) |tag| {
        if (tag == .relaunch) continue;
        const name = @tagName(tag);
        if (first) {
            text = text ++ " " ++ name;
            column += 1 + name.len;
        } else if (column + 2 + name.len + 1 > 80) {
            text = text ++ ",\n" ++ name;
            column = name.len;
        } else {
            text = text ++ ", " ++ name;
            column += 2 + name.len;
        }
        first = false;
    }
    break :names text ++ ".";
};
test "help names every action on lines of at most 80 columns" {
    var lines = std.mem.splitScalar(u8, action_names, '\n');
    while (lines.next()) |line| try std.testing.expect(line.len <= 80);
    var words = std.mem.tokenizeAny(u8, action_names["Actions:".len..], " ,.\n");
    for (std.meta.tags(std.meta.Tag(Action))) |tag| {
        if (tag == .relaunch) continue;
        try std.testing.expectEqualStrings(@tagName(tag), words.next().?);
    }
    try std.testing.expectEqual(null, words.next());
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
    \\  corgi action NAME [VALUE]     run a viewer action, named below
    \\  corgi agent claude|codex ...   optional discovered-binary launcher
    \\  corgi hooks claude|codex       print hook configuration
    \\  corgi which codex             show automatically selected executable
    \\  corgi keys [PRESET]           list shortcuts: corgi, tmux, herdr, cmux
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
    \\Keys: Ctrl+B opens a clickable command menu; `corgi keys` lists every shortcut.
    \\
    \\
++ action_names ++
    \\
    \\
    \\CORGI_SOCKET selects a runtime. Workspaces group tabs and panes; no worktrees.
    \\
;
test {
    // Each top-level file under src/, sorted; each package root lists the
    // files in its directory. "every source file is in the test root"
    // below fails when one is missing.
    _ = @import("action.zig");
    _ = @import("activity.zig");
    _ = @import("agent_drag.zig");
    _ = @import("agent_launcher.zig");
    _ = @import("agent_navigation.zig");
    _ = @import("agent_order.zig");
    _ = @import("agents.zig");
    _ = @import("base64.zig");
    _ = @import("bindings.zig");
    _ = @import("bounded_text.zig");
    _ = @import("claude_credentials.zig");
    _ = @import("cli.zig");
    _ = @import("client.zig");
    _ = @import("clock.zig");
    _ = @import("codex_files.zig");
    _ = @import("codex_observer.zig");
    _ = @import("codex_socket.zig");
    _ = @import("commands.zig");
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
    _ = @import("host_probe.zig");
    _ = @import("import.zig");
    _ = @import("inference.zig");
    _ = @import("integration.zig");
    _ = @import("json.zig");
    _ = @import("keyboard.zig");
    _ = @import("keymap.zig");
    _ = @import("keys.zig");
    _ = @import("launch.zig");
    _ = @import("launch_preview_stream.zig");
    _ = @import("launcher_usage.zig");
    _ = @import("layout.zig");
    _ = @import("link_tooltip.zig");
    _ = @import("mirror.zig");
    _ = @import("name_dialog.zig");
    _ = @import("native.zig");
    _ = @import("navigation.zig");
    _ = @import("observation.zig");
    _ = @import("onboarding.zig");
    _ = @import("os.zig");
    _ = @import("pane.zig");
    _ = @import("passes.zig");
    _ = @import("peer.zig");
    _ = @import("persist.zig");
    _ = @import("preferences.zig");
    _ = @import("protocol.zig");
    _ = @import("providers.zig");
    _ = @import("render.zig");
    _ = @import("resource_tooltip.zig");
    _ = @import("resume_hint.zig");
    _ = @import("rpc.zig");
    _ = @import("runtime.zig");
    _ = @import("server.zig");
    _ = @import("session.zig");
    _ = @import("shortcut_help.zig");
    _ = @import("sidebar.zig");
    _ = @import("sidebar_rows.zig");
    _ = @import("sound.zig");
    _ = @import("subagent_tooltip.zig");
    _ = @import("summary_backend.zig");
    _ = @import("theme.zig");
    _ = @import("trackers.zig");
    _ = @import("transcript.zig");
    _ = @import("updates.zig");
    _ = @import("url_opener.zig");
    _ = @import("usage.zig");
    _ = @import("viewer.zig");
    _ = @import("viewer_protocol.zig");
    _ = @import("viewer_test.zig");
    _ = @import("viewer_version.zig");
    _ = @import("workspace.zig");
    _ = @import("workspace_drag.zig");
}

test "every source file is in the test root" {
    // main.zig lists the top-level files; a package root lists the files in
    // the directory beside it, which main.zig reaches through the root.
    var dir = try std.fs.cwd().openDir("src", .{ .iterate = true });
    defer dir.close();
    var walker = try dir.walk(std.testing.allocator);
    defer walker.deinit();
    while (try walker.next()) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.path, ".zig")) continue;
        if (std.mem.eql(u8, entry.path, "main.zig")) continue;
        const package = std.fs.path.dirname(entry.path);
        var root_buf: [256]u8 = undefined;
        const root = if (package) |p| try std.fmt.bufPrint(&root_buf, "{s}.zig", .{p}) else "main.zig";
        // The root sits beside its directory and names members from there.
        const up = if (package) |p| std.fs.path.dirname(p) else null;
        const member = if (up) |u| entry.path[u.len + 1 ..] else entry.path;
        const source = dir.readFileAlloc(std.testing.allocator, root, 4 << 20) catch |err| {
            std.debug.print("{s} has no package root {s}\n", .{ entry.path, root });
            return err;
        };
        defer std.testing.allocator.free(source);
        var buf: [256]u8 = undefined;
        const line = try std.fmt.bufPrint(&buf, "_ = @import(\"{s}\");", .{member});
        if (std.mem.indexOf(u8, source, line) == null) {
            std.debug.print("missing from the test block in {s}: {s}\n", .{ root, member });
            return error.UnlistedSourceFile;
        }
    }
}

test "the daemon and the viewer never import each other" {
    // Files that run only in `corgi attach`.
    const viewer: std.StaticStringMap(void) = .initComptime(.{
        .{"agent_drag.zig"},       .{"agent_launcher.zig"}, .{"agent_navigation.zig"},      .{"bindings.zig"},
        .{"client.zig"},           .{"commands.zig"},       .{"controller.zig"},            .{"corgi_animation.zig"},
        .{"corgi_badge.zig"},      .{"corgi_frames.zig"},   .{"corgi_setup.zig"},           .{"ghostty_integration.zig"},
        .{"host_probe.zig"},       .{"keymap.zig"},         .{"launch_preview_stream.zig"}, .{"launcher_usage.zig"},
        .{"link_tooltip.zig"},     .{"mirror.zig"},         .{"name_dialog.zig"},           .{"navigation.zig"},
        .{"onboarding.zig"},       .{"preferences.zig"},    .{"render.zig"},                .{"resource_tooltip.zig"},
        .{"shortcut_help.zig"},    .{"sidebar.zig"},        .{"sidebar_rows.zig"},          .{"sound.zig"},
        .{"subagent_tooltip.zig"}, .{"url_opener.zig"},     .{"viewer.zig"},                .{"viewer_test.zig"},
        .{"workspace_drag.zig"},
    });
    // Files that own daemon state, the daemon's workers and updater, and their tests.
    const core: std.StaticStringMap(void) = .initComptime(.{
        .{"activity/worker.zig"},         .{"import/onboarding.zig"}, .{"peer.zig"},               .{"persist/checkpoint.zig"},
        .{"persist/checkpoint_test.zig"}, .{"persist/handoff.zig"},   .{"persist/migrations.zig"}, .{"persist/recovery.zig"},
        .{"runtime.zig"},                 .{"server.zig"},            .{"session.zig"},            .{"updates.zig"},
        .{"viewer_protocol.zig"},
    });
    // Shared files that still import core. import/herdr.zig holds both the
    // scan the onboarding wizard runs and the daemon's copy into the runtime.
    const allowed = [_][2][]const u8{.{ "import/herdr.zig", "runtime.zig" }};
    // Every other file is shared. Only main.zig imports viewer files, only
    // core imports core, and nothing imports main.zig. Importing a package
    // root imports the member it names, or every member when it names none.
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    var dir = try std.fs.cwd().openDir("src", .{ .iterate = true });
    defer dir.close();
    var sources: std.StringArrayHashMapUnmanaged([]const u8) = .empty;
    var walker = try dir.walk(alloc);
    while (try walker.next()) |entry| {
        if (entry.kind != .file or !std.mem.endsWith(u8, entry.path, ".zig")) continue;
        if (std.mem.eql(u8, entry.path, "main.zig")) continue;
        try sources.put(alloc, try alloc.dupe(u8, entry.path), try dir.readFileAlloc(alloc, entry.path, 4 << 20));
    }
    var crossed = false;
    for (sources.keys(), sources.values()) |path, source| {
        var targets: std.ArrayList([]const u8) = .empty;
        var rest = source;
        while (std.mem.indexOf(u8, rest, "@import(\"")) |start| {
            rest = rest[start + "@import(\"".len ..];
            const name = rest[0 .. std.mem.indexOfScalar(u8, rest, '"') orelse break];
            const target = try resolveImport(alloc, path, name);
            // A root's members count where the root is imported.
            if (inPackage(path, target)) continue;
            if (!isPackageRoot(sources.keys(), target)) {
                try targets.append(alloc, target);
            } else if (try namedMember(alloc, sources.get(target) orelse "", rest[name.len..])) |member| {
                try targets.append(alloc, try resolveImport(alloc, target, member));
            } else for (sources.keys()) |file| {
                if (inPackage(target, file)) try targets.append(alloc, file);
            }
        }
        for (targets.items) |target| {
            const exempt = for (allowed) |edge| {
                if (std.mem.eql(u8, edge[0], path) and std.mem.eql(u8, edge[1], target)) break true;
            } else false;
            if (std.mem.eql(u8, target, "main.zig") or (viewer.has(target) and !viewer.has(path)) or (core.has(target) and !core.has(path) and !exempt)) {
                std.debug.print("{s} imports {s} across the daemon/viewer boundary\n", .{ path, target });
                crossed = true;
            }
        }
    }
    if (crossed) return error.ProcessBoundary;
}

/// The file under src/ that `from` names by `name`.
fn resolveImport(alloc: std.mem.Allocator, from: []const u8, name: []const u8) ![]u8 {
    return std.fs.path.resolvePosix(alloc, &.{ std.fs.path.dirname(from) orelse "", name });
}

/// Whether `file` sits in the directory beside the package root `root`.
fn inPackage(root: []const u8, file: []const u8) bool {
    const stem = root[0 .. root.len - ".zig".len];
    return file.len > stem.len and std.mem.startsWith(u8, file, stem) and file[stem.len] == '/';
}

fn isPackageRoot(files: []const []const u8, path: []const u8) bool {
    if (!std.mem.endsWith(u8, path, ".zig")) return false;
    for (files) |file| if (inPackage(path, file)) return true;
    return false;
}

/// The path `root` imports the member by, when `after` (the source after an
/// import of `root`'s path, as in `").checkpoint;`) names one.
fn namedMember(alloc: std.mem.Allocator, root: []const u8, after: []const u8) !?[]const u8 {
    if (!std.mem.startsWith(u8, after, "\").")) return null;
    const rest = after["\").".len..];
    const end = std.mem.indexOfNone(u8, rest, "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_") orelse rest.len;
    const declaration = try std.fmt.allocPrint(alloc, "pub const {s} = @import(\"", .{rest[0..end]});
    const at = std.mem.indexOf(u8, root, declaration) orelse return null;
    const literal = root[at + declaration.len ..];
    return literal[0 .. std.mem.indexOfScalar(u8, literal, '"') orelse return null];
}
