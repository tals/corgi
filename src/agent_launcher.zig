//! The agent launcher popover: rows, keys, hit areas and drawing. The daemon
//! fills `launch_preview.Preview`; this file only shows it, and the shared
//! runtime remembers the choice.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const providers = @import("providers.zig");
pub const Provider = providers.Provider;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const name_dialog = @import("name_dialog.zig");
const launch_command = @import("launch.zig").command;
const sidebar = @import("sidebar.zig");
const layout = @import("layout.zig");
const Terminal = @import("pane.zig").Terminal;
const Path = @import("bounded_text.zig").Path;
const metadata = @import("usage.zig").account;
const usage_cell = @import("launcher_usage.zig");
const launch_preview = @import("launch.zig").preview;
const launch_history = @import("launch.zig").history;
const History = launch_history.History;
const launcher_resume = @import("launcher_resume.zig");
const writeKey = launcher_resume.writeKey;
const palette = @import("palette.zig");
const Text = metadata.Text;
const Option = launch_preview.Option;
const Preview = launch_preview.Preview;
/// Launcher rows: one per provider, then saved commands and a plain terminal.
pub const Row = enum {
    codex,
    claude,
    custom0,
    custom1,
    custom2,
    custom3,
    custom4,
    custom5,
    terminal,
    add,
    manage,
    pub fn of(provider: Provider) Row {
        return @enumFromInt(@intFromEnum(provider));
    }
    pub fn custom(row: Row) ?usize {
        const i = @intFromEnum(row);
        return if (i >= @intFromEnum(Row.custom0) and i <= @intFromEnum(Row.custom5)) i - @intFromEnum(Row.custom0) else null;
    }
    pub fn agent(row: Row) ?Provider {
        const i = @intFromEnum(row);
        return if (i < Provider.all.len) @enumFromInt(i) else null;
    }
    comptime {
        for (Provider.all) |provider| std.debug.assert(std.mem.eql(u8, @tagName(provider), @tagName(Row.of(provider))));
    }
};
/// The agent a launcher key starts.
pub fn keyAgent(byte: u8) ?Provider {
    for (Provider.all) |provider| if (provider.info().launcher_key == byte) return provider;
    return null;
}
pub const Menu = struct {
    workspace: WorkspaceId,
    cwd: Path = .{},
    /// The workspace's default folder, for the conversations' workspace scope.
    workspace_cwd: Path = .{},
    resume_view: launcher_resume.View = .{},
    history: History = .{},
    /// Conversations panes run now, which the list jumps to instead.
    open: [launcher_resume.max_open]launcher_resume.Open = undefined,
    open_count: usize = 0,
    selected: Row,
    yolo: providers.Each(bool, false) = .{},
    hidden: providers.Each(bool, false) = .{},
    managing: bool = false,
    editor: name_dialog.Dialog = .{ .target = .{ .agent_command = 0 }, .selected = false },
    name_editor: name_dialog.Dialog = .{ .target = .{ .rename = @enumFromInt(0) }, .selected = false },
    name_focused: bool = false,
    show_command: bool = false,
    name_customized: bool = false,
    edit_index: ?usize = null,
    edit_provider: ?Provider = null,
    save_error: Text = .{},
    draft: launch_command.Entry = .{},
    draft_changed: i64 = 0,
    request_id: u32 = 0,
    resolution_checked: i64 = 0,
    resolution: launch_command.Resolution = .{},
    save_requested: bool = false,
    commands: [launch_command.capacity]launch_command.Entry = @splat(.{}),
    last: Provider,
    pinned: bool,
    /// The prefix arrived while pinned. Cmd+T sends the prefix and `c`, so a
    /// repeat is ignored instead of read as a launcher key.
    prefix: bool = false,
    preview: Preview = .{},
    const headings = [_][]const u8{ "Agent", "YOLO", "Model", "Account", "Plan", "Usage (used) · resets in" };
    /// The text columns; `usageCell` draws the last one.
    fn cells(m: *const Menu, provider: Provider) [5][]const u8 {
        const option = m.preview.options.getPtrConst(provider);
        return .{
            provider.info().label,
            if (m.yolo.get(provider)) "✓" else "·",
            if (option.model.len > 0) option.model.text() else if (m.preview.pending) "Reading…" else "Default",
            if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading…" else "Unavailable",
            if (option.plan.len > 0) option.plan.text() else if (m.preview.pending) "…" else "Unknown",
        };
    }
    fn customCells(m: *const Menu, index: usize) [5][]const u8 {
        const entry = &m.commands[index];
        const info = &entry.semantics;
        const shared = if (info.default_account) info.provider else null;
        var values: [5][]const u8 = if (shared) |provider| m.cells(provider) else .{ "", "", "Default", "", "—" };
        values[0] = entry.label();
        values[1] = if (info.yolo) "✓" else "·";
        if (info.model.len > 0) values[2] = info.model.text();
        values[3] = m.account(info);
        return values;
    }
    fn usageCell(m: *const Menu, row: Row) usage_cell.Cell {
        const provider = row.agent() orelse if (row.custom()) |i| blk: {
            const info = m.commands[i].semantics;
            break :blk if (info.default_account) info.provider else null;
        } else null;
        const p = provider orelse return .status("—");
        const option = m.preview.options.getPtrConst(p);
        // Built-in rows offer an actionable "Track usage" link instead; saved
        // commands sharing that provider show unavailable data (no action).
        if (m.trackable(.of(p))) return if (row.custom() == null) .status("Track usage") else unavailableCell(option);
        const now = os.timestamp();
        return switch (option.limits) {
            .none => if (m.preview.pending) .status("Reading…") else unavailableCell(option),
            .metered => .status("Metered"),
            .rate_limited => unavailableCell(option),
            .windows => |windows| if (metadata.expired(option.usage_fetched_at, now)) unavailableCell(option) else .init(windows, now),
        };
    }
    fn unavailableCell(option: *const Option) usage_cell.Cell {
        const reason = if (option.usage_error.len > 0)
            option.usage_error.text()
        else if (option.usage_fetched_at > 0)
            "last success 10m+ ago"
        else
            "no usage received";
        return .unavailable(reason);
    }
    /// Management includes unavailable providers so preferences stay editable.
    pub fn shown(m: *const Menu, row: Row) bool {
        // Outside management, Manage is the title's button.
        if (row == .manage) return m.managing;
        if (row == .add) return m.managing;
        if (row.custom()) |index| return m.commands[index].command.len > 0 and (m.managing or !m.commands[index].hidden);
        if (row == .terminal) return !m.managing;
        if (m.managing) return true;
        const provider = row.agent().?;
        return m.preview.installed.get(provider) and !m.hidden.get(provider) and m.preview.options.get(provider).signed_in != false;
    }
    pub fn emptyCommand(m: *const Menu) ?usize {
        for (m.commands, 0..) |entry, i| if (entry.command.len == 0) return i;
        return null;
    }
    pub fn countRows(m: *const Menu) usize {
        return m.count() - 2;
    }
    fn count(m: *const Menu) usize {
        var n: usize = 0;
        for (std.enums.values(Row)) |row| n += @intFromBool(m.shown(row));
        return n;
    }
    fn rowAt(m: *const Menu, index: usize) ?Row {
        var n: usize = 0;
        for (std.enums.values(Row)) |row| if (m.shown(row)) {
            if (n == index) return row;
            n += 1;
        };
        return null;
    }
    fn position(m: *const Menu, row: Row) usize {
        var n: usize = 0;
        for (std.enums.values(Row)) |candidate| {
            if (candidate == row) return n;
            n += @intFromBool(m.shown(candidate));
        }
        return n;
    }
    /// Keep the selection on a visible row after the installed set changes.
    pub fn normalize(m: *Menu) void {
        if (!m.shown(m.selected)) m.selected = m.rowAt(0).?;
    }
    pub fn first(m: *const Menu) Row {
        return m.rowAt(0).?;
    }
    pub fn lastRow(m: *const Menu) Row {
        return m.rowAt(m.count() - 1).?;
    }
    /// Digits enumerate visible agents only, matching the picker keycaps.
    pub fn shortcutRow(m: *const Menu, key: u8) ?Row {
        if (m.managing or key < '0' or key > '9') return null;
        const row = m.rowAt(key - '0') orelse return null;
        return if (row.agent() != null or row.custom() != null) row else null;
    }
    pub fn move(m: *Menu, next: bool, wrap: bool) void {
        m.normalize();
        const n = m.count();
        const index = m.position(m.selected);
        m.selected = m.rowAt(if (wrap)
            (if (next) index + 1 else index + n - 1) % n
        else if (next) @min(index + 1, n - 1) else index -| 1).?;
    }
    /// Rows the menu needs: border, headings, agent rows and a gap, the
    /// conversations and a gap, footer and border.
    fn rowsHeight(m: *const Menu) u16 {
        if (m.managing) return @intCast(m.count() + 20);
        const conversations: usize = if (!m.hasResume()) 0 else if (m.resume_view.expanded) 8 else m.resume_view.collapsedHeight(m.resumeContext()) + 1;
        return @intCast(5 + m.count() + conversations);
    }
    pub fn bounds(m: *const Menu, cols: u16, rows: u16, side: sidebar.View) layout.Rect {
        var content: u16 = 4;
        for (m.columnSizes().preferred) |width| content += width;
        var width = @min(cols, if (m.managing) @as(u16, 82) else @max(@as(u16, if (m.hasResume()) 80 else 40), content));
        var height = @min(rows, m.rowsHeight());
        // Expanded conversations take the room a table of them needs.
        if (m.resume_view.expanded and m.hasResume()) {
            width = @max(width, @min(cols, 104));
            height = @min(rows, @max(30, height));
        }
        return .{ .x = @min(side.width -| 10, cols - width), .y = @min(side.middle() + 1, rows - height), .w = width, .h = height };
    }
    fn columnSizes(m: *const Menu) struct { preferred: [6]u16, usage_minimum: u16 } {
        var widths: [6]u16 = undefined;
        for (headings, &widths) |heading, *size| size.* = @intCast(sidebar.displayWidth(heading));
        var usage_minimum = widths[5];
        for (std.enums.values(Row)) |row| {
            if (!m.shown(row) or (row.agent() == null and row.custom() == null)) continue;
            const values = if (row.custom()) |i| m.customCells(i) else m.cells(row.agent().?);
            for (values, widths[0..5]) |text, *size| size.* = @max(size.*, @as(u16, @intCast(sidebar.displayWidth(text))));
            const cell = m.usageCell(row);
            widths[5] = @max(widths[5], @as(u16, @intCast(cell.preferredWidth())));
            usage_minimum = @max(usage_minimum, @as(u16, @intCast(cell.minimumWidth())));
        }
        for (&widths, 0..) |*size, column| size.* += if (column == 5) 1 else 2;
        widths[0] += 4; // Left shortcut keycap and its following space.
        return .{ .preferred = widths, .usage_minimum = usage_minimum + 1 };
    }
    fn columns(m: *const Menu, width: u16) [6]u16 {
        const sizes = m.columnSizes();
        var widths = sizes.preferred;
        const available = width -| 4;
        var minimum = [_]u16{ 17, 6, 9, 18, 6, sizes.usage_minimum };
        if (width < 64) {
            widths[1] = 3; // A one-cell Y heading and toggle, plus its gutter.
            minimum[1] = 3;
        }
        // Give up metadata columns before truncating reported limits and resets.
        for ([_]usize{ 3, 2, 4 }) |column| {
            var needed: u16 = 0;
            for (minimum, widths) |size, preferred| needed += @min(size, preferred);
            if (needed <= available) break;
            widths[column] = 0;
            minimum[column] = 0;
        }
        var total: u16 = 0;
        for (widths) |size| total += size;
        while (total > available) : (total -= 1) {
            // Remove spare space from the most oversized column first. Keep
            // headings readable until even their minimum widths cannot fit.
            var largest: usize = 0;
            for (widths, 0..) |size, i| {
                if (size -| minimum[i] > widths[largest] -| minimum[largest]) largest = i;
            }
            if (widths[largest] <= minimum[largest]) {
                for (widths, 0..) |size, i| if (size > widths[largest]) {
                    largest = i;
                };
            }
            widths[largest] -= 1;
        }
        return widths;
    }
    pub fn hit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) ?Row {
        const b = m.bounds(cols, rows, side);
        if (m.managing) {
            if (x <= b.x or x >= b.x + b.w - 1) return null;
            const n = m.count() - 2;
            if (y >= b.y + 4 and y < b.y + 4 + n) return m.rowAt(y - b.y - 4);
            if (y >= b.y + n + 5 and y <= b.y + n + 17 + @as(u16, if (m.show_command) 2 else 0)) return .add;
            if (y == b.y + b.h - 2 and x >= b.x + b.w -| 10) return .manage;
            return null;
        }
        if (x <= b.x or x >= b.x + b.w - 1 or y < b.y + 2) return null;
        const index = y - b.y - 2;
        return if (index < m.count()) m.rowAt(index) else null;
    }
    fn providerHit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) ?Provider {
        if (m.managing) return null;
        return (m.hit(cols, rows, side, x, y) orelse return null).agent();
    }
    pub fn yoloHit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0];
        return if (x >= start and x < start + widths[1] -| 2) provider else null;
    }
    pub fn trackable(m: *const Menu, row: Row) bool {
        if (m.managing) return false;
        const provider = row.agent() orelse return false;
        return !m.preview.pending and m.preview.options.get(provider).usage_needs_consent;
    }
    pub fn usageHit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
        return if (x >= start and x < start + widths[5] -| 1) provider else null;
    }
    pub fn resumeContext(m: *const Menu) launcher_resume.Context {
        return .{
            .history = m.history,
            .folder = m.cwd.text(),
            .workspace_folder = m.workspace_cwd.text(),
            .open = m.open[0..m.open_count],
            .now = os.timestamp(),
        };
    }
    /// Whether conversations show: once the daemon has sent some. A first
    /// read takes seconds; the menu does not wait on it or show a placeholder.
    pub fn hasResume(m: *const Menu) bool {
        return !m.managing and m.history.entries.len > 0;
    }
    /// The terminal row the conversations start on, a gap below the agents.
    fn resumeTop(m: *const Menu, b: layout.Rect) u16 {
        return b.y + 4 + @as(u16, @intCast(m.count()));
    }
    pub fn resumeArea(m: *const Menu, cols: u16, rows: u16, side: sidebar.View) launcher_resume.Area {
        const b = m.bounds(cols, rows, side);
        const top = m.resumeTop(b);
        return .{ .x = b.x + 1, .y = top, .width = b.w, .height = (b.y + b.h - 1) -| top };
    }
    /// The conversation row or scope under a pointer, in 0-based cells.
    pub fn resumeHit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) ?launcher_resume.View.Hit {
        if (!m.hasResume()) return null;
        const b = m.bounds(cols, rows, side);
        if (x <= b.x or x >= b.x + b.w - 1) return null;
        if (m.resume_view.expanded) return m.resume_view.hit(m.resumeContext(), m.resumeArea(cols, rows, side), x + 1, y + 1);
        // Below the collapsed list's heading.
        const lines_top = m.resumeTop(b) + 1;
        if (y + 1 < lines_top) return null;
        return if (m.resume_view.collapsedHit(m.resumeContext(), y + 1 - lines_top)) |row| .{ .row = row } else null;
    }
    const manage_label = " Manage agents ";
    /// The title's Manage button, ` m  Manage agents `, in 0-based cells;
    /// null when the menu is too narrow for it.
    fn manageSpan(b: layout.Rect) ?struct { x: u16, w: u16 } {
        const width: u16 = 1 + 3 + manage_label.len;
        if (b.w < width + 18) return null;
        return .{ .x = b.x + b.w - 2 - width, .w = width };
    }
    pub fn manageHit(m: *const Menu, cols: u16, rows: u16, side: sidebar.View, x: u16, y: u16) bool {
        if (m.managing) return false;
        const b = m.bounds(cols, rows, side);
        const span = manageSpan(b) orelse return false;
        return y == b.y and x >= span.x and x < span.x + span.w;
    }
    fn drawTitle(w: *std.Io.Writer, b: layout.Rect, panel: []const u8) !void {
        try w.print("\x1b[{d};{d}H\x1b[1m" ++ palette.fg(.strong) ++ " New agent {s}", .{ b.y + 1, b.x + 3, panel });
        const span = manageSpan(b) orelse return;
        // Like a footer hint: a keycap, then a faint label.
        try w.print("\x1b[{d};{d}H{s} ", .{ b.y + 1, span.x + 1, panel });
        try writeKey(w, "m", panel);
        try w.writeAll(manage_label);
    }
    const Hint = struct { key: []const u8, label: []const u8 };
    fn drawFooter(w: *std.Io.Writer, b: layout.Rect, panel: []const u8, cwd: []const u8, what: []const u8, hints: []const Hint) !void {
        var hint_width: u16 = 0;
        for (hints, 0..) |hint, i| hint_width += @intCast(sidebar.displayWidth(hint.key) + 2 + 1 + hint.label.len + @as(usize, if (i > 0) 2 else 0));
        const footer_row = b.y + b.h - 1;
        try w.print("\x1b[{d};{d}H{s}", .{ footer_row, b.x + 3, panel });
        const directory = std.fs.path.basename(cwd);
        var buffer: [std.fs.max_path_bytes + 32]u8 = undefined;
        const footer = try std.fmt.bufPrint(&buffer, "{s} · {s}", .{ directory, what });
        try sidebar.writeEllipsis(w, footer, b.w -| (hint_width + 6));
        try w.print("\x1b[{d};{d}H", .{ footer_row, b.x + b.w - 1 - hint_width });
        for (hints, 0..) |hint, i| {
            if (i > 0) try w.writeAll("  ");
            try writeKey(w, hint.key, panel);
            try w.print(" {s}", .{hint.label});
        }
    }
    pub fn edit(m: *Menu, row: Row) void {
        m.draft = .{};
        m.request_id = 0;
        m.resolution = .{};
        m.save_requested = false;
        m.edit_index = row.custom();
        m.edit_provider = row.agent();
        const source = if (m.edit_index) |i| m.commands[i].inputText() else if (m.edit_provider) |provider| @tagName(provider) else "";
        m.editor = name_dialog.Dialog.init(.{ .agent_command = 0 }, source);
        m.name_focused = false;
        m.show_command = false;
        m.name_customized = m.edit_index != null;
        m.name_editor = name_dialog.Dialog.init(.{ .rename = @enumFromInt(0) }, if (m.edit_index) |i| m.commands[i].label() else "");
        if (m.edit_index) |i| {
            m.draft.set(source) catch {};
            m.resolution = .{ .pending = false, .command = m.commands[i], .semantics = m.commands[i].semantics };
        }
        m.selected = .add;
        m.pinned = true;
    }
    pub fn input(m: *Menu) *name_dialog.Dialog {
        return if (m.name_focused) &m.name_editor else &m.editor;
    }
    fn account(m: *const Menu, info: *const launch_command.Semantics) []const u8 {
        if (info.account.len > 0) return info.account.text();
        if (info.default_account) if (info.provider) |provider| {
            const option = m.preview.options.getPtrConst(provider);
            return if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading default account…" else "Default account · unavailable";
        };
        return "Account unknown";
    }
    fn drawInput(w: *std.Io.Writer, editor: name_dialog.Dialog, placeholder: []const u8, x: u16, y: usize, width: u16, focused: bool) !void {
        var offset = editor.cursor -| (width -| 1);
        while (offset < editor.cursor and editor.text[offset] & 0xc0 == 0x80) offset += 1;
        const end = editor.byteAtColumn(offset, width);
        try w.print("\x1b[{d};{d}H" ++ palette.bg(.selected), .{ y, x });
        try w.splatByteAll(' ', width);
        try w.print("\x1b[{d};{d}H", .{ y, x });
        if (editor.len == 0) try sidebar.writeEllipsis(w, placeholder, width) else {
            if (focused and editor.selected) try w.writeAll("\x1b[7m");
            for (editor.text[offset..end]) |ch| try w.writeByte(if (ch < 32 or ch == 127) ' ' else ch);
        }
        try w.writeAll((palette.Style{ .fg = .text, .bg = .surface }).sgr());
    }
    fn drawManager(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: sidebar.View) !void {
        const b = m.bounds(cols, rows, side);
        if (b.w < 40 or b.h < m.rowsHeight()) return;
        const panel = (palette.Style{ .fg = .text, .bg = .surface }).sgr();
        const rule = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
        for (0..b.h) |y| {
            try w.print("\x1b[{d};{d}H{s}{s}", .{ b.y + y + 1, b.x + 1, rule, if (y == 0) "╭" else if (y == b.h - 1) "╰" else "│" });
            if (y == 0 or y == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (y == 0) "╮" else if (y == b.h - 1) "╯" else "│");
        }
        try w.print("\x1b[{d};{d}H{s} Manage agents ", .{ b.y + 1, b.x + 3, panel });
        const name_width: u16 = @min(24, b.w / 3);
        const command_x = b.x + 10 + name_width;
        try w.print("\x1b[{d};{d}HShow\x1b[{d};{d}HAgent\x1b[{d};{d}HAccount", .{ b.y + 3, b.x + 4, b.y + 3, b.x + 10, b.y + 3, command_x });
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 4, b.x + 4, rule });
        for (0..b.w - 6) |_| try w.writeAll("─");
        try w.writeAll(panel);
        const n = m.count() - 2;
        for (0..n) |i| {
            const row = m.rowAt(i).?;
            const custom = row.custom();
            const hidden = if (custom) |index| m.commands[index].hidden else m.hidden.get(row.agent().?);
            const label = if (custom) |index| m.commands[index].label() else row.agent().?.info().label;
            const info = if (custom) |index| m.commands[index].semantics else launch_command.Semantics{ .provider = row.agent().?, .default_account = true };
            const source = m.account(&info);
            try w.print("\x1b[{d};{d}H{s} [{s}]\x1b[{d};{d}H", .{ b.y + 5 + i, b.x + 2, if (m.selected == row) "›" else " ", if (hidden) " " else "✓", b.y + 5 + i, b.x + 10 });
            try sidebar.writeEllipsis(w, label, name_width - 2);
            try w.print("\x1b[{d};{d}H", .{ b.y + 5 + i, command_x });
            var clean: [2048]u8 = undefined;
            for (source, 0..) |ch, j| clean[j] = if (ch < 32 or ch == 127) ' ' else ch;
            try sidebar.writeEllipsis(w, clean[0..source.len], b.x + b.w -| 19 -| command_x);
            try w.print("\x1b[{d};{d}H[Edit]", .{ b.y + 5 + i, b.x + b.w - 17 });
            if (custom != null) try w.print("\x1b[{d};{d}H[Delete]", .{ b.y + 5 + i, b.x + b.w - 10 });
        }
        const field_y = b.y + n + 6;
        const input_x = b.x + 5;
        const width = b.w -| 10;
        const dim = palette.fg(.faint);
        for (0..2) |i| {
            const top = field_y + i * 4;
            const focused = m.selected == .add and m.name_focused == (i == 1);
            try w.print("\x1b[{d};{d}H{s}{s}", .{ top, b.x + 4, dim, if (i == 0) "Command" else "Name" });
            const border = if (focused) palette.fg(.accent) else palette.fg(.line);
            for (0..3) |line| {
                try w.print("\x1b[{d};{d}H{s}{s}", .{ top + line + 1, b.x + 4, border, if (line == 0) "┌" else if (line == 2) "└" else "│" });
                if (line != 1) {
                    for (0..width + 2) |_| try w.writeAll("─");
                } else try w.splatByteAll(' ', width + 2);
                try w.writeAll(if (line == 0) "┐" else if (line == 2) "┘" else "│");
            }
            try w.writeAll(panel);
            try drawInput(w, if (i == 0) m.editor else m.name_editor, if (i == 0) "Paste a command…" else "Suggested automatically", input_x + 1, top + 2, width, focused);
        }
        if (m.editor.len > 0) {
            const matches = std.mem.eql(u8, m.draft.text(), m.editor.name());
            const resolved = matches and !m.resolution.pending and m.resolution.error_message.len == 0;
            const status = if (m.editor.failed and m.save_error.len > 0)
                m.save_error.text()
            else if (m.editor.overflow)
                "Command too long"
            else if (!matches or m.resolution.pending)
                "Resolving command…"
            else if (m.resolution.error_message.len > 0)
                m.resolution.error_message.text()
            else
                m.account(&m.resolution.semantics);
            try w.print("\x1b[{d};{d}H", .{ field_y + 9, b.x + 4 });
            var summary: [512]u8 = undefined;
            const info = &m.resolution.semantics;
            const provider = if (info.provider) |known| known.info().label else "Custom agent";
            try sidebar.writeEllipsis(w, if (resolved) std.fmt.bufPrint(&summary, "{s} · {s}", .{ provider, status }) catch status else status, b.w - 8);
            try w.print("\x1b[{d};{d}H{s}", .{ field_y + 10, b.x + 4, dim });
            if (resolved) {
                var detail: [340]u8 = undefined;
                const mode = if (info.yolo) info.mode.text() else "";
                const text = std.fmt.bufPrint(&detail, "{s}{s}{s}", .{ info.model.text(), if (info.model.len > 0 and mode.len > 0) " · " else "", mode }) catch "";
                try sidebar.writeEllipsis(w, text, b.w - 26);
                try w.print("\x1b[{d};{d}H[{s} command]", .{ field_y + 10, b.x + b.w - 17, if (m.show_command) "Hide" else "Show" });
                if (m.show_command) {
                    try w.print("\x1b[{d};{d}HRuns: ", .{ field_y + 12, b.x + 4 });
                    var clean: [2048]u8 = undefined;
                    const source = m.resolution.command.text();
                    for (source, 0..) |ch, j| clean[j] = if (ch < 32 or ch == 127) ' ' else ch;
                    try sidebar.writeEllipsis(w, clean[0..source.len], b.w - 14);
                }
            }
        }
        const action = if (m.edit_index != null or m.edit_provider != null) "Save" else "Add";
        try w.print("{s}\x1b[{d};{d}H[Cancel]  [{s}]", .{ panel, field_y + 12 + @as(usize, if (m.show_command) 2 else 0), b.x + b.w - 19, action });
        try w.print("\x1b[{d};{d}H{s}Tab: command / name\x1b[{d};{d}H{s}[Done]\x1b[?25l", .{ b.y + b.h - 1, b.x + 4, dim, b.y + b.h - 1, b.x + b.w - 9, panel });
        if (m.selected == .add) {
            const editor = if (m.name_focused) m.name_editor else m.editor;
            var offset = editor.cursor -| (width -| 1);
            while (offset < editor.cursor and editor.text[offset] & 0xc0 == 0x80) offset += 1;
            const cursor = @min(width -| 1, sidebar.displayWidth(editor.text[offset..editor.cursor]));
            try w.print("\x1b[{d};{d}H\x1b[?25h", .{ field_y + 2 + @as(usize, if (m.name_focused) 4 else 0), input_x + 1 + cursor });
        }
    }

    pub fn draw(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: sidebar.View) !void {
        if (m.managing) return m.drawManager(w, cols, rows, side);
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return;
        const panel = (palette.Style{ .fg = .faint, .bg = .surface }).sgr();
        const rule = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
        for (0..b.h) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, rule });
            try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
            if (row == 0 or row == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
        }
        try drawTitle(w, b, panel);
        const widths = m.columns(b.w);
        var heading_x: u16 = b.x + 4;
        for (headings, widths, 0..) |heading, width, column| {
            if (width == 0 or (m.managing and column != 0)) continue;
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + 2, heading_x + @as(u16, if (column == 0) 4 else 0), panel });
            const room = width -| @as(u16, if (column == 0) 6 else if (column == 5) 1 else 2);
            const label = if (column == 1 and room < 4)
                "Y"
            else if (column == 5 and room < sidebar.displayWidth(heading))
                (if (room >= 14) "Usage · resets" else "Usage")
            else
                heading;
            try sidebar.writeEllipsis(w, label, room);
            heading_x += width;
        }
        for (0..m.count()) |visible| {
            const current = m.rowAt(visible).?;
            const selected = current == m.selected and !m.resume_view.focused;
            const row = b.y + 3 + visible + @as(usize, if (current == .manage) 2 else 0);
            if (current == .manage) {
                try w.print("\x1b[{d};{d}H{s}", .{ row - 1, b.x + 4, rule });
                for (0..b.w - 6) |_| try w.writeAll("─");
            }
            const style = if (selected) (palette.Style{ .fg = .strong, .bg = .selected }).sgr() else (palette.Style{ .fg = .text, .bg = .surface }).sgr();
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, style });
            try w.splatByteAll(' ', b.w - 2);
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, if (selected) "›" else " " });
            if (current.agent() != null or current.custom() != null) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                const digit = [_]u8{'0' + @as(u8, @intCast(visible))};
                try writeKey(w, &digit, style);
            }
            if (current == .add) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try sidebar.writeEllipsis(w, "+ Add agent…", b.w -| 6);
                continue;
            }
            if (current == .manage) {
                // A step above a selected row, so the button keeps its edge.
                const button = if (selected) (palette.Style{ .fg = .strong, .bg = .line, .bold = true }).sgr() else (palette.Style{ .fg = .strong, .bg = .selected, .bold = true }).sgr();
                try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 4, button });
                try sidebar.writeEllipsis(w, " → Manage agents… ", b.w -| 6);
                try w.writeAll(style);
                continue;
            }
            if (m.managing) {
                var line: [160]u8 = undefined;
                const provider = current.agent().?;
                const status = if (!m.preview.installed.get(provider)) "Not installed" else if (m.preview.options.get(provider).signed_in == false) "Not signed in" else if (m.hidden.get(provider)) "Hidden" else "In picker";
                const text = try std.fmt.bufPrint(&line, "{s} · {s}   [{s}]", .{ provider.info().label, status, if (m.hidden.get(provider)) "Add" else "Remove" });
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try sidebar.writeEllipsis(w, text, b.w -| 6);
                continue;
            }
            if (current == .terminal) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try writeKey(w, "t", style);
                try w.writeAll(" ");
                try sidebar.writeEllipsis(w, "New terminal", b.w -| 10);
                continue;
            }
            var x: u16 = b.x + 4;
            const values = if (current.custom()) |index| m.customCells(index) else m.cells(current.agent().?);
            const yolo = if (current.custom()) |index| m.commands[index].semantics.yolo else m.yolo.get(current.agent().?);
            for (widths, 0..) |width, column| {
                if (width == 0) continue;
                try w.print("\x1b[{d};{d}H", .{ row, x + @as(u16, if (column == 0) 4 else 0) });
                if (column == 5 and m.trackable(current)) try w.writeAll("\x1b[4m");
                if (column == 1 and yolo) try w.writeAll(comptime "\x1b[1m" ++ palette.fg(.strong));
                const room = width -| @as(u16, if (column == 0) 6 else if (column == 5) 1 else 2);
                if (column == 5) {
                    try m.usageCell(current).write(w, room, style, selected);
                } else try sidebar.writeEllipsis(w, values[column], room);
                try w.writeAll("\x1b[24m");
                if (column == 1 and yolo) try w.writeAll(style);
                x += width;
            }
        }
        if (m.hasResume()) {
            // A rule across the gap between the agents and the conversations.
            try w.print("\x1b[{d};{d}H{s}", .{ m.resumeTop(b) - 1, b.x + 4, rule });
            for (0..b.w - 6) |_| try w.writeAll("─");
            if (m.resume_view.expanded) {
                try m.resume_view.draw(w, m.resumeContext(), m.resumeArea(cols, rows, side));
            } else try m.resume_view.drawCollapsed(w, m.resumeContext(), b.x + 1, m.resumeTop(b), b.w);
        }
        const view = &m.resume_view;
        const on_more = blk: {
            var storage: [launcher_resume.max_lines]launcher_resume.Line = undefined;
            const c = m.resumeContext();
            break :blk view.focused and view.entry(c, view.lines(c, &storage)) == null;
        };
        const hints: []const Hint = if (view.searching and view.query.len > 0)
            &.{ .{ .key = "↵", .label = "resume" }, .{ .key = "tab", .label = "scope" }, .{ .key = "esc", .label = "clear" } }
        else if (view.searching)
            &.{ .{ .key = "↵", .label = "resume" }, .{ .key = "tab", .label = "scope" }, .{ .key = "esc", .label = "close" } }
        else if (view.focused and view.expanded)
            &.{ .{ .key = "↵", .label = "resume" }, .{ .key = "/", .label = "search" }, .{ .key = "tab", .label = "scope" }, .{ .key = "esc", .label = "less" } }
        else if (on_more)
            &.{ .{ .key = "↵", .label = "show all" }, .{ .key = "/", .label = "search" } }
        else if (view.focused)
            &.{ .{ .key = "↵", .label = "resume" }, .{ .key = "/", .label = "search" } }
        else if (m.managing or m.selected == .manage) blk: {
            const label = if (m.selected == .manage)
                "back/open"
            else if (m.selected == .add)
                "add"
            else if (m.selected.custom() != null)
                "edit"
            else if (m.selected.agent() != null and m.hidden.get(m.selected.agent().?))
                "add"
            else
                "remove";
            break :blk &.{.{ .key = "↵", .label = label }};
        } else if (m.selected.custom() != null)
            &.{.{ .key = "a", .label = "launch" }}
        else if (m.selected == .terminal)
            &.{.{ .key = "a", .label = "open" }}
        else if (m.trackable(m.selected))
            &.{ .{ .key = "u", .label = "Track usage" }, .{ .key = "a", .label = "launch" }, .{ .key = "y", .label = "YOLO" } }
        else
            &.{ .{ .key = "a", .label = "launch" }, .{ .key = "y", .label = "YOLO" } };
        try drawFooter(w, b, panel, m.cwd.text(), "new tab", hints);
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
};

test "launcher menu bounds" {
    const side = sidebar.View.init(80, 24, true, 0, 0);
    const menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    const b = menu.bounds(80, 24, side);
    try std.testing.expect(b.x + b.w <= 80 and b.y + b.h <= 24);
    try std.testing.expectEqual(Row.codex, menu.hit(80, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Row.claude, menu.hit(80, 24, side, b.x + 2, b.y + 3).?);
    try std.testing.expectEqual(Row.terminal, menu.hit(80, 24, side, b.x + 2, b.y + 4).?);
    try std.testing.expectEqual(@as(?Row, null), menu.hit(80, 24, side, b.x + 2, b.y + 6));
    // Manage is the title's button now.
    try std.testing.expect(menu.manageHit(80, 24, side, b.x + b.w - 6, b.y));
    try std.testing.expect(!menu.manageHit(80, 24, side, b.x + 4, b.y));
}

test "conversations sit below the agents and their rows hit-test" {
    const side = sidebar.View.init(120, 40, true, 0, 0);
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true, .cwd = .initTruncated("/w") };
    const entries = [_]launch_history.Entry{
        .{ .provider = .claude, .session = "a", .title = "First", .cwd = "/w", .updated_at = 5 },
        .{ .provider = .codex, .session = "b", .title = "Second", .cwd = "/w", .updated_at = 4 },
    };
    menu.history = .{ .pending = false, .entries = &entries };
    const b = menu.bounds(120, 40, side);
    // Border, headings, three agent rows, a gap, then the Resume heading.
    const first_line = b.y + 7;
    try std.testing.expectEqual(@as(?Row, null), menu.hit(120, 40, side, b.x + 2, first_line));
    try std.testing.expectEqual(@as(usize, 0), menu.resumeHit(120, 40, side, b.x + 2, first_line).?.row);
    try std.testing.expectEqual(@as(usize, 2), menu.resumeHit(120, 40, side, b.x + 2, first_line + 2).?.row);
    try std.testing.expect(menu.resumeHit(120, 40, side, b.x + 2, first_line - 1) == null);
    try std.testing.expect(b.h >= menu.rowsHeight());
    menu.resume_view.expand();
    try std.testing.expectEqual(@as(u16, 104), menu.bounds(120, 40, side).w);
}

test "launcher fits long content and keeps usage hit targets aligned" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .claude, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    menu.preview.options.getPtr(.codex).model = .ascii("a-long-model-name-that-needs-room");
    menu.preview.options.getPtr(.claude).account = .ascii("person.with.a.long.name@example.com");
    menu.preview.options.getPtr(.claude).usage_needs_consent = true;
    const widths = menu.columns(200);
    try std.testing.expectEqual(@as(u16, 35), widths[2]);
    try std.testing.expectEqual(@as(u16, 37), widths[3]);
    for ([_]u16{ 24, 40, 64, 80, 120, 200 }) |cols| {
        const side = sidebar.View.init(cols, 24, true, 0, 0);
        const b = menu.bounds(cols, 24, side);
        try std.testing.expect(b.x + b.w <= cols);
        const fitted = menu.columns(b.w);
        var used: u16 = 4;
        for (fitted) |width| used += width;
        try std.testing.expect(used <= b.w);
        const usage_x = b.x + 3 + fitted[0] + fitted[1] + fitted[2] + fitted[3] + fitted[4];
        try std.testing.expectEqual(Provider.claude, menu.usageHit(cols, 24, side, usage_x, b.y + 3).?);
    }
}

test "single-line limit groups survive narrow terminal rendering" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    const now = os.timestamp();
    menu.preview.options.getPtr(.codex).limits = .{ .windows = .{ null, .{ .minutes = 10080, .used = 48, .reset_at = now + 6 * 86400 + 18 * 3600 } } };
    menu.preview.options.getPtr(.claude).limits = .{ .windows = .{
        .{ .minutes = 300, .used = 17, .reset_at = now + 99 * 60 },
        .{ .minutes = 10080, .used = 35, .reset_at = now + 86400 + 15 * 3600 },
    } };
    for (&menu.preview.options.values.values) |*option| {
        option.usage_fetched_at = now;
        option.account = .ascii("toasty.tal@gmail.com");
        option.model = .ascii("gpt-6-astra");
        option.plan = .ascii("pro");
    }
    for ([_]u16{ 60, 80, 100, 124 }) |cols| {
        const side = sidebar.View.init(cols, 24, true, 0, 0);
        var output: std.Io.Writer.Allocating = .init(a);
        defer output.deinit();
        try menu.draw(&output.writer, cols, 24, side);
        const host = try Terminal.create(cols, 24);
        defer host.destroy();
        host.feed(output.written());
        const rendered = try host.text();
        defer a.free(rendered);
        var found: [2]usize = .{ 0, 0 };
        var lines = std.mem.splitScalar(u8, rendered, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "Codex") != null) {
                found[0] += 1;
                try std.testing.expect(std.mem.indexOf(u8, line, "7d") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "48%") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "6d 18h") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "5h") == null);
            }
            if (std.mem.indexOf(u8, line, "Claude Code") != null) {
                found[1] += 1;
                for ([_][]const u8{ "5h", "17%", "1h 39m", " │ 7d", "35%", "1d 15h" }) |value|
                    try std.testing.expect(std.mem.indexOf(u8, line, value) != null);
            }
            try std.testing.expect(sidebar.displayWidth(line) <= cols);
        }
        try std.testing.expectEqual([2]usize{ 1, 1 }, found);
        const b = menu.bounds(cols, 24, side);
        const x = b.x + 3 + menu.columns(b.w)[0];
        try std.testing.expectEqual(Provider.codex, menu.yoloHit(cols, 24, side, x, b.y + 2).?);
    }
}

test "viewer expires a delivered usage reading after ten minutes" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    const option = menu.preview.options.getPtr(.codex);
    option.limits = .{ .windows = .{ null, .{ .minutes = 10080, .used = 48 } } };
    option.usage_fetched_at = os.timestamp() - 590;
    try std.testing.expectEqual(@as(usize, 1), menu.usageCell(.codex).len);
    option.usage_fetched_at = os.timestamp() - metadata.usage_max_age;
    try std.testing.expectEqualStrings("Unavailable · last success 10m+ ago", menu.usageCell(.codex).fallback.text());
    option.limits = .metered;
    try std.testing.expectEqualStrings("Metered", menu.usageCell(.codex).fallback.text());
    option.limits = .rate_limited;
    option.usage_fetched_at = 0;
    option.usage_error = .ascii("server returned 429");
    try std.testing.expectEqualStrings("Unavailable · server returned 429", menu.usageCell(.codex).fallback.text());
}

test "launcher hides providers that are not installed" {
    const side = sidebar.View.init(120, 24, true, 0, 0);
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.installed = .init(.{ .codex = false });
    menu.normalize();
    try std.testing.expectEqual(Row.claude, menu.selected);
    const b = menu.bounds(120, 24, side);
    // Border, headings, two rows, a gap, footer and border.
    try std.testing.expectEqual(@as(u16, 7), b.h);
    try std.testing.expectEqual(Row.claude, menu.hit(120, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Row.terminal, menu.hit(120, 24, side, b.x + 2, b.y + 3).?);
    menu.move(true, true);
    try std.testing.expectEqual(Row.terminal, menu.selected);
    menu.move(true, true);
    try std.testing.expectEqual(Row.claude, menu.selected);
    menu.preview.installed = .init(.{ .codex = false, .claude = false });
    menu.normalize();
    try std.testing.expectEqual(Row.terminal, menu.selected);
    try std.testing.expectEqual(Row.terminal, menu.first());
}

test "signed-out and hidden agents remain editable in management" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.options.getPtr(.codex).signed_in = false;
    menu.hidden.set(.claude, true);
    menu.normalize();
    try std.testing.expectEqual(Row.terminal, menu.selected);
    try std.testing.expect(!menu.shown(.codex) and !menu.shown(.claude));
    menu.managing = true;
    try std.testing.expect(menu.shown(.codex) and menu.shown(.claude) and menu.shown(.add));
    try menu.commands[0].set("FOO=123 claude --whatever");
    menu.commands[0].hidden = true;
    try std.testing.expect(menu.shown(.custom0));
    menu.managing = false;
    try std.testing.expect(!menu.shown(.custom0));
    menu.commands[0].hidden = false;
    try std.testing.expect(menu.shown(.custom0));
    menu.preview.options.getPtr(.codex).signed_in = null;
    try std.testing.expect(menu.shown(.codex));
}

test "digit shortcuts enumerate visible agents and exclude terminal and management" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .codex, .last = .codex, .pinned = true };
    try std.testing.expectEqual(Row.codex, menu.shortcutRow('0').?);
    try std.testing.expectEqual(Row.claude, menu.shortcutRow('1').?);
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('2'));
    menu.hidden.set(.codex, true);
    try menu.commands[3].set("claude --model opus");
    try std.testing.expectEqual(Row.claude, menu.shortcutRow('0').?);
    try std.testing.expectEqual(Row.custom3, menu.shortcutRow('1').?);
    menu.preview.options.getPtr(.claude).signed_in = false;
    try std.testing.expectEqual(Row.custom3, menu.shortcutRow('0').?);
    menu.commands[3].hidden = true;
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('0'));
    menu.managing = true;
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('0'));
}

test "custom picker cells preserve account scope and permission state" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .selected = .custom0, .last = .claude, .pinned = true };
    menu.preview.pending = false;
    menu.preview.options.getPtr(.claude).account = .ascii("personal@example.com");
    menu.preview.options.getPtr(.claude).plan = .ascii("Max");
    menu.preview.options.getPtr(.claude).model = .ascii("opus");
    try menu.commands[0].set("claude --dangerously-skip-permissions");
    menu.commands[0].semantics = launch_command.analyze(menu.commands[0].text(), "/tmp");
    var values = menu.customCells(0);
    try std.testing.expectEqualStrings("personal@example.com", values[3]);
    try std.testing.expectEqualStrings("✓", values[1]);
    try std.testing.expectEqualStrings("Max", values[4]);
    menu.commands[0].semantics.default_account = false;
    menu.commands[0].semantics.account = .ascii("work@example.com (cached)");
    values = menu.customCells(0);
    try std.testing.expectEqualStrings("work@example.com (cached)", values[3]);
    try std.testing.expectEqualStrings("—", values[4]);
    try std.testing.expectEqualStrings("—", menu.usageCell(.custom0).fallback.text());
}
