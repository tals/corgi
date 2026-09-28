//! Signed HTTP feed, immutable local versions, and session-aware activation.
//! Bump the first ABI component when runtime/checkpoint/viewer changes cannot
//! coexist across a live handoff. Release version changes do not change the ABI.
const std = @import("std");
const builtin = @import("builtin");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const opts = @import("corgi_options");
const agents = @import("agents.zig");
const atomicWrite = @import("recovery.zig").atomicWrite;
const recoveryPath = @import("recovery.zig").path;
const Connection = @import("rpc.zig").Connection;
pub const abi = std.fmt.comptimePrint("1-{x}", .{opts.terminal_checkpoint_abi});
const platform = switch (builtin.os.tag) {
    .macos => "macos-aarch64",
    else => "linux-x86_64",
};
const max_binary = 256 * 1024 * 1024;
const Envelope = struct { payload: []const u8, signature: []const u8 };
const Target = struct { url: []const u8, sha256: []const u8, size: u64 };
const Manifest = struct {
    schema_version: u32,
    version: []const u8,
    commit: []const u8,
    update_abi: []const u8,
    targets: struct { @"macos-aarch64": Target, @"linux-x86_64": Target },
    fn target(m: Manifest) Target {
        return @field(m.targets, platform);
    }
};
fn join(root: []const u8, name: []const u8) ![]u8 {
    return std.fs.path.join(a, &.{ root, name });
}
fn read(root: []const u8, name: []const u8) !?[]u8 {
    const p = try join(root, name);
    defer a.free(p);
    return std.fs.cwd().readFileAlloc(a, p, 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => null,
        else => return err,
    };
}
fn write(root: []const u8, name: []const u8, bytes: []const u8) !void {
    const p = try join(root, name);
    defer a.free(p);
    try atomicWrite(p, bytes);
}
fn remove(root: []const u8, name: []const u8) void {
    const p = join(root, name) catch return;
    defer a.free(p);
    std.fs.cwd().deleteFile(p) catch {};
}
fn exists(root: []const u8, name: []const u8) bool {
    const bytes = (read(root, name) catch return false) orelse return false;
    a.free(bytes);
    return true;
}
fn version(s: []const u8) !std.SemanticVersion {
    if (s.len >= 24 and s.len <= 57 and s[8] == 'T' and s[15] == 'Z' and s[16] == '-') {
        for (s[0..8]) |ch| if (!std.ascii.isDigit(ch)) return error.InvalidReleaseVersion;
        for (s[9..15]) |ch| if (!std.ascii.isDigit(ch)) return error.InvalidReleaseVersion;
        for (s[17..]) |ch| if (!std.ascii.isDigit(ch) and !(ch >= 'a' and ch <= 'f')) return error.InvalidReleaseVersion;
        return .{ .major = try std.fmt.parseInt(usize, s[0..8], 10), .minor = try std.fmt.parseInt(usize, s[9..15], 10), .patch = 0 };
    }
    for (s) |ch| if ((ch < '0' or ch > '9') and ch != '.') return error.InvalidReleaseVersion;
    const v = std.SemanticVersion.parse(s) catch return error.InvalidReleaseVersion;
    if (v.pre != null or v.build != null) return error.InvalidReleaseVersion;
    return v;
}
fn executable(root: []const u8, ver: []const u8) ![]u8 {
    _ = try version(ver);
    return std.fs.path.join(a, &.{ root, "releases", ver, "corgi" });
}
fn managed(exe: []const u8) !?[]u8 {
    if (opts.update_url.len == 0 or opts.update_public_key.len != 64) return null;
    const dir = std.fs.path.dirname(exe) orelse return null;
    const releases = std.fs.path.dirname(dir) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(releases), "releases")) return null;
    const root = std.fs.path.dirname(releases) orelse return null;
    if (!std.mem.eql(u8, std.fs.path.basename(dir), opts.release_version) or !exists(root, "current")) return null;
    try os.privateDirectory(root);
    return try a.dupe(u8, root);
}
/// The downloaded release newer than this build, which the next launch activates.
pub fn stagedVersion(exe: []const u8, buf: []u8) ?[]const u8 {
    const root = (managed(exe) catch return null) orelse return null;
    defer a.free(root);
    const bytes = (read(root, "staged") catch return null) orelse return null;
    defer a.free(bytes);
    const newer = (version(bytes) catch return null).order(version(opts.release_version) catch return null) == .gt;
    if (!newer or bytes.len > buf.len) return null;
    @memcpy(buf[0..bytes.len], bytes);
    return buf[0..bytes.len];
}
/// "20260925T183012Z-be82c7b9090a" reads as "2026-09-25 · be82c7b". A known
/// commit replaces the version's hash, so development builds show theirs too.
pub fn label(buf: []u8, ver: []const u8, commit: []const u8) []const u8 {
    const release = ver.len >= 24 and ver[8] == 'T' and ver[16] == '-';
    const dirty = std.mem.endsWith(u8, commit, "-dirty");
    const hex = commit.len >= 7 and for (commit[0..7]) |ch| {
        if (!std.ascii.isHex(ch)) break false;
    } else true;
    const short = if (hex) commit[0..7] else if (release) ver[17..24] else "";
    const suffix = if (hex and dirty) "-dirty" else "";
    const out = if (release)
        std.fmt.bufPrint(buf, "{s}-{s}-{s} · {s}{s}", .{ ver[0..4], ver[4..6], ver[6..8], short, suffix })
    else if (short.len > 0)
        std.fmt.bufPrint(buf, "{s} · {s}{s}", .{ ver, short, suffix })
    else
        return ver;
    return out catch ver;
}
fn lock(root: []const u8, name: []const u8, wait: bool) !?std.fs.File {
    const p = try join(root, name);
    defer a.free(p);
    const file = try std.fs.cwd().createFile(p, .{ .truncate = false, .mode = 0o600 });
    errdefer file.close();
    if (wait) try file.lock(.exclusive) else if (!try file.tryLock(.exclusive)) {
        file.close();
        return null;
    }
    return file;
}
fn parse(bytes: []const u8) !std.json.Parsed(Manifest) {
    const envelope = try std.json.parseFromSlice(Envelope, a, bytes, .{});
    defer envelope.deinit();
    var pk: [32]u8 = undefined;
    var signature: [64]u8 = undefined;
    if (opts.update_public_key.len != 64 or envelope.value.signature.len != 128) return error.BadUpdateSignature;
    _ = try std.fmt.hexToBytes(&pk, opts.update_public_key);
    _ = try std.fmt.hexToBytes(&signature, envelope.value.signature);
    const Ed = std.crypto.sign.Ed25519;
    try Ed.Signature.fromBytes(signature).verify(envelope.value.payload, try Ed.PublicKey.fromBytes(pk));
    const m = try std.json.parseFromSlice(Manifest, a, envelope.value.payload, .{ .allocate = .alloc_always });
    errdefer m.deinit();
    if (m.value.schema_version != 1) return error.UnknownUpdateSchema;
    _ = try version(m.value.version);
    const t = m.value.target();
    if (t.size == 0 or t.size > max_binary or t.sha256.len != 64) return error.InvalidUpdateTarget;
    if (!std.mem.startsWith(u8, t.url, "https://") and !(opts.update_test_mode and std.mem.startsWith(u8, t.url, "http://127.0.0.1:"))) return error.InsecureUpdateURL;
    return m;
}
fn run(argv: []const []const u8) !void {
    const result = try std.process.Child.run(.{ .allocator = a, .argv = argv, .max_output_bytes = 1024 * 1024 });
    defer a.free(result.stdout);
    defer a.free(result.stderr);
    if (result.term != .Exited or result.term.Exited != 0) return error.UpdateSubprocessFailed;
}
fn fetch(url: []const u8, dest: []const u8, limit: u64) !void {
    const size = try std.fmt.allocPrint(a, "{d}", .{limit});
    defer a.free(size);
    const proto = if (opts.update_test_mode) "=http,https" else "=https";
    try run(&.{
        "curl",          "--disable",  "--fail",            "--silent",
        "--show-error",  "--location", "--proto",           proto,
        "--proto-redir", proto,        "--connect-timeout", "10",
        "--max-time",    "300",        "--max-filesize",    size,
        "--output",      dest,         url,
    });
}
fn hashFile(path: []const u8) ![64]u8 {
    var file = try std.fs.cwd().openFile(path, .{});
    defer file.close();
    var hash = std.crypto.hash.sha2.Sha256.init(.{});
    var buf: [65536]u8 = undefined;
    while (true) {
        const n = try file.read(&buf);
        if (n == 0) break;
        hash.update(buf[0..n]);
    }
    return std.fmt.bytesToHex(hash.finalResult(), .lower);
}
fn verifyFile(path: []const u8, t: Target) !void {
    var f = try std.fs.cwd().openFile(path, .{});
    defer f.close();
    if ((try f.stat()).size != t.size or !std.mem.eql(u8, &(try hashFile(path)), t.sha256)) return error.UpdateChecksumMismatch;
}
fn feed(root: []const u8, download: bool, explicit: bool) !void {
    const guard = (try lock(root, "download.lock", explicit)) orelse return;
    defer guard.close();
    const temp = try join(root, "feed.tmp");
    defer a.free(temp);
    defer std.fs.cwd().deleteFile(temp) catch {};
    const url = try std.fmt.allocPrint(a, "{s}/channels/stable.json", .{opts.update_url});
    defer a.free(url);
    try fetch(url, temp, 1024 * 1024);
    const bytes = try std.fs.cwd().readFileAlloc(a, temp, 1024 * 1024);
    defer a.free(bytes);
    const m = try parse(bytes);
    defer m.deinit();
    const current = (try read(root, "current")) orelse return error.MissingInstalledVersion;
    defer a.free(current);
    if ((try version(m.value.version)).order(try version(current)) != .gt) {
        if (explicit) try os.writeAll(1, "Corgi is up to date.\n");
        return;
    }
    if (!explicit) if (try read(root, "suppressed")) |v| {
        defer a.free(v);
        if ((try version(m.value.version)).order(try version(v)) != .gt) return;
    };
    if (explicit) std.debug.print("Corgi {s} is available.{s}\n", .{ m.value.version, if (download) " Downloading…" else "" });
    if (!download) return;
    const dest = try executable(root, m.value.version);
    defer a.free(dest);
    const dir = std.fs.path.dirname(dest).?;
    try os.privateDirectory(dir);
    // A completed immutable version is reusable, but always verify it first.
    verifyFile(dest, m.value.target()) catch {
        const partial = try join(dir, "download.tmp");
        defer a.free(partial);
        defer std.fs.cwd().deleteFile(partial) catch {};
        try fetch(m.value.target().url, partial, m.value.target().size);
        try verifyFile(partial, m.value.target());
        var f = try std.fs.cwd().openFile(partial, .{ .mode = .read_write });
        defer f.close();
        try f.chmod(0o700);
        try f.sync();
        // Never replace a completed executable (it may own a live runtime).
        if (std.fs.cwd().access(dest, .{})) |_| return error.ExistingReleaseDiffers else |err| if (err != error.FileNotFound) return err;
        try std.fs.cwd().rename(partial, dest);
    };
    try write(dir, "manifest.json", bytes);
    try write(root, "staged", m.value.version);
    remove(root, "last-error");
}
fn rpc(socket: []const u8, value: anytype) !std.json.Parsed(std.json.Value) {
    const fd = try os.connect(socket);
    defer _ = c.close(fd);
    var conn: Connection = .{ .fd = fd };
    return conn.call(value);
}
fn hello(socket: []const u8) !?std.json.Parsed(std.json.Value) {
    return rpc(socket, .{ .op = "hello", .protocol = 1 }) catch |err| switch (err) {
        error.FileNotFound, error.ConnectionRefused => null,
        else => return err,
    };
}
fn switchCurrent(root: []const u8, ver: []const u8) !void {
    const old = (try read(root, "current")) orelse return error.MissingInstalledVersion;
    defer a.free(old);
    if (!std.mem.eql(u8, old, ver)) {
        try write(root, "previous", old);
        try write(root, "current", ver);
    }
    const staged = try read(root, "staged");
    if (staged) |s| {
        defer a.free(s);
        if (std.mem.eql(u8, s, ver)) remove(root, "staged");
    }
}
fn recordError(root: []const u8, err: anyerror) void {
    write(root, "last-error", @errorName(err)) catch {};
}
fn reexec(exe: []const u8, cmd: []const u8) !noreturn {
    return os.exec(&.{ exe, cmd, "--update-routed" });
}
const Animation = struct {
    stop: std.atomic.Value(bool) = .init(false),
    fn animate(self: *Animation) void {
        const frames = [_][]const u8{ " /ᐠ•ᴥ•ᐟ\\  Updating.  ", " /ᐠ•ᴥ•ᐟ\\  Updating.. ", " /ᐠ•ᴥ•ᐟ\\  Updating..." };
        var tick: usize = 0;
        while (!self.stop.load(.acquire)) : (tick += 1) {
            os.writeAll(2, "\r") catch {};
            os.writeAll(2, frames[(tick / 3) % frames.len]) catch {};
            std.Thread.sleep(80 * std.time.ns_per_ms);
        }
        os.writeAll(2, "\r\x1b[2K") catch {};
    }
};
fn activate(root: []const u8, socket: []const u8, ver: []const u8, target: []const u8, live: bool) !void {
    var animation: Animation = .{};
    const thread = if (c.isatty(2) != 0) try std.Thread.spawn(.{}, Animation.animate, .{&animation}) else null;
    defer {
        animation.stop.store(true, .release);
        if (thread) |t| t.join();
    }
    if (live) {
        const response = rpc(socket, .{ .op = "server.reload", .protocol = 1, .executable = target }) catch |err| {
            // A lost reply is not evidence that ownership failed to commit.
            // Probe before deciding whether to stay on the old executable.
            if (try hello(socket)) |h| {
                defer h.deinit();
                if (std.mem.eql(u8, agents.str(h.value, "executable"), target)) {
                    try switchCurrent(root, ver);
                    return;
                }
            }
            return err;
        };
        response.deinit();
    } else {
        try run(&.{ target, "__update-start" });
    }
    const h = (try hello(socket)) orelse return error.UpdateRuntimeNotReady;
    defer h.deinit();
    if (!std.mem.eql(u8, agents.str(h.value, "executable"), target)) return error.UpdateRuntimeChanged;
    try switchCurrent(root, ver);
}
fn deferName(socket: []const u8, pid: i64) ![]u8 {
    return std.fmt.allocPrint(a, "deferred-{x}-{d}", .{ std.hash.Wyhash.hash(0, socket), pid });
}
var prompt_term: ?c.struct_termios = null;
fn cancelPrompt(_: c_int) callconv(.c) void {
    if (prompt_term) |*term| _ = c.tcsetattr(0, c.TCSANOW, term);
    c._exit(130);
}
fn confirmRestart(socket: []const u8) !?bool {
    if (c.isatty(0) == 0 or c.isatty(2) == 0 or os.env("CORGI_PANE") != null) return null;
    const snapshot = try rpc(socket, .{ .op = "session.snapshot", .protocol = 1 });
    defer snapshot.deinit();
    try os.writeAll(2, "\n /ᐠ•ᴥ•ᐟ\\  An update is ready, but this session could not be moved safely.\n\nRestarting will stop ALL shells and agents in this runtime and disconnect\nits other viewers. Saved layout and output can be restored; running processes\nwill not survive.\n\nEnter / Esc: keep working     r: restart and update… ");
    var term: c.struct_termios = undefined;
    if (c.tcgetattr(0, &term) != 0) return false;
    prompt_term = term;
    const old_int = c.signal(c.SIGINT, cancelPrompt);
    const old_term = c.signal(c.SIGTERM, cancelPrompt);
    const old_hup = c.signal(c.SIGHUP, cancelPrompt);
    defer {
        _ = c.tcsetattr(0, c.TCSANOW, &term);
        prompt_term = null;
        _ = c.signal(c.SIGINT, old_int);
        _ = c.signal(c.SIGTERM, old_term);
        _ = c.signal(c.SIGHUP, old_hup);
    }
    var raw = term;
    raw.c_lflag &= ~@as(c.tcflag_t, c.ICANON | c.ECHO);
    raw.c_cc[c.VMIN] = 1;
    raw.c_cc[c.VTIME] = 0;
    if (c.tcsetattr(0, c.TCSANOW, &raw) != 0) return false;
    var key: [1]u8 = undefined;
    const n = c.read(0, &key, 1);
    _ = c.tcsetattr(0, c.TCSANOW, &term);
    try os.writeAll(2, "\n");
    if (n != 1 or key[0] != 'r') return false;
    try os.writeAll(2, "Type restart to stop these processes and update: ");
    const line = try os.readLine(0, 128);
    defer a.free(line);
    return std.mem.eql(u8, std.mem.trim(u8, line, "\r\n"), "restart");
}
// Returns the executable compatible with the runtime (or selected installation).
fn select(root: []const u8, socket: []const u8, allow: bool, explicit: bool, rollback: bool) ![]u8 {
    const guard = try lock(root, "activation.lock", explicit);
    defer if (guard) |g| g.close();
    var h = try hello(socket);
    defer if (h) |*v| v.deinit();
    const current = (try read(root, "current")) orelse return error.MissingInstalledVersion;
    defer a.free(current);
    const fallback = if (h) |v| agents.str(v.value, "executable") else "";
    if (h != null and fallback.len == 0) return error.RuntimeDoesNotSupportUpdates;
    const old_exe = if (fallback.len > 0) try a.dupe(u8, fallback) else try executable(root, current);
    errdefer a.free(old_exe);
    if (!allow or guard == null) return old_exe;
    const candidate = (try read(root, if (rollback) "previous" else "staged")) orelse
        if (rollback) return old_exe else try a.dupe(u8, current);
    defer a.free(candidate);
    if (!rollback and (try version(candidate)).order(try version(current)) == .lt) return old_exe;
    const target = try executable(root, candidate);
    defer a.free(target);
    if (std.mem.eql(u8, target, old_exe)) {
        try switchCurrent(root, candidate);
        return old_exe;
    }
    const dir = std.fs.path.dirname(target).?;
    // Bootstrap installs also retain their signed manifest, permitting rollback.
    const bytes = (try read(dir, "manifest.json")) orelse return error.MissingReleaseManifest;
    defer a.free(bytes);
    const m = try parse(bytes);
    defer m.deinit();
    if (!std.mem.eql(u8, m.value.version, candidate)) return error.WrongReleaseManifest;
    try verifyFile(target, m.value.target());
    var safe = true;
    var deferred: ?[]u8 = null;
    defer if (deferred) |d| a.free(d);
    if (h) |v| {
        safe = std.mem.eql(u8, agents.str(v.value, "update_abi"), m.value.update_abi);
        const pid = switch (v.value.object.get("server_pid") orelse .null) {
            .integer => |n| n,
            else => return error.UpdateRuntimeChanged,
        };
        deferred = try deferName(socket, pid);
        if (!explicit) if (try read(root, deferred.?)) |d| {
            defer a.free(d);
            if (std.mem.eql(u8, d, candidate)) return old_exe;
        };
    }
    if (safe) {
        activate(root, socket, candidate, target, h != null) catch |err| {
            recordError(root, err);
            safe = false;
        };
        if (safe) {
            if (rollback) try write(root, "suppressed", current);
            a.free(old_exe);
            return try a.dupe(u8, target);
        }
        // Re-evaluate ownership after any activation failure; never shut down a
        // runtime whose state is unknown after the handoff commit point.
        if (h) |*v| v.deinit();
        h = null;
        h = try hello(socket);
        if (h) |v| if (std.mem.eql(u8, agents.str(v.value, "executable"), target)) {
            a.free(old_exe);
            return try a.dupe(u8, target);
        };
    }
    const decision = if (h != null) try confirmRestart(socket) else null;
    if (decision orelse false) {
        // The prompt may have been left open while the runtime changed.
        const fresh = (try hello(socket)) orelse return error.UpdateRuntimeChanged;
        defer fresh.deinit();
        const fresh_pid = switch (fresh.value.object.get("server_pid") orelse .null) {
            .integer => |n| n,
            else => return error.UpdateRuntimeChanged,
        };
        const stale_pid = switch (h.?.value.object.get("server_pid") orelse .null) {
            .integer => |n| n,
            else => return error.UpdateRuntimeChanged,
        };
        if (fresh_pid != stale_pid) return error.UpdateRuntimeChanged;
        // Backup the recovery file before the explicitly destructive operation.
        const saved = try rpc(socket, .{ .op = "recovery.save", .protocol = 1 });
        saved.deinit();
        const recovery = try recoveryPath(socket);
        defer a.free(recovery);
        const backup = try std.fmt.allocPrint(a, "{s}.before-update", .{recovery});
        defer a.free(backup);
        try std.fs.cwd().copyFile(recovery, std.fs.cwd(), backup, .{});
        const shutdown = try rpc(socket, .{ .op = "shutdown" });
        shutdown.deinit();
        var stopped = false;
        for (0..100) |_| {
            if (try hello(socket)) |v| {
                v.deinit();
                std.Thread.sleep(50 * std.time.ns_per_ms);
            } else {
                stopped = true;
                break;
            }
        }
        if (!stopped) return error.RuntimeDidNotStop;
        try activate(root, socket, candidate, target, false);
        if (rollback) try write(root, "suppressed", current);
        a.free(old_exe);
        return try a.dupe(u8, target);
    }
    if (decision != null) if (deferred) |d| try write(root, d, candidate);
    if (explicit) {
        try os.writeAll(2, "Update remains downloaded. Keep working, or run corgi update from an outside terminal to choose a restart.\n");
        return error.UpdateDeferred;
    }
    return old_exe;
}
pub fn startup(socket: []const u8, exe: []const u8, cmd: []const u8, skip: bool) !void {
    const root = (try managed(exe)) orelse return;
    defer a.free(root);
    const target = select(root, socket, !skip and !exists(root, "auto-off"), false, false) catch |err| {
        recordError(root, err);
        // Network and local staging failures must never prevent attachment.
        if (try hello(socket)) |h| {
            defer h.deinit();
            const running = agents.str(h.value, "executable");
            if (running.len > 0 and !std.mem.eql(u8, running, exe)) try reexec(running, cmd);
        }
        return;
    };
    defer a.free(target);
    if (!std.mem.eql(u8, target, exe)) try reexec(target, cmd);
}
pub fn command(args: []const []const u8, socket: []const u8, exe: []const u8) !void {
    const root = (try managed(exe)) orelse {
        try os.writeAll(2, "This is a development or unmanaged build. Install a release to enable updates.\n");
        return error.UnmanagedInstallation;
    };
    defer a.free(root);
    const Command = enum { auto, status, rollback, @"--check", @"--download-only" };
    const cmd = if (args.len == 0) null else std.meta.stringToEnum(Command, args[0]);
    if (args.len == 2 and cmd == .auto) {
        const Toggle = enum { on, off };
        const toggle = std.meta.stringToEnum(Toggle, args[1]) orelse return error.Usage;
        if (toggle == .off) try write(root, "auto-off", "off") else {
            remove(root, "auto-off");
            try background(socket, exe);
        }
        return;
    }
    if (args.len == 1 and cmd == .status) {
        std.debug.print("Automatic updates: {s}\n", .{if (exists(root, "auto-off")) "off" else "on"});
        for ([_][]const u8{ "current", "staged", "previous", "suppressed", "last-error" }) |name| {
            if (try read(root, name)) |value| {
                defer a.free(value);
                std.debug.print("{s}: {s}\n", .{ name, value });
            }
        }
        if (try hello(socket)) |h| {
            defer h.deinit();
            std.debug.print("running: {s}\n", .{agents.str(h.value, "release_version")});
        }
        return;
    }
    const rollback = args.len == 1 and cmd == .rollback;
    if (args.len > 1 or (args.len == 1 and !rollback and cmd != .@"--check" and cmd != .@"--download-only")) return error.Usage;
    if (!rollback) try feed(root, args.len == 0 or cmd == .@"--download-only", true);
    if (args.len == 1 and !rollback) return;
    if (rollback and !exists(root, "previous")) return error.NoPreviousRelease;
    const target = try select(root, socket, true, true, rollback);
    defer a.free(target);
    try os.writeAll(1, "Corgi is ready.\n");
    // Existing compatible viewers stay connected; new viewers use this version.
}
pub fn background(socket: []const u8, exe: []const u8) !void {
    const root = (try managed(exe)) orelse return;
    defer a.free(root);
    if (exists(root, "auto-off")) return;
    const pid = c.fork();
    if (pid < 0) return error.ForkFailed;
    if (pid == 0) {
        _ = c.setsid();
        const child = c.fork();
        if (child < 0) c._exit(1);
        if (child > 0) c._exit(0);
        const devnull = c.open("/dev/null", c.O_RDWR);
        for (0..3) |fd| _ = c.dup2(devnull, @intCast(fd));
        if (devnull > 2) _ = c.close(devnull);
        os.exec(&.{ exe, "__update-worker", socket }) catch c._exit(1);
    }
    var status: c_int = 0;
    _ = c.waitpid(pid, &status, 0);
}
fn worker(socket: []const u8) !void {
    const exe = try std.fs.selfExePathAlloc(a);
    defer a.free(exe);
    const root = (try managed(exe)) orelse return;
    defer a.free(root);
    // One worker per runtime: downloads themselves share an installation lock.
    // This allows one runtime to exit without stranding another's update checks.
    const name = try std.fmt.allocPrint(a, "worker-{x}.lock", .{std.hash.Wyhash.hash(0, socket)});
    defer a.free(name);
    const guard = (try lock(root, name, false)) orelse return;
    defer guard.close();
    var next: i64 = 0;
    while (!exists(root, "auto-off")) {
        const h = (try hello(socket)) orelse return;
        h.deinit();
        const now = std.time.timestamp();
        if (now >= next) {
            feed(root, true, false) catch |err| recordError(root, err);
            next = now + 3600 + std.crypto.random.intRangeLessThan(i64, 0, 300);
        }
        std.Thread.sleep(30 * std.time.ns_per_s);
    }
}
pub fn internal(args: []const []const u8) !bool {
    if (args.len < 2) return false;
    const Internal = enum { @"__update-worker", @"__update-info", __install };
    const cmd = std.meta.stringToEnum(Internal, args[1]) orelse return false;
    switch (cmd) {
        .@"__update-worker" => {
            if (args.len != 3) return false;
            try worker(args[2]);
        },
        .@"__update-info" => {
            const bytes = try std.json.Stringify.valueAlloc(a, .{
                .version = opts.release_version,
                .commit = opts.release_commit,
                .update_abi = abi,
                .platform = platform,
                .test_mode = opts.update_test_mode,
            }, .{});
            defer a.free(bytes);
            try os.writeAll(1, bytes);
        },
        .__install => {
            if (args.len != 5) return false;
            try install(args[2], args[3], args[4]);
        },
    }
    return true;
}
fn install(root: []const u8, bin: []const u8, manifest_path: []const u8) !void {
    if (!std.fs.path.isAbsolute(root) or !std.fs.path.isAbsolute(bin)) return error.AbsoluteInstallPathRequired;
    try os.privateDirectory(root);
    const guard = (try lock(root, "activation.lock", true)).?;
    defer guard.close();
    if (exists(root, "current")) return error.AlreadyInstalled;
    const bytes = try std.fs.cwd().readFileAlloc(a, manifest_path, 1024 * 1024);
    defer a.free(bytes);
    const m = try parse(bytes);
    defer m.deinit();
    if (!std.mem.eql(u8, m.value.version, opts.release_version) or !std.mem.eql(u8, m.value.commit, opts.release_commit)) return error.WrongReleaseManifest;
    const exe = try std.fs.selfExePathAlloc(a);
    defer a.free(exe);
    try verifyFile(exe, m.value.target());
    const dest = try executable(root, opts.release_version);
    defer a.free(dest);
    const dir = std.fs.path.dirname(dest).?;
    try os.privateDirectory(dir);
    try std.fs.cwd().copyFile(exe, std.fs.cwd(), dest, .{ .override_mode = 0o700 });
    try write(dir, "manifest.json", bytes);
    // Quote the install root for a POSIX shell. No shell-dependent PATH edits.
    var quoted: std.ArrayList(u8) = .empty;
    defer quoted.deinit(a);
    try quoted.append(a, '\'');
    for (root) |ch| {
        if (ch == '\'') try quoted.appendSlice(a, "'\\''") else try quoted.append(a, ch);
    }
    try quoted.append(a, '\'');
    const launcher = try std.fmt.allocPrint(a, "#!/bin/sh\nset -eu\nroot={s}\nv=$(cat \"$root/current\")\ncase \"$v\" in ''|*[!0-9.a-fTZ-]*) echo 'Invalid Corgi version' >&2; exit 1;; esac\nexec \"$root/releases/$v/corgi\" \"$@\"\n", .{quoted.items});
    defer a.free(launcher);
    try std.fs.cwd().makePath(std.fs.path.dirname(bin).?);
    const file = try std.fs.cwd().createFile(bin, .{ .exclusive = true, .mode = 0o755 });
    defer file.close();
    try file.writeAll(launcher);
    try file.sync();
    try write(root, "current", opts.release_version);
    std.debug.print("Installed Corgi {s} at {s}\nAdd its directory to PATH if needed, then run corgi.\n", .{ opts.release_version, bin });
}
test "release versions cannot escape installation paths" {
    try std.testing.expectError(error.InvalidReleaseVersion, version("../../bin"));
    try std.testing.expectError(error.InvalidReleaseVersion, version("1.0.0-beta"));
    try std.testing.expectEqual(@as(usize, 2), (try version("1.2.3")).minor);
}

test "timestamp releases sort by UTC date and time" {
    const first = try version("20260925T003012Z-abcdef012345");
    const second = try version("20260925T003013Z-123456abcdef");
    try std.testing.expect(first.order(second) == .lt);
    try std.testing.expectError(error.InvalidReleaseVersion, version("20260925T003012Z-../../abcdef"));
}
