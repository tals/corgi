//! Local workspace/tab/pane selection. Shared models contain no active or zoom state.
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const mirror = @import("mirror.zig");
const protocol = @import("protocol.zig");
const agent_navigation = @import("agent_navigation.zig");
const agent_launcher = @import("agent_launcher.zig");
const Action = @import("action.zig").Action;
pub const State = struct {
    workspace_id: WorkspaceId = .none,
    entries: [workspace.max_workspaces]Entry = @splat(.{}),
    const Entry = struct {
        id: WorkspaceId = .none,
        value: layout.Selection = .{},
        agents: agent_navigation.History = .{},
        /// The launcher row last left selected here.
        launcher: ?agent_launcher.Row = null,
    };
    pub fn index(n: *State, store: *mirror.Workspaces) usize {
        const i = store.index(n.workspace_id) orelse 0;
        n.workspace_id = store.items[i].id;
        return i;
    }
    pub fn current(n: *State, store: *mirror.Workspaces) *protocol.Workspace {
        return &store.items[n.index(store)];
    }
    pub fn tabs(n: *State, store: *mirror.Workspaces) *layout.Selection {
        return &n.entry(store, n.current(store)).value;
    }
    /// Takes over a closed workspace's slot the first time `ws` needs one.
    fn entry(n: *State, store: *mirror.Workspaces, ws: *protocol.Workspace) *Entry {
        for (&n.entries) |*e| if (e.id == ws.id) {
            e.value.reconcile(&ws.model);
            return e;
        };
        for (&n.entries) |*e| if (e.id == WorkspaceId.none or store.index(e.id) == null) {
            e.* = .{ .id = ws.id };
            e.value.reconcile(&ws.model);
            return e;
        };
        unreachable;
    }
    pub const Intent = struct { edit: ?protocol.Command = null, focus: ?layout.PaneId = null };
    pub fn agentHistory(n: *State, store: *mirror.Workspaces) *agent_navigation.History {
        return &n.entry(store, n.current(store)).agents;
    }
    /// The launcher row this viewer last left selected in workspace `id`.
    pub fn launcherRow(n: *State, store: *mirror.Workspaces, id: WorkspaceId) ?agent_launcher.Row {
        const i = store.index(id) orelse return null;
        return n.entry(store, &store.items[i]).launcher;
    }
    pub fn rememberLauncherRow(n: *State, store: *mirror.Workspaces, id: WorkspaceId, row: agent_launcher.Row) void {
        const i = store.index(id) orelse return;
        n.entry(store, &store.items[i]).launcher = row;
    }
    /// Resolve command shorthand once, before crossing the session seam.
    /// `Controller.perform` routes only tab and pane actions here.
    pub fn command(n: *State, store: *mirror.Workspaces, act: Action, area: layout.Rect) !Intent {
        const model = &n.current(store).model;
        if (model.count == 0) return error.NoPane;
        const selected = n.tabs(store);
        const pane = selected.tab().focus;
        const tab = model.tabs[selected.active].id;
        switch (act) {
            .rename => |name| return .{ .edit = .{ .@"tab.rename" = .{ .target = tab, .name = name } } },
            .resize => |direction| return .{ .edit = .{ .@"split.resize" = .{ .target = pane, .direction = direction } } },
            .focus, .swap => |direction| {
                const other = (layout.View{ .model = model, .selection = selected }).neighbor(direction, area) orelse return .{};
                return if (act == .focus) .{ .focus = other } else .{ .edit = .{ .@"pane.swap" = .{ .target = pane, .other = other } } };
            },
            .@"move-tab" => |side| return .{ .edit = moveTab(model, tab, switch (side) {
                .left => selected.active -| 1,
                .right => @min(selected.active + 2, model.count),
            }) },
            .@"break" => return if (model.nodes[model.tabs[selected.active].root].? == .pane)
                .{}
            else
                .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .new_tab = "" } } }, .focus = pane },
            .next, .prev => return .{ .focus = selected.tabs[(selected.active + if (act == .next) @as(usize, 1) else model.count - 1) % model.count].focus },
            .tab, .join => |number| {
                if (number == 0 or number > model.count) return error.NoTab;
                const tab_index = number - 1;
                const target = selected.tabs[tab_index].focus;
                if (act == .join) {
                    if (tab_index == selected.active) return error.NoTab;
                    return .{ .edit = .{ .@"pane.move" = .{ .target = pane, .destination = .{ .beside = .{ .other = target } } } }, .focus = pane };
                }
                return .{ .focus = target };
            },
            else => unreachable,
        }
    }
};

pub fn moveTab(model: *const layout.Model, id: layout.TabId, gap: usize) ?protocol.Command {
    if (gap > model.count or model.count == 0) return null;
    const other = model.tabs[if (gap == model.count) gap - 1 else gap].id;
    if (id == other) return null;
    return .{ .@"tab.move" = .{ .target = id, .destination = if (gap == model.count) .{ .after = other } else .{ .before = other } } };
}
