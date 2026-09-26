//! A cell-based, viewer-owned wizard. Its bounds depend only on terminal size.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const km = @import("keymap.zig");
const catalog = @import("import_catalog.zig");
const sidebar = @import("sidebar.zig");
const Connection = @import("rpc.zig").Connection;
pub const Step = enum { presets, keymap, connect, import, progress, complete };
pub const Progress = struct { phase: []const u8 = "idle", completed: usize = 0, total: usize = 0, workspace: ?u32 = null, message: []const u8 = "" };
pub const State = struct {
    preset: km.Preset = .corgi,
    prefix: km.Prefix = .ctrl_b,
    step: Step = .presets,
    source: catalog.Source = .tmux,
    workers: [3]?*catalog.Worker = .{ null, null, null },
    selected: [256]bool = @splat(false),
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
    scan_finished: bool = false,
    operation: u64 = 0,
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
        s.operation = 0;
        s.source = source;
        s.cursor = 0;
        s.scroll = 0;
        s.selected = @splat(false);
        s.message_len = 0;
        s.scan();
    }
    fn enterImport(s: *State) void {
        s.step = .import;
        s.focus = 0;
        if (s.workers[0] == null and s.workers[1] == null and s.workers[2] == null) s.source = switch (s.preset) {
            .herdr => .herdr,
            .cmux => .cmux,
            else => .tmux,
        };
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
        if (s.selectionCount() == 0) return true;
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
                const result = try conn.call(.{ .op = "onboarding.copy", .protocol = 1, .operation = s.operation, .source = s.source, .workspaces = selected.items, .herdr_session = s.worker().?.herdr_scan.?.sessions[first], .selected = ids.items });
                result.deinit();
            } else {
                const result = try conn.call(.{ .op = "onboarding.copy", .protocol = 1, .operation = s.operation, .source = s.source, .workspaces = selected.items });
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
        if (s.step == .import) {
            if (!s.scan_finished) if (s.worker()) |w| if (w.done.load(.acquire)) {
                s.scan_finished = true;
                s.cursor = @min(s.cursor, s.items().len -| 1);
                return true;
            };
            return false;
        }
        if (s.step != .progress or std.time.milliTimestamp() - s.last_poll < 100) return false;
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
        if (std.mem.eql(u8, s.progress.phase, "complete")) s.step = .complete;
        return true;
    }
    pub fn key(s: *State, byte: u8, conn: *Connection) !bool {
        s.message_len = 0;
        switch (s.step) {
            .presets => switch (byte) {
                'j', 14 => s.preset = @enumFromInt((@as(usize, @intFromEnum(s.preset)) + 1) % 4),
                'k', 16 => s.preset = @enumFromInt((@as(usize, @intFromEnum(s.preset)) + 3) % 4),
                '1'...'4' => s.preset = @enumFromInt(byte - '1'),
                'p', ' ' => s.prefix = if (s.prefix == .ctrl_b) .ctrl_a else .ctrl_b,
                '?' => {
                    s.step = .keymap;
                    s.scroll = 0;
                },
                9 => s.focus = (s.focus + 1) % 3,
                13 => {
                    if (s.focus == 1) {
                        s.prefix = if (s.prefix == .ctrl_b) .ctrl_a else .ctrl_b;
                    } else if (s.focus == 2) {
                        s.step = .keymap;
                        s.scroll = 0;
                    } else if (s.preset == .cmux) {
                        s.step = .connect;
                    } else s.enterImport();
                },
                else => {},
            },
            .keymap => switch (byte) {
                27, 13, 'q' => s.step = .presets,
                'j', 14 => s.scroll += 1,
                'k', 16 => s.scroll -|= 1,
                else => {},
            },
            .connect => switch (byte) {
                27 => s.step = .presets,
                'p' => {
                    s.preset = .herdr;
                    s.enterImport();
                },
                13 => {
                    if (ghosttyHost()) {
                        try @import("ghostty_integration.zig").setCmux();
                        s.enterImport();
                        s.setMessage("Reload Ghostty: Cmd+Shift+, to apply Command keys.");
                    } else s.setMessage("Press P for portable Herdr prefix keys, or Esc to choose again.");
                },
                else => {},
            },
            .import => switch (byte) {
                's', 'S' => return true,
                27 => s.step = .presets,
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
                9 => s.focus = (s.focus + 1) % 2,
                13 => return s.begin(conn),
                else => {},
            },
            .progress => {
                if (std.mem.eql(u8, s.progress.phase, "failed") and (byte == 27 or byte == 13)) {
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
    pub fn sequence(s: *State, seq: []const u8, conn: *Connection) !bool {
        const up = std.mem.eql(u8, seq, "\x1b[A") or std.mem.eql(u8, seq, "\x1bOA");
        const down = std.mem.eql(u8, seq, "\x1b[B") or std.mem.eql(u8, seq, "\x1bOB");
        if (up or down) return s.key(if (up) 16 else 14, conn);
        if (std.mem.eql(u8, seq, "\x1b[5~")) s.scroll -|= 5;
        if (std.mem.eql(u8, seq, "\x1b[6~")) s.scroll += 5;
        if (s.step == .import and (std.mem.eql(u8, seq, "\x1b[C") or std.mem.eql(u8, seq, "\x1b[D"))) s.changeSource(@enumFromInt((@as(usize, @intFromEnum(s.source)) + if (seq[2] == 'C') @as(usize, 1) else 2) % 3));
        return false;
    }
    pub fn click(s: *State, cols: u16, rows: u16, x: u16, y: u16, conn: *Connection) !bool {
        const b = bounds(cols, rows);
        if (!b.contains(x, y) or b.w < 76 or b.h < 26) return false;
        const rx = x - b.x;
        const ry = y - b.y;
        if (ry == b.h - 3) {
            if (s.step == .presets) s.focus = 0;
            if (rx < 15 and s.step != .presets) return s.key(27, conn);
            return s.key(13, conn);
        }
        if (s.step == .presets) {
            if (rx < 37 and ry >= 6 and ry < 22) {
                s.preset = @enumFromInt((ry - 6) / 4);
                s.focus = 0;
            }
            if (rx >= 40 and ry == 21) return s.key('p', conn);
            if (rx >= 40 and ry == 20) return s.key('?', conn);
        } else if (s.step == .import) {
            if (ry == 6 and rx >= b.w -| 23) return s.key('s', conn);
            if (ry == 6 and rx < 43) return s.key('1' + @as(u8, @intCast(@min(2, rx / 14))), conn);
            if (ry == 8 and s.source == .herdr) return s.key('h', conn);
            if (ry < 11 or ry >= b.h - 5) return false;
            var row: usize = 0;
            for (s.items(), 0..) |ws, i| {
                if (row >= s.scroll and ry == 11 + row - s.scroll) {
                    s.cursor = i;
                    if (!s.activeHandoff()) s.selected[i] = !s.selected[i];
                    break;
                }
                row += 1;
                for (ws.tabs) |tab| row += tabRows(tab);
                row += 1;
            }
        }
        return false;
    }
    pub fn frame(s: *State, cols: u16, rows: u16) ![]u8 {
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
        try put(w, b, 2, 0, " Welcome to Corgi ", mint);
        try put(w, b, 3, 2, switch (s.step) {
            .presets => "Which shortcuts feel like home?",
            .keymap => "Your shortcuts",
            .connect => "Connect your Command keys",
            .import => "Bring your work along",
            .progress => if (s.activeHandoff()) "Handing off to Corgi" else "Copying into Corgi",
            .complete => "You're ready to go",
        }, bright);
        try put(w, b, 3, 3, switch (s.step) {
            .presets => "Choose familiar keys.",
            .keymap => "Prefix, then the key shown. PgUp / PgDn scroll.",
            .connect => "Your host terminal needs to forward these shortcuts.",
            .import => if (s.source == .tmux) "Copy sessions, named windows and layouts. Source processes stay in tmux." else if (s.source == .herdr) "Choose a session to bring into Corgi." else "Copy workspaces and surfaces. Source processes stay in cmux.",
            .progress => s.progress.message,
            .complete => if (s.activeHandoff()) "Your processes are running in Corgi." else "Your workspaces are ready.",
        }, dim);
        switch (s.step) {
            .presets => {
                for (std.enums.values(km.Preset), 0..) |preset, i| {
                    const picked = s.preset == preset;
                    const card = @import("layout.zig").Rect{ .x = b.x + 3, .y = b.y + 6 + @as(u16, @intCast(i)) * 4, .w = 32, .h = 4 };
                    try box(w, card, picked);
                    var buf: [80]u8 = undefined;
                    const label = try std.fmt.bufPrint(&buf, "{s} {s}{s}", .{ if (picked) "●" else "○", if (preset == .corgi) "🐕 " else "", km.name(preset) });
                    try put(w, card, 2, 1, label, if (picked) selected_style else bright);
                    try put(w, card, 4, 2, km.description(preset), if (picked) selected_style else dim);
                }
                var buf: [120]u8 = undefined;
                try put(w, b, 39, 6, try std.fmt.bufPrint(&buf, "{s} keys", .{km.name(s.preset)}), mint);
                const labels = [_][]const u8{ "New tab → agent picker", "Split right / down", "Focus pane", "Next / previous tab", "Scroll / copy", "Detach" };
                const keys: [6][]const u8 = switch (s.preset) {
                    .tmux => .{ "c", "% / \"", "← ↓ ↑ →", "n / p", "[", "d" },
                    .herdr => .{ "c", "v / -", "h j k l", "n / p", "[", "q" },
                    .cmux => .{ "Cmd+T", "Cmd+D / Cmd+Shift+D", "Cmd+Option+arrows", "Cmd+Shift+] / [", "Cmd+Shift+M", "Prefix q" },
                    .corgi => .{ "c", "v / -", "h j k l", "n / p", "s", "q" },
                };
                for (labels, keys, 0..) |label, shortcut_key, i| {
                    try put(w, b, 39, 8 + i * 2, label, text);
                    try put(w, b, @min(b.w - 25, 68), 9 + i * 2, shortcut_key, mint);
                }
                try put(w, b, 39, 21, try std.fmt.bufPrint(&buf, "Prefix [ {s} ]  P change", .{if (s.prefix == .ctrl_b) "Ctrl+B" else "Ctrl+A"}), if (s.focus == 1) bright else mint);
                try put(w, b, 39, 22, "Press twice to send it through.", dim);
                try put(w, b, 39, 20, "[ ? Full keymap ]", if (s.focus == 2) bright else mint);
            },
            .keymap => {
                const direct = km.extraHints(s.preset);
                const entries = @import("commands.zig").presetEntries(s.preset);
                const total = direct.len + entries.len;
                s.scroll = @min(s.scroll, total -| (b.h - 10));
                var line: usize = 0;
                for (direct) |hint| {
                    defer line += 1;
                    if (line < s.scroll or line - s.scroll >= b.h - 10) continue;
                    try put(w, b, 5, 6 + line - s.scroll, hint, mint);
                }
                for (entries) |entry| {
                    const shortcut_key = entry.key;
                    defer line += 1;
                    if (line < s.scroll or line - s.scroll >= b.h - 10) continue;
                    var buf: [100]u8 = undefined;
                    try put(w, b, 5, 6 + line - s.scroll, try std.fmt.bufPrint(&buf, "{s} {s}   {s}", .{ if (s.prefix == .ctrl_b) "Ctrl+B" else "Ctrl+A", if (shortcut_key == 9) "Tab" else &.{shortcut_key}, entry.label }), text);
                }
            },
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
                    for ([_]catalog.Source{ .tmux, .herdr, .cmux }, 0..) |source, i| {
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
                    } else try put(w, b, 3, 8, if (s.source == .cmux) "Surfaces become tabs · browser links are saved" else "Names, folders and split layout · new shells", dim);
                } else {
                    var buf: [120]u8 = undefined;
                    try put(w, b, 3, 6, try std.fmt.bufPrint(&buf, "{s}  {d}/{d}", .{ s.progress.phase, s.progress.completed, s.progress.total }), mint);
                    try put(w, b, 3, 8, if (s.step == .complete) "[✓] Complete" else if (std.mem.eql(u8, s.progress.phase, "failed")) "[!] Import stopped · Enter returns to selection" else "[···] Working", bright);
                }
                if (s.worker()) |wk| {
                    if (!wk.done.load(.acquire)) try put(w, b, 5, 12, "Looking for running sessions…", dim) else if (s.items().len == 0) {
                        try put(w, b, 5, 12, "No available sessions found. Continue without importing.", text);
                        try put(w, b, 5, 14, wk.catalog.message, dim);
                    }
                }
                var row: usize = 0;
                var cursor_row: usize = 0;
                for (s.items(), 0..) |ws, i| {
                    if (s.step != .import and !s.chosen(i)) continue;
                    if (i == s.cursor) cursor_row = row;
                    row += 2;
                    for (ws.tabs) |tab| row += tabRows(tab);
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
                    var buf: [1024]u8 = undefined;
                    try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "{s}{s} {s}", .{ if (i == s.cursor and s.step == .import) "›" else " ", if (s.chosen(i)) "[x]" else "[ ]", short(ws.name) }), mint, "");
                    row += 1;
                    for (ws.tabs, 0..) |tab, tab_index| {
                        const last_tab = tab_index + 1 == ws.tabs.len;
                        const branch: []const u8 = if (last_tab) "└─" else "├─";
                        if (tab.panes.len == 1) {
                            const pane = tab.panes[0];
                            var hint: [120]u8 = undefined;
                            const done = s.step != .import and pane_number < s.progress.completed;
                            try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    {s} {s} · {s}{s}", .{ branch, short(tab.name), if (done) "✓ " else "", short(pane.name) }), text, try paneAnnotation(s.activeHandoff(), pane, &hint));
                            row += 1;
                            pane_number += 1;
                            continue;
                        }
                        try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    {s} {s}", .{ branch, short(tab.name) }), text, "");
                        row += 1;
                        for (tab.panes, 0..) |pane, pane_index| {
                            var hint: [120]u8 = undefined;
                            const annotation = try paneAnnotation(s.activeHandoff(), pane, &hint);
                            try treeLine(w, b, row, s.scroll, try std.fmt.bufPrint(&buf, "    {s}  {s} {s}{s}", .{ if (last_tab) " " else "│", if (pane_index + 1 == tab.panes.len) "└─" else "├─", if (s.step != .import and pane_number < s.progress.completed) "✓ " else "", short(pane.name) }), text, annotation);
                            row += 1;
                            pane_number += 1;
                        }
                    }
                    row += 1;
                }
            },
        }
        if (s.message_len > 0) try put(w, b, 3, b.h - 5, s.message[0..s.message_len], yellow);
        try put(w, b, 3, b.h - 3, if (s.step == .presets) "↑↓ choose · P prefix · ? keymap" else if (s.step == .import) if (s.source == .herdr) "Esc Back · Space select · H handoff" else "Esc Back · Space select" else if (s.step == .complete) "" else "Esc Back", dim);
        const cta: []const u8 = switch (s.step) {
            .presets => "[ Enter Continue → ]",
            .keymap => "[ Enter Back ]",
            .connect => "[ Enter Connect → ]",
            .import => if (s.selectionCount() == 0) "[ Enter Skip import → ]" else if (s.activeHandoff()) "[ Enter Handoff → ]" else "[ Enter Import → ]",
            .progress => if (std.mem.eql(u8, s.progress.phase, "failed")) "[ Enter Back ]" else "[ Importing… ]",
            .complete => "[ Enter Open Corgi → ]",
        };
        try put(w, b, b.w -| 27, b.h - 3, cta, mint);
        try put(w, b, 3, b.h - 2, if (s.step == .import) "←→ sources · ↑↓ choose · PgUp/PgDn scroll · R refresh · S skip" else "", dim);
        try w.writeAll("\x1b[0m");
        return out.toOwnedSlice();
    }
};
fn tabRows(tab: catalog.Tab) usize {
    return if (tab.panes.len == 1) 1 else 1 + tab.panes.len;
}
fn paneAnnotation(handoff: bool, pane: catalog.Pane, buffer: []u8) ![]const u8 {
    if (handoff) {
        if (pane.pid) |pid| if (pid > 0) return std.fmt.bufPrint(buffer, "{d:>7} · Herdr → Corgi", .{@as(u32, @intCast(pid))});
        return "      ? · Herdr → Corgi";
    }
    return if (pane.url.len > 0) "↗ Browser link" else if (pane.resume_available) "↻ Resume available" else "+ New shell";
}
fn ghosttyHost() bool {
    return @import("ghostty_integration.zig").available() and os.env("GHOSTTY_RESOURCES_DIR") != null and os.env("CMUX_WORKSPACE_ID") == null;
}
pub fn bounds(cols: u16, rows: u16) @import("layout.zig").Rect {
    const w = @min(cols, 112);
    const h = @min(rows, 32);
    return .{ .x = (cols - w) / 2, .y = (rows - h) / 2, .w = w, .h = h };
}
const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
const text = "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
const bright = "\x1b[1;38;2;226;230;233;48;2;35;40;47m";
const mint = "\x1b[0;38;2;161;194;178;48;2;35;40;47m";
const dim = panel;
const yellow = "\x1b[0;38;2;232;190;115;48;2;35;40;47m";
const selected_style = "\x1b[0;38;2;201;224;211;48;2;47;64;59m";
fn put(w: *std.Io.Writer, b: @import("layout.zig").Rect, x: usize, y: usize, str: []const u8, style: []const u8) !void {
    if (x >= b.w - 1 or y >= b.h - 1 and y != 0) return;
    try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + x + 1, style });
    try safeText(w, str, b.w - x - 2);
}
fn box(w: *std.Io.Writer, b: @import("layout.zig").Rect, on: bool) !void {
    for (0..b.h) |row| {
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, if (on) selected_style else panel });
        try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
        if (row == 0 or row == b.h - 1) {
            for (0..b.w - 2) |_| try w.writeAll("─");
        } else try w.splatByteAll(' ', b.w - 2);
        try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
    }
}
fn treeLine(w: *std.Io.Writer, b: @import("layout.zig").Rect, row: usize, scroll: usize, label: []const u8, style: []const u8, hint: []const u8) !void {
    if (row < scroll or row - scroll >= b.h - 16) return;
    const y = 11 + row - scroll;
    const split = b.w -| 32;
    try w.print("\x1b[{d};{d}H{s}", .{ b.y + y + 1, b.x + 4, style });
    try safeText(w, label, split - 5);
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
