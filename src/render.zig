const std = @import("std");
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const a = @import("os.zig").allocator;
pub const Pane = @import("mirror.zig").Pane;
pub const Buffer = std.Io.Writer.Allocating;
pub const Pointer = struct { x: u16, y: u16 };
pub const Ui = struct {
    pointer: ?Pointer = null,
    link_tooltip: bool = false,
    agent_launcher: ?@import("agent_launcher.zig").Menu = null,
    message: []const u8,
    copy_mode: bool,
    copy_feedback: bool = false,
    native_blocked: usize,
    native_finished: usize,
    menu: ?commands.View = null,
    tab_menu: ?commands.TabMenu = null,
    port_menu: ?sidebar.PortMenu = null,
    agent_search: ?sidebar.Search = null,
    tab_drop_x: ?u16 = null,
    dialog: ?naming.Dialog = null,
    confirm: bool = false,
    sidebar_open: bool = true,
    corgi_badge: bool = false,
    sidebar_width: u16 = 28,
    workspace_drop_y: ?u16 = null,
    sidebar_offset: usize = 0,
    agents: []const sidebar.Entry = &.{},
    conversations: []const @import("protocol.zig").Conversation = &.{},
    system_model: []const u8 = "",
    system_working: bool = false,
    system_usage: @import("live_usage.zig").View = .{},
    workspaces: []const sidebar.WorkspaceEntry = &.{},
    workspace_offset: usize = 0,
};
pub fn tabWidth(tab: layout.Tab, index: usize) usize {
    const digits: usize = if (index + 1 >= 10) 2 else 1;
    return @max(10, 2 + (if (tab.name_len > 0) @min(tab.title().len, 16) else digits));
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
pub fn frame(view: layout.View, panes: anytype, width: u16, height: u16, ui: Ui) ![]u8 {
    const model = view.model;
    var out: Buffer = .init(a);
    defer out.deinit();
    const w = &out.writer;
    var side = sidebar.View.init(width, height, ui.sidebar_open, ui.sidebar_offset, ui.agents.len).withSearch(ui.agent_search).withWidth(ui.sidebar_width).withWorkspaces(ui.workspaces.len, ui.workspace_offset);
    side.corgi_badge = ui.corgi_badge;
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
        const text = if (tab.name_len == 0)
            try std.fmt.bufPrint(&name, "{d}", .{i + 1})
        else
            tab.title()[0..@min(tab.title().len, 16)];
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
        const empty = " No panes. Ctrl-B c: new tab | Ctrl-B u: undo close | Ctrl-B q: detach";
        try w.print("\x1b[2;{d}H", .{side.width + 1});
        try w.writeAll(empty[0..@min(empty.len, side.area().w)]);
    }
    var locations: [layout.max_panes]layout.Placement = undefined;
    const area = side.area();
    var hovered_uri: ?[]const u8 = null;
    var link_pointer = false;
    var workspace_uri: [256]u8 = undefined;
    if (ui.pointer) |pointer| {
        if (ui.agent_launcher == null and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.dialog == null and !ui.confirm) {
            if (ui.port_menu) |menu| {
                for (ui.workspaces) |ws| {
                    if (ws.id != menu.workspace) continue;
                    if (menu.hit(ws, width, height, pointer.x, pointer.y)) |index|
                        hovered_uri = sidebar.workspaceUrl(ws, index, &workspace_uri);
                    break;
                }
            } else {
                link_pointer = sidebar.portWorkspace(side, ui.workspaces, pointer.x, pointer.y) != null;
                switch (side.hit(pointer.x, pointer.y)) {
                    .agent_new, .agent_options => link_pointer = true,
                    .workspace => |index| link_pointer = link_pointer or side.unreadHit(ui.workspaces[index], pointer.x, pointer.y),
                    else => {},
                }
                hovered_uri = sidebar.portLink(side, ui.workspaces, pointer.x, pointer.y, &workspace_uri);
            }
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
                if (r.contains(pointer.x, pointer.y) and ui.agent_launcher == null and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.port_menu == null and ui.dialog == null and !ui.confirm) {
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
                try @import("surface.zig").writeRowHovered(w, state, p.terminal.hyperlinks(), p.id, row, r.w, ui.dialog != null, hovered);
            }
            try w.writeAll("\x1b[0m");
            break;
        };
    }
    try drawDividers(w, view, area);
    try side.draw(w, ui.agents, ui.workspaces);
    if (ui.corgi_badge) {
        try w.writeAll(@import("corgi_badge.zig").hide);
        if (side.width > 0 and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.port_menu == null and ui.dialog == null)
            try @import("corgi_badge.zig").place(w);
    }
    if (ui.workspace_drop_y) |y| {
        try w.print("\x1b[{d};1H\x1b[1;38;2;161;194;178m", .{y + 1});
        for (0..side.width -| 1) |_| try w.writeAll("─");
        try w.writeAll("\x1b[0m");
    }
    var blocked: usize = ui.native_blocked;
    var finished: usize = ui.native_finished;
    for (panes) |p| switch (p.agent.attention) {
        .needs_input => blocked += 1,
        .finished => finished += 1,
        .none => {},
    };
    try w.print("\x1b[{d};1H\x1b[0;38;2;125;132;143m", .{height});
    var status: [512]u8 = undefined;
    if (ui.confirm) {
        const text = try std.fmt.bufPrint(&status, " [ Close ]  [ Cancel ] {s}", .{ui.message});
        try w.writeAll(text[0..@min(text.len, width)]);
    } else if (hovered_uri) |uri| {
        try sidebar.writeClipped(w, uri, width);
    } else {
        var agent_label: [64]u8 = undefined;
        var label: []const u8 = "corgi";
        if (model.count > 0) for (panes) |p| {
            if (p.id == view.selection.tabs[view.selection.active].focus and p.label.len > 0) {
                label = p.label;
                break;
            }
            if (p.id == view.selection.tabs[view.selection.active].focus and p.agent.provider != .other) {
                label = try std.fmt.bufPrint(&agent_label, "{s} {s}", .{ @tagName(p.agent.provider), @tagName(p.agent.state) });
                break;
            }
        };
        const text = if (ui.message.len > 0) ui.message else try std.fmt.bufPrint(&status, " {s}  ^B commands   ! {d} needs you  + {d} finished   ^B a attention", .{ if (ui.copy_mode) "SCROLL  j/k move  y copy viewport  q exit" else label, blocked, finished });
        try w.writeAll(text[0..@min(text.len, width)]);
    }
    try w.writeAll("\x1b[0m");
    if (model.count > 0 and !ui.copy_mode and !ui.link_tooltip and ui.agent_launcher == null and ui.agent_search == null and ui.menu == null and ui.tab_menu == null and ui.port_menu == null and ui.dialog == null and !ui.confirm) for (view.placements(area, &locations)) |place| {
        if (place.id != view.selection.tabs[view.selection.active].focus or place.rect.h == 0) continue;
        for (panes) |p| if (p.id == place.id) {
            if (p.terminal.renderState().cursor.visible) if (p.terminal.renderState().cursor.viewport) |cursor| {
                if (cursor.x < place.rect.w and cursor.y < place.rect.h) {
                    try w.print("\x1b[{d};{d}H\x1b[?25h", .{ place.rect.y + cursor.y + 1, place.rect.x + cursor.x + 1 });
                }
            };
        };
    };
    if (ui.link_tooltip and ui.agent_launcher == null) if (ui.pointer) |pointer| {
        if (@import("corgi_badge.zig").hit(ui.corgi_badge, side.width, pointer.x, pointer.y)) {
            try @import("subagent_tooltip.zig").drawOverview(w, ui.conversations, ui.system_usage, ui.system_working, ui.system_model, width, height);
        } else if (sidebar.gitWorkspace(side, ui.workspaces, pointer.x, pointer.y)) |ws| {
            try sidebar.drawGitTooltip(w, ws, width, height, pointer.x, pointer.y);
        } else if (sidebar.agentAt(side, ui.agents, pointer.x, pointer.y)) |entry| {
            try @import("subagent_tooltip.zig").draw(w, ui.conversations, entry.*, width, height, pointer.x, pointer.y);
        } else if (width >= 24 and height >= 5) {
            const tooltip_x = @min(pointer.x +| 1, width - 24);
            const tooltip_y = if (pointer.y + 4 < height) pointer.y + 1 else pointer.y -| 3;
            try w.writeAll("\x1b7\x1b]8;;\x1b\\\x1b[0;38;2;226;230;233;48;2;48;53;61m");
            try w.print("\x1b[{d};{d}H╭──────────────────────╮", .{ tooltip_y + 1, tooltip_x + 1 });
            try w.print("\x1b[{d};{d}H│ Ctrl-click to open ↗ │", .{ tooltip_y + 2, tooltip_x + 1 });
            try w.print("\x1b[{d};{d}H╰──────────────────────╯", .{ tooltip_y + 3, tooltip_x + 1 });
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
    if (ui.agent_launcher) |*launcher| try launcher.draw(w, width, height, side);
    try side.searchCursor(w);
    // Include the shape in each complete frame so reconnects and overlay changes
    // cannot leave the host pointer stuck on a previously hovered link.
    try w.writeAll(if (link_pointer or hovered_uri != null) "\x1b]22;pointer\x1b\\" else "\x1b]22;default\x1b\\");
    try w.writeAll("\x1b[?2026l");
    return out.toOwnedSlice();
}

test "unread pointer follows the clickable workspace and respects overlays" {
    var model: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &model, .selection = &selection };
    var workspaces = [_]sidebar.WorkspaceEntry{
        .{ .id = 1, .name = "Read", .cwd = "/tmp", .active = true },
        .{ .id = 2, .name = "Unread", .cwd = "/tmp", .active = false, .unread = 2 },
    };
    const side = sidebar.View.init(100, 30, true, 0, 0).withWorkspaces(workspaces.len, 0);
    const range = side.unreadRange(workspaces[1]);
    const Case = struct { x: u16, y: u16 = 6, confirm: bool = false, open: bool = true, hand: bool = false };
    for ([_]Case{
        .{ .x = @intCast(range.start), .hand = true },
        .{ .x = @intCast(range.end - 1), .hand = true },
        .{ .x = @intCast(range.end) },
        .{ .x = @intCast(range.start), .y = 3 },
        .{ .x = @intCast(range.start), .confirm = true },
        .{ .x = @intCast(range.start), .open = false },
    }) |case| {
        const output = try frame(view, @as([]const Pane, &.{}), 100, 30, .{
            .pointer = .{ .x = case.x, .y = case.y },
            .message = "",
            .copy_mode = false,
            .native_blocked = 0,
            .native_finished = 0,
            .workspaces = &workspaces,
            .confirm = case.confirm,
            .sidebar_open = case.open,
        });
        defer a.free(output);
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
                    if (x > area.x and other.rect.contains(@intCast(x - 1), @intCast(y))) left = true;
                    if (x + 1 < area.x + area.w and other.rect.contains(@intCast(x + 1), @intCast(y))) right = true;
                    if (y > area.y and other.rect.contains(@intCast(x), @intCast(y - 1))) up = true;
                    if (y + 1 < area.y + area.h and other.rect.contains(@intCast(x), @intCast(y + 1))) down = true;
                }
                const glyph: []const u8 = if (up and down)
                    (if (left and right) "┼" else if (left) "┤" else if (right) "├" else "│")
                else if (left and right) (if (up) "┴" else if (down) "┬" else "─") else if (up) (if (left) "┘" else if (right) "└" else "│") else if (down) (if (left) "┐" else if (right) "┌" else "│") else if (border.axis == .horizontal) "│" else "─";
                try w.writeAll(glyph);
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

test "badge redraw preserves cached pixels and shifts only the workspace heading" {
    var model: layout.Model = .{};
    var selection: layout.Selection = .{};
    const view: layout.View = .{ .model = &model, .selection = &selection };
    var ui: Ui = .{ .message = "", .copy_mode = false, .native_blocked = 0, .native_finished = 0, .corgi_badge = true };
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
    try std.testing.expect(std.mem.indexOf(u8, usage_popup, "Usage not reported yet") != null);
    ui.link_tooltip = false;
    ui.agent_launcher = .{ .workspace = 1, .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    const popup = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(popup);
    try std.testing.expect(std.mem.indexOf(u8, popup, "New agent") != null);
    try std.testing.expect(std.mem.indexOf(u8, popup, "a=p,i=730031") != null);
    try std.testing.expect(std.mem.indexOf(u8, popup, "a=t,") == null);
    ui.agent_launcher = null;
    ui.sidebar_open = false;
    const hidden = try frame(view, @as([]const Pane, &.{}), 100, 30, ui);
    defer a.free(hidden);
    try std.testing.expect(std.mem.indexOf(u8, hidden, @import("corgi_badge.zig").hide) != null);
    try std.testing.expect(std.mem.indexOf(u8, hidden, "a=p,i=730031") == null);
}
