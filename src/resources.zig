//! Shared resource sampling. Immutable snapshots cross the worker boundary;
//! UI views never inspect processes, spawn tools or own a polling loop.
const std = @import("std");
const log = std.log.scoped(.resources);
const builtin = @import("builtin");
const os = @import("os.zig");
const native = @import("resource_os.zig");
const clock = @import("clock.zig");
const a = os.allocator;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const Provider = @import("agents.zig").Provider;
pub const history_capacity = 48;
pub const process_capacity = 64;
pub const Sort = enum { cpu, memory, io };
pub fn cpuText(buf: []u8, value: ?f64) []const u8 {
    const n = value orelse return "";
    return if (n >= 10000) std.fmt.bufPrint(buf, "{d:.0}k%", .{n / 1000}) catch "" else std.fmt.bufPrint(buf, "{d:.0}%", .{n}) catch "";
}
pub fn memoryText(buf: []u8, value: ?u64) []const u8 {
    const n = value orelse return "";
    if (n >= 1024 * 1024 * 1024) return std.fmt.bufPrint(buf, "{d:.1}G", .{@as(f64, @floatFromInt(n)) / (1024 * 1024 * 1024)}) catch "";
    return std.fmt.bufPrint(buf, "{d}M", .{n / (1024 * 1024)}) catch "";
}
pub fn ioText(buf: []u8, value: ?u64) []const u8 {
    const n = value orelse return "";
    if (n >= 1000000000) return std.fmt.bufPrint(buf, "{d:.0}G/s", .{@as(f64, @floatFromInt(n)) / 1000000000}) catch "";
    if (n >= 1000000) return std.fmt.bufPrint(buf, "{d:.0}M/s", .{@as(f64, @floatFromInt(n)) / 1000000}) catch "";
    return std.fmt.bufPrint(buf, "{d}K/s", .{n / 1000}) catch "";
}
pub const Point = struct { at: i64 = 0, cpu: ?f64 = null, memory: ?u64 = null, io: ?u64 = null };
pub const Process = struct {
    pid: i32,
    start: u64,
    name: []const u8,
    provider: ?Provider = null,
    cpu: ?f64 = null,
    memory: u64 = 0,
    read: ?u64 = null,
    written: ?u64 = null,
    pub fn less(sort: Sort, left: Process, right: Process) bool {
        const l: f64 = switch (sort) {
            .cpu => left.cpu orelse -1,
            .memory => @floatFromInt(left.memory),
            .io => if (left.read != null and left.written != null) @floatFromInt(left.read.? +| left.written.?) else -1,
        };
        const r: f64 = switch (sort) {
            .cpu => right.cpu orelse -1,
            .memory => @floatFromInt(right.memory),
            .io => if (right.read != null and right.written != null) @floatFromInt(right.read.? +| right.written.?) else -1,
        };
        return if (l == r) left.pid < right.pid else l > r;
    }
};
pub const Work = struct {
    id: WorkspaceId,
    known: bool = false,
    partial: bool = false,
    count: usize = 0,
    cpu: ?f64 = null,
    memory: ?u64 = null,
    read: ?u64 = null,
    written: ?u64 = null,
    cpu_pressure: bool = false,
    processes: []const Process = &.{},
    history: []const Point = &.{},

    fn add(work: *Work, proc: Process) void {
        work.memory = (work.memory orelse 0) +| proc.memory;
        if (proc.cpu) |value| work.cpu = (work.cpu orelse 0) + value;
        if (proc.read) |value| work.read = (work.read orelse 0) +| value;
        if (proc.written) |value| work.written = (work.written orelse 0) +| value;
    }
};
pub const Snapshot = struct {
    sampled_at: i64 = 0,
    interval_ms: u32 = 2000,
    host_cpu: ?f64 = null,
    host_memory: u64 = 0,
    cores: u32 = 1,
    memory_pressure: native.MemoryPressure = .unknown,
    /// Linux sums RSS; macOS sums physical footprints. Both are estimates.
    memory_kind: []const u8 = if (builtin.os.tag == .linux) "RSS" else "footprint",
    workspaces: []const Work = &.{},
    pub fn workspace(s: Snapshot, id: WorkspaceId) Work {
        for (s.workspaces) |work| if (work.id == id) return work;
        return .{ .id = id };
    }
    /// Normal viewer syncs carry totals only. Details travel only for the open
    /// card; CLI session snapshots can still inspect the complete inventory.
    pub fn forViewer(s: Snapshot, allocator: std.mem.Allocator, detail: ?WorkspaceId) !Snapshot {
        var result = s;
        const works = try allocator.dupe(Work, s.workspaces);
        for (works) |*work| if (detail != work.id) {
            work.processes = &.{};
            work.history = &.{};
        };
        result.workspaces = works;
        return result;
    }
};
const Root = struct { key: u64 = 0, pid: i32, start: ?u64 = null, workspace: WorkspaceId, agent_pid: i32 = 0, provider: ?Provider = null };
const Origin = struct { pid: i32, start: u64 };
const Reading = struct { pid: i32, workspace: WorkspaceId, identity_start: u64, at: i64, value: native.Counters };
const Alarm = struct {
    active: bool = false,
    since: ?i64 = null,
    clear_since: ?i64 = null,
    fn update(alarm: *Alarm, high: bool, low: bool, now: i64) bool {
        if (!alarm.active) {
            alarm.clear_since = null;
            if (!high) {
                alarm.since = null;
                return false;
            }
            if (alarm.since == null) alarm.since = now;
            if (now - alarm.since.? >= 10000) alarm.active = true;
        } else {
            alarm.since = null;
            if (!low) alarm.clear_since = null else {
                if (alarm.clear_since == null) alarm.clear_since = now;
                if (now - alarm.clear_since.? >= 30000) {
                    alarm.active = false;
                    alarm.clear_since = null;
                }
            }
        }
        return alarm.active;
    }
};
const Health = struct { id: WorkspaceId, cpu: Alarm = .{} };
const Batch = struct { view: Snapshot = .{}, readings: []const Reading = &.{}, host: native.Host = .{}, health: []const Health = &.{} };

pub const Tracker = struct {
    current: Snapshot = .{},
    batch: Batch = .{},
    pending: Batch = .{},
    arena: std.heap.ArenaAllocator = .init(a),
    pending_arena: std.heap.ArenaAllocator = .init(a),
    roots: []const Root = &.{},
    // Worker-owned identities survive failed reads and reject reused imported PIDs.
    origins: std.AutoHashMapUnmanaged(u64, Origin) = .empty,
    workspaces: []const WorkspaceId = &.{},
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
    next_refresh: i64 = 0,
    last_started: i64 = 0,
    // Samples repeat every few seconds; warn once per distinct failure.
    sample_error: ?anyerror = null,
    interval_ms: u32 = 2000,

    pub fn deinit(t: *Tracker) void {
        t.stopping.store(true, .release);
        if (t.thread) |thread| thread.join();
        t.arena.deinit();
        t.pending_arena.deinit();
        t.origins.deinit(a);
    }
    pub fn tick(t: *Tracker, runtime: anytype, detailed: bool) bool {
        var changed = false;
        if (t.thread) |thread| {
            if (!t.done.load(.acquire)) return false;
            thread.join();
            t.thread = null;
            // Reject an in-flight sample after a pane/session is moved or closed.
            const valid = for (t.roots) |root| {
                var found = false;
                for (runtime.panes.items) |p| if (!p.terminal.exited and p.terminal.pid == root.pid and @as(u64, @intFromEnum(p.id)) * 2 == root.key) {
                    if (runtime.workspaces.owner(p.id)) |ws| found = ws.id == root.workspace;
                };
                for (runtime.sessions.items) |s| if (!s.exited and s.child.id == root.pid and s.workspace_id == root.workspace and @as(u64, @intFromEnum(s.id)) * 2 + 1 == root.key) {
                    found = true;
                };
                if (!found) break false;
            } else true;
            if (valid) {
                t.arena.deinit();
                t.arena = t.pending_arena;
                t.pending_arena = .init(a);
                t.batch = t.pending;
                t.current = t.batch.view;
                changed = true;
            }
        }
        const now = clock.milliTimestamp();
        const interval: u32 = if (detailed) 1000 else 2000;
        if (now < @min(t.next_refresh, t.last_started + interval)) return changed;
        t.interval_ms = interval;
        t.last_started = now;
        t.next_refresh = now + interval;
        _ = t.pending_arena.reset(.free_all);
        const allocator = t.pending_arena.allocator();
        var roots: std.ArrayList(Root) = .empty;
        var works: std.ArrayList(WorkspaceId) = .empty;
        for (runtime.workspaces.items.items) |ws| works.append(allocator, ws.id) catch return changed;
        for (runtime.panes.items) |*p| {
            if (p.terminal.exited) continue;
            const ws = runtime.workspaces.owner(p.id) orelse continue;
            roots.append(allocator, .{
                .key = @as(u64, @intFromEnum(p.id)) * 2,
                .pid = p.terminal.pid,
                .workspace = ws.id,
                .agent_pid = p.detection.pid,
                .provider = p.agent().provider,
            }) catch return changed;
        }
        for (runtime.sessions.items) |*s| {
            if (s.exited or s.workspace_id == WorkspaceId.none) continue;
            roots.append(allocator, .{
                .key = @as(u64, @intFromEnum(s.id)) * 2 + 1,
                .pid = s.child.id,
                .workspace = s.workspace_id,
                .agent_pid = s.child.id,
                .provider = s.provider,
            }) catch return changed;
        }
        t.roots = roots.toOwnedSlice(allocator) catch return changed;
        t.workspaces = works.toOwnedSlice(allocator) catch return changed;
        t.pending = .{};
        t.done.store(false, .release);
        t.thread = std.Thread.spawn(.{}, run, .{t}) catch |err| blk: {
            log.warn("spawn sample thread failed: {}", .{err});
            break :blk null;
        };
        return changed;
    }
    /// Discards every reading once sampling is turned off, so snapshots carry
    /// none and a later start measures afresh. True when readings were dropped.
    pub fn stop(t: *Tracker) bool {
        if (t.thread) |thread| {
            if (!t.done.load(.acquire)) return false;
            thread.join();
            t.thread = null;
        } else if (t.current.sampled_at == 0 and t.batch.readings.len == 0) return false;
        t.arena.deinit();
        t.arena = .init(a);
        _ = t.pending_arena.reset(.free_all);
        t.current = .{};
        t.batch = .{};
        t.pending = .{};
        t.roots = &.{};
        t.workspaces = &.{};
        t.next_refresh = 0;
        t.last_started = 0;
        return true;
    }
    fn run(t: *Tracker) void {
        defer t.done.store(true, .release);
        t.sample() catch |err| {
            const repeated = if (t.sample_error) |previous| previous == err else false;
            if (err != error.Stopped and !repeated) log.warn("resource sample failed: {}", .{err});
            t.sample_error = err;
            // Never retain stale values as a healthy zero after sampling fails.
            t.pending = .{ .view = .{ .sampled_at = clock.milliTimestamp(), .interval_ms = t.interval_ms } };
            return;
        };
        t.sample_error = null;
    }
    fn sample(t: *Tracker) !void {
        const allocator = t.pending_arena.allocator();
        const now = clock.milliTimestamp();
        const inventory = try native.inventory(allocator);
        var index: std.AutoHashMapUnmanaged(i32, usize) = .empty;
        for (inventory.items, 0..) |item, i| try index.put(allocator, item.pid, i);
        const roots = try allocator.dupe(Root, t.roots);
        // Prune identities of closed roots, retaining only current pane/session IDs.
        var stale: std.ArrayList(u64) = .empty;
        var origins = t.origins.keyIterator();
        while (origins.next()) |key| {
            const active = for (roots) |root| {
                if (root.key == key.*) break true;
            } else false;
            if (!active) try stale.append(allocator, key.*);
        }
        for (stale.items) |key| _ = t.origins.remove(key);
        for (roots) |*root| {
            if (t.origins.get(root.key)) |origin| if (origin.pid == root.pid) {
                root.start = origin.start;
            };
            if (root.start == null) if (index.get(root.pid)) |i| {
                root.start = inventory.items[i].start;
                try t.origins.put(a, root.key, .{ .pid = root.pid, .start = root.start.? });
            };
        }
        var previous: std.AutoHashMapUnmanaged(i32, Reading) = .empty;
        for (t.batch.readings) |r| try previous.put(allocator, r.pid, r);
        const host = native.host();
        const host_cpu: ?f64 = if (t.batch.host.total > 0 and host.total > t.batch.host.total and host.busy >= t.batch.host.busy)
            @min(100, 100 * @as(f64, @floatFromInt(host.busy - t.batch.host.busy)) / @as(f64, @floatFromInt(host.total - t.batch.host.total)))
        else
            null;
        var readings: std.ArrayList(Reading) = .empty;
        const works = try allocator.alloc(Work, t.workspaces.len);
        const health = try allocator.alloc(Health, t.workspaces.len);
        const lists = try allocator.alloc(std.ArrayList(Process), works.len);
        for (works, health, lists, t.workspaces) |*work, *h, *list, id| {
            work.* = .{ .id = id, .known = true, .partial = inventory.truncated };
            h.* = .{ .id = id };
            for (t.batch.health) |old| if (old.id == id) {
                h.* = old;
                break;
            };
            list.* = .empty;
        }
        for (inventory.items) |identity| {
            if (t.stopping.load(.acquire)) return error.Stopped;
            const root = owner(identity.pid, inventory.items, &index, roots) orelse continue;
            const wi = std.mem.indexOfScalar(WorkspaceId, t.workspaces, root.workspace) orelse continue;
            const work = &works[wi];
            work.count += 1;
            const value = native.counters(identity.pid) orelse {
                work.partial = true;
                continue;
            };
            const reading: Reading = .{ .pid = identity.pid, .workspace = root.workspace, .identity_start = identity.start, .at = now, .value = value };
            try readings.append(allocator, reading);
            const rates = delta(previous.get(identity.pid), reading);
            var proc: Process = .{
                .pid = identity.pid,
                .start = value.start,
                .name = try allocator.dupe(u8, std.mem.sliceTo(&identity.name, 0)),
                .cpu = rates.cpu,
                .memory = value.memory,
                .read = rates.read,
                .written = rates.written,
            };
            if (identity.pid == root.agent_pid) proc.provider = root.provider;
            // A new process needs a baseline before it contributes rates.
            // Preserve measurements from the rest of the workspace meanwhile.
            work.add(proc);
            try lists[wi].append(allocator, proc);
        }
        for (works, health, lists) |*work, *h, *list| {
            // Missing roots and failed reads are explicit partial/unavailable data.
            for (roots) |root| if (root.workspace == work.id and (root.start == null or !index.contains(root.pid) or inventory.items[index.get(root.pid).?].start != root.start.?)) {
                work.partial = true;
            };
            // Failed reads leave partial totals from the processes we could
            // sample. Only a confirmed empty workspace is a measured zero.
            if (work.count == 0 and !work.partial) {
                work.cpu = 0;
                work.memory = 0;
                work.read = 0;
                work.written = 0;
            }
            const share = (work.cpu orelse 0) / @as(f64, @floatFromInt(@max(1, host.cores)));
            const cpu_high = !work.partial and host_cpu != null and host_cpu.? >= 90 and share >= 25;
            const cpu_low = work.cpu == null or host_cpu == null or host_cpu.? < 75 or share < 15;
            work.cpu_pressure = h.cpu.update(cpu_high, cpu_low, now) and work.cpu != null;
            work.processes = try leaders(allocator, list.items);
            const old = t.current.workspace(work.id).history;
            const keep = @min(old.len, history_capacity - 1);
            const history = try allocator.alloc(Point, keep + 1);
            @memcpy(history[0..keep], old[old.len - keep ..]);
            history[keep] = .{ .at = now, .cpu = work.cpu, .memory = work.memory, .io = if (work.read != null and work.written != null) work.read.? +| work.written.? else null };
            work.history = history;
        }
        t.pending = .{
            .view = .{
                .sampled_at = now,
                .interval_ms = t.interval_ms,
                .host_cpu = host_cpu,
                .host_memory = host.memory,
                .cores = host.cores,
                .memory_pressure = host.pressure,
                .workspaces = works,
            },
            .readings = try readings.toOwnedSlice(allocator),
            .host = host,
            .health = health,
        };
    }
};

/// Keep the leading processes for every sortable metric, so a memory or disk
/// hog cannot disappear merely because CPU happened to be the initial sort.
fn leaders(allocator: std.mem.Allocator, list: []Process) ![]const Process {
    if (list.len <= process_capacity) return list;
    var result: std.ArrayList(Process) = .empty;
    inline for (.{ Sort.cpu, Sort.memory, Sort.io }) |sort| {
        std.mem.sort(Process, list, sort, Process.less);
        for (list[0 .. process_capacity / 3]) |proc| {
            const exists = for (result.items) |other| {
                if (other.pid == proc.pid) break true;
            } else false;
            if (!exists) try result.append(allocator, proc);
        }
    }
    return result.toOwnedSlice(allocator);
}

fn owner(pid: i32, inventory: []const native.Identity, index: *const std.AutoHashMapUnmanaged(i32, usize), roots: []const Root) ?Root {
    var cursor = pid;
    for (0..128) |_| {
        for (roots) |root| if (cursor == root.pid) {
            const i = index.get(cursor) orelse return null;
            return if (root.start != null and root.start.? == inventory[i].start) root else null;
        };
        const i = index.get(cursor) orelse return null;
        const parent = inventory[i].parent;
        if (parent <= 1 or parent == cursor) return null;
        cursor = parent;
    }
    return null;
}
const Rates = struct { cpu: ?f64 = null, read: ?u64 = null, written: ?u64 = null };
fn rate(old: ?u64, new: ?u64, ms: u64) ?u64 {
    if (old == null or new == null or new.? < old.?) return null;
    return @intCast(@min(std.math.maxInt(u64), @as(u128, new.? - old.?) * 1000 / ms));
}
fn delta(old: ?Reading, new: Reading) Rates {
    const prev = old orelse return .{};
    if (prev.workspace != new.workspace or prev.identity_start != new.identity_start or prev.value.start != new.value.start or new.at <= prev.at or new.at - prev.at > 10000) return .{};
    const ms: u64 = @intCast(new.at - prev.at);
    const cpu: ?f64 = if (new.value.cpu_ns >= prev.value.cpu_ns)
        @as(f64, @floatFromInt(new.value.cpu_ns - prev.value.cpu_ns)) / (@as(f64, @floatFromInt(ms)) * 10000)
    else
        null;
    return .{ .cpu = cpu, .read = rate(prev.value.read, new.value.read, ms), .written = rate(prev.value.written, new.value.written, ms) };
}

test "new process baselines preserve established workspace rates" {
    const established: Process = .{ .pid = 1, .start = 1, .name = "worker", .cpu = 45, .memory = 100, .read = 200, .written = 0 };
    const newcomer: Process = .{ .pid = 2, .start = 2, .name = "child", .memory = 50 };
    for ([_]bool{ false, true }) |first| {
        var work: Work = .{ .id = WorkspaceId.first };
        work.add(if (first) newcomer else established);
        work.add(if (first) established else newcomer);
        try std.testing.expectEqual(@as(?f64, 45), work.cpu);
        try std.testing.expectEqual(@as(?u64, 150), work.memory);
        try std.testing.expectEqual(@as(?u64, 200), work.read);
        try std.testing.expectEqual(@as(?u64, 0), work.written);
    }
    var fresh: Work = .{ .id = WorkspaceId.first };
    fresh.add(newcomer);
    try std.testing.expectEqual(@as(?f64, null), fresh.cpu);
    try std.testing.expectEqual(@as(?u64, null), fresh.read);
    try std.testing.expectEqual(@as(?u64, null), fresh.written);
    try std.testing.expectEqual(@as(?u64, 50), fresh.memory);
}

test "deltas ignore PID reuse, reassignment, first samples and counter resets" {
    const r: Reading = .{ .pid = 4, .workspace = @enumFromInt(1), .identity_start = 8, .at = 1000, .value = .{ .start = 9, .cpu_ns = 100, .memory = 10, .read = 100, .written = 200 } };
    var next = r;
    next.at = 3000;
    next.value.cpu_ns += 4 * std.time.ns_per_s;
    next.value.read = 2100;
    try std.testing.expectEqual(@as(?f64, 200), delta(r, next).cpu);
    try std.testing.expectEqual(@as(?u64, 1000), delta(r, next).read);
    try std.testing.expectEqual(@as(?f64, null), delta(null, next).cpu);
    next.value.start += 1;
    try std.testing.expectEqual(@as(?f64, null), delta(r, next).cpu);
    next.value.start = r.value.start;
    next.workspace = @enumFromInt(2);
    try std.testing.expectEqual(@as(?f64, null), delta(r, next).cpu);
    next.workspace = r.workspace;
    next.value.read = 1;
    try std.testing.expectEqual(@as(?u64, null), delta(r, next).read);
}
test "pressure requires sustained evidence and clears with hysteresis" {
    var alarm: Alarm = .{};
    try std.testing.expect(!alarm.update(true, false, 0));
    try std.testing.expect(!alarm.update(false, true, 9000));
    try std.testing.expect(!alarm.update(true, false, 10000));
    try std.testing.expect(alarm.update(true, false, 20000));
    try std.testing.expect(alarm.update(false, true, 21000));
    try std.testing.expect(alarm.update(false, true, 50999));
    try std.testing.expect(!alarm.update(false, true, 51000));
}
test "ownership chooses the nearest root and bounds ancestry cycles" {
    const inventory = [_]native.Identity{ .{ .pid = 10, .parent = 1, .start = 1 }, .{ .pid = 11, .parent = 10, .start = 2 }, .{ .pid = 12, .parent = 11, .start = 3 }, .{ .pid = 20, .parent = 21, .start = 4 }, .{ .pid = 21, .parent = 20, .start = 5 } };
    var index: std.AutoHashMapUnmanaged(i32, usize) = .empty;
    defer index.deinit(std.testing.allocator);
    for (inventory, 0..) |item, i| try index.put(std.testing.allocator, item.pid, i);
    const roots = [_]Root{ .{ .pid = 10, .start = 1, .workspace = @enumFromInt(1) }, .{ .pid = 11, .start = 2, .workspace = @enumFromInt(2) } };
    try std.testing.expectEqual(@as(WorkspaceId, @enumFromInt(2)), owner(12, &inventory, &index, &roots).?.workspace);
    try std.testing.expectEqual(@as(?Root, null), owner(20, &inventory, &index, &roots));
    var reused = inventory;
    reused[1].start = 99;
    try std.testing.expectEqual(@as(?Root, null), owner(12, &reused, &index, &roots));
}

test "bounded process details retain leaders for every resource" {
    var list: [100]Process = undefined;
    for (&list, 0..) |*p, i| p.* = .{ .pid = @intCast(i + 1), .start = 1, .name = "fixture", .cpu = @floatFromInt(i), .memory = 100 - i, .read = if (i == 50) 1000000 else 0, .written = 0 };
    const selected = try leaders(std.testing.allocator, &list);
    defer std.testing.allocator.free(selected);
    try std.testing.expect(selected.len <= process_capacity);
    for ([_]i32{ 100, 1, 51 }) |pid| {
        const found = for (selected) |p| {
            if (p.pid == pid) break true;
        } else false;
        try std.testing.expect(found);
    }
}
