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
const agents = @import("agents.zig");
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
    pending: std.ArrayList(u8) = .empty,
    pub fn emulator(t: *Terminal) *vt.Terminal {
        return &t.inner.vt;
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
        t.conn.send(.{ .op = "pane.input", .protocol = 1, .pane = t.id, .data = t.pending.items }) catch |err| {
            if (err != error.NoPane) return err;
        };
        t.pending.clearRetainingCapacity();
    }
    pub fn receive(t: *Terminal, view: surface.View) !void {
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
pub const Pane = struct { id: u32, terminal: *Terminal, agent: agents.Agent = .{}, cwd: []const u8 };
pub const Native = struct {
    observation: agents.observation.State = .{},
    id: u32,
    workspace_id: u32,
    provider: agents.Provider,
    cwd: []const u8,
    state: agents.State,
    attention: agents.Attention,
    tool_active: bool,
    pub fn toolActive(s: Native) bool {
        return s.tool_active;
    }
};
pub const Runtime = struct {
    workspaces: workspace.Store = .{},
    panes: std.ArrayList(Pane) = .empty,
    sessions: std.ArrayList(Native) = .empty,
    tokens: [workspace.max_workspaces]u64 = @splat(0),
    revision: u64 = 0,
    closed_panes: usize = 0,
    pub fn pane(r: *Runtime, id: u32) ?*Pane {
        for (r.panes.items) |*p| if (p.id == id) return p;
        return null;
    }
    pub fn deinit(r: *Runtime) void {
        for (r.panes.items) |p| {
            p.terminal.destroy();
            a.free(p.cwd);
        }
        r.panes.deinit(a);
        for (r.sessions.items) |s| a.free(s.cwd);
        r.sessions.deinit(a);
        r.workspaces.deinit();
    }
    pub fn receive(r: *Runtime, conn: *Connection, snapshot: protocol.Snapshot) !void {
        if (snapshot.workspaces.len == 0 or snapshot.workspaces.len > workspace.max_workspaces) return error.InvalidSnapshot;
        var next: workspace.Store = .{};
        errdefer next.deinit();
        const selected = if (r.workspaces.items.items.len > 0) r.workspaces.current().id else 0;
        for (snapshot.workspaces, 0..) |ws, index| {
            const previous = if (r.workspaces.index(ws.id)) |i| r.workspaces.items.items[i].model else layout.Model{};
            // Do not resolve remote paths or persist the viewer's selection.
            var item: workspace.Workspace = .{ .id = ws.id, .cwd = try a.dupe(u8, ws.cwd), .git_ahead = ws.git_ahead, .away = .{ .counts = ws.stats }, .model = try protocol.modelFromTabs(ws.tabs, &previous) };
            item.name_len = agents.clean(&item.name_buf, ws.custom_name orelse ws.name);
            try next.items.append(a, item);
            if (ws.id == selected) next.active = index;
            r.tokens[index] = ws.token;
        }
        r.workspaces.deinit();
        r.workspaces = next;
        var i: usize = 0;
        while (i < r.panes.items.len) {
            const id = r.panes.items[i].id;
            const found = for (snapshot.panes) |p| {
                if (p.id == id) break true;
            } else false;
            if (!found) {
                const old = r.panes.orderedRemove(i);
                old.terminal.destroy();
                a.free(old.cwd);
            } else i += 1;
        }
        for (snapshot.panes) |info| {
            if (r.pane(info.id) == null) {
                const term = try a.create(Terminal);
                errdefer a.destroy(term);
                term.* = .{ .id = info.id, .conn = conn, .inner = try terminal.Terminal.create(info.cols, info.rows) };
                try r.panes.append(a, .{ .id = info.id, .terminal = term, .cwd = try a.dupe(u8, info.cwd) });
            }
            const p = r.pane(info.id).?;
            const cwd = try a.dupe(u8, info.cwd);
            a.free(p.cwd);
            p.cwd = cwd;
            p.agent.setName(info.agent.name);
            p.agent.changed_at = info.agent.changed_at;
            p.agent.provider = info.agent.provider;
            p.agent.state = info.agent.state;
            p.agent.attention = info.agent.attention;
            p.agent.observation = info.agent.observation;
            p.agent.recent_len = agents.clean(&p.agent.recent, info.agent.recent_activity);
            p.agent.tool_active = info.agent.tool_active;
            p.agent.session_len = agents.clean(&p.agent.session, info.agent.session);
            p.agent.activity_len = agents.clean(&p.agent.activity, info.agent.activity);
            p.agent.cwd_len = agents.clean(&p.agent.cwd, info.agent.cwd);
        }
        for (r.sessions.items) |s| a.free(s.cwd);
        r.sessions.clearRetainingCapacity();
        for (snapshot.native_sessions) |s| try r.sessions.append(a, .{
            .id = s.id,
            .workspace_id = s.workspace,
            .provider = s.provider,
            .cwd = try a.dupe(u8, s.cwd),
            .state = s.state,
            .attention = s.attention,
            .observation = s.observation,
            .tool_active = s.tool_active,
        });
        r.revision = snapshot.revision;
        r.closed_panes = snapshot.closed_panes;
    }
};
