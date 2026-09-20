//! Explicit, server-side CLI operations. Layout transactions never depend on UI focus.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const Runtime = @import("runtime.zig").Runtime;

pub const Request = struct {
    op: []const u8 = "cli.control",
    protocol: u32 = 1,
    action: []const u8,
    target: u32 = 0,
    current: bool = false,
    caller: u32 = 0,
    other: u32 = 0,
    workspace: u32 = 0,
    viewer: u32 = 0,
    direction: layout.Direction = .right,
    placement: enum { none, before, after, beside, new_tab, workspace } = .none,
    name: []const u8 = "",
    cwd: []const u8 = "",
    text: []const u8 = "",
    enter: bool = false,
    lines: usize = 100,
    ratio: u16 = 500,
    axis: layout.Axis = .horizontal,
};
pub fn validate(q: Request) !void {
    const known = for ([_][]const u8{ "list", "current", "focus", "tab.new", "tab.rename", "tab.move", "tab.merge", "tab.close", "pane.split", "pane.move", "pane.swap", "pane.resize", "pane.close", "pane.read", "pane.send", "pane.keys" }) |action| {
        if (eq(q.action, action)) break true;
    } else false;
    if (!known) return error.UnknownOperation;
    if (q.current and q.caller == 0) return error.NoCallerPane;
    if (!q.current and q.target == 0 and !eq(q.action, "list") and !eq(q.action, "current") and !eq(q.action, "tab.new")) return error.MissingTarget;
    if (eq(q.action, "pane.move")) {
        if (q.placement != .beside and q.placement != .new_tab) return error.InvalidDestination;
    } else if (eq(q.action, "tab.merge")) {
        if (q.placement != .beside) return error.InvalidDestination;
    } else if (eq(q.action, "tab.move")) {
        if (q.placement != .before and q.placement != .after and q.placement != .workspace) return error.InvalidDestination;
    } else if (q.placement != .none) return error.InvalidDestination;
    if ((q.placement == .beside or q.placement == .before or q.placement == .after or eq(q.action, "pane.swap")) and q.other == 0) return error.MissingTarget;
    if (q.placement == .workspace and q.workspace == 0) return error.MissingWorkspace;
}

const Location = struct { pane: u32, tab: u32, workspace: u32 };
fn location(r: *Runtime, pane: u32) !Location {
    const ws = r.workspaces.owner(pane) orelse return error.NoPane;
    return .{ .pane = pane, .tab = ws.model.tabs[ws.model.tabForPane(pane).?].id, .workspace = ws.id };
}
fn tabOwner(r: *Runtime, id: u32) !*@import("workspace.zig").Workspace {
    for (r.workspaces.items.items) |*ws| for (ws.model.tabs[0..ws.model.count]) |t| {
        if (t.id == id) return ws;
    };
    return error.NoTab;
}
fn tabIndex(m: *const layout.Model, id: u32) !usize {
    for (m.tabs[0..m.count], 0..) |t, i| if (t.id == id) return i;
    return error.NoTab;
}
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}

pub fn handle(s: anytype, cl: anytype, value: std.json.Value) !bool {
    if (!eq(@import("agents.zig").str(value, "op"), "cli.control")) return false;
    try protocol.require(value, cl.protocol_version);
    const parsed = try std.json.parseFromValue(Request, a, value, .{ .ignore_unknown_fields = false });
    defer parsed.deinit();
    var q = parsed.value;
    try validate(q);
    const r = &s.runtime;
    if (q.current) {
        const loc = try location(r, q.caller);
        q.target = if (std.mem.startsWith(u8, q.action, "tab.")) loc.tab else loc.pane;
    }
    if (eq(q.action, "list")) {
        var arena = std.heap.ArenaAllocator.init(a);
        defer arena.deinit();
        const Viewer = struct { id: u32, workspace: u32, pane: ?u32 };
        var viewers: std.ArrayList(Viewer) = .empty;
        for (s.clients.items) |view| if (view.viewer and !view.dead) try viewers.append(arena.allocator(), .{ .id = view.viewer_id, .workspace = view.view_workspace, .pane = view.view_focus });
        try cl.queue(.{ .ok = true, .result = try protocol.snapshot(arena.allocator(), r), .viewers = viewers.items });
        return true;
    }
    if (eq(q.action, "current")) {
        try cl.queue(.{ .ok = true, .result = try location(r, q.caller) });
        return true;
    }
    if (eq(q.action, "focus")) {
        _ = try location(r, q.target);
        if (q.viewer == 0) return error.MissingViewer;
        const view = for (s.clients.items) |*v| {
            if (v.viewer and !v.dead and v.viewer_id == q.viewer) break v;
        } else return error.NoViewer;
        if (view.controls.items.len >= 64) return error.ViewerBusy;
        try view.controls.append(a, .{ .seq = view.next_control, .kind = .focus, .id = q.target });
        view.next_control += 1;
        try cl.queue(.{ .ok = true, .result = try location(r, q.target), .viewer = q.viewer });
        return true;
    }
    if (eq(q.action, "tab.new") or eq(q.action, "pane.split")) {
        const split = eq(q.action, "pane.split");
        const ws = if (split) r.workspaces.owner(q.target) orelse return error.NoPane else if (q.workspace != 0) try r.getWorkspace(q.workspace) else r.workspaces.owner(q.caller) orelse return error.MissingWorkspace;
        const source = if (split) r.pane(q.target) else r.pane(q.caller);
        if (source) |p| p.refreshCwd();
        const cwd = if (q.cwd.len > 0) q.cwd else if (source) |p| if (r.workspaces.owner(p.id).?.id == ws.id) p.cwd else ws.cwd else ws.cwd;
        const id = try r.create(.{ .workspace = ws.id, .split = if (split) .{ .pane = q.target, .axis = if (q.direction == .left or q.direction == .right) .horizontal else .vertical } else null, .cwd = cwd, .title = q.name, .cols = 80, .rows = 24, .theme = s.theme, .socket = s.socket, .executable = s.executable });
        if (split and (q.direction == .left or q.direction == .up)) {
            const x = ws.model.findNode(id).?;
            const y = ws.model.findNode(q.target).?;
            std.mem.swap(?layout.Node, &ws.model.nodes[x], &ws.model.nodes[y]);
        }
        s.dirty = true;
        try cl.queue(.{ .ok = true, .result = try location(r, id) });
        return true;
    }
    if (eq(q.action, "pane.read")) {
        const p = r.pane(q.target) orelse return error.NoPane;
        if (q.lines == 0 or q.lines > 10000) return error.InvalidLines;
        // Dump the active screen including its available scrollback, joining soft wraps.
        const screen = p.terminal.vt.screens.active;
        var dump: std.Io.Writer.Allocating = .init(a);
        defer dump.deinit();
        try screen.dumpString(&dump.writer, .{ .tl = screen.pages.getTopLeft(.screen), .unwrap = true });
        const text = dump.written();
        var end = text.len;
        while (end > 0 and std.mem.indexOfScalar(u8, " \t\r\n", text[end - 1]) != null) : (end -= 1) {}
        var start = end;
        var lines: usize = 1;
        while (start > 0) {
            if (text[start - 1] == '\n') {
                if (lines == q.lines) break;
                lines += 1;
            }
            start -= 1;
        }
        if (end - start > 512 * 1024) return error.OutputTooLarge;
        try cl.queue(.{ .ok = true, .text = text[start..end], .result = try location(r, q.target) });
        return true;
    }
    if (eq(q.action, "pane.send") or eq(q.action, "pane.keys")) {
        const p = r.pane(q.target) orelse return error.NoPane;
        var output: std.Io.Writer.Allocating = .init(a);
        defer output.deinit();
        if (eq(q.action, "pane.keys")) {
            var keys = std.mem.tokenizeScalar(u8, q.text, ' ');
            while (keys.next()) |key| try (try logicalKey(key)).encode(&output.writer, @import("terminal.zig").vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
        } else {
            const bracketed = p.terminal.vt.modes.get(.bracketed_paste);
            if (bracketed) try output.writer.writeAll("\x1b[200~");
            try output.writer.writeAll(q.text);
            if (bracketed) try output.writer.writeAll("\x1b[201~");
            if (q.enter) try (@import("keyboard.zig").Key{ .codepoint = 13, .mods = .{} }).encode(&output.writer, @import("terminal.zig").vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
        }
        try p.terminal.send(output.written());
        try cl.queue(.{ .ok = true, .result = try location(r, q.target) });
        return true;
    }
    if (eq(q.action, "pane.close") or eq(q.action, "tab.close")) {
        var ids: [layout.max_panes]u32 = undefined;
        var count: usize = 0;
        if (eq(q.action, "pane.close")) {
            _ = try location(r, q.target);
            ids[0] = q.target;
            count = 1;
        } else {
            const ws = try tabOwner(r, q.target);
            const index = try tabIndex(&ws.model, q.target);
            for (ws.model.nodes) |n| if (n) |node| if (node == .pane and ws.model.contains(ws.model.tabs[index].root, node.pane)) {
                ids[count] = node.pane;
                count += 1;
            };
        }
        try r.closed.ensureUnusedCapacity(a, count);
        for (ids[0..count]) |id| try s.close(id);
        s.dirty = true;
        try cl.queue(.{ .ok = true, .result = .{ .closed_panes = ids[0..count] } });
        return true;
    }
    const result = try edit(r, q);
    s.dirty = true;
    try cl.queue(.{ .ok = true, .result = result });
    return true;
}

pub fn logicalKey(name: []const u8) !@import("keyboard.zig").Key {
    var mods: @import("terminal.zig").vt.input.KeyMods = .{};
    var key = name;
    while (std.mem.indexOfScalar(u8, key, '+')) |i| {
        const mod = key[0..i];
        if (eq(mod, "ctrl")) mods.ctrl = true else if (eq(mod, "alt")) mods.alt = true else if (eq(mod, "shift")) mods.shift = true else return error.InvalidKey;
        key = key[i + 1 ..];
    }
    const names = [_][]const u8{ "esc", "enter", "tab", "backspace", "left", "right", "up", "down", "home", "end", "delete", "pageup", "pagedown", "space" };
    const codes = [_]u21{ 27, 13, 9, 127, 57350, 57351, 57352, 57353, 57356, 57357, 57349, 57354, 57355, 32 };
    for (names, codes) |n, cp| if (eq(key, n)) return .{ .codepoint = cp, .mods = mods };
    if (key.len == 1 and key[0] >= 32 and key[0] < 127) return .{ .codepoint = key[0], .mods = mods };
    return error.InvalidKey;
}

/// Work on copies; allocation/validation failures cannot partially detach a live tree.
fn edit(r: *Runtime, q: Request) !Location {
    const tab_op = std.mem.startsWith(u8, q.action, "tab.");
    const source = if (tab_op) try tabOwner(r, q.target) else r.workspaces.owner(q.target) orelse return error.NoPane;
    var src = source.model;
    const original = src;
    const source_index = if (tab_op) try tabIndex(&src, q.target) else src.tabForPane(q.target).?;
    var representative = if (tab_op) src.firstPane(src.tabs[source_index].root) else q.target;
    if (eq(q.action, "tab.rename")) {
        src.tabs[source_index].rename(q.name);
    } else if (eq(q.action, "pane.resize")) {
        if (q.ratio < 100 or q.ratio > 900) return error.InvalidRatio;
        try src.setShare(q.target, q.axis, q.ratio);
    } else {
        const destination = if (q.placement == .workspace) try r.getWorkspace(q.workspace) else if (q.placement == .before or q.placement == .after) try tabOwner(r, q.other) else if (q.placement == .beside or eq(q.action, "pane.swap")) r.workspaces.owner(q.other) orelse return error.NoPane else source;
        var dst_copy = destination.model;
        const dst = if (source == destination) &src else &dst_copy;
        if (eq(q.action, "pane.swap")) {
            const x = src.findNode(q.target).?;
            const y = dst.findNode(q.other) orelse return error.NoPane;
            std.mem.swap(?layout.Node, &src.nodes[x], &dst.nodes[y]);
        } else if (eq(q.action, "tab.move") and source == destination and (q.placement == .before or q.placement == .after)) {
            src.moveTab(q.target, (try tabIndex(&src, q.other)) + @intFromBool(q.placement == .after));
        } else if (eq(q.action, "tab.move") and source == destination and q.placement == .workspace) {
            // Already in this workspace.
        } else if (eq(q.action, "pane.move") or eq(q.action, "tab.move") or eq(q.action, "tab.merge")) {
            if (q.placement == .beside and src.contains(src.tabs[source_index].root, q.other) and (tab_op or q.target == q.other)) return error.InvalidDestination;
            const saved_tab = src.tabs[source_index];
            const root = if (tab_op) saved_tab.root else src.findNode(q.target).?;
            if (tab_op) src.removeTab(source_index) else try src.close(q.target);
            const copied = try dst.copyTree(&original, root);
            if (q.placement == .beside) {
                try dst.insertTree(copied, q.other, q.direction);
            } else {
                if (dst.count == layout.max_tabs) return error.TooManyTabs;
                var tab = saved_tab;
                tab.root = copied;
                if (!tab_op) {
                    tab.id = r.workspaces.next_pane_id;
                    tab.focus = q.target;
                    tab.zoom = false;
                    tab.rename(q.name);
                }
                dst.tabs[dst.count] = tab;
                dst.count += 1;
                if (q.placement == .before or q.placement == .after) dst.moveTab(tab.id, (try tabIndex(dst, q.other)) + @intFromBool(q.placement == .after));
            }
        } else return error.UnknownOperation;
        // Normalize focus after swaps/moves, preserving valid selection by stable ID.
        normalize(dst);
        if (source != destination) destination.model = dst.*;
        if (!tab_op and eq(q.action, "pane.move") and q.placement == .new_tab) r.workspaces.next_pane_id += 1;
        if (eq(q.action, "pane.swap")) representative = q.target;
    }
    normalize(&src);
    source.model = src;
    r.changed();
    return location(r, representative);
}
fn normalize(m: *layout.Model) void {
    for (m.tabs[0..m.count]) |*t| if (!m.contains(t.root, t.focus)) {
        t.focus = m.firstPane(t.root);
        t.zoom = false;
    };
    if (m.active >= m.count) m.active = m.count -| 1;
}
