//! Each invocation owns its UI, local selections, and input parser. The daemon
//! sends shared session organization and terminal surfaces, never Corgi frames.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const agents = @import("agents.zig");
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const surface = @import("surface.zig");
const controller = @import("controller.zig");
const Connection = @import("rpc.zig").Connection;
pub const View = controller.Controller(true);
const Response = struct {
    viewer: u32,
    controls: []const controller.Control,
    session: protocol.Snapshot,
    surfaces: []const surface.View,
    bell_seq: u64,
    bell_kind: agents.Attention,
    detach: bool,
};

pub fn open(view: *View, cwd: []const u8, theme: @import("theme.zig").Theme) !u64 {
    view.remote_links = @import("ports.zig").sshViewer();
    const hello = try view.connection.call(.{ .op = "hello", .protocol = 1 });
    defer hello.deinit();
    const capabilities = hello.value.object.get("capabilities") orelse return error.ViewerProtocolUnavailable;
    if (capabilities != .array) return error.ViewerProtocolUnavailable;
    const supported = for (capabilities.array.items) |cap| {
        if (cap == .string and std.mem.eql(u8, cap.string, "viewer.sync")) break true;
    } else false;
    if (!supported) return error.ViewerProtocolUnavailable;
    const opened = try view.connection.call(.{ .op = "viewer.open", .protocol = 1, .can_relaunch = true, .cwd = cwd, .theme = theme });
    defer opened.deinit();
    try view.clients.append(a, .{ .fd = -1, .attached = true });
    try view.refresh();
    return @intCast(opened.value.object.get("bell_seq").?.integer);
}
pub fn deinit(view: *View) void {
    if (view.executable.len > 0) a.free(view.executable);
    view.dismissName();
    for (view.clients.items) |*cl| {
        @import("viewer_protocol.zig").clearControls(cl);
        cl.controls.deinit(a);
        cl.input.deinit(a);
        cl.output.deinit(a);
        cl.keybuf.deinit(a);
    }
    view.clients.deinit(a);
    view.runtime.deinit();
}
pub fn sync(view: *View, bell_seq: *u64, play_sound: bool) !bool {
    view.flushLayout() catch |err| {
        if (err != error.StaleLayout) return err;
        view.notice(" Layout changed in another viewer; repeat the edit");
    };
    for (view.runtime.panes.items) |p| {
        if (p.terminal.holding_selection and (view.selection == null or view.selection.?.pane != p.id))
            try p.terminal.clearSelection();
        try p.terminal.flush();
    }
    var places: [layout.max_panes]layout.Placement = undefined;
    var interests: [layout.max_panes]controller.Interest = undefined;
    var count: usize = 0;
    const model = &view.runtime.workspaces.current().model;
    for (model.placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        interests[count] = .{ .pane = place.id, .cols = @max(1, place.rect.w), .rows = @max(1, place.rect.h), .offset = p.terminal.offset };
        count += 1;
    }
    const response = try view.connection.call(.{ .op = "viewer.sync", .protocol = 1, .interests = interests[0..count], .focus = if (view.focused()) |p| @as(?u32, p.id) else null, .watched = view.clients.items[0].watched, .workspace = view.runtime.workspaces.current().id, .ack = view.clients.items[0].last_control });
    defer response.deinit();
    const parsed = try std.json.parseFromValue(Response, a, response.value, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const reply = parsed.value;
    try view.receiveSnapshot(reply.session);
    view.clients.items[0].viewer_id = reply.viewer;
    for (reply.controls) |control| {
        if (control.seq <= view.clients.items[0].last_control) continue;
        if (control.kind == .action and std.mem.eql(u8, control.name, "relaunch")) {
            view.executable = try a.dupe(u8, control.value);
            return false;
        }
        switch (control.kind) {
            .focus => view.focusPane(control.id) catch |err| view.notice(@errorName(err)),
            .workspace => view.switchWorkspace(control.id) catch |err| view.notice(@errorName(err)),
            .action => view.action(control.name, control.value) catch |err| view.notice(@errorName(err)),
        }
        view.clients.items[0].last_control = control.seq;
    }
    for (reply.surfaces) |frame| if (view.runtime.pane(frame.surface.pane)) |p| try p.terminal.receive(frame);
    if (reply.bell_seq != bell_seq.*) {
        bell_seq.* = reply.bell_seq;
        if (play_sound and !view.muted) try @import("sound.zig").play(@tagName(reply.bell_kind));
    }
    return !reply.detach and view.clients.items[0].attached;
}

// Called only after the frame has been written. Receipts refer to the
// snapshot displayed, never whatever completion happens to be latest remotely.
pub fn presented(view: *View) !void {
    if (!view.clients.items[0].watched) return;
    var places: [layout.max_panes]layout.Placement = undefined;
    for (view.runtime.workspaces.current().model.placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        const focused = if (view.focused()) |selected| selected.id == p.id else false;
        if (!p.agent.observation.unread() and (p.agent.attention == .none or !focused)) continue;
        try view.connection.send(.{ .op = "pane.acknowledge", .protocol = 1, .pane = p.id, .session = p.agent.sessionId(), .through = p.agent.observation.completed, .attention_at = if (focused) p.agent.changed_at else @as(i64, -1) });
        if (focused) p.agent.acknowledge() else p.agent.readThrough(p.agent.observation.completed);
    }
}

pub fn run(fd: c_int, path: []const u8, probe: *@import("theme.zig").Probe, input: *std.ArrayList(u8)) !?[]const u8 {
    var connection: Connection = .{ .fd = fd };
    var view: View = .{ .connection = &connection, .socket = path, .executable = "" };
    defer deinit(&view);
    const cwd = try std.process.getCwdAlloc(a);
    defer a.free(cwd);
    var bell_seq = try open(&view, cwd, probe.theme);
    var openers: @import("url_opener.zig").Openers = .{};
    defer openers.reap();
    var previous: []const u8 = "";
    defer if (previous.len > 0) a.free(previous);
    var next_sync: i64 = 0;
    while (view.clients.items[0].attached) {
        openers.reap();
        try probe.expire(input);
        if (probe.changed) {
            try connection.send(.{ .op = "theme", .theme = probe.theme });
            probe.changed = false;
        }
        const size = dimensions();
        if (view.width != size.cols or view.height != size.rows) {
            view.width = size.cols;
            view.height = size.rows;
            view.dirty = true;
        }
        var input_end = input.items.len;
        while (input_end > 0 and !std.unicode.utf8ValidateSlice(input.items[0..input_end])) : (input_end -= 1) {}
        if (input_end > 0) {
            view.input(&view.clients.items[0], input.items[0..input_end]) catch |err| view.notice(@errorName(err));
            std.mem.copyForwards(u8, input.items[0 .. input.items.len - input_end], input.items[input_end..]);
            input.items.len -= input_end;
        }
        if (input.items.len > 4) input.clearRetainingCapacity();
        try view.expireInput();
        const now = std.time.milliTimestamp();
        if (view.dirty or now >= next_sync) {
            if (!try sync(&view, &bell_seq, true)) return if (view.executable.len > 0) try a.dupe(u8, view.executable) else null;
            next_sync = std.time.milliTimestamp() + 30;
            const frame = try view.frame();
            if (!std.mem.eql(u8, previous, frame)) try os.writeAll(1, frame);
            if (previous.len > 0) a.free(previous);
            previous = frame;
            try presented(&view);
            view.dirty = false;
        }
        // Clipboard and detach effects from the shared controller are local.
        const cl = &view.clients.items[0];
        var lines = std.mem.splitScalar(u8, cl.output.items, '\n');
        while (lines.next()) |line| {
            if (line.len == 0) continue;
            const event = try std.json.parseFromSlice(std.json.Value, a, line, .{});
            defer event.deinit();
            if (std.mem.eql(u8, agents.str(event.value, "type"), "open_url") and !view.remote_links) {
                openers.open(agents.str(event.value, "url")) catch |err| view.notice(@errorName(err));
            }
            if (std.mem.eql(u8, agents.str(event.value, "type"), "detach")) return null;
            if (std.mem.eql(u8, agents.str(event.value, "type"), "frame")) try os.writeAll(1, agents.str(event.value, "data"));
        }
        cl.output.clearRetainingCapacity();
        var poll = c.struct_pollfd{ .fd = 0, .events = c.POLLIN, .revents = 0 };
        _ = c.poll(&poll, 1, 16);
        if (poll.revents & (c.POLLHUP | c.POLLERR) != 0) return null;
        if (poll.revents & c.POLLIN != 0) {
            var bytes: [8192]u8 = undefined;
            const n = c.read(0, &bytes, bytes.len);
            if (n <= 0) return null;
            try probe.feed(bytes[0..@intCast(n)], input);
        }
    }
    return null;
}
fn dimensions() struct { cols: u16, rows: u16 } {
    var size = std.mem.zeroes(c.struct_winsize);
    _ = c.ioctl(0, c.TIOCGWINSZ, &size);
    return .{ .cols = if (size.ws_col == 0) 100 else std.math.clamp(size.ws_col, 10, 500), .rows = if (size.ws_row == 0) 30 else std.math.clamp(size.ws_row, 4, 200) };
}
