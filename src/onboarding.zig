//! A cell-based, viewer-owned wizard. Its bounds depend only on terminal size.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const keys = @import("keys.zig");
const km = @import("keymap.zig");
const catalog = @import("import_catalog.zig");
const sidebar = @import("sidebar.zig");
const Connection = @import("rpc.zig").Connection;
const Rect = @import("layout.zig").Rect;
const shortcut_help = @import("shortcut_help.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const builtin = @import("builtin");
const herdr_adapter = @import("herdr_adapter.zig");
const ghostty_integration = @import("ghostty_integration.zig");
pub const Step = enum { presets, keymap, connect, import, progress, complete };
/// `welcome` is the first-run wizard. Corgi setup opens `keyboard` or `import`
/// on its own: no greeting, and finishing returns to Corgi instead of chaining.
pub const Mode = enum { welcome, keyboard, import };
pub const Progress = struct { phase: []const u8 = "idle", completed: usize = 0, total: usize = 0, workspace: ?WorkspaceId = null, message: []const u8 = "" };
/// `Progress.phase` stays a string on the wire because it is also displayed.
const Phase = enum { idle, connecting, receiving, preparing, committing, copying, complete, failed };
pub const State = struct {
    preset: km.Preset = .corgi,
    prefix: km.Prefix = .ctrl_b,
    step: Step = .presets,
    source: catalog.Source = .tmux,
    source_initialized: bool = false,
    help: shortcut_help.State = .{},
    workers: [3]?*catalog.Worker = .{ null, null, null },
    selected: [256]bool = @splat(false),
    expanded: [256]bool = @splat(false),
    cursor: usize = 0,
    scroll: usize = 0,
    reveal_cursor: bool = false,
    handoff: bool = true,
    focus: u8 = 0,
    progress: Progress = .{},
    progress_data: ?std.json.Parsed(Progress) = null,
    message: [256]u8 = @splat(0),
    message_len: usize = 0,
    last_poll: i64 = 0,
    blink_closed: bool = false,
    scan_finished: bool = false,
    selection_initialized: bool = false,
    operation: u64 = 0,
    mode: Mode = .welcome,
    /// Opened on request (not first run): Esc on the first screen closes it.
    dismissable: bool = false,
    cancelled: bool = false,
    pub fn start(mode: Mode, preset: km.Preset, prefix: km.Prefix) State {
        var state: State = .{ .mode = mode, .preset = preset, .prefix = prefix, .dismissable = true };
        if (mode == .import) state.enterImport();
        return state;
    }
    fn cancel(s: *State) bool {
        s.cancelled = true;
        return true;
    }
    pub fn deinit(s: *State) void {
        for (s.workers) |entry| if (entry) |w| w.deinit();
        if (s.progress_data) |data| data.deinit();
    }
    pub fn fail(s: *State, err: anyerror) void {
        s.setMessage(@errorName(err));
    }
    fn setMessage(s: *State, msg: []const u8) void {
        s.message_len = @min(msg.len, s.message.len);
        @memcpy(s.message[0..s.message_len], msg[0..s.message_len]);
    }
    fn phase(s: *const State) ?Phase {
        return std.meta.stringToEnum(Phase, s.progress.phase);
    }
    pub fn worker(s: *const State) ?*catalog.Worker {
        return s.workers[@intFromEnum(s.source)];
    }
    pub fn items(s: *const State) []const catalog.Workspace {
        const w = s.worker() orelse return &.{};
        return if (w.done.load(.acquire)) w.catalog.workspaces[0..@min(256, w.catalog.workspaces.len)] else &.{};
    }
    fn scan(s: *State) void {
        s.scan_finished = false;
        if (s.worker() == null) s.workers[@intFromEnum(s.source)] = catalog.Worker.start(s.source) catch |err| {
            s.fail(err);
            return;
        };
    }
    fn changeSource(s: *State, source: catalog.Source) void {
        if (!std.mem.containsAtLeast(catalog.Source, catalog.available_sources, 1, &.{source})) return;
        s.operation = 0;
        s.source = source;
        s.cursor = 0;
        s.scroll = 0;
        s.selected = @splat(false);
        s.expanded = @splat(false);
        s.selection_initialized = false;
        s.message_len = 0;
        s.scan();
    }
    fn enterKeymap(s: *State) void {
        s.step = .keymap;
        s.help = .{};
    }
    fn enterImport(s: *State) void {
        s.step = .import;
        s.focus = 0;
        if (!s.source_initialized) {
            s.source_initialized = true;
            s.source = if (herdr_adapter.detected()) .herdr else switch (km.supportedPreset(s.preset)) {
                .herdr => .herdr,
                .cmux => .cmux,
                else => .tmux,
            };
        }
        s.scan();
    }
    fn activeHandoff(s: *const State) bool {
        const list = s.items();
        return s.source == .herdr and s.handoff and list.len > 0 and list[@min(s.cursor, list.len - 1)].handoff;
    }
    fn chosen(s: *const State, index: usize) bool {
        return if (s.activeHandoff()) s.items()[index].session == s.items()[@min(s.cursor, s.items().len - 1)].session else s.selected[index];
    }
    fn selectionCount(s: *const State) usize {
        var n: usize = 0;
        for (s.items(), 0..) |_, i| {
            if (s.chosen(i)) n += 1;
        }
        return n;
    }
    fn begin(s: *State, conn: *Connection) !bool {
        if (s.selectionCount() == 0) return if (s.mode == .import) s.cancel() else true;
        if (s.operation == 0) s.operation = (std.crypto.random.int(u64) >> 1) | 1;
        if (s.activeHandoff()) {
            if (os.env("HERDR_PANE_ID")) |current_pane| {
                for (s.items()) |ws| if (ws.session == s.items()[s.cursor].session) {
                    for (ws.tabs) |tab| for (tab.panes) |pane| if (std.mem.eql(u8, pane.id, current_pane)) return error.OpenCorgiOutsideHerdrFirst;
                };
            }
            const result = try conn.call(.{ .viewer_pgid = os.c.getpgrp(), .op = "onboarding.handoff", .protocol = 1, .operation = s.operation, .socket = s.items()[s.cursor].socket });
            result.deinit();
        } else {
            var selected: std.ArrayList(catalog.Workspace) = .empty;
            defer selected.deinit(a);
            for (s.items(), 0..) |ws, i| if (s.chosen(i)) {
                try selected.append(a, ws);
            };
            if (s.source == .herdr) {
                // A copy transaction covers one source session at a time.
                const first = selected.items[0].session;
                for (selected.items) |ws| if (ws.session != first) return error.ChooseOneHerdrSession;
                var ids: std.ArrayList([]const u8) = .empty;
                defer ids.deinit(a);
                for (selected.items) |ws| try ids.append(a, ws.id);
                const result = try conn.call(.{
                    .op = "onboarding.copy",
                    .protocol = 1,
                    .operation = s.operation,
                    .source = s.source,
                    .workspaces = selected.items,
                    .herdr_session = s.worker().?.herdr_scan.?.sessions[first],
                    .selected = ids.items,
                });
                result.deinit();
            } else {
                var arena: std.heap.ArenaAllocator = .init(a);
                defer arena.deinit();
                const workspaces = try catalog.copyWorkspaces(arena.allocator(), selected.items);
                const result = try conn.call(.{ .op = "onboarding.copy", .protocol = 1, .operation = s.operation, .source = s.source, .workspaces = workspaces });
                result.deinit();
            }
        }
        s.step = .progress;
        s.scroll = 0;
        s.message_len = 0;
        s.progress = .{ .phase = "connecting" };
        s.last_poll = 0;
        return false;
    }
    pub fn poll(s: *State, conn: *Connection) bool {
        const blink = s.cmuxConfused() and @mod(std.time.milliTimestamp(), 5000) >= 4850;
        const animation_changed = blink != s.blink_closed;
        s.blink_closed = blink;
        if (s.step == .import) {
            if (!s.scan_finished) if (s.worker()) |w| if (w.done.load(.acquire)) {
                s.scan_finished = true;
                s.cursor = @min(s.cursor, s.items().len -| 1);
                s.selectDefaults();
                return true;
            };
            return animation_changed;
        }
        if (s.step != .progress or std.time.milliTimestamp() - s.last_poll < 100) return animation_changed;
        s.last_poll = std.time.milliTimestamp();
        const response = conn.call(.{ .op = "onboarding.status", .protocol = 1, .operation = s.operation }) catch |err| {
            s.fail(err);
            return true;
        };
        defer response.deinit();
        const value = response.value.object.get("progress") orelse return false;
        const parsed = std.json.parseFromValue(Progress, a, value, .{ .allocate = .alloc_always, .ignore_unknown_fields = true }) catch |err| {
            s.fail(err);
            return true;
        };
        if (s.progress_data) |old| old.deinit();
        s.progress_data = parsed;
        s.progress = parsed.value;
        if (s.phase() == .complete) s.step = .complete;
        return true;
    }
    pub fn key(s: *State, byte: u8, conn: *Connection) !bool {
        if (s.step == .import) s.selectDefaults();
        s.preset = km.supportedPreset(s.preset);
        s.message_len = 0;
        switch (s.step) {
            .presets => switch (byte) {
                'j', 14 => s.preset = km.available_presets[(@as(usize, @intFromEnum(s.preset)) + 1) % km.available_presets.len],
                'k', 16 => s.preset = km.available_presets[(@as(usize, @intFromEnum(s.preset)) + km.available_presets.len - 1) % km.available_presets.len],
                '1'...'4' => if (byte - '1' < km.available_presets.len) {
                    s.preset = km.available_presets[byte - '1'];
                },
                'p', 'P', ' ' => s.prefix = if (s.prefix == .ctrl_b) .ctrl_a else .ctrl_b,
                '?' => {
                    s.enterKeymap();
                },
                9 => s.focus = (s.focus + 1) % 3,
                27 => if (s.dismissable) return s.cancel(),
                13 => {
                    if (s.focus == 1) {
                        s.prefix = if (s.prefix == .ctrl_b) .ctrl_a else .ctrl_b;
                    } else if (s.focus == 2) {
                        s.enterKeymap();
                    } else if (s.preset == .cmux) {
                        s.step = .connect;
                    } else if (s.mode == .keyboard) return true else s.enterImport();
                },
                else => {},
            },
            .keymap => if (s.help.key(byte)) {
                s.step = .presets;
            },
            .connect => switch (byte) {
                27 => s.step = .presets,
                'p' => {
                    s.preset = .herdr;
                    if (s.mode == .keyboard) return true;
                    s.enterImport();
                },
                13 => {
                    if (ghosttyHost()) {
                        try ghostty_integration.setCmux();
                        if (s.mode == .keyboard) return true;
                        s.enterImport();
                        s.setMessage("Reload Ghostty: Cmd+Shift+, to apply Command keys.");
                    } else s.setMessage("Press P for portable Herdr prefix keys, or Esc to choose again.");
                },
                else => {},
            },
            .import => switch (byte) {
                's', 'S' => return if (s.mode == .import) s.cancel() else true,
                27 => if (s.mode == .import) return s.cancel() else {
                    s.step = .presets;
                },
                '1'...'3' => s.changeSource(@enumFromInt(byte - '1')),
                'h' => if (s.source == .herdr) {
                    s.handoff = !s.handoff;
                },
                'r' => {
                    if (s.worker()) |w| {
                        if (!w.done.load(.acquire)) return false;
                        w.deinit();
                        s.workers[@intFromEnum(s.source)] = null;
                    }
                    s.selected = @splat(false);
                    s.expanded = @splat(false);
                    s.selection_initialized = false;
                    s.scan();
                },
                'j', 14 => {
                    s.cursor = @min(s.cursor + 1, s.items().len -| 1);
                    s.reveal_cursor = true;
                },
                'k', 16 => {
                    s.cursor -|= 1;
                    s.reveal_cursor = true;
                },
                ' ', 'x' => if (s.items().len > 0 and !s.activeHandoff()) {
                    s.selected[s.cursor] = !s.selected[s.cursor];
                },
                'e', 'E' => s.toggleExpanded(s.cursor),
                9 => s.focus = (s.focus + 1) % 2,
                13 => return s.begin(conn),
                else => {},
            },
            .progress => {
                if (s.phase() == .failed and (byte == 27 or byte == 13)) {
                    s.step = .import;
                    s.operation = 0;
                    s.setMessage(s.progress.message);
                }
            },
            .complete => if (byte == 13) {
                return true;
            },
        }
        return false;
    }
    fn selectDefaults(s: *State) void {
        if (s.selection_initialized) return;
        const w = s.worker() orelse return;
        if (!w.done.load(.acquire)) return;
        s.selection_initialized = true;
        if (s.source == .tmux) for (0..@min(3, s.items().len)) |i| {
            s.selected[i] = true;
        };
    }
    fn preview(s: *const State, ws: catalog.Workspace, index: usize) WorkspacePreview {
        return WorkspacePreview.init(ws, s.step == .import, s.expanded[index]);
    }
    fn toggleExpanded(s: *State, index: usize) void {
        const list = s.items();
        if (index >= list.len or s.preview(list[index], index).toggle_row == null) return;
        var row: usize = 0;
        for (list[0..index], 0..) |ws, i| row += s.preview(ws, i).rows;
        s.expanded[index] = !s.expanded[index];
        s.scroll = row;
        s.reveal_cursor = false;
    }
    pub fn sequence(s: *State, seq: []const u8, conn: *Connection) !bool {
        if (s.step == .keymap) {
            s.help.sequence(seq);
            return false;
        }
        if (keys.parse(seq)) |k| switch (k) {
            .up => return s.key(16, conn),
            .down => return s.key(14, conn),
            .page_up => s.scroll -|= 5,
            .page_down => s.scroll += 5,
            else => {},
        };
        // CSI-only, unlike keys.zig's arrows.
        if (s.step == .import and (std.mem.eql(u8, seq, "\x1b[C") or std.mem.eql(u8, seq, "\x1b[D"))) {
            const delta: usize = if (seq[2] == 'C') 1 else catalog.available_sources.len - 1;
            s.changeSource(catalog.available_sources[(@as(usize, @intFromEnum(s.source)) + delta) % catalog.available_sources.len]);
        }
        return false;
    }
    pub fn click(s: *State, cols: u16, rows: u16, x: u16, y: u16, conn: *Connection) !bool {
        if (s.step == .keymap) {
            if (shortcut_help.State.closeAt(cols, rows, x, y)) s.step = .presets;
            return false;
        }
        const b = bounds(cols, rows);
        if (!b.contains(x, y) or b.w < 76 or b.h < 26) return false;
        const rx = x - b.x;
        const ry = y - b.y;
        if (ry == b.h - 3) {
            if (s.step == .presets) s.focus = 0;
            if (rx < 15 and (s.step != .presets or s.dismissable)) return s.key(27, conn);
            return s.key(13, conn);
        }
        if (s.step == .presets) {
            const layout = presetLayout(b);
            for (layout.cards, 0..) |card, i| if (card.contains(x, y)) {
                s.preset = km.available_presets[i];
                s.focus = 0;
                return false;
            };
            if (s.preset != .cmux and layout.prefix.contains(x, y)) return s.key('p', conn);
            if (ry == layout.help_y and rx >= layout.detail_x) {
                if (rx < layout.detail_x + 20) return s.key('?', conn);
                if (s.preset == .cmux) return s.key('p', conn);
            }
        } else if (s.step == .import) {
            if (ry == 6 and rx >= b.w -| 23) return s.key('s', conn);
            if (ry == 6 and rx >= 3 and rx < 3 + 14 * catalog.available_sources.len) return s.key('1' + @as(u8, @intCast((rx - 3) / 14)), conn);
            if (ry == 8 and s.source == .herdr) return s.key('h', conn);
            if (ry < 11 or ry >= b.h - 5) return false;
            var row: usize = 0;
            for (s.items(), 0..) |ws, i| {
                const preview_layout = s.preview(ws, i);
                if (row >= s.scroll and ry == 11 + row - s.scroll) {
                    s.cursor = i;
                    if (!s.activeHandoff()) s.selected[i] = !s.selected[i];
                    break;
                }
                if (preview_layout.toggle_row) |offset| {
                    const toggle_row = row + offset;
                    if (toggle_row >= s.scroll and ry == 11 + toggle_row - s.scroll) {
                        s.toggleExpanded(i);
                        break;
                    }
                }
                row += preview_layout.rows;
            }
        }
        return false;
    }
    pub fn frame(s: *State, cols: u16, rows: u16) ![]u8 {
        if (s.step == .import) s.selectDefaults();
        s.preset = km.supportedPreset(s.preset);
        if (s.step == .keymap) return s.help.frame(cols, rows, s.preset, s.prefix);
        var out: std.Io.Writer.Allocating = .init(a);
        errdefer out.deinit();
        const w = &out.writer;
        try w.writeAll("\x1b[0;48;2;24;27;32m\x1b[2J\x1b[?25l");
        const b = bounds(cols, rows);
        if (b.w < 76 or b.h < 26) {
            try w.writeAll("\x1b[H\x1b[38;2;201;208;215mWelcome to Corgi. Enlarge the terminal to 76 × 26 to continue.");
            return out.toOwnedSlice();
        }
        try box(w, b, false);
        try put(w, b, 2, 0, switch (s.mode) {
            .welcome => " Welcome to Corgi ",
            .keyboard => " Keyboard shortcuts ",
            .import => " Import sessions ",
        }, mint);
        try put(w, b, 3, 2, switch (s.step) {
            .presets => "Which shortcuts feel like home?",
            .keymap => "Your shortcuts",
            .connect => "Connect your Command keys",
            .import => "Bring your work along",
            .progress => if (s.activeHandoff()) "Handing off to Corgi" else "Copying into Corgi",
            .complete => if (s.mode == .import) "Import complete" else "You're ready to go",
        }, bright);
        try put(w, b, 3, 3, switch (s.step) {
            .presets => "Choose familiar keys.",
            .keymap => "",
            .connect => "Your host terminal needs to forward these shortcuts.",
            .import => switch (s.source) {
                .tmux => "Copy sessions, scrollback and commands. Source processes stay in tmux.",
                .herdr => "Choose a session to bring into Corgi.",
                .cmux => "Copy workspaces and surfaces. Source processes stay in cmux.",
            },
            .progress => s.progress.message,
            .complete => if (s.activeHandoff()) "Your processes are running in Corgi." else "Your workspaces are ready.",
        }, dim);
        switch (s.step) {
            .presets => try drawPresets(w, b, s),
            .keymap => unreachable,
            .connect => {
                try put(w, b, 5, 7, if (ghosttyHost()) "Ghostty / macOS" else "Command forwarding is not confirmed", mint);
                try put(w, b, 5, 10, if (ghosttyHost()) "[ Connect and continue ]" else "[ P Use Herdr prefix keys ]", bright);
                try put(w, b, 5, 13, "Ghostty setup changes shortcuts in every Ghostty window.", text);
                try put(w, b, 5, 15, "Cmd+T/D/W, workspace numbers and related bindings replace host actions.", dim);
                try put(w, b, 5, 17, "Reload Ghostty with Cmd+Shift+, after connecting.", dim);
                try put(w, b, 5, 20, "P  Continue with portable Herdr keys", mint);
            },
            .import, .progress, .complete => {
                if (s.step == .import) {
                    for (catalog.available_sources, 0..) |source, i| {
                        var buf: [32]u8 = undefined;
                        try put(w, b, 3 + i * 14, 6, try std.fmt.bufPrint(&buf, "[ {d} {s} ]", .{ i + 1, @tagName(source) }), if (source == s.source) mint else dim);
                    }
                    try put(w, b, b.w -| 23, 6, "[ S Skip import ]", dim);
                    if (s.source == .herdr) {
                        if (s.handoff and s.items().len > 0 and !s.activeHandoff()) try put(w, b, 3, 9, "Live handoff unavailable for this Herdr session; H switches to copy.", yellow);
                        if (s.activeHandoff()) {
                            var info: [100]u8 = undefined;
                            try put(w, b, 3, 9, try std.fmt.bufPrint(&info, "All {d} workspaces in this session move together.", .{s.selectionCount()}), dim);
                        }
                        try put(w, b, 3, 8, if (s.handoff) "[● ON ] Handoff processes  Keep your processes running" else "[  OFF] Handoff processes  Keep your processes running", mint);
                    } else if (!s.cmuxConfused()) try put(w, b, 3, 8, if (s.source == .cmux)
                        "Visible splits first · remaining surfaces in additional tabs"
                    else
                        "Up to 3 recent groups selected · Return in each pane restarts its command", dim);
                } else {
                    var buf: [120]u8 = undefined;
                    try put(w, b, 3, 6, try std.fmt.bufPrint(&buf, "{s}  {d}/{d}", .{ s.progress.phase, s.progress.completed, s.progress.total }), mint);
                    const status: []const u8 = if (s.step == .complete) "[✓] Complete" else if (s.phase() == .failed) "[!] Import stopped · Enter returns to selection" else "[···] Working";
                    try put(w, b, 3, 8, status, bright);
                }
                if (s.cmuxConfused()) {
                    const y: usize = if (s.step == .import) 8 else 9;
                    try put(w, b, 3, y, if (s.blink_closed) "ᐱ─ᴥ─ᐱ" else "ᐱoᴥ°ᐱ", yellow);
                    try put(w, b, 10, y, "I'm confused by this cmux version.", yellow);
                    try put(w, b, 10, y + 1, if (s.step == .complete) "Imported what I could. See details below." else "I'll bring over what I can.", dim);
                }
                if (s.worker()) |wk| {
                    if (!wk.done.load(.acquire)) try put(w, b, 5, 12, "Looking for running sessions…", dim) else if (s.items().len == 0) {
                        const empty: []const u8 = if (s.cmuxConfused())
                            "No workspaces could be recovered yet."
                        else if (wk.catalog.message.len > 0)
                            "Couldn't read this source. R retries; S skips import."
                        else
                            "No available sessions found. Continue without importing.";
                        try put(w, b, 5, 12, empty, text);
                        try put(w, b, 5, 14, wk.catalog.message, dim);
                    }
                }
                var row: usize = 0;
                var cursor_row: usize = 0;
                for (s.items(), 0..) |ws, i| {
                    if (s.step != .import and !s.chosen(i)) continue;
                    if (i == s.cursor) cursor_row = row;
                    row += s.preview(ws, i).rows;
                }
                const capacity: usize = b.h - 16;
                if (s.step == .import and s.reveal_cursor) {
                    s.reveal_cursor = false;
                    if (cursor_row < s.scroll) s.scroll = cursor_row;
                    if (cursor_row >= s.scroll + capacity) s.scroll = cursor_row - capacity + 1;
                }
                s.scroll = @min(s.scroll, row -| capacity);
                row = 0;
                var pane_number: usize = 0;
                for (s.items(), 0..) |ws, i| {
                    if (s.step != .import and !s.chosen(i)) continue;
                    const preview_layout = s.preview(ws, i);
                    var buf: [1024]u8 = undefined;
                    const cursor_mark: []const u8 = if (i == s.cursor and s.step == .import) "›" else " ";
                    const check_mark: []const u8 = if (s.chosen(i)) "[x]" else "[ ]";
                    try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "{s}{s} {s}", .{ cursor_mark, check_mark, short(ws.name) }), mint, "");
                    row += 1;
                    if (ws.recovery != .full) {
                        if (ws.recovery == .workspace) {
                            try treeLine(w, b, row, s.scroll, "    Workspace only · opens a new shell", yellow, "");
                            row += 1;
                        }
                        try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    {s}", .{ws.recovery_note}), yellow, "");
                        row += 1;
                    }
                    if (preview_layout.toggle_row != null and preview_layout.hidden == 0) {
                        try treeLine(w, b, row, s.scroll, "    ▾ Show less", mint, "");
                        row += 1;
                    }
                    var remaining = preview_layout.pane_limit;
                    for (ws.tabs, 0..) |tab, tab_index| {
                        if (remaining == 0) break;
                        const visible = @min(remaining, tab.panes.len);
                        remaining -= visible;
                        const last_tab = tab_index + 1 == ws.tabs.len;
                        const branch: []const u8 = if (last_tab) "└─" else "├─";
                        if (tab.panes.len == 1) {
                            const pane = tab.panes[0];
                            var hint: [120]u8 = undefined;
                            const done = s.step != .import and pane_number < s.progress.completed;
                            const label = try std.fmt.bufPrint(&buf, "    {s} {s} · {s}{s}", .{ branch, short(tab.name), if (done) "✓ " else "", short(pane.name) });
                            try treeLine(w, b, row, s.scroll, label, text, try paneAnnotation(s.source, s.activeHandoff(), pane, &hint));
                            row += 1;
                            pane_number += 1;
                            continue;
                        }
                        try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    {s} {s}", .{ branch, short(tab.name) }), text, "");
                        row += 1;
                        for (tab.panes[0..visible], 0..) |pane, pane_index| {
                            var hint: [120]u8 = undefined;
                            const annotation = try paneAnnotation(s.source, s.activeHandoff(), pane, &hint);
                            const rail: []const u8 = if (last_tab) " " else "│";
                            const twig: []const u8 = if (pane_index + 1 == tab.panes.len) "└─" else "├─";
                            const check: []const u8 = if (s.step != .import and pane_number < s.progress.completed) "✓ " else "";
                            const label = try std.fmt.bufPrint(&buf, "    {s}  {s} {s}{s}", .{ rail, twig, check, short(pane.name) });
                            try treeLine(w, b, row, s.scroll, label, text, annotation);
                            row += 1;
                            pane_number += 1;
                        }
                    }
                    if (preview_layout.hidden > 0) {
                        try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    …{d} more", .{preview_layout.hidden}), mint, "");
                        row += 1;
                    }
                    row += 1;
                }
            },
        }
        if (s.message_len > 0) try put(w, b, 3, b.h - @as(u16, if (s.step == .presets or s.step == .keymap) 4 else 5), s.message[0..s.message_len], yellow);
        try put(w, b, 3, b.h - 3, footerHint(s), dim);
        const cta: []const u8 = switch (s.step) {
            .presets => if (s.mode == .keyboard and s.preset != .cmux) "[ Enter Save ]" else "[ Enter Continue → ]",
            .keymap => "[ Enter Back ]",
            .connect => "[ Enter Connect → ]",
            .import => if (s.selectionCount() == 0)
                (if (s.mode == .import) "[ Enter Close ]" else "[ Enter Skip import → ]")
            else if (s.activeHandoff())
                "[ Enter Handoff → ]"
            else
                "[ Enter Import → ]",
            .progress => if (s.phase() == .failed) "[ Enter Back ]" else "[ Importing… ]",
            .complete => if (s.mode == .import) "[ Enter Done ]" else "[ Enter Open Corgi → ]",
        };
        try put(w, b, b.w -| 27, b.h - 3, cta, if (s.step == .presets and s.focus == 0) keycap else mint);
        try put(w, b, 3, b.h - 2, if (s.step == .import) "←→ sources · ↑↓ choose · PgUp/PgDn scroll · R refresh · S skip" else "", dim);
        try w.writeAll("\x1b[0m");
        return out.toOwnedSlice();
    }
    fn cmuxConfused(s: *const State) bool {
        if (s.source != .cmux or (s.step != .import and s.step != .progress and s.step != .complete)) return false;
        const wk = s.worker() orelse return false;
        return wk.done.load(.acquire) and wk.catalog.confused;
    }
};
// Rendering and mouse hit regions share one layout at every supported size.
const PresetLayout = struct {
    cards: [km.available_presets.len]Rect,
    hero: Rect,
    prefix: Rect,
    split: Rect,
    focus: Rect,
    detail_x: u16,
    summary_y: u16,
    help_y: u16,
};
fn presetLayout(b: Rect) PresetLayout {
    const compact = b.h < 32;
    const card_w: u16 = if (b.w >= 100) 32 else 24;
    const x = card_w + 7;
    const width = b.w - x - 4;
    const hero_h: u16 = if (compact) 3 else 6;
    const prefix_h: u16 = if (width < 64) 4 else 3;
    const panes_y = 6 + hero_h + prefix_h;
    const panes_h: u16 = if (compact) 6 else 7;
    const split_w = (width - 2) / 2;
    const summary_y = panes_y + panes_h + @as(u16, if (compact) 0 else 1);
    var cards: [km.available_presets.len]Rect = undefined;
    for (&cards, 0..) |*card, i| card.* = .{ .x = b.x + 3, .y = b.y + 6 + @as(u16, @intCast(i)) * 4, .w = card_w, .h = 4 };
    return .{
        .cards = cards,
        .hero = .{ .x = b.x + x, .y = b.y + 6 + prefix_h, .w = width, .h = hero_h },
        .prefix = .{ .x = b.x + x, .y = b.y + 6, .w = width, .h = prefix_h },
        .split = .{ .x = b.x + x, .y = b.y + panes_y, .w = split_w, .h = panes_h },
        .focus = .{ .x = b.x + x + split_w + 2, .y = b.y + panes_y, .w = width - split_w - 2, .h = panes_h },
        .detail_x = x,
        .summary_y = summary_y,
        .help_y = summary_y + @as(u16, if (compact) 2 else 3),
    };
}
fn drawPresets(w: *std.Io.Writer, b: Rect, s: *const State) !void {
    const layout = presetLayout(b);
    const direct = s.preset == .cmux;
    const prefix_name = if (s.prefix == .ctrl_b) "Ctrl+B" else "Ctrl+A";
    var buf: [120]u8 = undefined;
    for (km.available_presets, layout.cards) |preset, card| {
        const picked = s.preset == preset;
        try box(w, card, picked);
        const dot: []const u8 = if (picked) "●" else "○";
        const paw: []const u8 = if (preset == .corgi) "🐕 " else "";
        try put(w, card, 2, 1, try std.fmt.bufPrint(&buf, "{s} {s}{s}", .{ dot, paw, km.name(preset) }), if (picked) selected_style else bright);
        const description = if (card.w >= 32) km.description(preset) else switch (preset) {
            .corgi => "Made for Corgi",
            .tmux => "Classic splits",
            .herdr => "Home row",
            .cmux => "Command keys",
        };
        try put(w, card, 4, 2, description, if (picked) selected_style else dim);
    }

    const hero = layout.hero;
    const narrow = hero.w < 64;
    try box(w, hero, false);
    try put(w, hero, 2, 0, if (narrow or hero.h == 3) " New tab → agent picker " else " New tab ", mint);
    const key_y: usize = if (hero.h == 3) 1 else 2;
    try put(w, hero, 3, key_y, try std.fmt.bufPrint(&buf, "[ {s} ]", .{if (direct) "Cmd" else prefix_name}), keycap);
    try put(w, hero, if (direct) 11 else 15, key_y, if (direct) "+" else "then", text);
    try put(w, hero, if (direct) 15 else 22, key_y, if (direct) "[ T ]" else "[ c ]", mint);
    if (hero.h > 3) {
        if (narrow) {
            try put(w, hero, 3, key_y + 2, "Choose an agent or terminal", text);
        } else {
            try put(w, hero, 36, key_y, "Open the agent picker", text);
            try put(w, hero, 36, key_y + 1, "Agent or new terminal", dim);
        }
    }

    const band = layout.prefix;
    try box(w, band, false);
    try put(w, band, 2, 1, if (direct) "MODIFIER" else "PREFIX", mint);
    try put(w, band, 12, 1, try std.fmt.bufPrint(&buf, "[ {s} ]", .{if (direct) "Cmd" else prefix_name}), keycap);
    const explanation = if (direct) "Hold with the action key." else "Release, then press a key.";
    if (narrow) {
        try put(w, band, 2, 2, explanation, text);
    } else try put(w, band, 24, 1, explanation, text);
    if (!direct) try put(w, band, band.w - 14, 1, "[ P change ]", if (s.focus == 1) keycap else mint);

    const split = layout.split;
    try box(w, split, false);
    try put(w, split, 2, 0, " Split ", mint);
    const diagram_y: u16 = if (split.h == 6) 1 else 2;
    const diagram_w: u16 = if (split.w < 28) 5 else 9;
    const left_x: u16 = 2;
    const right_x = split.w / 2 + 1;
    try drawSplitDiagram(w, .{ .x = split.x + left_x, .y = split.y + diagram_y, .w = diagram_w, .h = 3 }, false);
    try drawSplitDiagram(w, .{ .x = split.x + right_x, .y = split.y + diagram_y, .w = diagram_w, .h = 3 }, true);
    try put(w, split, left_x, diagram_y + 3, if (direct) "D Right" else if (s.preset == .tmux) "% Right" else "v Right", mint);
    try put(w, split, right_x, diagram_y + 3, if (direct) "⇧D Down" else if (s.preset == .tmux) "\" Down" else "- Down", mint);

    const focus = layout.focus;
    try box(w, focus, false);
    try put(w, focus, 2, 0, " Focus pane ", mint);
    const nav_y: usize = if (focus.h == 6) 1 else 2;
    try put(w, focus, 2, nav_y, if (direct) "[ Cmd+Option ]" else if (s.preset == .tmux) "Arrow keys" else "Home row", if (direct) keycap else dim);
    const arrows = direct or s.preset == .tmux;
    const nav_x = (focus.w - 17) / 2;
    try put(w, focus, nav_x + 6, nav_y + 1, if (arrows) "[ ↑ ]" else "[ k ]", mint);
    try put(w, focus, nav_x, nav_y + 2, if (arrows) "[ ← ] [ ↓ ] [ → ]" else "[ h ] [ j ] [ l ]", mint);

    // The Command band applies to all direct keys; detach uses the portable prefix.
    const detail = Rect{ .x = b.x + layout.detail_x, .y = b.y, .w = hero.w, .h = b.h };
    const col = detail.w / 3;
    try put(w, detail, 0, layout.summary_y, "TABS", dim);
    try put(w, detail, col, layout.summary_y, if (narrow) "COPY" else "SCROLL / COPY", dim);
    try put(w, detail, col * 2, layout.summary_y, "DETACH", dim);
    try put(w, detail, 0, layout.summary_y + 1, if (direct) "⇧] / ⇧[" else "n / p", mint);
    try put(w, detail, col, layout.summary_y + 1, if (direct) "⇧M" else if (s.preset == .corgi) "s" else "[", mint);
    try put(w, detail, col * 2, layout.summary_y + 1, if (direct) try std.fmt.bufPrint(&buf, "{s} q", .{prefix_name}) else if (s.preset == .tmux) "d" else "q", mint);
    try put(w, detail, 0, layout.help_y, "[ ? Full keymap ]", if (s.focus == 2) keycap else mint);
    if (direct) {
        const prefix_hint = if (narrow) try std.fmt.bufPrint(&buf, "[ P {s} ]", .{prefix_name}) else try std.fmt.bufPrint(&buf, "Prefix [ {s} ]  P change", .{prefix_name});
        try put(w, detail, 22, layout.help_y, prefix_hint, if (s.focus == 1) keycap else mint);
    } else if (!narrow) try put(w, detail, 23, layout.help_y, try std.fmt.bufPrint(&buf, "{s} twice sends it through.", .{prefix_name}), dim);
}
fn drawSplitDiagram(w: *std.Io.Writer, b: Rect, down: bool) !void {
    try box(w, b, false);
    if (down) {
        try w.print("\x1b[{d};{d}H{s}├", .{ b.y + 2, b.x + 1, panel });
        for (0..b.w - 2) |_| try w.writeAll("─");
        try w.writeAll("┤");
    } else {
        for (0..3) |row| try w.print("\x1b[{d};{d}H{s}{s}", .{ b.y + row + 1, b.x + b.w / 2 + 1, panel, if (row == 0) "┬" else if (row == 2) "┴" else "│" });
    }
}
// Counts and hit targets use the same pane budget as the rendered tree.
const WorkspacePreview = struct {
    pane_limit: usize,
    hidden: usize,
    rows: usize,
    toggle_row: ?usize,

    fn init(ws: catalog.Workspace, can_fold: bool, expanded: bool) WorkspacePreview {
        var total: usize = 0;
        for (ws.tabs) |tab| total += tab.panes.len;
        const foldable = can_fold and total > 3;
        const limit: usize = if (foldable and !expanded) 3 else std.math.maxInt(usize);
        var remaining: usize = limit;
        var details: usize = 0;
        for (ws.tabs) |tab| {
            if (remaining == 0) break;
            const visible = @min(remaining, tab.panes.len);
            remaining -= visible;
            details += if (tab.panes.len == 1) 1 else 1 + visible;
        }
        const header = 1 + recoveryRows(ws);
        return .{
            .pane_limit = limit,
            .hidden = total -| limit,
            .rows = header + details + @intFromBool(foldable) + 1,
            .toggle_row = if (foldable) header + (if (expanded) @as(usize, 0) else details) else null,
        };
    }
};
fn footerHint(s: *const State) []const u8 {
    return switch (s.step) {
        .presets => if (s.dismissable) "Esc close · ↑↓ choose · P prefix · ? keymap" else "↑↓ choose · P prefix · ? keymap",
        .keymap => "",
        .connect, .progress => "Esc Back",
        .import => if (s.source == .herdr)
            "Esc · Space select · E expand · H handoff"
        else if (s.mode == .import)
            "Esc close · Space select · E expand"
        else
            "Esc Back · Space select · E expand",
        .complete => "",
    };
}
fn recoveryRows(ws: catalog.Workspace) usize {
    return if (ws.recovery == .full) 0 else if (ws.recovery == .workspace) 2 else 1;
}
fn paneAnnotation(source: catalog.Source, handoff: bool, pane: catalog.Pane, buffer: []u8) ![]const u8 {
    if (source == .tmux) return "";
    if (handoff) {
        if (pane.pid) |pid| if (pid > 0) return std.fmt.bufPrint(buffer, "{d:>7} · Herdr → Corgi", .{@as(u32, @intCast(pid))});
        return "      ? · Herdr → Corgi";
    }
    return if (pane.url.len > 0) "↗ Browser link" else if (pane.resume_available) "↻ Resume available" else "+ New shell";
}
fn ghosttyHost() bool {
    return ghostty_integration.available() and os.env("GHOSTTY_RESOURCES_DIR") != null and os.env("CMUX_WORKSPACE_ID") == null;
}
pub fn bounds(cols: u16, rows: u16) Rect {
    const w = @min(cols, 112);
    const h = @min(rows, 36);
    return .{ .x = (cols - w) / 2, .y = (rows - h) / 2, .w = w, .h = h };
}
const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
const text = "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
const bright = "\x1b[1;38;2;226;230;233;48;2;35;40;47m";
const mint = "\x1b[0;38;2;161;194;178;48;2;35;40;47m";
const dim = panel;
const yellow = "\x1b[0;38;2;232;190;115;48;2;35;40;47m";
const keycap = "\x1b[1;38;2;24;27;32;48;2;161;194;178m";
const selected_style = "\x1b[0;38;2;201;224;211;48;2;47;64;59m";

test "onboarding offers only platform-supported presets and import sources" {
    const macos = builtin.os.tag == .macos;
    var state: State = .{};
    defer state.deinit();
    var conn: Connection = undefined; // Preset navigation does not use RPC.
    const presets = try state.frame(100, 34);
    defer a.free(presets);
    try std.testing.expectEqual(macos, std.mem.indexOf(u8, presets, "cmux") != null);
    _ = try state.key('k', &conn);
    try std.testing.expectEqual(if (macos) km.Preset.cmux else .herdr, state.preset);
    _ = try state.key('j', &conn);
    try std.testing.expectEqual(km.Preset.corgi, state.preset);
    _ = try state.key('4', &conn);
    try std.testing.expectEqual(if (macos) km.Preset.cmux else .corgi, state.preset);
    state.step = .import;
    const sources = try state.frame(100, 34);
    defer a.free(sources);
    try std.testing.expectEqual(macos, std.mem.indexOf(u8, sources, "cmux") != null);
    if (!macos) {
        _ = try state.key('3', &conn);
        try std.testing.expectEqual(catalog.Source.tmux, state.source);
        try std.testing.expectError(error.CmuxRequiresMacOS, catalog.Worker.start(.cmux));
    }
}

test "tmux selects at most three recent groups once per discovery" {
    var worker: catalog.Worker = .{ .arena = .init(a), .source = .tmux, .done = .init(true), .catalog = .{ .workspaces = &.{
        .{ .id = "0", .name = "first", .tabs = &.{} },
        .{ .id = "1", .name = "second", .tabs = &.{} },
        .{ .id = "2", .name = "third", .tabs = &.{} },
        .{ .id = "3", .name = "fourth", .tabs = &.{} },
    } } };
    defer worker.arena.deinit();
    var state: State = .{ .step = .import };
    state.workers[0] = &worker;
    state.selectDefaults();
    try std.testing.expectEqualSlices(bool, &.{ true, true, true, false }, state.selected[0..4]);
    state.selected[0] = false;
    state.scan(); // Returning from the preset page must keep manual choices.
    state.selectDefaults();
    try std.testing.expect(!state.selected[0]);
}

test "failed discovery does not claim the source has no sessions" {
    var worker: catalog.Worker = .{
        .arena = .init(a),
        .source = .tmux,
        .done = .init(true),
        .catalog = .{ .message = "FileNotFound" },
    };
    defer worker.arena.deinit();
    var state: State = .{ .step = .import };
    state.workers[0] = &worker;
    const output = try state.frame(76, 26);
    defer a.free(output);
    try std.testing.expect(std.mem.indexOf(u8, output, "Couldn't read this source.") != null);
    try std.testing.expect(std.mem.indexOf(u8, output, "No available sessions found") == null);
}

test "workspace previews keep recovery rows and handoff selection aligned while expanding" {
    const tabs: []const catalog.Tab = &.{
        .{ .id = "t1", .name = "shell", .panes = &.{.{ .id = "1", .name = "one" }} },
        .{ .id = "t2", .name = "split", .panes = &.{
            .{ .id = "2", .name = "two" },  .{ .id = "3", .name = "three" },
            .{ .id = "4", .name = "four" }, .{ .id = "5", .name = "five" },
        } },
        .{ .id = "t3", .name = "hidden-tab", .panes = &.{
            .{ .id = "6", .name = "six" }, .{ .id = "7", .name = "seven" }, .{ .id = "8", .name = "eight" },
        } },
    };
    var worker: catalog.Worker = .{ .arena = .init(a), .source = .herdr, .done = .init(true), .catalog = .{ .workspaces = &.{
        .{ .id = "a", .name = "first", .tabs = tabs, .handoff = true, .session = 0, .recovery = .workspace, .recovery_note = "Recovery note" },
        .{ .id = "b", .name = "second", .tabs = tabs, .handoff = true, .session = 1 },
    } } };
    defer worker.arena.deinit();
    var state: State = .{ .step = .import, .source = .herdr };
    state.workers[1] = &worker;
    var conn: Connection = .{ .fd = -1 }; // Preview controls must not call RPC.
    const initial = try state.frame(76, 26);
    defer a.free(initial);
    try std.testing.expect(std.mem.indexOf(u8, initial, "…5 more") != null);
    try std.testing.expect(std.mem.indexOf(u8, initial, "hidden-tab") == null);
    try std.testing.expect(std.mem.indexOf(u8, initial, "[ ] second") != null);
    _ = try state.sequence("\x1b[6~", &conn);
    const scrolled = try state.frame(76, 26);
    defer a.free(scrolled);
    // The second workspace's fold row is the final visible row after Page Down.
    _ = try state.click(76, 26, 8, 20, &conn);
    try std.testing.expect(state.expanded[1]);
    try std.testing.expect(!state.expanded[0]);
    try std.testing.expectEqual(@as(usize, 0), state.cursor);
    try std.testing.expect(state.chosen(0) and !state.chosen(1));
    const expanded = try state.frame(76, 26);
    defer a.free(expanded);
    try std.testing.expect(std.mem.indexOf(u8, expanded, "Show less") != null);
    try std.testing.expect(std.mem.indexOf(u8, expanded, "hidden-tab") != null);
    // Collapse stays directly under the workspace header, even for long lists.
    _ = try state.click(76, 26, 8, 12, &conn);
    try std.testing.expect(!state.expanded[1]);
    try std.testing.expect(state.chosen(0) and !state.chosen(1));
    const collapsed = try state.frame(76, 26);
    defer a.free(collapsed);
    // The second header remains selectable after collapsing and scroll clamping.
    _ = try state.click(76, 26, 8, 14, &conn);
    try std.testing.expectEqual(@as(usize, 1), state.cursor);
    _ = try state.key('e', &conn);
    try std.testing.expect(state.expanded[1]);
    _ = try state.key('E', &conn);
    try std.testing.expect(!state.expanded[1]);
    try std.testing.expect(!state.chosen(0) and state.chosen(1));
    state.step = .complete;
    state.scroll = 0;
    state.progress.completed = 8;
    const completed = try state.frame(100, 34);
    defer a.free(completed);
    try std.testing.expect(std.mem.indexOf(u8, completed, "✓ eight") != null);
    try std.testing.expect(std.mem.indexOf(u8, completed, "more") == null);
}
fn put(w: *std.Io.Writer, b: Rect, x: usize, y: usize, str: []const u8, style: []const u8) !void {
    if (x >= b.w - 1 or y >= b.h - 1 and y != 0) return;
    try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + x + 1, style });
    try safeText(w, str, b.w - x - 2);
}
fn box(w: *std.Io.Writer, b: Rect, on: bool) !void {
    for (0..b.h) |row| {
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, if (on) selected_style else panel });
        try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
        if (row == 0 or row == b.h - 1) {
            for (0..b.w - 2) |_| try w.writeAll("─");
        } else try w.splatByteAll(' ', b.w - 2);
        try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
    }
}
fn treeLine(w: *std.Io.Writer, b: Rect, row: usize, scroll: usize, label: []const u8, style: []const u8, hint: []const u8) !void {
    if (row < scroll or row - scroll >= b.h - 16) return;
    const y = 11 + row - scroll;
    const split = b.w -| 32;
    try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + 4, style });
    try safeText(w, label, if (hint.len > 0) split - 5 else b.w - 7);
    if (hint.len > 0) try put(w, b, split, y, hint, mint);
}

fn short(value: []const u8) []const u8 {
    var len = @min(value.len, 300);
    while (len > 0 and !std.unicode.utf8ValidateSlice(value[0..len])) len -= 1;
    return value[0..len];
}
fn safeText(w: *std.Io.Writer, value: []const u8, room: usize) !void {
    var clean: [2048]u8 = undefined;
    var n: usize = 0;
    var offset: usize = 0;
    while (offset < value.len and n < clean.len - 4) {
        const len = std.unicode.utf8ByteSequenceLength(value[offset]) catch 1;
        const valid = offset + len <= value.len and std.unicode.utf8ValidateSlice(value[offset..@min(offset + len, value.len)]);
        if (!valid or value[offset] < 32 or value[offset] == 127) {
            clean[n] = ' ';
            n += 1;
            offset += 1;
            continue;
        }
        @memcpy(clean[n .. n + len], value[offset .. offset + len]);
        n += len;
        offset += len;
    }
    try sidebar.writeEllipsis(w, clean[0..n], room);
}

test "keyboard setup saves without chaining and Esc closes it; first run cannot be dismissed" {
    var conn: Connection = undefined; // These keys do not use RPC.
    var first: State = .{};
    defer first.deinit();
    try std.testing.expect(!try first.key(27, &conn));
    var keyboard = State.start(.keyboard, .tmux, .ctrl_a);
    defer keyboard.deinit();
    const frame = try keyboard.frame(100, 34);
    defer a.free(frame);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Welcome") == null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Keyboard shortcuts") != null);
    try std.testing.expect(try keyboard.key(13, &conn));
    try std.testing.expect(!keyboard.cancelled);
    try std.testing.expectEqual(Step.presets, keyboard.step);
    keyboard.cancelled = false;
    try std.testing.expect(try keyboard.key(27, &conn));
    try std.testing.expect(keyboard.cancelled);
}
