//! Viewer-owned navigation, dialogs, input and rendering. Shared mutations are RPC operations.
const std = @import("std");
const keys = @import("keys.zig");
const keyboard = @import("keyboard.zig");
const keymap = @import("keymap.zig");
const onboarding = @import("onboarding.zig");
const shortcut_help = @import("shortcut_help.zig");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const render = @import("render.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const agent_navigation = @import("agent_navigation.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const protocol = @import("protocol.zig");
const git_push = @import("git_push.zig");
const NativeId = @import("native.zig").Session.Id;
const mirror = @import("mirror.zig");
const rpc = @import("rpc.zig");
const navigation = @import("navigation.zig");
const corgi_badge = @import("corgi_badge.zig");
const sidebar_rows = @import("sidebar_rows.zig");
const agent_launcher = @import("agent_launcher.zig");
const launch_preview_stream = @import("launch_preview_stream.zig");
const corgi_setup = @import("corgi_setup.zig");
const link_tooltip = @import("link_tooltip.zig");
const resource_tooltip = @import("resource_tooltip.zig");
const preferences = @import("preferences.zig");
const agent_drag = @import("agent_drag.zig");
const workspace_drag = @import("workspace_drag.zig");
const clock = @import("clock.zig");
const launch_command = @import("launch_command.zig");
const ghostty_integration = @import("ghostty_integration.zig");
const subagent_tooltip = @import("subagent_tooltip.zig");
const vt = @import("terminal.zig").vt;
const Command = @import("session.zig").Command;
const BoundedText = @import("bounded_text.zig").BoundedText;
const Path = @import("bounded_text.zig").Path;
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
    workspace_id: WorkspaceId,
    tab_id: layout.TabId,
    start_x: u16,
    width: u16,
    tabs_x: u16,
    first: usize,
    ids: [layout.max_tabs]layout.TabId = undefined,
    count: usize,
    dragging: bool = false,
    cancelled: bool = false,
    drop: ?render.TabDrop = null,
};
/// A pressed link or port row, tracked until release confirms it wasn't a drag.
const PortClick = struct {
    x: u16,
    y: u16,
    url: BoundedText(4096) = .{},
    menu: ?WorkspaceId = null,
    pane: ?layout.PaneId = null,
    px: u16 = 0,
    py: u16 = 0,
    drag_selects: bool = false,
    cancelled: bool = false,
};
const InputState = struct {
    viewer_id: u32 = 0,
    last_control: u64 = 0,
    attached: bool = false,
    watched: bool = true,
    /// User input or a window resize since the last sync; the daemon sizes
    /// shared panes for the viewer that was used most recently.
    active: bool = false,
    port_click: ?PortClick = null,
    paste: bool = false,
    paste_pane: ?layout.PaneId = null,
    paste_to_name: bool = false,
    paste_to_picker: bool = false,
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
    const Terminal = mirror.Terminal;
    const Pane = mirror.Pane;
    connection: *rpc.Connection,
    runtime: mirror.Runtime = .{},
    navigation: navigation.State = .{},
    workspace_offset: usize = 0,
    input_state: InputState = .{},
    effects: std.ArrayList(Effect) = .empty,
    executable: []const u8,
    width: u16 = 100,
    height: u16 = 30,
    dirty: bool = true,
    prefix: bool = false,
    key_preset: keymap.Preset = .corgi,
    key_prefix: keymap.Prefix = .ctrl_b,
    onboarding: ?onboarding.State = null,
    help: shortcut_help.State = .{ .command_mode = true },
    help_visible: bool = false,
    workspace_chooser: ?usize = null,
    clipboard: ?[]const u8 = null,
    menu_page: usize = 0,
    menu_highlight: ?u8 = null,
    sidebar_open: bool = true,
    corgi_badge: corgi_badge.Mode = .none,
    supports_kitty_graphics: bool = false,
    sidebar_width: u16 = 28,
    sidebar_offset: usize = 0,
    sidebar_rows: sidebar_rows.State = .{},
    remote_links: bool = false,
    tab_menu: ?commands.TabMenu = null,
    port_menu: ?sidebar.PortMenu = null,
    agent_scope: sidebar.Scope = .workspace,
    /// Workspace ids whose group is folded in the grouped "All" list.
    folded_groups: [workspace.max_workspaces]WorkspaceId = undefined,
    folded_count: usize = 0,
    scope_menu: ?sidebar.ScopeMenu = null,
    agent_picker: ?agent_navigation.Picker = null,
    agent_launcher: ?agent_launcher.Menu = null,
    launcher_selection: ?agent_launcher.Row = null,
    launch_previews: launch_preview_stream.Stream = .{},
    corgi_setup: ?corgi_setup.Menu = null,
    launcher_hover_blocked: bool = false,
    pointer: ?render.Pointer = null,
    iterm2_pointer: bool = false,
    link_tooltip: link_tooltip.State = .{},
    git_hover: ?WorkspaceId = null,
    resource_card: resource_tooltip.State = .{},
    resource_aim: ?resource_tooltip.Aim = null,
    resource_prefs: preferences.Resources = .{},
    sleeping_corgis: bool = true,
    ui_mouse_down: bool = false,
    sidebar_drag: bool = false,
    agent_drag: ?agent_drag.Drag = null,
    workspace_drag: ?workspace_drag.Drag = null,
    resize_mode: bool = false,
    copy_mode: bool = false,
    name_dialog: ?naming.Dialog = null,
    confirm: enum { none, pane, tab } = .none,
    confirm_tab: ?layout.TabId = null,
    message: BoundedText(512) = .{},
    native_notice: ?NativeId = null,
    copy_feedback_until: i64 = 0,
    muted: bool = false,
    selection: ?struct { pane: layout.PaneId, x: u16, y: u16, moved: bool = false } = null,
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
    const Created = struct { pane: layout.PaneId, workspace: WorkspaceId };
    fn execute(s: *Self, command: Command) !Created {
        const response = try s.connection.call(.{ .op = "session.command", .protocol = 1, .command = command });
        defer response.deinit();
        const raw_result = response.value.object.get("result") orelse return error.InvalidResponse;
        const parsed = try std.json.parseFromValue(Created, a, raw_result, .{ .ignore_unknown_fields = true });
        defer parsed.deinit();
        const result = parsed.value;
        try s.refresh();
        if (s.runtime.panes.items.len == 0 and s.runtime.workspaces.items.len == 1) {
            s.input_state.attached = false;
        }
        s.dirty = true;
        return result;
    }
    fn edit(s: *Self, command: Command) !void {
        _ = try s.execute(command);
    }
    fn moveTab(s: *Self, id: layout.TabId, gap: usize) !void {
        if (navigation.moveTab(s.model(), id, gap)) |operation| try s.edit(operation);
    }

    pub fn switchWorkspace(s: *Self, id: WorkspaceId) !void {
        _ = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
        s.rememberAgent();
        if (s.input_state.tab_drag) |*drag| {
            drag.cancelled = true;
        }
        s.dismissName();
        s.closeMenu();
        s.navigation.workspace_id = id;
        s.visitWorkspace(id);
        s.revealWorkspace();
        // "All" lists the same agents in every workspace; keep its scroll.
        if (s.agent_scope == .workspace) s.sidebar_offset = 0;
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.confirm = .none;
        s.confirm_tab = null;
        s.message = .{};
        s.native_notice = null;
        s.rememberAgent();
        s.dirty = true;
    }
    fn closeWorkspace(s: *Self, id: WorkspaceId, close_contents: bool) !void {
        _ = s.runtime.workspaces.index(id) orelse return error.NoWorkspace;
        if (s.runtime.workspaces.items.len == 1) return error.LastWorkspace;

        try s.edit(.{ .@"workspace.close" = .{ .target = id, .close_contents = close_contents } });
        try s.switchWorkspace(s.current().id);
        return;
    }
    fn revealWorkspace(s: *Self) void {
        const capacity = s.sidebarView(&.{}).workspaceCapacity();
        const index = s.workspaceIndex();
        if (index < s.workspace_offset) s.workspace_offset = index else if (index >= s.workspace_offset + capacity) s.workspace_offset = index + 1 - capacity;
    }
    pub fn focusPane(s: *Self, id: layout.PaneId) !void {
        const owner = s.runtime.workspaces.owner(id) orelse return error.NoPane;
        s.rememberAgent();
        const workspace_id = owner.id;
        if (workspace_id != s.current().id) try s.switchWorkspace(workspace_id);
        try s.nav().focus(s.model(), id);
        s.native_notice = null;
        s.rememberAgent();
    }
    pub fn area(s: *Self) layout.Rect {
        return s.sidebarView(&.{}).area();
    }
    fn sidebarView(s: *Self, entries: []const sidebar.Entry) sidebar.View {
        const offset = if (s.agent_picker) |picker| picker.offset else s.sidebar_offset;
        var view = sidebar.View.init(s.width, s.height, s.sidebar_open, offset, entries.len).withSearch(s.agentSearch()).withWidth(s.sidebar_width);
        // Workspace rows, and so paging, depend on whether readings are shown.
        view.resources = s.resource_prefs;
        view = view.withWorkspaces(s.runtime.workspaces.items.len, s.workspace_offset).withEntries(entries);
        view.scope_label = s.scopeLabel();
        return view;
    }
    fn scopeLabel(s: *Self) []const u8 {
        return switch (s.agent_scope) {
            .workspace => s.current().name,
            .all => "all",
        };
    }
    fn inScope(s: *Self, id: WorkspaceId) bool {
        return switch (s.agent_scope) {
            .workspace => id == s.current().id,
            .all => true,
        };
    }
    fn setAgentScope(s: *Self, scope: sidebar.Scope) void {
        s.closeMenu();
        s.agent_scope = scope;
        s.sidebar_offset = 0;
        s.dirty = true;
        const lasting: @FieldType(preferences.Preferences, "agents") = switch (scope) {
            .workspace => .workspace,
            .all => .all,
        };
        var saved = preferences.load();
        saved.agents = lasting;
        preferences.save(saved) catch |err| s.notice(@errorName(err));
    }
    pub fn loadPreferences(s: *Self) void {
        const saved = preferences.load();
        s.key_preset = saved.preset;
        s.key_prefix = saved.prefix;
        s.sidebar_width = saved.sidebar_width;
        s.resource_prefs = saved.resources;
        s.sleeping_corgis = saved.sleeping_corgis;
        if (!saved.onboarding_complete) s.onboarding = .{ .preset = saved.preset, .prefix = saved.prefix };
        s.agent_scope = switch (saved.agents) {
            .workspace => .workspace,
            .all => .all,
        };
    }
    fn groupFolded(s: *Self, id: WorkspaceId) bool {
        return std.mem.indexOfScalar(WorkspaceId, s.folded_groups[0..s.folded_count], id) != null;
    }
    fn toggleGroup(s: *Self, id: WorkspaceId) void {
        if (std.mem.indexOfScalar(WorkspaceId, s.folded_groups[0..s.folded_count], id)) |index| {
            s.folded_groups[index] = s.folded_groups[s.folded_count - 1];
            s.folded_count -= 1;
        } else if (s.folded_count < s.folded_groups.len) {
            s.folded_groups[s.folded_count] = id;
            s.folded_count += 1;
        }
        s.sidebar_rows.discard();
        s.dirty = true;
    }
    fn openScopeMenu(s: *Self, pinned: bool) void {
        s.closeMenu();
        s.scope_menu = .{ .pinned = pinned };
        s.cancelDividers();
        s.selection = null;
        s.dirty = true;
    }
    fn pollScopeMenu(s: *Self) void {
        const side = s.sidebarView(&.{});
        const on_label = if (s.pointer) |p| side.hit(p.x, p.y) == .agent_scope else false;
        if (s.scope_menu) |open| {
            const inside = if (s.pointer) |p| sidebar.ScopeMenu.bounds(side, s.width, s.height).contains(p.x, p.y) else false;
            if (side.width == 0 or (!open.pinned and !on_label and !inside)) s.closeMenu();
        } else if (on_label and !s.launcher_hover_blocked and !s.hasMenu() and s.name_dialog == null and s.confirm == .none and !s.ui_mouse_down and !s.copy_mode) {
            s.openScopeMenu(false);
        }
    }
    fn agentSearch(s: *Self) ?sidebar.Search {
        if (s.agent_picker) |*picker| return .{ .text = picker.query.text[0..picker.query.len], .cursor = picker.query.cursor };
        return null;
    }
    pub fn inheritedCwd(s: *Self, ws: *protocol.Workspace, target: ?layout.PaneId) []const u8 {
        const id = target orelse if (ws.model.count > 0) ws.model.firstPane(ws.model.tabs[0].root) else return ws.cwd;
        const p = s.pane(id) orelse return ws.cwd;
        return p.cwd;
    }
    fn currentCwd(s: *Self) []const u8 {
        return s.inheritedCwd(s.current(), if (s.focused()) |p| p.id else null);
    }
    fn workspaceIds(s: *Self, out: *[workspace.max_workspaces]WorkspaceId) []WorkspaceId {
        for (s.runtime.workspaces.items, 0..) |ws, i| out[i] = ws.id;
        return out[0..s.runtime.workspaces.items.len];
    }
    pub fn workspaceEntries(s: *Self, out: *[workspace.max_workspaces]sidebar.WorkspaceEntry) []sidebar.WorkspaceEntry {
        for (s.runtime.workspaces.items, 0..) |*ws, i| {
            out[i] = .{
                .id = ws.id,
                .name = ws.name,
                .cwd = ws.cwd,
                .active = i == s.workspaceIndex(),
                .git_ahead = ws.git_ahead,
                .git_push = ws.git_push,
                .git_commits = ws.git_commits,
                .stats = ws.stats,
            };
            out[i].ports = s.runtime.ports;
            out[i].resources = s.runtime.resources.workspace(ws.id);
            out[i].remote_links = s.remote_links;
            for (s.runtime.panes.items) |p| {
                if (p.agent.provider == null or ws.model.tabForPane(p.id) == null) continue;
                out[i].agents += 1;
                if (p.agent.state == .working) out[i].working += 1;
                if (p.agent.state == .blocked or p.agent.attention == .needs_input) out[i].attention += 1;
                if (p.agent.observation.unread()) out[i].unread += 1;
            }
            for (s.runtime.sessions) |session| {
                if (session.workspace != ws.id) continue;
                out[i].agents += 1;
                if (session.state == .working) out[i].working += 1;
                if (session.state == .blocked or session.attention == .needs_input) out[i].attention += 1;
                if (session.observation.unread()) out[i].unread += 1;
            }
        }
        return out[0..s.runtime.workspaces.items.len];
    }
    pub fn agentEntries(s: *Self, entries: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
        var count: usize = 0;
        const focus = if (s.model().count > 0) s.nav().tab().focus else layout.PaneId.none;
        // "All" groups agents under a header per workspace that has any.
        const grouped = s.agent_scope == .all;
        var totals_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
        const totals: []const sidebar.WorkspaceEntry = if (grouped) s.workspaceEntries(&totals_storage) else &.{};
        for (s.runtime.workspaces.items, 0..) |*ws, ws_index| {
            if (!s.inScope(ws.id)) continue;
            if (grouped) {
                const total = totals[ws_index];
                if (total.agents == 0 or count == entries.len) continue;
                const folded = s.groupFolded(ws.id);
                const here = ws.id == s.current().id;
                // A folded header stands in for the focused agent it hides.
                entries[count] = .{
                    .target = .{ .group = ws.id },
                    .name = ws.name,
                    .provider = null,
                    .state = .idle,
                    .attention = .none,
                    .focused = folded and here and s.focusedAgent() != null,
                    .group = .{ .agents = total.agents, .working = total.working, .attention = total.attention, .folded = folded, .current = here },
                };
                count += 1;
                if (folded) continue;
            }
            const first_agent = count;
            for (ws.model.tabs[0..ws.model.count], 0..) |_, tab_index| {
                for (s.runtime.panes.items) |*p| {
                    if (p.agent.provider == null or ws.model.tabForPane(p.id) != tab_index or count == entries.len) continue;
                    entries[count] = .{
                        .conversation = p.agent.conversation,
                        .target = .{ .pane = p.id },
                        .name = if (p.label.len > 0) p.label else p.agent.name,
                        .provider = p.agent.provider,
                        .state = p.agent.state,
                        .attention = p.agent.attention,
                        .focused = s.native_notice == null and focus == p.id,
                        .cwd = if (p.agent.cwd.len > 0) p.agent.cwd else p.cwd,
                        .tool_active = p.agent.tool_active,
                        .compacting = p.agent.compacting,
                        .subagents = p.agent.subagents,
                        .unread = p.agent.observation.unread(),
                        .activity = p.agent.activity,
                    };
                    count += 1;
                }
            }
            for (s.runtime.sessions) |*session| {
                if (session.workspace != ws.id or count == entries.len) continue;
                entries[count] = .{
                    .target = .{ .native = session.id },
                    .provider = session.provider,
                    .state = session.state,
                    .attention = session.attention,
                    .focused = s.native_notice == session.id,
                    .cwd = session.cwd,
                    .tool_active = session.tool_active,
                    .unread = session.observation.unread(),
                };
                if (session.agent) |agent| {
                    entries[count].conversation = agent.conversation;
                    entries[count].subagents = agent.subagents;
                    entries[count].name = agent.name;
                    entries[count].activity = agent.activity;
                }
                count += 1;
            }
            std.sort.insertion(sidebar.Entry, entries[first_agent..count], ws.agent_order, sidebar.Entry.lessThan);
        }
        for (entries[0..count]) |*entry| {
            if (entry.target == .group) continue;
            subagent_tooltip.presentChildren(entry, s.runtime.conversations, std.time.microTimestamp());
            for (s.runtime.conversations) |conversation| if (conversation.id == entry.conversation) {
                entry.context = conversation.context;
                break;
            };
        }
        return entries[0..count];
    }
    fn sidebarEntries(s: *Self, entries: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
        var live: [sidebar.max_entries]sidebar.Entry = undefined;
        const list = switch (s.agent_scope) {
            .workspace => s.current().id,
            .all => @as(WorkspaceId, @enumFromInt(std.math.maxInt(u32))),
        };
        return s.sidebar_rows.update(list, s.agentEntries(&live), entries, std.time.milliTimestamp());
    }
    fn firstUnreadAgent(s: *Self, workspace_index: usize) ?sidebar.Target {
        const ws = &s.runtime.workspaces.items[workspace_index];
        for (ws.model.tabs[0..ws.model.count], 0..) |_, tab_index| {
            for (s.runtime.panes.items) |p| {
                if (p.agent.provider != null and ws.model.tabForPane(p.id) == tab_index and p.agent.observation.unread())
                    return .{ .pane = p.id };
            }
        }
        for (s.runtime.sessions) |session| {
            if (session.workspace == ws.id and session.observation.unread()) return .{ .native = session.id };
        }
        return null;
    }
    fn selectAgent(s: *Self, target: sidebar.Target) !void {
        s.rememberAgent();
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.message = .{};
        switch (target) {
            .pane => |id| {
                try s.focusPane(id);

                s.dirty = true;
            },
            .native => |id| for (s.runtime.sessions) |session| {
                if (session.id != id) continue;
                if (session.workspace != s.current().id) try s.switchWorkspace(session.workspace);
                try s.noticeNativeSession(session);
                break;
            },
            .group => |id| s.toggleGroup(id),
        }
        s.rememberAgent();
        var storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.sidebarEntries(&storage);
        if (agent_navigation.indexOf(entries, target)) |index| s.sidebar_offset = s.sidebarView(entries).reveal(index);
        s.dirty = true;
    }
    fn focusedAgent(s: *Self) ?sidebar.Target {
        if (s.native_notice) |id| {
            for (s.runtime.sessions) |session| if (session.id == id and session.workspace == s.current().id) return .{ .native = id };
        }
        if (s.focused()) |p| if (p.agent.provider != null) return .{ .pane = p.id };
        return null;
    }
    fn rememberAgent(s: *Self) void {
        if (s.runtime.workspaces.items.len == 0) return;
        const target = s.focusedAgent();
        s.navigation.agentHistory(&s.runtime.workspaces).observe(target);
    }
    fn navigateAgent(s: *Self, next: ?bool) !void {
        s.rememberAgent();
        var storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.agentEntries(&storage);
        const target = if (next) |forward| agent_navigation.relative(entries, s.focusedAgent(), forward) else s.navigation.agentHistory(&s.runtime.workspaces).destination(entries, s.focusedAgent());
        if (target) |value| try s.selectAgent(value) else s.notice(if (entries.len == 0) " No agents in this workspace" else " No previous agent in this workspace");
    }
    fn openAgentPicker(s: *Self) void {
        s.closeMenu();
        if (s.width < 40 or s.height < 13) {
            s.notice(" Agent search needs at least 40 columns and 13 rows");
            return;
        }
        s.sidebar_open = true;
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.agent_picker = .{ .workspace = s.current().id, .selected = s.focusedAgent(), .offset = s.sidebar_offset };
        s.dirty = true;
    }
    fn pickerEntries(s: *Self, out: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
        var storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.agentEntries(&storage);
        const picker = &s.agent_picker.?;
        const filtered = picker.list(entries, out);
        picker.reconcile(filtered, s.sidebarView(filtered).capacity);
        for (filtered) |*entry| entry.focused = std.meta.eql(picker.selected, @as(?sidebar.Target, entry.target));
        return filtered;
    }
    fn moveAgentPicker(s: *Self, next: bool) void {
        var storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = s.pickerEntries(&storage);
        s.agent_picker.?.move(entries, next, s.sidebarView(entries).capacity);
        s.dirty = true;
    }
    fn acceptAgentPicker(s: *Self) !void {
        var storage: [sidebar.max_entries]sidebar.Entry = undefined;
        _ = s.pickerEntries(&storage);
        const target = s.agent_picker.?.selected orelse return;
        s.closeMenu();
        try s.selectAgent(target);
    }
    fn pane(s: *Self, id: layout.PaneId) ?*Pane {
        return s.runtime.pane(id);
    }
    pub fn focused(s: *Self) ?*Pane {
        return if (s.model().count == 0) null else s.pane(s.nav().tab().focus);
    }
    pub fn notice(s: *Self, msg: []const u8) void {
        s.message = .ascii(msg);
        s.native_notice = null;
        s.dirty = true;
    }
    fn noticeNativeSession(s: *Self, session: protocol.Native) !void {
        var msg: [180]u8 = undefined;
        s.notice(try std.fmt.bufPrint(
            &msg,
            " {s} native session {d}: {s}. Inspect: corgi native events {d}",
            .{ @tagName(session.provider), @intFromEnum(session.id), @tagName(session.state), @intFromEnum(session.id) },
        ));
        s.native_notice = session.id;
    }
    pub fn menu(s: *Self) ?commands.ResizeView {
        if (!s.resize_mode) return null;
        var view = commands.ResizeView.init(s.width, s.height, s.menu_page, s.model().count > 0);
        view.highlighted = s.menu_highlight;
        return view;
    }
    fn hasMenu(s: *Self) bool {
        return s.onboarding != null or s.workspace_chooser != null or s.prefix or s.resize_mode or
            s.tab_menu != null or s.port_menu != null or s.agent_picker != null or
            s.agent_launcher != null or s.corgi_setup != null or s.scope_menu != null;
    }
    fn tabIndex(s: *Self, id: layout.TabId) ?usize {
        for (s.model().tabs[0..s.model().count], 0..) |tab, i| if (tab.id == id) return i;
        return null;
    }
    /// Whether a tab menu's target (pane, workspace, or tab) has disappeared.
    fn tabMenuStale(s: *Self, context: commands.TabMenu) bool {
        if (context.pane) return s.pane(@enumFromInt(context.tab)) == null;
        if (context.workspace) return s.runtime.workspaces.index(@enumFromInt(context.tab)) == null;
        return s.tabIndex(@enumFromInt(context.tab)) == null;
    }
    fn openTabMenu(s: *Self, index: usize, x: u16) void {
        s.closeMenu();
        s.search_mode = false;
        s.cancelDividers();
        s.selection = null;
        s.tab_menu = .{ .tab = @intFromEnum(s.model().tabs[index].id), .anchor_x = x };
    }
    fn tabMenuAction(s: *Self, key_: u8) !void {
        const context = s.tab_menu orelse return;
        const supported = for (context.entries()) |entry| {
            if (entry.key == key_) break true;
        } else false;
        if (!supported) return;
        s.closeMenu();
        if (context.pane) {
            const pane_id: layout.PaneId = @enumFromInt(context.tab);
            if (s.pane(pane_id) == null) return;
            if (key_ == 'T') {
                s.name_dialog = naming.Dialog.init(.{ .pane = pane_id }, s.pane(pane_id).?.label);
                s.dirty = true;
            } else if (key_ == 'C') {
                try s.renamePane(pane_id, "");
            } else if (key_ == 'X') {
                try s.close(pane_id);
            } else if (key_ == 's') {
                if (context.source) |raw_source| {
                    const source: layout.PaneId = @enumFromInt(raw_source);
                    if (s.model().tabForPane(source) != s.model().tabForPane(pane_id)) return;
                    try s.focusPane(source);
                    try s.edit(.{ .@"pane.swap" = .{ .target = source, .other = pane_id } });
                    s.dirty = true;
                }
            } else {
                try s.focusPane(pane_id);
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
            if (s.runtime.workspaces.index(@enumFromInt(context.tab)) == null) return;
            switch (key_) {
                'T' => s.beginWorkspace(@enumFromInt(context.tab)),
                'X' => s.closeWorkspace(@enumFromInt(context.tab), true) catch |err| s.notice(if (err == error.LastWorkspace) " Cannot close the last workspace" else " Could not close workspace"),
                else => {},
            }
            return;
        }
        s.rememberAgent();
        s.nav().active = s.tabIndex(@enumFromInt(context.tab)) orelse return;
        s.native_notice = null;
        s.rememberAgent();
        s.copy_mode = false;

        s.dirty = true;
        switch (key_) {
            'c' => try s.action("new", ""),
            'T' => s.beginRename(),
            'X' => try s.action("close-tab", ""),
            else => {},
        }
    }
    fn moveTabMenu(s: *Self, next: bool) void {
        if (s.tab_menu) |*context| context.move(next);
        s.dirty = true;
    }
    fn beginPrefix(s: *Self) void {
        s.closeMenu();
        s.cancelDividers();
        s.selection = null;
        s.prefix = true;
        s.help = .{ .command_mode = true };
    }
    fn openHelp(s: *Self) void {
        s.beginPrefix();
        s.help_visible = true;
    }
    fn closeMenu(s: *Self) void {
        s.help_visible = false;
        s.workspace_chooser = null;
        s.link_tooltip.cancel();
        s.agent_picker = null;
        s.closeLauncher();
        s.scope_menu = null;
        s.corgi_setup = null;
        s.launcher_hover_blocked = true;
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
    fn beginWorkspace(s: *Self, id: ?WorkspaceId) void {
        s.dismissName();
        const initial = if (id) |value| s.runtime.workspaces.items[s.runtime.workspaces.index(value) orelse return].custom_name else "";
        s.name_dialog = naming.Dialog.init(.{ .workspace_name = id }, initial);
        s.prepareName();
    }
    fn newWorkspace(s: *Self, name: []const u8, cwd: []const u8) !WorkspaceId {
        const id = (try s.execute(.{ .@"workspace.create" = .{ .name = name, .cwd = cwd } })).workspace;
        try s.switchWorkspace(id);
        return id;
    }
    fn beginRename(s: *Self) void {
        if (s.model().count == 0) return;
        const tab = s.selectedTab();
        s.dismissName();
        s.name_dialog = naming.Dialog.init(.{ .rename = tab.id }, tab.title.text());
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
        s.name_dialog = null;
    }
    fn renamePane(s: *Self, id: layout.PaneId, name: []const u8) !void {
        try s.edit(.{ .@"pane.rename" = .{ .target = id, .name = name } });
    }
    fn finishName(s: *Self, save: bool) void {
        s.dirty = true;
        if (save) if (s.name_dialog) |*dialog| {
            switch (dialog.target) {
                .agent_command => |index| {
                    if (dialog.overflow) {
                        dialog.failed = true;
                        return;
                    }
                    _ = s.execute(.{ .@"agent.command" = .{ .index = index, .command = dialog.name(), .hidden = s.runtime.agent_commands[index].hidden } }) catch {
                        dialog.failed = true;
                        return;
                    };
                },
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
            }
        };
        const command_dialog = if (s.name_dialog) |dialog| dialog.target == .agent_command else false;
        s.dismissName();
        if (command_dialog) {
            s.openLauncher(true);
            s.agent_launcher.?.managing = true;
            s.agent_launcher.?.selected = .add;
            s.agent_launcher.?.normalize();
        }
        s.message = .{};
    }
    fn create(s: *Self, split: ?layout.Axis, cwd: []const u8, command: ?[]const u8, title: []const u8) !layout.PaneId {
        const operation: Command = if (split) |axis|
            .{ .@"pane.split" = .{
                .target = if (s.model().count > 0) s.nav().tab().focus else layout.PaneId.none,
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
    pub fn close(s: *Self, id: layout.PaneId) !void {
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
                try s.noticeNativeSession(session);
                return;
            };
        }
        s.notice(" Nothing needs your attention");
    }
    /// Controller-level action names. Anything else is tried as a `navigation.Action`.
    pub const Action = enum { onboard, @"workspace-next", @"workspace-prev", new, sidebar, mute, @"undo-close", attention, split, zoom, close, @"close-tab" };
    pub fn action(s: *Self, name: []const u8, value: []const u8) !void {
        s.message = .{};
        if (std.meta.stringToEnum(Action, name)) |act| switch (act) {
            .onboard => return s.openOnboarding(.welcome),
            .@"workspace-next", .@"workspace-prev" => {
                const count = s.runtime.workspaces.items.len;
                const index = if (act == .@"workspace-next") (s.workspaceIndex() + 1) % count else (s.workspaceIndex() + count - 1) % count;
                return s.switchWorkspace(s.runtime.workspaces.items[index].id);
            },
            .new => {
                s.openLauncher(true);
                s.copy_mode = false;
            },
            .sidebar => {
                s.sidebar_open = !s.sidebar_open;
                s.selection = null;
                s.cancelDividers();
                s.dirty = true;
            },
            .mute => {
                s.muted = !s.muted;
                s.notice(if (s.muted) " Dings muted; attention markers remain on" else " Dings enabled");
            },
            .@"undo-close" => return s.undoClose(),
            .attention => return s.attention(),
            .split, .zoom, .close, .@"close-tab" => {
                if (s.model().count == 0) return error.NoPane;
                switch (act) {
                    .split => _ = try s.create(if (std.mem.eql(u8, value, "down")) .vertical else .horizontal, s.currentCwd(), null, ""),
                    .zoom => s.nav().tab().zoom = !s.nav().tab().zoom,
                    .close => try s.close(s.nav().tab().focus),
                    .@"close-tab" => try s.edit(.{ .@"tab.close" = .{ .target = s.selectedTab().id } }),
                    else => unreachable,
                }
            },
        } else {
            if (s.model().count == 0) return error.NoPane;
            const nav_action = std.meta.stringToEnum(navigation.Action, name) orelse return error.UnknownAction;
            const intent = try s.navigation.command(&s.runtime.workspaces, nav_action, value, s.area());
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
        if (s.clipboard) |old| a.free(old);
        s.clipboard = null;
        s.clipboard = try a.dupe(u8, text);
        const encoded = try a.alloc(u8, std.base64.standard.Encoder.calcSize(text.len));
        defer a.free(encoded);
        _ = std.base64.standard.Encoder.encode(encoded, text);
        const osc = try std.fmt.allocPrint(a, "\x1b]52;c;{s}\x07", .{encoded});
        try s.queueEffect(.{ .write_terminal = osc });
        s.copy_feedback_until = clock.milliTimestamp() + 2000;
        s.dirty = true;
    }
    fn launchAgent(s: *Self, provider: ?agents.Provider) !void {
        var cwd: [std.fs.max_path_bytes]u8 = undefined;
        const dir = if (s.agent_launcher) |*launch| launch.cwd.text() else s.currentCwd();
        if (dir.len > cwd.len) return error.NameTooLong;
        @memcpy(cwd[0..dir.len], dir);
        const len = dir.len;
        s.closeMenu();
        s.launcher_selection = .of(provider orelse s.runtime.last_agent);
        const created = s.execute(.{ .@"agent.create" = .{ .workspace = s.current().id, .cwd = cwd[0..len], .provider = provider } }) catch |err| {
            s.notice(@errorName(err));
            return;
        };
        try s.focusPane(created.pane);
        s.dirty = true;
    }
    fn launchRow(s: *Self, row: agent_launcher.Row) !void {
        if (s.agent_launcher) |*launch| {
            if (!launch.managing and row != .manage) launch.selected = row;
            if (launch.managing and row == .add) return s.saveInlineCommand();
            if (launch.managing and row.custom() != null) {
                launch.edit(row);
                s.dirty = true;
                return;
            }
            if (!launch.managing) if (row.custom()) |index| {
                const created = try s.execute(.{ .@"agent.command.create" = .{ .workspace = launch.workspace, .cwd = launch.cwd.text(), .index = index } });
                s.closeMenu();
                try s.focusPane(created.pane);
                s.dirty = true;
                return;
            };
            if (row == .manage) {
                s.rememberLauncherSelection();
                launch.managing = !launch.managing;
                launch.selected = if (launch.managing) .add else s.launcher_selection orelse launch.first();
                launch.normalize();
                launch.pinned = true;
                s.dirty = true;
                return;
            }
            if (launch.managing) {
                if (row.agent()) |provider| {
                    var hidden = s.runtime.agent_hidden;
                    hidden[@intFromEnum(provider)] = !hidden[@intFromEnum(provider)];
                    _ = try s.execute(.{ .@"agent.visibility" = .{ .hidden = hidden } });
                    s.agent_launcher.?.hidden = hidden;
                    s.agent_launcher.?.pinned = true;
                    s.dirty = true;
                }
                return;
            }
        }
        if (row.agent()) |provider| return s.launchAgent(provider);
        var cwd: [std.fs.max_path_bytes]u8 = undefined;
        const dir = if (s.agent_launcher) |*launch| launch.cwd.text() else s.currentCwd();
        if (dir.len > cwd.len) return error.NameTooLong;
        @memcpy(cwd[0..dir.len], dir);
        s.closeMenu();
        _ = try s.create(null, cwd[0..dir.len], null, "");
        s.copy_mode = false;
    }
    fn previewInlineCommand(s: *Self, immediate: bool) void {
        const launch = if (s.agent_launcher) |*value| value else return;
        if (!launch.managing) return;
        const now = clock.milliTimestamp();
        if (!std.mem.eql(u8, launch.draft.text(), launch.editor.name())) {
            launch.draft.set(launch.editor.name()) catch return;
            launch.draft_changed = now;
            launch.request_id = std.crypto.random.int(u32) | 1;
            launch.resolution_checked = 0;
            launch.resolution = .{};
            launch.save_requested = false;
            s.dirty = true;
        }
        if (launch.draft.command.len == 0 or launch.editor.overflow or !launch.resolution.pending) return;
        if (!immediate and now - launch.draft_changed < 350) return;
        if (now - launch.resolution_checked < 100) return;
        launch.resolution_checked = now;
        const response = s.connection.call(.{
            .op = "agent.command.preview",
            .protocol = 1,
            .workspace = launch.workspace,
            .cwd = launch.cwd.text(),
            .request = launch.request_id,
            .command = launch.draft.text(),
        }) catch return;
        defer response.deinit();
        const value = response.value.object.get("resolution") orelse return;
        const parsed = std.json.parseFromValue(launch_command.Resolution, a, value, .{}) catch return;
        defer parsed.deinit();
        launch.resolution = parsed.value;
        if (!launch.resolution.pending and !launch.name_customized and launch.resolution.error_message.len == 0) {
            launch.name_editor = naming.Dialog.init(.{ .rename = @enumFromInt(0) }, launch.resolution.semantics.suggested_name.text());
        }
        s.dirty = true;
    }
    fn deleteLauncherCommand(s: *Self, index: usize) !void {
        _ = try s.execute(.{ .@"agent.command" = .{ .index = index, .command = "", .resolve = false } });
        if (s.agent_launcher) |*launch| {
            launch.commands = s.runtime.agent_commands;
            if (launch.edit_index == index) launch.edit(.add);
            launch.normalize();
        }
        s.dirty = true;
    }
    fn saveInlineCommand(s: *Self) !void {
        const launch = if (s.agent_launcher) |*value| value else return;
        const index = launch.edit_index orelse launch.emptyCommand() orelse {
            launch.editor.failed = true;
            s.dirty = true;
            return;
        };
        if (launch.editor.overflow or (launch.editor.name().len == 0 and launch.edit_index == null)) {
            launch.editor.failed = true;
            s.dirty = true;
            return;
        }
        s.previewInlineCommand(true);
        if (launch.editor.name().len > 0 and launch.resolution.pending) {
            launch.save_requested = true;
            return;
        }
        launch.save_requested = false;
        if (launch.editor.name().len > 0 and launch.resolution.error_message.len > 0) {
            launch.save_error = launch.resolution.error_message;
            launch.editor.failed = true;
            s.dirty = true;
            return;
        }
        launch.save_error = .{};
        const hidden = if (launch.edit_index) |i| launch.commands[i].hidden else false;
        _ = s.execute(.{ .@"agent.command" = .{
            .index = index,
            .command = if (launch.editor.name().len == 0) "" else launch.resolution.command.text(),
            .hidden = hidden,
            .resolve = false,
            .original = launch.editor.name(),
            .name = if (launch.name_editor.name().len > 0) launch.name_editor.name() else launch.resolution.semantics.suggested_name.text(),
            .semantics = launch.resolution.semantics,
        } }) catch {
            launch.save_error = .ascii("Could not resolve shorthand. Paste its underlying command.");
            launch.editor.failed = true;
            s.dirty = true;
            return;
        };
        if (launch.edit_provider) |provider| {
            var visibility = s.runtime.agent_hidden;
            visibility[@intFromEnum(provider)] = true;
            _ = try s.execute(.{ .@"agent.visibility" = .{ .hidden = visibility } });
            launch.hidden = visibility;
        }
        launch.commands = s.runtime.agent_commands;
        launch.edit(.add);
        s.dirty = true;
    }
    fn toggleCommandVisibility(s: *Self, index: usize) !void {
        const entry = s.runtime.agent_commands[index];
        _ = try s.execute(.{ .@"agent.command" = .{ .index = index, .command = entry.text(), .hidden = !entry.hidden, .resolve = false } });
        if (s.agent_launcher) |*launch| {
            launch.commands[index].hidden = !entry.hidden;
            launch.pinned = true;
        }
        s.dirty = true;
    }
    fn toggleLauncherYolo(s: *Self, provider: agents.Provider) !void {
        const enabled = !s.runtime.agent_yolo[@intFromEnum(provider)];
        _ = try s.execute(.{ .@"agent.yolo" = .{ .provider = provider, .enabled = enabled } });
        if (s.agent_launcher) |*launch| {
            launch.yolo[@intFromEnum(provider)] = enabled;
            launch.selected = .of(provider);
            launch.pinned = true;
        }
        s.dirty = true;
    }
    fn rememberLauncherSelection(s: *Self) void {
        if (s.agent_launcher) |launch| {
            if (!launch.managing and launch.selected != .manage and launch.selected != .add) s.launcher_selection = launch.selected;
        }
    }
    fn closeLauncher(s: *Self) void {
        s.rememberLauncherSelection();
        s.agent_launcher = null;
    }
    fn openLauncher(s: *Self, pinned: bool) void {
        s.closeMenu();
        const cwd = s.currentCwd();
        var launch: agent_launcher.Menu = .{
            .workspace = s.current().id,
            .cwd = Path.init(cwd) catch return,
            .selected = s.launcher_selection orelse .of(s.runtime.last_agent),
            .last = s.runtime.last_agent,
            .yolo = s.runtime.agent_yolo,
            .hidden = s.runtime.agent_hidden,
            .commands = s.runtime.agent_commands,
            .pinned = pinned,
        };
        launch.preview = s.launch_previews.current(cwd);
        launch.normalize();
        s.agent_launcher = launch;
        s.cancelDividers();
        s.selection = null;
        s.dirty = true;
    }
    fn newAgentShortcut(s: *Self) !void {
        if (s.agent_launcher) |launch| {
            if (launch.pinned) {
                try s.launchRow(launch.selected);
                return;
            }
            s.agent_launcher.?.pinned = true;
            s.dirty = true;
            return;
        }
        s.sidebar_open = true;
        s.openLauncher(true);
    }
    fn moveLauncher(s: *Self, next: bool, wrap: bool) void {
        if (s.agent_launcher) |*launch| {
            launch.move(next, wrap);
            launch.pinned = true;
        }
        s.dirty = true;
    }
    fn selectLauncher(s: *Self, row: agent_launcher.Row) void {
        if (s.agent_launcher) |*launch| {
            launch.selected = row;
            launch.normalize();
            launch.pinned = true;
        }
        s.dirty = true;
    }
    fn trackLauncherUsage(s: *Self, provider: agents.Provider) void {
        const launch = if (s.agent_launcher) |*value| value else return;
        // Tracking asks for access to Claude's stored credentials.
        switch (provider) {
            .claude => {},
            .codex => return,
        }
        if (!launch.trackable(.of(provider))) return;
        launch.pinned = true;
        const response = s.connection.call(.{ .op = "agent.track_usage", .protocol = 1, .workspace = launch.workspace, .cwd = launch.cwd.text() }) catch return;
        defer response.deinit();
        launch.preview.pending = true;
        s.launch_previews.pending(launch.cwd.text());
        s.dirty = true;
    }
    fn pollLauncher(s: *Self) !void {
        s.updateLaunchPreview();
        s.previewInlineCommand(false);
        if (s.agent_launcher) |launch| {
            if (launch.managing and launch.save_requested and !launch.resolution.pending) try s.saveInlineCommand();
        }
        const side = s.sidebarView(&.{});
        const on_button = if (s.pointer) |p| switch (side.hit(p.x, p.y)) {
            .agent_new, .agent_options => true,
            else => false,
        } else false;
        if (s.agent_launcher) |*launch| {
            launch.yolo = s.runtime.agent_yolo;
            launch.hidden = s.runtime.agent_hidden;
            launch.commands = s.runtime.agent_commands;
            launch.normalize();
            if (launch.workspace != s.current().id or (side.width == 0 and !launch.pinned)) {
                s.closeLauncher();
                return;
            }
            const inside = if (s.pointer) |p| launch.bounds(s.width, s.height, side).contains(p.x, p.y) else false;
            if (!launch.pinned and !on_button and !inside) {
                s.closeMenu();
                return;
            }
            launch.last = s.runtime.last_agent;
        } else if (on_button and !s.launcher_hover_blocked and !s.hasMenu() and s.name_dialog == null and s.confirm == .none and !s.ui_mouse_down and !s.copy_mode) {
            s.openLauncher(false);
        }
    }
    pub fn updateLaunchPreview(s: *Self) void {
        const cwd = if (s.agent_launcher) |*launch| launch.cwd.text() else s.currentCwd();
        if (!s.launch_previews.poll(s.current().id, cwd)) return;
        if (s.agent_launcher) |*launch| {
            launch.preview = s.launch_previews.current(launch.cwd.text());
            launch.normalize();
        }
        s.dirty = true;
    }
    fn portWorkspaceEntry(s: *Self, id: WorkspaceId) sidebar.WorkspaceEntry {
        return .{ .id = id, .name = "", .cwd = "", .active = false, .ports = s.runtime.ports, .remote_links = s.remote_links };
    }
    fn openSetup(s: *Self) void {
        s.closeMenu();
        s.corgi_setup = corgi_setup.Menu.open(s.runtime.inference);
        s.corgi_setup.?.integration = if (s.remote_links) .unavailable else ghostty_integration.state();
        s.corgi_setup.?.preset = s.key_preset;
        s.corgi_setup.?.prefix = s.key_prefix;
        s.corgi_setup.?.resources = s.resource_prefs;
        s.corgi_setup.?.sleeping_corgis = s.sleeping_corgis;
        s.dirty = true;
    }
    pub fn openOnboarding(s: *Self, mode: onboarding.Mode) void {
        // Repeated commands must preserve an open wizard and any active import.
        if (s.onboarding != null) return;
        s.dismissName();
        s.closeMenu();
        s.confirm = .none;
        s.confirm_tab = null;
        s.copy_mode = false;
        s.search_mode = false;
        s.selection = null;
        s.cancelDividers();
        s.onboarding = .start(mode, s.key_preset, s.key_prefix);
        s.dirty = true;
    }
    fn applySetup(s: *Self, choice: corgi_setup.Choice) void {
        if (choice == .keyboard or choice == .import) {
            return s.openOnboarding(if (choice == .keyboard) .keyboard else .import);
        }
        if (choice == .readings) {
            s.resource_prefs.enabled = !s.resource_prefs.enabled;
            if (s.corgi_setup) |*setup| setup.resources = s.resource_prefs;
            var saved = preferences.load();
            saved.resources = s.resource_prefs;
            preferences.save(saved) catch |err| s.notice(@errorName(err));
            s.dirty = true;
            return;
        }
        if (choice == .sleeping_corgis) {
            s.sleeping_corgis = !s.sleeping_corgis;
            if (s.corgi_setup) |*setup| setup.sleeping_corgis = s.sleeping_corgis;
            var saved = preferences.load();
            saved.sleeping_corgis = s.sleeping_corgis;
            preferences.save(saved) catch |err| s.notice(@errorName(err));
            s.dirty = true;
            return;
        }
        if (choice == .ghostty) {
            const integration_state = if (s.remote_links) ghostty_integration.State.unavailable else ghostty_integration.state();
            s.dirty = true;
            if (integration_state == .unavailable) {
                s.notice(" Ghostty integration requires a local macOS viewer");
                return;
            }
            if (integration_state == .failed) {
                s.notice(" Could not read Ghostty config; no changes made");
                return;
            }
            ghostty_integration.setEnabled(integration_state != .enabled) catch |err| {
                var message: [160]u8 = undefined;
                s.notice(std.fmt.bufPrint(&message, " Ghostty integration: {s}", .{@errorName(err)}) catch "Ghostty config update failed");
                return;
            };
            if (s.corgi_setup) |*setup| setup.integration = ghostty_integration.state();
            s.notice(if (integration_state == .enabled) " Ghostty integration disabled. Reload Ghostty: Cmd+Shift+," else " Ghostty integration enabled. Reload Ghostty: Cmd+Shift+,");
            return;
        }
        // The setup screen stays open; the daemon republishes status, which
        // moves the "in use" marker.
        s.dirty = true;
        const response = s.connection.call(.{ .op = "inference.configure", .protocol = 1, .choice = @tagName(choice) }) catch {
            s.notice(" Corgi setup: the runtime did not accept the change");
            return;
        };
        defer response.deinit();
        const saved = if (response.value.object.get("saved")) |value| value == .bool and value.bool else false;
        var buffer: [128]u8 = undefined;
        const label = switch (choice) {
            .ghostty, .keyboard, .import, .readings, .sleeping_corgis => unreachable,
            .auto => "Auto (follows your agents)",
            .off => "Off",
            else => choice.provider().?.info().label,
        };
        s.notice(std.fmt.bufPrint(&buffer, " Summaries and link names: {s}{s}", .{ label, if (saved) "" else " (not saved for next start)" }) catch "");
    }
    fn movePortMenu(s: *Self, next: bool) void {
        if (s.port_menu) |*links| {
            const count = sidebar.urlCount(s.portWorkspaceEntry(links.workspace));
            links.selected = if (next) @min(links.selected + 1, count -| 1) else links.selected -| 1;
            s.dirty = true;
        }
    }
    fn finishOnboarding(s: *Self) !void {
        const wizard = if (s.onboarding) |*w| w else return;
        if (wizard.cancelled) {
            wizard.deinit();
            s.onboarding = null;
            s.dirty = true;
            return;
        }
        var saved = preferences.load();
        saved.preset = wizard.preset;
        saved.prefix = wizard.prefix;
        saved.onboarding_complete = true;
        preferences.save(saved) catch |err| {
            wizard.fail(err);
            s.dirty = true;
            return;
        };
        s.key_preset = saved.preset;
        s.key_prefix = saved.prefix;
        const target = wizard.progress.workspace;
        const mode = wizard.mode;
        wizard.deinit();
        s.onboarding = null;
        if (mode == .keyboard) {
            var message: [96]u8 = undefined;
            s.notice(if (saved.preset == .cmux)
                " Shortcuts: cmux. Reload Ghostty: Cmd+Shift+,"
            else
                std.fmt.bufPrint(&message, " Shortcuts: {s} · prefix {s}", .{ keymap.name(saved.preset), if (saved.prefix == .ctrl_b) "Ctrl+B" else "Ctrl+A" }) catch "");
        } else if (target) |id| {
            try s.refresh();
            try s.switchWorkspace(id);
            if (s.model().count == 0) s.openLauncher(true);
        } else if (mode == .welcome) s.openLauncher(true);
        s.dirty = true;
    }
    fn cyclePane(s: *Self, next: bool) !void {
        if (s.model().count == 0) return;
        var places: [layout.max_panes]layout.Placement = undefined;
        var selection = s.nav().*;
        selection.tab().zoom = false;
        const view = layout.View{ .model = s.model(), .selection = &selection };
        const list = view.placements(s.area(), &places);
        if (list.len == 0) return;
        const index = for (list, 0..) |p, i| {
            if (p.id == s.nav().tab().focus) break i;
        } else 0;
        try s.focusPane(list[if (next) (index + 1) % list.len else (index + list.len - 1) % list.len].id);
    }
    fn dispatchKey(s: *Self, byte: u8) !void {
        s.prefix = false;
        s.dirty = true;
        switch (byte) {
            'w' => s.beginWorkspace(null),
            'W' => s.beginWorkspace(s.current().id),
            '}' => try s.action("workspace-next", ""),
            '{' => try s.action("workspace-prev", ""),
            'c' => try s.action("new", ""),
            'a', 'A', 1 => s.openLauncher(true),
            'u' => try s.action("undo-close", ""),
            'v', '%' => try s.action("split", "right"),
            '-', '"' => try s.action("split", "down"),
            'h', 'j', 'k', 'l' => try s.action("focus", direction(byte).?),
            'H', 'J', 'K', 'L' => try s.action("swap", direction(std.ascii.toLower(byte)).?),
            'n' => try s.action("next", ""),
            'p' => try s.action("prev", ""),
            '1'...'9' => try s.action("tab", &.{byte}),
            'z' => try s.action("zoom", ""),
            'f' => try s.action("attention", ""),
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
            'g' => s.openAgentPicker(),
            'i', 'C' => s.openSetup(),
            '[' => try s.navigateAgent(false),
            ']' => try s.navigateAgent(true),
            9 => try s.navigateAgent(null),
            's' => {
                s.copy_mode = true;
                s.dirty = true;
            },
            'q', 'd' => s.input_state.attached = false,
            '?' => s.openHelp(),
            keymap.workspace_picker => {
                s.closeMenu();
                s.workspace_chooser = s.workspaceIndex();
            },
            keymap.cycle_next => try s.cyclePane(true),
            keymap.cycle_prev => try s.cyclePane(false),
            keymap.close_workspace => try s.closeWorkspace(s.current().id, true),
            keymap.paste => if (s.clipboard) |text| {
                if (s.focused()) |p| {
                    const bracketed = p.terminal.emulator().*.modes.get(.bracketed_paste);
                    if (bracketed) try s.sendInput(p.terminal, "\x1b[200~");
                    try s.sendInput(p.terminal, text);
                    if (bracketed) try s.sendInput(p.terminal, "\x1b[201~");
                }
            },
            245 => if (s.model().count > 9) {
                s.nav().active = 9;
            },
            else => {},
        }
    }
    fn key(s: *Self, byte: u8) !void {
        const cl = &s.input_state;
        if (s.onboarding) |*wizard| {
            if (byte == 3) {
                cl.attached = false;
                return;
            }
            const done = wizard.key(byte, s.connection) catch |err| {
                wizard.fail(err);
                s.dirty = true;
                return;
            };
            if (done) try s.finishOnboarding();
            s.dirty = true;
            return;
        }
        if (s.workspace_chooser) |index| {
            switch (byte) {
                27 => s.closeMenu(),
                'j', 14, 9 => s.workspace_chooser = @min(index + 1, s.runtime.workspaces.items.len -| 1),
                'k', 16 => s.workspace_chooser = index -| 1,
                13 => try s.switchWorkspace(s.runtime.workspaces.items[index].id),
                else => {},
            }
            s.dirty = true;
            return;
        }
        if (s.scope_menu != null) {
            s.closeMenu();
            if (byte == 27) return;
        }
        if (s.corgi_setup) |*setup| {
            switch (byte) {
                27, 'q' => s.closeMenu(),
                13, ' ' => s.applySetup(setup.selected),
                'j', 14, 9 => setup.move(true),
                'k', 16 => setup.move(false),
                else => {},
            }
            s.dirty = true;
            return;
        }
        if (s.agent_launcher) |launch| {
            if (launch.managing and launch.selected == .add) {
                switch (byte) {
                    9 => s.agent_launcher.?.name_focused = !launch.name_focused,
                    14 => s.moveLauncher(true, false),
                    16 => s.moveLauncher(false, false),
                    27 => try s.launchRow(.manage),
                    13 => try s.saveInlineCommand(),
                    else => {
                        if (launch.name_focused) s.agent_launcher.?.name_customized = true;
                        _ = s.agent_launcher.?.input().key(byte);
                    },
                }
                s.dirty = true;
                return;
            }
            if (launch.pinned and byte == keymap.prefixByte(s.key_prefix)) {
                s.agent_launcher.?.prefix = true;
                return;
            }
            s.agent_launcher.?.prefix = false;
            if (launch.prefix and (byte == 'c' or byte == 'a' or byte == 'A')) return;
            if (launch.pinned and byte == 20 and s.key_preset == .corgi) return;
            const recognized = switch (byte) {
                27, 13, 9, 14, 16, 'a', 'A', 1, 'y', 't' => true,
                'u' => launch.trackable(launch.selected) or launch.shortcutRow(byte) != null,
                else => launch.shortcutRow(byte) != null,
            };
            if (!launch.pinned and !recognized) {
                s.closeMenu();
            } else {
                s.agent_launcher.?.pinned = true;
                switch (byte) {
                    27 => s.closeMenu(),
                    13, 'a', 'A', 1 => try s.launchRow(launch.selected),
                    9 => s.moveLauncher(true, true),
                    'j', 14 => s.moveLauncher(true, false),
                    'k', 16 => s.moveLauncher(false, false),
                    '0'...'9' => if (launch.shortcutRow(byte)) |row| try s.launchRow(row),
                    't' => try s.launchRow(.terminal),
                    'y' => if (!launch.managing) if (launch.selected.agent()) |provider| try s.toggleLauncherYolo(provider),
                    'u' => if (launch.trackable(launch.selected)) s.trackLauncherUsage(launch.selected.agent().?),
                    else => if (agent_launcher.keyAgent(byte)) |provider| {
                        if (!launch.managing and launch.shown(.of(provider))) try s.launchAgent(provider);
                    },
                }
                return;
            }
        }
        if (s.agent_picker != null) {
            switch (byte) {
                27 => s.closeMenu(),
                13 => try s.acceptAgentPicker(),
                9, 14 => s.moveAgentPicker(true),
                16 => s.moveAgentPicker(false),
                else => {
                    _ = s.agent_picker.?.query.key(byte);
                    var storage: [sidebar.max_entries]sidebar.Entry = undefined;
                    _ = s.pickerEntries(&storage);
                },
            }
            s.dirty = true;
            return;
        }
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
        if (s.workspace_drag) |*drag| {
            drag.cancelled = true;
            drag.drop = null;
            drag.preview = null;
            s.dirty = true;
        }
        if (s.agent_drag) |*drag| {
            drag.cancelled = true;
            drag.drop = null;
            drag.preview = null;
            s.dirty = true;
        }
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
                2 => s.beginPrefix(),
                else => {},
            }
            return;
        }
        if (s.search_mode) {
            if (byte == 27) {
                s.search_mode = false;
                s.message = .{};
            } else if (byte == 13) {
                s.search_mode = false;
                s.search_skip = 0;
                s.message = .{};
                if (s.focused()) |p| if (!try p.terminal.search(s.search_text[0..s.search_len], 0)) s.notice(" No matches");
            } else if (byte == 127) {
                s.search_len -|= 1;
            } else if (byte >= 32 and byte < 127 and s.search_len < s.search_text.len) {
                s.search_text[s.search_len] = byte;
                s.search_len += 1;
            }
            if (s.search_mode) {
                s.message = .initTruncated("/");
                s.message.append(s.search_text[0..s.search_len]);
            }
            s.dirty = true;
            return;
        }
        if (s.confirm != .none) {
            const pending = s.confirm;
            const target = s.confirm_tab;
            s.confirm = .none;
            s.confirm_tab = null;
            s.message = .{};
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
            if (s.help_visible and (byte == 14 or byte == 16)) {
                s.help.move(byte == 14, 1);
                s.dirty = true;
                return;
            }
            s.prefix = false;
            s.dirty = true;
            if (byte == keymap.prefixByte(s.key_prefix)) {
                if (s.focused()) |p| try s.sendInput(p.terminal, &.{byte});
                return;
            }
            if (keymap.resolve(s.key_preset, byte)) |action_key| try s.dispatchKey(action_key);
            return;
        }
        if (byte == keymap.prefixByte(s.key_prefix)) {
            s.beginPrefix();
            return;
        }
        if (byte == 20 and s.key_preset == .corgi and !s.copy_mode) {
            s.openLauncher(true);
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
        if (data.len > 0) cl.active = true;
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
                    if (s.agent_launcher != null and s.agent_launcher.?.managing and s.agent_launcher.?.selected == .add) {
                        if (s.agent_launcher.?.name_focused) s.agent_launcher.?.name_customized = true;
                        s.agent_launcher.?.input().pasteByte(rest[0]);
                    } else if (cl.paste_to_picker and s.agent_picker != null) {
                        if (rest[0] >= 32 and rest[0] < 127) try s.key(rest[0]);
                    } else if (cl.paste_to_name and s.name_dialog != null) {
                        s.name_dialog.?.pasteByte(rest[0]);
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
                    if (s.onboarding == null and s.name_dialog == null and s.workspace_chooser == null and (s.prefix or !s.hasMenu())) {
                        if (keymap.modified(s.key_preset, s.prefix, key_event)) |binding| {
                            s.prefix = false;
                            switch (binding) {
                                .action => |key_| try s.dispatchKey(key_),
                                .resize => |key_| try s.action("resize", direction(key_).?),
                                .workspace => |index| if (index < s.runtime.workspaces.items.len) {
                                    try s.switchWorkspace(s.runtime.workspaces.items[index].id);
                                },
                            }
                            used += len;
                            continue;
                        }
                    }
                    // Resolve Corgi shortcuts before encoding for the child. A
                    // Kitty Ctrl-B/Ctrl-T are otherwise invisible to the byte handlers.
                    try key_event.encode(&encoded.writer, .{});
                    const legacy = encoded.written();
                    const owned = s.hasMenu() or s.name_dialog != null or s.confirm != .none or s.copy_mode or s.search_mode;
                    if (owned or (legacy.len == 1 and (legacy[0] == keymap.prefixByte(s.key_prefix) or (legacy[0] == 20 and s.key_preset == .corgi)))) {
                        seq = legacy;
                    } else if (s.focused()) |p| {
                        encoded.clearRetainingCapacity();
                        try key_event.encode(&encoded.writer, vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.emulator().*));
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
            const parsed_key = keys.parse(seq);
            if (parsed_key == .paste_start or parsed_key == .paste_end) {
                cl.paste = parsed_key == .paste_start;
                if (cl.paste) {
                    cl.paste_pane = if (!s.hasMenu() and s.name_dialog == null and s.confirm == .none) (if (s.focused()) |p| p.id else null) else null;
                    cl.paste_to_name = s.name_dialog != null;
                    cl.paste_to_picker = s.agent_picker != null;
                }
                if (cl.paste_pane) |id| {
                    if (s.pane(id)) |p| if (p.terminal.emulator().*.modes.get(.bracketed_paste)) try s.sendInput(p.terminal, seq);
                }
            } else if (cl.paste) {
                if (cl.paste_pane) |id| {
                    if (s.pane(id)) |p| try s.sendInput(p.terminal, seq);
                }
            } else if (parsed_key == .focus_in) {
                cl.watched = true;
            } else if (parsed_key == .focus_out) {
                cl.watched = false;
                s.pointer = null;
                s.dirty = true;
            } else if (std.mem.startsWith(u8, seq, "\x1b[<")) try s.mouse(seq) else if (s.onboarding) |*wizard| {
                const done = wizard.sequence(seq, s.connection) catch |err| blk: {
                    wizard.fail(err);
                    break :blk false;
                };
                if (done) try s.finishOnboarding();
                s.dirty = true;
            } else if (s.prefix) {
                if (s.key_preset == .tmux and seq.len == 6 and std.mem.startsWith(u8, seq, "\x1b[1;5")) {
                    const dir: ?[]const u8 = switch (seq[5]) {
                        'A' => "up",
                        'B' => "down",
                        'C' => "right",
                        'D' => "left",
                        else => null,
                    };
                    if (dir) |value| {
                        s.prefix = false;
                        try s.action("resize", value);
                    }
                } else if (s.key_preset == .herdr and parsed_key == .shift_tab) {
                    try s.dispatchKey(keymap.cycle_prev);
                } else if (s.help_visible) s.help.sequence(seq);
                s.dirty = true;
            } else if (s.workspace_chooser != null) {
                if (parsed_key == .up) try s.key(16) else if (parsed_key == .down) try s.key(14);
            } else if (s.agent_picker != null) {
                if (parsed_key == .up or parsed_key == .shift_tab) s.moveAgentPicker(false) else if (parsed_key == .down) s.moveAgentPicker(true) else s.agent_picker.?.query.sequence(seq);
            } else if (s.corgi_setup) |*setup| {
                if (parsed_key == .up or parsed_key == .shift_tab) setup.move(false) else if (parsed_key == .down) setup.move(true);
                s.dirty = true;
            } else if (s.agent_launcher != null) {
                // CSI-only on purpose: SS3 arrows reach the name field as input.
                if (s.agent_launcher.?.managing and s.agent_launcher.?.selected == .add and
                    !std.mem.eql(u8, seq, "\x1b[A") and !std.mem.eql(u8, seq, "\x1b[B") and !std.mem.eql(u8, seq, "\x1b[Z"))
                {
                    s.agent_launcher.?.input().sequence(seq);
                    s.dirty = true;
                } else if (parsed_key == .up) {
                    s.moveLauncher(false, false);
                } else if (parsed_key == .down) {
                    s.moveLauncher(true, false);
                } else if (std.mem.eql(u8, seq, "\x1b[H") or std.mem.eql(u8, seq, "\x1b[1~")) {
                    s.selectLauncher(s.agent_launcher.?.first());
                } else if (std.mem.eql(u8, seq, "\x1b[F") or std.mem.eql(u8, seq, "\x1b[4~")) {
                    s.selectLauncher(if (s.agent_launcher.?.managing) .manage else .terminal);
                } else if (parsed_key == .shift_tab) {
                    s.moveLauncher(false, true);
                } else if (!s.agent_launcher.?.pinned) {
                    s.closeMenu();
                    if (s.focused()) |p| try s.sendInput(p.terminal, seq);
                }
            } else if (s.port_menu != null) {
                if (parsed_key == .up) s.movePortMenu(false) else if (parsed_key == .down) s.movePortMenu(true);
            } else if (s.tab_menu != null) {
                if (parsed_key == .up) s.moveTabMenu(false) else if (parsed_key == .down) s.moveTabMenu(true);
            } else if (s.menu() != null) {
                if (parsed_key == .page_up) s.pageMenu(false) else if (parsed_key == .page_down) s.pageMenu(true);
            } else if (s.name_dialog) |*dialog| {
                dialog.sequence(seq);
                s.dirty = true;
            } else if (s.confirm != .none) {
                // Dialog keys belong to Corgi, never to the shell beneath it.
            } else if (s.copy_mode and parsed_key == .page_up) s.scroll(-20) else if (s.copy_mode and parsed_key == .page_down) s.scroll(20) else if (s.focused()) |p| try s.sendInput(p.terminal, seq);
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
        const tabs_x = s.sidebarView(&.{}).tabX();
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
        if (s.onboarding) |*wizard| {
            if (!release and button == 0) {
                const done = wizard.click(s.width, s.height, x, y, s.connection) catch |err| blk: {
                    wizard.fail(err);
                    break :blk false;
                };
                if (done) try s.finishOnboarding();
            } else if (!release and button & 64 != 0) {
                if (wizard.step == .keymap) wizard.help.move(button & 1 != 0, 3) else if (button & 1 != 0) wizard.scroll += 3 else wizard.scroll -|= 3;
            }
            s.dirty = true;
            return;
        }
        if (s.prefix and s.help_visible) {
            if (!release and button == 0) {
                s.ui_mouse_down = true;
                switch (try s.help.hit(s.width, s.height, x, y, s.key_preset)) {
                    .close => s.closeMenu(),
                    .action => |action_key| if (s.model().count > 0 or !shortcut_help.needsPane(action_key)) {
                        try s.dispatchKey(action_key);
                    },
                    .none => {},
                }
            } else if (!release and (button == 64 or button == 65)) s.help.move(button == 65, 3);
            if (release) s.ui_mouse_down = false;
            s.dirty = true;
            return;
        }
        // A hidden prefix has no mouse targets. A click resumes normal UI input.
        if (s.prefix and !release and button & 0xe0 == 0) s.closeMenu();
        if (s.workspace_chooser != null) return;
        const moved = s.pointer == null or s.pointer.?.x != x or s.pointer.?.y != y;
        if (moved) s.aimResource(x, y);
        var resource_workspace_press = false;
        if (s.resourceRect()) |rect| if (rect.contains(x, y)) {
            // The card can cover workspace rows on narrower screens. A
            // workspace press dismisses it and reaches normal navigation.
            resource_workspace_press = !release and (button == 0 or button == 2) and s.sidebarView(&.{}).hit(x, y) == .workspace;
            if (!resource_workspace_press) {
                s.pointer = .{ .x = x, .y = y };
                if (!release and button == 0) {
                    s.resource_card.click(rect, x, y);
                } else if (release) s.ui_mouse_down = false else if (button & 64 != 0) s.link_tooltip.cancel();
                s.dirty = true;
                return;
            }
        };
        if (!release and button & 32 != 0 and button & 3 == 3 and button & 64 == 0) {
            if (moved and !s.resourceHoverContains(x, y)) {
                var resource_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
                const resource_hit = sidebar.resourceAt(s.sidebarView(&.{}), s.workspaceEntries(&resource_storage), x, y);
                if (resource_hit == null or s.resourceDetail() != resource_hit.?.id) s.link_tooltip.move();
                s.launcher_hover_blocked = false;
            }
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
                    // A consumed link press must not leak an unmatched drag
                    // or release into a mouse-aware child.
                    if (!click.drag_selects and p.terminal.emulator().*.flags.mouse_event != .none) {
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
                            try s.queueEffect(.{ .open_url = try a.dupe(u8, click.url.text()) });
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
                        var buf: [@FieldType(PortClick, "url").capacity]u8 = undefined;
                        if (sidebar.workspaceUrl(ws, index, &buf)) |url| cl.port_click = .{ .x = x, .y = y, .url = .initTruncated(url) };
                    }
                } else s.closeMenu();
            }
            return;
        }

        if (cl.divider) |*drag| {
            if (!std.meta.eql(drag.area, s.area())) drag.cancelled = true;
            if (!drag.cancelled and (release or button & 0xe3 == 32)) {
                const split = s.model().nodes[drag.hit.node].?.split;
                const operation: Command = .{ .@"split.ratio" = .{
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
            if (release) {
                s.sidebar_drag = false;
                var saved = preferences.load();
                saved.sidebar_width = s.sidebar_width;
                preferences.save(saved) catch |err| s.notice(@errorName(err));
            } else if (button == 32) {
                s.sidebar_width = std.math.clamp(x +| 1, 20, @max(20, s.width -| 20));
                s.dirty = true;
            }
            s.dirty = true;
            return;
        }
        if (s.agent_drag) |*drag| {
            // Input can arrive before the next snapshot poll. Validate a drop
            // against current shared state, including rows removed mid-drag.
            if (release and button & 3 == 0) try s.refresh();
            var storage: [sidebar.max_entries]sidebar.Entry = undefined;
            const live = s.sidebarEntries(&storage);
            var side = s.sidebarView(live);
            if (!release and (button == 64 or button == 65) and drag.valid(side, s.current().id)) {
                s.sidebar_offset = if (button == 64) side.offset -| 1 else @min(side.offset + 1, side.maxOffset());
                side = s.sidebarView(live);
                drag.dragging = true;
            }
            if (!release and button == 32 and (x != drag.start_x or y != drag.start_y)) drag.dragging = true;
            drag.update(side, s.current().id, x, y);
            if (release and button & 3 == 0) {
                const saved = drag.*;
                s.agent_drag = null;
                s.ui_mouse_down = false;
                if (saved.drop) |drop| {
                    const before = if (drop.index == saved.end) null else live[drop.index].orderTarget();
                    s.edit(.{ .@"agent.move" = .{ .workspace = saved.workspace, .target = saved.target, .before = before } }) catch |err| s.notice(@errorName(err));
                }
            }
            s.dirty = true;
            return;
        }
        if (s.workspace_drag) |*drag| {
            // Mirrors the agent drag: validate against current shared state.
            if (release and button & 3 == 0) try s.refresh();
            var ids_storage: [workspace.max_workspaces]WorkspaceId = undefined;
            const ids = s.workspaceIds(&ids_storage);
            var side = s.sidebarView(&.{});
            if (!release and (button == 64 or button == 65) and drag.valid(side, ids)) {
                s.workspace_offset = if (button == 64) side.workspace_offset -| 1 else @min(side.workspace_offset + 1, ids.len -| side.workspaceCapacity());
                side = s.sidebarView(&.{});
                drag.dragging = true;
            }
            if (!release and button == 32 and (x != drag.start_x or y != drag.start_y)) drag.dragging = true;
            drag.update(side, ids, x, y);
            if (release and button & 3 == 0) {
                const saved = drag.*;
                s.workspace_drag = null;
                s.ui_mouse_down = false;
                if (saved.before()) |before| {
                    s.edit(.{ .@"workspace.move" = .{ .target = saved.ids[saved.source], .before = before } }) catch |err| s.notice(@errorName(err));
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
        const tabs_x = s.sidebarView(&.{}).tabX();
        const tabs_width = s.width - tabs_x;
        if (s.ui_mouse_down) {
            if (release) s.ui_mouse_down = false;
            return;
        }
        if (s.corgi_setup != null) {
            const setup = corgi_setup.Menu;
            if (!release and button == 0) {
                s.ui_mouse_down = true;
                if (setup.hit(s.width, s.height, x, y)) |choice| s.applySetup(choice) else if (!setup.contains(s.width, s.height, x, y)) s.closeMenu();
            } else if (!release and (button == 35 or button == 32)) {
                if (setup.hit(s.width, s.height, x, y)) |choice| s.corgi_setup.?.selected = choice;
            } else if (!release and (button == 64 or button == 65)) s.corgi_setup.?.move(button == 65);
            s.dirty = true;
            return;
        }
        if (s.scope_menu) |*scope_menu| {
            const side = s.sidebarView(&.{});
            const scope = sidebar.ScopeMenu.hit(side, s.width, s.height, x, y);
            if (!release and button == 0) {
                s.ui_mouse_down = true;
                if (scope) |value| s.setAgentScope(value) else if (side.hit(x, y) == .agent_scope and !scope_menu.pinned) scope_menu.pinned = true else s.closeMenu();
            } else if (!release and (button == 35 or button == 32)) {
                scope_menu.hovered = scope;
            }
            s.dirty = true;
            return;
        }
        if (s.agent_launcher != null) {
            const side = s.sidebarView(&.{});
            if (!release and button == 0) {
                s.ui_mouse_down = true;
                if (s.agent_launcher.?.managing) {
                    const launch = &s.agent_launcher.?;
                    const b = launch.bounds(s.width, s.height, side);
                    if (launch.hit(s.width, s.height, side, x, y)) |row| {
                        if (row == .add) {
                            launch.selected = .add;
                            const top = b.y + @as(u16, @intCast(launch.countRows())) + 5;
                            const actions = top + 12 + @as(u16, if (launch.show_command) 2 else 0);
                            if (y == actions and x >= b.x + b.w -| 10) {
                                try s.saveInlineCommand();
                            } else if (y == actions and x >= b.x + b.w -| 20) {
                                launch.edit(.add);
                            } else if (y == top + 10 and x >= b.x + b.w -| 18) {
                                launch.show_command = !launch.show_command;
                            } else if (y == top + 2 or y == top + 6) {
                                launch.name_focused = y == top + 6;
                                const width = b.w -| 10;
                                const editor = launch.input();
                                var offset = editor.cursor -| (width -| 1);
                                while (offset < editor.cursor and editor.text[offset] & 0xc0 == 0x80) offset += 1;
                                editor.position(editor.byteAtColumn(offset, x -| (b.x + 5)));
                            }
                        } else if (row == .manage) {
                            try s.launchRow(row);
                        } else if (row.custom() != null and x >= b.x + b.w -| 11) {
                            try s.deleteLauncherCommand(row.custom().?);
                        } else if (x >= b.x + b.w -| 18) {
                            launch.edit(row);
                        } else if (row.custom()) |index| {
                            try s.toggleCommandVisibility(index);
                        } else try s.launchRow(row);
                    } else if (!b.contains(x, y)) s.closeMenu();
                    s.dirty = true;
                    return;
                }
                const hit = side.hit(x, y);
                if (s.agent_launcher.?.visibilityHit(s.width, s.height, side, x, y)) |index| {
                    try s.toggleCommandVisibility(index);
                } else if (s.agent_launcher.?.yoloHit(s.width, s.height, side, x, y)) |provider| {
                    try s.toggleLauncherYolo(provider);
                } else if (s.agent_launcher.?.usageHit(s.width, s.height, side, x, y)) |provider| {
                    s.trackLauncherUsage(provider);
                } else if (hit == .agent_new) {
                    try s.launchAgent(null);
                } else if (hit == .agent_options) {
                    s.agent_launcher.?.pinned = true;
                } else if (s.agent_launcher.?.hit(s.width, s.height, side, x, y)) |row| {
                    try s.launchRow(row);
                } else s.closeMenu();
            } else if (!release and (button == 35 or button == 32)) {
                if (!s.agent_launcher.?.managing) if (s.agent_launcher.?.hit(s.width, s.height, side, x, y)) |row| {
                    s.agent_launcher.?.selected = row;
                };
                s.dirty = true;
            }
            return;
        }
        if (s.agent_picker != null) {
            var storage: [sidebar.max_entries]sidebar.Entry = undefined;
            const entries = s.pickerEntries(&storage);
            const view = s.sidebarView(entries);
            if (!release and (button == 64 or button == 65)) {
                if (x < view.width and y >= view.middle()) s.moveAgentPicker(button == 65);
                return;
            }
            if (!release and button == 0) {
                const hit = view.hit(x, y);
                if (hit == .entry) {
                    const index = hit.entry;
                    s.ui_mouse_down = true;
                    s.agent_picker.?.selected = entries[index].target;
                    try s.acceptAgentPicker();
                    return;
                } else if (x < view.width and y == view.middle() + 1) {
                    s.ui_mouse_down = true;
                    s.agent_picker.?.query.position(view.searchOffset() + (x -| 3));
                    return;
                } else if (x < view.width and y >= view.middle()) {
                    return;
                }
                // A click elsewhere leaves search and retains its usual action.
                s.closeMenu();
            } else return;
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
        const entries = s.sidebarEntries(&agent_storage);
        const side = s.sidebarView(entries);
        if (!release and button == 0 and side.width > 0 and x == side.width - 1) {
            s.sidebar_drag = true;
            return;
        }
        var git_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
        // Do not activate Git or URL controls hidden behind the resource card.
        const git_hit = if (resource_workspace_press) null else sidebar.gitActionWorkspace(side, s.workspaceEntries(&git_storage), s.git_hover, x, y);
        s.git_hover = if (git_hit) |ws| ws.id else null;
        if (!release and button == 0 and git_hit != null and !s.copy_mode) {
            s.ui_mouse_down = true;
            const ws = git_hit.?;
            if (ws.git_push.phase == .pushing or ws.git_push.phase == .succeeded) return;
            const index = s.runtime.workspaces.index(ws.id) orelse return;
            const response = try s.connection.request(.{ .op = "git.push", .protocol = 1, .workspace = ws.id, .ref = s.runtime.workspaces.items[index].git_ref });
            defer response.deinit();
            const err = agents.str(response.value, "err");
            if (err.len > 0) s.notice(gitPushMessage(err));
            try s.refresh();
            s.dirty = true;
            return;
        }
        if (!release and button == 0 and !resource_workspace_press) {
            var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
            if (sidebar.portWorkspace(side, s.workspaceEntries(&workspace_storage), x, y)) |ws| {
                var click: PortClick = .{ .x = x, .y = y };
                if (sidebar.urlCount(ws) > 1) {
                    click.menu = ws.id;
                } else if (!s.remote_links) {
                    var buf: [@TypeOf(click.url).capacity]u8 = undefined;
                    click.url = .initTruncated(sidebar.workspaceUrl(ws, 0, &buf) orelse return);
                } else return;
                cl.port_click = click;
                return;
            }
        }
        if ((side.width > 0 and x < side.width and y < s.height - 1) or (y == 0 and x < tabs_x)) {
            if (!release and (button == 64 or button == 65)) {
                if (y < side.middle()) {
                    s.workspace_offset = if (button == 64) side.workspace_offset -| 1 else @min(side.workspace_offset + 1, s.runtime.workspaces.items.len -| side.workspaceCapacity());
                } else s.sidebar_offset = if (button == 64) side.offset -| 1 else @min(side.offset + 1, side.maxOffset());
                s.dirty = true;
            } else if (!release and (button == 0 or button == 2)) {
                s.ui_mouse_down = true;
                if (corgi_badge.hit(s.corgi_badge, side.width, x, y)) return s.openSetup();
                switch (side.hit(x, y)) {
                    .toggle => try s.action("sidebar", ""),
                    .previous => s.sidebar_offset = side.offset -| side.capacity,
                    .next => s.sidebar_offset = @min(side.offset + side.capacity, side.maxOffset()),
                    .entry => |index| if (entries[index].exit == null) {
                        const target = entries[index].target;
                        try s.selectAgent(target);
                        if (button == 0 and target != .group) {
                            // Selecting another workspace can scroll the list.
                            // Capture the post-selection viewport and identity.
                            const updated = s.sidebarEntries(&agent_storage);
                            const view = s.sidebarView(updated);
                            if (agent_navigation.indexOf(updated, target)) |at| {
                                if (view.offset == side.offset) {
                                    const owner = switch (target) {
                                        .pane => |id| s.runtime.workspaces.owner(id).?.id,
                                        .native => |id| for (s.runtime.sessions) |session| {
                                            if (session.id == id) break session.workspace;
                                        } else unreachable,
                                        .group => unreachable,
                                    };
                                    s.agent_drag = .init(view, at, x, y, owner, s.current().id);
                                }
                            }
                        }
                    },
                    .workspace_new => s.beginWorkspace(null),
                    .agent_new => if (button == 0) try s.launchAgent(null) else s.openLauncher(true),
                    .agent_options => s.openLauncher(true),
                    .agent_scope => s.openScopeMenu(true),
                    .workspace_previous => s.workspace_offset = side.workspace_offset -| side.workspaceCapacity(),
                    .workspace_next => s.workspace_offset = @min(side.workspace_offset + side.workspaceCapacity(), s.runtime.workspaces.items.len -| side.workspaceCapacity()),
                    .workspace => |index| if (button == 2) {
                        s.closeMenu();
                        s.search_mode = false;
                        s.cancelDividers();
                        s.selection = null;
                        s.tab_menu = .{ .tab = @intFromEnum(s.runtime.workspaces.items[index].id), .workspace = true, .anchor_x = x, .anchor_y = y };
                    } else {
                        const id = s.runtime.workspaces.items[index].id;
                        var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
                        const ws_entries = s.workspaceEntries(&workspace_storage);
                        const jump = !resource_workspace_press and side.unreadHit(ws_entries[index], x, y);
                        const target = if (jump) s.firstUnreadAgent(index) else null;
                        try s.switchWorkspace(id);
                        if (jump) {
                            if (target) |agent| {
                                try s.selectAgent(agent);
                                const updated = s.sidebarEntries(&agent_storage);
                                for (updated, 0..) |entry, i| {
                                    if (std.meta.eql(entry.target, agent)) {
                                        s.sidebar_offset = @min(i, s.sidebarView(updated).maxOffset());
                                        break;
                                    }
                                }
                            }
                        } else {
                            var ids_storage: [workspace.max_workspaces]WorkspaceId = undefined;
                            const ids = s.workspaceIds(&ids_storage);
                            // Switching can scroll the list; capture the post-switch viewport.
                            const view = s.sidebarView(&.{});
                            if (view.workspace_offset == side.workspace_offset) if (std.mem.indexOfScalar(WorkspaceId, ids, id)) |at| {
                                s.workspace_drag = .init(view, ids, at, x, y);
                            };
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
                s.dismissName();
                try s.action("new", "");
                return;
            }
            if (x >= tabs_x) if (render.tabAt(s.layoutView(), tabs_width, x - tabs_x)) |index| {
                s.rememberAgent();
                s.nav().active = index;
                s.native_notice = null;
                s.rememberAgent();
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
                s.tab_menu = .{ .pane = true, .tab = @intFromEnum(p.id), .source = if (source != p.id) @intFromEnum(source) else null, .anchor_x = x, .anchor_y = y };
                s.ui_mouse_down = true;
                s.dirty = true;
                return;
            }
            try s.focusPane(p.id);

            s.dirty = true;
            const term = s.pane(p.id).?.terminal;
            // Agent output keeps ordinary left-drag selection even when the
            // agent requests mouse reporting. Alt-click still reaches its UI.
            const agent_selection = s.pane(p.id).?.agent.provider != null and (button == 0 or button == 32);
            // Links open on release in the pressed cell, so a drag that ends
            // on a link never opens it. Plain clicks only claim links when
            // they would otherwise start a selection; mouse-aware apps keep
            // them. Cmd-click stays with the host's OSC 8 handler. SGR mouse
            // events expose Ctrl, but do not encode the Command modifier.
            const plain_link = button == 0 and (term.emulator().*.flags.mouse_event == .none or agent_selection);
            if (!release and (button == 16 or plain_link) and !s.copy_mode) {
                for (term.hyperlinks()) |link| {
                    if (link.row != y - p.rect.y or x - p.rect.x < link.start or x - p.rect.x >= link.end) continue;
                    if (!std.mem.startsWith(u8, link.uri, "http://") and !std.mem.startsWith(u8, link.uri, "https://")) continue;
                    cl.port_click = .{
                        .x = x,
                        .y = y,
                        .url = @FieldType(PortClick, "url").init(link.uri) catch continue,
                        .pane = p.id,
                        .px = x - p.rect.x,
                        .py = y - p.rect.y,
                        .drag_selects = plain_link,
                    };
                    return;
                }
            }
            if (term.emulator().*.flags.mouse_event != .none and !s.copy_mode and button & 4 == 0 and !agent_selection) {
                // Translate coordinates through Ghostty's input encoder into the app's chosen protocol.
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

    pub fn visitWorkspace(s: *Self, id: WorkspaceId) void {
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
        const previous_focus = if (s.runtime.workspaces.items.len > 0) (if (s.focused()) |p| p.id else layout.PaneId.none) else layout.PaneId.none;
        const previous_workspace = if (s.runtime.workspaces.items.len > 0) s.current().id else WorkspaceId.none;
        const previous_token = if (s.runtime.workspaces.items.len > 0) s.model().revision else 0;
        try s.runtime.receive(s.connection, snapshot);
        if (previous_workspace != s.current().id or previous_token != s.model().revision) s.cancelDividers();
        if (previous_focus != layout.PaneId.none and previous_focus != (if (s.focused()) |p| p.id else layout.PaneId.none)) {
            s.copy_mode = false;
            s.search_mode = false;
            s.selection = null;
            s.message = .{};
            s.native_notice = null;
        }
        s.reconcile();
    }
    pub fn reconcile(s: *Self) void {
        if (s.agent_picker) |picker| {
            if (picker.workspace != s.current().id) s.agent_picker = null;
        }
        if (s.port_menu) |*links| {
            const count = sidebar.urlCount(s.portWorkspaceEntry(links.workspace));
            if (s.runtime.workspaces.index(links.workspace) == null or count == 0) {
                s.port_menu = null;
            } else links.selected = @min(links.selected, count - 1);
        }
        if (s.tab_menu) |context| if (s.tabMenuStale(context)) {
            s.tab_menu = null;
        };
        if (s.confirm_tab) |id| if (s.tabIndex(id) == null) {
            s.confirm = .none;
            s.confirm_tab = null;
            s.message = .{};
        };
        if (s.selection) |selection| if (s.pane(selection.pane) == null) {
            s.selection = null;
        };
        if (s.name_dialog) |dialog| if ((dialog.target == .rename and s.tabIndex(dialog.target.rename) == null) or (dialog.target == .pane and s.pane(dialog.target.pane) == null)) s.dismissName();
        s.dirty = true;
    }
    pub fn expireInput(s: *Self) !void {
        if (s.onboarding) |*wizard| {
            if (wizard.poll(s.connection)) s.dirty = true;
        }
        try s.pollLauncher();
        s.pollScopeMenu();
        if (s.link_tooltip.due(clock.milliTimestamp())) s.dirty = true;
        if (s.resource_aim) |aim| if (clock.milliTimestamp() - aim.at >= resource_tooltip.aim_ms) {
            // The pointer stopped short of the card: what it rests on takes over.
            s.resource_aim = null;
            if (s.resourceDetail() != null) s.link_tooltip.move();
            s.dirty = true;
        };
        if (s.copy_feedback_until != 0 and clock.milliTimestamp() >= s.copy_feedback_until) {
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
    pub fn resourceDetail(s: *Self) ?WorkspaceId {
        if (!s.resource_prefs.enabled or !s.link_tooltip.shown or s.link_tooltip.target == null) return null;
        const id = s.link_tooltip.target.?.resource orelse return null;
        if (s.runtime.workspaces.index(id) == null) return null;
        const work = s.runtime.resources.workspace(id);
        if (work.cpu == null and work.memory == null and work.read == null and work.written == null) return null;
        return id;
    }
    fn resourceRect(s: *Self) ?layout.Rect {
        _ = s.resourceDetail() orelse return null;
        return resource_tooltip.geometry(s.width, s.height, s.sidebarView(&.{}).width, s.resource_card.anchor);
    }
    fn resourceBridgeContains(s: *Self, rect: layout.Rect, x: u16, y: u16) bool {
        const side = s.sidebarView(&.{}).width;
        // Bridge the resource row's right padding and sidebar divider so the
        // pointer can reach the card one cell at a time, including diagonally.
        return rect.contains(x, y) or (x >= side -| 2 and x < rect.x and y >= rect.y and y < rect.y + rect.h);
    }
    fn resourceHoverContains(s: *Self, x: u16, y: u16) bool {
        const rect = s.resourceRect() orelse return false;
        if (s.resourceBridgeContains(rect, x, y)) return true;
        const aim = s.resource_aim orelse return false;
        return resource_tooltip.aimed(rect, aim, x, y);
    }
    /// Starts aiming when the pointer steps off the card's row toward the
    /// card and keeps the card while each move stays inside the triangle.
    fn aimResource(s: *Self, x: u16, y: u16) void {
        const id = s.resourceDetail() orelse {
            s.resource_aim = null;
            return;
        };
        const rect = s.resourceRect().?;
        var storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
        const entries = s.workspaceEntries(&storage);
        const view = s.sidebarView(&.{});
        const on_row = if (sidebar.resourceAt(view, entries, x, y)) |ws| ws.id == id else false;
        if (on_row or s.resourceBridgeContains(rect, x, y)) {
            s.resource_aim = null;
            return;
        }
        if (s.pointer) |from| if (sidebar.resourceAt(view, entries, from.x, from.y)) |ws| if (ws.id == id) {
            s.resource_aim = .{ .x = from.x, .y = from.y };
        };
        if (s.resource_aim) |*aim| {
            if (resource_tooltip.aimed(rect, aim.*, x, y)) aim.at = clock.milliTimestamp() else s.resource_aim = null;
        }
    }
    /// No modal, drag, or selection is claiming the pointer right now.
    fn hoverIdle(s: *Self) bool {
        return !s.hasMenu() and s.menu() == null and s.name_dialog == null and s.confirm == .none and !s.copy_mode and s.selection == null and s.workspace_drag == null;
    }
    fn linkTooltipReady(s: *Self) !bool {
        var target: ?link_tooltip.Target = null;
        if (s.pointer) |pointer| {
            if (!s.hasMenu() and s.menu() == null and s.name_dialog == null and s.confirm == .none and !s.copy_mode and s.selection == null and !s.ui_mouse_down) {
                var storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
                if (s.resourceHoverContains(pointer.x, pointer.y)) return true;
                if (sidebar.resourceAt(s.sidebarView(&.{}), s.workspaceEntries(&storage), pointer.x, pointer.y)) |ws| {
                    if (resource_tooltip.geometry(s.width, s.height, s.sidebarView(&.{}).width, pointer.y) != null) {
                        target = .{ .pane = .none, .link = 0, .resource = ws.id };
                        s.resource_card.anchor = pointer.y;
                    }
                }
                if (corgi_badge.hit(s.corgi_badge, s.sidebarView(&.{}).width, pointer.x, pointer.y)) {
                    target = .{ .pane = .none, .link = 0, .usage = true };
                }
                if (sidebar.gitActionWorkspace(s.sidebarView(&.{}), s.workspaceEntries(&storage), s.git_hover, pointer.x, pointer.y)) |ws| {
                    target = .{ .pane = @enumFromInt(@intFromEnum(ws.id)), .link = 0, .git = true };
                    if (ws.git_push.phase == .failed) return true;
                }
                var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
                const entries = s.sidebarEntries(&agent_storage);
                // The host may leave its last mouse report at the window edge.
                if (pointer.x > 0) if (sidebar.agentAt(s.sidebarView(entries), entries, pointer.x, pointer.y)) |entry| {
                    target = .{ .pane = .none, .link = 0, .conversation = entry.conversation, .agent = entry.target };
                };
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
        return s.link_tooltip.ready(target, clock.milliTimestamp());
    }
    pub fn frame(s: *Self) ![]u8 {
        if (s.onboarding) |*wizard| return wizard.frame(s.width, s.height);
        if (s.prefix and s.help_visible) return s.help.frame(s.width, s.height, s.key_preset, s.key_prefix);
        if (s.workspace_chooser) |index| {
            var output: std.Io.Writer.Allocating = .init(a);
            errdefer output.deinit();
            try output.writer.writeAll("\x1b[0;38;2;201;208;215;48;2;35;40;47m\x1b[2J\x1b[H Workspaces\r\n\r\n");
            const capacity = s.height -| 5;
            const start = index -| (capacity -| 1);
            for (s.runtime.workspaces.items[start..@min(s.runtime.workspaces.items.len, start + capacity)], start..) |ws, i| {
                try output.writer.writeAll(if (i == index) " › " else "   ");
                try sidebar.writeEllipsis(&output.writer, ws.name, s.width -| 5);
                try output.writer.writeAll("\r\n");
            }
            try output.writer.writeAll("\r\n ↑↓ choose · Enter switch · Esc close\x1b[0m\x1b[?25l");
            return output.toOwnedSlice();
        }
        s.rememberAgent();
        var agent_storage: [sidebar.max_entries]sidebar.Entry = undefined;
        const entries = if (s.agent_picker != null) s.pickerEntries(&agent_storage) else s.sidebarEntries(&agent_storage);
        var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
        if (s.pointer) |pointer| {
            const hit = sidebar.gitActionWorkspace(s.sidebarView(entries), s.workspaceEntries(&workspace_storage), s.git_hover, pointer.x, pointer.y);
            s.git_hover = if (hit) |ws| ws.id else null;
        } else s.git_hover = null;
        if (s.agent_drag) |*drag| _ = drag.valid(s.sidebarView(entries), s.current().id);
        if (s.workspace_drag) |*drag| {
            var ids_storage: [workspace.max_workspaces]WorkspaceId = undefined;
            _ = drag.valid(s.sidebarView(entries), s.workspaceIds(&ids_storage));
        }
        const tooltip_ready = try s.linkTooltipReady();
        const detail = s.resourceDetail();
        if (detail) |id| {
            const rect = s.resourceRect();
            const freeze = if (s.pointer) |pointer| if (rect) |box| box.contains(pointer.x, pointer.y) else false else false;
            s.resource_card.update(s.runtime.resources.workspace(id), freeze);
        }
        return render.frame(s.layoutView(), s.runtime.panes.items, s.width, s.height, .{
            .key_preset = s.key_preset,
            .key_prefix = s.key_prefix,
            .pointer = s.pointer,
            .iterm2_pointer = s.iterm2_pointer,
            .link_tooltip = tooltip_ready,
            .resources = s.runtime.resources,
            .resource_prefs = s.resource_prefs,
            .sleeping_corgis = s.sleeping_corgis,
            .resource_hover = if (s.link_tooltip.target) |target| target.resource else null,
            .resource_card = if (tooltip_ready and detail != null) s.resource_card else null,
            .git_hover = if (s.hoverIdle()) s.git_hover else null,
            .message = if (s.agent_picker != null and (s.width < 40 or s.height < 13)) " Agent search: enlarge terminal or Esc" else s.message.text(),
            .copy_feedback = s.copy_feedback_until > clock.milliTimestamp(),
            .copy_mode = s.copy_mode,
            .menu = s.menu(),
            .tab_menu = s.tab_menu,
            .port_menu = s.port_menu,
            .agent_search = s.agentSearch(),
            .agent_launcher = s.agent_launcher,
            .scope_menu = s.scope_menu,
            .agent_scope = s.agent_scope,
            .scope_label = s.scopeLabel(),
            .corgi_setup = s.corgi_setup,
            .inference = s.runtime.inference,
            .tab_drop_x = s.tabDropX(),
            .dialog = s.name_dialog,
            .confirm = s.confirm != .none,
            .sidebar_open = s.sidebar_open,
            .corgi_badge = s.corgi_badge,
            .supports_kitty_graphics = s.supports_kitty_graphics,
            .sidebar_width = s.sidebar_width,
            .dragged_workspace = if (s.workspace_drag) |drag| if (drag.preview) |destination| .{ .source = drag.source, .destination = destination } else null else null,
            .dragged_agent = if (s.agent_drag) |drag| if (drag.preview) |destination| .{ .source = drag.source, .destination = destination } else null else null,
            .sidebar_offset = if (s.agent_picker) |picker| picker.offset else s.sidebar_offset,
            .agents = entries,
            .conversations = s.runtime.conversations,
            .system_model = s.runtime.system_model,
            .release = .{ .running = s.runtime.release_version, .commit = s.runtime.release_commit, .staged = s.runtime.staged_version },
            .system_usage = s.runtime.system_usage,
            .system_working = s.runtime.system_working,
            .accounts = .{ .options = s.launch_previews.preview.options, .system = s.runtime.inference.provider },
            .workspaces = s.workspaceEntries(&workspace_storage),
            .workspace_offset = s.workspace_offset,
        });
    }
};
fn direction(key: u8) ?[]const u8 {
    return switch (key) {
        'h' => "left",
        'j' => "down",
        'k' => "up",
        'l' => "right",
        else => null,
    };
}
fn gitPushMessage(err: []const u8) []const u8 {
    return switch (std.meta.stringToEnum(protocol.Rejection, err) orelse return err) {
        .GitPreviewChanged => git_push.preview_changed,
        .GitPushInProgress => "A push is already running for this repository.",
        else => err,
    };
}
