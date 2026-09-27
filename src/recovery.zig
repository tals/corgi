//! Atomic, private recovery snapshot. No live descriptors, process resurrection,
//! input replay, or automatic agent command execution on cold startup.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const checkpoint = @import("checkpoint.zig");
const migrations = @import("state_migrations.zig");
const Runtime = @import("runtime.zig").Runtime;
pub fn path(socket: []const u8) ![]const u8 {
    const root = if (os.env("XDG_STATE_HOME")) |p| try a.dupe(u8, p) else try std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".local", "state" });
    defer a.free(root);
    const default_socket = try std.fmt.allocPrint(a, "/tmp/corgi-{d}/control.sock", .{os.c.getuid()});
    defer a.free(default_socket);
    const name = if (std.mem.eql(u8, socket, default_socket)) try a.dupe(u8, "recovery.json") else try std.fmt.allocPrint(a, "runtime-{x}.json", .{std.hash.Wyhash.hash(0, socket)});
    defer a.free(name);
    return std.fs.path.join(a, &.{ root, "corgi", "recovery", name });
}
pub fn save(r: *Runtime, socket: []const u8) !void {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const state = try checkpoint.capture(arena.allocator(), r, false);
    const bytes = try std.json.Stringify.valueAlloc(arena.allocator(), state, .{});
    const dest = try path(socket);
    defer a.free(dest);
    try atomicWrite(dest, bytes);
}
pub fn atomicWrite(dest: []const u8, bytes: []const u8) !void {
    const parent = std.fs.path.dirname(dest) orelse return error.InvalidRecoveryPath;
    try os.privateDirectory(parent);
    const temp = try std.fmt.allocPrint(a, "{s}.{d}.{x}.tmp", .{ dest, os.c.getpid(), std.crypto.random.int(u64) });
    defer a.free(temp);
    const file = try std.fs.cwd().createFile(temp, .{ .mode = 0o600, .exclusive = true });
    defer file.close();
    defer std.fs.cwd().deleteFile(temp) catch {};
    try file.writeAll(bytes);
    try file.sync();
    try std.fs.cwd().rename(temp, dest);
    // Linux O_PATH descriptors cannot be synced; request a readable directory.
    var dir = try std.fs.cwd().openDir(parent, .{ .iterate = true });
    defer dir.close();
    try std.posix.fsync(dir.fd);
}
pub fn load(r: *Runtime, socket: []const u8, executable: []const u8) !bool {
    const source = try path(socket);
    defer a.free(source);
    const bytes = std.fs.cwd().readFileAlloc(a, source, 256 * 1024 * 1024) catch |err| switch (err) {
        error.FileNotFound => return false,
        else => return err,
    };
    defer a.free(bytes);
    const parsed = migrations.decode(checkpoint.State, .checkpoint, a, bytes) catch |err| {
        std.log.err("recovery snapshot {s} could not be decoded or migrated ({s}); original file left unchanged", .{ source, @errorName(err) });
        return err;
    };
    defer parsed.deinit();
    checkpoint.restore(r, parsed.parsed.value, false, socket, executable) catch |err| {
        std.log.err("recovery snapshot {s} could not be restored ({s}); move it aside to start fresh", .{ source, @errorName(err) });
        return err;
    };
    if (parsed.migrated) {
        // Restore/validation must succeed before touching the user's source.
        // Periodic saves overwrite it soon after, so keep the pre-migration
        // bytes first: a migration that loses data quietly stays recoverable.
        const backup = try std.fmt.allocPrint(a, "{s}.v{d}", .{ source, parsed.from });
        defer a.free(backup);
        atomicWrite(backup, bytes) catch |err| {
            std.log.err("recovery snapshot {s} could not be backed up before migration ({s}); original file left unchanged", .{ source, @errorName(err) });
            return err;
        };
        // Serialize the migrated saved state, not newly spawned recovery shells.
        // Best effort: the next periodic save writes the current format anyway.
        upgrade(source, parsed.parsed.value) catch |err| std.log.err("recovery snapshot {s} could not be rewritten after migration ({s})", .{ source, @errorName(err) });
    }
    return true;
}
fn upgrade(dest: []const u8, state: checkpoint.State) !void {
    const bytes = try std.json.Stringify.valueAlloc(a, state, .{});
    defer a.free(bytes);
    try atomicWrite(dest, bytes);
}
