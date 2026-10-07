//! Each invocation owns its UI, local selections, and input parser. The daemon
//! sends shared session organization and terminal surfaces, never Corgi frames.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const protocol = @import("protocol.zig");
const controller = @import("controller.zig");
const Action = @import("action.zig").Action;
const Connection = @import("rpc.zig").Connection;
const Theme = @import("theme.zig").Theme;
const Probe = @import("host_probe.zig").Probe;
const ports = @import("trackers.zig").ports;
const sound = @import("sound.zig");
const url_opener = @import("url_opener.zig");
const corgi_badge = @import("corgi_badge.zig");
const host_clipboard = @import("host_clipboard.zig");
const fork_motion = @import("fork_motion.zig");
pub const View = controller.Controller;

pub fn open(view: *View, cwd: []const u8, theme: Theme, socket: []const u8) !u64 {
    return openMode(view, cwd, theme, socket, false);
}
fn openMode(view: *View, cwd: []const u8, theme: Theme, socket: []const u8, start_onboarding: bool) !u64 {
    view.remote_links = ports.sshViewer();
    // OSC 22 uses X11 names in iTerm2, CSS names in Ghostty/Kitty. Read the
    // attaching viewer's environment: one daemon can serve both terminals.
    view.iterm2_pointer = std.mem.eql(u8, os.env("TERM_PROGRAM") orelse "", "iTerm.app");
    view.branch_glyphs = branchGlyphs(os.env("TERM") orelse "") or branchGlyphs(os.env("TERM_PROGRAM") orelse "");
    view.loadPreferences();
    if (start_onboarding) view.openOnboarding(.welcome);
    const opened = view.connection.call(.@"viewer.open", .{
        .cwd = cwd,
        .theme = .{ .value = theme },
        .onboarding = view.onboarding != null,
    }) catch |err| return incompatible(err);
    defer opened.deinit();
    view.navigation.workspace_id = opened.value.workspace;
    view.input_state.attached = true;
    try view.refresh();
    view.launch_previews.socket = socket;
    view.updateLaunchPreview();
    return opened.value.bell_seq;
}
/// A daemon on another protocol is one error, which `main` explains.
fn incompatible(err: anytype) (@TypeOf(err) || error{IncompatibleViewerProtocol}) {
    return switch (err) {
        error.UnsupportedViewerProtocol, error.UnsupportedProtocol, error.ProtocolRequired => error.IncompatibleViewerProtocol,
        else => err,
    };
}
pub fn deinit(view: *View) void {
    view.launch_previews.deinit();
    if (view.resume_arena) |*arena| arena.deinit();
    if (view.onboarding) |*wizard| wizard.deinit();
    if (view.clipboard) |bytes| a.free(bytes);
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
    var interests: [layout.max_panes]protocol.Interest = undefined;
    var count: usize = 0;
    for (view.layoutView().placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        interests[count] = .{ .pane = place.id, .cols = @max(1, place.rect.w), .rows = @max(1, place.rect.h), .offset = p.terminal.offset, .known = p.terminal.known };
        count += 1;
    }
    const response = view.connection.call(.@"viewer.sync", .{
        .interests = interests[0..count],
        .session_hash = view.runtime.snapshot_hash,
        .focus = if (view.focused()) |p| p.id else null,
        .watched = view.input_state.watched,
        .workspace = view.current().id,
        .ack = view.input_state.last_control,
        .active = view.input_state.active,
        .resource_detail = view.resourceDetail(),
        .resources = view.prefs.resources.enabled,
        .resources_hash = view.runtime.resources_hash,
    }) catch |err| return incompatible(err);
    view.input_state.active = false;
    defer response.deinit();
    const reply = response.value;
    if (reply.session) |session| try view.receiveSnapshot(session);
    view.runtime.snapshot_hash = reply.session_hash;
    if (reply.resources) |readings| try view.runtime.receiveResources(readings);
    view.runtime.resources_hash = reply.resources_hash;
    view.input_state.viewer_id = reply.viewer;
    for (reply.controls) |control| {
        if (control.seq <= view.input_state.last_control) continue;
        switch (control.kind) {
            .focus => view.focusPane(@enumFromInt(control.id)) catch |err| view.notice(@errorName(err)),
            .workspace => view.switchWorkspace(@enumFromInt(control.id)) catch |err| view.notice(@errorName(err)),
            .action => if (Action.parse(control.name, control.value)) |act| switch (act) {
                .relaunch => |path| {
                    view.executable = try a.dupe(u8, path);
                    return false;
                },
                else => view.perform(act) catch |err| view.notice(@errorName(err)),
            } else |err| view.notice(@errorName(err)),
        }
        view.input_state.last_control = control.seq;
    }
    for (reply.surfaces) |frame| if (view.runtime.pane(frame.surface.pane)) |p| try p.terminal.receive(frame);
    if (reply.bell_seq != bell_seq.*) {
        bell_seq.* = reply.bell_seq;
        view.last_bell_kind = reply.bell_kind;
        if (play_sound and !view.muted) try sound.play(@tagName(reply.bell_kind));
    }
    const choosing = view.onboarding != null or (if (view.agent_launcher) |launcher| launcher.pinned else false);
    return (!reply.detach or choosing) and view.input_state.attached;
}

// Called only after the frame has been written. Receipts refer to the
// snapshot displayed, never whatever completion happens to be latest remotely.
pub fn presented(view: *View) !void {
    if (!view.input_state.watched or view.coversPanes()) return;
    var places: [layout.max_panes]layout.Placement = undefined;
    for (view.layoutView().placements(view.area(), &places)) |place| {
        const p = view.runtime.pane(place.id) orelse continue;
        const focused = if (view.focused()) |selected| selected.id == p.id else false;
        if (!p.agent.observation.unread() and (p.agent.attention == .none or !focused)) continue;
        try view.connection.send(.@"pane.acknowledge", .{
            .pane = p.id,
            .binding = p.binding,
            .conversation = p.agent.conversation,
            .session = p.agent.session,
            .through = p.agent.observation.completed,
            .attention_at = if (focused) p.agent.changed_at else @as(i64, -1),
        });
        p.agent.observation.acknowledge(p.agent.observation.completed);
        if (focused or p.agent.attention != .needs_input) p.agent.attention = .none;
    }
}

pub fn run(fd: c_int, socket: []const u8, probe: *Probe, input: *std.ArrayList(u8), start_onboarding: bool) !?[]const u8 {
    var connection: Connection = .{ .fd = fd };
    var view: View = .{ .connection = &connection, .executable = "" };
    defer deinit(&view);
    const cwd = try std.process.currentPathAlloc(os.io(), a);
    defer a.free(cwd);
    var bell_seq = try openMode(&view, cwd, probe.theme, socket, start_onboarding);
    // Pasted images are saved beside the socket, on the daemon's machine.
    const paste_folder = try std.fs.path.join(a, &.{ std.fs.path.dirname(socket) orelse ".", "paste" });
    defer a.free(paste_folder);
    probe.clipboard.folder = paste_folder;
    view.host_clipboard = &probe.clipboard;
    if (view.remote_links) try probe.clipboard.start(os.milliTimestamp());
    var openers: url_opener.Openers = .{};
    defer openers.reap();
    var previous: []const u8 = "";
    defer if (previous.len > 0) a.free(previous);
    probe.badge = .{};
    try os.writeAll(1, corgi_badge.query);
    defer if (probe.badge.uploaded) {
        os.writeAll(1, corgi_badge.remove) catch {};
    };
    defer if (view.name_dialog) |d| if (d.hero.motion != null) {
        os.writeAll(1, fork_motion.remove) catch {};
    };
    // Opened once the first sync names this viewer.
    var waker: ?c_int = null;
    var watch_opened = false;
    defer if (waker) |wake_fd| {
        _ = c.close(wake_fd);
    };
    var woken = true;
    var synced: i64 = 0;
    var next_sync: i64 = 0;
    var typed = false;
    while (view.input_state.attached) {
        openers.reap();
        try probe.expire(input);
        try answerClipboard(&view, &probe.clipboard);
        var image_output: std.Io.Writer.Allocating = .init(a);
        defer image_output.deinit();
        try probe.badge.upload(&image_output.writer, os.milliTimestamp());
        if (image_output.written().len > 0) try os.writeAll(1, image_output.written());
        const badge_mode = probe.badge.mode();
        if (view.corgi_badge != badge_mode or view.supports_kitty_graphics != probe.badge.supports_kitty_graphics) {
            view.corgi_badge = badge_mode;
            view.supports_kitty_graphics = probe.badge.supports_kitty_graphics;
            view.dirty = true;
        }
        if (probe.changed) {
            try connection.send(.theme, .{ .theme = .{ .value = probe.theme } });
            probe.changed = false;
        }
        const size = dimensions();
        view.cell_pixels = size.cell;
        // Over SSH, TERM may not name the terminal; XTVERSION does.
        if (branchGlyphs(probe.clipboard.terminal.text())) view.branch_glyphs = true;
        if (view.width != size.cols or view.height != size.rows) {
            view.width = size.cols;
            view.height = size.rows;
            view.input_state.active = true;
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
        const now = os.milliTimestamp();
        if (view.dirty or now >= next_sync) {
            // Frames keep their clock for animations; the daemon is asked
            // only when it said something changed, or often enough that it
            // still counts this viewer as watching.
            if (waker == null or view.dirty or woken or now - synced >= quiet_sync_ms) {
                if (!try sync(&view, &bell_seq, true)) return if (view.executable.len > 0) try a.dupe(u8, view.executable) else null;
                woken = false;
                synced = now;
                if (!watch_opened) {
                    waker = watch(socket, view.input_state.viewer_id);
                    watch_opened = true;
                }
            }
            next_sync = os.milliTimestamp() + view.frameDelay();
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
        var polls = [2]c.struct_pollfd{
            .{ .fd = 0, .events = c.POLLIN, .revents = 0 },
            .{ .fd = waker orelse -1, .events = c.POLLIN, .revents = 0 },
        };
        _ = c.poll(&polls, polls.len, 16);
        const poll = polls[0];
        // Input reaches the daemon with a frame's sync, so send it now, and
        // show the first change after it (its echo) without waiting a frame.
        if (polls[0].revents != 0) {
            typed = true;
            next_sync = 0;
        }
        if (polls[1].revents != 0) {
            woken = true;
            if (typed) next_sync = 0;
            typed = false;
            var bytes: [4096]u8 = undefined;
            // A daemon gone or replaced by a reload stops waking; sync on
            // every frame again until this viewer reconnects.
            if (c.read(waker.?, &bytes, bytes.len) <= 0) {
                _ = c.close(waker.?);
                waker = null;
            }
        }
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
/// Hands the host clipboard's paste and what a read brought to the view,
/// and writes the requests both make.
fn answerClipboard(view: *View, clipboard: *host_clipboard.State) !void {
    clipboard.tick(os.milliTimestamp());
    if (clipboard.takeEvent()) |listing| view.pasteEvent(listing) catch |err| view.notice(@errorName(err));
    if (clipboard.takeResult()) |result| {
        defer result.deinit();
        view.pasteResult(result) catch |err| view.notice(@errorName(err));
    }
    if (clipboard.out.items.len > 0) {
        try os.writeAll(1, clipboard.out.items);
        clipboard.out.clearRetainingCapacity();
    }
}
/// How often a viewer syncs while the daemon reports nothing new. Under a
/// second, so the daemon keeps counting the viewer as watching.
const quiet_sync_ms = 500;
/// The daemon's wake connection, or null when it cannot watch (an older
/// daemon), in which case the viewer syncs on every frame.
fn watch(socket: []const u8, viewer: u32) ?c_int {
    const fd = os.connect(socket) catch return null;
    var connection: Connection = .{ .fd = fd };
    connection.send(.@"viewer.watch", .{ .viewer = viewer }) catch {
        _ = c.close(fd);
        return null;
    };
    os.nonblock(fd);
    return fd;
}
fn dimensions() struct { cols: u16, rows: u16, cell: ?fork_motion.Cell } {
    var size = std.mem.zeroes(c.struct_winsize);
    _ = c.ioctl(0, c.TIOCGWINSZ, &size);
    // Terminals that report pixels pad under a cell, so this is the cell.
    const cell: ?fork_motion.Cell = if (size.ws_col == 0 or size.ws_row == 0 or size.ws_xpixel < size.ws_col or size.ws_ypixel < size.ws_row)
        null
    else
        .{ .width = size.ws_xpixel / size.ws_col, .height = size.ws_ypixel / size.ws_row };
    return .{ .cols = if (size.ws_col == 0) 100 else std.math.clamp(size.ws_col, 10, 500), .rows = if (size.ws_row == 0) 30 else std.math.clamp(size.ws_row, 4, 200), .cell = cell };
}
/// Whether a terminal by this name draws Kitty's branch drawing characters:
/// Ghostty and Kitty do.
fn branchGlyphs(name: []const u8) bool {
    return std.ascii.indexOfIgnoreCase(name, "ghostty") != null or std.ascii.indexOfIgnoreCase(name, "kitty") != null;
}
