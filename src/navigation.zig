//! Local workspace/tab/pane selection. Shared models contain no active or zoom state.
const std = @import("std");
const session = @import("session.zig");
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
pub const State = struct {
    workspace_id: WorkspaceId = .none,
    entries: [workspace.max_workspaces]struct { id: WorkspaceId = .none, value: layout.Selection = .{}, agents: @import("agent_navigation.zig").History = .{} } = @splat(.{}),
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
        for (&n.entries) |*entry| if (entry.id == WorkspaceId.none or store.index(entry.id) == null) {
            entry.* = .{ .id = ws.id };
            entry.value.reconcile(&ws.model);
            return &entry.value;
        };
        unreachable;
    }
    pub const Intent = struct { edit: ?session.Command = null, focus: ?layout.PaneId = null };
    pub fn agentHistory(n: *State, store: *@import("mirror.zig").Workspaces) *@import("agent_navigation.zig").History {
        _ = n.tabs(store);
        for (&n.entries) |*entry| if (entry.id == n.workspace_id) return &entry.agents;
        unreachable;
    }
    /// Resolve command shorthand once, before crossing the session seam.
    pub fn command(n: *State, store: *@import("mirror.zig").Workspaces, act: Action, value: []const u8, area: layout.Rect) !Intent {
        const model = &n.current(store).model;
        if (model.count == 0) return error.NoPane;
        const selected = n.tabs(store);
        const pane = selected.tab().focus;
        const tab = model.tabs[selected.active].id;
        switch (act) {
            .rename => return .{ .edit = .{ .@"tab.rename" = .{ .target = tab, .name = value } } },
            .resize, .focus, .swap => {
                const direction = std.meta.stringToEnum(layout.Direction, value) orelse return error.BadDirection;
                if (act == .resize) return .{ .edit = .{ .@"split.resize" = .{ .target = pane, .direction = direction } } };
                const other = (layout.View{ .model = model, .selection = selected }).neighbor(direction, area) orelse return .{};
                return if (act == .focus) .{ .focus = other } else .{ .edit = .{ .@"pane.swap" = .{ .target = pane, .other = other } } };
            },
            .@"move-tab" => return .{ .edit = moveTab(model, tab, if (std.mem.eql(u8, value, "left")) selected.active -| 1 else @min(selected.active + 2, model.count)) },
            .@"break" => return if (model.nodes[model.tabs[selected.active].root].? == .pane) .{} else .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .new_tab = "" } } }, .focus = pane },
            .next, .prev => return .{ .focus = selected.tabs[(selected.active + if (act == .next) @as(usize, 1) else model.count - 1) % model.count].focus },
            .tab, .join => {
                const number = try std.fmt.parseInt(usize, value, 10);
                if (number == 0 or number > model.count) return error.NoTab;
                const tab_index = number - 1;
                const target = selected.tabs[tab_index].focus;
                if (act == .join) {
                    if (tab_index == selected.active) return error.NoTab;
                    return .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .beside = .{ .other = target } } } }, .focus = pane };
                }
                return .{ .focus = target };
            },
        }
    }
};

/// Names the controller delegates to `State.command` once its own action names don't match.
pub const Action = enum { rename, resize, focus, swap, @"move-tab", @"break", next, prev, tab, join };

pub fn moveTab(model: *const layout.Model, id: layout.TabId, gap: usize) ?session.Command {
    if (gap > model.count or model.count == 0) return null;
    const other = model.tabs[if (gap == model.count) gap - 1 else gap].id;
    if (id == other) return null;
    return .{ .@"tab.move" = .{ .target = id, .destination = if (gap == model.count) .{ .after = other } else .{ .before = other } } };
}
