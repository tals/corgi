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
const peer = @import("peer.zig");
const Connection = @import("rpc.zig").Connection;
pub const View = controller.Controller;
const Response = struct {
    viewer: u32,
    controls: []const peer.Control,
    session: std.json.Value,
    surfaces: []const surface.View,
    bell_seq: u64,
    bell_kind: agents.Attention,
    detach: bool,
};

pub fn open(view: *View, cwd: []const u8, theme: @import("theme.zig").Theme) !u64 {
    view.remote_links = @import("ports.zig").sshViewer();
    view.loadPreferences();
    const opened = try view.connection.call(.{ .op = "viewer.open", .protocol = 1, .cwd = cwd, .theme = theme });
    defer opened.deinit();
    view.navigation.workspace_id = try protocol.id(opened.value, "workspace");
    view.input_state.attached = true;
    try view.refresh();
    // Warm the New menu cache; provider checks run on the daemon's worker.
    const preview_cwd = view.inheritedCwd(view.current(), if (view.focused()) |p| p.id else null);
    if (view.connection.call(.{ .op = "agent.preview", .protocol = 1, .workspace = view.current().id, .cwd = preview_cwd })) |preview| {
        preview.deinit();
    } else |_| {}
    return @intCast(opened.value.object.get("bell_seq").?.integer);
}
pub fn deinit(view: *View) void {
    if (view.executable.len > 0) a.free(view.executable);
    view.dismissName();
    view.input_state.deinit();
    view.clearEffects();
    view.effects.deinit(a);
    view.runtime.deinit();
}
pub fn sync(view: *View, bell_seq: *u64, play_sound: bool) !bool {
    for (view.runtime.panes.items) |p| {
        if (p.terminal.holding_selection and (view.selection == null or view.selection.?.pane != p.id))
            try p.terminal.clearSelection();
        try p.terminal.flush();
    }
    var places: [layout.max_panes]layout.Placement = undefined;
    var interests: [layout.max_panes]peer.Interest = undefined;
    var count: usize = 0;
    for (view.layoutView().placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        interests[count] = .{ .pane = place.id, .cols = @max(1, place.rect.w), .rows = @max(1, place.rect.h), .offset = p.terminal.offset };
        count += 1;
    }
    const response = try view.connection.call(.{ .op = "viewer.sync", .protocol = 1, .interests = interests[0..count], .focus = if (view.focused()) |p| @as(?u32, p.id) else null, .watched = view.input_state.watched, .workspace = view.current().id, .ack = view.input_state.last_control });
    defer response.deinit();
    const parsed = try std.json.parseFromValue(Response, a, response.value, .{ .ignore_unknown_fields = true });
    defer parsed.deinit();
    const reply = parsed.value;
    try view.receiveSnapshot(reply.session);
    view.input_state.viewer_id = reply.viewer;
    for (reply.controls) |control| {
        if (control.seq <= view.input_state.last_control) continue;
        if (control.kind == .action and std.mem.eql(u8, control.name, "relaunch")) {
            view.executable = try a.dupe(u8, control.value);
            return false;
        }
        switch (control.kind) {
            .focus => view.focusPane(control.id) catch |err| view.notice(@errorName(err)),
            .workspace => view.switchWorkspace(control.id) catch |err| view.notice(@errorName(err)),
            .action => view.action(control.name, control.value) catch |err| view.notice(@errorName(err)),
        }
        view.input_state.last_control = control.seq;
    }
    for (reply.surfaces) |frame| if (view.runtime.pane(frame.surface.pane)) |p| try p.terminal.receive(frame);
    if (reply.bell_seq != bell_seq.*) {
        bell_seq.* = reply.bell_seq;
        view.last_bell_kind = reply.bell_kind;
        if (play_sound and !view.muted) try @import("sound.zig").play(@tagName(reply.bell_kind));
    }
    return !reply.detach and view.input_state.attached;
}

// Called only after the frame has been written. Receipts refer to the
// snapshot displayed, never whatever completion happens to be latest remotely.
pub fn presented(view: *View) !void {
    if (!view.input_state.watched) return;
    var places: [layout.max_panes]layout.Placement = undefined;
    for (view.layoutView().placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        const focused = if (view.focused()) |selected| selected.id == p.id else false;
        if (!p.agent.observation.unread() and (p.agent.attention == .none or !focused)) continue;
        try view.connection.send(.{ .op = "pane.acknowledge", .protocol = 1, .pane = p.id, .binding = p.binding, .conversation = p.agent.conversation, .session = p.agent.session, .through = p.agent.observation.completed, .attention_at = if (focused) p.agent.changed_at else @as(i64, -1) });
        p.agent.observation.acknowledge(p.agent.observation.completed);
        if (focused or p.agent.attention != .needs_input) p.agent.attention = .none;
    }
}

pub fn run(fd: c_int, probe: *@import("theme.zig").Probe, input: *std.ArrayList(u8)) !?[]const u8 {
    var connection: Connection = .{ .fd = fd };
    var view: View = .{ .connection = &connection, .executable = "" };
    defer deinit(&view);
    const cwd = try std.process.getCwdAlloc(a);
    defer a.free(cwd);
    var bell_seq = try open(&view, cwd, probe.theme);
    var openers: @import("url_opener.zig").Openers = .{};
    defer openers.reap();
    var previous: []const u8 = "";
    defer if (previous.len > 0) a.free(previous);
    const badge = @import("corgi_badge.zig");
    probe.badge = .{};
    try os.writeAll(1, badge.query);
    defer if (probe.badge.uploaded) {
        os.writeAll(1, badge.remove) catch {};
    };
    var next_sync: i64 = 0;
    while (view.input_state.attached) {
        openers.reap();
        try probe.expire(input);
        var image_output: std.Io.Writer.Allocating = .init(a);
        defer image_output.deinit();
        try probe.badge.upload(&image_output.writer, std.time.milliTimestamp());
        if (image_output.written().len > 0) try os.writeAll(1, image_output.written());
        const badge_mode = probe.badge.mode();
        if (view.corgi_badge != badge_mode) {
            view.corgi_badge = badge_mode;
            view.dirty = true;
        }
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
            view.input(input.items[0..input_end]) catch |err| view.notice(@errorName(err));
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
        for (view.effects.items) |effect| switch (effect) {
            .open_url => |url| if (!view.remote_links) {
                openers.open(url) catch |err| view.notice(@errorName(err));
            },
            .write_terminal => |data| try os.writeAll(1, data),
        };
        view.clearEffects();
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
