//! Deterministic stdio harness for the actual viewer controller and transport.
//! Only the test build exposes this entry point.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const viewer = @import("viewer.zig");
const agents = @import("agents.zig");
const protocol = @import("protocol.zig");
const Action = @import("action.zig").Action;
const PaneId = @import("layout.zig").PaneId;
const TabId = @import("layout.zig").TabId;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
pub fn run(path: []const u8) !void {
    const fd = try os.connect(path);
    defer _ = os.c.close(fd);
    var conn: @import("rpc.zig").Connection = .{ .fd = fd };
    var view: viewer.View = .{ .connection = &conn, .executable = "" };
    defer viewer.deinit(&view);
    const cwd = try std.process.currentPathAlloc(os.io(), a);
    defer a.free(cwd);
    var bell = try viewer.open(&view, cwd, .{}, path);
    while (true) {
        const line = os.readLine(0, 1024 * 1024) catch |err| {
            if (err == error.EndOfStream) return;
            return err;
        };
        defer a.free(line);
        const parsed = try std.json.parseFromSlice(std.json.Value, a, line, .{});
        defer parsed.deinit();
        const value = parsed.value;
        const op = agents.str(value, "op");
        if (std.mem.eql(u8, op, "input")) try view.input(agents.str(value, "data"));
        // Viewer-local delays (hover cards, command preview debounce).
        if (std.mem.eql(u8, op, "advance")) @import("clock.zig").advance(value.object.get("ms").?.integer);
        if (std.mem.eql(u8, op, "action")) {
            const act = try Action.parse(agents.str(value, "name"), agents.str(value, "value"));
            // viewer.sync execs the new binary before perform; the driver cannot.
            if (act == .relaunch) return error.UnknownAction;
            try view.perform(act);
        }
        if (std.mem.eql(u8, op, "focus")) try view.focusPane(try protocol.typedId(PaneId, value, "pane"));
        if (std.mem.eql(u8, op, "workspace")) try view.switchWorkspace(try protocol.typedId(WorkspaceId, value, "workspace"));
        // The stdio driver has no host terminal to negotiate image support.
        if (std.mem.eql(u8, op, "badge")) {
            view.corgi_badge = if (!value.object.get("visible").?.bool) .none else if (value.object.get("emoji")) |e| (if (e.bool) .emoji else .image) else .image;
            view.supports_kitty_graphics = view.corgi_badge == .image;
        }
        if (std.mem.eql(u8, op, "size")) {
            view.width = @intCast(value.object.get("cols").?.integer);
            view.height = @intCast(value.object.get("rows").?.integer);
            view.input_state.active = true;
        }
        try view.expireInput();
        const previous_bell = bell;
        var active = try viewer.sync(&view, &bell, false);
        // A layout change from another viewer can change the visible set. A
        // second exchange captures the newly reconciled selection immediately.
        if (active) active = try viewer.sync(&view, &bell, false);
        const frame = try view.frame();
        try viewer.presented(&view);
        defer a.free(frame);
        const model = &view.current().model;
        try os.sendJson(1, .{ .bell_seq = bell, .bell_kind = @tagName(view.last_bell_kind), .rang = bell != previous_bell, .data = frame, .workspace = view.current().id, .tab = if (model.count > 0) model.tabs[view.layoutView().selection.active].id else TabId.none, .pane = if (view.focused()) |p| p.id else PaneId.none, .prefix = view.prefix, .dialog = view.name_dialog != null, .detached = !active, .effects = view.effects.items });
        view.clearEffects();
        if (!active) return;
    }
}
