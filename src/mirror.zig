//! A viewer's private projection of shared session organization and pane surfaces.
//! These terminals are framebuffers: no child process or PTY is created here.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const terminal = @import("terminal.zig");
const vt = terminal.vt;
const protocol = @import("protocol.zig");
const layout = @import("layout.zig");
const workspace = @import("workspace.zig");
const Connection = @import("rpc.zig").Connection;
const surface = @import("surface.zig");

pub const Terminal = struct {
    const Selection = struct { x: u16, y: u16, end_x: u16, end_y: u16 };
    inner: *terminal.Terminal,
    conn: *Connection,
    id: u32,
    offset: ?usize = null,
    bottom: usize = 0,
    selection: ?Selection = null,
    holding_selection: bool = false,
    pending: std.ArrayList(u8) = .empty,
    pub fn emulator(t: *Terminal) *vt.Terminal {
        return &t.inner.vt;
    }
    pub fn hyperlinks(t: *Terminal) []const @import("hyperlinks.zig").Link {
        return t.inner.hyperlinks();
    }
    pub fn renderState(t: *Terminal) *vt.RenderState {
        return &t.inner.render;
    }
    pub fn updateRender(t: *Terminal) !void {
        try t.inner.updateRender();
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
    }
    pub fn selectedText(t: *Terminal) ![]const u8 {
        return t.inner.selectedText();
    }
    pub fn search(t: *Terminal, needle: []const u8, skip: usize) !bool {
        const response = try t.conn.call(.{ .op = "viewer.search", .protocol = 1, .pane = t.id, .needle = needle, .skip = skip });
        defer response.deinit();
        const offset = response.value.object.get("offset") orelse return false;
        if (offset == .null) return false;
        t.offset = @intCast(offset.integer);
        if (response.value.object.get("match")) |match| if (match != .null) {
            const parsed = try std.json.parseFromValue(Selection, a, match, .{});
            defer parsed.deinit();
            t.selection = parsed.value;
        };
        return true;
    }
    pub fn send(t: *Terminal, bytes: []const u8) !void {
        if (t.pending.items.len + bytes.len > 1024 * 1024) return error.InputBackpressure;
        try t.pending.appendSlice(a, bytes);
    }
    pub fn flush(t: *Terminal) !void {
        if (t.pending.items.len == 0) return;
        t.conn.send(.{ .op = "session.command", .protocol = 1, .command = .{ .@"pane.input" = .{ .target = t.id, .data = t.pending.items } } }) catch |err| {
            if (err != error.NoPane) return err;
        };
        t.pending.clearRetainingCapacity();
    }
    pub fn receive(t: *Terminal, view: surface.View) !void {
        // Keep the displayed text stable for the entire mouse gesture. The
        // runtime continues collecting output; release resumes the live surface.
        if (t.holding_selection) return;
        const frame = view.surface;
        if (frame.cols == 0 or frame.rows == 0) return;
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
        try t.inner.updateRender();
    }
};
pub const Pane = struct {
    id: u32,
    label: []const u8,
    cwd: []const u8,
    agent: protocol.Agent,
    terminal: *Terminal,
};
pub const Workspaces = struct {
    items: []protocol.Workspace = &.{},
    pub fn index(store: *const Workspaces, id: u32) ?usize {
        for (store.items, 0..) |ws, i| if (ws.id == id) return i;
        return null;
    }
    pub fn owner(store: *Workspaces, pane: u32) ?*protocol.Workspace {
        for (store.items) |*ws| if (ws.model.tabForPane(pane) != null) return ws;
        return null;
    }
};
pub const Runtime = struct {
    snapshot: ?std.json.Parsed(protocol.Snapshot) = null,
    workspaces: Workspaces = .{},
    panes: std.ArrayList(Pane) = .empty,
    sessions: []const protocol.Native = &.{},
    ports: @import("ports.zig").Snapshot = .{},
    revision: u64 = 0,
    closed_panes: usize = 0,
    pub fn pane(r: *Runtime, id: u32) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }
    pub fn deinit(r: *Runtime) void {
        for (r.panes.items) |p| p.terminal.destroy();
        r.panes.deinit(a);
        if (r.snapshot) |snapshot| snapshot.deinit();
    }
    pub fn receive(r: *Runtime, conn: *Connection, value: std.json.Value) !void {
        // Own the decoded snapshot. Metadata is used directly; only terminal
        // surfaces and interaction state survive independently between snapshots.
        const parsed = try std.json.parseFromValue(protocol.Snapshot, a, value, .{ .allocate = .alloc_always });
        errdefer parsed.deinit();
        const snapshot = parsed.value;
        if (snapshot.workspaces.len == 0 or snapshot.workspaces.len > workspace.max_workspaces or snapshot.panes.len > layout.max_panes) return error.InvalidSnapshot;
        var panes: std.ArrayList(Pane) = .empty;
        errdefer {
            for (panes.items) |p| if (r.pane(p.id) == null) p.terminal.destroy();
            panes.deinit(a);
        }
        try panes.ensureTotalCapacity(a, snapshot.panes.len);
        for (snapshot.panes) |info| {
            const term = if (r.pane(info.id)) |old| old.terminal else blk: {
                const created = try a.create(Terminal);
                errdefer a.destroy(created);
                created.* = .{ .id = info.id, .conn = conn, .inner = try terminal.Terminal.create(info.cols, info.rows) };
                break :blk created;
            };
            panes.appendAssumeCapacity(.{ .id = info.id, .label = info.name, .cwd = info.cwd, .agent = info.agent, .terminal = term });
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
        r.panes = panes;
        r.workspaces.items = snapshot.workspaces;
        r.sessions = snapshot.native_sessions;
        r.ports = snapshot.ports;
        r.revision = snapshot.revision;
        r.closed_panes = snapshot.closed_panes;
    }
};
