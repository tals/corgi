//! Viewer-local system opener. Never run on the daemon or an SSH host.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
pub const Openers = struct {
    pids: [8]c_int = @splat(0),
    pub fn reap(o: *Openers) void {
        for (&o.pids) |*pid| if (pid.* > 0) {
            var status: c_int = 0;
            const result = c.waitpid(pid.*, &status, c.WNOHANG);
            if (result == pid.* or (result < 0 and std.posix.errno(result) == .CHILD)) pid.* = 0;
        };
    }
    pub fn open(o: *Openers, url: []const u8) !void {
        if (!std.mem.startsWith(u8, url, "http://") and !std.mem.startsWith(u8, url, "https://")) return error.InvalidURL;
        for (url) |byte| if (byte < 0x20 or byte == 0x7f) return error.InvalidURL;
        o.reap();
        const slot = for (&o.pids) |*pid| {
            if (pid.* == 0) break pid;
        } else return error.TooManyOpenRequests;
        const executable = if (@import("builtin").os.tag == .macos) "open" else "xdg-open";
        var child = std.process.Child.init(&.{ executable, url }, os.allocator);
        child.stdin_behavior = .Ignore;
        child.stdout_behavior = .Ignore;
        child.stderr_behavior = .Ignore;
        child.pgid = 0;
        try child.spawn();
        child.waitForSpawn() catch |err| {
            _ = child.wait() catch {};
            return err;
        };
        slot.* = child.id;
    }
};
