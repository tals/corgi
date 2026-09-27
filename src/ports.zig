//! Host process/socket discovery; immutable results are selected by each viewer.
const std = @import("std");
const log = std.log.scoped(.ports);
const os = @import("os.zig");
const layout = @import("layout.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const detection = @import("detection.zig");
const git_status = @import("git_status.zig");
const clock = @import("clock.zig");
const a = os.allocator;
const c = os.c;
const net = @cImport({
    @cInclude("ifaddrs.h");
    @cInclude("net/if.h");
    @cInclude("arpa/inet.h");
    @cInclude("netinet/in.h");
});
pub const Kind = enum { loopback, tailscale, vpn, network };
pub const Interface = struct { name: []const u8, address: []const u8, kind: Kind, ipv6: bool = false };
pub const Scheme = enum { unknown, http, https };
pub const Endpoint = struct {
    label: []const u8 = "",
    label_pending: bool = false,
    pid: i32,
    pane: layout.PaneId,
    name: []const u8,
    transport: enum { tcp, udp },
    bind_address: []const u8,
    port: u16,
    ipv6: bool = false,
    interfaces: []const Interface = &.{},
    scheme: Scheme = .unknown,
    http_status: ?u16 = null,
    probed_at: i64 = 0,
};
pub const Work = struct { id: WorkspaceId, background: usize = 0, endpoints: []const Endpoint = &.{} };
pub const Snapshot = struct {
    processes_available: bool = false,
    ports_available: bool = false,
    workspaces: []const Work = &.{},
    pub fn workspace(s: Snapshot, id: WorkspaceId) Work {
        for (s.workspaces) |w| if (w.id == id) return w;
        return .{ .id = id };
    }
};
pub fn sshViewer() bool {
    for ([_][:0]const u8{ "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY" }) |key| {
        if (os.env(key)) |value| if (value.len > 0) return true;
    }
    return false;
}
pub fn loopback(address: []const u8) bool {
    return std.mem.startsWith(u8, address, "127.") or std.mem.eql(u8, address, "::1");
}
fn wildcard(address: []const u8) bool {
    return std.mem.eql(u8, address, "*") or std.mem.eql(u8, address, "0.0.0.0") or std.mem.eql(u8, address, "::");
}
pub fn kind(name: []const u8, address: []const u8) Kind {
    if (loopback(address)) return .loopback;
    const tunnel = for ([_][]const u8{ "utun", "tun", "wg", "ppp", "tap" }) |prefix| {
        if (std.mem.startsWith(u8, name, prefix)) break true;
    } else false;
    // macOS gives Tailscale an ordinary utun name. Its address range is a hint,
    // not a guarantee that the remote browser is on the same tailnet.
    var parts = std.mem.splitScalar(u8, address, '.');
    const first = parts.next() orelse "";
    const second = std.fmt.parseInt(u8, parts.next() orelse "", 10) catch 0;
    const tailnet_range = std.mem.eql(u8, first, "100") and second >= 64 and second <= 127;
    if (std.mem.startsWith(u8, name, "tailscale") or
        (tunnel and (tailnet_range or std.mem.startsWith(u8, address, "fd7a:115c:a1e0:")))) return .tailscale;
    return if (tunnel) .vpn else .network;
}
/// Only use addresses matched to this bind. Wildcard binds never become URLs.
pub fn host(e: Endpoint, remote: bool) ?[]const u8 {
    if (!remote and (std.mem.eql(u8, e.bind_address, "127.0.0.1") or std.mem.eql(u8, e.bind_address, "::1") or wildcard(e.bind_address))) return "localhost";
    var best: ?Interface = null;
    for (e.interfaces) |iface| {
        if (remote and iface.kind == .loopback) continue;
        // A server's link-local scope is not the browser machine's scope.
        if (std.mem.startsWith(u8, iface.address, "fe80:") or std.mem.startsWith(u8, iface.address, "169.254.")) continue;
        if (best == null or @intFromEnum(iface.kind) < @intFromEnum(best.?.kind) or (iface.kind == best.?.kind and !iface.ipv6 and best.?.ipv6)) best = iface;
    }
    if (best) |iface| return iface.address;
    if (!remote and !wildcard(e.bind_address)) return e.bind_address;
    return null;
}
pub fn url(buf: []u8, e: Endpoint, remote: bool) ?[]const u8 {
    if (e.scheme == .unknown or !browserResponse(e.http_status)) return null;
    const address = host(e, remote) orelse return null;
    const ipv6 = std.mem.indexOfScalar(u8, address, ':') != null;
    return std.fmt.bufPrint(buf, "{s}://{s}{s}{s}:{d}", .{ @tagName(e.scheme), if (ipv6) "[" else "", address, if (ipv6) "]" else "", e.port }) catch null;
}

pub const Root = struct { pid: i32, pane: layout.PaneId, workspace: WorkspaceId, agent_pid: i32 = 0 };
const Process = struct { pid: i32, parent: i32, group: i32, name: []const u8 };
fn processes(allocator: std.mem.Allocator, text: []const u8) ![]const Process {
    var result: std.ArrayList(Process) = .empty;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (lines.next()) |line| {
        var words = std.mem.tokenizeAny(u8, line, " \t");
        const pid = std.fmt.parseInt(i32, words.next() orelse continue, 10) catch continue;
        const parent = std.fmt.parseInt(i32, words.next() orelse continue, 10) catch continue;
        const group = std.fmt.parseInt(i32, words.next() orelse continue, 10) catch continue;
        try result.append(allocator, .{ .pid = pid, .parent = parent, .group = group, .name = std.mem.trim(u8, words.rest(), " \t") });
    }
    return result.toOwnedSlice(allocator);
}
// Workspace workloads include foreground servers too. Job-control groups
// describe terminal input ownership, not whether useful work is running.
fn workload(p: Process, root: Root) bool {
    if (p.pid == root.agent_pid) return false;
    const name = std.mem.trimStart(u8, std.fs.path.basename(p.name), "-");
    for ([_][]const u8{ "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu" }) |shell| {
        if (std.mem.eql(u8, name, shell)) return false;
    }
    return detection.identify(&.{name}) == null;
}
fn browserResponse(status: ?u16) bool {
    const code = status orelse return false;
    return code >= 200 and code < 400;
}
fn owner(pid: i32, list: []const Process, roots: []const Root) ?Root {
    var current = pid;
    for (0..list.len + 1) |_| {
        for (roots) |root| if (root.pid == current) return root;
        const parent = for (list) |p| {
            if (p.pid == current) break p.parent;
        } else return null;
        if (parent <= 1 or parent == current) return null;
        current = parent;
    }
    return null;
}
fn interfaces(allocator: std.mem.Allocator) ![]const Interface {
    var result: std.ArrayList(Interface) = .empty;
    var first: ?*net.struct_ifaddrs = null;
    if (net.getifaddrs(&first) != 0) return error.InterfaceScanFailed;
    defer net.freeifaddrs(first);
    var cursor = first;
    while (cursor) |entry| : (cursor = entry.ifa_next) {
        const address = entry.ifa_addr orelse continue;
        if (entry.ifa_flags & net.IFF_UP == 0) continue;
        const family = address.*.sa_family;
        if (family != net.AF_INET and family != net.AF_INET6) continue;
        var buf: [net.INET6_ADDRSTRLEN]u8 = undefined;
        const bytes: *const anyopaque = if (family == net.AF_INET)
            &@as(*const net.struct_sockaddr_in, @ptrCast(@alignCast(address))).sin_addr
        else
            &@as(*const net.struct_sockaddr_in6, @ptrCast(@alignCast(address))).sin6_addr;
        const raw = net.inet_ntop(family, bytes, &buf, buf.len) orelse continue;
        const ip = std.mem.span(raw);
        const name = std.mem.span(entry.ifa_name);
        // Link-local IPv6 addresses need a zone for any local use.
        const scoped = if (family == net.AF_INET6 and std.mem.startsWith(u8, ip, "fe80:")) try std.fmt.allocPrint(allocator, "{s}%{s}", .{ ip, name }) else try allocator.dupe(u8, ip);
        try result.append(allocator, .{ .name = try allocator.dupe(u8, name), .address = scoped, .kind = kind(name, ip), .ipv6 = family == net.AF_INET6 });
    }
    return result.toOwnedSlice(allocator);
}
fn matching(allocator: std.mem.Allocator, address: []const u8, ipv6: bool, all: []const Interface) ![]const Interface {
    var result: std.ArrayList(Interface) = .empty;
    for (all) |iface| {
        if (iface.ipv6 == ipv6 and (wildcard(address) or std.mem.eql(u8, address, iface.address))) try result.append(allocator, iface);
    }
    return result.toOwnedSlice(allocator);
}
fn sockets(allocator: std.mem.Allocator, text: []const u8, list: []const Process, roots: []const Root, all: []const Interface) ![]const Endpoint {
    var result: std.ArrayList(Endpoint) = .empty;
    var pid: i32 = 0;
    var name: []const u8 = "";
    var ipv6 = false;
    var transport: enum { none, tcp, udp } = .none;
    var address: []const u8 = "";
    var listening = false;
    var lines = std.mem.splitScalar(u8, text, '\n');
    while (true) {
        const line = lines.next();
        if (line == null or (line.?.len > 0 and (line.?[0] == 'p' or line.?[0] == 'f'))) {
            if (address.len > 0 and (transport == .udp or (transport == .tcp and listening))) blk: {
                const root = owner(pid, list, roots) orelse break :blk;
                const process = for (list) |p| {
                    if (p.pid == pid) break p;
                } else break :blk;
                if (!workload(process, root)) break :blk;
                const local = address[0 .. std.mem.indexOf(u8, address, "->") orelse address.len];
                const colon = std.mem.lastIndexOfScalar(u8, local, ':') orelse break :blk;
                const port = std.fmt.parseInt(u16, local[colon + 1 ..], 10) catch break :blk;
                if (port == 0) break :blk;
                const bind = std.mem.trim(u8, local[0..colon], "[]");
                for (result.items) |e| if (e.pid == pid and e.port == port and e.ipv6 == ipv6 and
                    std.mem.eql(u8, e.bind_address, bind) and
                    std.mem.eql(u8, @tagName(e.transport), @tagName(transport))) break :blk;
                try result.append(allocator, .{
                    .pid = pid,
                    .pane = root.pane,
                    .name = try allocator.dupe(u8, name),
                    .transport = if (transport == .tcp) .tcp else .udp,
                    .bind_address = try allocator.dupe(u8, bind),
                    .port = port,
                    .ipv6 = ipv6,
                    .interfaces = try matching(allocator, bind, ipv6, all),
                });
            }
            address = "";
            listening = false;
            transport = .none;
            ipv6 = false;
        }
        const field = line orelse break;
        if (field.len == 0) continue;
        switch (field[0]) {
            'p' => pid = std.fmt.parseInt(i32, field[1..], 10) catch 0,
            'c' => name = field[1..],
            't' => ipv6 = std.mem.eql(u8, field[1..], "IPv6"),
            'P' => transport = if (std.mem.eql(u8, field[1..], "TCP")) .tcp else if (std.mem.eql(u8, field[1..], "UDP")) .udp else .none,
            'n' => address = field[1..],
            'T' => if (std.mem.eql(u8, field[1..], "ST=LISTEN")) {
                listening = true;
            },
            else => {},
        }
    }
    return result.toOwnedSlice(allocator);
}

// Share the daemon reaper's lock, but keep this worker's child slot separate.
const mutex = &git_status.child_mutex;
var child_pid: c_int = 0;
var child_status: ?c_int = null;
pub fn recordExit(pid: c_int, status: c_int) void {
    if (pid == child_pid) {
        child_status = status;
    }
}
fn command(argv: []const []const u8, stopping: *const std.atomic.Value(bool), allow_empty: bool) ?[]const u8 {
    var child = std.process.Child.init(argv, a);
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    mutex.lock();
    child.spawn() catch {
        mutex.unlock();
        return null;
    };
    child_pid = child.id;
    child_status = null;
    mutex.unlock();
    var reaped = false;
    defer {
        mutex.lock();
        defer mutex.unlock();
        if (!reaped and child_status == null) {
            _ = c.kill(-child.id, c.SIGKILL);
            var status: c_int = 0;
            _ = c.waitpid(child.id, &status, 0);
        }
        child_pid = 0;
        child_status = null;
        if (child.stdout) |file| file.close();
    }
    child.waitForSpawn() catch return null;
    const fd = child.stdout.?.handle;
    os.nonblock(fd);
    var output: std.ArrayList(u8) = .empty;
    defer output.deinit(a);
    var timer = std.time.Timer.start() catch return null;
    while (timer.read() < 2 * std.time.ns_per_s and !stopping.load(.acquire)) {
        var buf: [16384]u8 = undefined;
        const n = c.read(fd, &buf, buf.len);
        if (n > 0) output.appendSlice(a, buf[0..@intCast(n)]) catch return null;
        if (output.items.len > 4 * 1024 * 1024) return null;
        mutex.lock();
        var status: c_int = 0;
        const exited = if (child_status) |saved| blk: {
            status = saved;
            break :blk true;
        } else c.waitpid(child.id, &status, c.WNOHANG) == child.id;
        if (exited) {
            reaped = true;
            child_status = status;
        }
        mutex.unlock();
        if (exited and n <= 0) {
            if (status != 0 and !(allow_empty and status == 256 and output.items.len == 0)) return null;
            return output.toOwnedSlice(a) catch null;
        }
        if (n <= 0) std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return null;
}
const Probe = struct { scheme: Scheme = .unknown, status: ?u16 = null };
fn probe(endpoint: Endpoint, stopping: *const std.atomic.Value(bool)) Probe {
    var e = endpoint;
    // Use the exact family/address for probing; localhost DNS could hit another
    // process listening on the other address family at the same port.
    const address = if (wildcard(e.bind_address)) if (e.ipv6) "::1" else "127.0.0.1" else e.bind_address;
    var buf: [256]u8 = undefined;
    for ([_]Scheme{ .http, .https }) |scheme| {
        e.scheme = scheme;
        const target = std.fmt.bufPrint(&buf, "{s}://{s}{s}{s}:{d}/", .{ @tagName(scheme), if (e.ipv6) "[" else "", address, if (e.ipv6) "]" else "", e.port }) catch continue;
        // -q disables user curlrc; never use proxies, credentials or redirects.
        // Certificate trust belongs to the browser, not protocol detection.
        const result = command(&.{
            "curl",              "-q",         "--noproxy",   "*",
            "--silent",          "--insecure", "--range",     "0-4095",
            "--connect-timeout", "0.3",        "--max-time",  "0.6",
            "--output",          "/dev/null",  "--write-out", "%{http_code}",
            "--",                target,
        }, stopping, false) orelse continue;
        defer a.free(result);
        const status = std.fmt.parseInt(u16, result, 10) catch continue;
        if (status >= 100 and status <= 599) return .{ .scheme = scheme, .status = status };
    }
    return .{};
}

/// Whether a recurring failure repeats the last one logged.
fn same(last: ?anyerror, err: anyerror) bool {
    return if (last) |previous| previous == err else false;
}
pub const Tracker = struct {
    arena: std.heap.ArenaAllocator = .init(a),
    current: Snapshot = .{},
    pending_arena: std.heap.ArenaAllocator = .init(a),
    pending: Snapshot = .{},
    roots: []const Root = &.{},
    thread: ?std.Thread = null,
    done: std.atomic.Value(bool) = .init(false),
    stopping: std.atomic.Value(bool) = .init(false),
    next_refresh: i64 = 0,
    // Scans repeat every few seconds; warn once per distinct failure.
    scan_error: ?anyerror = null,
    interfaces_error: ?anyerror = null,
    pub fn deinit(t: *Tracker) void {
        t.stopping.store(true, .release);
        if (t.thread) |thread| thread.join();
        t.arena.deinit();
        t.pending_arena.deinit();
    }
    /// A scan is running or its result has not been applied yet.
    pub fn busy(t: *const Tracker) bool {
        return t.thread != null;
    }
    pub fn tick(t: *Tracker, runtime: anytype) bool {
        var changed = false;
        if (t.thread) |thread| {
            if (!t.done.load(.acquire)) return false;
            thread.join();
            t.thread = null;
            // A moved/closed pane must not publish results to its old workspace.
            const valid = for (t.roots) |root| {
                const p = runtime.pane(root.pane) orelse break false;
                const ws = runtime.workspaces.owner(root.pane) orelse break false;
                if (p.terminal.pid != root.pid or ws.id != root.workspace) break false;
            } else true;
            if (valid) {
                t.arena.deinit();
                t.arena = t.pending_arena;
                t.pending_arena = .init(a);
                t.current = t.pending;
                changed = true;
            }
        }
        const now = clock.milliTimestamp();
        if (now < t.next_refresh) return changed;
        t.next_refresh = now + 3000;
        _ = t.pending_arena.reset(.free_all);
        const allocator = t.pending_arena.allocator();
        var roots: std.ArrayList(Root) = .empty;
        for (runtime.panes.items) |p| {
            if (p.terminal.exited) continue;
            const ws = runtime.workspaces.owner(p.id) orelse continue;
            roots.append(allocator, .{ .pid = p.terminal.pid, .pane = p.id, .workspace = ws.id, .agent_pid = p.detection.pid }) catch return changed;
        }
        t.roots = roots.toOwnedSlice(allocator) catch return changed;
        t.pending = .{};
        t.done.store(false, .release);
        t.thread = std.Thread.spawn(.{}, run, .{t}) catch |err| blk: {
            log.warn("spawn scan thread failed: {}", .{err});
            break :blk null;
        };
        return changed;
    }
    fn run(t: *Tracker) void {
        defer t.done.store(true, .release);
        t.scan() catch |err| {
            if (!same(t.scan_error, err)) log.warn("port/process scan failed: {}", .{err});
            t.scan_error = err;
            t.pending = .{};
            return;
        };
        t.scan_error = null;
    }
    fn scan(t: *Tracker) !void {
        const allocator = t.pending_arena.allocator();
        const ps = command(&.{ "ps", "-axo", "pid=,ppid=,pgid=,comm=" }, &t.stopping, false) orelse return;
        defer a.free(ps);
        const list = try processes(allocator, ps);
        const all = if (interfaces(allocator)) |found| blk: {
            t.interfaces_error = null;
            break :blk found;
        } else |err| blk: {
            if (!same(t.interfaces_error, err)) log.warn("network interface enumeration failed: {}", .{err});
            t.interfaces_error = err;
            break :blk &.{};
        };
        const files = command(&.{ "lsof", "-nP", "-iTCP", "-iUDP", "-FpcftPnT" }, &t.stopping, true);
        defer if (files) |text| a.free(text);
        const endpoints = if (files) |text| try sockets(allocator, text, list, t.roots, all) else &.{};
        var works: std.ArrayList(Work) = .empty;
        const now = clock.milliTimestamp();
        for (t.roots) |root| {
            const exists = for (works.items) |w| {
                if (w.id == root.workspace) break true;
            } else false;
            if (exists) continue;
            var work: Work = .{ .id = root.workspace };
            for (list) |p| if (owner(p.pid, list, t.roots)) |owned| {
                if (owned.workspace == root.workspace and workload(p, owned)) work.background += 1;
            };
            var selected: std.ArrayList(Endpoint) = .empty;
            for (endpoints) |endpoint| {
                const owned = owner(endpoint.pid, list, t.roots) orelse continue;
                if (owned.workspace != root.workspace) continue;
                var e = endpoint;
                for (t.current.workspace(work.id).endpoints) |old| {
                    if (old.pid == e.pid and old.pane == e.pane and old.port == e.port and old.ipv6 == e.ipv6 and old.transport == e.transport and std.mem.eql(u8, old.bind_address, e.bind_address)) {
                        e.scheme = old.scheme;
                        e.http_status = old.http_status;
                        e.probed_at = old.probed_at;
                        break;
                    }
                }
                try selected.append(allocator, e);
            }
            work.endpoints = try selected.toOwnedSlice(allocator);
            try works.append(allocator, work);
        }
        // Oldest/unprobed endpoints first, across all workspaces. Busy early
        // workspaces cannot starve later ones of the bounded probe budget.
        for (0..4) |_| {
            if (t.stopping.load(.acquire)) break;
            var oldest: ?*Endpoint = null;
            for (works.items) |work| for (@constCast(work.endpoints)) |*e| {
                if (e.transport != .tcp or now - e.probed_at <= @as(i64, if (!browserResponse(e.http_status)) 15000 else 60000)) continue;
                if (oldest == null or e.probed_at < oldest.?.probed_at) oldest = e;
            };
            const e = oldest orelse break;
            const result = probe(e.*, &t.stopping);
            e.scheme = result.scheme;
            e.http_status = result.status;
            e.probed_at = now;
        }
        t.pending = .{ .processes_available = true, .ports_available = files != null, .workspaces = try works.toOwnedSlice(allocator) };
    }
};

test "viewer chooses only bound addresses in tailscale VPN network order" {
    const all = [_]Interface{
        .{ .name = "en0", .address = "192.168.1.20", .kind = .network },
        .{ .name = "utun2", .address = "10.8.0.2", .kind = .vpn },
        .{ .name = "utun4", .address = "100.80.1.2", .kind = .tailscale },
    };
    var e: Endpoint = .{ .pid = 1, .pane = @enumFromInt(1), .name = "web", .transport = .tcp, .bind_address = "*", .port = 3000, .scheme = .http, .http_status = 200, .interfaces = &all };
    var buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings("http://localhost:3000", url(&buf, e, false).?);
    try std.testing.expectEqualStrings("http://100.80.1.2:3000", url(&buf, e, true).?);
    e.interfaces = all[0..2];
    try std.testing.expectEqualStrings("10.8.0.2", host(e, true).?);
    e.bind_address = "192.168.1.20";
    e.interfaces = all[0..1];
    try std.testing.expectEqualStrings("192.168.1.20", host(e, false).?);
    try std.testing.expectEqualStrings("192.168.1.20", host(e, true).?);
    e.bind_address = "127.0.0.1";
    e.interfaces = &.{};
    try std.testing.expect(url(&buf, e, true) == null);
    try std.testing.expectEqual(Kind.tailscale, kind("utun9", "100.80.1.2"));
    try std.testing.expectEqual(Kind.network, kind("en0", "100.80.1.2"));
}

test "lsof inventory associates descendants, ignores TCP clients, keeps UDP and IPv6 binds" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const allocator = arena.allocator();
    const list = try processes(allocator, "10 1 10\n20 10 20\n21 20 20\n30 1 30\n");
    const roots = [_]Root{.{ .pid = 10, .pane = @enumFromInt(1), .workspace = @enumFromInt(7), .agent_pid = 0 }};
    const text = "p21\ncweb\nf4\ntIPv4\nPTCP\nn*:3000\nTST=LISTEN\nf5\ntIPv4\nPTCP\nn127.0.0.1:51000->127.0.0.1:80\nTST=ESTABLISHED\nf6\ntIPv6\nPUDP\nn[::1]:9000\np30\ncother\nf4\ntIPv4\nPTCP\nn*:4000\nTST=LISTEN\n";
    const endpoints = try sockets(allocator, text, list, &roots, &.{});
    try std.testing.expectEqual(@as(usize, 2), endpoints.len);
    try std.testing.expectEqual(@as(u16, 3000), endpoints[0].port);
    try std.testing.expectEqualStrings("::1", endpoints[1].bind_address);
    try std.testing.expect(endpoints[1].ipv6);
    try std.testing.expectEqual(@as(WorkspaceId, @enumFromInt(7)), owner(21, list, &roots).?.workspace);
    try std.testing.expect(owner(30, list, &roots) == null);
}

test "wildcard interface expansion respects family and explicit bind constraints" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const all = [_]Interface{
        .{ .name = "lo0", .address = "127.0.0.1", .kind = .loopback },
        .{ .name = "en0", .address = "192.168.1.20", .kind = .network },
        .{ .name = "tailscale0", .address = "fd7a:115c:a1e0::1", .kind = .tailscale, .ipv6 = true },
    };
    try std.testing.expectEqual(@as(usize, 2), (try matching(arena.allocator(), "*", false, &all)).len);
    const specific = try matching(arena.allocator(), "192.168.1.20", false, &all);
    try std.testing.expectEqual(@as(usize, 1), specific.len);
    try std.testing.expectEqualStrings("en0", specific[0].name);
    var e: Endpoint = .{
        .pid = 1,
        .pane = @enumFromInt(1),
        .name = "web",
        .transport = .tcp,
        .bind_address = "::",
        .port = 443,
        .ipv6 = true,
        .scheme = .https,
        .http_status = 200,
        .interfaces = try matching(arena.allocator(), "::", true, &all),
    };
    var buf: [256]u8 = undefined;
    try std.testing.expectEqualStrings("https://[fd7a:115c:a1e0::1]:443", url(&buf, e, true).?);
    e.ipv6 = false;
    e.bind_address = "127.0.0.2";
    e.interfaces = &.{};
    try std.testing.expectEqualStrings("https://127.0.0.2:443", url(&buf, e, false).?);
    try std.testing.expect(url(&buf, e, true) == null);
}

test "workloads count foreground servers and agent children but not shells or controllers" {
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const list = try processes(arena.allocator(), "10 1 10 /opt/homebrew/bin/fish\n" ++
        "20 10 20 bun\n21 20 20 bun\n" ++
        "30 10 30 codex\n31 30 30 /bin/sh\n32 31 30 python3\n" ++
        "33 30 33 /opt/node\n" ++
        "40 1 40 unrelated\n");
    const root: Root = .{ .pid = 10, .pane = @enumFromInt(1), .workspace = @enumFromInt(1), .agent_pid = 33 };
    var count: usize = 0;
    for (list) |p| if (owner(p.pid, list, &.{root})) |owned| {
        if (workload(p, owned)) count += 1;
    };
    try std.testing.expectEqual(@as(usize, 3), count);
    // Controller and shell listeners stay hidden, but their workers' ports remain.
    var socket_text: std.ArrayList(u8) = .empty;
    for (list) |p| {
        const entry = try std.fmt.allocPrint(arena.allocator(), "p{d}\ncserver\nf4\ntIPv4\nPTCP\nn127.0.0.1:{d}\nTST=LISTEN\n", .{ p.pid, 8000 + p.pid });
        try socket_text.appendSlice(arena.allocator(), entry);
    }
    const endpoints = try sockets(arena.allocator(), socket_text.items, list, &.{root}, &.{});
    try std.testing.expectEqual(@as(usize, 3), endpoints.len);
    for (endpoints, [_]i32{ 20, 21, 32 }) |endpoint, pid| {
        try std.testing.expectEqual(pid, endpoint.pid);
    }
    // A pane can exec directly into a server; its root PID still counts.
    try std.testing.expect(workload(.{ .pid = 10, .parent = 1, .group = 10, .name = "bun" }, root));
}

test "HTTP errors and unprobed endpoints never become browser links" {
    var e: Endpoint = .{ .pid = 1, .pane = @enumFromInt(1), .name = "web", .transport = .tcp, .bind_address = "127.0.0.1", .port = 3000, .scheme = .http };
    var buf: [256]u8 = undefined;
    try std.testing.expect(url(&buf, e, false) == null);
    for ([_]u16{ 101, 401, 403, 404, 500, 503 }) |status| {
        e.http_status = status;
        try std.testing.expect(url(&buf, e, false) == null);
    }
    for ([_]u16{ 200, 206, 301, 302, 307 }) |status| {
        e.http_status = status;
        try std.testing.expectEqualStrings("http://localhost:3000", url(&buf, e, false).?);
    }
}
