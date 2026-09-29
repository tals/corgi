//! Daemon-side copy transactions. Source processes are never signalled.
const std = @import("std");
const os = @import("os.zig");
const pane_label = @import("pane_label.zig");
const a = os.allocator;
const catalog = @import("import_catalog.zig");
const herdr = @import("herdr_adapter.zig");
const Runtime = @import("runtime.zig").Runtime;
const layout = @import("layout.zig");
const import_layout = @import("import_layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const tmux_resume = @import("tmux_resume.zig");
const OnboardingProgress = @import("protocol.zig").OnboardingProgress;
const Plan = @import("protocol.zig").Request.Copy;
pub const Job = struct {
    plan: ?std.json.Parsed(Plan) = null,
    progress: OnboardingProgress = .{},
    index: usize = 0,
    created: [workspace.max_workspaces]WorkspaceId = undefined,
    count: usize = 0,
    operation: u64 = 0,
    pub fn busy(j: *const Job) bool {
        return j.plan != null;
    }
    pub fn deinit(j: *Job) void {
        if (j.plan) |p| p.deinit();
        j.plan = null;
    }
    pub fn start(j: *Job, plan: Plan) !void {
        if (j.busy()) return error.ImportInProgress;
        // The plan lives in the request's memory; the job outlives the request.
        const copied = try std.json.Stringify.valueAlloc(a, plan, .{});
        defer a.free(copied);
        const p = try std.json.parseFromSlice(Plan, a, copied, .{ .allocate = .alloc_always });
        errdefer p.deinit();
        if (p.value.workspaces.len == 0 or p.value.workspaces.len > j.created.len) return error.InvalidImport;
        if (p.value.source == .herdr and p.value.herdr_session == null) return error.InvalidImport;
        var total: usize = 0;
        for (p.value.workspaces) |ws| {
            if (ws.tabs.len > layout.max_tabs) return error.TooManyTabs;
            for (ws.tabs) |tab| {
                if (tab.panes.len == 0 or tab.panes.len > layout.max_panes) return error.InvalidImport;
                if (tab.nodes.len > 0) try import_layout.validate(tab.nodes, tab.panes.len);
                total += tab.panes.len;
            }
        }
        if (total > layout.max_panes) return error.TooManyPanes;
        j.* = .{ .plan = p, .operation = plan.operation, .progress = .{ .phase = .copying, .total = total, .message = "Creating workspaces and shells" } };
    }
    pub fn tick(j: *Job, r: *Runtime, defaults: Runtime.Create) bool {
        const plan = j.plan orelse return false;
        const source = plan.value.workspaces[j.index];
        const id = (if (plan.value.source == .herdr) herdr.copy(r, plan.value.herdr_session.?, &.{source.id}, defaults) else copy(r, source, plan.value.source, defaults)) catch |err| {
            for (j.created[0..j.count]) |created| discard(r, created);
            j.progress.phase = .failed;
            j.progress.message = @errorName(err);
            j.progress.completed = 0;
            j.deinit();
            return true;
        };
        j.created[j.count] = id;
        j.count += 1;
        if (j.progress.workspace == null) j.progress.workspace = id;
        for (source.tabs) |tab| j.progress.completed += tab.panes.len;
        j.index += 1;
        if (j.index == plan.value.workspaces.len) {
            j.progress.phase = .complete;
            j.progress.message = "Copied successfully. Source processes are unchanged.";
            j.deinit();
        }
        return true;
    }
};
fn copy(r: *Runtime, source: catalog.Workspace, kind: catalog.Source, defaults: Runtime.Create) !WorkspaceId {
    const dir = if (kind == .cmux) cmuxDirectory(source.cwd, os.env("HOME") orelse "/") else if (std.fs.path.isAbsolute(source.cwd)) source.cwd else os.env("HOME") orelse "/";
    const wid = try r.workspaces.add(source.name, dir);
    errdefer discard(r, wid);
    for (source.tabs) |tab| {
        if (tab.panes.len > layout.max_panes) return error.TooManyPanes;
        var ids: [layout.max_panes]layout.PaneId = undefined;
        var first: ?layout.PaneId = null;
        for (tab.panes, 0..) |p, i| {
            var opts = defaults;
            opts.workspace = wid;
            opts.cwd = if (kind == .cmux) cmuxDirectory(p.cwd, dir) else if (std.fs.path.isAbsolute(p.cwd)) p.cwd else dir;
            opts.title = tab.name;
            opts.command = null;
            opts.interactive_command = false;
            opts.split = if (first) |id| .{ .pane = id, .axis = .horizontal } else null;
            const id = try r.create(opts);
            if (kind == .tmux) {
                const t = r.pane(id).?.terminal;
                tmux_resume.feed(t, p.history);
                tmux_resume.feed(t, p.screen);
                t.feed("\x1b[0m\r\n# Imported tmux output; new shell.\r\n");
                if (p.restart_command.len > 0) {
                    // Even a hand-written copy request must not submit input.
                    for (p.restart_command) |ch| if (ch < 32 or ch == 127) return error.InvalidImport;
                    t.feed("# Press Return to restart the command below.\r\n");
                    try t.prefill(p.restart_command);
                }
            }
            if (kind == .cmux) r.pane(id).?.label = pane_label.label(p.name);
            ids[i] = id;
            if (first == null) first = id;
            if (p.url.len > 0) {
                const t = r.pane(id).?.terminal;
                t.feed("\r\n# Imported browser link:\r\n# ");
                for (p.url) |ch| if (ch >= 32 and ch != 127) t.feed(&.{ch});
                t.feed("\r\n");
            }
        }
        if (tab.nodes.len > 0 or (kind == .tmux and tab.panes.len > 1)) {
            const ws = try r.getWorkspace(wid);
            const ti = ws.model.tabForPane(first.?).?;
            // Build in a copy, then replace the old subtree in one step.
            var model = ws.model;
            clear(&model, model.tabs[ti].root);
            var indices: [layout.max_panes]usize = undefined;
            for (0..tab.panes.len) |i| indices[i] = i;
            model.tabs[ti].root = if (tab.nodes.len > 0) try import_layout.install(&model, tab.nodes, ids[0..tab.panes.len]) else try geometry(&model, tab.panes, &ids, indices[0..tab.panes.len]);
            ws.model = model;
        }
    }
    r.changed();
    return wid;
}
fn cmuxDirectory(path: []const u8, fallback: []const u8) []const u8 {
    for ([_][]const u8{ path, fallback, os.env("HOME") orelse "/", "/" }) |candidate| {
        if (!std.fs.path.isAbsolute(candidate)) continue;
        var dir = std.fs.openDirAbsolute(candidate, .{}) catch continue;
        dir.close();
        return candidate;
    }
    return "/";
}
fn clear(m: *layout.Model, node: u8) void {
    const old = m.nodes[node] orelse return;
    if (old == .split) {
        clear(m, old.split.first);
        clear(m, old.split.second);
    }
    m.nodes[node] = null;
}
fn geometry(m: *layout.Model, panes: []const catalog.Pane, ids: []const layout.PaneId, indices: []const usize) anyerror!u8 {
    if (indices.len == 1) return m.alloc(.{ .pane = ids[indices[0]] });
    for ([_]layout.Axis{ .horizontal, .vertical }) |axis| {
        var min: u32 = std.math.maxInt(u16);
        var max: u32 = 0;
        for (indices) |i| {
            const p = panes[i];
            const origin: u32 = if (axis == .horizontal) p.x else p.y;
            const size: u32 = if (axis == .horizontal) p.w else p.h;
            min = @min(min, origin);
            max = @max(max, origin + size);
        }
        for (indices) |candidate| {
            const cut: u32 = if (axis == .horizontal) panes[candidate].x else panes[candidate].y;
            if (cut <= min or cut >= max) continue;
            var left: [layout.max_panes]usize = undefined;
            var right: [layout.max_panes]usize = undefined;
            var nl: usize = 0;
            var nr: usize = 0;
            var crosses = false;
            for (indices) |i| {
                const p = panes[i];
                const start: u32 = if (axis == .horizontal) p.x else p.y;
                const end = start + @as(u32, if (axis == .horizontal) p.w else p.h);
                if (end <= cut) {
                    left[nl] = i;
                    nl += 1;
                } else if (start >= cut) {
                    right[nr] = i;
                    nr += 1;
                } else {
                    crosses = true;
                    break;
                }
            }
            if (crosses or nl == 0 or nr == 0) continue;
            const l = try geometry(m, panes, ids, left[0..nl]);
            const rr = try geometry(m, panes, ids, right[0..nr]);
            return m.alloc(.{ .split = .{ .axis = axis, .first = l, .second = rr, .ratio = @intCast(std.math.clamp((cut - min) * 1000 / (max - min), 100, 900)) } });
        }
    }
    return error.UnsupportedSourceLayout;
}

// Rollback owns only newly spawned shells. Do not turn them into undo-close items.
fn discard(r: *Runtime, wid: WorkspaceId) void {
    const index = r.workspaces.index(wid) orelse return;
    const model = r.workspaces.items.items[index].model;
    var i: usize = r.panes.items.len;
    while (i > 0) {
        i -= 1;
        if (model.tabForPane(r.panes.items[i].id) != null) {
            const pane = r.panes.orderedRemove(i);
            r.stopShell(pane.terminal);
            pane.terminal.destroy();
            a.free(pane.cwd);
        }
    }
    const ws = r.workspaces.items.orderedRemove(index);
    a.free(ws.cwd);
    r.changed();
}

test "a copy's plan outlives the request that brought it" {
    // The daemon reuses a request's memory once it has answered.
    var buffer: [16 * 1024]u8 = undefined;
    var request: std.heap.FixedBufferAllocator = .init(&buffer);
    const json =
        \\{"operation":5,"source":"herdr","selected":["w"],
        \\ "workspaces":[{"id":"w","name":"w","tabs":[{"id":"t","name":"t","panes":[{"id":"p","name":"p"}]}]}],
        \\ "herdr_session":{"socket":"/s","name":"n","live_handoff":false,"workspaces":[{"id":"w","name":"w","cwd":"/",
        \\  "tabs":[{"id":"t","name":"t","panes":[{"id":"p","name":"p","cwd":"/"}],"root":{"type":"pane","terminal_id":"p"}}]}]}}
    ;
    const value = try std.json.parseFromSliceLeaky(std.json.Value, request.allocator(), json, .{ .allocate = .alloc_always });
    var job: Job = .{};
    defer job.deinit();
    try job.start(try std.json.parseFromValueLeaky(Plan, request.allocator(), value, .{}));
    @memset(&buffer, 0);
    const root = job.plan.?.value.herdr_session.?.workspaces[0].tabs[0].root;
    const kind = root.object.get("type") orelse return error.TestUnexpectedResult;
    try std.testing.expectEqualStrings("pane", kind.string);
}
