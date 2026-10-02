const std = @import("std");
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const a = @import("os.zig").allocator;
const mirror = @import("mirror.zig");
const keymap = @import("keymap.zig");
const bindings = @import("bindings.zig");
const resources = @import("trackers.zig").resources;
const preferences = @import("preferences.zig");
const resource_tooltip = @import("resource_tooltip.zig");
const AgentLauncherMenu = @import("agent_launcher.zig").Menu;
const CorgiSetupMenu = @import("corgi_setup.zig").Menu;
const inference_setup = @import("inference.zig").setup;
const corgi_badge = @import("corgi_badge.zig");
const protocol = @import("protocol.zig");
const subagent_tooltip = @import("subagent_tooltip.zig");
const live_usage = @import("usage.zig").live;
const surface = @import("pane.zig").surface;
pub const Pane = mirror.Pane;
pub const Buffer = std.Io.Writer.Allocating;
pub const Pointer = struct { x: u16, y: u16 };
pub const Ui = struct {
    prefs: preferences.Preferences = .{},
    pointer: ?Pointer = null,
    iterm2_pointer: bool = false,
    link_tooltip: bool = false,
    resources: resources.Snapshot = .{},
    resource_hover: ?WorkspaceId = null,
    resource_card: ?resource_tooltip.State = null,
    git_hover: ?WorkspaceId = null,
    agent_launcher: ?AgentLauncherMenu = null,
    corgi_setup: ?CorgiSetupMenu = null,
    inference: inference_setup.Status = .{},
    message: []const u8,
    copy_mode: bool,
    copy_feedback: bool = false,
    menu: ?commands.ResizeView = null,
    tab_menu: ?commands.TabMenu = null,
    port_menu: ?sidebar.PortMenu = null,
    scope_menu: ?sidebar.ScopeMenu = null,
    scope_label: []const u8 = "",
    agent_search: ?sidebar.Search = null,
    tab_drop_x: ?u16 = null,
    dialog: ?naming.Dialog = null,
    sidebar_open: bool = true,
    corgi_badge: corgi_badge.Mode = .none,
    supports_kitty_graphics: bool = false,
    dragged_workspace: ?sidebar.Preview = null,
    dragged_agent: ?sidebar.Preview = null,
    sidebar_offset: usize = 0,
    agents: []const sidebar.Entry = &.{},
    conversations: []const protocol.Conversation = &.{},
    system_model: []const u8 = "",
    release: subagent_tooltip.Release = .{},
    system_working: bool = false,
    system_usage: live_usage.View = .{},
    accounts: subagent_tooltip.Accounts = .{},
    workspaces: []const sidebar.WorkspaceEntry = &.{},
    workspace_offset: usize = 0,
};
pub fn tabWidth(tab: layout.Tab, index: usize) usize {
    const digits: usize = if (index + 1 >= 10) 2 else 1;
    return @max(10, 2 + (if (tab.title.len > 0) @min(tab.title.text().len, 16) else digits));
}
fn tabExtent(tab: layout.Tab, index: usize, first: usize, remaining: usize) usize {
    const width = tabWidth(tab, index);
    // Clip only when even the first tab cannot fit; avoid tiny trailing tabs.
    return if (index == first) @min(width, remaining) else if (width <= remaining) width else 0;
}
pub fn tabStart(view: layout.View, width: u16) usize {
    const model = view.model;
    if (model.count == 0) return 0;
    var start = view.selection.active;
    var used = tabWidth(model.tabs[start], start);
    while (start > 0 and used + tabWidth(model.tabs[start - 1], start - 1) <= width) {
        start -= 1;
        used += tabWidth(model.tabs[start], start);
    }
    return start;
}

pub fn addTabX(view: layout.View, width: u16) u16 {
    const model = view.model;
    const available = width -| 3;
    var x: usize = 0;
    const first = tabStart(view, available);
    for (model.tabs[first..model.count], first..) |tab, i| {
        const len = tabExtent(tab, i, first, available - x);
        if (len == 0) break;
        x += len;
    }
    return @intCast(x);
}
pub fn tabAt(view: layout.View, width: u16, x: u16) ?usize {
    const model = view.model;
    const available = width -| 3;
    var start: usize = 0;
    const first = tabStart(view, available);
    for (model.tabs[first..model.count], first..) |tab, i| {
        const len = tabExtent(tab, i, first, available - start);
        if (len == 0) break;
        if (x >= start and x < start + len) return i;
        start += len;
    }
    return null;
}
pub const TabDrop = struct { index: usize, x: u16 };
/// Use the same clipped tab geometry for hit testing and the drop marker.
pub fn tabDrop(view: layout.View, width: u16, x: u16) ?TabDrop {
    const model = view.model;
    if (x >= width or model.count == 0) return null;
    const available = width -| 3;
    const first = tabStart(view, available);
    var left: usize = 0;
    var last: ?TabDrop = null;
    for (model.tabs[first..model.count], first..) |tab, i| {
        const len = tabExtent(tab, i, first, available - left);
        if (len == 0) break;
        if (x < left + len / 2) return .{ .index = i, .x = @intCast(left -| 1) };
        left += len;
        last = .{ .index = i + 1, .x = @intCast(left -| 1) };
        if (x < left) return last;
    }
    return last;
}
/// Draw one row of text over the window's bottom-left corner, like a browser's
/// link preview. Panes keep the row otherwise. It moves to the bottom-right
/// corner when the pointer is where it would go.
/// No modal overlay, menu, or dialog is covering the panes.
fn noOverlay(ui: Ui) bool {
    return ui.scope_menu == null and ui.agent_launcher == null and ui.corgi_setup == null and ui.agent_search == null and
        ui.menu == null and ui.tab_menu == null and ui.port_menu == null and ui.dialog == null;
}
fn writeChip(w: *std.Io.Writer, raw: []const u8, width: u16, height: u16, pointer: ?Pointer) !void {
    const text = std.mem.trimLeft(u8, raw, " ");
    if (width < 4 or height == 0 or text.len == 0 or !std.unicode.utf8ValidateSlice(text)) return;
    var buffer: [2048]u8 = undefined;
    var clipped = std.Io.Writer.fixed(&buffer);
    sidebar.writeEllipsis(&clipped, text, width - 2) catch {};
    const body = clipped.buffered();
    const chip_width = sidebar.displayWidth(body) + 2;
    const covered = if (pointer) |p| p.y == height - 1 and p.x < chip_width else false;
    const x = if (covered) width - chip_width else 0;
    try w.print("\x1b[{d};{d}H\x1b]8;;\x1b\\\x1b[0;38;2;201;208;214;48;2;48;53;61m {s} \x1b[0m", .{ height, x + 1, body });
}
pub fn frame(view: layout.View, panes: anytype, width: u16, height: u16, ui: Ui) ![]u8 {
    const model = view.model;
    var out: Buffer = .init(a);
    defer out.deinit();
    const w = &out.writer;
    var preview_storage: [sidebar.max_entries]sidebar.Entry = undefined;
    const entries = if (ui.dragged_agent) |drag| drag.apply(sidebar.Entry, ui.agents, &preview_storage) else ui.agents;
    var workspace_storage: [workspace.max_workspaces]sidebar.WorkspaceEntry = undefined;
    const workspaces = if (ui.dragged_workspace) |drag| drag.apply(sidebar.WorkspaceEntry, ui.workspaces, &workspace_storage) else ui.workspaces;
    const dragging = ui.dragged_agent != null or ui.dragged_workspace != null;
    var side = sidebar.View.init(width, height, ui.sidebar_open, ui.sidebar_offset, entries.len).withSearch(ui.agent_search).withWidth(ui.prefs.sidebar_width);
    side.resources = ui.prefs.resources;
    side = side.withWorkspaces(ui.workspaces.len, ui.workspace_offset).withEntries(entries);
    side.corgi_badge = ui.corgi_badge;
    side.supports_kitty_graphics = ui.supports_kitty_graphics;
    side.scope_label = ui.scope_label;
    side.resource_hover = ui.resource_hover;
    side.sleeping_corgis = ui.prefs.sleeping_corgis;
    side.dragged = if (ui.dragged_agent) |drag| drag.destination else null;
    side.dragged_workspace = if (ui.dragged_workspace) |drag| drag.destination else null;
    // Mouse tracking modes replace one another. Disabling first makes the host
    // briefly switch to a text pointer on every redraw.
    try w.writeAll("\x1b[?1003h");
    // Erase from home to the end, preserving Kitty image storage. ED 2
    // deletes cached images in Ghostty, even those without a placement.
    try w.writeAll("\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[J");
    try w.print("\x1b[1;{d}H", .{side.tabX() + 1});
    var x: usize = 0;
    const tab_space = width - side.tabX() -| 3;
    const start = tabStart(view, tab_space);
    for (model.tabs[start..model.count], start..) |tab, i| {
        const len = tabExtent(tab, i, start, tab_space - x);
        if (len == 0) break;
        try w.writeAll(if (i == view.selection.active) "\x1b[1;38;2;226;230;233;48;2;48;53;61m" else "\x1b[0;38;2;125;132;143;48;2;24;27;32m");
        var name: [96]u8 = undefined;
        const text = if (tab.title.len == 0)
            try std.fmt.bufPrint(&name, "{d}", .{i + @as(usize, if (ui.prefs.preset == .tmux) 0 else 1)})
        else
            tab.title.text()[0..@min(tab.title.text().len, 16)];
        const text_len = @min(text.len, len);
        const padding = (len - text_len) / 2;
        try w.splatByteAll(' ', padding);
        try w.writeAll(text[0..text_len]);
        try w.splatByteAll(' ', len - text_len - padding);
        x += len;
    }
    try w.writeAll("\x1b[1;38;2;161;194;178;48;2;35;40;47m + ");
    try w.writeAll("\x1b[0m");
    if (ui.tab_drop_x) |drop_x| {
        try w.print("\x1b[1;{d}H\x1b[1;38;2;161;194;178m│\x1b[0m", .{side.tabX() + drop_x + 1});
    }
    if (model.count == 0) {
        var empty_buffer: [160]u8 = undefined;
        const prefix_key = keymap.prefixName(ui.prefs.prefix);
        const empty = try std.fmt.bufPrint(&empty_buffer, " No panes. {s} {f}: agent picker | {s} {f}: shortcuts", .{
            prefix_key,
            bindings.first(ui.prefs.preset, .new, true).?,
            prefix_key,
            bindings.first(ui.prefs.preset, .help, true).?,
        });
        try w.print("\x1b[2;{d}H", .{side.width + 1});
        try w.writeAll(empty[0..@min(empty.len, side.area().w)]);
    }
    var locations: [layout.max_panes]layout.Placement = undefined;
    const area = side.area();
    var hovered_uri: ?[]const u8 = null;
    var link_pointer = false;
    var workspace_uri: [256]u8 = undefined;
    const card_rect: ?layout.Rect = if (!ui.link_tooltip or ui.agent_launcher != null or ui.corgi_setup != null or ui.pointer == null) null else if (ui.resource_card) |card|
        resource_tooltip.geometry(width, height, side.width, card.anchor)
    else
        null;
    // The card hides links beneath it. Workspace rows it covers still take
    // presses, so they keep their own pointer.
    const on_card = if (ui.pointer) |pointer| if (card_rect) |rect| rect.contains(pointer.x, pointer.y) and side.hit(pointer.x, pointer.y) != .workspace else false else false;
    if (ui.pointer) |pointer| {
        if (on_card) {
            link_pointer = resource_tooltip.sortAt(card_rect.?, pointer.x, pointer.y) != null;
        } else if (ui.scope_menu != null) {
            link_pointer = side.hit(pointer.x, pointer.y) == .agent_scope or sidebar.ScopeMenu.hit(side, width, height, pointer.x, pointer.y) != null;
        } else if (ui.agent_launcher == null and ui.corgi_setup == null and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.dialog == null) {
            if (ui.port_menu) |menu| {
                for (ui.workspaces) |ws| {
                    if (ws.id != menu.workspace) continue;
                    if (menu.hit(ws, width, height, pointer.x, pointer.y)) |index|
                        hovered_uri = sidebar.workspaceUrl(ws, index, &workspace_uri);
                    break;
                }
            } else {
                link_pointer = sidebar.portWorkspace(side, ui.workspaces, pointer.x, pointer.y) != null or
                    corgi_badge.hit(ui.corgi_badge, side.width, pointer.x, pointer.y);
                switch (side.hit(pointer.x, pointer.y)) {
                    .toggle, .workspace_new, .workspace_previous, .workspace_next, .agent_scope, .agent_new, .agent_options => link_pointer = true,
                    .workspace => |index| link_pointer = link_pointer or side.unreadHit(ui.workspaces[index], pointer.x, pointer.y),
                    else => {},
                }
                // Pushing and just-pushed badges ignore clicks, so only Push and Retry point.
                if (sidebar.gitActionWorkspace(side, ui.workspaces, ui.git_hover, pointer.x, pointer.y)) |ws|
                    link_pointer = link_pointer or ws.git_push.phase == .idle or ws.git_push.phase == .failed;
                if (pointer.y == 0 and pointer.x >= side.tabX()) {
                    const add_x = side.tabX() + addTabX(view, width - side.tabX());
                    link_pointer = link_pointer or (pointer.x >= add_x and pointer.x < add_x + 3);
                }
                hovered_uri = sidebar.portLink(side, ui.workspaces, pointer.x, pointer.y, &workspace_uri);
            }
        }
    }
    if (ui.corgi_setup != null) if (ui.pointer) |pointer| {
        link_pointer = CorgiSetupMenu.hit(width, height, pointer.x, pointer.y) != null;
    };
    if (ui.pointer) |pointer| {
        if (ui.menu) |menu| link_pointer = switch (menu.hit(pointer.x, pointer.y)) {
            .command, .previous, .next => true,
            .close => pointer.y == menu.y and pointer.x >= menu.x and pointer.x < menu.x + menu.width,
            .none => false,
        } else if (ui.tab_menu) |menu| {
            link_pointer = menu.hit(width, height, pointer.x, pointer.y) != null;
        } else if (ui.dialog) |dialog| {
            const dialog_view = naming.View.init(width, height, dialog);
            // Clicks outside the dialog also cancel; only the buttons point.
            const inside = pointer.x >= dialog_view.x and pointer.x < dialog_view.x + dialog_view.width;
            link_pointer = inside and pointer.y == dialog_view.buttons_y and dialog_view.hit(pointer.x, pointer.y) != .none;
        }
    }
    if (ui.agent_launcher != null) if (ui.pointer) |pointer| {
        link_pointer = ui.agent_launcher.?.hit(width, height, side, pointer.x, pointer.y) != null or side.hit(pointer.x, pointer.y) == .agent_new or side.hit(pointer.x, pointer.y) == .agent_options;
    };
    for (view.placements(area, &locations)) |place| {
        if (place.rect.w == 0 or place.rect.h == 0) continue;
        for (panes) |p| if (p.id == place.id) {
            const r = place.rect;
            try p.terminal.updateRender();
            const state = p.terminal.renderState();
            var hovered: ?u64 = null;
            if (ui.pointer) |pointer| {
                if (r.contains(pointer.x, pointer.y) and !on_card and noOverlay(ui)) {
                    for (p.terminal.hyperlinks()) |link| {
                        if (link.row == pointer.y - r.y and link.start <= pointer.x - r.x and pointer.x - r.x < link.end) {
                            hovered = link.id;
                            hovered_uri = link.uri;
                            break;
                        }
                    }
                }
            }
            for (0..@min(state.rows, r.h)) |row| {
                try w.print("\x1b[{d};{d}H", .{ r.y + row + 1, r.x + 1 });
                try surface.writeRowHovered(w, state, p.terminal.hyperlinks(), p.id, row, r.w, ui.dialog != null, hovered);
            }
            try w.writeAll("\x1b[0m");
            break;
        };
    }
    try drawDividers(w, view, area);
    try side.draw(w, entries, workspaces);
    if (ui.git_hover) |id| try sidebar.drawGitAction(w, side, ui.workspaces, id);
    if (ui.corgi_badge == .image) {
        try w.writeAll(corgi_badge.hide);
        if (side.width > 0 and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.port_menu == null and ui.dialog == null)
            try corgi_badge.place(w);
    }
    const text: []const u8 = hovered_uri orelse if (ui.message.len > 0) ui.message else if (ui.copy_mode) "SCROLL  j/k move  y copy viewport  q exit" else "";
    try writeChip(w, text, width, height, ui.pointer);
    if (model.count > 0 and !ui.copy_mode and !ui.link_tooltip and noOverlay(ui)) for (view.placements(area, &locations)) |place| {
        if (place.id != view.selection.tabs[view.selection.active].focus or place.rect.h == 0) continue;
        for (panes) |p| if (p.id == place.id) {
            if (p.terminal.renderState().cursor.visible) if (p.terminal.renderState().cursor.viewport) |cursor| {
                if (cursor.x < place.rect.w and cursor.y < place.rect.h) {
                    try w.print("\x1b[{d};{d}H\x1b[?25h", .{ place.rect.y + cursor.y + 1, place.rect.x + cursor.x + 1 });
                }
            };
        };
    };
    if (ui.link_tooltip and ui.agent_launcher == null and ui.corgi_setup == null) if (ui.pointer) |pointer| {
        if (ui.resource_card) |card| {
            if (card_rect) |rect| {
                const name = for (ui.workspaces) |ws| {
                    if (ws.id == card.workspace) break ws.name;
                } else "workspace";
                try resource_tooltip.draw(w, rect, name, ui.resources, card);
            }
        } else if (corgi_badge.hit(ui.corgi_badge, side.width, pointer.x, pointer.y)) {
            try subagent_tooltip.drawOverview(w, ui.conversations, ui.system_usage, ui.system_working, ui.system_model, ui.release, ui.accounts, width, height);
        } else if (sidebar.gitActionWorkspace(side, ui.workspaces, ui.git_hover, pointer.x, pointer.y)) |ws| {
            try sidebar.drawGitTooltip(w, ws, width, height, pointer.x, pointer.y);
        } else if (sidebar.agentAt(side, ui.agents, pointer.x, pointer.y)) |entry| {
            try subagent_tooltip.draw(w, ui.conversations, entry.*, width, height, pointer.x, pointer.y);
        } else if (width >= 19 and height >= 5) {
            const tooltip_x = @min(pointer.x +| 1, width - 19);
            const tooltip_y = if (pointer.y + 4 < height) pointer.y + 1 else pointer.y -| 3;
            try w.writeAll("\x1b7\x1b]8;;\x1b\\\x1b[0;38;2;226;230;233;48;2;48;53;61m");
            try w.print("\x1b[{d};{d}H╭─────────────────╮", .{ tooltip_y + 1, tooltip_x + 1 });
            try w.print("\x1b[{d};{d}H│ Click to open ↗ │", .{ tooltip_y + 2, tooltip_x + 1 });
            try w.print("\x1b[{d};{d}H╰─────────────────╯", .{ tooltip_y + 3, tooltip_x + 1 });
            try w.writeAll("\x1b[0m\x1b8");
        }
    };
    if (ui.copy_feedback and width >= 27 and height >= 5) {
        const toast_x = width - 26;
        try w.writeAll("\x1b7\x1b[0;38;2;166;227;161;48;2;30;30;46m");
        try w.print("\x1b[2;{d}H╭─────────────────────────╮", .{toast_x});
        try w.print("\x1b[3;{d}H│ ● \x1b[1mCopied to clipboard\x1b[22m   │", .{toast_x});
        try w.print("\x1b[4;{d}H╰─────────────────────────╯", .{toast_x});
        try w.writeAll("\x1b[0m\x1b8");
    }
    if (ui.menu) |menu| try menu.draw(w);
    if (ui.tab_menu) |menu| try menu.draw(w, width, height);
    if (ui.port_menu) |menu| for (ui.workspaces) |ws| {
        if (ws.id == menu.workspace) {
            try menu.draw(w, ws, width, height);
            break;
        }
    };
    if (ui.dialog) |dialog| {
        var number = model.count + 1;
        if (dialog.target == .rename) for (model.tabs[0..model.count], 0..) |tab, i| {
            if (tab.id == dialog.target.rename) {
                number = i + 1;
                break;
            }
        };
        try naming.View.init(width, height, dialog).draw(dialog, w, number);
    }
    if (ui.scope_menu) |menu| try menu.draw(w, side, width, height, ui.workspaces, ui.prefs.agents);
    if (ui.agent_launcher) |*launcher| try launcher.draw(w, width, height, side);
    if (ui.corgi_setup) |*setup| try setup.draw(w, ui.inference, ui.prefs, width, height);
    try side.searchCursor(w);
    if (dragging) try w.writeAll("\x1b[?25l");
    // Include the shape in each complete frame so reconnects and overlay changes
    // cannot leave the host pointer stuck on a previously hovered link.
    // iTerm2 has a pointing hand and an open hand, but no closed-hand shape.
    // "default" also clears its override because unrecognized names reset it.
    const shape = if (dragging)
        (if (ui.iterm2_pointer) "fleur" else "grabbing")
    else if (link_pointer or hovered_uri != null)
        (if (ui.iterm2_pointer) "hand2" else "pointer")
    else
        "default";
    try w.print("\x1b]22;{s}\x1b\\", .{shape});
    try w.writeAll("\x1b[?2026l");
    return out.toOwnedSlice();
}

test "unread pointer follows the clickable workspace and respects overlays" {
    var model: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &model, .selection = &selection };
    var workspaces = [_]sidebar.WorkspaceEntry{
        .{ .id = @enumFromInt(1), .name = "Read", .cwd = "/tmp", .active = true },
        .{ .id = @enumFromInt(2), .name = "Unread", .cwd = "/tmp", .active = false, .unread = 2 },
    };
    const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(workspaces.len, 0);
    const range = side.unreadRange(workspaces[1]);
    const Case = struct { x: u16, y: u16 = 6, open: bool = true, hand: bool = false };
    for ([_]Case{
        .{ .x = @intCast(range.start), .hand = true },
        .{ .x = @intCast(range.end - 1), .hand = true },
        .{ .x = @intCast(range.end) },
        .{ .x = @intCast(range.start), .y = 3 },
        .{ .x = @intCast(range.start), .open = false },
    }) |case| {
        const output = try frame(view, @as([]const Pane, &.{}), 100, 30, .{
            .pointer = .{ .x = case.x, .y = case.y },
            .message = "",
            .copy_mode = false,
            .workspaces = &workspaces,
            .sidebar_open = case.open,
        });
        defer a.free(output);
        try std.testing.expect(std.mem.indexOf(u8, output, if (case.hand) "\x1b]22;pointer\x1b\\" else "\x1b]22;default\x1b\\") != null);
    }
}

test "resource card points only at its sortable column headers" {
    var model: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &model, .selection = &selection };
    var workspaces = [_]sidebar.WorkspaceEntry{.{ .id = WorkspaceId.first, .name = "Busy", .cwd = "/tmp", .active = true }};
    const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(workspaces.len, 0);
    const rect = resource_tooltip.geometry(100, 30, side.width, 2).?;
    const header = rect.y + 14;
    const Case = struct { x: u16, y: u16, hand: bool = false };
    for ([_]Case{
        .{ .x = rect.x + rect.w - 32, .y = header, .hand = true },
        .{ .x = rect.x + rect.w - 20, .y = header, .hand = true },
        .{ .x = rect.x + rect.w - 3, .y = header, .hand = true },
        .{ .x = rect.x + rect.w - 33, .y = header },
        .{ .x = rect.x + rect.w - 2, .y = header },
        .{ .x = rect.x + rect.w - 20, .y = header + 1 },
    }) |case| {
        const output = try frame(view, @as([]const Pane, &.{}), 100, 30, .{
            .pointer = .{ .x = case.x, .y = case.y },
            .link_tooltip = true,
            .resource_card = .{ .workspace = workspaces[0].id, .anchor = 2 },
            .message = "",
            .copy_mode = false,
            .workspaces = &workspaces,
        });
        defer a.free(output);
        try std.testing.expect(std.mem.indexOf(u8, output, "TOP PROCESSES") != null);
        try std.testing.expect(std.mem.indexOf(u8, output, if (case.hand) "\x1b]22;pointer\x1b\\" else "\x1b]22;default\x1b\\") != null);
    }
}

test "tab drop slots follow midpoints and clipped visible tabs" {
    var m: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &m, .selection = &selection };
    _ = try m.newTab("one");
    _ = try m.newTab("two");
    _ = try m.newTab("three");
    selection.reconcile(&m);
    selection.active = 2;
    try std.testing.expectEqual(@as(usize, 0), tabDrop(view, 40, 4).?.index);
    try std.testing.expectEqual(@as(usize, 1), tabDrop(view, 40, 5).?.index);
    try std.testing.expectEqual(@as(usize, 3), tabDrop(view, 40, 35).?.index);
    // Only the focused tab fits: the left gap is before tab three, not tab one.
    try std.testing.expectEqual(@as(usize, 2), tabDrop(view, 13, 0).?.index);
    try std.testing.expectEqual(@as(usize, 3), tabDrop(view, 13, 12).?.index);
    try std.testing.expectEqual(@as(u16, 9), tabDrop(view, 13, 12).?.x);
    try std.testing.expect(tabDrop(view, 13, 13) == null);
    try std.testing.expect(tabDrop(view, 3, 0) == null);
}

/// The box-drawing glyph joining a divider cell with its neighbors on each side.
fn dividerGlyph(up: bool, down: bool, left: bool, right: bool, horizontal: bool) []const u8 {
    if (up and down) return if (left and right) "┼" else if (left) "┤" else if (right) "├" else "│";
    if (left and right) return if (up) "┴" else if (down) "┬" else "─";
    if (up) return if (left) "┘" else if (right) "└" else "│";
    if (down) return if (left) "┐" else if (right) "┌" else "│";
    return if (horizontal) "│" else "─";
}
fn drawDividers(w: *std.Io.Writer, view: layout.View, area: layout.Rect) !void {
    var storage: [layout.max_borders]layout.View.Border = undefined;
    const borders = view.borders(area, &storage);
    var placements: [layout.max_panes]layout.Placement = undefined;
    var focused: layout.Rect = .{};
    for (view.placements(area, &placements)) |place| {
        if (place.id == view.selection.tabs[view.selection.active].focus) focused = place.rect;
    }
    for (borders) |border| {
        const r = border.rect;
        for (r.y..r.y + r.h) |y| {
            var highlighted = touchesPane(focused, r.x, y);
            try dividerStyle(w, highlighted);
            try w.print("\x1b[{d};{d}H", .{ y + 1, r.x + 1 });
            for (r.x..r.x + r.w) |x| {
                const selected = touchesPane(focused, x, y);
                if (selected != highlighted) {
                    try dividerStyle(w, selected);
                    highlighted = selected;
                }
                var left = false;
                var right = false;
                var up = false;
                var down = false;
                for (borders) |other| {
                    if (x > area.x and other.rect.contains(x - 1, y)) left = true;
                    if (x + 1 < area.x + area.w and other.rect.contains(x + 1, y)) right = true;
                    if (y > area.y and other.rect.contains(x, y - 1)) up = true;
                    if (y + 1 < area.y + area.h and other.rect.contains(x, y + 1)) down = true;
                }
                try w.writeAll(dividerGlyph(up, down, left, right, border.axis == .horizontal));
            }
        }
    }
    try w.writeAll("\x1b[0m");
}

fn dividerStyle(w: *std.Io.Writer, highlighted: bool) !void {
    try w.writeAll(if (highlighted) "\x1b[1;38;2;161;194;178m" else "\x1b[0;38;2;125;132;143m");
}

fn touchesPane(r: layout.Rect, x: usize, y: usize) bool {
    if (r.w == 0 or r.h == 0) return false;
    // Include the junction cells at the corners of the selected pane.
    return x + 1 >= r.x and x <= @as(usize, r.x) + r.w and
        y + 1 >= r.y and y <= @as(usize, r.y) + r.h;
}

const TestCell = struct { glyph: u21 = 0, highlighted: bool = false };
/// The cells drawDividers paints on a 100x30 screen.
fn testDividerCells(view: layout.View, area: layout.Rect) ![30][100]TestCell {
    var out: Buffer = .init(std.testing.allocator);
    defer out.deinit();
    try drawDividers(&out.writer, view, area);
    var cells: [30][100]TestCell = @splat(@splat(.{}));
    var x: usize = 0;
    var y: usize = 0;
    var highlighted = false;
    var rest = out.written();
    while (rest.len > 0) {
        if (rest[0] == 0x1b) {
            const end = std.mem.indexOfAny(u8, rest, "Hm").?;
            const params = rest[2..end];
            if (rest[end] == 'H') {
                var it = std.mem.splitScalar(u8, params, ';');
                y = try std.fmt.parseInt(usize, it.next().?, 10) - 1;
                x = try std.fmt.parseInt(usize, it.next().?, 10) - 1;
            } else highlighted = std.mem.eql(u8, params, "1;38;2;161;194;178");
            rest = rest[end + 1 ..];
            continue;
        }
        const len = try std.unicode.utf8ByteSequenceLength(rest[0]);
        cells[y][x] = .{ .glyph = try std.unicode.utf8Decode(rest[0..len]), .highlighted = highlighted };
        x += 1;
        rest = rest[len..];
    }
    return cells;
}
fn expectOutline(cells: *const [30][100]TestCell, highlighted: []const [2]u16, plain: []const [2]u16) !void {
    for ([_][]const [2]u16{ highlighted, plain }, [_]bool{ true, false }) |points, expected| for (points) |p| {
        errdefer std.debug.print("cell {d},{d}\n", .{ p[0], p[1] });
        try std.testing.expect(cells[p[1]][p[0]].glyph != 0);
        try std.testing.expectEqual(expected, cells[p[1]][p[0]].highlighted);
    };
}

test "focus outline includes the outer edges and corners of the focused pane" {
    const area: layout.Rect = .{ .x = 28, .y = 1, .w = 72, .h = 29 };
    var m: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &m, .selection = &selection };
    const left = try m.newTab("");
    const right = try m.split(left, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, left);
    var cells = try testDividerCells(view, area);
    try expectOutline(&cells, &.{ .{ 28, 1 }, .{ 40, 1 }, .{ 40, 29 }, .{ 28, 10 }, .{ 63, 10 }, .{ 63, 1 }, .{ 63, 29 } }, &.{ .{ 90, 1 }, .{ 99, 10 } });
    try std.testing.expectEqual(@as(u21, '┌'), cells[1][28].glyph);
    try std.testing.expectEqual(@as(u21, '└'), cells[29][28].glyph);
    try std.testing.expectEqual(@as(u21, '┬'), cells[1][63].glyph);
    var placements: [layout.max_panes]layout.Placement = undefined;
    const split = view.placements(area, &placements);
    try std.testing.expectEqualDeep(layout.Rect{ .x = 29, .y = 2, .w = 34, .h = 27 }, split[0].rect);
    try std.testing.expectEqualDeep(layout.Rect{ .x = 64, .y = 2, .w = 35, .h = 27 }, split[1].rect);

    try selection.focus(&m, right);
    cells = try testDividerCells(view, area);
    try expectOutline(&cells, &.{ .{ 99, 1 }, .{ 90, 1 }, .{ 90, 29 }, .{ 99, 10 }, .{ 63, 10 } }, &.{.{ 28, 10 }});
    // The outer frame is not a divider, so pressing it starts no drag.
    try std.testing.expect(view.dividerAt(area, 89, 1) == null);
    selection.tab().zoom = true;
    try std.testing.expectEqualDeep(area, view.placements(area, &placements)[0].rect);
    cells = try testDividerCells(view, area);
    try std.testing.expectEqual(@as(u21, 0), cells[1][99].glyph);
}

test "focus outline follows stacked and nested splits" {
    const area: layout.Rect = .{ .x = 28, .y = 1, .w = 72, .h = 29 };
    var m: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &m, .selection = &selection };
    const top = try m.newTab("");
    const bottom = try m.split(top, .vertical);
    selection.reconcile(&m);
    try selection.focus(&m, bottom);
    var cells = try testDividerCells(view, area);
    try expectOutline(&cells, &.{ .{ 28, 20 }, .{ 99, 20 }, .{ 50, 29 }, .{ 50, 15 } }, &.{ .{ 50, 1 }, .{ 28, 5 } });
    const right = try m.split(bottom, .horizontal);
    selection.reconcile(&m);
    try selection.focus(&m, right);
    cells = try testDividerCells(view, area);
    try expectOutline(&cells, &.{ .{ 99, 20 }, .{ 90, 29 }, .{ 90, 15 }, .{ 63, 20 }, .{ 63, 15 } }, &.{ .{ 40, 29 }, .{ 28, 20 } });
}

test "badge redraw preserves cached pixels and shifts only the workspace heading" {
    var model: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &model, .selection = &selection };
    var ui: Ui = .{ .message = "", .copy_mode = false, .corgi_badge = .image };
    const shown = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(shown);
    try std.testing.expect(std.mem.indexOf(u8, shown, "\x1b[2J") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "\x1b[H\x1b[J") != null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "a=p,i=730031") != null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "a=t,") == null);
    try std.testing.expect(std.mem.indexOf(u8, shown, "\x1b[1;6H\x1b[1;38;2;226;230;233mworkspaces") != null);
    ui.pointer = .{ .x = 2, .y = 0 };
    ui.link_tooltip = true;
    const usage_popup = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(usage_popup);
    try std.testing.expect(std.mem.indexOf(u8, usage_popup, "Observed tokens") != null);
    try std.testing.expect(std.mem.indexOf(u8, usage_popup, "Since Corgi started") == null);
    try std.testing.expect(std.mem.indexOf(u8, usage_popup, "— tokens") != null);
    ui.link_tooltip = false;
    ui.agent_launcher = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    const popup = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(popup);
    try std.testing.expect(std.mem.indexOf(u8, popup, "New agent") != null);
    try std.testing.expect(std.mem.indexOf(u8, popup, "a=p,i=730031") != null);
    try std.testing.expect(std.mem.indexOf(u8, popup, "a=t,") == null);
    ui.agent_launcher = null;
    // The scope menu opens below the workspaces, clear of the badge.
    ui.scope_menu = .{};
    const scope = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(scope);
    try std.testing.expect(std.mem.indexOf(u8, scope, "This workspace") != null);
    try std.testing.expect(std.mem.indexOf(u8, scope, "a=p,i=730031") != null);
    ui.scope_menu = null;
    ui.sidebar_open = false;
    const hidden = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(hidden);
    try std.testing.expect(std.mem.indexOf(u8, hidden, corgi_badge.hide) != null);
    try std.testing.expect(std.mem.indexOf(u8, hidden, "a=p,i=730031") == null);
    ui.sidebar_open = true;
    ui.corgi_badge = .emoji;
    const emoji = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(emoji);
    try std.testing.expect(std.mem.indexOf(u8, emoji, corgi_badge.emoji) != null);
    try std.testing.expect(std.mem.indexOf(u8, emoji, "\x1b_G") == null);
    try std.testing.expect(std.mem.indexOf(u8, emoji, "\x1b[1;6H\x1b[1;38;2;226;230;233mworkspaces") != null);
}
