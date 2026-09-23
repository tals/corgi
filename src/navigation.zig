//! Local workspace/tab/pane selection. Shared models contain no active or zoom state.
const std = @import("std");
const session = @import("session.zig");
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
pub const State = struct {
    workspace_id: u32 = 0,
    entries: [workspace.max_workspaces]struct { id: u32 = 0, value: layout.Selection = .{} } = @splat(.{}),
    pub fn index(n: *State, store: *@import("mirror.zig").Workspaces) usize {
        const i = store.index(n.workspace_id) orelse 0;
        n.workspace_id = store.items[i].id;
        return i;
    }
    pub fn current(n: *State, store: *@import("mirror.zig").Workspaces) *@import("protocol.zig").Workspace {
        return &store.items[n.index(store)];
    }
    pub fn tabs(n: *State, store: *@import("mirror.zig").Workspaces) *layout.Selection {
        const ws = n.current(store);
        for (&n.entries) |*entry| if (entry.id == ws.id) {
            entry.value.reconcile(&ws.model);
            return &entry.value;
        };
        for (&n.entries) |*entry| if (entry.id == 0 or store.index(entry.id) == null) {
            entry.* = .{ .id = ws.id };
            entry.value.reconcile(&ws.model);
            return &entry.value;
        };
        unreachable;
    }
    pub const Intent = struct { edit: ?session.Command = null, focus: ?u32 = null };
    /// Resolve command shorthand once, before crossing the session seam.
    pub fn command(n: *State, store: *@import("mirror.zig").Workspaces, name: []const u8, value: []const u8, area: layout.Rect) !Intent {
        const model = &n.current(store).model;
        if (model.count == 0) return error.NoPane;
        const selected = n.tabs(store);
        const pane = selected.tab().focus;
        const tab = model.tabs[selected.active].id;
        if (eq(name, "rename")) return .{ .edit = .{ .@"tab.rename" = .{ .target = tab, .name = value } } };
        if (eq(name, "resize") or eq(name, "focus") or eq(name, "swap")) {
            const direction = std.meta.stringToEnum(layout.Direction, value) orelse return error.BadDirection;
            if (eq(name, "resize")) return .{ .edit = .{ .@"split.resize" = .{ .target = pane, .direction = direction } } };
            const other = (layout.View{ .model = model, .selection = selected }).neighbor(direction, area) orelse return .{};
            return if (eq(name, "focus")) .{ .focus = other } else .{ .edit = .{ .@"pane.swap" = .{ .target = pane, .other = other } } };
        }
        if (eq(name, "move-tab")) return .{ .edit = moveTab(model, tab, if (eq(value, "left")) selected.active -| 1 else @min(selected.active + 2, model.count)) };
        if (eq(name, "break")) return if (model.nodes[model.tabs[selected.active].root].? == .pane) .{} else .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .new_tab = "" } } }, .focus = pane };
        var tab_index: usize = undefined;
        if (eq(name, "next") or eq(name, "prev")) {
            tab_index = (selected.active + if (eq(name, "next")) @as(usize, 1) else model.count - 1) % model.count;
        } else if (eq(name, "tab") or eq(name, "join")) {
            const number = try std.fmt.parseInt(usize, value, 10);
            if (number == 0 or number > model.count) return error.NoTab;
            tab_index = number - 1;
        } else return error.UnknownAction;
        const target = selected.tabs[tab_index].focus;
        if (eq(name, "join")) {
            if (tab_index == selected.active) return error.NoTab;
            return .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .beside = .{ .other = target } } } }, .focus = pane };
        }
        return .{ .focus = target };
    }
};

pub fn moveTab(model: *const layout.Model, id: u32, gap: usize) ?session.Command {
    if (gap > model.count or model.count == 0) return null;
    const other = model.tabs[if (gap == model.count) gap - 1 else gap].id;
    if (id == other) return null;
    return .{ .@"tab.move" = .{ .target = id, .destination = if (gap == model.count) .{ .after = other } else .{ .before = other } } };
}
fn eq(a: []const u8, b: []const u8) bool {
    return std.mem.eql(u8, a, b);
}
