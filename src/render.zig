const std = @import("std");
const layout = @import("layout.zig");
const agents = @import("agents.zig");
const commands = @import("commands.zig");
const naming = @import("name_dialog.zig");
const sidebar = @import("sidebar.zig");
const a = @import("os.zig").allocator;
pub const Pane = @import("runtime.zig").Pane;
pub const Buffer = std.Io.Writer.Allocating;
pub const Ui = struct {
    message: []const u8,
    copy_mode: bool,
    copy_feedback: bool = false,
    native_blocked: usize,
    native_finished: usize,
    menu: ?commands.View = null,
    tab_menu: ?commands.TabMenu = null,
    tab_drop_x: ?u16 = null,
    dialog: ?naming.Dialog = null,
    confirm: bool = false,
    sidebar_open: bool = true,
    sidebar_width: u16 = 28,
    workspace_drop_y: ?u16 = null,
    sidebar_offset: usize = 0,
    agents: []const sidebar.Entry = &.{},
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
pub fn tabStart(model: *const layout.Model, width: u16) usize {
    if (model.count == 0) return 0;
    var start = model.active;
    var used = tabWidth(model.tabs[start], start);
    while (start > 0 and used + tabWidth(model.tabs[start - 1], start - 1) <= width) {
        start -= 1;
        used += tabWidth(model.tabs[start], start);
    }
    return start;
}

pub fn addTabX(model: *const layout.Model, width: u16) u16 {
    const available = width -| 3;
    var x: usize = 0;
    const first = tabStart(model, available);
    for (model.tabs[first..model.count], first..) |tab, i| {
        const len = tabExtent(tab, i, first, available - x);
        if (len == 0) break;
        x += len;
    }
    return @intCast(x);
}
pub fn tabAt(model: *const layout.Model, width: u16, x: u16) ?usize {
    const available = width -| 3;
    var start: usize = 0;
    const first = tabStart(model, available);
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
pub fn tabDrop(model: *const layout.Model, width: u16, x: u16) ?TabDrop {
    if (x >= width or model.count == 0) return null;
    const available = width -| 3;
    const first = tabStart(model, available);
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
pub fn frame(model: *layout.Model, panes: anytype, width: u16, height: u16, ui: Ui) ![]u8 {
    var out: Buffer = .init(a);
    defer out.deinit();
    const w = &out.writer;
    const side = sidebar.View.init(width, height, ui.sidebar_open, ui.sidebar_offset, ui.agents.len).withWidth(ui.sidebar_width).withWorkspaces(ui.workspaces.len, ui.workspace_offset);
    // Mouse tracking modes replace one another. Disabling first makes the host
    // briefly switch to a text pointer on every redraw.
    try w.writeAll(if (ui.menu != null or ui.tab_menu != null) "\x1b[?1003h" else "\x1b[?1002h");
    try w.writeAll("\x1b[?2026h\x1b[?25l\x1b[0m\x1b[H\x1b[2J");
    try w.print("\x1b[1;{d}H", .{side.tabX() + 1});
    var x: usize = 0;
    const tab_space = width - side.tabX() -| 3;
    const start = tabStart(model, tab_space);
    for (model.tabs[start..model.count], start..) |tab, i| {
        const len = tabExtent(tab, i, start, tab_space - x);
        if (len == 0) break;
        try w.writeAll(if (i == model.active) "\x1b[1;38;2;226;230;233;48;2;48;53;61m" else "\x1b[0;38;2;125;132;143;48;2;24;27;32m");
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
    for (model.placements(area, &locations)) |place| {
        if (place.rect.w == 0 or place.rect.h == 0) continue;
        for (panes) |p| if (p.id == place.id) {
            const r = place.rect;
            try p.terminal.updateRender();
            const state = p.terminal.renderState();
            for (0..@min(state.rows, r.h)) |row| {
                try w.print("\x1b[{d};{d}H", .{ r.y + row + 1, r.x + 1 });
                try @import("surface.zig").writeRow(w, state, row, r.w, ui.dialog != null);
            }
            try w.writeAll("\x1b[0m");
            break;
        };
    }
    try drawDividers(w, model, area);
    try side.draw(w, ui.agents, ui.workspaces);
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
    } else {
        var agent_label: [64]u8 = undefined;
        var label: []const u8 = "corgi";
        if (model.count > 0) for (panes) |p| {
            if (p.id == model.tab().focus and p.label.len > 0) {
                label = p.label.text();
                break;
            }
            if (p.id == model.tab().focus and p.agent.provider != .other) {
                label = try std.fmt.bufPrint(&agent_label, "{s} {s}", .{ @tagName(p.agent.provider), @tagName(p.agent.state) });
                break;
            }
        };
        const text = if (ui.message.len > 0) ui.message else try std.fmt.bufPrint(&status, " {s}  ^B commands   ! {d} needs you  + {d} finished   ^B a attention", .{ if (ui.copy_mode) "SCROLL  j/k move  y copy viewport  q exit" else label, blocked, finished });
        try w.writeAll(text[0..@min(text.len, width)]);
    }
    try w.writeAll("\x1b[0m");
    if (model.count > 0 and !ui.copy_mode and ui.menu == null and ui.tab_menu == null and ui.dialog == null and !ui.confirm) for (model.placements(area, &locations)) |place| {
        if (place.id != model.tab().focus or place.rect.h == 0) continue;
        for (panes) |p| if (p.id == place.id) {
            if (p.terminal.renderState().cursor.visible) if (p.terminal.renderState().cursor.viewport) |cursor| {
                if (cursor.x < place.rect.w and cursor.y < place.rect.h) {
                    try w.print("\x1b[{d};{d}H\x1b[?25h", .{ place.rect.y + cursor.y + 1, place.rect.x + cursor.x + 1 });
                }
            };
        };
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
    try w.writeAll("\x1b[?2026l");
    return out.toOwnedSlice();
}

test "tab drop slots follow midpoints and clipped visible tabs" {
    var m: layout.Model = .{};
    _ = try m.newTab("one");
    _ = try m.newTab("two");
    _ = try m.newTab("three");
    try std.testing.expectEqual(@as(usize, 0), tabDrop(&m, 40, 4).?.index);
    try std.testing.expectEqual(@as(usize, 1), tabDrop(&m, 40, 5).?.index);
    try std.testing.expectEqual(@as(usize, 3), tabDrop(&m, 40, 35).?.index);
    // Only the focused tab fits: the left gap is before tab three, not tab one.
    try std.testing.expectEqual(@as(usize, 2), tabDrop(&m, 13, 0).?.index);
    try std.testing.expectEqual(@as(usize, 3), tabDrop(&m, 13, 12).?.index);
    try std.testing.expectEqual(@as(u16, 9), tabDrop(&m, 13, 12).?.x);
    try std.testing.expect(tabDrop(&m, 13, 13) == null);
    try std.testing.expect(tabDrop(&m, 3, 0) == null);
}

fn drawDividers(w: *std.Io.Writer, model: *const layout.Model, area: layout.Rect) !void {
    var storage: [layout.max_borders]layout.Model.Border = undefined;
    const borders = model.borders(area, &storage);
    var placements: [layout.max_panes]layout.Placement = undefined;
    var focused: layout.Rect = .{};
    for (model.placements(area, &placements)) |place| {
        if (place.id == model.tabs[model.active].focus) focused = place.rect;
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
