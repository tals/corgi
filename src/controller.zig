//! Viewer-owned navigation, dialogs, input and rendering. Shared mutations are RPC operations.
const std = @import("std");
const keyboard = @import("keyboard.zig");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const render = @import("render.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const workspace = @import("workspace.zig");
const protocol = @import("protocol.zig");
const Effect = union(enum) {
    write_terminal: []const u8,
    open_url: []const u8,

    fn deinit(effect: Effect) void {
        switch (effect) {
            .write_terminal, .open_url => |data| a.free(data),
        }
    }
};
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
const InputState = struct {
    viewer_id: u32 = 0,
    last_control: u64 = 0,
    attached: bool = false,
    watched: bool = true,
    port_click: ?struct { x: u16, y: u16, url: [4096]u8, len: usize, menu: ?u32 = null, pane: ?u32 = null, px: u16 = 0, py: u16 = 0, cancelled: bool = false } = null,
    paste: bool = false,
    paste_pane: ?layout.Id = null,
    paste_to_name: bool = false,
    tab_drag: ?TabDrag = null,
    divider: ?struct { hit: layout.View.Divider, area: layout.Rect, cancelled: bool = false } = null,
    keybuf: std.ArrayList(u8) = .empty,
    escape_at: i64 = 0,
    pub fn deinit(cl: *InputState) void {
        cl.keybuf.deinit(a);
    }
};
pub const Controller = struct {
    const Self = @This();
    const Terminal = @import("mirror.zig").Terminal;
    const Pane = @import("mirror.zig").Pane;
    connection: *@import("rpc.zig").Connection,
    runtime: @import("mirror.zig").Runtime = .{},
    navigation: @import("navigation.zig").State = .{},
    workspace_offset: usize = 0,
    input_state: InputState = .{},
    effects: std.ArrayList(Effect) = .empty,
    executable: []const u8,
    width: u16 = 100,
    height: u16 = 30,
    dirty: bool = true,
    prefix: bool = false,
    menu_page: usize = 0,
    menu_highlight: ?u8 = null,
    sidebar_open: bool = true,
    corgi_badge: bool = false,
    sidebar_width: u16 = 28,
    sidebar_offset: usize = 0,
    remote_links: bool = false,
    tab_menu: ?commands.TabMenu = null,
    port_menu: ?sidebar.PortMenu = null,
    pointer: ?render.Pointer = null,
    link_tooltip: @import("link_tooltip.zig").State = .{},
    ui_mouse_down: bool = false,
    sidebar_drag: bool = false,
    workspace_drag: ?struct { id: u32, start_y: u16, before: ?u32 = null, drop_y: ?u16 = null, width: u16, height: u16, offset: usize, ids: [workspace.max_workspaces]u32 = undefined, count: usize = 0 } = null,
    resize_mode: bool = false,
    copy_mode: bool = false,
    name_dialog: ?naming.Dialog = null,
    confirm: enum { none, pane, tab } = .none,
    confirm_tab: ?layout.Id = null,
    message: [512]u8 = .{0} ** 512,
    message_len: usize = 0,
    native_notice: ?u32 = null,
    copy_feedback_until: i64 = 0,
    muted: bool = false,
    selection: ?struct { pane: u32, x: u16, y: u16, moved: bool = false } = null,
    search_mode: bool = false,
    search_text: [128]u8 = .{0} ** 128,
    search_len: usize = 0,
    search_skip: usize = 0,
    last_bell_kind: agents.Attention = .none,

    fn model(s: *Self) *layout.Model {
        return &s.current().model;
    }
    fn nav(s: *Self) *layout.Selection {
        return s.navigation.tabs(&s.runtime.workspaces);
    }
    pub fn current(s: *Self) *protocol.Workspace {
        return s.navigation.current(&s.runtime.workspaces);
    }
    fn workspaceIndex(s: *Self) usize {
        return s.navigation.index(&s.runtime.workspaces);
    }
    fn selectedTab(s: *Self) *layout.Tab {
        return &s.model().tabs[s.nav().active];
    }
    pub fn layoutView(s: *Self) layout.View {
        return .{ .model = s.model(), .selection = s.nav() };
    }
    const Created = struct { pane: u32, workspace: u32 };
    fn execute(s: *Self, command: @import("session.zig").Command) !Created {
        const response = try s.connection.call(.{ .op = "session.command", .protocol = 1, .command = command });
        defer response.deinit();
        const parsed = try std.json.parseFromValue(Created, a, response.value.object.get("result").?, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const result = parsed.value;
        try s.refresh();
        if (s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.len == 1) {
            s.input_state.attached = false;
        }
        s.dirty = true;
        return result;
    }
    fn edit(s: *Self, command: @import("session.zig").Command) !void {
        _ = try s.execute(command);
    }
    fn moveTab(s: *Self, id: u32, gap: usize) !void {
        if (@import("navigation.zig").moveTab(s.model(), id, gap)) |operation| try s.edit(operation);
    }

    pub fn switchWorkspace(s: *Self, id: u32) !void {
        _ = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
        if (s.input_state.tab_drag) |*drag| {
            drag.cancelled = true;
        }
        s.dismissName();
        s.closeMenu();
        s.navigation.workspace_id = id;
        s.visitWorkspace(id);
        s.revealWorkspace();
        s.sidebar_offset = 0;
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.confirm = .none;
        s.confirm_tab = null;
        s.message_len = 0;
        s.native_notice = null;

        s.dirty = true;
    }
    fn closeWorkspace(s: *Self, id: u32, close_contents: bool) !void {
        _ = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
        if (s.runtime.workspaces.items.len == 1) return error.LastWorkspace;

        try s.edit(.{ .@"workspace.close" = .{ .target = id, .close_contents = close_contents } });
        try s.switchWorkspace(s.current().id);
        return;
    }
    fn revealWorkspace(s: *Self) void {
        const capacity = s.sidebarView(0).workspaceCapacity();
        const index = s.workspaceIndex();
        if (index < s.workspace_offset) s.workspace_offset = index else if (index >= s.workspace_offset + capacity) s.workspace_offset = index + 1 - capacity;
    }
    pub fn focusPane(s: *Self, id: u32) !void {
        const owner = s.runtime.workspaces.owner(id) orelse return error.NoPane;
        const workspace_id = owner.id;
        if (workspace_id != s.current().id) try s.switchWorkspace(workspace_id);
        try s.nav().focus(s.model(), id);
    }
    pub fn area(s: *Self) layout.Rect {
        return s.sidebarView(0).area();
    }
    fn sidebarView(s: *Self, count: usize) sidebar.View {
        return sidebar.View.init(s.width, s.height, s.sidebar_open, s.sidebar_offset, count).withWidth(s.sidebar_width).withWorkspaces(s.runtime.workspaces.items.len, s.workspace_offset);
    }
    pub fn inheritedCwd(s: *Self, ws: *protocol.Workspace, target: ?layout.Id) []const u8 {
        const id = target orelse if (ws.model.count > 0) ws.model.firstPane(ws.model.tabs[0].root) else return ws.cwd;
        const p = s.pane(id) orelse return ws.cwd;
        return p.cwd;
    }
    fn currentCwd(s: *Self) []const u8 {
        return s.inheritedCwd(s.current(), if (s.focused()) |p| p.id else null);
    }
    pub fn workspaceEntries(s: *Self, out: *[workspace.max_workspaces]sidebar.WorkspaceEntry) []sidebar.WorkspaceEntry {
        for (s.runtime.workspaces.items, 0..) |*ws, i| {
            out[i] = .{ .id = ws.id, .name = ws.name, .cwd = ws.cwd, .active = i == s.workspaceIndex(), .git_ahead = ws.git_ahead, .git_commits = ws.git_commits, .stats = ws.stats };
            out[i].ports = s.runtime.ports;
            out[i].remote_links = s.remote_links;
            for (s.runtime.panes.items) |p| {
                if (p.agent.provider == .other or ws.model.tabForPane(p.id) == null) continue;
                if (p.agent.state == .working) out[i].working += 1;
                if (p.agent.state == .blocked or p.agent.attention == .needs_input) out[i].attention += 1;
                if (p.agent.observation.unread()) out[i].unread += 1;
            }
            for (s.runtime.sessions) |session| {
                if (session.workspace != ws.id) continue;
                if (session.state == .working) out[i].working += 1;
                if (session.state == .blocked or session.attention == .needs_input) out[i].attention += 1;
                if (session.observation.unread()) out[i].unread += 1;
            }
        }
        return out[0..s.runtime.workspaces.items.len];
    }
    pub fn agentEntries(s: *Self, entries: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
        var count: usize = 0;
        for (s.model().tabs[0..s.model().count], 0..) |_, tab_index| {
            for (s.runtime.panes.items) |*p| {
                if (p.agent.provider == .other or s.model().tabForPane(p.id) != tab_index) continue;
                entries[count] = .{ .target = .{ .pane = p.id }, .name = if (p.label.len > 0) p.label else p.agent.name, .provider = p.agent.provider, .state = p.agent.state, .attention = p.agent.attention, .focused = s.nav().tab().focus == p.id, .cwd = if (p.agent.cwd.len > 0) p.agent.cwd else p.cwd, .tool_active = p.agent.tool_active, .compacting = p.agent.compacting, .subagents = p.agent.subagents, .unread = p.agent.observation.unread(), .activity = if (p.agent.provider == .codex or p.agent.activity.len > 0) p.agent.activity else p.agent.recent_activity };
                count += 1;
            }
        }
        for (s.runtime.sessions) |*session| {
            if (session.workspace != s.current().id) continue;
            entries[count] = .{ .target = .{ .native = session.id }, .provider = session.provider, .state = session.state, .attention = session.attention, .focused = s.native_notice == session.id, .cwd = session.cwd, .tool_active = session.tool_active, .unread = session.observation.unread() };
            count += 1;
        }
        return entries[0..count];
    }
    fn firstUnreadAgent(s: *Self, workspace_index: usize) ?sidebar.Target {
        const ws = &s.runtime.workspaces.items[workspace_index];
        for (ws.model.tabs[0..ws.model.count], 0..) |_, tab_index| {
            for (s.runtime.panes.items) |p| {
                if (p.agent.provider != .other and ws.model.tabForPane(p.id) == tab_index and p.agent.observation.unread())
                    return .{ .pane = p.id };
            }
        }
        for (s.runtime.sessions) |session| {
            if (session.workspace == ws.id and session.observation.unread()) return .{ .native = session.id };
        }
        return null;
    }
    fn selectAgent(s: *Self, target: sidebar.Target) !void {
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.message_len = 0;
        s.native_notice = null;
        switch (target) {
            .pane => |id| {
                try s.focusPane(id);

                s.dirty = true;
            },
            .native => |id| for (s.runtime.sessions) |session| {
                if (session.id != id) continue;
                var msg: [180]u8 = undefined;
                s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}. Inspect: corgi native events {d}", .{ @tagName(session.provider), id, @tagName(session.state), id }));
                s.native_notice = id;
                break;
            },
        }
        s.dirty = true;
    }
    fn pane(s: *Self, id: layout.Id) ?*Pane {
        return s.runtime.pane(id);
    }
    pub fn focused(s: *Self) ?*Pane {
        return if (s.model().count == 0) null else s.pane(s.nav().tab().focus);
    }
    pub fn notice(s: *Self, msg: []const u8) void {
        s.message_len = agents.clean(&s.message, msg);
        s.native_notice = null;
        s.dirty = true;
    }
    pub fn menu(s: *Self) ?commands.View {
        if (!s.prefix and !s.resize_mode) return null;
        var view = commands.View.init(s.width, s.height, s.resize_mode, s.menu_page, s.model().count > 0);
        view.highlighted = s.menu_highlight;
        return view;
    }
    fn hasMenu(s: *Self) bool {
        return s.prefix or s.resize_mode or s.tab_menu != null or s.port_menu != null;
    }
    fn tabIndex(s: *Self, id: layout.Id) ?usize {
        for (s.model().tabs[0..s.model().count], 0..) |tab, i| if (tab.id == id) return i;
        return null;
    }
    fn openTabMenu(s: *Self, index: usize, x: u16) void {
        s.closeMenu();
        s.search_mode = false;
        s.cancelDividers();
        s.selection = null;
        s.tab_menu = .{ .tab = s.model().tabs[index].id, .anchor_x = x };
    }
    fn tabMenuAction(s: *Self, key_: u8) !void {
        const context = s.tab_menu orelse return;
        const supported = for (context.entries()) |entry| {
            if (entry.key == key_) break true;
        } else false;
        if (!supported) return;
        s.closeMenu();
        if (context.pane) {
            if (s.pane(context.tab) == null) return;
            if (key_ == 'T') {
                s.name_dialog = naming.Dialog.init(.{ .pane = context.tab }, s.pane(context.tab).?.label);
                s.dirty = true;
            } else if (key_ == 'C') {
                try s.renamePane(context.tab, "");
            } else if (key_ == 'X') {
                try s.close(context.tab);
            } else if (key_ == 's') {
                if (context.source) |source| {
                    if (s.model().tabForPane(source) != s.model().tabForPane(context.tab)) return;
                    try s.focusPane(source);
                    try s.edit(.{ .@"pane.swap" = .{ .target = source, .other = context.tab } });
                    s.dirty = true;
                }
            } else {
                try s.focusPane(context.tab);
                switch (key_) {
                    'v' => try s.action("split", "right"),
                    '-' => try s.action("split", "down"),
                    'z' => try s.action("zoom", ""),
                    else => {},
                }
            }
            return;
        }
        if (context.workspace) {
            if (s.runtime.workspaces.index(context.tab) == null) return;
            switch (key_) {
                'T' => s.beginWorkspace(context.tab),
                'X' => s.closeWorkspace(context.tab, true) catch |err| s.notice(if (err == error.LastWorkspace) " Cannot close the last workspace" else " Could not close workspace"),
                else => {},
            }
            return;
        }
        s.nav().active = s.tabIndex(context.tab) orelse return;
        s.copy_mode = false;

        s.dirty = true;
        switch (key_) {
            'c' => try s.beginNewTab(),
            'T' => s.beginRename(),
            'X' => try s.action("close-tab", ""),
            else => {},
        }
    }
    fn moveTabMenu(s: *Self, next: bool) void {
        if (s.tab_menu) |*context| context.move(next);
        s.dirty = true;
    }
    fn openMenu(s: *Self) void {
        s.link_tooltip.cancel();
        s.port_menu = null;
        s.tab_menu = null;
        s.prefix = true;
        s.menu_page = 0;
        s.menu_highlight = null;
        s.cancelDividers();
        s.selection = null;
        s.dirty = true;
    }
    fn closeMenu(s: *Self) void {
        s.link_tooltip.cancel();
        s.port_menu = null;
        s.tab_menu = null;
        s.menu_highlight = null;
        s.prefix = false;
        s.resize_mode = false;
        s.dirty = true;
    }
    fn pageMenu(s: *Self, next: bool) void {
        const view = s.menu() orelse return;
        s.menu_highlight = null;
        s.menu_page = if (next) (view.page + 1) % view.pages else (view.page + view.pages - 1) % view.pages;
        s.dirty = true;
    }
    fn beginWorkspace(s: *Self, id: ?u32) void {
        s.dismissName();
        const initial = if (id) |value| s.runtime.workspaces.items[s.runtime.workspaces.index(value) orelse return].custom_name else "";
        s.name_dialog = naming.Dialog.init(.{ .workspace_name = id }, initial);
        s.prepareName();
    }
    fn newWorkspace(s: *Self, name: []const u8, cwd: []const u8) !u32 {
        const id = (try s.execute(.{ .@"workspace.create" = .{ .name = name, .cwd = cwd } })).workspace;
        try s.switchWorkspace(id);
        return id;
    }
    fn beginRename(s: *Self) void {
        if (s.model().count == 0) return;
        const tab = s.selectedTab();
        s.dismissName();
        s.name_dialog = naming.Dialog.init(.{ .rename = tab.id }, tab.title());
        s.prepareName();
    }
    fn beginNewTab(s: *Self) !void {
        const cwd = try a.dupe(u8, s.currentCwd());
        s.dismissName();
        s.name_dialog = naming.Dialog.init(.{ .create = cwd }, "");
        s.prepareName();
    }
    fn prepareName(s: *Self) void {
        s.search_mode = false;
        s.copy_mode = false;
        s.closeMenu();
        s.cancelDividers();
        s.selection = null;
        s.dirty = true;
    }
    pub fn dismissName(s: *Self) void {
        if (s.name_dialog) |dialog| switch (dialog.target) {
            .create => |cwd| a.free(cwd),
            else => {},
        };
        s.name_dialog = null;
    }
    fn renamePane(s: *Self, id: u32, name: []const u8) !void {
        try s.edit(.{ .@"pane.rename" = .{ .target = id, .name = name } });
    }
    fn finishName(s: *Self, save: bool) void {
        s.dirty = true;
        if (save) if (s.name_dialog) |*dialog| {
            switch (dialog.target) {
                .pane => |id| s.renamePane(id, dialog.name()) catch {
                    dialog.failed = true;
                    return;
                },
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
                    s.edit(.{ .@"workspace.edit" = .{ .target = id.?, .name = name } }) catch {
                        dialog.failed = true;
                        return;
                    };
                },
                .rename => |id| {
                    s.edit(.{ .@"tab.rename" = .{ .target = id, .name = dialog.name() } }) catch {
                        dialog.failed = true;
                        return;
                    };
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
    fn create(s: *Self, split: ?layout.Axis, cwd: []const u8, command: ?[]const u8, title: []const u8) !layout.Id {
        const operation: @import("session.zig").Command = if (split) |axis|
            .{ .@"pane.split" = .{
                .target = if (s.model().count > 0) s.nav().tab().focus else 0,
                .direction = if (axis == .horizontal) .right else .down,
                .cwd = cwd,
                .command = command,
                .title = title,
            } }
        else
            .{ .@"pane.create" = .{ .workspace = s.current().id, .cwd = cwd, .command = command, .title = title } };
        const id = (try s.execute(operation)).pane;
        try s.focusPane(id);
        s.nav().tab().zoom = false;
        s.dirty = true;
        return id;
    }
    pub fn close(s: *Self, id: layout.Id) !void {
        try s.edit(.{ .@"pane.close" = .{ .target = id } });
        s.dirty = true;
        return;
    }
    fn undoClose(s: *Self) !void {
        if (s.runtime.closed_panes == 0) {
            s.notice(" No closed panes to restore");
            return;
        }
        const id = (try s.execute(.{ .@"pane.restore" = .{ .workspace = s.current().id } })).pane;
        try s.focusPane(id);
        s.copy_mode = false;
        s.notice(" Restored closed pane in a new tab with a fresh shell");
        return;
    }
    fn attention(s: *Self) !void {
        for ([_]agents.Attention{ .needs_input, .finished }) |priority| {
            var best: ?*Pane = null;
            for (s.runtime.panes.items) |*p| if (p.agent.attention == priority) {
                if (best == null or p.agent.changed_at < best.?.agent.changed_at) best = p;
            };
            if (best) |p| {
                try s.focusPane(p.id);

                s.dirty = true;
                return;
            }
        }
        for ([_]agents.Attention{ .needs_input, .finished }) |priority| {
            for (s.runtime.sessions) |session| if (session.attention == priority) {
                if (session.workspace != s.current().id) try s.switchWorkspace(session.workspace);
                var msg: [180]u8 = undefined;
                s.notice(try std.fmt.bufPrint(&msg, " {s} native session {d}: {s}. Inspect: corgi native events {d}", .{ @tagName(session.provider), session.id, @tagName(session.state), session.id }));
                s.native_notice = session.id;
                return;
            };
        }
        s.notice(" Nothing needs your attention");
    }
    pub fn action(s: *Self, name: []const u8, value: []const u8) !void {
        s.message_len = 0;
        if (eq(name, "workspace-next") or eq(name, "workspace-prev")) {
            const count = s.runtime.workspaces.items.len;
            const index = if (eq(name, "workspace-next")) (s.workspaceIndex() + 1) % count else (s.workspaceIndex() + count - 1) % count;
            return s.switchWorkspace(s.runtime.workspaces.items[index].id);
        } else if (eq(name, "new")) {
            _ = try s.create(null, s.currentCwd(), null, "");
            s.copy_mode = false;
        } else if (eq(name, "sidebar")) {
            s.sidebar_open = !s.sidebar_open;
            s.selection = null;
            s.cancelDividers();
            s.dirty = true;
        } else if (eq(name, "mute")) {
            s.muted = !s.muted;
            s.notice(if (s.muted) " Dings muted; attention markers remain on" else " Dings enabled");
        } else if (eq(name, "undo-close")) return s.undoClose() else if (eq(name, "attention")) return s.attention() else if (s.model().count == 0) return error.NoPane else if (eq(name, "split")) {
            _ = try s.create(if (eq(value, "down")) .vertical else .horizontal, s.currentCwd(), null, "");
        } else if (eq(name, "zoom")) s.nav().tab().zoom = !s.nav().tab().zoom else if (eq(name, "close")) try s.close(s.nav().tab().focus) else if (eq(name, "close-tab")) {
            try s.edit(.{ .@"tab.close" = .{ .target = s.selectedTab().id } });
        } else {
            const intent = try s.navigation.command(&s.runtime.workspaces, name, value, s.area());
            if (intent.edit) |operation| try s.edit(operation);
            if (intent.focus) |id| {
                try s.focusPane(id);
                s.copy_mode = false;
            }
        }
        s.dirty = true;
    }
    fn scroll(s: *Self, delta: isize) void {
        if (s.focused()) |p| {
            p.terminal.scrollViewport(.{ .delta = delta });
            s.dirty = true;
        }
    }
    fn sendInput(s: *Self, term: *Terminal, bytes: []const u8) !void {
        if (!s.copy_mode and bytes.len > 0 and !term.atBottom()) {
            term.scrollViewport(.bottom);
            try term.clearSelection();
            s.selection = null;
            s.dirty = true;
        }
        try term.send(bytes);
    }
    // Takes ownership of the payload, including on append failure.
    fn queueEffect(s: *Self, effect: Effect) !void {
        errdefer effect.deinit();
        try s.effects.append(a, effect);
    }
    pub fn clearEffects(s: *Self) void {
        for (s.effects.items) |effect| effect.deinit();
        s.effects.clearRetainingCapacity();
    }
    fn copyPane(s: *Self, p: *Pane) !void {
        const text = try p.terminal.selectedText();
        defer a.free(text);
        const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(text.len));
        defer a.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, text);
        const osc = try std.fmt.allocPrint(a, "\x1b]52;c;{s}\x07", .{encoded});
        try s.queueEffect(.{ .write_terminal = osc });
        s.copy_feedback_until = std.time.milliTimestamp() + 2000;
        s.dirty = true;
    }
    fn portWorkspaceEntry(s: *Self, id: u32) sidebar.WorkspaceEntry {
        return .{ .id = id, .name = "", .cwd = "", .active = false, .ports = s.runtime.ports, .remote_links = s.remote_links };
    }
    fn movePortMenu(s: *Self, next: bool) void {
        if (s.port_menu) |*links| {
            const count = sidebar.urlCount(s.portWorkspaceEntry(links.workspace));
            links.selected = if (next) @min(links.selected + 1, count -| 1) else links.selected -| 1;
            s.dirty = true;
        }
    }
    fn key(s: *Self, byte: u8) !void {
        const cl = &s.input_state;
        if (s.port_menu) |links| {
            switch (byte) {
                27 => s.closeMenu(),
                'j', 9 => s.movePortMenu(true),
                'k' => s.movePortMenu(false),
                13 => {
                    var buf: [256]u8 = undefined;
                    if (!s.remote_links) if (sidebar.workspaceUrl(s.portWorkspaceEntry(links.workspace), links.selected, &buf)) |url| {
                        try s.queueEffect(.{ .open_url = try a.dupe(u8, url) });
                        s.closeMenu();
                    };
                },
                else => {},
            }
            return;
        }

        s.sidebar_drag = false;
        s.workspace_drag = null;
        s.cancelDividers();
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
                's', 'C', 'v', '-', 'z' => try s.tabMenuAction(byte),
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
                if (target) |id| s.nav().active = s.tabIndex(id) orelse return;
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
                'W' => s.beginWorkspace(s.current().id),
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
                'q', 'd' => cl.attached = false,
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
                'y', 13 => if (s.focused()) |p| try s.copyPane(p),
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
            p.agent.observation.acknowledge(p.agent.observation.completed);
            p.agent.attention = .none;
        }
    }
    pub fn input(s: *Self, data: []const u8) !void {
        const cl = &s.input_state;
        try cl.keybuf.appendSlice(a, data);
        var used: usize = 0;
        while (used < cl.keybuf.items.len) {
            if (!cl.attached) {
                cl.keybuf.clearRetainingCapacity();
                return;
            }
            const rest = cl.keybuf.items[used..];
            if (rest[0] != 27) {
                s.link_tooltip.cancel();
                s.dirty = true;
                if (cl.paste) {
                    if (cl.paste_to_name and s.name_dialog != null) {
                        if (rest[0] >= 32 and rest[0] < 127) try s.key(rest[0]);
                    } else if (cl.paste_pane) |id| {
                        if (s.pane(id)) |p| try s.sendInput(p.terminal, rest[0..1]);
                    }
                } else try s.key(rest[0]);
                used += 1;
                continue;
            }
            if (rest.len < 2) {
                s.link_tooltip.cancel();
                s.dirty = true;
                break;
            }
            if (!cl.paste and rest[1] != '[' and rest[1] != 'O' and (s.hasMenu() or s.name_dialog != null or s.confirm != .none)) {
                try s.key(27);
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
            if (!std.mem.startsWith(u8, seq, "\x1b[<")) {
                s.link_tooltip.cancel();
                s.dirty = true;
            }
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
                        try s.key(seq[0]);
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
            } else if (eq(seq, "\x1b[O")) {
                cl.watched = false;
                s.pointer = null;
                s.dirty = true;
            } else if (std.mem.startsWith(u8, seq, "\x1b[<")) try s.mouse(seq) else if (s.port_menu != null) {
                if (eq(seq, "\x1b[A") or eq(seq, "\x1bOA")) s.movePortMenu(false) else if (eq(seq, "\x1b[B") or eq(seq, "\x1bOB")) s.movePortMenu(true);
            } else if (s.tab_menu != null) {
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
    fn validTabDrag(s: *Self, drag: *TabDrag) bool {
        const tabs_x = s.sidebarView(0).tabX();
        const m = s.model();
        if (drag.workspace_id != s.current().id or drag.width != s.width or
            drag.tabs_x != tabs_x or drag.count != m.count or
            drag.first != render.tabStart(s.layoutView(), s.width - tabs_x -| 3) or
            s.hasMenu() or s.name_dialog != null or s.confirm != .none)
            drag.cancelled = true;
        for (m.tabs[0..m.count], 0..) |tab, i| {
            if (i >= drag.count or drag.ids[i] != tab.id) drag.cancelled = true;
        }
        return !drag.cancelled;
    }
    pub fn tabDropX(s: *Self) ?u16 {
        if (s.input_state.tab_drag) |*drag| {
            if (s.validTabDrag(drag) and drag.dragging) if (drag.drop) |drop| return drop.x;
        }
        return null;
    }
    fn cancelDividers(s: *Self) void {
        if (s.input_state.divider) |*drag| {
            drag.cancelled = true;
        }
    }
    fn mouse(s: *Self, seq: []const u8) !void {
        const cl = &s.input_state;
        var fields = std.mem.splitScalar(u8, seq[3 .. seq.len - 1], ';');
        const button = std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return;
        const x = (std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return) -| 1;
        const y = (std.fmt.parseInt(u16, fields.next() orelse return, 10) catch return) -| 1;
        const release = seq[seq.len - 1] == 'm';
        const moved = s.pointer == null or s.pointer.?.x != x or s.pointer.?.y != y;
        if (!release and button & 32 != 0 and button & 3 == 3 and button & 64 == 0) {
            if (moved) s.link_tooltip.move();
        } else {
            s.link_tooltip.cancel();
            s.dirty = true;
        }
        if (moved) {
            s.pointer = .{ .x = x, .y = y };
            s.dirty = true;
        }
        if (cl.port_click) |*click| {
            if ((x != click.x or y != click.y) and click.pane != null) {
                if (s.pane(click.pane.?)) |p| {
                    // A consumed Ctrl-press must not leak an unmatched drag
                    // or release into a mouse-aware child.
                    if (p.terminal.emulator().*.flags.mouse_event != .none) {
                        click.cancelled = true;
                        if (release) cl.port_click = null;
                        return;
                    }
                    try p.terminal.clearSelection();
                    p.terminal.holding_selection = true;
                    s.selection = .{ .pane = click.pane.?, .x = click.px, .y = click.py };
                }
                cl.port_click = null;
            } else {
                if (x != click.x or y != click.y) click.cancelled = true;
                if (release) {
                    if (!click.cancelled and (button == 0 or button == 16)) {
                        if (click.menu) |id| {
                            s.port_menu = .{ .workspace = id };
                            s.dirty = true;
                        } else {
                            try s.queueEffect(.{ .open_url = try a.dupe(u8, click.url[0..click.len]) });
                            s.closeMenu();
                        }
                    }
                    cl.port_click = null;
                }
                return;
            }
        }

        if (s.port_menu) |links| {
            const ws = s.portWorkspaceEntry(links.workspace);
            if (!release and (button == 64 or button == 65)) s.movePortMenu(button == 65);
            if (!release and button == 0) {
                if (links.hit(ws, s.width, s.height, x, y)) |index| {
                    if (!s.remote_links) {
                        var click: @typeInfo(@FieldType(InputState, "port_click")).optional.child = .{ .x = x, .y = y, .url = undefined, .len = 0 };
                        if (sidebar.workspaceUrl(ws, index, &click.url)) |url| {
                            click.len = url.len;
                            cl.port_click = click;
                        }
                    }
                } else s.closeMenu();
            }
            return;
        }

        if (cl.divider) |*drag| {
            if (!std.meta.eql(drag.area, s.area())) drag.cancelled = true;
            if (!drag.cancelled and (release or button & 0xe3 == 32)) {
                const split = s.model().nodes[drag.hit.node].?.split;
                const operation: @import("session.zig").Command = .{ .@"split.ratio" = .{
                    .target = s.model().firstPane(split.first),
                    .other = s.model().firstPane(split.second),
                    .ratio = layout.View.dividerRatio(drag.hit, split.axis, x, y),
                    .expected = s.model().revision,
                } };
                try s.edit(operation);
                // A successful local resize changes revision, but keeps this gesture valid.
                drag.cancelled = false;
                s.dirty = true;
            }
            if (release) cl.divider = null;
            return;
        }
        if (s.sidebar_drag) {
            if (release) s.sidebar_drag = false else if (button == 32) {
                s.sidebar_width = std.math.clamp(x +| 1, 20, @max(20, s.width -| 20));
                s.dirty = true;
            }
            s.dirty = true;
            return;
        }
        if (s.workspace_drag) |*drag| {
            const side = s.sidebarView(0);
            var valid = drag.width == s.width and drag.height == s.height and drag.offset == side.workspace_offset and drag.count == s.runtime.workspaces.items.len;
            if (valid) for (s.runtime.workspaces.items, 0..) |ws, i| {
                if (ws.id != drag.ids[i]) valid = false;
            };
            if (!valid) {
                s.workspace_drag = null;
                s.dirty = true;
                return;
            }
            drag.before = null;
            drag.drop_y = null;
            if (valid and x < side.width and y >= 2 and y < side.middle() -| 2 and y != drag.start_y) {
                const slot = @min(side.workspace_offset + (y - 2 + 1) / 3, s.runtime.workspaces.items.len);
                drag.before = if (slot == s.runtime.workspaces.items.len) drag.id else if (s.runtime.workspaces.items[slot].id == drag.id) null else s.runtime.workspaces.items[slot].id;
                if (drag.before != null) drag.drop_y = @intCast(2 + (slot - side.workspace_offset) * 3 -| 1);
            }
            if (release) {
                const saved = drag.*;
                s.workspace_drag = null;
                if (saved.before) |before| {
                    try s.edit(.{ .@"workspace.move" = .{ .target = saved.id, .before = before } });
                }
            }
            s.dirty = true;
            return;
        }
        // Finish the captured selection before hit testing the release location.
        if (release and button & 3 == 0) if (s.selection) |sel| {
            s.selection = null;
            s.dirty = true;
            if (s.pane(sel.pane)) |p| {
                defer p.terminal.clearSelection() catch {};
                if (sel.moved) try s.copyPane(p);
            }
            return;
        };
        if (cl.tab_drag) |*drag| {
            const valid = s.validTabDrag(drag);
            const drop = if (valid and y == 0 and x >= drag.tabs_x)
                render.tabDrop(s.layoutView(), s.width - drag.tabs_x, x - drag.tabs_x)
            else
                null;
            if (button == 32 and !release) {
                if (drop != null and x != drag.start_x) drag.dragging = true;
                drag.drop = drop;
            }
            if (release and button & 3 == 0) {
                if (valid and drag.dragging) if (drop) |target| try s.moveTab(drag.tab_id, target.index);
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
            if (x >= tabs_x) if (render.tabAt(s.layoutView(), tabs_width, x - tabs_x)) |index| {
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
                    .command => |entry| try s.key(entry.key),
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
                try s.key(if (y == s.height - 1 and x < 10) 'y' else 'n');
            }
            return;
        }
        var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.agentEntries(&agent_storage);
        const side = s.sidebarView(entries.len);
        if (!release and button == 0 and side.width > 0 and x == side.width - 1) {
            s.sidebar_drag = true;
            return;
        }
        if (!release and button == 0) {
            var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
            if (sidebar.portWorkspace(side, s.workspaceEntries(&workspace_storage), x, y)) |ws| {
                var click: @typeInfo(@FieldType(InputState, "port_click")).optional.child = .{ .x = x, .y = y, .url = undefined, .len = 0 };
                if (sidebar.urlCount(ws) > 1) {
                    click.menu = ws.id;
                } else if (!s.remote_links) {
                    const url = sidebar.workspaceUrl(ws, 0, &click.url) orelse return;
                    click.len = url.len;
                } else return;
                cl.port_click = click;
                return;
            }
        }
        if ((side.width > 0 and x < side.width and y < s.height - 1) or (y == 0 and x < tabs_x)) {
            if (!release and (button == 64 or button == 65)) {
                if (y < side.middle()) {
                    s.workspace_offset = if (button == 64) side.workspace_offset -| 1 else @min(side.workspace_offset + 1, s.runtime.workspaces.items.len -| side.workspaceCapacity());
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
                    .workspace_next => s.workspace_offset = @min(side.workspace_offset + side.workspaceCapacity(), s.runtime.workspaces.items.len -| side.workspaceCapacity()),
                    .workspace => |index| if (button == 2) {
                        s.closeMenu();
                        s.search_mode = false;
                        s.cancelDividers();
                        s.selection = null;
                        s.tab_menu = .{ .tab = s.runtime.workspaces.items[index].id, .workspace = true, .anchor_x = x, .anchor_y = y };
                    } else {
                        const id = s.runtime.workspaces.items[index].id;
                        var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
                        const ws_entries = s.workspaceEntries(&workspace_storage);
                        const jump = side.unreadHit(ws_entries[index], x, y);
                        const target = if (jump) s.firstUnreadAgent(index) else null;
                        try s.switchWorkspace(id);
                        if (jump) {
                            if (target) |agent| {
                                try s.selectAgent(agent);
                                const updated = s.agentEntries(&agent_storage);
                                for (updated, 0..) |entry, i| {
                                    if (std.meta.eql(entry.target, agent)) {
                                        s.sidebar_offset = @min(i, updated.len -| side.capacity);
                                        break;
                                    }
                                }
                            }
                        } else {
                            s.ui_mouse_down = false;
                            s.workspace_drag = .{ .id = id, .start_y = y, .width = s.width, .height = s.height, .offset = s.workspace_offset, .count = s.runtime.workspaces.items.len };
                            for (s.runtime.workspaces.items, 0..) |ws, i| s.workspace_drag.?.ids[i] = ws.id;
                        }
                    },
                    .none => {},
                }
                s.dirty = true;
            }
            return;
        }
        if (y == 0 and button == 0 and !release) {
            const add_x = tabs_x + render.addTabX(s.layoutView(), tabs_width);
            if (x >= add_x and x < add_x + 3) {
                s.ui_mouse_down = true;
                try s.beginNewTab();
                return;
            }
            if (x >= tabs_x) if (render.tabAt(s.layoutView(), tabs_width, x - tabs_x)) |index| {
                s.nav().active = index;
                cl.tab_drag = .{
                    .workspace_id = s.current().id,
                    .tab_id = s.model().tabs[index].id,
                    .start_x = x,
                    .width = s.width,
                    .tabs_x = tabs_x,
                    .first = render.tabStart(s.layoutView(), tabs_width -| 3),
                    .count = s.model().count,
                };
                for (s.model().tabs[0..s.model().count], 0..) |tab, i| cl.tab_drag.?.ids[i] = tab.id;

                s.dirty = true;
            };
            return;
        }
        if (button & 32 != 0 and button & 3 == 3) return;
        var locations: [layout.max_panes]layout.Placement = undefined;
        for (s.layoutView().placements(s.area(), &locations)) |p| if (p.rect.contains(x, y)) {
            if (!release and button & 0xe3 == 2 and (s.pane(p.id).?.terminal.emulator().*.flags.mouse_event == .none or button & 4 != 0)) {
                const source = s.nav().tab().focus;
                s.closeMenu();
                s.selection = null;
                s.cancelDividers();
                s.tab_menu = .{ .pane = true, .tab = p.id, .source = if (source != p.id) source else null, .anchor_x = x, .anchor_y = y };
                s.ui_mouse_down = true;
                s.dirty = true;
                return;
            }
            try s.focusPane(p.id);

            s.dirty = true;
            const term = s.pane(p.id).?.terminal;
            // Cmd-click stays with the host's OSC 8 handler. SGR mouse
            // events expose Ctrl, but do not encode the Command modifier.
            if (!release and button == 16 and !s.copy_mode) {
                for (term.hyperlinks()) |link| {
                    if (link.row != y - p.rect.y or x - p.rect.x < link.start or x - p.rect.x >= link.end) continue;
                    if (!std.mem.startsWith(u8, link.uri, "http://") and !std.mem.startsWith(u8, link.uri, "https://")) continue;
                    var click: @typeInfo(@FieldType(InputState, "port_click")).optional.child = .{ .x = x, .y = y, .url = undefined, .len = link.uri.len, .pane = p.id, .px = x - p.rect.x, .py = y - p.rect.y };
                    if (link.uri.len > click.url.len) continue;
                    @memcpy(click.url[0..link.uri.len], link.uri);
                    cl.port_click = click;
                    return;
                }
            }
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
                term.holding_selection = true;
            }
            return;
        };
        if (release) {
            s.selection = null;
            return;
        }
        if (button == 0) if (s.layoutView().dividerAt(s.area(), x, y)) |hit| {
            cl.divider = .{ .hit = hit, .area = s.area() };
            s.selection = null;
        };
    }

    pub fn visitWorkspace(s: *Self, id: u32) void {
        const index = s.runtime.workspaces.index(id) orelse return;
        if (s.runtime.workspaces.items[index].stats.any()) {
            s.runtime.workspaces.items[index].stats = .{};
            s.dirty = true;
        }
    }
    pub fn refresh(s: *Self) !void {
        const reply = try s.connection.call(.{ .op = "session.snapshot", .protocol = 1 });
        defer reply.deinit();
        try s.receiveSnapshot(reply.value);
    }
    pub fn receiveSnapshot(s: *Self, snapshot: std.json.Value) !void {
        const previous_focus = if (s.runtime.workspaces.items.len > 0) if (s.focused()) |p| p.id else 0 else 0;
        const previous_workspace = if (s.runtime.workspaces.items.len > 0) s.current().id else 0;
        const previous_token = if (s.runtime.workspaces.items.len > 0) s.model().revision else 0;
        try s.runtime.receive(s.connection, snapshot);
        if (previous_workspace != s.current().id or previous_token != s.model().revision) s.cancelDividers();
        if (previous_focus != 0 and previous_focus != (if (s.focused()) |p| p.id else 0)) {
            s.copy_mode = false;
            s.search_mode = false;
            s.selection = null;
            s.message_len = 0;
            s.native_notice = null;
        }
        s.reconcile();
    }
    pub fn reconcile(s: *Self) void {
        if (s.port_menu) |*links| {
            const count = sidebar.urlCount(s.portWorkspaceEntry(links.workspace));
            if (s.runtime.workspaces.index(links.workspace) == null or count == 0) {
                s.port_menu = null;
            } else links.selected = @min(links.selected, count - 1);
        }
        if (s.tab_menu) |context| if (if (context.pane) s.pane(context.tab) == null else if (context.workspace) s.runtime.workspaces.index(context.tab) == null else s.tabIndex(context.tab) == null) {
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
        if (s.name_dialog) |dialog| if ((dialog.target == .rename and s.tabIndex(dialog.target.rename) == null) or (dialog.target == .pane and s.pane(dialog.target.pane) == null)) s.dismissName();
        s.dirty = true;
    }
    pub fn expireInput(s: *Self) !void {
        if (s.link_tooltip.due(std.time.milliTimestamp())) s.dirty = true;
        if (s.copy_feedback_until != 0 and std.time.milliTimestamp() >= s.copy_feedback_until) {
            s.copy_feedback_until = 0;
            s.dirty = true;
        }
        const cl = &s.input_state;
        if (cl.attached and cl.keybuf.items.len > 0 and std.time.milliTimestamp() - cl.escape_at > @as(i64, if (cl.paste or cl.keybuf.items.len == 1) 40 else 1000)) {
            if (cl.paste) {
                if (cl.paste_pane) |id| if (s.pane(id)) |p| try s.sendInput(p.terminal, cl.keybuf.items);
            } else if (cl.keybuf.items.len == 1 and cl.keybuf.items[0] == 27) try s.key(27) else if (!s.hasMenu() and s.name_dialog == null and s.confirm == .none) {
                if (s.focused()) |p| try s.sendInput(p.terminal, cl.keybuf.items);
            }
            cl.keybuf.clearRetainingCapacity();
        }
    }
    fn linkTooltipReady(s: *Self) !bool {
        var target: ?@import("link_tooltip.zig").Target = null;
        if (s.pointer) |pointer| {
            if (!s.hasMenu() and s.menu() == null and s.name_dialog == null and s.confirm == .none and !s.copy_mode and s.selection == null and !s.ui_mouse_down) {
                var storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
                if (sidebar.gitWorkspace(s.sidebarView(0), s.workspaceEntries(&storage), pointer.x, pointer.y)) |ws| {
                    target = .{ .pane = ws.id, .link = 0, .git = true };
                }
                var locations: [layout.max_panes]layout.Placement = undefined;
                for (s.layoutView().placements(s.area(), &locations)) |place| {
                    if (!place.rect.contains(pointer.x, pointer.y)) continue;
                    const p = s.pane(place.id) orelse continue;
                    try p.terminal.updateRender();
                    for (p.terminal.hyperlinks()) |link| {
                        if (link.row == pointer.y - place.rect.y and link.start <= pointer.x - place.rect.x and pointer.x - place.rect.x < link.end and
                            (std.mem.startsWith(u8, link.uri, "http://") or std.mem.startsWith(u8, link.uri, "https://")))
                        {
                            target = .{ .pane = place.id, .link = link.id };
                            break;
                        }
                    }
                }
            }
        }
        return s.link_tooltip.ready(target, std.time.milliTimestamp());
    }
    pub fn frame(s: *Self) ![]u8 {
        var native_blocked: usize = 0;
        var native_finished: usize = 0;
        for (s.runtime.sessions) |session| switch (session.attention) {
            .needs_input => native_blocked += 1,
            .finished => native_finished += 1,
            .none => {},
        };
        var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.agentEntries(&agent_storage);
        var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
        return render.frame(s.layoutView(), s.runtime.panes.items, s.width, s.height, .{
            .pointer = s.pointer,
            .link_tooltip = try s.linkTooltipReady(),
            .message = s.message[0..s.message_len],
            .copy_feedback = s.copy_feedback_until > std.time.milliTimestamp(),
            .copy_mode = s.copy_mode,
            .native_blocked = native_blocked,
            .native_finished = native_finished,
            .menu = s.menu(),
            .tab_menu = s.tab_menu,
            .port_menu = s.port_menu,
            .tab_drop_x = s.tabDropX(),
            .dialog = s.name_dialog,
            .confirm = s.confirm != .none,
            .sidebar_open = s.sidebar_open,
            .corgi_badge = s.corgi_badge,
            .sidebar_width = s.sidebar_width,
            .workspace_drop_y = if (s.workspace_drag) |drag| drag.drop_y else null,
            .sidebar_offset = s.sidebar_offset,
            .agents = entries,
            .workspaces = s.workspaceEntries(&workspace_storage),
            .workspace_offset = s.workspace_offset,
        });
    }
};
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
