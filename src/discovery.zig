//! Find an installed provider without requiring configuration. Package
//! wrappers can be executable even when their native binary is missing, so a
//! provider with a `version_prefix` only accepts candidates whose --version
//! output identifies them.
const std = @import("std");
const builtin = @import("builtin");
const options = @import("corgi_options");
const os = @import("os.zig");
const a = os.allocator;
const c = os.c;
const Provider = @import("agents.zig").Provider;
const providers = @import("providers.zig");
/// Integration tests move system install locations under a fixture directory,
/// so what happens to be installed on the machine cannot satisfy discovery.
fn systemRoot() []const u8 {
    if (!options.test_build) return "";
    return os.env("CORGI_TEST_SYSTEM_ROOT") orelse "";
}

/// The caller owns the result. Explicit overrides preserve execvp semantics.
pub fn resolve(provider: Provider, cwd: ?[]const u8) ![]const u8 {
    const info = provider.info();
    const command = info.executables[0];
    if (os.env(info.binary_env)) |path| if (path.len > 0 or info.version_prefix == null) return a.dupe(u8, path);
    const version_prefix = info.version_prefix orelse return a.dupe(u8, command);
    const current = try std.process.getCwdAlloc(a);
    defer a.free(current);
    const base = try std.fs.path.resolve(a, &.{ current, cwd orelse current });
    defer a.free(base);
    var finder: Finder = .{ .timer = try std.time.Timer.start(), .command = command, .version_prefix = version_prefix, .bundles = info.app_bundles };
    defer finder.deinit();

    if (os.env("PATH")) |path| {
        // Unlike os.PathSearch, relative entries count here: the agent runs
        // in `cwd`, where the user's shell would resolve them the same way.
        var dirs = std.mem.splitScalar(u8, path, ':');
        while (dirs.next()) |dir| {
            const candidate = try std.fs.path.resolve(a, &.{ base, dir, command });
            defer a.free(candidate);
            if (try finder.candidate(candidate)) |found| return found;
        }
    }
    const user_home = os.env("HOME");
    if (user_home) |home_dir| {
        for (info.home_paths) |relative| {
            const candidate = try std.fs.path.join(a, &.{ home_dir, relative });
            defer a.free(candidate);
            if (try finder.candidate(candidate)) |found| return found;
        }
        if (builtin.os.tag == .macos and info.app_bundles.len > 0) {
            const apps = try std.fs.path.join(a, &.{ home_dir, "Applications" });
            defer a.free(apps);
            if (try finder.applications(apps)) |found| return found;
        }
    }
    const root = systemRoot();
    for (info.system_paths) |system| {
        const candidate = try std.fmt.allocPrint(a, "{s}{s}", .{ root, system });
        defer a.free(candidate);
        if (try finder.candidate(candidate)) |found| return found;
    }
    if (builtin.os.tag == .macos and info.app_bundles.len > 0) {
        const apps = try std.fmt.allocPrint(a, "{s}/Applications", .{root});
        defer a.free(apps);
        if (try finder.applications(apps)) |found| return found;
    }
    return error.ProviderNotFound;
}

const Finder = struct {
    seen: std.StringHashMapUnmanaged(void) = .empty,
    timer: std.time.Timer,
    command: []const u8,
    version_prefix: []const u8,
    bundles: []const []const u8,
    // Stay below the control client's three-second request timeout.
    const budget = 2 * std.time.ns_per_s;

    fn deinit(f: *Finder) void {
        var keys = f.seen.keyIterator();
        while (keys.next()) |key| a.free(key.*);
        f.seen.deinit(a);
    }
    fn candidate(f: *Finder, path: []const u8) !?[]const u8 {
        // A pane-local agent symlink invokes Corgi's launcher. Probing it
        // would recurse back into discovery rather than identify a provider.
        const self = try std.fs.selfExePathAlloc(a);
        defer a.free(self);
        const self_real = try std.fs.cwd().realpathAlloc(a, self);
        defer a.free(self_real);
        const real = std.fs.cwd().realpathAlloc(a, path) catch return null;
        defer a.free(real);
        if (std.mem.eql(u8, self_real, real)) return null;
        // Preserve symlink paths: package-manager shims may dispatch using argv[0].
        if (f.seen.contains(path)) return null;
        const owned = try a.dupe(u8, path);
        f.seen.put(a, owned, {}) catch |err| {
            a.free(owned);
            return err;
        };
        const z = try a.dupeZ(u8, path);
        defer a.free(z);
        const stat = std.posix.fstatat(std.posix.AT.FDCWD, path, 0) catch return null;
        if ((stat.mode & c.S_IFMT) != c.S_IFREG or c.access(z, c.X_OK) != 0) return null;
        const remaining = budget -| f.timer.read();
        if (remaining == 0) return null;
        if (probe(path, f.version_prefix, @min(remaining, 750 * std.time.ns_per_ms))) return try a.dupe(u8, path);
        return null;
    }
    fn applications(f: *Finder, root: []const u8) !?[]const u8 {
        // Prefer stable app names, then allow renamed/beta app bundles too.
        for (f.bundles) |name| {
            if (try f.bundle(root, name)) |found| return found;
        }
        var dir = std.fs.cwd().openDir(root, .{ .iterate = true }) catch return null;
        defer dir.close();
        var names: std.ArrayList([]const u8) = .empty;
        defer {
            for (names.items) |name| a.free(name);
            names.deinit(a);
        }
        var it = dir.iterate();
        while (try it.next()) |entry| {
            if (!std.mem.endsWith(u8, entry.name, ".app")) continue;
            try names.append(a, try a.dupe(u8, entry.name));
        }
        std.mem.sort([]const u8, names.items, {}, struct {
            fn less(_: void, x: []const u8, y: []const u8) bool {
                return std.mem.lessThan(u8, x, y);
            }
        }.less);
        for (names.items) |name| if (try f.bundle(root, name)) |found| return found;
        return null;
    }
    fn bundle(f: *Finder, root: []const u8, name: []const u8) !?[]const u8 {
        const path = try std.fs.path.join(a, &.{ root, name, "Contents/Resources", f.command });
        defer a.free(path);
        return f.candidate(path);
    }
};

fn probe(path: []const u8, prefix: []const u8, timeout_ns: u64) bool {
    var child = std.process.Child.init(&.{ path, "--version" }, a);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    child.spawn() catch return false;
    var reaped = false;
    defer {
        // Kill the process group as well: a hanging wrapper may have children.
        _ = c.kill(-child.id, c.SIGKILL);
        if (!reaped) {
            var status: c_int = 0;
            _ = c.waitpid(child.id, &status, 0);
        }
        if (child.stdout) |file| file.close();
    }
    child.waitForSpawn() catch return false;
    const fd = child.stdout.?.handle;
    os.nonblock(fd);
    var output: [4096]u8 = undefined;
    var len: usize = 0;
    var timer = std.time.Timer.start() catch return false;
    while (timer.read() < timeout_ns) {
        // Bounded output and bounded work even for a noisy or broken wrapper.
        for (0..8) |_| {
            if (len == output.len) return false;
            const n = c.read(fd, output[len..].ptr, output.len - len);
            if (n <= 0) break;
            len += @intCast(n);
        }
        var status: c_int = 0;
        if (c.waitpid(child.id, &status, c.WNOHANG) == child.id) {
            reaped = true;
            // The child may have written between the last read and waitpid.
            if (len < output.len) {
                const n = c.read(fd, output[len..].ptr, output.len - len);
                if (n > 0) len += @intCast(n);
            }
            return status == 0 and isVersion(output[0..len], prefix);
        }
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return false;
}
fn isVersion(output: []const u8, prefix: []const u8) bool {
    const line = std.mem.trim(u8, output, " \t\r\n");
    return std.mem.startsWith(u8, line, prefix) and line.len > prefix.len and std.ascii.isDigit(line[prefix.len]);
}
test "Codex version validation rejects successful non-Codex programs" {
    const prefix = providers.Codex.info.version_prefix.?;
    try std.testing.expect(isVersion("codex-cli 0.155.0-alpha.2.6\n", prefix));
    try std.testing.expect(!isVersion("", prefix));
    try std.testing.expect(!isVersion("codex-cli ", prefix));
    try std.testing.expect(!isVersion("unrelated tool 1.0.0\n", prefix));
    try std.testing.expect(!isVersion("codex-cli missing native binary", prefix));
}

/// Cheap, spawn-free presence check for the launcher. It never probes a
/// candidate, so a broken Codex wrapper can still count as installed.
pub fn installed(provider: Provider) bool {
    const info = provider.info();
    const name = info.executables[0];
    const override = info.binary_env;
    const self = std.fs.selfExePathAlloc(a) catch return true;
    defer a.free(self);
    const self_real = std.fs.cwd().realpathAlloc(a, self) catch return true;
    defer a.free(self_real);
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    if (os.env(override)) |path| if (path.len > 0) {
        if (std.mem.indexOfScalar(u8, path, '/') != null) return executable(path, self_real);
        return onPath(path, self_real);
    };
    if (onPath(name, self_real)) return true;
    const home = os.env("HOME") orelse "";
    if (home.len > 0) {
        for (info.home_paths) |relative| {
            const path = std.fmt.bufPrint(&buf, "{s}/{s}", .{ home, relative }) catch continue;
            if (executable(path, self_real)) return true;
        }
        for (info.app_bundles) |bundle| {
            const path = std.fmt.bufPrint(&buf, "{s}/Applications/{s}/Contents/Resources/{s}", .{ home, bundle, name }) catch continue;
            if (executable(path, self_real)) return true;
        }
    }
    const root = systemRoot();
    for (info.system_paths) |system| {
        const path = std.fmt.bufPrint(&buf, "{s}{s}", .{ root, system }) catch continue;
        if (executable(path, self_real)) return true;
    }
    for (info.app_bundles) |bundle| {
        const path = std.fmt.bufPrint(&buf, "{s}/Applications/{s}/Contents/Resources/{s}", .{ root, bundle, name }) catch continue;
        if (executable(path, self_real)) return true;
    }
    return false;
}
fn onPath(name: []const u8, self_real: []const u8) bool {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    var search: os.PathSearch = .init(os.env("PATH") orelse return false, name);
    while (search.next(&buf)) |path| if (executable(path, self_real)) return true;
    return false;
}
fn executable(path: []const u8, self_real: []const u8) bool {
    var buf: [std.fs.max_path_bytes]u8 = undefined;
    // Pane-local shims resolve to Corgi itself and do not mean a provider exists.
    const real = std.fs.cwd().realpath(path, &buf) catch return false;
    if (std.mem.eql(u8, real, self_real)) return false;
    const stat = std.posix.fstatat(std.posix.AT.FDCWD, real, 0) catch return false;
    if ((stat.mode & c.S_IFMT) != c.S_IFREG) return false;
    var z: [std.fs.max_path_bytes + 1]u8 = undefined;
    @memcpy(z[0..real.len], real);
    z[real.len] = 0;
    return c.access(@ptrCast(&z), c.X_OK) == 0;
}
