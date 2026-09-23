//! Versioned runtime data. No viewer focus, menus, or screen coordinates belong
//! in a session snapshot. Clients keep selection by the stable IDs below.
const std = @import("std");
const layout = @import("layout.zig");
const runtime = @import("runtime.zig");
const agents = @import("agents.zig");

pub const version: u32 = 1;
pub const capabilities = [_][]const u8{
    "cli.control",
    "viewer.open",
    "viewer.sync",
    "viewer.search",
    "layout.apply",
    "pane.transfer",
    "pane.restore",
    "pane.rename",
    "workspace.move",
    "pane.acknowledge",
    "workspace.create",
    "session.snapshot",
    "session.subscribe",
    "pane.surface",
    "pane.input",
    "pane.create",
    "pane.split",
    "pane.close",
    "tab.rename",
    "split.resize",
    "server.reload",
    "recovery.save",
};

pub fn require(v: std.json.Value, negotiated: ?u32) !void {
    const requested = v.object.get("protocol");
    const selected = if (requested) |value| blk: {
        if (value != .integer) return error.UnsupportedProtocol;
        break :blk std.math.cast(u32, value.integer) orelse return error.UnsupportedProtocol;
    } else negotiated orelse return error.ProtocolRequired;
    if (selected != version) return error.UnsupportedProtocol;
}

pub fn id(v: std.json.Value, field: []const u8) !u32 {
    const value = v.object.get(field) orelse return error.MissingTarget;
    if (value != .integer) return error.InvalidTarget;
    const n = std.math.cast(u32, value.integer) orelse return error.InvalidTarget;
    if (n == 0) return error.InvalidTarget;
    return n;
}

pub const Node = union(enum) {
    pane: u32,
    split: struct { axis: layout.Axis, ratio: u16, first: *const Node, second: *const Node },
};
pub const Tab = struct { id: u32, title: []const u8, layout: *const Node };
pub const GitCommit = struct { timestamp: i64 = 0, hash: []const u8, subject: []const u8, author: []const u8, date: []const u8 };
pub const Workspace = struct { git_commits: []const GitCommit = &.{}, stats: @import("usage.zig").Counts = .{}, git_ahead: ?u64 = null, token: u64 = 0, id: u32, name: []const u8, cwd: []const u8, custom_name: ?[]const u8 = null, tabs: []const Tab };
pub const Agent = struct {
    subagents: agents.Subagents = .{},
    name: []const u8 = "",
    observation: agents.observation.State = .{},
    recent_activity: []const u8 = "",
    changed_at: i64 = 0,
    provider: agents.Provider,
    state: agents.State,
    attention: agents.Attention,
    session: []const u8,
    activity: []const u8,
    cwd: []const u8,
    tool_active: bool,
    compacting: bool = false,
};
pub const Pane = struct {
    name: []const u8 = "",
    id: u32,
    workspace: u32,
    tab: u32,
    cwd: []const u8,
    pid: i32,
    cols: u16,
    rows: u16,
    exited: bool,
    agent: Agent,
};
pub const Native = struct {
    observation: agents.observation.State = .{},
    id: u32,
    workspace: u32,
    provider: agents.Provider,
    cwd: []const u8,
    ready: bool,
    exited: bool,
    state: agents.State,
    attention: agents.Attention,
    tool_active: bool,
    compacting: bool = false,
};
pub const Snapshot = struct {
    ports: @import("ports.zig").Snapshot = .{},
    type: []const u8 = "session",
    protocol: u32 = version,
    server_pid: i32,
    revision: u64,
    workspaces: []const Workspace,
    panes: []const Pane,
    native_sessions: []const Native,
    closed_panes: usize,
};

/// Allocate containers in a request arena; strings borrow the runtime until
/// serialization completes. No Ghostty or layout implementation structs cross
/// the wire.
pub fn snapshot(allocator: std.mem.Allocator, r: *runtime.Runtime) !Snapshot {
    const workspaces = try allocator.alloc(Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*ws, *out| {
        const tabs = try allocator.alloc(Tab, ws.model.count);
        for (ws.model.tabs[0..ws.model.count], tabs) |*tab, *item| {
            item.* = .{ .id = tab.id, .title = tab.title(), .layout = try tree(allocator, &ws.model, tab.root) };
        }
        const commits = try allocator.alloc(GitCommit, ws.git_commits.len);
        for (ws.git_commits.items[0..ws.git_commits.len], commits) |*commit, *dest| {
            dest.* = .{ .timestamp = commit.timestamp, .hash = commit.hash[0..commit.hash_len], .subject = commit.subject[0..commit.subject_len], .author = commit.author[0..commit.author_len], .date = commit.date[0..commit.date_len] };
        }
        out.* = .{ .git_commits = commits, .token = try layoutToken(&ws.model), .id = ws.id, .name = ws.name(), .cwd = ws.cwd, .custom_name = ws.customName(), .git_ahead = ws.git_ahead, .stats = ws.away.counts, .tabs = tabs };
    }
    const panes = try allocator.alloc(Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        const owner = r.workspaces.owner(p.id) orelse return error.NoWorkspace;
        const tab = owner.model.tabForPane(p.id) orelse return error.NoTab;
        out.* = .{
            .id = p.id,
            .name = p.label.text(),
            .workspace = owner.id,
            .tab = owner.model.tabs[tab].id,
            .cwd = p.cwd,
            .pid = p.terminal.pid,
            .cols = p.terminal.vt.cols,
            .rows = p.terminal.vt.rows,
            .exited = p.terminal.exited,
            .agent = .{
                .subagents = p.agent.subagents,
                .changed_at = p.agent.changed_at,
                .provider = p.agent.provider,
                .state = p.agent.state,
                .attention = p.agent.attention,
                .observation = p.agent.observation,
                .recent_activity = p.agent.recentLabel(),
                .name = p.agent.displayName(),
                .session = p.agent.sessionId(),
                .activity = p.agent.label(),
                .cwd = p.agent.directory(),
                .tool_active = p.agent.tool_active,
                .compacting = p.agent.compacting,
            },
        };
    }
    const sessions = try allocator.alloc(Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*session, *out| out.* = .{
        .id = session.id,
        .workspace = session.workspace_id,
        .provider = session.provider,
        .cwd = session.cwd,
        .ready = session.ready,
        .exited = session.exited,
        .state = session.state,
        .attention = session.attention,
        .observation = session.observation,
        .tool_active = session.toolActive(),
    };
    return .{
        .server_pid = @import("os.zig").c.getpid(),
        .ports = r.ports.current,
        .revision = r.revision,
        .workspaces = workspaces,
        .panes = panes,
        .native_sessions = sessions,
        .closed_panes = r.closed.items.len,
    };
}

fn tree(allocator: std.mem.Allocator, model: *const layout.Model, index: u8) std.mem.Allocator.Error!*const Node {
    const node = try allocator.create(Node);
    node.* = switch (model.nodes[index].?) {
        .pane => |pane| .{ .pane = pane },
        .split => |split| .{ .split = .{
            .axis = split.axis,
            .ratio = split.ratio,
            .first = try tree(allocator, model, split.first),
            .second = try tree(allocator, model, split.second),
        } },
    };
    return node;
}

/// Structural token deliberately excludes presentation state and terminal output.
pub fn encodeTabs(allocator: std.mem.Allocator, model: *const layout.Model) ![]const Tab {
    const result = try allocator.alloc(Tab, model.count);
    for (model.tabs[0..model.count], result) |*tab, *out| out.* = .{
        .id = tab.id,
        .title = tab.title(),
        .layout = try tree(allocator, model, tab.root),
    };
    return result;
}
pub fn layoutToken(model: *const layout.Model) !u64 {
    var arena = std.heap.ArenaAllocator.init(@import("os.zig").allocator);
    defer arena.deinit();
    const bytes = try std.json.Stringify.valueAlloc(arena.allocator(), try encodeTabs(arena.allocator(), model), .{});
    return std.hash.Wyhash.hash(0, bytes) & std.math.maxInt(i64);
}

/// Decode shared organization while preserving the caller's selection by ID.
pub fn modelFromTabs(items: []const Tab, previous: *const layout.Model) !layout.Model {
    if (items.len > layout.max_tabs) return error.TooManyTabs;
    var result: layout.Model = .{ .next_id = previous.next_id };
    var used: usize = 0;
    for (items, 0..) |tab, index| {
        if (tab.id == 0) return error.InvalidLayout;
        for (items[0..index]) |other| if (other.id == tab.id) return error.InvalidLayout;
        const root = try loadNode(&result, tab.layout, &used);
        result.tabs[index] = .{ .id = tab.id, .root = root, .focus = firstPane(&result, root) };
        result.tabs[index].rename(tab.title);
        result.count += 1;
        for (previous.tabs[0..previous.count], 0..) |old, old_index| if (old.id == tab.id) {
            if (result.tabForPane(old.focus) == index) {
                result.tabs[index].focus = old.focus;
                result.tabs[index].zoom = old.zoom;
            }
            if (old_index == previous.active) result.active = index;
        };
    }
    return result;
}
fn firstPane(model: *const layout.Model, index: u8) u32 {
    return switch (model.nodes[index].?) {
        .pane => |id_| id_,
        .split => |s| firstPane(model, s.first),
    };
}
fn loadNode(model: *layout.Model, node: *const Node, used: *usize) !u8 {
    if (used.* >= model.nodes.len) return error.TooManyPanes;
    const index: u8 = @intCast(used.*);
    used.* += 1;
    switch (node.*) {
        .pane => |pane| {
            if (pane == 0) return error.InvalidLayout;
            for (model.nodes) |existing| if (existing) |n| if (n == .pane and n.pane == pane) return error.InvalidLayout;
            model.nodes[index] = .{ .pane = pane };
        },
        .split => |s| {
            if (s.ratio < 100 or s.ratio > 900) return error.InvalidLayout;
            const first = try loadNode(model, s.first, used);
            const second = try loadNode(model, s.second, used);
            model.nodes[index] = .{ .split = .{ .axis = s.axis, .ratio = s.ratio, .first = first, .second = second } };
        },
    }
    return index;
}

test "shared arrangement round trip retains viewer selection by IDs" {
    const a = std.testing.allocator;
    var original: layout.Model = .{};
    const first = try original.newTab("first");
    const split = try original.split(.horizontal);
    const second = try original.newTab("second");
    const token = try layoutToken(&original);
    var viewer = original;
    try viewer.focus(first);
    viewer.tab().zoom = true;
    try std.testing.expectEqual(token, try layoutToken(&viewer));
    var shared = original;
    shared.moveTab(shared.tabs[1].id, 0);
    try shared.close(split);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    var restored = try modelFromTabs(try encodeTabs(arena.allocator(), &shared), &viewer);
    try std.testing.expectEqual(first, restored.tab().focus);
    try std.testing.expectEqual(@as(usize, 1), restored.active);
    try std.testing.expect(restored.tab().zoom);
    var other = try modelFromTabs(try encodeTabs(arena.allocator(), &shared), &original);
    try std.testing.expectEqual(second, other.tab().focus);
    try std.testing.expectEqual(@as(usize, 0), other.active);
}
