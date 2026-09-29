//! Native, read-only process counters. No subprocesses or command-line scraping.
const std = @import("std");
const builtin = @import("builtin");
const c = @cImport({
    @cInclude("unistd.h");
    if (builtin.os.tag == .macos) {
        @cInclude("libproc.h");
        @cInclude("sys/resource.h");
        @cInclude("sys/sysctl.h");
        @cInclude("mach/mach.h");
        @cInclude("mach/mach_time.h");
    }
});

pub const Identity = struct { pid: i32, parent: i32, start: u64, name: [64]u8 = @splat(0) };
pub const Counters = struct { start: u64, cpu_ns: u64, memory: u64, read: ?u64, written: ?u64 };
pub const MemoryPressure = enum { unknown, normal, warning, critical };
pub const Host = struct {
    busy: u64 = 0,
    total: u64 = 0,
    cores: u32 = 1,
    memory: u64 = 0,
    pressure: MemoryPressure = .unknown,
};
pub const Inventory = struct { items: []const Identity, truncated: bool = false };
const max_processes = 16384;

pub fn inventory(alloc: std.mem.Allocator) !Inventory {
    var list: std.ArrayList(Identity) = .empty;
    var truncated = false;
    if (builtin.os.tag == .macos) {
        const count = c.proc_listallpids(null, 0);
        if (count <= 0) return error.ProcessInventoryUnavailable;
        const pids = try alloc.alloc(c_int, @min(max_processes, @as(usize, @intCast(count)) + 128));
        const n = c.proc_listallpids(pids.ptr, @intCast(pids.len * @sizeOf(c_int)));
        if (n <= 0) return error.ProcessInventoryUnavailable;
        truncated = n >= pids.len;
        for (pids[0..@min(pids.len, @as(usize, @intCast(n)))]) |pid| {
            var info: c.struct_proc_bsdinfo = undefined;
            if (c.proc_pidinfo(pid, c.PROC_PIDTBSDINFO, 0, &info, @sizeOf(@TypeOf(info))) != @sizeOf(@TypeOf(info))) continue;
            var item: Identity = .{ .pid = pid, .parent = @intCast(info.pbi_ppid), .start = info.pbi_start_tvsec * std.time.us_per_s + info.pbi_start_tvusec };
            const raw = if (info.pbi_name[0] != 0) std.mem.sliceTo(&info.pbi_name, 0) else std.mem.sliceTo(&info.pbi_comm, 0);
            const name = @as([]const u8, @ptrCast(raw));
            @memcpy(item.name[0..@min(name.len, item.name.len - 1)], name[0..@min(name.len, item.name.len - 1)]);
            try list.append(alloc, item);
        }
    } else if (builtin.os.tag == .linux) {
        var dir = try std.fs.openDirAbsolute("/proc", .{ .iterate = true });
        defer dir.close();
        var it = dir.iterate();
        while (try it.next()) |entry| {
            const pid = std.fmt.parseInt(i32, entry.name, 10) catch continue;
            if (list.items.len == max_processes) {
                truncated = true;
                break;
            }
            var buf: [4096]u8 = undefined;
            const stat = linuxStat(pid, &buf) orelse continue;
            try list.append(alloc, stat.identity);
        }
    } else return error.UnsupportedPlatform;
    return .{ .items = try list.toOwnedSlice(alloc), .truncated = truncated };
}

pub fn counters(pid: i32) ?Counters {
    if (builtin.os.tag == .macos) {
        var info: c.struct_rusage_info_v2 = undefined;
        if (c.proc_pid_rusage(pid, c.RUSAGE_INFO_V2, @ptrCast(&info)) != 0) return null;
        // rusage CPU times are Mach ticks, not nanoseconds on Apple Silicon.
        var timebase: c.mach_timebase_info_data_t = undefined;
        if (c.mach_timebase_info(&timebase) != c.KERN_SUCCESS or timebase.denom == 0) return null;
        const cpu_ns = @as(u128, info.ri_user_time +| info.ri_system_time) * timebase.numer / timebase.denom;
        return .{
            .start = info.ri_proc_start_abstime,
            .cpu_ns = @intCast(@min(std.math.maxInt(u64), cpu_ns)),
            .memory = info.ri_phys_footprint,
            .read = info.ri_diskio_bytesread,
            .written = info.ri_diskio_byteswritten,
        };
    } else if (builtin.os.tag == .linux) {
        var buf: [4096]u8 = undefined;
        const stat = linuxStat(pid, &buf) orelse return null;
        const ticks = c.sysconf(c._SC_CLK_TCK);
        const pages = c.sysconf(c._SC_PAGESIZE);
        if (ticks <= 0 or pages <= 0) return null;
        var path: [64]u8 = undefined;
        const io = read(std.fmt.bufPrint(&path, "/proc/{d}/io", .{pid}) catch return null, &buf);
        return .{
            .start = stat.identity.start,
            .cpu_ns = stat.ticks *| (std.time.ns_per_s / @as(u64, @intCast(ticks))),
            .memory = stat.pages *| @as(u64, @intCast(pages)),
            .read = if (io) |text| field(text, "read_bytes:") else null,
            .written = if (io) |text| field(text, "write_bytes:") else null,
        };
    } else return null;
}

const Stat = struct { identity: Identity, ticks: u64, pages: u64 };
fn linuxStat(pid: i32, buf: []u8) ?Stat {
    var path: [64]u8 = undefined;
    return parseStat(pid, read(std.fmt.bufPrint(&path, "/proc/{d}/stat", .{pid}) catch return null, buf) orelse return null);
}
fn parseStat(pid: i32, text: []const u8) ?Stat {
    const begin = std.mem.indexOfScalar(u8, text, '(') orelse return null;
    const end = std.mem.lastIndexOfScalar(u8, text, ')') orelse return null;
    if (end <= begin) return null;
    var result: Stat = .{ .identity = .{ .pid = pid, .parent = 0, .start = 0 }, .ticks = 0, .pages = 0 };
    const name = text[begin + 1 .. end];
    @memcpy(result.identity.name[0..@min(name.len, 63)], name[0..@min(name.len, 63)]);
    var fields = std.mem.tokenizeAny(u8, text[end + 1 ..], " \n");
    var index: usize = 3;
    while (fields.next()) |value| : (index += 1) {
        switch (index) {
            4 => result.identity.parent = std.fmt.parseInt(i32, value, 10) catch return null,
            14, 15 => result.ticks +|= std.fmt.parseInt(u64, value, 10) catch return null,
            22 => result.identity.start = std.fmt.parseInt(u64, value, 10) catch return null,
            24 => {
                result.pages = std.fmt.parseInt(u64, value, 10) catch 0;
                return result;
            },
            else => {},
        }
    }
    return null;
}
fn read(path: []const u8, buf: []u8) ?[]const u8 {
    const file = std.fs.openFileAbsolute(path, .{}) catch return null;
    defer file.close();
    const n = file.readAll(buf) catch return null;
    return buf[0..n];
}
fn field(text: []const u8, key: []const u8) ?u64 {
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| if (std.mem.startsWith(u8, line, key)) {
        var words = std.mem.tokenizeAny(u8, line[key.len..], " \t");
        return std.fmt.parseInt(u64, words.next() orelse return null, 10) catch null;
    };
    return null;
}
pub fn host() Host {
    var result: Host = .{};
    const cores = c.sysconf(c._SC_NPROCESSORS_ONLN);
    if (cores > 0) result.cores = @intCast(cores);
    if (builtin.os.tag == .macos) {
        var load: c.host_cpu_load_info_data_t = undefined;
        var count: c.mach_msg_type_number_t = c.HOST_CPU_LOAD_INFO_COUNT;
        const port = c.mach_host_self();
        defer _ = c.mach_port_deallocate(c.mach_task_self(), port);
        if (c.host_statistics(port, c.HOST_CPU_LOAD_INFO, @ptrCast(&load), &count) == c.KERN_SUCCESS) {
            for (load.cpu_ticks) |tick| result.total += tick;
            result.busy = result.total - load.cpu_ticks[c.CPU_STATE_IDLE];
        }
        var size: usize = @sizeOf(u64);
        _ = c.sysctlbyname("hw.memsize", &result.memory, &size, null, 0);
        var pressure: c_int = 0;
        size = @sizeOf(c_int);
        if (c.sysctlbyname("kern.memorystatus_vm_pressure_level", &pressure, &size, null, 0) == 0) result.pressure = switch (pressure) {
            1 => .normal,
            2 => .warning,
            4 => .critical,
            else => .unknown,
        };
    } else if (builtin.os.tag == .linux) {
        var buf: [8192]u8 = undefined;
        if (read("/proc/stat", &buf)) |text| {
            var values = std.mem.tokenizeAny(u8, text[0 .. std.mem.indexOfScalar(u8, text, '\n') orelse text.len], " ");
            _ = values.next();
            var index: usize = 0;
            while (values.next()) |value| : (index += 1) {
                if (index >= 8) break; // guest time is already included in user/nice.
                const n = std.fmt.parseInt(u64, value, 10) catch break;
                result.total += n;
                if (index != 3 and index != 4) result.busy += n;
            }
        }
        if (read("/proc/meminfo", &buf)) |text| result.memory = (field(text, "MemTotal:") orelse 0) * 1024;
        if (read("/proc/pressure/memory", &buf)) |text| {
            if (std.mem.indexOf(u8, text, "some avg10=")) |start| {
                const tail = text[start + "some avg10=".len ..];
                const pct = std.fmt.parseFloat(f64, tail[0 .. std.mem.indexOfScalar(u8, tail, ' ') orelse tail.len]) catch return result;
                result.pressure = if (pct >= 10) .critical else if (pct >= 1) .warning else .normal;
            }
        }
    }
    return result;
}

test "linux stat handles spaces and closing parentheses in process names" {
    const stat = parseStat(42, "42 (odd ) name) S 12 0 0 0 0 0 0 0 0 0 10 20 0 0 0 0 0 0 1234 999 50") orelse return error.BadStat;
    try std.testing.expectEqual(@as(i32, 12), stat.identity.parent);
    try std.testing.expectEqual(@as(u64, 30), stat.ticks);
    try std.testing.expectEqual(@as(u64, 1234), stat.identity.start);
    try std.testing.expectEqual(@as(u64, 50), stat.pages);
}
test "native counters can sample this process" {
    const value = counters(c.getpid()) orelse return error.CountersUnavailable;
    try std.testing.expect(value.start > 0);
    try std.testing.expect(value.memory > 0);
}
