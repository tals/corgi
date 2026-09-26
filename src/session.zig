//! One typed command interface for shared session state. Selection belongs to viewers.
const std = @import("std");
const os = @import("os.zig");
const layout = @import("layout.zig");
const runtime = @import("runtime.zig");
const Runtime = runtime.Runtime;
const Workspace = @import("workspace.zig").Workspace;
const Id = struct { target: u32 };
const Rename = struct { target: u32, name: []const u8 };
pub const Beside = struct { other: u32, direction: layout.Direction = .right };
pub const Destination = union(enum) { before: u32, after: u32, workspace: u32 };
pub const Command = union(enum) {
    @"agent.move": struct { workspace: u32, target: @import("agent_order.zig").Target, before: ?@import("agent_order.zig").Target = null },
    @"agent.command": struct { index: usize, command: []const u8, hidden: bool = false, name: ?[]const u8 = null, original: ?[]const u8 = null, semantics: ?@import("launch_command.zig").Semantics = null, resolve: bool = true, cwd: ?[]const u8 = null },
    @"agent.command.create": struct { workspace: u32, cwd: []const u8 = "", index: usize },
    @"agent.visibility": struct { hidden: [2]bool },
    @"agent.yolo": struct { provider: @import("agent_launcher.zig").Provider, enabled: bool },
    @"agent.create": struct { workspace: u32, cwd: []const u8 = "", provider: ?@import("agent_launcher.zig").Provider = null },
    @"pane.create": struct {
        workspace: u32,
        from: ?u32 = null,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.split": struct {
        target: u32,
        direction: layout.Direction = .right,
        cwd: []const u8 = "",
        command: ?[]const u8 = null,
        title: []const u8 = "",
    },
    @"pane.close": Id,
    @"tab.close": Id,
    @"pane.restore": struct { workspace: u32 },
    @"workspace.create": struct { name: []const u8 = "", cwd: []const u8 },
    @"workspace.edit": struct {
        target: u32,
        name: ?[]const u8 = null,
        cwd: ?[]const u8 = null,
    },
    @"workspace.close": struct { target: u32, close_contents: bool = false },
    @"workspace.move": struct { target: u32, before: u32 },
    @"pane.rename": Rename,
    @"tab.rename": Rename,
    @"pane.swap": struct { target: u32, other: u32 },
    @"pane.resize": struct {
        target: u32,
        axis: layout.Axis,
        ratio: u16,
    },
    @"split.resize": struct { target: u32, direction: layout.Direction },
    @"split.ratio": struct {
        target: u32,
        other: u32,
        ratio: u16,
        expected: u64,
    },
    @"pane.move": struct {
        target: u32,
        destination: union(enum) { beside: Beside, new_tab: []const u8 },
    },
    @"tab.move": struct { target: u32, destination: Destination },
    @"tab.merge": struct {
        target: u32,
        other: u32,
        direction: layout.Direction = .right,
    },
    @"pane.read": struct {
        target: u32,
        lines: usize = 100,
        view: enum { history, screen } = .history,
    },
    @"pane.send": struct {
        target: u32,
        text: []const u8,
        enter: bool = false,
    },
    @"pane.keys": struct { target: u32, text: []const u8 },
    @"pane.input": struct { target: u32, data: []const u8 },
};
pub const Context = struct {
    socket: []const u8,
    executable: []const u8,
    theme: @import("theme.zig").Theme,
};
pub const Result = struct {
    pane: u32 = 0,
    tab: u32 = 0,
    workspace: u32 = 0,
    text: ?[]const u8 = null,
    closed_panes: []const u32 = &.{},
};
pub fn location(r: *Runtime, pane: u32) !Result {
    const ws = r.workspaces.owner(pane) orelse return error.NoPane;
    return .{ .pane = pane, .tab = ws.model.tabs[ws.model.tabForPane(pane).?].id, .workspace = ws.id };
}
fn tabOwner(r: *Runtime, id: u32) !*Workspace {
    for (r.workspaces.items.items) |*ws| for (ws.model.tabs[0..ws.model.count]) |t| {
        if (t.id == id) return ws;
    };
    return error.NoTab;
}
fn tabIndex(m: *const layout.Model, id: u32) !usize {
    for (m.tabs[0..m.count], 0..) |t, i| if (t.id == id) return i;
    return error.NoTab;
}
fn spawnOptions(r: *Runtime, ctx: Context, workspace: u32, from: ?u32, cwd: []const u8) !runtime.Runtime.Create {
    const ws = try r.getWorkspace(workspace);
    const dir = if (cwd.len > 0) cwd else if (from) |id| blk: {
        const p = r.pane(id) orelse return error.NoPane;
        if (r.workspaces.owner(id).?.id != workspace) return error.InvalidDestination;
        p.refreshCwd();
        break :blk p.cwd;
    } else ws.cwd;
    return .{ .workspace = workspace, .cwd = dir, .cols = 80, .rows = 24, .theme = ctx.theme, .socket = ctx.socket, .executable = ctx.executable };
}
/// Returned strings/arrays belong to the request allocator. Structural edits
/// prepare copies before committing; process creation owns its rollback in Runtime.
pub fn execute(r: *Runtime, ctx: Context, cmd: Command, alloc: std.mem.Allocator) !Result {
    switch (cmd) {
        .@"agent.move" => |q| {
            const order = @import("agent_order.zig");
            const ws = try r.getWorkspace(q.workspace);
            var live: [order.capacity]order.Target = undefined;
            var count: usize = 0;
            // Include shells so a temporary loss of agent detection does not
            // erase their saved position. IDs are validated within this workspace.
            for (ws.model.tabs[0..ws.model.count], 0..) |_, tab_index| {
                for (r.panes.items) |p| if (ws.model.tabForPane(p.id) == tab_index) {
                    if (count == live.len) return error.TooManyAgents;
                    live[count] = .{ .pane = p.id };
                    count += 1;
                };
            }
            for (r.sessions.items) |session| if (session.workspace_id == ws.id) {
                if (count == live.len) return error.TooManyAgents;
                live[count] = .{ .native = session.id };
                count += 1;
            };
            try ws.agent_order.move(live[0..count], q.target, q.before);
        },
        .@"agent.command" => |q| {
            if (q.index >= r.agent_commands.len) return error.InvalidCommand;
            const source = if (q.resolve and q.command.len > 0) try @import("launch_command.zig").resolve(q.command, q.cwd, alloc) else q.command;
            defer if (q.resolve and q.command.len > 0) alloc.free(source);
            try r.agent_commands[q.index].set(source);
            if (q.original) |original| try r.agent_commands[q.index].setOriginal(original) else if (q.resolve) try r.agent_commands[q.index].setOriginal(q.command);
            if (q.name) |name| r.agent_commands[q.index].name.set(name);
            if (source.len == 0) r.agent_commands[q.index] = .{} else {
                r.agent_commands[q.index].semantics = q.semantics orelse @import("launch_command.zig").analyze(source, q.cwd orelse ".");
            }
            r.agent_commands[q.index].hidden = r.agent_commands[q.index].len > 0 and q.hidden;
            r.changed();
            return .{};
        },
        .@"agent.command.create" => |q| {
            if (q.index >= r.agent_commands.len) return error.InvalidCommand;
            const entry = &r.agent_commands[q.index];
            if (entry.len == 0) return error.InvalidCommand;
            var opts = try spawnOptions(r, ctx, q.workspace, null, q.cwd);
            opts.command = entry.text();
            opts.interactive_command = true;
            return location(r, try r.create(opts));
        },
        .@"agent.visibility" => |q| {
            r.agent_hidden = q.hidden;
            r.changed();
            return .{};
        },
        .@"agent.yolo" => |q| {
            r.agent_yolo[@intFromEnum(q.provider)] = q.enabled;
            r.changed();
            return .{};
        },
        .@"agent.create" => |q| {
            const provider = q.provider orelse r.last_agent;
            var opts = try spawnOptions(r, ctx, q.workspace, null, q.cwd);
            const executable = try @import("integration.zig").shellQuote(ctx.executable);
            defer os.allocator.free(executable);
            const command = try std.fmt.allocPrint(alloc, "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT {s} agent {s}{s}", .{ executable, @tagName(provider), if (!r.agent_yolo[@intFromEnum(provider)]) "" else switch (provider) {
                .codex => " --dangerously-bypass-approvals-and-sandbox",
                .claude => " --dangerously-skip-permissions",
            } });
            opts.command = command;
            const pane = try r.create(opts);
            r.last_agent = provider;
            return location(r, pane);
        },
        .@"pane.create" => |q| {
            var opts = try spawnOptions(r, ctx, q.workspace, q.from, q.cwd);
            opts.command = q.command;
            opts.title = q.title;
            return location(r, try r.create(opts));
        },
        .@"pane.split" => |q| {
            const ws = r.workspaces.owner(q.target) orelse return error.NoPane;
            var opts = try spawnOptions(r, ctx, ws.id, q.target, q.cwd);
            opts.command = q.command;
            opts.title = q.title;
            opts.split = .{ .pane = q.target, .axis = if (q.direction == .left or q.direction == .right) .horizontal else .vertical, .before = q.direction == .left or q.direction == .up };
            return location(r, try r.create(opts));
        },
        .@"workspace.create" => |q| {
            const id = try r.createWorkspace(q.name, .{ .workspace = 0, .cwd = q.cwd, .cols = 80, .rows = 24, .theme = ctx.theme, .socket = ctx.socket, .executable = ctx.executable });
            const ws = try r.getWorkspace(id);
            return location(r, ws.model.firstPane(ws.model.tabs[0].root));
        },
        .@"workspace.edit" => |q| {
            const ws = try r.getWorkspace(q.target);
            try r.workspaces.edit(q.target, q.name orelse ws.customName(), q.cwd orelse ws.cwd);
        },
        .@"workspace.close" => |q| try r.closeWorkspace(q.target, q.close_contents),
        .@"workspace.move" => |q| try r.workspaces.moveBefore(q.target, q.before),
        .@"pane.restore" => |q| return location(r, try r.restore(try spawnOptions(r, ctx, q.workspace, null, ""))),
        .@"pane.close", .@"tab.close" => |q| {
            const ids = try alloc.alloc(u32, layout.max_panes);
            var count: usize = 0;
            if (cmd == .@"pane.close") {
                _ = try location(r, q.target);
                ids[0] = q.target;
                count = 1;
            } else {
                const ws = try tabOwner(r, q.target);
                const root = ws.model.tabs[try tabIndex(&ws.model, q.target)].root;
                for (ws.model.nodes) |slot| if (slot) |node| if (node == .pane and ws.model.contains(root, node.pane)) {
                    ids[count] = node.pane;
                    count += 1;
                };
            }
            try r.closed.ensureUnusedCapacity(os.allocator, count);
            for (ids[0..count]) |id| try r.close(id);
            return .{ .closed_panes = ids[0..count] };
        },
        .@"pane.read" => |q| {
            const p = r.pane(q.target) orelse return error.NoPane;
            if (q.view == .screen) {
                const text = try p.terminal.text();
                defer os.allocator.free(text);
                var result = try location(r, q.target);
                result.text = try alloc.dupe(u8, text);
                return result;
            }
            if (q.lines == 0 or q.lines > 10000) return error.InvalidLines;
            const screen = p.terminal.vt.screens.active;
            var dump: std.Io.Writer.Allocating = .init(alloc);
            defer dump.deinit();
            try screen.dumpString(&dump.writer, .{ .tl = screen.pages.getTopLeft(.screen), .unwrap = true });
            const text = std.mem.trimEnd(u8, dump.written(), " \t\r\n");
            var start = text.len;
            var lines: usize = 1;
            while (start > 0) {
                if (text[start - 1] == '\n') {
                    if (lines == q.lines) break;
                    lines += 1;
                }
                start -= 1;
            }
            if (text.len - start > 512 * 1024) return error.OutputTooLarge;
            var result = try location(r, q.target);
            result.text = try alloc.dupe(u8, text[start..]);
            return result;
        },
        .@"pane.send" => |q| {
            const p = r.pane(q.target) orelse return error.NoPane;
            var output: std.Io.Writer.Allocating = .init(alloc);
            defer output.deinit();
            const bracketed = p.terminal.vt.modes.get(.bracketed_paste);
            if (bracketed) try output.writer.writeAll("\x1b[200~");
            try output.writer.writeAll(q.text);
            if (bracketed) try output.writer.writeAll("\x1b[201~");
            if (q.enter) try (try logicalKey("enter")).encode(&output.writer, @import("terminal.zig").vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
            try p.terminal.send(output.written());
            return location(r, q.target);
        },
        .@"pane.keys" => |q| {
            const p = r.pane(q.target) orelse return error.NoPane;
            var output: std.Io.Writer.Allocating = .init(alloc);
            defer output.deinit();
            var keys = std.mem.tokenizeScalar(u8, q.text, ' ');
            while (keys.next()) |key| try (try logicalKey(key)).encode(&output.writer, @import("terminal.zig").vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
            p.detection.observeInput(output.written(), std.time.microTimestamp());
            try p.terminal.send(output.written());
            return location(r, q.target);
        },
        .@"pane.input" => |q| {
            const p = r.pane(q.target) orelse return error.NoPane;
            p.detection.observeInput(q.data, std.time.microTimestamp());
            try p.terminal.send(q.data);
            return location(r, q.target);
        },
        else => return arrange(r, cmd),
    }
    r.changed();
    return .{};
}
fn arrange(r: *Runtime, cmd: Command) !Result {
    const target = switch (cmd) {
        .@"tab.rename", .@"pane.rename" => |q| q.target,
        .@"pane.swap" => |q| q.target,
        .@"pane.resize" => |q| q.target,
        .@"split.resize" => |q| q.target,
        .@"split.ratio" => |q| q.target,
        .@"pane.move" => |q| q.target,
        .@"tab.move" => |q| q.target,
        .@"tab.merge" => |q| q.target,
        else => unreachable,
    };
    const tab_op = switch (cmd) {
        .@"tab.rename", .@"tab.move", .@"tab.merge" => true,
        else => false,
    };
    const source = if (tab_op) try tabOwner(r, target) else r.workspaces.owner(target) orelse return error.NoPane;
    var src = source.model;
    const original = src;
    const index = if (tab_op) try tabIndex(&src, target) else src.tabForPane(target).?;
    const representative = if (tab_op) src.firstPane(src.tabs[index].root) else target;
    switch (cmd) {
        .@"tab.rename" => |q| src.tabs[index].rename(q.name),
        .@"pane.rename" => |q| (r.pane(target) orelse return error.NoPane).label.set(q.name),
        .@"split.resize" => |q| src.resize(target, q.direction),
        .@"pane.resize" => |q| {
            if (q.ratio < 100 or q.ratio > 900) return error.InvalidRatio;
            try src.setShare(target, q.axis, q.ratio);
        },
        .@"split.ratio" => |q| {
            if (source.model.revision != q.expected) return error.StaleLayout;
            if (q.ratio < 100 or q.ratio > 900) return error.InvalidRatio;
            const node = for (&src.nodes) |*slot| {
                if (slot.*) |n| if (n == .split and src.firstPane(n.split.first) == target and src.firstPane(n.split.second) == q.other) break slot;
            } else return error.NoSplit;
            node.*.?.split.ratio = q.ratio;
        },
        else => {
            const Placement = union(enum) { beside: Beside, new_tab: []const u8, tab: Destination, swap: u32 };
            const place: Placement = switch (cmd) {
                .@"pane.swap" => |q| .{ .swap = q.other },
                .@"pane.move" => |q| switch (q.destination) {
                    .beside => |d| .{ .beside = d },
                    .new_tab => |name| .{ .new_tab = name },
                },
                .@"tab.merge" => |q| .{ .beside = .{ .other = q.other, .direction = q.direction } },
                .@"tab.move" => |q| .{ .tab = q.destination },
                else => unreachable,
            };
            const destination = switch (place) {
                .swap => |other| r.workspaces.owner(other) orelse return error.NoPane,
                .beside => |d| r.workspaces.owner(d.other) orelse return error.NoPane,
                .new_tab => source,
                .tab => |d| switch (d) {
                    .workspace => |id| try r.getWorkspace(id),
                    .before, .after => |id| try tabOwner(r, id),
                },
            };
            var dst_copy = destination.model;
            const dst = if (source == destination) &src else &dst_copy;
            if (place == .swap) {
                std.mem.swap(?layout.Node, &src.nodes[src.findNode(target).?], &dst.nodes[dst.findNode(place.swap).?]);
            } else if (place == .tab and source == destination) {
                switch (place.tab) {
                    .before, .after => |other| src.moveTab(target, (try tabIndex(&src, other)) + @intFromBool(place.tab == .after)),
                    .workspace => {},
                }
            } else {
                if (place == .beside and src.contains(src.tabs[index].root, place.beside.other) and (tab_op or target == place.beside.other)) return error.InvalidDestination;
                const saved = src.tabs[index];
                const root = if (tab_op) saved.root else src.findNode(target).?;
                if (tab_op) src.removeTab(index) else try src.close(target);
                const copied = try dst.copyTree(&original, root);
                if (place == .beside) {
                    try dst.insertTree(copied, place.beside.other, place.beside.direction);
                } else {
                    if (dst.count == layout.max_tabs) return error.TooManyTabs;
                    var tab = saved;
                    tab.root = copied;
                    if (!tab_op) {
                        tab.id = r.workspaces.next_pane_id;
                        tab.rename(place.new_tab);
                    }
                    dst.tabs[dst.count] = tab;
                    dst.count += 1;
                    if (place == .tab) switch (place.tab) {
                        .before, .after => |other| dst.moveTab(tab.id, (try tabIndex(dst, other)) + @intFromBool(place.tab == .after)),
                        .workspace => {},
                    };
                }
            }
            if (source != destination) {
                dst.revision +%= 1;
                destination.model = dst.*;
            }
            if (place == .new_tab) r.workspaces.next_pane_id += 1;
        },
    }
    src.revision +%= 1;
    source.model = src;
    r.changed();
    return location(r, representative);
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

fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
