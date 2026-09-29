//! One typed command interface for shared session state. Selection belongs to viewers.
const std = @import("std");
const os = @import("os.zig");
const pane_label = @import("pane.zig").label;
const layout = @import("layout.zig");
const runtime = @import("runtime.zig");
const Runtime = runtime.Runtime;
const Workspace = @import("workspace.zig").Workspace;
const WorkspaceId = Workspace.Id;
const PaneId = layout.PaneId;
const TabId = layout.TabId;
const keys = @import("keys.zig");
const agents = @import("agents.zig");
const ActorId = @import("conversations.zig").Actor.Id;
const options = @import("corgi_options");
const protocol = @import("protocol.zig");
const Command = protocol.Command;
const Result = protocol.Result;
const Theme = @import("theme.zig").Theme;
const ordering = @import("agent_order.zig");
const launch_command = @import("launch.zig").command;
const terminal = @import("pane.zig").terminal;
pub const Context = struct {
    socket: []const u8,
    executable: []const u8,
    theme: Theme,
};
pub fn location(r: *Runtime, pane: PaneId) !Result {
    const ws = r.workspaces.owner(pane) orelse return error.NoPane;
    return .{ .pane = pane, .tab = ws.model.tabs[ws.model.tabForPane(pane).?].id, .workspace = ws.id };
}
fn tabOwner(r: *Runtime, id: TabId) !*Workspace {
    for (r.workspaces.items.items) |*ws| for (ws.model.tabs[0..ws.model.count]) |t| {
        if (t.id == id) return ws;
    };
    return error.NoTab;
}
fn tabIndex(m: *const layout.Model, id: TabId) !usize {
    for (m.tabs[0..m.count], 0..) |t, i| if (t.id == id) return i;
    return error.NoTab;
}
fn spawnOptions(r: *Runtime, ctx: Context, workspace: WorkspaceId, from: ?PaneId, cwd: []const u8) !runtime.Runtime.Create {
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
            const ws = try r.getWorkspace(q.workspace);
            var live: [ordering.capacity]ordering.Target = undefined;
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
            const source = if (q.resolve and q.command.len > 0) try launch_command.resolve(q.command, q.cwd, alloc) else q.command;
            defer if (q.resolve and q.command.len > 0) alloc.free(source);
            try r.agent_commands[q.index].set(source);
            if (q.original) |original| try r.agent_commands[q.index].setOriginal(original) else if (q.resolve) try r.agent_commands[q.index].setOriginal(q.command);
            if (q.name) |name| r.agent_commands[q.index].name = .ascii(name);
            if (source.len == 0) r.agent_commands[q.index] = .{} else {
                r.agent_commands[q.index].semantics = q.semantics orelse launch_command.analyze(source, q.cwd orelse ".");
            }
            r.agent_commands[q.index].hidden = r.agent_commands[q.index].command.len > 0 and q.hidden;
            r.changed();
            return .{};
        },
        .@"agent.command.create" => |q| {
            if (q.index >= r.agent_commands.len) return error.InvalidCommand;
            const entry = &r.agent_commands[q.index];
            if (entry.command.len == 0) return error.InvalidCommand;
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
            r.agent_yolo.set(q.provider, q.enabled);
            r.changed();
            return .{};
        },
        .@"agent.create" => |q| {
            const provider = q.provider orelse r.last_agent;
            var opts = try spawnOptions(r, ctx, q.workspace, null, q.cwd);
            const executable = try os.shellQuote(os.allocator, ctx.executable);
            defer os.allocator.free(executable);
            const yolo = r.agent_yolo.get(provider);
            const command = try std.fmt.allocPrint(alloc, "env -u CLAUDECODE -u CLAUDE_CODE_ENTRYPOINT {s} agent {t}{s}{s}", .{
                executable,
                provider,
                if (yolo) " " else "",
                if (yolo) provider.info().yolo_flag else "",
            });
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
            const id = try r.createWorkspace(q.name, .{ .workspace = .none, .cwd = q.cwd, .cols = 80, .rows = 24, .theme = ctx.theme, .socket = ctx.socket, .executable = ctx.executable });
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
        .@"pane.close" => |q| {
            const ids = try alloc.alloc(PaneId, layout.max_panes);
            _ = try location(r, q.target);
            ids[0] = q.target;
            try r.closed.ensureUnusedCapacity(os.allocator, 1);
            try r.close(q.target);
            return .{ .closed_panes = ids[0..1] };
        },
        .@"tab.close" => |q| {
            const ids = try alloc.alloc(PaneId, layout.max_panes);
            var count: usize = 0;
            const ws = try tabOwner(r, q.target);
            const root = ws.model.tabs[try tabIndex(&ws.model, q.target)].root;
            for (ws.model.nodes) |slot| if (slot) |node| if (node == .pane and ws.model.contains(root, node.pane)) {
                ids[count] = node.pane;
                count += 1;
            };
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
            if (q.enter) try (try keys.logicalKey("enter")).encode(&output.writer, terminal.vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
            try p.terminal.send(output.written());
            return location(r, q.target);
        },
        .@"pane.keys" => |q| {
            const p = r.pane(q.target) orelse return error.NoPane;
            var output: std.Io.Writer.Allocating = .init(alloc);
            defer output.deinit();
            var names = std.mem.tokenizeScalar(u8, q.text, ' ');
            while (names.next()) |key| try (try keys.logicalKey(key)).encode(&output.writer, terminal.vt.input.KeyEncodeOptions.fromTerminal(&p.terminal.vt));
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
    // Panes and tabs share one numeric target space on the wire; recover
    // whichever typed id this command actually addresses.
    const target: u32 = switch (cmd) {
        .@"tab.rename" => |q| @intFromEnum(q.target),
        .@"tab.move" => |q| @intFromEnum(q.target),
        .@"tab.merge" => |q| @intFromEnum(q.target),
        .@"pane.rename" => |q| @intFromEnum(q.target),
        .@"pane.swap" => |q| @intFromEnum(q.target),
        .@"pane.resize" => |q| @intFromEnum(q.target),
        .@"split.resize" => |q| @intFromEnum(q.target),
        .@"split.ratio" => |q| @intFromEnum(q.target),
        .@"pane.move" => |q| @intFromEnum(q.target),
        else => unreachable,
    };
    const tab_op = switch (cmd) {
        .@"tab.rename", .@"tab.move", .@"tab.merge" => true,
        else => false,
    };
    const pane_target: PaneId = @enumFromInt(target);
    const tab_target: TabId = @enumFromInt(target);
    const source = if (tab_op) try tabOwner(r, tab_target) else r.workspaces.owner(pane_target) orelse return error.NoPane;
    var src = source.model;
    const original = src;
    const index = if (tab_op) try tabIndex(&src, tab_target) else src.tabForPane(pane_target).?;
    const representative = if (tab_op) src.firstPane(src.tabs[index].root) else pane_target;
    switch (cmd) {
        .@"tab.rename" => |q| src.tabs[index].rename(q.name),
        .@"pane.rename" => |q| (r.pane(pane_target) orelse return error.NoPane).label = pane_label.label(q.name),
        .@"split.resize" => |q| src.resize(pane_target, q.direction),
        .@"pane.resize" => |q| {
            if (q.ratio < 100 or q.ratio > 900) return error.InvalidRatio;
            try src.setShare(pane_target, q.axis, q.ratio);
        },
        .@"split.ratio" => |q| {
            if (source.model.revision != q.expected) return error.StaleLayout;
            if (q.ratio < 100 or q.ratio > 900) return error.InvalidRatio;
            const node = for (&src.nodes) |*slot| {
                if (slot.*) |n| if (n == .split and src.firstPane(n.split.first) == pane_target and src.firstPane(n.split.second) == q.other) break slot;
            } else return error.NoSplit;
            node.*.?.split.ratio = q.ratio;
        },
        else => {
            const Placement = union(enum) { beside: protocol.Beside, new_tab: []const u8, tab: protocol.Destination, swap: PaneId };
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
                std.mem.swap(?layout.Node, &src.nodes[src.findNode(pane_target).?], &dst.nodes[dst.findNode(place.swap).?]);
            } else if (place == .tab and source == destination) {
                switch (place.tab) {
                    .before, .after => |other| src.moveTab(tab_target, (try tabIndex(&src, other)) + @intFromBool(place.tab == .after)),
                    .workspace => {},
                }
            } else {
                if (place == .beside and src.contains(src.tabs[index].root, place.beside.other) and (tab_op or pane_target == place.beside.other)) return error.InvalidDestination;
                const saved = src.tabs[index];
                const root = if (tab_op) saved.root else src.findNode(pane_target).?;
                if (tab_op) src.removeTab(index) else try src.close(pane_target);
                const copied = try dst.copyTree(&original, root);
                if (place == .beside) {
                    try dst.insertTree(copied, place.beside.other, place.beside.direction);
                } else {
                    if (dst.count == layout.max_tabs) return error.TooManyTabs;
                    var tab = saved;
                    tab.root = copied;
                    if (!tab_op) {
                        // Tab ids share the pane-id counter: a tab created by a pane
                        // move/merge takes the next counter value as its own id.
                        tab.id = @enumFromInt(@intFromEnum(r.workspaces.next_pane_id));
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
            if (place == .new_tab) r.workspaces.next_pane_id = r.workspaces.next_pane_id.next();
        },
    }
    src.revision +%= 1;
    source.model = src;
    r.changed();
    return location(r, representative);
}

fn agentView(state: *const agents.Agent, conversation: ActorId) protocol.Agent {
    return .{
        .conversation = conversation,
        .subagents = state.subagents,
        .changed_at = state.changed_at,
        .provider = state.provider,
        .state = state.state,
        .attention = state.attention,
        .observation = state.observation,
        .recent_activity = state.recentLabel(),
        .name = state.displayName(),
        .session = state.sessionId(),
        .activity = state.activity.text(),
        .cwd = state.directory(),
        .tool_active = state.tool_active,
        .compacting = state.compacting,
    };
}

/// Allocate containers in a request arena; strings borrow the runtime until
/// serialization completes. Process resources remain in the runtime.
pub fn snapshot(allocator: std.mem.Allocator, r: *Runtime) !protocol.Snapshot {
    return build(allocator, r, false);
}
/// A viewer syncs every 30 ms and gets a new session only when this copy's
/// hash changes. It leaves out what moves while nothing shown changes: the
/// revision, which every PTY read bumps, freshness stamps finer than
/// `protocol.stamp_bucket`, which the viewer only compares against a window, and
/// resources, which `viewer.sync` sends beside the session.
pub fn viewerSnapshot(allocator: std.mem.Allocator, r: *Runtime) !protocol.Snapshot {
    return build(allocator, r, true);
}
fn coarse(stamp: i64) i64 {
    return if (stamp <= 0) stamp else @divFloor(stamp, protocol.stamp_bucket) * protocol.stamp_bucket;
}
fn build(allocator: std.mem.Allocator, r: *Runtime, viewer: bool) !protocol.Snapshot {
    const workspaces = try allocator.alloc(protocol.Workspace, r.workspaces.items.items.len);
    for (r.workspaces.items.items, workspaces) |*ws, *out| {
        const commits = try allocator.alloc(protocol.GitCommit, ws.git_commits.len);
        for (ws.git_commits.items[0..ws.git_commits.len], commits) |*commit, *dest| {
            dest.* = .{
                .timestamp = commit.timestamp,
                .hash = commit.hash.text(),
                .subject = commit.subject.text(),
                .author = commit.author.text(),
                .date = commit.date.text(),
            };
        }
        out.* = .{
            .agent_order = ws.agent_order.slice(),
            .git_commits = commits,
            .id = ws.id,
            .name = ws.name(),
            .cwd = ws.cwd,
            .custom_name = ws.customName(),
            .git_ahead = ws.git_ahead,
            .git_ref = ws.git_ref.view(),
            .git_push = ws.git_push.view(),
            .stats = ws.away.counts,
            .model = ws.model,
        };
    }
    const panes = try allocator.alloc(protocol.Pane, r.panes.items.len);
    for (r.panes.items, panes) |*p, *out| {
        const owner = r.workspaces.owner(p.id) orelse return error.NoWorkspace;
        const tab = owner.model.tabForPane(p.id) orelse return error.NoTab;
        out.* = .{
            .id = p.id,
            .binding = p.attachment.generation,
            .name = p.label.text(),
            .workspace = owner.id,
            .tab = owner.model.tabs[tab].id,
            .cwd = p.cwd,
            .pid = p.terminal.pid,
            .cols = p.terminal.vt.cols,
            .rows = p.terminal.vt.rows,
            .exited = p.terminal.exited,
            .agent = agentView(p.agent(), if (p.attachment.actor) |actor| actor.id else .none),
        };
    }
    const sessions = try allocator.alloc(protocol.Native, r.sessions.items.len);
    for (r.sessions.items, sessions) |*session, *out| out.* = .{
        .agent = agentView(session.attachment.agent(), if (session.attachment.actor) |actor| actor.id else .none),
        .id = session.id,
        .workspace = session.workspace_id,
        .provider = session.provider,
        .cwd = session.cwd,
        .ready = session.ready,
        .exited = session.exited,
        .state = session.status(),
        .attention = session.attention(),
        .observation = session.observation(),
        .tool_active = session.toolActive(),
    };
    const conversations = try allocator.alloc(protocol.Conversation, r.conversations.items.items.len);
    for (r.conversations.items.items, conversations) |actor, *out| {
        const current_usage = actor.usageView(std.time.milliTimestamp());
        const points = try allocator.alloc(protocol.Conversation.ActivityPoint, actor.activity_timeline.len);
        for (actor.activity_timeline.points[0..actor.activity_timeline.len], points) |*point, *dst| {
            dst.* = .{ .at = point.at, .activity = point.label.text(), .usage = point.usage };
        }
        var attachments: u32 = 0;
        for (r.panes.items) |p| if (!p.terminal.exited and p.attachment.actor == actor) {
            attachments += 1;
        };
        for (r.sessions.items) |native_session| if (!native_session.exited) {
            for (native_session.members.items) |member| if (member == actor) {
                attachments += 1;
                break;
            };
        };
        out.* = .{
            .id = actor.id,
            .parent = actor.parent,
            .workspace = actor.workspace,
            .observed_at = actor.observed_at,
            .attachments = attachments,
            .role = actor.role.text(),
            .background_tasks = try actor.background_tasks.view(allocator),
            .model = actor.model.text(),
            .usage = current_usage,
            .context = actor.context.view(&r.conversations.compaction_points),
            .timeline = .{ .points = points, .pending = actor.activity_timeline.pending(current_usage) },
            .children_observed_at = actor.children_observed_at,
            .agent = agentView(&actor.state, actor.id),
        };
        if (viewer) {
            out.observed_at = coarse(out.observed_at);
            out.children_observed_at = coarse(out.children_observed_at);
            out.background_tasks.observed_at = coarse(out.background_tasks.observed_at);
        }
    }
    return .{
        .conversations = conversations,
        .release_version = options.release_version,
        .release_commit = options.release_commit,
        .staged_version = r.staged_version,
        .system_model = r.system_model,
        .inference = r.inference,
        .system_usage = r.system_usage,
        .system_working = r.system_working,
        .server_pid = os.c.getpid(),
        .ports = try r.link_labels.snapshot(allocator, r.ports.current),
        .resources = if (viewer) .{} else r.resources.current,
        .revision = if (viewer) 0 else r.revision,
        .last_agent = r.last_agent,
        .agent_yolo = r.agent_yolo,
        .agent_hidden = r.agent_hidden,
        .agent_commands = r.agent_commands,
        .workspaces = workspaces,
        .panes = panes,
        .native_sessions = sessions,
        .closed_panes = r.closed.items.len,
    };
}

const test_context: Context = .{ .socket = "", .executable = "", .theme = .{} };
/// Adds a tab, or splits `split` to the right, as Runtime.create does, without a process.
fn testPane(r: *Runtime, workspace: WorkspaceId, split: ?PaneId) !PaneId {
    const ws = try r.getWorkspace(workspace);
    ws.model.next_id = r.workspaces.next_pane_id;
    const id = if (split) |target| try ws.model.split(target, .horizontal) else try ws.model.newTab("");
    r.workspaces.next_pane_id = ws.model.next_id;
    return id;
}
/// Every workspace's tabs and nodes.
fn testTopology(r: *Runtime) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for (r.workspaces.items.items) |ws| try out.writer.print("{d} {f}\n", .{ @intFromEnum(ws.id), std.json.fmt(ws.model, .{}) });
    return out.toOwnedSlice();
}

test "moving a pane or tab into a full workspace fails and changes nothing" {
    var r: Runtime = .{};
    defer r.deinit();
    const full = try r.workspaces.add("full", "/tmp");
    const other = try r.workspaces.add("other", "/tmp");
    const one = try testPane(&r, full, null);
    const split = try testPane(&r, full, one);
    var lone = one;
    for (1..layout.max_tabs) |_| lone = try testPane(&r, full, null);
    const outside = (try location(&r, try testPane(&r, other, null))).tab;
    const before = try testTopology(&r);
    defer std.testing.allocator.free(before);
    const next_pane_id = r.workspaces.next_pane_id;
    const revision = r.revision;
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.TooManyTabs, execute(&r, test_context, .{ .@"pane.move" = .{ .target = split, .destination = .{ .new_tab = "" } } }, alloc));
    try std.testing.expectError(error.TooManyTabs, execute(&r, test_context, .{ .@"tab.move" = .{ .target = outside, .destination = .{ .workspace = full } } }, alloc));
    try std.testing.expectError(error.TooManyTabs, execute(&r, test_context, .{ .@"tab.move" = .{ .target = outside, .destination = .{ .after = (try location(&r, one)).tab } } }, alloc));
    const after = try testTopology(&r);
    defer std.testing.allocator.free(after);
    try std.testing.expectEqualStrings(before, after);
    try std.testing.expectEqual(next_pane_id, r.workspaces.next_pane_id);
    try std.testing.expectEqual(revision, r.revision);
    // A pane alone in its tab frees that tab as it moves.
    const moved = try execute(&r, test_context, .{ .@"pane.move" = .{ .target = lone, .destination = .{ .new_tab = "Logs" } } }, alloc);
    try std.testing.expectEqual(@as(u32, @intFromEnum(next_pane_id)), @intFromEnum(moved.tab));
    try std.testing.expectEqual(next_pane_id.next(), r.workspaces.next_pane_id);
    try std.testing.expectEqual(layout.max_tabs, r.workspaces.get(full).?.model.count);
}

test "a tab cannot merge into itself, and missing destinations change nothing" {
    var r: Runtime = .{};
    defer r.deinit();
    const ws = try r.workspaces.add("", "/tmp");
    const one = try testPane(&r, ws, null);
    const split = try testPane(&r, ws, one);
    const two = try testPane(&r, ws, null);
    const tab = (try location(&r, one)).tab;
    const missing: PaneId = @enumFromInt(999999);
    const before = try testTopology(&r);
    defer std.testing.allocator.free(before);
    const alloc = std.testing.allocator;
    try std.testing.expectError(error.InvalidDestination, execute(&r, test_context, .{ .@"tab.merge" = .{ .target = tab, .other = split } }, alloc));
    try std.testing.expectError(error.InvalidDestination, execute(&r, test_context, .{ .@"pane.move" = .{ .target = split, .destination = .{ .beside = .{ .other = split } } } }, alloc));
    try std.testing.expectError(error.NoPane, execute(&r, test_context, .{ .@"pane.move" = .{ .target = one, .destination = .{ .beside = .{ .other = missing } } } }, alloc));
    try std.testing.expectError(error.NoPane, execute(&r, test_context, .{ .@"pane.move" = .{ .target = missing, .destination = .{ .new_tab = "" } } }, alloc));
    try std.testing.expectError(error.NoPane, execute(&r, test_context, .{ .@"pane.swap" = .{ .target = one, .other = missing } }, alloc));
    try std.testing.expectError(error.NoTab, execute(&r, test_context, .{ .@"tab.move" = .{ .target = tab, .destination = .{ .before = @enumFromInt(999999) } } }, alloc));
    try std.testing.expectError(error.NoWorkspace, execute(&r, test_context, .{ .@"tab.move" = .{ .target = tab, .destination = .{ .workspace = @enumFromInt(99) } } }, alloc));
    try std.testing.expectError(error.NoSplit, execute(&r, test_context, .{ .@"pane.resize" = .{ .target = two, .axis = .horizontal, .ratio = 600 } }, alloc));
    try std.testing.expectError(error.InvalidRatio, execute(&r, test_context, .{ .@"pane.resize" = .{ .target = one, .axis = .horizontal, .ratio = 50 } }, alloc));
    const after = try testTopology(&r);
    defer std.testing.allocator.free(after);
    try std.testing.expectEqualStrings(before, after);
}

test "merging a tab moves its whole tree beside a pane in any workspace" {
    var r: Runtime = .{};
    defer r.deinit();
    const home = try r.workspaces.add("", "/tmp");
    const away = try r.workspaces.add("", "/tmp");
    const left = try testPane(&r, home, null);
    const right = try testPane(&r, home, left);
    const target = try testPane(&r, home, null);
    const kept = (try location(&r, target)).tab;
    const alloc = std.testing.allocator;
    const merged = try execute(&r, test_context, .{ .@"tab.merge" = .{ .target = (try location(&r, left)).tab, .other = target } }, alloc);
    try std.testing.expectEqualDeep(Result{ .pane = left, .tab = kept, .workspace = home }, merged);
    const m = &r.workspaces.get(home).?.model;
    try std.testing.expectEqual(1, m.count);
    const root = m.nodes[m.tabs[0].root].?.split;
    try std.testing.expectEqual(layout.Axis.horizontal, root.axis);
    try std.testing.expectEqual(target, m.firstPane(root.first));
    const moved = m.nodes[root.second].?.split;
    try std.testing.expectEqual(left, m.firstPane(moved.first));
    try std.testing.expectEqual(right, m.firstPane(moved.second));

    const lone = try testPane(&r, away, null);
    const revisions = .{ m.revision, r.workspaces.get(away).?.model.revision };
    const joined = try execute(&r, test_context, .{ .@"tab.merge" = .{ .target = (try location(&r, lone)).tab, .other = right, .direction = .down } }, alloc);
    try std.testing.expectEqualDeep(Result{ .pane = lone, .tab = kept, .workspace = home }, joined);
    try std.testing.expectEqual(0, r.workspaces.get(away).?.model.count);
    const below = m.nodes[moved.second].?.split;
    try std.testing.expectEqual(layout.Axis.vertical, below.axis);
    try std.testing.expectEqual(right, m.firstPane(below.first));
    try std.testing.expectEqual(lone, m.firstPane(below.second));
    try std.testing.expectEqual(revisions[0] + 1, m.revision);
    try std.testing.expectEqual(revisions[1] + 1, r.workspaces.get(away).?.model.revision);
}

test "swapping panes exchanges their places, across workspaces too" {
    var r: Runtime = .{};
    defer r.deinit();
    const home = try r.workspaces.add("", "/tmp");
    const away = try r.workspaces.add("", "/tmp");
    const left = try testPane(&r, home, null);
    const right = try testPane(&r, home, left);
    const other = try testPane(&r, away, null);
    const tab = (try location(&r, left)).tab;
    const alloc = std.testing.allocator;
    _ = try execute(&r, test_context, .{ .@"pane.swap" = .{ .target = left, .other = right } }, alloc);
    const m = &r.workspaces.get(home).?.model;
    const root = m.nodes[m.tabs[0].root].?.split;
    try std.testing.expectEqual(right, m.firstPane(root.first));
    try std.testing.expectEqual(left, m.firstPane(root.second));

    const revisions = .{ m.revision, r.workspaces.get(away).?.model.revision };
    const swapped = try execute(&r, test_context, .{ .@"pane.swap" = .{ .target = left, .other = other } }, alloc);
    try std.testing.expectEqualDeep(try location(&r, left), swapped);
    try std.testing.expectEqual(away, swapped.workspace);
    try std.testing.expectEqualDeep(Result{ .pane = other, .tab = tab, .workspace = home }, try location(&r, other));
    try std.testing.expectEqual(other, m.firstPane(root.second));
    try std.testing.expectEqual(revisions[0] + 1, m.revision);
    try std.testing.expectEqual(revisions[1] + 1, r.workspaces.get(away).?.model.revision);
}

test "a viewer's snapshot stays byte-stable while only output and stamps move" {
    var r: Runtime = .{};
    defer r.deinit();
    _ = try r.workspaces.add("stable", "/tmp");
    const actor = try r.conversations.get(.codex, "stable");
    actor.observed_at = 10 * std.time.us_per_s + 1;
    actor.children_observed_at = actor.observed_at;
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const alloc = arena.allocator();
    const before = try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{});
    // A PTY read bumps the revision; a later observation lands in the same
    // bucket; resource readings travel separately.
    r.changed();
    r.resources.current.cores = 8;
    actor.observed_at += std.time.us_per_s;
    actor.children_observed_at = actor.observed_at;
    try std.testing.expectEqualStrings(before, try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{}));
    try std.testing.expect(!std.mem.eql(u8, before, try std.json.Stringify.valueAlloc(alloc, try snapshot(alloc, &r), .{})));
    actor.observed_at += protocol.stamp_bucket;
    try std.testing.expect(!std.mem.eql(u8, before, try std.json.Stringify.valueAlloc(alloc, try viewerSnapshot(alloc, &r), .{})));
}
