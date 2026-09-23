//! Deterministic stdio harness for the actual viewer controller and transport.
//! Only the test build exposes this entry point.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const viewer = @import("viewer.zig");
const agents = @import("agents.zig");
pub fn run(path: []const u8) !void {
    const fd = try os.connect(path);
    defer _ = os.c.close(fd);
    var conn: @import("rpc.zig").Connection = .{ .fd = fd };
    var view: viewer.View = .{ .connection = &conn, .executable = "" };
    defer viewer.deinit(&view);
    const cwd = try std.process.getCwdAlloc(a);
    defer a.free(cwd);
    var bell = try viewer.open(&view, cwd, .{});
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
        if (std.mem.eql(u8, op, "action")) try view.action(agents.str(value, "name"), agents.str(value, "value"));
        if (std.mem.eql(u8, op, "focus")) try view.focusPane(try @import("protocol.zig").id(value, "pane"));
        if (std.mem.eql(u8, op, "workspace")) try view.switchWorkspace(try @import("protocol.zig").id(value, "workspace"));
        if (std.mem.eql(u8, op, "size")) {
            view.width = @intCast(value.object.get("cols").?.integer);
            view.height = @intCast(value.object.get("rows").?.integer);
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
        try os.sendJson(1, .{ .bell_seq = bell, .bell_kind = @tagName(view.last_bell_kind), .rang = bell != previous_bell, .data = frame, .workspace = view.current().id, .tab = if (model.count > 0) model.tabs[view.layoutView().selection.active].id else 0, .pane = if (view.focused()) |p| p.id else 0, .prefix = view.prefix, .dialog = view.name_dialog != null, .detached = !active, .effects = view.effects.items });
        view.clearEffects();
        if (!active) return;
    }
}
