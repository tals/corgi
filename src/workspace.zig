const std = @import("std");
const layout = @import("layout.zig");
const a = @import("os.zig").allocator;

pub const max_workspaces = 32;

pub const Workspace = struct {
    id: u32,
    name_buf: [80]u8 = .{0} ** 80,
    name_len: usize = 0,
    cwd: []const u8,
    model: layout.Model = .{},
    agent_order: @import("agent_order.zig").Order = .{},
    git_ahead: ?u64 = null,
    git_ref: @import("git_push.zig").Ref = .{},
    git_push: @import("git_push.zig").State = .{},
    git_commits: @import("git_status.zig").Commits = .{},
    away: @import("usage.zig").Window = .{},
    pub fn customName(w: *const Workspace) []const u8 {
        return w.name_buf[0..w.name_len];
    }
    pub fn name(w: *const Workspace) []const u8 {
        if (w.name_len > 0) return w.customName();
        const base = std.fs.path.basename(w.cwd);
        return if (base.len > 0) base else "/";
    }
    pub fn follow(w: *Workspace, cwd: []const u8) !bool {
        if (cwd.len == 0 or std.mem.eql(u8, w.cwd, cwd)) return false;
        const next = try a.dupe(u8, cwd);
        a.free(w.cwd);
        w.cwd = next;
        w.git_ahead = null;
        w.git_ref = .{};
        w.git_push = .{};
        w.git_commits = .{};
        return true;
    }
    fn rename(w: *Workspace, value: []const u8) void {
        const label = std.mem.trim(u8, value, " ");
        w.name_len = @min(label.len, w.name_buf.len);
        for (label[0..w.name_len], 0..) |ch, i| w.name_buf[i] = if (ch >= 32 and ch < 127) ch else '_';
    }
};
pub const Store = struct {
    items: std.ArrayList(Workspace) = .empty,
    next_id: u32 = 1,
    next_pane_id: u32 = 1,
    const SavedWorkspace = struct { id: u32, name: []const u8, cwd: []const u8 };
    const Saved = struct { version: u32 = 2, active: u32, next_id: u32, workspaces: []const SavedWorkspace };

    pub fn statePath(socket: []const u8) ![]const u8 {
        const os = @import("os.zig");
        // go.sh environments keep durable settings separate from short /tmp sockets.
        if (os.env("CORGI_ENV_DIR")) |root| return std.fs.path.join(a, &.{ root, "state", "corgi", "workspaces.json" });
        if (os.env("CORGI_SOCKET") != null) return std.fmt.allocPrint(a, "{s}.workspaces.json", .{socket});
        if (os.env("XDG_STATE_HOME")) |root| return std.fs.path.join(a, &.{ root, "corgi", "workspaces.json" });
        return std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".local", "state", "corgi", "workspaces.json" });
    }
    pub fn save(s: *Store, path: []const u8, selected: u32) !void {
        var entries: [max_workspaces]SavedWorkspace = undefined;
        for (s.items.items, 0..) |*w, i| entries[i] = .{ .id = w.id, .name = w.customName(), .cwd = w.cwd };
        const bytes = try std.json.Stringify.valueAlloc(a, Saved{ .active = selected, .next_id = s.next_id, .workspaces = entries[0..s.items.items.len] }, .{ .whitespace = .indent_2 });
        defer a.free(bytes);
        try std.fs.cwd().makePath(std.fs.path.dirname(path) orelse ".");
        const temp = try std.fmt.allocPrint(a, "{s}.tmp", .{path});
        defer a.free(temp);
        var file = try std.fs.cwd().createFile(temp, .{ .mode = 0o600 });
        defer file.close();
        errdefer std.fs.cwd().deleteFile(temp) catch {};
        try file.writeAll(bytes);
        try file.sync();
        try std.fs.cwd().rename(temp, path);
    }
    pub fn load(s: *Store, path: []const u8) !?u32 {
        const bytes = std.fs.cwd().readFileAlloc(a, path, 1024 * 1024) catch |err| switch (err) {
            error.FileNotFound => return null,
            else => return err,
        };
        defer a.free(bytes);
        const parsed = try std.json.parseFromSlice(Saved, a, bytes, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const saved = parsed.value;
        if ((saved.version != 1 and saved.version != 2) or saved.workspaces.len == 0 or saved.workspaces.len > max_workspaces) return error.InvalidWorkspaceState;
        var restored: Store = .{};
        errdefer restored.deinit();
        for (saved.workspaces) |w| {
            if (w.id == 0 or w.id >= saved.next_id or restored.index(w.id) != null or !std.fs.path.isAbsolute(w.cwd)) return error.InvalidWorkspaceState;
            const cwd = try a.dupe(u8, w.cwd);
            errdefer a.free(cwd);
            var item: Workspace = .{ .id = w.id, .cwd = cwd };
            item.rename(w.name);
            try restored.items.append(a, item);
        }
        _ = restored.index(saved.active) orelse return error.InvalidWorkspaceState;
        restored.next_id = saved.next_id;
        s.deinit();
        s.* = restored;
        return saved.active;
    }
    pub fn deinit(s: *Store) void {
        for (s.items.items) |w| a.free(w.cwd);
        s.items.deinit(a);
    }
    pub fn index(s: *const Store, id: u32) ?usize {
        for (s.items.items, 0..) |w, i| if (w.id == id) return i;
        return null;
    }
    pub fn get(s: *Store, id: u32) ?*Workspace {
        return &s.items.items[s.index(id) orelse return null];
    }
    pub fn owner(s: *Store, pane: u32) ?*Workspace {
        for (s.items.items) |*w| if (w.model.tabForPane(pane) != null) return w;
        return null;
    }
    /// Move before another workspace; before == id moves to the end.
    pub fn moveBefore(s: *Store, id: u32, before: u32) !void {
        const from = s.index(id) orelse return error.NoWorkspace;
        _ = s.index(before) orelse return error.NoWorkspace;
        const item = s.items.orderedRemove(from);
        const to = if (before == id) s.items.items.len else s.index(before).?;
        s.items.insertAssumeCapacity(to, item);
    }
    pub fn directory(path: []const u8) ![]const u8 {
        const home = @import("os.zig").env("HOME") orelse ".";
        const expanded = if (std.mem.eql(u8, path, "~")) try a.dupe(u8, home) else if (std.mem.startsWith(u8, path, "~/")) try std.fs.path.join(a, &.{ home, path[2..] }) else try a.dupe(u8, if (path.len == 0) "." else path);
        defer a.free(expanded);
        var dir = try std.fs.cwd().openDir(expanded, .{});
        defer dir.close();
        return dir.realpathAlloc(a, ".");
    }
    pub fn add(s: *Store, name: []const u8, cwd: []const u8) !u32 {
        if (s.items.items.len >= max_workspaces) return error.TooManyWorkspaces;
        const path = try directory(cwd);
        errdefer a.free(path);
        var w: Workspace = .{ .id = s.next_id, .cwd = path };
        w.rename(name);
        try s.items.append(a, w);
        s.next_id += 1;
        return w.id;
    }
    pub fn rename(s: *Store, id: u32, name: []const u8) !void {
        const w = s.get(id) orelse return error.NoWorkspace;
        w.rename(name);
    }
    pub fn edit(s: *Store, id: u32, name: []const u8, cwd: []const u8) !void {
        const w = s.get(id) orelse return error.NoWorkspace;
        const path = try directory(cwd);
        a.free(w.cwd);
        w.cwd = path;
        w.git_ahead = null;
        w.git_ref = .{};
        w.git_push = .{};
        w.git_commits = .{};
        w.rename(name);
    }
};

test "automatic workspace names follow folders while overrides survive save and load" {
    var store: Store = .{};
    defer store.deinit();
    const id = try store.add("", ".");
    _ = try store.items.items[0].follow("/tmp/项目");
    try std.testing.expectEqualStrings("项目", store.items.items[0].name());
    try store.rename(id, "My project");
    _ = try store.items.items[0].follow("/tmp/next");
    try std.testing.expectEqualStrings("My project", store.items.items[0].name());
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const root = try tmp.dir.realpathAlloc(a, ".");
    defer a.free(root);
    const path = try std.fs.path.join(a, &.{ root, "workspaces.json" });
    defer a.free(path);
    try store.save(path, store.items.items[0].id);
    var restored: Store = .{};
    defer restored.deinit();
    try std.testing.expect((try restored.load(path)) != null);
    try std.testing.expectEqualStrings("My project", restored.items.items[0].name());
    try store.rename(id, "");
    try store.save(path, store.items.items[0].id);
    try std.testing.expect((try restored.load(path)) != null);
    _ = try restored.items.items[0].follow("/tmp/new");
    try std.testing.expectEqualStrings("new", restored.items.items[0].name());
    try std.testing.expectEqualStrings("", restored.items.items[0].customName());
    _ = try restored.items.items[0].follow("/");
    try std.testing.expectEqualStrings("/", restored.items.items[0].name());
}

test "old workspace state drops pins and preserves all existing names" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    const legacy =
        \\{"version":1,"active":1,"next_id":3,"workspaces":[{"id":1,"name":"Default","cwd":"/tmp/project","pinned":true},{"id":2,"name":"Custom","cwd":"/tmp/other","pinned":true}]}
    ;
    try tmp.dir.writeFile(.{ .sub_path = "workspaces.json", .data = legacy });
    const path = try tmp.dir.realpathAlloc(a, "workspaces.json");
    defer a.free(path);
    var store: Store = .{};
    defer store.deinit();
    try std.testing.expect((try store.load(path)) != null);
    try std.testing.expectEqualStrings("Default", store.items.items[0].name());
    try std.testing.expectEqualStrings("Custom", store.items.items[1].name());
    try store.rename(store.items.items[0].id, "");
    _ = try store.items.items[0].follow("/tmp/moved");
    try std.testing.expectEqualStrings("moved", store.items.items[0].name());
}
