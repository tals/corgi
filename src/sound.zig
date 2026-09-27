const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const a = os.allocator;

const done = @embedFile("sounds/done.mp3");
const request = @embedFile("sounds/request.mp3");
const Kind = enum { done, request };

pub fn play(kind: []const u8) !void {
    if (os.env("CORGI_BELL")) |setting| {
        if (std.mem.eql(u8, setting, "off")) return;
        if (std.mem.eql(u8, setting, "terminal")) return os.writeAll(1, "\x07");
    }
    // With a plain SSH attachment the audio device belongs to the remote host.
    // BEL travels through SSH to the viewer's terminal instead.
    if (os.env("SSH_CONNECTION") != null or os.env("SSH_TTY") != null) return os.writeAll(1, "\x07");
    const sound: Kind = if (std.mem.eql(u8, kind, "needs_input")) .request else .done;
    const thread = std.Thread.spawn(.{}, worker, .{sound}) catch return os.writeAll(1, "\x07");
    thread.detach();
}

fn worker(kind: Kind) void {
    playEmbedded(kind) catch {
        os.writeAll(1, "\x07") catch {};
    };
}

fn playEmbedded(kind: Kind) !void {
    var random: [16]u8 = undefined;
    std.crypto.random.bytes(&random);
    const filename = try std.fmt.allocPrint(a, "corgi-sound-{s}.mp3", .{std.fmt.bytesToHex(random, .lower)});
    defer a.free(filename);
    const path = try std.fs.path.join(a, &.{ os.env("TMPDIR") orelse "/tmp", filename });
    defer a.free(path);
    {
        const file = try std.fs.cwd().createFile(path, .{ .exclusive = true, .mode = 0o600 });
        defer file.close();
        errdefer std.fs.cwd().deleteFile(path) catch {};
        try file.writeAll(if (kind == .request) request else done);
    }
    defer std.fs.cwd().deleteFile(path) catch {};
    if (builtin.os.tag == .macos) {
        if (runPlayer(&.{ "afplay", path }, 15 * std.time.ns_per_s)) return;
    } else {
        // Like Herdr, only try players that decode MP3 (never bare aplay).
        const players = [_][]const []const u8{
            &.{ "paplay", path },
            &.{ "pw-play", path },
            &.{ "ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", path },
            &.{ "mpg123", "-q", path },
            &.{ "mpv", "--no-video", "--really-quiet", path },
        };
        for (players) |argv| if (runPlayer(argv, 15 * std.time.ns_per_s)) return;
    }
    return error.NoAudioPlayer;
}

fn runPlayer(argv: []const []const u8, timeout_ns: u64) bool {
    var child = std.process.Child.init(argv, a);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Ignore;
    child.stderr_behavior = .Ignore;
    child.spawn() catch return false;
    child.waitForSpawn() catch {
        _ = std.posix.waitpid(child.id, 0);
        return false;
    };
    var timer = std.time.Timer.start() catch {
        _ = os.c.kill(child.id, os.c.SIGKILL);
        _ = child.wait() catch {};
        return false;
    };
    while (true) {
        var status: c_int = 0;
        const pid = os.c.waitpid(child.id, &status, os.c.WNOHANG);
        if (pid > 0) return status == 0;
        if (pid < 0 and std.posix.errno(pid) != .INTR) return false;
        if (timer.read() >= timeout_ns) {
            _ = os.c.kill(child.id, os.c.SIGKILL);
            _ = child.wait() catch {};
            return false;
        }
        std.Thread.sleep(25 * std.time.ns_per_ms);
    }
}

test "audio player failures and timeouts are bounded" {
    try std.testing.expect(runPlayer(&.{ "/bin/sh", "-c", "exit 0" }, std.time.ns_per_s));
    try std.testing.expect(!runPlayer(&.{ "/bin/sh", "-c", "exit 1" }, std.time.ns_per_s));
    try std.testing.expect(!runPlayer(&.{"/nonexistent-corgi-player"}, std.time.ns_per_s));
    try std.testing.expect(!runPlayer(&.{ "/bin/sh", "-c", "exec sleep 5" }, 50 * std.time.ns_per_ms));
}
