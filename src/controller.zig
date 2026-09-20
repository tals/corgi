const std = @import("std");
const keyboard = @import("keyboard.zig");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const render = @import("render.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const workspace = @import("workspace.zig");
const RealTerminal = @import("terminal.zig").Terminal;
const native = @import("native.zig");
const Theme = @import("theme.zig").Theme;
const runtime = @import("runtime.zig");
const protocol = @import("protocol.zig");
const TabDrag = struct {
    workspace_id: u32,
    tab_id: layout.Id,
    start_x: u16,
    width: u16,
    tabs_x: u16,
    first: usize,
    ids: [layout.max_tabs]layout.Id = undefined,
    count: usize,
    dragging: bool = false,
    cancelled: bool = false,
    drop: ?render.TabDrop = null,
};
pub const Interest = struct { pane: u32, cols: u16, rows: u16, offset: ?usize = null };
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
const ReadReceipt = struct { pane: u32, through: u64, attention_at: i64 };
pub const Client = struct {
    presented: [layout.max_panes]ReadReceipt = undefined,
    presented_count: usize = 0,
    viewer_id: u32 = 0,
    can_relaunch: bool = false,
    next_control: u64 = 1,
    last_control: u64 = 0,
    view_workspace: u32 = 0,
    controls: std.ArrayList(Control) = .empty,
    viewer: bool = false,
    view_focus: ?u32 = null,
    interests: [layout.max_panes]Interest = undefined,
    interest_count: usize = 0,
    fd: c_int,
    input: std.ArrayList(u8) = .empty,
    output: std.ArrayList(u8) = .empty,
    sent: usize = 0,
    attached: bool = false,
    protocol_version: ?u32 = null,
    subscribed: bool = false,
    snapshot_revision: ?u64 = null,
    last_snapshot: i64 = 0,
    width: u16 = 100,
    height: u16 = 30,
    needs_frame: bool = true,
    watched: bool = true,
    paste: bool = false,
    paste_pane: ?layout.Id = null,
    paste_to_name: bool = false,
    tab_drag: ?TabDrag = null,
    keybuf: std.ArrayList(u8) = .empty,
    escape_at: i64 = 0,
    dead: bool = false,
    touched: i64 = 0,
    pub fn queue(cl: *Client, value: anytype) !void {
        const data = try std.json.Stringify.valueAlloc(a, value, .{});
        defer a.free(data);
        if (cl.output.items.len + data.len > 4 * 1024 * 1024) {
            cl.dead = true;
            return;
        }
        try cl.output.appendSlice(a, data);
        try cl.output.append(a, '\n');
    }
    fn deinit(cl: *Client) void {
        @import("viewer_protocol.zig").clearControls(cl);
        cl.controls.deinit(a);
        _ = c.close(cl.fd);
        cl.input.deinit(a);
        cl.keybuf.deinit(a);
        cl.output.deinit(a);
    }
};
pub fn Controller(comptime remote: bool) type {
    return struct {
        const Server = @This();
        const Terminal = if (remote) @import("mirror.zig").Terminal else RealTerminal;
        const Pane = if (remote) @import("mirror.zig").Pane else runtime.Pane;
        connection: if (remote) *@import("rpc.zig").Connection else void = if (remote) undefined else {},
        runtime: if (remote) @import("mirror.zig").Runtime else runtime.Runtime = .{},
        workspace_offset: usize = 0,
        default_folder_pending: bool = true,
        clients: std.ArrayList(Client) = .empty,
        socket: []const u8,
        executable: []const u8,
        width: u16 = 100,
        height: u16 = 30,
        theme: Theme = .{},
        dirty: bool = true,
        quit: bool = false,
        prefix: bool = false,
        menu_page: usize = 0,
        menu_highlight: ?u8 = null,
        sidebar_open: bool = true,
        sidebar_offset: usize = 0,
        tab_menu: ?commands.TabMenu = null,
        ui_mouse_down: bool = false,
        resize_mode: bool = false,
        copy_mode: bool = false,
        name_dialog: ?naming.Dialog = null,
        confirm: enum { none, pane, tab } = .none,
        confirm_tab: ?layout.Id = null,
        message: [512]u8 = .{0} ** 512,
        message_len: usize = 0,
        native_notice: ?u32 = null,
        bell: bool = false,
        bell_kind: agents.Attention = .none,
        muted: bool = false,
        divider: ?layout.Model.Divider = null,
        selection: ?struct { pane: u32, x: u16, y: u16, moved: bool = false } = null,
        search_mode: bool = false,
        search_text: [128]u8 = .{0} ** 128,
        search_len: usize = 0,
        search_skip: usize = 0,
        last_frame: i64 = 0,
        last_bell: i64 = 0,
        bell_seq: u64 = 0,
        next_viewer: u32 = 1,
        last_bell_kind: agents.Attention = .none,
        last_detection: i64 = 0,
        inherited_listener: ?c_int = null,
        reload_executable: ?[]const u8 = null,
        reload_requester: c_int = -1,
        last_recovery: i64 = 0,
        saved_revision: u64 = 0,

        fn model(s: *Server) *layout.Model {
            return &s.runtime.workspaces.current().model;
        }
        pub fn saveWorkspaces(s: *Server) void {
            if (remote) return;
            const path = workspace.Store.statePath(s.socket) catch {
                s.notice(" Could not save workspaces");
                return;
            };
            defer a.free(path);
            s.runtime.workspaces.save(path) catch |err| {
                std.log.err("saving workspaces: {s}", .{@errorName(err)});
                s.notice(" Could not save workspaces");
            };
        }
        pub fn switchWorkspace(s: *Server, id: u32) !void {
            const index = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
            for (s.clients.items) |*cl| if (cl.tab_drag) |*drag| {
                drag.cancelled = true;
            };
            s.dismissName();
            s.closeMenu();
            s.runtime.workspaces.active = index;
            s.revealWorkspace();
            s.sidebar_offset = 0;
            s.copy_mode = false;
            s.search_mode = false;
            s.selection = null;
            s.divider = null;
            s.confirm = .none;
            s.confirm_tab = null;
            s.message_len = 0;
            s.native_notice = null;
            s.acknowledge();
            try s.resizePanes();
            s.saveWorkspaces();
            s.dirty = true;
        }
        fn closeWorkspace(s: *Server, id: u32, close_contents: bool) !void {
            const index = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
            if (s.runtime.workspaces.items.items.len == 1) return error.LastWorkspace;
            if (remote) {
                try s.flushLayout();
                const response = try s.connection.call(.{ .op = "workspace.close", .workspace = id, .close_contents = close_contents });
                defer response.deinit();
                try s.refresh();
                try s.switchWorkspace(s.runtime.workspaces.current().id);
                return;
            }
            const ws = &s.runtime.workspaces.items.items[index];
            if (!close_contents) {
                if (ws.model.count > 0) return error.WorkspaceNotEmpty;
                for (s.runtime.sessions.items) |session| if (session.workspace_id == id) return error.WorkspaceNotEmpty;
            }
            while (ws.model.count > 0) try s.close(ws.model.tabs[0].focus);
            var i: usize = 0;
            while (i < s.runtime.sessions.items.len) {
                if (s.runtime.sessions.items[i].workspace_id == id) {
                    s.runtime.sessions.items[i].destroy();
                    _ = s.runtime.sessions.orderedRemove(i);
                } else i += 1;
            }
            const removed = s.runtime.workspaces.items.orderedRemove(index);
            a.free(removed.cwd);
            if (s.runtime.workspaces.active > index) s.runtime.workspaces.active -= 1 else if (s.runtime.workspaces.active >= s.runtime.workspaces.items.items.len) s.runtime.workspaces.active -= 1;
            try s.switchWorkspace(s.runtime.workspaces.current().id);
        }
        fn revealWorkspace(s: *Server) void {
            const capacity = s.sidebarView(0).workspaceCapacity();
            const index = s.runtime.workspaces.active;
            if (index < s.workspace_offset) s.workspace_offset = index else if (index >= s.workspace_offset + capacity) s.workspace_offset = index + 1 - capacity;
        }
        pub fn focusPane(s: *Server, id: u32) !void {
            const owner = s.runtime.workspaces.owner(id) orelse return error.NoPane;
            const workspace_id = owner.id;
            if (workspace_id != s.runtime.workspaces.current().id) try s.switchWorkspace(workspace_id);
            try s.model().focus(id);
            s.followWorkspaceDirectories();
        }
        pub fn area(s: *Server) layout.Rect {
            return s.sidebarView(0).area();
        }
        fn sidebarView(s: *Server, count: usize) sidebar.View {
            return sidebar.View.init(s.width, s.height, s.sidebar_open, s.sidebar_offset, count).withWorkspaces(s.runtime.workspaces.items.items.len, s.workspace_offset);
        }
        pub fn inheritedCwd(s: *Server, ws: *workspace.Workspace, target: ?layout.Id) []const u8 {
            const id = target orelse if (ws.model.count > 0) ws.model.tab().focus else return ws.cwd;
            const p = s.pane(id) orelse return ws.cwd;
            if (!remote) p.refreshCwd();
            return p.cwd;
        }
        fn currentCwd(s: *Server) []const u8 {
            return s.inheritedCwd(s.runtime.workspaces.current(), null);
        }
        fn followWorkspaceDirectories(s: *Server) void {
            var changed = false;
            for (s.runtime.workspaces.items.items) |*ws| {
                if (ws.model.count == 0) continue;
                const p = s.pane(ws.model.tabs[0].focus) orelse continue;
                changed = (ws.follow(p.cwd) catch false) or changed;
            }
            if (changed) {
                s.dirty = true;
                if (!remote) s.saveWorkspaces();
            }
        }
        pub fn workspaceEntries(s: *Server, out: *[workspace.max_workspaces]sidebar.WorkspaceEntry) []sidebar.WorkspaceEntry {
            s.followWorkspaceDirectories();
            for (s.runtime.workspaces.items.items, 0..) |*ws, i| out[i] = .{ .id = ws.id, .name = ws.name(), .cwd = ws.cwd, .active = i == s.runtime.workspaces.active, .git_ahead = ws.git_ahead };
            return out[0..s.runtime.workspaces.items.items.len];
        }
        pub fn agentEntries(s: *Server, entries: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
            var count: usize = 0;
            for (s.model().tabs[0..s.model().count], 0..) |_, tab_index| {
                for (s.runtime.panes.items) |*p| {
                    if (p.agent.provider == .other or s.model().tabForPane(p.id) != tab_index) continue;
                    entries[count] = .{ .target = .{ .pane = p.id }, .provider = p.agent.provider, .state = p.agent.state, .attention = p.agent.attention, .focused = s.model().tab().focus == p.id, .cwd = if (p.agent.cwd_len > 0) p.agent.directory() else p.cwd, .tool_active = p.agent.tool_active, .unread = p.agent.observation.unread(), .activity = if (p.agent.label().len > 0) p.agent.label() else p.agent.recentLabel() };
                    count += 1;
                }
            }
            for (s.runtime.sessions.items) |*session| {
                if (session.workspace_id != s.runtime.workspaces.current().id) continue;
                entries[count] = .{ .target = .{ .native = session.id }, .provider = session.provider, .state = session.state, .attention = session.attention, .focused = s.native_notice == session.id, .cwd = session.cwd, .tool_active = session.toolActive(), .unread = session.observation.unread() };
                count += 1;
            }
            return entries[0..count];
        }
        fn selectAgent(s: *Server, target: sidebar.Target) !void {
            s.copy_mode = false;
            s.search_mode = false;
            s.selection = null;
            s.divider = null;
            s.message_len = 0;
            s.native_notice = null;
            switch (target) {
                .pane => |id| {
                    try s.focusPane(id);
                    s.acknowledge();
                    try s.resizePanes();
                },
                .native => |id| for (s.runtime.sessions.items) |session| {
                    if (session.id != id) continue;
                    var msg: [180]u8 = undefined;
                    s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}. Inspect: corgi native events {d}", .{ @tagName(session.provider), id, @tagName(session.state), id }));
                    s.native_notice = id;
                    break;
                },
            }
            s.dirty = true;
        }
        fn pane(s: *Server, id: layout.Id) ?*Pane {
            return s.runtime.pane(id);
        }
        pub fn focused(s: *Server) ?*Pane {
            return if (s.model().count == 0) null else s.pane(s.model().tab().focus);
        }
        pub fn notice(s: *Server, msg: []const u8) void {
            s.message_len = agents.clean(&s.message, msg);
            s.native_notice = null;
            s.dirty = true;
        }
        fn acknowledge(s: *Server) void {
            if (remote) return;
            if (s.focused()) |p| p.agent.acknowledge();
        }
        pub fn menu(s: *Server) ?commands.View {
            if (!s.prefix and !s.resize_mode) return null;
            var view = commands.View.init(s.width, s.height, s.resize_mode, s.menu_page, s.model().count > 0);
            view.highlighted = s.menu_highlight;
            return view;
        }
        fn hasMenu(s: *Server) bool {
            return s.prefix or s.resize_mode or s.tab_menu != null;
        }
        fn tabIndex(s: *Server, id: layout.Id) ?usize {
            for (s.model().tabs[0..s.model().count], 0..) |tab, i| if (tab.id == id) return i;
            return null;
        }
        fn openTabMenu(s: *Server, index: usize, x: u16) void {
            s.closeMenu();
            s.search_mode = false;
            s.divider = null;
            s.selection = null;
            s.tab_menu = .{ .tab = s.model().tabs[index].id, .anchor_x = x };
        }
        fn tabMenuAction(s: *Server, key_: u8) !void {
            const context = s.tab_menu orelse return;
            s.closeMenu();
            if (context.workspace) {
                if (s.runtime.workspaces.index(context.tab) == null) return;
                switch (key_) {
                    'T' => s.beginWorkspace(context.tab),
                    'X' => s.closeWorkspace(context.tab, true) catch |err| s.notice(if (err == error.LastWorkspace) " Cannot close the last workspace" else " Could not close workspace"),
                    else => {},
                }
                return;
            }
            s.model().active = s.tabIndex(context.tab) orelse return;
            s.copy_mode = false;
            s.acknowledge();
            try s.resizePanes();
            switch (key_) {
                'c' => try s.beginNewTab(),
                'T' => s.beginRename(),
                'X' => try s.action("close-tab", ""),
                else => {},
            }
        }
        fn moveTabMenu(s: *Server, next: bool) void {
            if (s.tab_menu) |*context| context.move(next);
            s.dirty = true;
        }
        fn openMenu(s: *Server) void {
            s.tab_menu = null;
            s.prefix = true;
            s.menu_page = 0;
            s.menu_highlight = null;
            s.divider = null;
            s.selection = null;
            s.dirty = true;
        }
        fn closeMenu(s: *Server) void {
            s.tab_menu = null;
            s.menu_highlight = null;
            s.prefix = false;
            s.resize_mode = false;
            s.dirty = true;
        }
        fn pageMenu(s: *Server, next: bool) void {
            const view = s.menu() orelse return;
            s.menu_highlight = null;
            s.menu_page = if (next) (view.page + 1) % view.pages else (view.page + view.pages - 1) % view.pages;
            s.dirty = true;
        }
        fn beginWorkspace(s: *Server, id: ?u32) void {
            s.dismissName();
            const initial = if (id) |value| s.runtime.workspaces.items.items[s.runtime.workspaces.index(value) orelse return].customName() else "";
            s.name_dialog = naming.Dialog.init(.{ .workspace_name = id }, initial);
            s.prepareName();
        }
        fn newWorkspace(s: *Server, name: []const u8, cwd: []const u8) !u32 {
            if (remote) {
                try s.flushLayout();
                const response = try s.connection.call(.{ .op = "workspace.create", .protocol = 1, .name = name, .cwd = cwd });
                defer response.deinit();
                const id = try protocol.id(response.value, "workspace");
                try s.refresh();
                try s.switchWorkspace(id);
                return id;
            }
            if (s.runtime.panes.items.len >= layout.max_panes) return error.TooManyPanes;
            const id = try s.runtime.workspaces.add(name, cwd);
            try s.switchWorkspace(id);
            _ = try s.create(null, s.currentCwd(), null, "");
            return id;
        }
        fn beginRename(s: *Server) void {
            if (s.model().count == 0) return;
            const tab = s.model().tab();
            s.dismissName();
            s.name_dialog = naming.Dialog.init(.{ .rename = tab.id }, tab.title());
            s.prepareName();
        }
        fn beginNewTab(s: *Server) !void {
            s.followWorkspaceDirectories();
            const cwd = try a.dupe(u8, s.currentCwd());
            s.dismissName();
            s.name_dialog = naming.Dialog.init(.{ .create = cwd }, "");
            s.prepareName();
        }
        fn prepareName(s: *Server) void {
            s.search_mode = false;
            s.copy_mode = false;
            s.closeMenu();
            s.divider = null;
            s.selection = null;
            s.dirty = true;
        }
        pub fn dismissName(s: *Server) void {
            if (s.name_dialog) |dialog| switch (dialog.target) {
                .create => |cwd| a.free(cwd),
                else => {},
            };
            s.name_dialog = null;
        }
        fn finishName(s: *Server, save: bool) void {
            s.dirty = true;
            if (save) if (s.name_dialog) |*dialog| {
                switch (dialog.target) {
                    .workspace_name => |id| {
                        const name = a.dupe(u8, dialog.name()) catch {
                            dialog.failed = true;
                            return;
                        };
                        if (id == null) {
                            defer a.free(name);
                            _ = s.newWorkspace(name, s.currentCwd()) catch {
                                s.notice(" Could not create workspace");
                            };
                            return;
                        }
                        defer a.free(name);
                        if (remote) s.connection.send(.{ .op = "workspace.edit", .workspace = id.?, .name = name }) catch {
                            dialog.failed = true;
                            return;
                        };
                        s.runtime.workspaces.rename(id.?, name) catch {
                            dialog.failed = true;
                            return;
                        };
                        s.saveWorkspaces();
                    },
                    .rename => |id| {
                        if (s.tabIndex(id)) |index| s.model().tabs[index].rename(dialog.name());
                    },
                    .create => |cwd| {
                        var dir = std.fs.cwd().openDir(cwd, .{}) catch {
                            dialog.failed = true;
                            return;
                        };
                        dir.close();
                        _ = s.create(null, cwd, null, dialog.name()) catch {
                            dialog.failed = true;
                            return;
                        };
                    },
                }
            };
            s.dismissName();
            s.message_len = 0;
        }
        fn create(s: *Server, split: ?layout.Axis, cwd: []const u8, command: ?[]const u8, title: []const u8) !layout.Id {
            if (remote) {
                try s.flushLayout();
                const response = if (split) |axis| try s.connection.call(.{ .op = "pane.split", .protocol = 1, .pane = if (s.model().count > 0) s.model().tab().focus else 0, .axis = if (axis == .horizontal) "right" else "down", .cwd = cwd, .command = command orelse "", .title = title }) else try s.connection.call(.{ .op = "pane.create", .protocol = 1, .workspace = s.runtime.workspaces.current().id, .cwd = cwd, .command = command orelse "", .title = title });
                defer response.deinit();
                const id = try protocol.id(response.value, "pane");
                try s.refresh();
                try s.focusPane(id);
                s.model().tab().zoom = false;
                s.dirty = true;
                return id;
            }
            if (split != null and s.model().count == 0) return error.NoPane;
            if (s.runtime.panes.items.len >= layout.max_panes) return error.TooManyPanes;
            const dir = try workspace.Store.directory(cwd);
            defer a.free(dir);
            if (s.default_folder_pending and s.runtime.workspaces.current().id == 1) {
                try s.runtime.workspaces.edit(1, s.runtime.workspaces.current().customName(), dir);
                s.saveWorkspaces();
            }
            s.default_folder_pending = false;
            const id = try s.runtime.create(.{
                .workspace = s.runtime.workspaces.current().id,
                .split = if (split) |axis| .{ .pane = s.model().tab().focus, .axis = axis } else null,
                .cwd = dir,
                .command = command,
                .title = title,
                .cols = s.area().w,
                .rows = s.area().h,
                .theme = s.theme,
                .socket = s.socket,
                .executable = s.executable,
            });
            try s.model().focus(id);
            if (split != null) s.model().tab().zoom = false;
            try s.resizePanes();
            s.dirty = true;
            return id;
        }
        pub fn resizePanes(s: *Server) !void {
            if (remote) {
                s.dirty = true;
                return;
            }
            try s.resizeModel(s.model());
        }
        fn resizePaneTab(s: *Server, id: layout.Id) !void {
            const owner = s.runtime.workspaces.owner(id) orelse return error.NoPane;
            var projection = owner.model;
            projection.active = projection.tabForPane(id) orelse return error.NoPane;
            try s.resizeModel(&projection);
        }
        fn resizeModel(s: *Server, projection: *const layout.Model) !void {
            if (!s.hasClient()) {
                for (s.clients.items) |cl| if (cl.viewer and !cl.dead) return;
            }
            var locations: [layout.max_panes]layout.Placement = undefined;
            for (projection.placements(s.area(), &locations)) |place| if (s.pane(place.id)) |p| {
                try p.terminal.resize(@max(1, place.rect.w), @max(1, place.rect.h));
            };
        }
        pub fn close(s: *Server, id: layout.Id) !void {
            if (remote) {
                try s.flushLayout();
                try s.connection.send(.{ .op = "pane.close", .protocol = 1, .pane = id });
                try s.refresh();
                if (s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.items.len == 1) {
                    for (s.clients.items) |*cl| {
                        cl.attached = false;
                        try cl.queue(.{ .type = "detach" });
                    }
                }
                s.dirty = true;
                return;
            }
            const owner = s.runtime.workspaces.owner(id) orelse return error.NoPane;
            const closed_tab = owner.model.tabs[owner.model.tabForPane(id).?].id;
            const was_focused = s.model().count > 0 and s.model().tab().focus == id;
            try s.runtime.close(id);
            // Closing a background split must resize its survivors too.
            for (owner.model.tabs[0..owner.model.count]) |tab| if (tab.id == closed_tab) {
                try s.resizePaneTab(tab.focus);
                break;
            };
            // A removed split can invalidate a drag even if its pane wasn't focused.
            s.divider = null;
            s.selection = null;
            if (s.tab_menu) |context| if (if (context.workspace) s.runtime.workspaces.index(context.tab) == null else s.tabIndex(context.tab) == null) {
                s.tab_menu = null;
            };
            if (s.confirm_tab) |target| if (s.tabIndex(target) == null) {
                s.confirm = .none;
                s.confirm_tab = null;
                s.message_len = 0;
            };
            if (s.name_dialog) |dialog| if (dialog.target == .rename and s.tabIndex(dialog.target.rename) == null) s.dismissName();
            if (was_focused) {
                s.copy_mode = false;
                s.search_mode = false;
                s.resize_mode = false;
                s.confirm = .none;
                s.confirm_tab = null;
                s.prefix = false;
                s.message_len = 0;
                s.native_notice = null;
            }
            s.dirty = true;
            try s.resizePanes();
            if (s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.items.len == 1) {
                s.dismissName();
                for (s.clients.items) |*cl| if (cl.attached) {
                    try cl.queue(.{ .type = "detach" });
                    cl.attached = false;
                };
            }
        }
        fn undoClose(s: *Server) !void {
            if (remote) {
                if (s.runtime.closed_panes == 0) {
                    s.notice(" No closed panes to restore");
                    return;
                }
                const result = try s.connection.call(.{ .op = "pane.restore", .protocol = 1, .workspace = s.runtime.workspaces.current().id });
                defer result.deinit();
                const id = try protocol.id(result.value, "pane");
                try s.refresh();
                try s.focusPane(id);
                s.copy_mode = false;
                s.notice(" Restored closed pane in a new tab with a fresh shell");
                return;
            }
            if (s.runtime.closed.items.len == 0) {
                s.notice(" No closed panes to restore");
                return;
            }
            const saved = s.runtime.closed.items[s.runtime.closed.items.len - 1];
            const content = try saved.terminal.snapshot();
            defer a.free(content);
            // Validate before consuming history; a deleted directory is recoverable.
            var dir = try std.fs.cwd().openDir(saved.cwd, .{});
            dir.close();
            if (s.runtime.workspaces.index(saved.workspace_id) != null) try s.switchWorkspace(saved.workspace_id);
            const id = try s.create(null, saved.cwd, null, saved.tab.title());
            const term = s.pane(id).?.terminal;
            term.feed(content);
            term.feed("\x1b[0m\r\n[Corgi: restored output; new shell]\r\n");
            _ = s.runtime.closed.pop();
            saved.deinit();
            s.copy_mode = false;
            s.notice(" Restored closed pane in a new tab with a fresh shell");
        }
        fn attention(s: *Server) !void {
            for ([_]agents.Attention{ .needs_input, .finished }) |priority| {
                var best: ?*Pane = null;
                for (s.runtime.panes.items) |*p| if (p.agent.attention == priority) {
                    if (best == null or p.agent.changed_at < best.?.agent.changed_at) best = p;
                };
                if (best) |p| {
                    try s.focusPane(p.id);
                    s.acknowledge();
                    try s.resizePanes();
                    s.dirty = true;
                    return;
                }
            }
            for ([_]agents.Attention{ .needs_input, .finished }) |priority| {
                for (s.runtime.sessions.items) |session| if (session.attention == priority) {
                    if (session.workspace_id != s.runtime.workspaces.current().id) try s.switchWorkspace(session.workspace_id);
                    var msg: [180]u8 = undefined;
                    s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}. Inspect: corgi native events {d}", .{ @tagName(session.provider), session.id, @tagName(session.state), session.id }));
                    s.native_notice = session.id;
                    return;
                };
            }
            s.notice(" Nothing needs your attention");
        }
        pub fn action(s: *Server, name: []const u8, value: []const u8) !void {
            s.followWorkspaceDirectories();
            if (remote and (eq(name, "break") or eq(name, "join"))) {
                if (s.model().count == 0) return error.NoPane;
                const id = s.model().tab().focus;
                var tab: u32 = 0;
                if (eq(name, "join")) {
                    const index = try std.fmt.parseInt(usize, value, 10);
                    if (index == 0 or index > s.model().count) return error.NoTab;
                    tab = s.model().tabs[index - 1].id;
                }
                try s.flushLayout();
                try s.connection.send(.{ .op = "pane.transfer", .protocol = 1, .pane = id, .tab = tab });
                try s.refresh();
                try s.focusPane(id);
                s.dirty = true;
                return;
            }
            s.message_len = 0;
            if (eq(name, "workspace-next") or eq(name, "workspace-prev")) {
                const count = s.runtime.workspaces.items.items.len;
                const index = if (eq(name, "workspace-next")) (s.runtime.workspaces.active + 1) % count else (s.runtime.workspaces.active + count - 1) % count;
                return s.switchWorkspace(s.runtime.workspaces.items.items[index].id);
            } else if (eq(name, "new")) {
                _ = try s.create(null, s.currentCwd(), null, "");
                s.copy_mode = false;
            } else if (eq(name, "sidebar")) {
                s.sidebar_open = !s.sidebar_open;
                s.selection = null;
                s.divider = null;
                try s.resizePanes();
                s.dirty = true;
            } else if (eq(name, "mute")) {
                s.muted = !s.muted;
                s.notice(if (s.muted) " Dings muted; attention markers remain on" else " Dings enabled");
            } else if (eq(name, "undo-close")) return s.undoClose() else if (eq(name, "attention")) return s.attention() else if (s.model().count == 0) return error.NoPane else if (eq(name, "split")) {
                _ = try s.create(if (eq(value, "down")) .vertical else .horizontal, s.currentCwd(), null, "");
            } else if (eq(name, "zoom")) s.model().tab().zoom = !s.model().tab().zoom else if (eq(name, "close")) try s.close(s.model().tab().focus) else if (eq(name, "close-tab")) {
                const tab_id = s.model().tab().id;
                while (s.model().count > 0 and s.model().tab().id == tab_id) try s.close(s.model().tab().focus);
            } else if (eq(name, "next") or eq(name, "prev")) {
                s.model().active = if (eq(name, "next")) (s.model().active + 1) % s.model().count else (s.model().active + s.model().count - 1) % s.model().count;
                s.copy_mode = false;
                s.acknowledge();
            } else if (eq(name, "tab")) {
                const index = try std.fmt.parseInt(usize, value, 10);
                if (index == 0 or index > s.model().count) return error.NoTab;
                s.model().active = index - 1;
                s.copy_mode = false;
                s.acknowledge();
            } else if (eq(name, "rename")) s.model().tab().rename(value) else if (eq(name, "focus") or eq(name, "swap") or eq(name, "resize")) {
                const dir = std.meta.stringToEnum(layout.Direction, value) orelse return error.BadDirection;
                if (eq(name, "resize")) s.model().resize(dir) else if (s.model().neighbor(dir, s.area())) |id| {
                    if (eq(name, "swap")) try s.model().swap(id) else try s.focusPane(id);
                    s.acknowledge();
                }
            } else if (eq(name, "move-tab")) s.model().reorder(if (eq(value, "left")) -1 else 1) else if (eq(name, "break")) {
                s.model().next_id = s.runtime.workspaces.next_pane_id;
                try s.model().breakPane();
                s.runtime.workspaces.next_pane_id = s.model().next_id;
            } else if (eq(name, "join")) {
                const dest = try std.fmt.parseInt(usize, value, 10);
                if (dest == 0) return error.NoTab;
                try s.model().joinPane(dest - 1);
            } else return error.UnknownAction;
            try s.resizePanes();
            s.dirty = true;
        }
        fn scroll(s: *Server, delta: isize) void {
            if (s.focused()) |p| {
                p.terminal.scrollViewport(.{ .delta = delta });
                s.dirty = true;
            }
        }
        fn sendInput(s: *Server, term: *Terminal, bytes: []const u8) !void {
            if (!s.copy_mode and bytes.len > 0 and !term.atBottom()) {
                term.scrollViewport(.bottom);
                try term.clearSelection();
                s.selection = null;
                s.dirty = true;
            }
            try term.send(bytes);
        }
        fn clipboard(s: *Server, cl: *Client) !void {
            const p = s.focused() orelse return;
            const text = try p.terminal.selectedText();
            defer a.free(text);
            const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(text.len));
            defer a.free(encoded);
            _ = std.base64.standard.Encoder.encode(encoded, text);
            const osc = try std.fmt.allocPrint(a, "\x1b]52;c;{s}\x07", .{encoded});
            defer a.free(osc);
            try cl.queue(.{ .type = "frame", .data = osc });
            s.notice(" Viewport copied via OSC 52");
        }
        pub fn key(s: *Server, cl: *Client, byte: u8) !void {
            if (cl.tab_drag) |*drag| {
                drag.cancelled = true;
                s.dirty = true;
            }
            if (s.tab_menu) |context| {
                switch (byte) {
                    27 => s.closeMenu(),
                    13 => try s.tabMenuAction(context.entries()[context.highlighted].key),
                    'j', 9 => s.moveTabMenu(true),
                    'k' => s.moveTabMenu(false),
                    'c' => try s.tabMenuAction('c'),
                    'T', 'r' => try s.tabMenuAction('T'),
                    'X', 'x' => try s.tabMenuAction('X'),
                    2 => s.openMenu(),
                    else => {},
                }
                return;
            }
            if (s.search_mode) {
                if (byte == 27) {
                    s.search_mode = false;
                    s.message_len = 0;
                } else if (byte == 13) {
                    s.search_mode = false;
                    s.search_skip = 0;
                    s.message_len = 0;
                    if (s.focused()) |p| if (!try p.terminal.search(s.search_text[0..s.search_len], 0)) s.notice(" No matches");
                } else if (byte == 127) {
                    s.search_len -|= 1;
                } else if (byte >= 32 and byte < 127 and s.search_len < s.search_text.len) {
                    s.search_text[s.search_len] = byte;
                    s.search_len += 1;
                }
                if (s.search_mode) {
                    s.message[0] = '/';
                    @memcpy(s.message[1 .. s.search_len + 1], s.search_text[0..s.search_len]);
                    s.message_len = s.search_len + 1;
                }
                s.dirty = true;
                return;
            }
            if (s.confirm != .none) {
                const pending = s.confirm;
                const target = s.confirm_tab;
                s.confirm = .none;
                s.confirm_tab = null;
                s.message_len = 0;
                if (byte == 'y' or byte == 'Y') {
                    if (target) |id| s.model().active = s.tabIndex(id) orelse return;
                    try s.action(if (pending == .pane) "close" else "close-tab", "");
                }
                s.dirty = true;
                return;
            }
            if (s.name_dialog) |*dialog| {
                switch (dialog.key(byte)) {
                    .save => s.finishName(true),
                    .cancel => s.finishName(false),
                    .none => {},
                }
                s.dirty = true;
                return;
            }
            if (s.resize_mode) {
                if (direction(byte)) |dir| try s.action("resize", dir) else s.closeMenu();
                return;
            }
            if (s.prefix) {
                s.prefix = false;
                s.dirty = true;
                if (s.model().count == 0) {
                    for (commands.entries) |entry| if (entry.key == byte and entry.needs_pane) return;
                }
                switch (byte) {
                    2 => if (s.focused()) |p| try s.sendInput(p.terminal, &.{2}),
                    'w' => s.beginWorkspace(null),
                    'W' => s.beginWorkspace(s.runtime.workspaces.current().id),
                    '}' => try s.action("workspace-next", ""),
                    '{' => try s.action("workspace-prev", ""),
                    'c' => try s.beginNewTab(),
                    'u' => try s.action("undo-close", ""),
                    'v', '%' => try s.action("split", "right"),
                    '-', '"' => try s.action("split", "down"),
                    'h', 'j', 'k', 'l' => try s.action("focus", direction(byte).?),
                    'H', 'J', 'K', 'L' => try s.action("swap", direction(std.ascii.toLower(byte)).?),
                    'n' => try s.action("next", ""),
                    'p' => try s.action("prev", ""),
                    '1'...'9' => try s.action("tab", &.{byte}),
                    'z' => try s.action("zoom", ""),
                    'a' => try s.action("attention", ""),
                    'b' => try s.action("sidebar", ""),
                    '!' => try s.action("break", ""),
                    'm' => try s.action("mute", ""),
                    'r' => {
                        s.resize_mode = true;
                        s.menu_page = 0;
                        s.menu_highlight = null;
                    },
                    'T', ',' => s.beginRename(),
                    'x' => try s.action("close", ""),
                    'X' => try s.action("close-tab", ""),
                    '[' => {
                        s.copy_mode = true;
                        s.dirty = true;
                    },
                    'q', 'd' => {
                        try cl.queue(.{ .type = "detach" });
                        cl.attached = false;
                        try s.resizeViewers();
                    },
                    '?' => s.openMenu(),
                    else => {},
                }
                return;
            }
            if (byte == 2) {
                s.openMenu();
                return;
            }
            if (s.copy_mode) {
                switch (byte) {
                    'k' => s.scroll(-1),
                    'j' => s.scroll(1),
                    21 => s.scroll(-10),
                    4 => s.scroll(10),
                    'g' => if (s.focused()) |p| {
                        p.terminal.scrollViewport(.top);
                        s.dirty = true;
                    },
                    'G' => if (s.focused()) |p| {
                        p.terminal.scrollViewport(.bottom);
                        s.dirty = true;
                    },
                    'y', 13 => try s.clipboard(cl),
                    '/' => {
                        s.search_mode = true;
                        s.search_len = 0;
                        s.notice("/");
                    },
                    'n', 'N' => if (s.focused()) |p| {
                        if (byte == 'n') s.search_skip += 1 else s.search_skip -|= 1;
                        if (!try p.terminal.search(s.search_text[0..s.search_len], s.search_skip)) {
                            s.search_skip = 0;
                            _ = try p.terminal.search(s.search_text[0..s.search_len], 0);
                        }
                        s.dirty = true;
                    },
                    'q', 27 => {
                        s.copy_mode = false;
                        if (s.focused()) |p| {
                            p.terminal.scrollViewport(.bottom);
                            try p.terminal.clearSelection();
                        }
                        s.dirty = true;
                    },
                    else => {},
                }
                return;
            }
            if (s.focused()) |p| {
                try s.sendInput(p.terminal, &.{byte});
                p.agent.acknowledge();
            }
        }
        pub fn input(s: *Server, cl: *Client, data: []const u8) !void {
            try cl.keybuf.appendSlice(a, data);
            var used: usize = 0;
            while (used < cl.keybuf.items.len) {
                if (!cl.attached) {
                    cl.keybuf.clearRetainingCapacity();
                    return;
                }
                const rest = cl.keybuf.items[used..];
                if (rest[0] != 27) {
                    if (cl.paste) {
                        if (cl.paste_to_name and s.name_dialog != null) {
                            if (rest[0] >= 32 and rest[0] < 127) try s.key(cl, rest[0]);
                        } else if (cl.paste_pane) |id| {
                            if (s.pane(id)) |p| try s.sendInput(p.terminal, rest[0..1]);
                        }
                    } else try s.key(cl, rest[0]);
                    used += 1;
                    continue;
                }
                if (rest.len < 2) break;
                if (!cl.paste and rest[1] != '[' and rest[1] != 'O' and (s.hasMenu() or s.name_dialog != null or s.confirm != .none)) {
                    try s.key(cl, 27);
                    used += 1;
                    continue;
                }
                var len: usize = 2;
                if (rest[1] == '[' or rest[1] == 'O') {
                    while (len < rest.len and !(rest[len] >= 0x40 and rest[len] <= 0x7e)) : (len += 1) {}
                    if (len == rest.len) break;
                    len += 1;
                }
                var seq = rest[0..len];
                var encoded: std.Io.Writer.Allocating = .init(a);
                defer encoded.deinit();
                if (!cl.paste) {
                    if (keyboard.decode(seq)) |key_event| {
                        // Resolve Corgi shortcuts before encoding for the child. A
                        // Kitty Ctrl-B is otherwise invisible to the byte handlers.
                        try key_event.encode(&encoded.writer, .{});
                        const legacy = encoded.written();
                        const owned = s.hasMenu() or s.name_dialog != null or s.confirm != .none or s.copy_mode or s.search_mode;
                        if (owned or (legacy.len == 1 and legacy[0] == 2)) {
                            seq = legacy;
                        } else if (s.focused()) |p| {
                            encoded.clearRetainingCapacity();
                            try key_event.encode(&encoded.writer, @import("terminal.zig").vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.emulator().*));
                            seq = encoded.written();
                        }
                        if (seq.len == 0) {
                            used += len;
                            continue;
                        }
                        if (seq.len == 1) {
                            try s.key(cl, seq[0]);
                            used += len;
                            continue;
                        }
                    }
                }
                if (eq(seq, "\x1b[200~") or eq(seq, "\x1b[201~")) {
                    cl.paste = eq(seq, "\x1b[200~");
                    if (cl.paste) {
                        cl.paste_pane = if (!s.hasMenu() and s.name_dialog == null and s.confirm == .none) (if (s.focused()) |p| p.id else null) else null;
                        cl.paste_to_name = s.name_dialog != null;
                    }
                    if (cl.paste_pane) |id| {
                        if (s.pane(id)) |p| if (p.terminal.emulator().*.modes.get(.bracketed_paste)) try s.sendInput(p.terminal, seq);
                    }
                } else if (cl.paste) {
                    if (cl.paste_pane) |id| {
                        if (s.pane(id)) |p| try s.sendInput(p.terminal, seq);
                    }
                } else if (eq(seq, "\x1b[I")) {
                    cl.watched = true;
                    s.acknowledge();
                } else if (eq(seq, "\x1b[O")) cl.watched = false else if (std.mem.startsWith(u8, seq, "\x1b[<")) try s.mouse(cl, seq) else if (s.tab_menu != null) {
                    if (eq(seq, "\x1b[A") or eq(seq, "\x1bOA")) s.moveTabMenu(false) else if (eq(seq, "\x1b[B") or eq(seq, "\x1bOB")) s.moveTabMenu(true);
                } else if (s.menu() != null) {
                    if (eq(seq, "\x1b[5~")) s.pageMenu(false) else if (eq(seq, "\x1b[6~")) s.pageMenu(true);
                } else if (s.name_dialog) |*dialog| {
                    dialog.sequence(seq);
                    s.dirty = true;
                } else if (s.confirm != .none) {
                    // Dialog keys belong to Corgi, never to the shell beneath it.
                } else if (s.copy_mode and eq(seq, "\x1b[5~")) s.scroll(-20) else if (s.copy_mode and eq(seq, "\x1b[6~")) s.scroll(20) else if (s.focused()) |p| try s.sendInput(p.terminal, seq);
                used += len;
            }
            std.mem.copyForwards(u8, cl.keybuf.items[0 .. cl.keybuf.items.len - used], cl.keybuf.items[used..]);
            cl.keybuf.items.len -= used;
            cl.escape_at = std.time.milliTimestamp();
            if (cl.keybuf.items.len > 256) {
                cl.keybuf.clearRetainingCapacity();
                return error.InvalidInput;
            }
        }
        fn validTabDrag(s: *Server, drag: *TabDrag) bool {
            const tabs_x = s.sidebarView(0).tabX();
            const m = s.model();
            if (drag.workspace_id != s.runtime.workspaces.current().id or drag.width != s.width or
                drag.tabs_x != tabs_x or drag.count != m.count or
                drag.first != render.tabStart(m, s.width - tabs_x -| 3) or
                s.hasMenu() or s.name_dialog != null or s.confirm != .none)
                drag.cancelled = true;
            for (m.tabs[0..m.count], 0..) |tab, i| {
                if (i >= drag.count or drag.ids[i] != tab.id) drag.cancelled = true;
            }
            return !drag.cancelled;
        }
        pub fn tabDropX(s: *Server) ?u16 {
            for (s.clients.items) |*cl| {
                if (!cl.attached or cl.dead) continue;
                if (cl.tab_drag) |*drag| {
                    if (s.validTabDrag(drag) and drag.dragging) if (drag.drop) |drop| return drop.x;
                }
            }
            return null;
        }
        fn mouse(s: *Server, cl: *Client, seq: []const u8) !void {
            var fields = std.mem.splitScalar(u8, seq[3 .. seq.len - 1], ';');
            const button = std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return;
            const x = (std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return) -| 1;
            const y = (std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return) -| 1;
            const release = seq[seq.len - 1] == 'm';
            if (cl.tab_drag) |*drag| {
                const valid = s.validTabDrag(drag);
                const drop = if (valid and y == 0 and x >= drag.tabs_x)
                    render.tabDrop(s.model(), s.width - drag.tabs_x, x - drag.tabs_x)
                else
                    null;
                if (button == 32 and !release) {
                    if (drop != null and x != drag.start_x) drag.dragging = true;
                    drag.drop = drop;
                }
                if (release and button & 3 == 0) {
                    if (valid and drag.dragging) if (drop) |target| s.model().moveTab(drag.tab_id, target.index);
                    cl.tab_drag = null;
                }
                // The tab owns this gesture, including motion/release over a pane.
                s.dirty = true;
                return;
            }
            if (!release and (x >= s.width or y >= s.height)) return;
            const tabs_x = s.sidebarView(0).tabX();
            const tabs_width = s.width - tabs_x;
            if (s.ui_mouse_down) {
                if (release) s.ui_mouse_down = false;
                return;
            }
            if (!release and button == 2 and y == 0 and s.name_dialog == null and s.confirm == .none) {
                if (x >= tabs_x) if (render.tabAt(s.model(), tabs_width, x - tabs_x)) |index| {
                    s.ui_mouse_down = true;
                    s.openTabMenu(index, x);
                    return;
                };
            }
            if (s.tab_menu) |context| {
                if (!release and (button == 64 or button == 65)) s.moveTabMenu(button == 65);
                if (!release and button == 0) {
                    s.ui_mouse_down = true;
                    if (context.hit(s.width, s.height, x, y)) |index| try s.tabMenuAction(context.entries()[index].key) else s.closeMenu();
                } else if (!release and (button == 35 or button == 32)) {
                    if (context.hit(s.width, s.height, x, y)) |index| {
                        s.tab_menu.?.highlighted = index;
                        s.dirty = true;
                    }
                }
                return;
            }
            if (s.menu()) |view| {
                if (!release and (button == 35 or button == 32)) {
                    const highlighted: ?u8 = switch (view.hit(x, y)) {
                        .command => |entry| entry.key,
                        else => null,
                    };
                    if (s.menu_highlight != highlighted) {
                        s.menu_highlight = highlighted;
                        s.dirty = true;
                    }
                }
                if (!release and (button == 64 or button == 65)) s.pageMenu(button == 65);
                if (!release and button == 0) {
                    s.ui_mouse_down = true;
                    switch (view.hit(x, y)) {
                        .close => s.closeMenu(),
                        .previous => s.pageMenu(false),
                        .next => s.pageMenu(true),
                        .command => |entry| try s.key(cl, entry.key),
                        .none => {},
                    }
                }
                return;
            }
            if (s.name_dialog) |*dialog| {
                if (!release and button == 0) {
                    s.ui_mouse_down = true;
                    const view = naming.View.init(s.width, s.height, dialog.*);
                    switch (view.hit(x, y)) {
                        .save => s.finishName(true),
                        .cancel => s.finishName(false),
                        .clear => dialog.clear(),
                        .field => |column| dialog.position(dialog.byteAtColumn(view.offset, column - view.offset)),
                        .none => {},
                    }
                    s.dirty = true;
                }
                return;
            }
            if (s.confirm != .none) {
                if (!release and button == 0) {
                    s.ui_mouse_down = true;
                    try s.key(cl, if (y == s.height - 1 and x < 10) 'y' else 'n');
                }
                return;
            }
            if (release and s.divider != null) {
                s.divider = null;
                return;
            }
            if (button == 32 and s.divider != null) {
                s.model().dragDivider(s.divider.?, x, y);
                try s.resizePanes();
                s.dirty = true;
                return;
            }
            var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
            const entries = s.agentEntries(&agent_storage);
            const side = s.sidebarView(entries.len);
            if ((side.width > 0 and x < side.width and y < s.height - 1) or (y == 0 and x < tabs_x)) {
                if (!release and (button == 64 or button == 65)) {
                    if (y < side.middle()) {
                        s.workspace_offset = if (button == 64) side.workspace_offset -| 1 else @min(side.workspace_offset + 1, s.runtime.workspaces.items.items.len -| side.workspaceCapacity());
                    } else s.sidebar_offset = if (button == 64) side.offset -| 1 else @min(side.offset + 1, entries.len -| side.capacity);
                    s.dirty = true;
                } else if (!release and (button == 0 or button == 2)) {
                    s.ui_mouse_down = true;
                    switch (side.hit(x, y)) {
                        .toggle => try s.action("sidebar", ""),
                        .previous => s.sidebar_offset = side.offset -| side.capacity,
                        .next => s.sidebar_offset = @min(side.offset + side.capacity, entries.len -| side.capacity),
                        .entry => |index| try s.selectAgent(entries[index].target),
                        .workspace_new => s.beginWorkspace(null),
                        .workspace_previous => s.workspace_offset = side.workspace_offset -| side.workspaceCapacity(),
                        .workspace_next => s.workspace_offset = @min(side.workspace_offset + side.workspaceCapacity(), s.runtime.workspaces.items.items.len -| side.workspaceCapacity()),
                        .workspace => |index| if (button == 2) {
                            s.closeMenu();
                            s.search_mode = false;
                            s.divider = null;
                            s.selection = null;
                            s.tab_menu = .{ .tab = s.runtime.workspaces.items.items[index].id, .workspace = true, .anchor_x = x, .anchor_y = y };
                        } else try s.switchWorkspace(s.runtime.workspaces.items.items[index].id),
                        .none => {},
                    }
                    s.dirty = true;
                }
                return;
            }
            if (y == 0 and button == 0 and !release) {
                const add_x = tabs_x + render.addTabX(s.model(), tabs_width);
                if (x >= add_x and x < add_x + 3) {
                    s.ui_mouse_down = true;
                    try s.beginNewTab();
                    return;
                }
                if (x >= tabs_x) if (render.tabAt(s.model(), tabs_width, x - tabs_x)) |index| {
                    s.model().active = index;
                    cl.tab_drag = .{
                        .workspace_id = s.runtime.workspaces.current().id,
                        .tab_id = s.model().tabs[index].id,
                        .start_x = x,
                        .width = s.width,
                        .tabs_x = tabs_x,
                        .first = render.tabStart(s.model(), tabs_width -| 3),
                        .count = s.model().count,
                    };
                    for (s.model().tabs[0..s.model().count], 0..) |tab, i| cl.tab_drag.?.ids[i] = tab.id;
                    s.acknowledge();
                    try s.resizePanes();
                    s.dirty = true;
                };
                return;
            }
            if (button & 32 != 0 and button & 3 == 3) return;
            var locations: [layout.max_panes]layout.Placement = undefined;
            for (s.model().placements(s.area(), &locations)) |p| if (p.rect.contains(x, y)) {
                try s.focusPane(p.id);
                s.acknowledge();
                s.dirty = true;
                const term = s.pane(p.id).?.terminal;
                if (term.emulator().*.flags.mouse_event != .none and !s.copy_mode and button & 4 == 0) {
                    // Translate coordinates through Ghostty's input encoder into the app's chosen protocol.
                    const vt = @import("terminal.zig").vt;
                    var encoded: std.Io.Writer.Allocating = .init(a);
                    defer encoded.deinit();
                    var opts = vt.input.MouseEncodeOptions.fromTerminal(&term.emulator().*, .{
                        .screen = .{ .width = term.emulator().*.cols, .height = term.emulator().*.rows },
                        .cell = .{ .width = 1, .height = 1 },
                        .padding = .{},
                    });
                    opts.any_button_pressed = !release and button & 3 != 3;
                    const btn: ?vt.input.MouseButton = switch (button & 0xc3) {
                        0 => .left,
                        1 => .middle,
                        2 => .right,
                        64 => .four,
                        65 => .five,
                        66 => .six,
                        67 => .seven,
                        else => null,
                    };
                    try vt.input.encodeMouse(&encoded.writer, .{
                        .action = if (release) .release else if (button & 32 != 0) .motion else .press,
                        .button = btn,
                        .mods = .{ .shift = button & 4 != 0, .alt = button & 8 != 0, .ctrl = button & 16 != 0 },
                        .pos = .{ .x = @floatFromInt(x - p.rect.x), .y = @floatFromInt(y - p.rect.y) },
                    }, opts);
                    try term.send(encoded.written());
                    return;
                }
                if (release) {
                    if (s.selection) |sel| if (sel.moved) try s.clipboard(cl);
                    s.selection = null;
                    return;
                }
                // Wheel events are a separate button class, including horizontal
                // scrolling and modifiers. They must never fall through to clicks.
                if (button & 64 != 0) {
                    switch (button & 0xc3) {
                        64 => s.scroll(-3),
                        65 => s.scroll(3),
                        else => {}, // No horizontal viewport scrolling.
                    }
                    return;
                }
                if (button & 0xe3 == 2) {
                    s.ui_mouse_down = true;
                    s.openMenu();
                    return;
                }
                const px = x - p.rect.x;
                const py = y - p.rect.y;
                if (button & 32 != 0) {
                    if (s.selection) |*sel| if (sel.pane == p.id) {
                        sel.moved = true;
                        try term.select(sel.x, sel.y, px, py);
                    };
                } else if (button & 3 == 0) {
                    s.selection = .{ .pane = p.id, .x = px, .y = py };
                    try term.clearSelection();
                }
                return;
            };
            if (release) {
                s.selection = null;
                return;
            }
            if (button == 0) s.divider = s.model().dividerAt(s.area(), x, y);
        }

        fn paneWatched(s: *Server, id: u32) bool {
            for (s.clients.items) |cl| if (cl.viewer and !cl.dead and cl.watched and cl.view_focus == id and std.time.milliTimestamp() - cl.touched < 1000) return true;
            return s.isWatched() and s.model().count > 0 and s.model().tab().focus == id and s.hasClient();
        }
        pub fn refresh(s: *Server) !void {
            const reply = try s.connection.call(.{ .op = "session.snapshot", .protocol = 1 });
            defer reply.deinit();
            const parsed = try std.json.parseFromValue(protocol.Snapshot, a, reply.value, .{ .ignore_unknown_fields = true });
            defer parsed.deinit();
            try s.receiveSnapshot(parsed.value);
        }
        pub fn receiveSnapshot(s: *Server, snapshot: protocol.Snapshot) !void {
            const previous_focus = if (s.runtime.workspaces.items.items.len > 0) if (s.focused()) |p| p.id else 0 else 0;
            const previous_token = if (s.runtime.workspaces.items.items.len > 0) try protocol.layoutToken(s.model()) else 0;
            try s.runtime.receive(s.connection, snapshot);
            if (previous_token != try protocol.layoutToken(s.model())) s.divider = null;
            if (previous_focus != 0 and s.pane(previous_focus) == null) {
                s.copy_mode = false;
                s.search_mode = false;
                s.selection = null;
                s.message_len = 0;
                s.native_notice = null;
            }
            s.followWorkspaceDirectories();
            s.reconcile();
        }
        pub fn reconcile(s: *Server) void {
            if (s.tab_menu) |context| if (if (context.workspace) s.runtime.workspaces.index(context.tab) == null else s.tabIndex(context.tab) == null) {
                s.tab_menu = null;
            };
            if (s.confirm_tab) |id| if (s.tabIndex(id) == null) {
                s.confirm = .none;
                s.confirm_tab = null;
                s.message_len = 0;
            };
            if (s.selection) |selection| if (s.pane(selection.pane) == null) {
                s.selection = null;
            };
            if (s.name_dialog) |dialog| if (dialog.target == .rename and s.tabIndex(dialog.target.rename) == null) s.dismissName();
            s.dirty = true;
        }
        pub fn flushLayout(s: *Server) !void {
            if (!remote) return;
            for (s.runtime.workspaces.items.items, 0..) |*ws, index| {
                const token = try protocol.layoutToken(&ws.model);
                if (token == s.runtime.tokens[index]) continue;
                var arena = std.heap.ArenaAllocator.init(a);
                defer arena.deinit();
                s.connection.send(.{ .op = "layout.apply", .protocol = 1, .workspace = ws.id, .token = s.runtime.tokens[index], .tabs = try protocol.encodeTabs(arena.allocator(), &ws.model) }) catch |err| {
                    try s.refresh();
                    return err;
                };
                s.runtime.tokens[index] = token;
            }
        }

        fn queueSession(s: *Server, cl: *Client) !void {
            var arena = std.heap.ArenaAllocator.init(a);
            defer arena.deinit();
            try cl.queue(try protocol.snapshot(arena.allocator(), &s.runtime));
            cl.snapshot_revision = s.runtime.revision;
            cl.last_snapshot = std.time.milliTimestamp();
        }

        fn runtimeRequest(s: *Server, cl: *Client, v: std.json.Value) !bool {
            const op = agents.str(v, "op");
            if (eq(op, "hello")) {
                try protocol.require(v, null);
                cl.protocol_version = protocol.version;
                try cl.queue(.{ .type = "hello", .protocol = protocol.version, .capabilities = protocol.capabilities, .server_pid = c.getpid(), .build_id = &@import("main.zig").build_id });
                return true;
            }
            var known = false;
            for (protocol.capabilities) |name| if (eq(op, name)) {
                known = true;
                break;
            };
            if (!known) return false;
            try protocol.require(v, cl.protocol_version);
            if (eq(op, "session.snapshot") or eq(op, "session.subscribe")) {
                if (eq(op, "session.subscribe") and cl.attached) return error.AlreadyAttached;
                try s.queueSession(cl);
                if (eq(op, "session.subscribe")) cl.subscribed = true;
            } else if (eq(op, "pane.surface")) {
                const id = try protocol.id(v, "pane");
                const p = s.pane(id) orelse return error.NoPane;
                var arena = std.heap.ArenaAllocator.init(a);
                defer arena.deinit();
                const surface = try @import("surface.zig").capture(arena.allocator(), id, p.terminal);
                try cl.queue(.{ .type = "surface", .protocol = protocol.version, .server_pid = c.getpid(), .revision = s.runtime.revision, .surface = surface });
            } else if (eq(op, "pane.input")) {
                const id = try protocol.id(v, "pane");
                const p = s.pane(id) orelse return error.NoPane;
                const data = v.object.get("data") orelse return error.MissingInput;
                if (data != .string) return error.InvalidInput;
                try p.terminal.send(data.string);
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "pane.create") or eq(op, "pane.split")) {
                const split = eq(op, "pane.split");
                const target = if (split) try protocol.id(v, "pane") else 0;
                const ws = if (split) s.runtime.workspaces.owner(target) orelse return error.NoPane else try s.runtime.getWorkspace(try protocol.id(v, "workspace"));
                const axis: layout.Axis = if (!split or eq(agents.str(v, "axis"), "right")) .horizontal else if (eq(agents.str(v, "axis"), "down")) .vertical else return error.BadAxis;
                const cwd = agents.str(v, "cwd");
                const command = agents.str(v, "command");
                const id = try s.runtime.create(.{
                    .workspace = ws.id,
                    .split = if (split) .{ .pane = target, .axis = axis } else null,
                    .cwd = if (cwd.len > 0) cwd else s.inheritedCwd(ws, if (split) target else null),
                    .command = if (command.len > 0) command else null,
                    .title = agents.str(v, "title"),
                    .cols = s.area().w,
                    .rows = s.area().h,
                    .theme = s.theme,
                    .socket = s.socket,
                    .executable = s.executable,
                });
                try s.resizePaneTab(id);
                s.dirty = true;
                try cl.queue(.{ .ok = true, .pane = id });
            } else if (eq(op, "pane.close")) {
                try s.close(try protocol.id(v, "pane"));
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "tab.rename")) {
                try s.runtime.renameTab(try protocol.id(v, "tab"), agents.str(v, "title"));
                s.dirty = true;
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "split.resize")) {
                const dir = std.meta.stringToEnum(layout.Direction, agents.str(v, "direction")) orelse return error.BadDirection;
                const id = try protocol.id(v, "pane");
                try s.runtime.resizeSplit(id, dir);
                try s.resizePaneTab(id);
                s.dirty = true;
                try cl.queue(.{ .ok = true });
            }
            return true;
        }

        fn request(s: *Server, cl: *Client, v: std.json.Value) !void {
            if (v != .object) return error.UnknownOperation;
            const operation = agents.str(v, "op");
            if (eq(operation, "server.reload")) {
                try protocol.require(v, cl.protocol_version);
                if (s.reload_executable != null) return error.ReloadInProgress;
                const executable = agents.str(v, "executable");
                if (!std.fs.path.isAbsolute(executable)) return error.InvalidExecutable;
                s.reload_executable = try a.dupe(u8, executable);
                s.reload_requester = cl.fd;
                return;
            }
            if (eq(operation, "recovery.save")) {
                try protocol.require(v, cl.protocol_version);
                try @import("recovery.zig").save(&s.runtime, s.socket);
                const path = try @import("recovery.zig").path(s.socket);
                defer a.free(path);
                try cl.queue(.{ .ok = true, .path = path });
                return;
            }
            if (try @import("viewer_protocol.zig").handle(s, cl, v)) return;
            if (try @import("viewer_protocol.zig").routeControl(s, cl, v)) return;
            if (try s.runtimeRequest(cl, v)) return;
            const op = agents.str(v, "op");
            if (eq(op, "workspace.list")) {
                const Info = struct { id: u32, name: []const u8, cwd: []const u8, active: bool, tabs: usize };
                var info: [workspace.max_workspaces]Info = undefined;
                for (s.runtime.workspaces.items.items, 0..) |*ws, i| info[i] = .{ .id = ws.id, .name = ws.name(), .cwd = ws.cwd, .active = i == s.runtime.workspaces.active, .tabs = ws.model.count };
                try cl.queue(.{ .ok = true, .workspaces = info[0..s.runtime.workspaces.items.items.len] });
            } else if (eq(op, "workspace.new")) {
                const cwd = agents.str(v, "cwd");
                // Store.add resolves the folder before appending to the store.
                const id = try s.newWorkspace(agents.str(v, "name"), if (cwd.len == 0) s.currentCwd() else cwd);
                try cl.queue(.{ .ok = true, .workspace = id });
            } else if (eq(op, "workspace.switch") or eq(op, "workspace.edit") or eq(op, "workspace.close")) {
                const id = std.math.cast(u32, number(v, "workspace", 0)) orelse return error.NoWorkspace;
                const index = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
                if (eq(op, "workspace.switch")) try s.switchWorkspace(id) else if (eq(op, "workspace.edit")) {
                    const ws = &s.runtime.workspaces.items.items[index];
                    const name = agents.str(v, "name");
                    const cwd = agents.str(v, "cwd");
                    try s.runtime.workspaces.edit(id, if (v.object.get("name") == null) ws.customName() else name, if (cwd.len == 0) ws.cwd else cwd);
                    s.followWorkspaceDirectories();
                    if (id == 1) s.default_folder_pending = false;
                    s.saveWorkspaces();
                    s.dirty = true;
                } else {
                    try s.closeWorkspace(id, if (v.object.get("close_contents")) |value| value == .bool and value.bool else false);
                }
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "native.start")) {
                if (s.runtime.sessions.items.len >= 16) return error.TooManyNativeSessions;
                const provider = std.meta.stringToEnum(agents.Provider, agents.str(v, "provider")) orelse return error.BadProvider;
                const cwd = agents.str(v, "cwd");
                try s.runtime.sessions.ensureUnusedCapacity(a, 1);
                var session = try native.Session.start(s.runtime.next_session, provider, if (cwd.len > 0) cwd else s.currentCwd());
                session.workspace_id = s.runtime.workspaces.current().id;
                s.runtime.sessions.appendAssumeCapacity(session);
                s.runtime.next_session += 1;
                s.dirty = true;
                try cl.queue(.{ .ok = true, .session = session.id, .provider = provider });
            } else if (eq(op, "native.list")) {
                const Info = struct { id: u32, pid: i32, session_id: []const u8, provider: agents.Provider, ready: bool, exited: bool, state: agents.State, attention: agents.Attention, observation: agents.observation.State, unread: bool, pending_requests: usize, active_tools: usize, next_seq: u64 };
                var info: std.ArrayList(Info) = .empty;
                defer info.deinit(a);
                for (s.runtime.sessions.items) |session| try info.append(a, .{ .id = session.id, .pid = session.child.id, .session_id = session.resume_hint.session[0..session.resume_hint.len], .provider = session.provider, .ready = session.ready, .exited = session.exited, .state = session.state, .attention = session.attention, .observation = session.observation, .unread = session.observation.unread(), .pending_requests = session.approvals.items.len, .active_tools = session.active_tools.items.len, .next_seq = session.next_seq });
                try cl.queue(.{ .ok = true, .sessions = info.items });
            } else if (std.mem.startsWith(u8, op, "native.")) {
                const id = std.math.cast(u32, number(v, "session", 0)) orelse return error.NoNativeSession;
                for (s.runtime.sessions.items, 0..) |*session, index| if (session.id == id) {
                    s.dirty = true;
                    if (s.native_notice == id) {
                        s.native_notice = null;
                        s.message_len = 0;
                    }
                    if (eq(op, "native.stop")) {
                        session.destroy();
                        _ = s.runtime.sessions.orderedRemove(index);
                        try cl.queue(.{ .ok = true });
                    } else if (eq(op, "native.send")) {
                        try session.send(v.object.get("message") orelse return error.InvalidMessage);
                        try cl.queue(.{ .ok = true });
                    } else if (eq(op, "native.events")) {
                        const after = std.math.cast(u64, number(v, "after", 0)) orelse 0;
                        var events: std.ArrayList(native.Event) = .empty;
                        defer events.deinit(a);
                        for (session.events.items) |event| if (event.seq > after) try events.append(a, event);
                        try cl.queue(.{ .ok = true, .events = events.items, .pending_requests = session.approvals.items, .next_seq = session.next_seq, .first_seq = if (session.events.items.len > 0) session.events.items[0].seq else session.next_seq });
                        session.observation.acknowledge(session.observation.completed);
                        session.attention = .none;
                    } else return error.UnknownOperation;
                    return;
                };
                return error.NoNativeSession;
            } else if (eq(op, "theme")) {
                if (!cl.attached and !cl.viewer) return error.NotAttached;
                for (s.clients.items) |viewer| if ((viewer.attached or viewer.viewer) and !viewer.dead) {
                    if (viewer.fd == cl.fd) s.updateTheme(v);
                    break;
                };
                if (cl.viewer) try cl.queue(.{ .ok = true });
            } else if (eq(op, "attach")) {
                if (cl.subscribed) return error.AlreadySubscribed;
                const first = !s.hasClient();
                cl.attached = true;
                cl.watched = true;
                cl.width = @intCast(std.math.clamp(number(v, "cols", 100), 10, 500));
                cl.height = @intCast(std.math.clamp(number(v, "rows", 30), 4, 200));
                cl.keybuf.clearRetainingCapacity();
                cl.paste = false;
                cl.paste_pane = null;
                cl.paste_to_name = false;
                if (first) {
                    s.prefix = false;
                    s.tab_menu = null;
                    s.ui_mouse_down = false;
                    s.copy_mode = false;
                    s.dismissName();
                    s.resize_mode = false;
                    s.confirm = .none;
                    s.confirm_tab = null;
                    s.updateTheme(v);
                }
                try s.resizeViewers();
                if (s.model().count == 0) _ = try s.create(null, if (s.default_folder_pending) agents.str(v, "cwd") else s.runtime.workspaces.current().cwd, null, "");
                s.acknowledge();
                cl.needs_frame = true;
                try cl.queue(.{ .type = "attached" });
            } else if (eq(op, "size")) {
                if (!cl.attached) return error.NotAttached;
                cl.width = @intCast(std.math.clamp(number(v, "cols", 100), 10, 500));
                cl.height = @intCast(std.math.clamp(number(v, "rows", 30), 4, 200));
                try s.resizeViewers();
                cl.needs_frame = true;
            } else if (eq(op, "input")) {
                if (!cl.attached) return error.NotAttached;
                try s.input(cl, agents.str(v, "data"));
            } else if (eq(op, "action")) {
                try s.action(agents.str(v, "name"), agents.str(v, "value"));
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "new") or eq(op, "split")) {
                const cwd = agents.str(v, "cwd");
                const cmd = agents.str(v, "command");
                const id = try s.create(if (eq(op, "new")) null else if (eq(agents.str(v, "axis"), "down")) .vertical else .horizontal, if (cwd.len == 0) s.currentCwd() else cwd, if (cmd.len == 0) null else cmd, agents.str(v, "title"));
                try cl.queue(.{ .ok = true, .pane = id });
            } else if (eq(op, "list")) {
                const Info = struct { id: u32, workspace: u32, tab: u32, focused: bool, provider: agents.Provider, state: agents.State, attention: agents.Attention, session: []const u8, activity: []const u8, recent_activity: []const u8, unread: bool, completed: u64, read: u64, pending_stop: bool, source: agents.observation.Source, cwd: []const u8, exited: bool };
                var items: std.ArrayList(Info) = .empty;
                defer items.deinit(a);
                for (s.runtime.panes.items) |*p| {
                    const owner = s.runtime.workspaces.owner(p.id) orelse continue;
                    var copy = owner.model;
                    try copy.focus(p.id);
                    try items.append(a, .{ .id = p.id, .workspace = owner.id, .tab = copy.tab().id, .focused = s.model().count > 0 and s.model().tab().focus == p.id, .provider = p.agent.provider, .state = p.agent.state, .attention = p.agent.attention, .session = p.agent.sessionId(), .activity = p.agent.label(), .recent_activity = p.agent.recentLabel(), .unread = p.agent.observation.unread(), .completed = p.agent.observation.completed, .read = p.agent.observation.read, .pending_stop = p.agent.observation.pending_stop, .source = p.agent.observation.source, .cwd = p.cwd, .exited = p.terminal.exited });
                }
                try cl.queue(.{ .ok = true, .panes = items.items, .tabs = s.model().count, .closed_panes = s.runtime.closed.items.len, .muted = s.muted });
            } else if (eq(op, "focus") or eq(op, "close") or eq(op, "read") or eq(op, "send") or eq(op, "hook")) {
                const id = std.math.cast(u32, number(v, "pane", 0)) orelse return error.NoPane;
                const p = s.pane(id) orelse return error.NoPane;
                if (eq(op, "focus")) {
                    try s.focusPane(id);
                    s.acknowledge();
                    try s.resizePanes();
                    s.dirty = true;
                } else if (eq(op, "close")) try s.close(id) else if (eq(op, "read")) {
                    const text = try p.terminal.text();
                    defer a.free(text);
                    try cl.queue(.{ .ok = true, .text = text });
                    return;
                } else if (eq(op, "send")) {
                    try p.terminal.send(agents.str(v, "text"));
                    if (boolean(v, "enter")) try p.terminal.send("\r");
                } else {
                    const provider = std.meta.stringToEnum(agents.Provider, agents.str(v, "provider")) orelse return error.BadProvider;
                    const event = v.object.get("event") orelse return error.NoEvent;
                    // Bind a newly launched foreground process before applying its
                    // first hook, including back-to-back launches in the same pane.
                    s.detectPane(p);
                    const viewed = s.paneWatched(id);
                    const ding = p.agent.apply(provider, event, number(v, "seq", std.time.microTimestamp()), viewed);
                    if (ding) {
                        s.bell = true;
                        if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
                    }
                    s.dirty = true;
                }
                try cl.queue(.{ .ok = true });
            } else if (eq(op, "ping")) try cl.queue(.{ .ok = true, .version = "0.1.0" }) else if (eq(op, "shutdown")) {
                s.quit = true;
                try cl.queue(.{ .ok = true });
            } else return error.UnknownOperation;
        }
        pub fn updateTheme(s: *Server, v: std.json.Value) void {
            const value = v.object.get("theme") orelse return;
            s.theme.merge(Theme.fromJson(value));
            for (s.runtime.panes.items) |p| if (remote) s.theme.apply(p.terminal.emulator()) else p.terminal.applyTheme(s.theme);
            s.dirty = true;
        }
        pub fn resizeViewers(s: *Server) !void {
            if (remote) return;
            var width: u16 = 500;
            var height: u16 = 200;
            var found = false;
            for (s.clients.items) |cl| if (cl.attached and !cl.dead) {
                width = @min(width, cl.width);
                height = @min(height, cl.height);
                found = true;
            };
            if (!found or (width == s.width and height == s.height)) {
                try @import("viewer_protocol.zig").resize(s);
                return;
            }
            s.width = width;
            s.height = height;
            s.revealWorkspace();
            try s.resizePanes();
            try @import("viewer_protocol.zig").resize(s);
            s.dirty = true;
        }
        fn isWatched(s: *Server) bool {
            for (s.clients.items) |cl| if (cl.attached and !cl.dead and cl.watched) return true;
            return false;
        }
        fn framePending(s: *Server) bool {
            for (s.clients.items) |cl| if (cl.attached and !cl.dead and cl.needs_frame and cl.output.items.len == 0) return true;
            return false;
        }
        fn hasClient(s: *Server) bool {
            for (s.clients.items) |cl| if (cl.attached and !cl.dead) return true;
            return false;
        }
        fn detectPane(s: *Server, p: *Pane) void {
            const detection = @import("detection.zig");
            const job = detection.foreground(p.terminal.fd);
            const before = p.agent;
            const previous_pid = p.detection.pid;
            // A disconnected observer must not permanently suppress the
            // existing screen fallback with an old authoritative timestamp.
            if (p.agent.provider == .codex and p.agent.observation.source == .protocol and std.time.microTimestamp() - p.agent.last_seq > 5 * std.time.us_per_s) {
                p.agent.last_seq = 0;
                p.agent.observation.source = .unknown;
            }
            p.resume_hint.observe(&p.agent);
            const live_screen = p.terminal.emulator().*.screens.active.pages.viewport == .active;
            const text = if (job != null and p.agent.last_seq == 0 and live_screen) p.terminal.text() catch null else null;
            defer if (text) |bytes| a.free(bytes);
            const watched = s.paneWatched(p.id);
            const ding = p.detection.update(&p.agent, job, p.terminal.emulator().*.getTitle() orelse "", text orelse "", watched);
            if (job) |current| if (current.pid != previous_pid and p.agent.session_len == 0) {
                p.resume_hint = .{ .provider = current.provider };
            };
            p.resume_hint.observe(&p.agent);
            // A quiet agent can change directory without writing to the PTY.
            const previous_cwd = std.hash.Wyhash.hash(0, p.cwd);
            p.refreshCwd();
            if (previous_cwd != std.hash.Wyhash.hash(0, p.cwd)) s.dirty = true;
            if (!std.meta.eql(before, p.agent)) s.dirty = true;
            if (ding) {
                s.bell = true;
                if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
            }
        }
        pub fn expireInput(s: *Server) !void {
            for (s.clients.items) |*cl| if (cl.attached and cl.keybuf.items.len > 0 and std.time.milliTimestamp() - cl.escape_at > @as(i64, if (cl.paste or cl.keybuf.items.len == 1) 40 else 1000)) {
                if (cl.paste) {
                    if (cl.paste_pane) |id| if (s.pane(id)) |p| try s.sendInput(p.terminal, cl.keybuf.items);
                } else if (cl.keybuf.items.len == 1 and cl.keybuf.items[0] == 27) try s.key(cl, 27) else if (!s.hasMenu() and s.name_dialog == null and s.confirm == .none) {
                    if (s.focused()) |p| try s.sendInput(p.terminal, cl.keybuf.items);
                }
                cl.keybuf.clearRetainingCapacity();
            };
        }
        pub fn frame(s: *Server) ![]u8 {
            var native_blocked: usize = 0;
            var native_finished: usize = 0;
            for (s.runtime.sessions.items) |session| switch (session.attention) {
                .needs_input => native_blocked += 1,
                .finished => native_finished += 1,
                .none => {},
            };
            var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
            const entries = s.agentEntries(&agent_storage);
            var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
            return render.frame(s.model(), s.runtime.panes.items, s.width, s.height, .{
                .message = s.message[0..s.message_len],
                .copy_mode = s.copy_mode,
                .native_blocked = native_blocked,
                .native_finished = native_finished,
                .menu = s.menu(),
                .tab_menu = s.tab_menu,
                .tab_drop_x = s.tabDropX(),
                .dialog = s.name_dialog,
                .confirm = s.confirm != .none,
                .sidebar_open = s.sidebar_open,
                .sidebar_offset = s.sidebar_offset,
                .agents = entries,
                .workspaces = s.workspaceEntries(&workspace_storage),
                .workspace_offset = s.workspace_offset,
            });
        }
        pub fn run(s: *Server) !void {
            const observer = try @import("transcript.zig").Worker.start();
            defer observer.stop();
            const codex_observer = @import("codex_observer.zig");
            const codex = try codex_observer.Worker.start();
            defer codex.stop();
            _ = c.signal(c.SIGPIPE, os.sig_ignore);
            const fd = s.inherited_listener orelse try os.listen(s.socket);
            defer {
                _ = c.close(fd);
                std.fs.cwd().deleteFile(s.socket) catch {};
            }
            defer s.runtime.deinit();
            const state_path = try workspace.Store.statePath(s.socket);
            defer a.free(state_path);
            if (s.inherited_listener != null) {
                // Imported state and sockets are ready before ownership commits.
            } else if (try @import("recovery.zig").load(&s.runtime, s.socket, s.executable)) {
                s.default_folder_pending = false;
            } else if (try s.runtime.workspaces.load(state_path)) {
                s.default_folder_pending = false;
            } else {
                _ = try s.runtime.workspaces.add("", ".");
                try s.runtime.workspaces.save(state_path);
            }
            if (s.inherited_listener == null) for ([_][]const u8{ "codex", "claude" }) |provider| {
                @import("integration.zig").install(provider) catch |err| {
                    std.log.warn("{s} hook setup: {s}; using automatic detection", .{ provider, @errorName(err) });
                    var msg: [180]u8 = undefined;
                    s.notice(std.fmt.bufPrint(&msg, "{s} hooks: {s}; automatic detection is active", .{ provider, @errorName(err) }) catch "Hook setup failed; automatic detection is active");
                };
            };
            defer {
                for (s.clients.items) |*cl| cl.deinit();
                s.clients.deinit(a);
                s.dismissName();
            }
            while (!s.quit) {
                var polls: [1 + layout.max_panes + 32]c.struct_pollfd = undefined;
                var count: usize = 1;
                polls[0] = .{ .fd = fd, .events = c.POLLIN, .revents = 0 };
                for (s.runtime.panes.items) |p| {
                    polls[count] = .{ .fd = if (p.terminal.exited) -1 else p.terminal.fd, .events = @intCast(c.POLLIN | (if (p.terminal.pending.items.len > 0) c.POLLOUT else 0)), .revents = 0 };
                    count += 1;
                }
                for (s.clients.items) |cl| {
                    polls[count] = .{ .fd = cl.fd, .events = @intCast(c.POLLIN | (if (cl.output.items.len > cl.sent) c.POLLOUT else 0)), .revents = 0 };
                    count += 1;
                }
                _ = c.poll(&polls, @intCast(count), 16);
                // Read every live PTY, even when its tab is hidden. Only visible output dirties the frame.
                for (s.runtime.panes.items, 0..) |*p, i| {
                    p.terminal.refreshRedraw(std.time.milliTimestamp());
                    if (polls[i + 1].revents != 0) p.refreshCwd();
                    p.terminal.flush();
                    const journal_size = p.terminal.journal.bytes.items.len;
                    if (p.terminal.read()) {
                        s.runtime.changed();
                        var copy = s.model().*;
                        copy.focus(p.id) catch continue;
                        if (copy.active == s.model().active and (!s.model().tab().zoom or s.model().tab().focus == p.id)) s.dirty = true;
                    }
                    if (journal_size != p.terminal.journal.bytes.items.len) s.runtime.changed();
                }
                const now = std.time.milliTimestamp();
                if (now - s.last_detection >= 250) {
                    s.last_detection = now;
                    for (s.runtime.panes.items) |*p| if (!p.terminal.exited) s.detectPane(p);
                    codex.reconcile(s.runtime.panes.items);
                    var snapshots: [layout.max_panes]?codex_observer.Snapshot = undefined;
                    codex.take(&snapshots);
                    for (snapshots) |entry| if (entry) |snap| {
                        if (s.pane(snap.request.pane)) |p| {
                            const prefix = codex_observer.titlePrefix(p.terminal.vt.getTitle() orelse "") orelse continue;
                            if (p.terminal.exited or p.agent.provider != .codex or p.detection.missing != 0 or p.detection.pid != snap.request.pid or p.terminal.title_pid != snap.request.pid or !eq(prefix.text(), snap.request.prefix.text())) continue;
                            if (codex_observer.apply(&p.agent, snap, s.paneWatched(p.id))) {
                                s.bell = true;
                                if (s.bell_kind != .needs_input) s.bell_kind = if (p.agent.state == .blocked) .needs_input else .finished;
                            }
                            p.resume_hint.observe(&p.agent);
                            s.dirty = true;
                            s.runtime.changed();
                        }
                    };
                    s.followWorkspaceDirectories();
                    observer.reconcile(s.runtime.panes.items);
                    var completions: [layout.max_panes]?@import("transcript.zig").Result = undefined;
                    observer.take(&completions);
                    for (completions) |entry| if (entry) |result| {
                        if (s.pane(result.pane)) |p| {
                            const was_pending = p.agent.observation.pending_stop;
                            const ding = p.agent.confirm(result.seq, result.outcome);
                            if (was_pending and !p.agent.observation.pending_stop) {
                                s.runtime.changed();
                                s.dirty = true;
                            }
                            if (ding and !s.paneWatched(p.id)) {
                                s.bell = true;
                                if (s.bell_kind != .needs_input) s.bell_kind = .finished;
                            }
                        }
                    };
                }
                for (s.runtime.sessions.items) |*session| {
                    const old_seq = session.next_seq;
                    const old_state = session.state;
                    const old_ready = session.ready;
                    const old_attention = session.attention;
                    const old_tool = session.toolActive();
                    const ding = session.poll() catch |err| blk: {
                        s.notice(@errorName(err));
                        _ = c.kill(-session.child.id, c.SIGTERM);
                        break :blk false;
                    };
                    if (old_seq != session.next_seq) s.runtime.changed();
                    if (session.state != old_state or session.ready != old_ready or session.attention != old_attention or session.toolActive() != old_tool) s.dirty = true;
                    if (ding) {
                        s.bell = true;
                        if (s.bell_kind != .needs_input) s.bell_kind = session.attention;
                        var msg: [160]u8 = undefined;
                        s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}  |  corgi native events {d}", .{ @tagName(session.provider), session.id, @tagName(session.state), session.id }));
                        s.native_notice = session.id;
                    }
                }
                // Reap closed panes too, forwarding Git exits to its worker.
                @import("git_status.zig").child_mutex.lock();
                while (true) {
                    var status: c_int = 0;
                    const pid = c.waitpid(-1, &status, c.WNOHANG);
                    if (pid <= 0) break;
                    @import("git_status.zig").recordExit(pid, status);
                    for (s.runtime.panes.items) |*p| if (p.terminal.pid == pid) {
                        p.terminal.exited = true;
                        p.terminal.exit_status = status;
                        s.dirty = true;
                    };
                    for (s.runtime.sessions.items) |*session| if (session.child.id == pid) {
                        session.markExited();
                        s.dirty = true;
                    };
                }
                @import("git_status.zig").child_mutex.unlock();
                // Both Terminal.read and the general child reaper can detect exit.
                // Remove in a separate pass so adjacent exits aren't skipped.
                var pi: usize = 0;
                while (pi < s.runtime.panes.items.len) {
                    if (s.runtime.panes.items[pi].terminal.exited) {
                        try s.close(s.runtime.panes.items[pi].id);
                    } else pi += 1;
                }
                var ci: usize = 0;
                while (ci < s.clients.items.len) {
                    const cl = &s.clients.items[ci];
                    var bytes: [16384]u8 = undefined;
                    const n = c.read(cl.fd, &bytes, bytes.len);
                    if (n == 0) cl.dead = true;
                    if (n > 0) {
                        cl.touched = std.time.milliTimestamp();
                        try cl.input.appendSlice(a, bytes[0..@intCast(n)]);
                        if (cl.input.items.len > 1024 * 1024) cl.dead = true;
                    }
                    if (cl.input.items.len > 0) {
                        var consumed: usize = 0;
                        while (!cl.dead) {
                            const newline = std.mem.indexOfScalarPos(u8, cl.input.items, consumed, '\n') orelse break;
                            const parsed = std.json.parseFromSlice(std.json.Value, a, cl.input.items[consumed..newline], .{ .max_value_len = 1024 * 1024 }) catch {
                                try cl.queue(.{ .ok = false, .err = "InvalidJson" });
                                consumed = newline + 1;
                                continue;
                            };
                            defer parsed.deinit();
                            s.request(cl, parsed.value) catch |err| {
                                try cl.queue(.{ .ok = false, .err = @errorName(err) });
                                if (cl.attached) s.notice(@errorName(err));
                            };
                            consumed = newline + 1;
                            if (s.reload_executable != null and s.reload_requester == cl.fd) break;
                        }
                        std.mem.copyForwards(u8, cl.input.items[0 .. cl.input.items.len - consumed], cl.input.items[consumed..]);
                        cl.input.items.len -= consumed;
                    }
                    if (!cl.attached and !cl.viewer and !cl.subscribed and std.time.milliTimestamp() - cl.touched > 5000) cl.dead = true;
                    if (cl.dead) {
                        cl.deinit();
                        _ = s.clients.orderedRemove(ci);
                        try s.resizeViewers();
                        continue;
                    }
                    ci += 1;
                }
                // Give fragmented CSI/SS3 keys time to complete, but eventually
                // release incomplete prefixes (e.g. a legacy terminal's Alt-[).
                // A lone ESC and literal paste fragments keep the short timeout.
                try s.expireInput();
                s.followWorkspaceDirectories();
                if (s.runtime.git_status.tick(&s.runtime.workspaces)) s.dirty = true;
                if (s.dirty) {
                    s.runtime.changed();
                    for (s.clients.items) |*cl| if (cl.attached) {
                        cl.needs_frame = true;
                    };
                    s.dirty = false;
                }
                if (s.framePending() and std.time.milliTimestamp() - s.last_frame >= 30) {
                    const bytes = try s.frame();
                    defer a.free(bytes);
                    for (s.clients.items) |*cl| if (cl.attached and !cl.dead and cl.needs_frame and cl.output.items.len == 0) {
                        try cl.queue(.{ .type = "frame", .data = bytes });
                        cl.presented_count = 0;
                        if (cl.watched) {
                            var places: [layout.max_panes]layout.Placement = undefined;
                            for (s.model().placements(s.area(), &places)) |place| if (s.pane(place.id)) |p| {
                                cl.presented[cl.presented_count] = .{ .pane = p.id, .through = p.agent.observation.completed, .attention_at = if (s.model().tab().focus == p.id) p.agent.changed_at else -1 };
                                cl.presented_count += 1;
                            };
                        }
                        cl.needs_frame = false;
                    };
                    s.last_frame = std.time.milliTimestamp();
                }
                if (s.bell and s.bell_kind == .finished) {
                    var unread = false;
                    for (s.runtime.panes.items) |p| unread = unread or p.agent.observation.unread();
                    for (s.runtime.sessions.items) |session| unread = unread or session.attention == .finished;
                    if (!unread) {
                        s.bell = false;
                        s.bell_kind = .none;
                    }
                }
                if (s.bell and std.time.milliTimestamp() - s.last_bell > 1500) {
                    for (s.clients.items) |*cl| if (cl.attached and !s.muted) try cl.queue(.{ .type = "bell", .kind = @tagName(s.bell_kind) });
                    s.bell_seq +%= 1;
                    s.last_bell_kind = s.bell_kind;
                    s.bell = false;
                    s.bell_kind = .none;
                    s.last_bell = std.time.milliTimestamp();
                }
                for (s.clients.items) |*cl| {
                    if (cl.subscribed and !cl.dead and cl.output.items.len == 0 and
                        cl.snapshot_revision != s.runtime.revision and std.time.milliTimestamp() - cl.last_snapshot >= 30)
                    {
                        try s.queueSession(cl);
                    }
                }
                for (s.clients.items) |*cl| {
                    if (cl.sent < cl.output.items.len) {
                        const pending = cl.output.items[cl.sent..];
                        const written = c.write(cl.fd, pending.ptr, pending.len);
                        if (written > 0) cl.sent += @intCast(written) else if (written < 0 and std.posix.errno(written) != .AGAIN and std.posix.errno(written) != .INTR) cl.dead = true;
                        if (cl.sent == cl.output.items.len) {
                            cl.output.clearRetainingCapacity();
                            cl.sent = 0;
                            if (cl.watched) for (cl.presented[0..cl.presented_count]) |receipt| {
                                if (s.pane(receipt.pane)) |p| {
                                    const before = p.agent;
                                    if (p.agent.changed_at == receipt.attention_at) p.agent.attention = .none;
                                    p.agent.readThrough(receipt.through);
                                    if (!std.meta.eql(before, p.agent)) s.dirty = true;
                                }
                            };
                            cl.presented_count = 0;
                        }
                    }
                }
                if (polls[0].revents & c.POLLIN != 0) {
                    const client_fd = c.accept(fd, null, null);
                    if (client_fd >= 0) {
                        if (s.clients.items.len == 32) _ = c.close(client_fd) else {
                            os.nonblock(client_fd);
                            os.cloexec(client_fd);
                            try s.clients.append(a, .{ .fd = client_fd, .touched = std.time.milliTimestamp() });
                        }
                    }
                }
                if (!s.quit) if (s.reload_executable) |executable| {
                    @import("handoff.zig").replace(s, fd, executable, s.reload_requester) catch |err| {
                        for (s.clients.items) |*cl| if (cl.fd == s.reload_requester) try cl.queue(.{ .ok = false, .err = @errorName(err) });
                        a.free(executable);
                        s.reload_executable = null;
                        s.notice(@errorName(err));
                    };
                };
                if ((now - s.last_recovery >= 2000 and s.saved_revision != s.runtime.revision) or s.quit) {
                    s.last_recovery = now;
                    @import("recovery.zig").save(&s.runtime, s.socket) catch |err| {
                        std.log.err("saving recovery: {s}", .{@errorName(err)});
                        s.notice(" Could not save recovery snapshot; see server.log");
                        continue;
                    };
                    s.saved_revision = s.runtime.revision;
                }
            }
        }
    };
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
fn direction(key: u8) ?[]const u8 {
    return switch (key) {
        'h' => "left",
        'j' => "down",
        'k' => "up",
        'l' => "right",
        else => null,
    };
}
fn number(v: std.json.Value, key: []const u8, default: i64) i64 {
    if (v != .object) return default;
    const n = v.object.get(key) orelse return default;
    return if (n == .integer) n.integer else default;
}
fn boolean(v: std.json.Value, key: []const u8) bool {
    if (v != .object) return false;
    const b = v.object.get(key) orelse return false;
    return b == .bool and b.bool;
}
