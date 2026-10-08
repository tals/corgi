//! Which agent CLI a process runs: a pane's foreground job for the
//! terminal's title tracking, and the Claude process behind a hook.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const c = os.c;

/// An agent CLI Corgi recognizes by its executable or script.
pub const Provider = enum {
    codex,
    claude,

    const Info = struct {
        executables: []const []const u8,
        install_markers: []const []const u8 = &.{},
        scripts: []const []const u8,
    };
    const all = std.enums.values(Provider);
    fn named(basename: []const u8) ?Provider {
        for (all) |provider| {
            for (provider.info().executables) |executable| if (std.mem.eql(u8, basename, executable)) return provider;
        }
        return null;
    }
    fn info(provider: Provider) Info {
        return switch (provider) {
            .codex => .{ .executables = &.{"codex"}, .scripts = &.{"/@openai/codex/bin/codex.js"} },
            .claude => .{
                .executables = &.{ "claude", "claude-code" },
                // Claude's daemon launches the versioned native binary directly.
                .install_markers = &.{"/claude/versions/"},
                .scripts = &.{"/@anthropic-ai/claude-code/cli.js"},
            },
        };
    }
};
pub const Job = struct { pid: c_int, provider: Provider };

fn name(path: []const u8) ?Provider {
    if (Provider.named(std.fs.path.basename(path))) |provider| return provider;
    for (Provider.all) |provider| {
        for (provider.info().install_markers) |marker| if (std.mem.indexOf(u8, path, marker) != null) return provider;
    }
    return null;
}

// Only executable/script positions count. `sh -c 'codex ...'`, `node -e
// 'codex'`, and an editor opening a file named codex are not agents.
fn identify(argv: []const []const u8) ?Provider {
    if (argv.len == 0) return null;
    if (name(argv[0])) |direct| return direct;
    const exe = std.fs.path.basename(argv[0]);
    const interpreter = std.mem.eql(u8, exe, "node") or std.mem.eql(u8, exe, "bun") or
        std.mem.eql(u8, exe, "sh") or std.mem.eql(u8, exe, "bash") or
        std.mem.eql(u8, exe, "zsh") or std.ascii.startsWithIgnoreCase(exe, "python");
    if (!interpreter or argv.len < 2) return null;
    var i: usize = 1;
    if (std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    while (i < argv.len and argv[i].len > 0 and argv[i][0] == '-') : (i += 1) {
        if (std.mem.eql(u8, argv[i], "--")) {
            i += 1;
            break;
        }
        // Be conservative with interpreter flags that consume another argument.
        const bun_flag = std.mem.eql(u8, exe, "bun") and (std.mem.eql(u8, argv[i], "--bun") or std.mem.eql(u8, argv[i], "-b"));
        if (!bun_flag and !std.mem.eql(u8, argv[i], "-u") and !std.mem.eql(u8, argv[i], "--no-warnings")) return null;
    }
    if (i < argv.len and std.mem.eql(u8, exe, "bun") and std.mem.eql(u8, argv[i], "run")) i += 1;
    if (i >= argv.len) return null;
    const script = argv[i];
    if (name(script)) |script_name| return script_name;
    for (Provider.all) |provider| {
        for (provider.info().scripts) |suffix| if (std.mem.endsWith(u8, script, suffix)) return provider;
    }
    return null;
}

fn process(pid: c_int) ?Provider {
    var bytes: [65536]u8 = undefined;
    const p = os.processArgs(pid, &bytes, .{}) orelse return null;
    return identify(p.args());
}

/// Holds a Claude process's arguments and environment. Daemon-hosted
/// sessions carry large environments; 64 KiB is not enough.
pub const process_buffer = 1024 * 1024;

/// The Claude process a hook runs under, 0 when none was found, and
/// whether its session runs in the background.
pub const HookOrigin = struct { pid: c_int = 0, background: bool = false };

/// Claude runs hooks without its internal session variables, and its
/// background daemon hands CORGI_PANE from one pane to every session it
/// hosts. So does a `claude -p` that an agent's tool starts, but tools run
/// detached from the terminal. Only the pane's foreground Claude owns
/// CORGI_PANE, so find the hook's nearest Claude process and check it.
pub fn hookOrigin() HookOrigin {
    const a = os.allocator;
    const bytes = a.alloc(u8, process_buffer) catch return .{};
    defer a.free(bytes);
    var pid: c_int = c.getppid();
    for (0..8) |_| {
        if (pid <= 1) return .{};
        if (os.processArgs(pid, bytes, .{ .env = true })) |p| if (claudeProcess(&p)) {
            for (p.environ()) |entry| if (std.mem.eql(u8, entry, "CLAUDE_CODE_SESSION_KIND=bg")) return .{ .pid = pid, .background = true };
            return .{ .pid = pid, .background = backgroundJob(pid) };
        };
        pid = (os.processJob(pid) orelse return .{}).ppid;
    }
    return .{};
}

/// Claude retitles its processes ("claude bg-spare" as one argv[0]),
/// so also trust the executable path and argv[0]'s first word.
fn claudeProcess(p: *const os.ProcessArgs) bool {
    if (name(p.exe) == .claude) return true;
    const argv = p.args();
    if (argv.len == 0) return false;
    if (identify(argv) == .claude) return true;
    const first = argv[0][0 .. std.mem.indexOfScalar(u8, argv[0], ' ') orelse argv[0].len];
    return name(first) == .claude;
}

/// Whether the process is known to run outside its terminal's foreground
/// job, including without a controlling terminal at all.
fn backgroundJob(pid: c_int) bool {
    const info = os.processJob(pid) orelse return false;
    return info.tpgid <= 0 or info.pgid != info.tpgid;
}

pub fn foreground(fd: c_int) ?Job {
    const pgid = c.tcgetpgrp(fd);
    if (pgid <= 0) return null;
    if (process(pgid)) |leader| return .{ .pid = pgid, .provider = leader };
    if (builtin.os.tag == .macos) {
        var pids: [128]c_int = undefined;
        const n = c.proc_listpids(c.PROC_PGRP_ONLY, @intCast(pgid), &pids, @sizeOf(@TypeOf(pids)));
        if (n <= 0) return null;
        for (pids[0..@min(pids.len, @as(usize, @intCast(n)) / @sizeOf(c_int))]) |pid| {
            if (pid <= 0 or pid == pgid) continue;
            if (process(pid)) |provider| return .{ .pid = pid, .provider = provider };
        }
    } else if (builtin.os.tag == .linux) {
        var dir = std.Io.Dir.openDirAbsolute(os.io(), "/proc", .{ .iterate = true }) catch return null;
        defer dir.close(os.io());
        var it = dir.iterate();
        while (it.next(os.io()) catch null) |entry| {
            const pid = std.fmt.parseInt(c_int, entry.name, 10) catch continue;
            if (pid == pgid or c.getpgid(pid) != pgid) continue;
            if (process(pid)) |provider| return .{ .pid = pid, .provider = provider };
        }
    }
    return null;
}

test "identify actual executables and scripts, not arguments or shell text" {
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{"/opt/bin/codex"}));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "node", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "bun", "/a/node_modules/@openai/codex/bin/codex.js" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "bun", "run", "--bun", "/a/node_modules/@anthropic-ai/claude-code/cli.js" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "python3", "/tmp/codex" }));
    try std.testing.expectEqual(@as(?Provider, .codex), identify(&.{ "/Frameworks/Python", "/tmp/codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "sh", "-c", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "node", "-e", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "bun", "-e", "codex" }));
    try std.testing.expectEqual(@as(?Provider, null), identify(&.{ "vim", "codex" }));
    try std.testing.expectEqual(@as(?Provider, .claude), identify(&.{ "/Users/a/.local/share/claude/versions/2.1.282", "--session-id", "x" }));
}

test "a retitled Claude process is still Claude" {
    var p: os.ProcessArgs = .{ .exe = "/usr/bin/node" };
    p.argv[0] = "claude bg-spare";
    p.argc = 1;
    try std.testing.expect(claudeProcess(&p));
    p.argv[0] = "node";
    try std.testing.expect(!claudeProcess(&p));
    p.exe = "/opt/claude/bin/claude";
    try std.testing.expect(claudeProcess(&p));
}

test "a detached process is a background job and a terminal's foreground is not" {
    var byte: [1]u8 = undefined;
    var ready: [2]c_int = undefined;
    try std.testing.expectEqual(@as(c_int, 0), c.pipe(&ready));
    defer _ = c.close(ready[0]);
    // Agent tools start commands like this, in a new session without a terminal.
    const detached = c.fork();
    if (detached == 0) {
        _ = c.setsid();
        _ = c.write(ready[1], "x", 1);
        while (true) _ = c.pause();
    }
    _ = c.close(ready[1]);
    if (detached < 0) return error.ForkFailed;
    defer _ = c.waitpid(detached, null, 0);
    defer _ = c.kill(detached, c.SIGKILL);
    try std.testing.expectEqual(@as(isize, 1), c.read(ready[0], &byte, 1));
    try std.testing.expect(backgroundJob(detached));

    var fd: c_int = undefined;
    const leader = c.forkpty(&fd, null, null, null);
    if (leader == 0) {
        _ = c.write(1, "x", 1);
        while (true) _ = c.pause();
    }
    if (leader < 0) return error.ForkFailed;
    defer _ = c.close(fd);
    defer _ = c.waitpid(leader, null, 0);
    defer _ = c.kill(leader, c.SIGKILL);
    try std.testing.expectEqual(@as(isize, 1), c.read(fd, &byte, 1));
    try std.testing.expect(!backgroundJob(leader));
}