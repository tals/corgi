const std = @import("std");
const resource_os = @import("resource_os").resource_os;
const a = std.heap.c_allocator;
const c = @cImport({
    @cInclude("unistd.h");
    @cInclude("sys/wait.h");
    @cInclude("sys/file.h");
});
pub export fn app_sysconf(pages: bool) i64 {
    return c.sysconf(if (pages) c._SC_PAGESIZE else c._SC_CLK_TCK);
}
pub export fn app_waitpid(pid: i32) i32 {
    var status: c_int = 0;
    return c.waitpid(pid, &status, c.WNOHANG);
}
pub export fn app_flock(fd: i32, lock: bool) i32 {
    return c.flock(fd, if (lock) c.LOCK_EX | c.LOCK_NB else c.LOCK_UN);
}
pub export fn app_system_json(op: u32, pid: i32, out: [*]u8, cap: usize) i64 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const bytes = switch (op) {
        0 => blk: {
            const inventory = resource_os.inventory(alloc) catch return -1;
            const Identity = struct { pid: i32, parent: i32, start: u64, name: []const u8 };
            const items = alloc.alloc(Identity, inventory.items.len) catch return -1;
            for (inventory.items, items) |item, *result| result.* = .{ .pid = item.pid, .parent = item.parent, .start = item.start, .name = std.mem.sliceTo(&item.name, 0) };
            break :blk std.json.Stringify.valueAlloc(alloc, .{ .items = items, .truncated = inventory.truncated }, .{}) catch return -1;
        },
        1 => std.json.Stringify.valueAlloc(alloc, resource_os.counters(pid), .{}) catch return -1,
        2 => std.json.Stringify.valueAlloc(alloc, resource_os.host(), .{}) catch return -1,
        else => return -1,
    };
    if (bytes.len > cap) return -@as(i64, @intCast(bytes.len));
    @memcpy(out[0..bytes.len], bytes);
    return @intCast(bytes.len);
}
