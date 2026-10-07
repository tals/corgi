//! A viewer's private projection of shared session organization and pane surfaces.
//! These terminals are framebuffers: no child process or PTY is created here.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const terminal = @import("pane.zig").terminal;
const vt = terminal.vt;
const protocol = @import("protocol.zig");
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const WorkspaceId = workspace.Workspace.Id;
const Connection = @import("rpc.zig").Connection;
const surface = @import("pane.zig").surface;
const hyperlink = @import("pane.zig").hyperlinks;
const inference_setup = @import("inference.zig").setup;
const live_usage = @import("usage.zig").live;
const ports = @import("trackers.zig").ports;
const resources = @import("trackers.zig").resources;
const providers = @import("providers.zig");
const launch_command = @import("launch.zig").command;

pub const Terminal = struct {
    const Selection = struct { x: u16, y: u16, end_x: u16, end_y: u16 };
    inner: *terminal.Terminal,
    conn: *Connection,
    id: layout.PaneId,
    offset: ?usize = null,
    bottom: usize = 0,
    selection: ?Selection = null,
    holding_selection: bool = false,
    known: ?surface.Stamp = null,
    render_dirty: bool = true,
    pending: std.ArrayList(u8) = .empty,
    pub fn emulator(t: *Terminal) *vt.Terminal {
        return &t.inner.vt;
    }
    pub fn hyperlinks(t: *Terminal) []const hyperlink.Link {
        return t.inner.hyperlinks();
    }
    pub fn renderState(t: *Terminal) *vt.RenderState {
        return &t.inner.render;
    }
    pub fn updateRender(t: *Terminal) !void {
        if (!t.render_dirty) return;
        try t.inner.updateRender();
        t.render_dirty = false;
    }
    pub fn destroy(t: *Terminal) void {
        t.inner.destroy();
        t.pending.deinit(a);
        a.destroy(t);
    }
    pub fn atBottom(t: *Terminal) bool {
        return t.offset == null;
    }
    pub fn clearSelection(t: *Terminal) !void {
        t.selection = null;
        t.holding_selection = false;
        try t.inner.clearSelection();
        t.render_dirty = true;
    }
    pub fn scrollViewport(t: *Terminal, scroll: vt.Terminal.ScrollViewport) void {
        t.offset = switch (scroll) {
            .bottom => null,
            .top => 0,
            .row => |row| @min(row, t.bottom),
            .delta => |delta| @intCast(std.math.clamp(@as(i64, @intCast(t.offset orelse t.bottom)) + delta, 0, @as(i64, @intCast(t.bottom)))),
        };
        if (t.offset == t.bottom) t.offset = null;
        t.clearSelection() catch {};
    }
    pub fn select(t: *Terminal, x: u16, y: u16, end_x: u16, end_y: u16) !void {
        t.selection = .{ .x = x, .y = y, .end_x = end_x, .end_y = end_y };
        try t.inner.select(x, y, end_x, end_y);
        t.render_dirty = true;
    }
    pub fn selectedText(t: *Terminal) ![]const u8 {
        return t.inner.selectedText();
    }
    pub fn search(t: *Terminal, needle: []const u8, skip: usize) !bool {
        const response = try t.conn.call(.@"viewer.search", .{ .pane = t.id, .needle = needle, .skip = skip });
        defer response.deinit();
        t.offset = response.value.offset orelse return false;
        // A match on the current viewport still needs its selection applied.
        t.known = null;
        if (response.value.match) |m| t.selection = .{ .x = m.x, .y = m.y, .end_x = m.end_x, .end_y = m.end_y };
        return true;
    }
    pub fn send(t: *Terminal, bytes: []const u8) !void {
        if (t.pending.items.len + bytes.len > 1024 * 1024) return error.InputBackpressure;
        try t.pending.appendSlice(a, bytes);
    }
    pub fn flush(t: *Terminal) !void {
        if (t.pending.items.len == 0) return;
        const command: protocol.Command = .{ .@"pane.input" = .{ .target = t.id, .data = t.pending.items } };
        if (t.conn.call(.@"session.command", .{ .command = command })) |response| {
            response.deinit();
        } else |err| if (err != error.NoPane) return err;
        t.pending.clearRetainingCapacity();
    }
    pub fn receive(t: *Terminal, view: surface.View) !void {
        // Keep the displayed text stable for the entire mouse gesture. The
        // runtime continues collecting output; release resumes the live surface.
        if (t.holding_selection) return;
        const frame = view.surface;
        if (frame.cols == 0 or frame.rows == 0) return;
        t.render_dirty = true;
        try t.inner.resize(frame.cols, frame.rows);
        t.inner.feed("\x1b[?7l\x1b[0m\x1b[H\x1b[2J");
        var bytes: std.Io.Writer.Allocating = .init(a);
        defer bytes.deinit();
        for (frame.lines, 0..) |line, row| {
            try bytes.writer.print("\x1b[{d};1H{s}", .{ row + 1, line });
        }
        if (frame.cursor) |cursor| try bytes.writer.print("\x1b[{d};{d}H\x1b[?25h", .{ cursor.y + 1, cursor.x + 1 }) else try bytes.writer.writeAll("\x1b[?25l");
        t.inner.feed(bytes.written());
        const modes = view.modes;
        const screen_ = &t.inner.vt;
        screen_.modes.set(.bracketed_paste, modes.bracketed_paste);
        screen_.modes.set(.kitty_paste_events, modes.paste_events);
        screen_.modes.set(.cursor_keys, modes.cursor_keys);
        screen_.modes.set(.keypad_keys, modes.keypad_keys);
        screen_.modes.set(.backarrow_key_mode, modes.backarrow);
        screen_.modes.set(.ignore_keypad_with_numlock, modes.numlock);
        screen_.modes.set(.alt_esc_prefix, modes.alt_escape);
        screen_.flags.modify_other_keys_2 = modes.modify_other;
        screen_.screens.active.kitty_keyboard.set(.set, @bitCast(modes.kitty));
        screen_.flags.mouse_event = modes.mouse_event;
        screen_.flags.mouse_format = modes.mouse_format;
        t.bottom = view.bottom;
        if (t.offset != null) t.offset = view.offset;
        if (t.selection) |sel| try t.inner.select(sel.x, sel.y, sel.end_x, sel.end_y);
        try t.updateRender();
        // Only acknowledge surfaces actually installed. A mouse gesture may
        // hold the old display while the daemon continues collecting output.
        t.known = view.stamp;
    }
};
pub const Pane = struct {
    binding: u64 = 0,
    id: layout.PaneId,
    label: []const u8,
    cwd: []const u8,
    agent: protocol.Agent,
    terminal: *Terminal,
    /// The command a reopened agent runs while its old screen shows.
    restoring: []const u8 = "",
    /// Its command forks, so the band says "Forking…".
    forking: bool = false,
    /// When this viewer first saw it restoring, which its animation starts from.
    restoring_since: i64 = 0,
};
pub const Workspaces = struct {
    items: []protocol.Workspace = &.{},
    pub fn index(store: *const Workspaces, id: WorkspaceId) ?usize {
        for (store.items, 0..) |ws, i| if (ws.id == id) return i;
        return null;
    }
    pub fn owner(store: *Workspaces, pane: layout.PaneId) ?*protocol.Workspace {
        for (store.items) |*ws| if (ws.model.tabForPane(pane) != null) return ws;
        return null;
    }
};
pub const Runtime = struct {
    snapshot: ?std.json.Parsed(protocol.Snapshot) = null,
    snapshot_hash: ?u64 = null,
    workspaces: Workspaces = .{},
    panes: std.ArrayList(Pane) = .empty,
    sessions: []const protocol.Native = &.{},
    conversations: []const protocol.Conversation = &.{},
    system_model: []const u8 = "",
    system_model_name: []const u8 = "",
    release_version: []const u8 = "",
    release_commit: []const u8 = "",
    staged_version: []const u8 = "",
    inference: inference_setup.Status = .{},
    system_working: bool = false,
    system_usage: live_usage.View = .{},
    ports: ports.Snapshot = .{},
    resources: resources.Snapshot = .{},
    /// Owns `resources`, which arrive beside the session with their own hash.
    resources_parsed: ?std.json.Parsed(resources.Snapshot) = null,
    resources_hash: ?u64 = null,
    last_agent: providers.Provider = .codex,
    agent_yolo: providers.Each(bool, false) = .{},
    agent_hidden: providers.Each(bool, false) = .{},
    agent_commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    pub fn pane(r: *Runtime, id: layout.PaneId) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }
    pub fn deinit(r: *Runtime) void {
        for (r.panes.items) |p| p.terminal.destroy();
        r.panes.deinit(a);
        if (r.snapshot) |snapshot| snapshot.deinit();
        if (r.resources_parsed) |parsed| parsed.deinit();
    }
    pub fn receiveResources(r: *Runtime, value: std.json.Value) !void {
        const parsed = try std.json.parseFromValue(resources.Snapshot, a, value, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
        if (r.resources_parsed) |previous| previous.deinit();
        r.resources_parsed = parsed;
        r.resources = parsed.value;
    }
    pub fn receive(r: *Runtime, conn: *Connection, value: std.json.Value) !void {
        // Own the decoded snapshot. Metadata is used directly; only terminal
        // surfaces and interaction state survive independently between snapshots.
        const parsed = try std.json.parseFromValue(protocol.Snapshot, a, value, .{ .allocate = .alloc_always, .ignore_unknown_fields = true });
        errdefer parsed.deinit();
        const snapshot = parsed.value;
        if (snapshot.workspaces.len == 0 or snapshot.workspaces.len > workspace.max_workspaces or snapshot.panes.len > layout.max_panes) return error.InvalidSnapshot;
        var panes: std.ArrayList(Pane) = .empty;
        errdefer {
            for (panes.items) |p| if (r.pane(p.id) == null) p.terminal.destroy();
            panes.deinit(a);
        }
        try panes.ensureTotalCapacity(a, snapshot.panes.len);
        const now = os.milliTimestamp();
        for (snapshot.panes) |info| {
            const previous = r.pane(info.id);
            const term = if (previous) |old| old.terminal else blk: {
                const created = try a.create(Terminal);
                errdefer a.destroy(created);
                created.* = .{ .id = info.id, .conn = conn, .inner = try terminal.Terminal.create(info.cols, info.rows) };
                break :blk created;
            };
            const was_restoring = if (previous) |old| old.restoring.len > 0 else false;
            panes.appendAssumeCapacity(.{
                .id = info.id,
                .binding = info.binding,
                .label = info.name,
                .cwd = info.cwd,
                .agent = info.agent,
                .terminal = term,
                .restoring = info.restoring,
                .forking = info.forking,
                .restoring_since = if (was_restoring) previous.?.restoring_since else now,
            });
        }
        for (r.panes.items) |old| {
            const retained = for (panes.items) |p| {
                if (p.id == old.id) break true;
            } else false;
            if (!retained) old.terminal.destroy();
        }
        r.panes.deinit(a);
        if (r.snapshot) |previous| previous.deinit();
        r.snapshot = parsed;
        r.snapshot_hash = null;
        r.panes = panes;
        r.workspaces.items = snapshot.workspaces;
        r.sessions = snapshot.native_sessions;
        r.conversations = snapshot.conversations;
        r.system_model = snapshot.system_model;
        r.system_model_name = snapshot.system_model_name;
        r.release_version = snapshot.release_version;
        r.release_commit = snapshot.release_commit;
        r.staged_version = snapshot.staged_version;
        r.inference = snapshot.inference;
        r.system_usage = snapshot.system_usage;
        r.system_working = snapshot.system_working;
        r.ports = snapshot.ports;
        r.last_agent = snapshot.last_agent;
        r.agent_yolo = snapshot.agent_yolo;
        r.agent_hidden = snapshot.agent_hidden;
        r.agent_commands = snapshot.agent_commands;
    }
};
