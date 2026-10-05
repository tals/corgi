//! The launcher's conversations to resume: the newest few under the agent
//! rows, and every one, grouped by day and searchable, once expanded. The
//! daemon sends every resumable conversation; this file filters, draws and
//! hit-tests them.
const std = @import("std");
const agents = @import("agents.zig");
const Provider = agents.Provider;
const layout = @import("layout.zig");
const sidebar = @import("sidebar.zig");
const naming = @import("name_dialog.zig");
const palette = @import("palette.zig");
const launch_history = @import("launch.zig").history;
const Entry = launch_history.Entry;
const History = launch_history.History;
const time_c = @cImport(@cInclude("time.h"));

pub const Scope = enum {
    folder,
    workspace,
    everywhere,
    fn label(s: Scope) []const u8 {
        return switch (s) {
            .folder => "this folder",
            .workspace => "this workspace",
            .everywhere => "everywhere",
        };
    }
};

/// A conversation a pane runs. Search jumps to its pane instead of starting
/// a second copy of the session.
pub const Open = struct { provider: Provider, session: agents.Text, pane: layout.PaneId };
pub const max_open = 64;

/// Where the launcher is, and what is already open.
pub const Context = struct {
    history: History,
    folder: []const u8,
    workspace_folder: []const u8,
    open: []const Open,
    /// Seconds.
    now: i64,

    fn opened(c: Context, e: *const Entry) ?Open {
        for (c.open) |o| if (o.provider == e.provider and std.mem.eql(u8, o.session.text(), e.session)) return o;
        return null;
    }
    fn within(folder: []const u8, path: []const u8) bool {
        return folder.len > 0 and std.mem.startsWith(u8, path, folder) and (path.len == folder.len or path[folder.len] == '/' or folder[folder.len - 1] == '/');
    }
    fn inScope(c: Context, e: *const Entry, scope: Scope) bool {
        return switch (scope) {
            .folder => std.mem.eql(u8, e.cwd, c.folder),
            .workspace => within(c.workspace_folder, e.cwd) or within(c.folder, e.cwd),
            .everywhere => true,
        };
    }
    /// Listed without a search: closed, in `scope`, and more than a commit.
    fn listed(c: Context, e: *const Entry, scope: Scope) bool {
        return c.opened(e) == null and c.inScope(e, scope) and !e.chore;
    }
};

/// What this Corgi knows about a conversation it ran: the name its sidebar
/// showed, and when it last saw or closed it, in seconds.
pub const Known = struct { provider: Provider, session: []const u8, name: []const u8 = "", at: i64 = 0 };

/// `entries` as this Corgi knows them, newest first, copied into `alloc`:
/// its names, and its times when later than the transcript's.
pub fn merge(alloc: std.mem.Allocator, entries: []const Entry, known: []const Known) ![]Entry {
    var by_session: std.StringHashMapUnmanaged(Known) = .empty;
    for (known) |k| {
        const slot = try by_session.getOrPut(alloc, try std.fmt.allocPrint(alloc, "{t}:{s}", .{ k.provider, k.session }));
        if (!slot.found_existing) {
            slot.value_ptr.* = k;
            continue;
        }
        if (slot.value_ptr.name.len == 0) slot.value_ptr.name = k.name;
        slot.value_ptr.at = @max(slot.value_ptr.at, k.at);
    }
    const out = try alloc.alloc(Entry, entries.len);
    for (entries, out) |e, *merged| {
        merged.* = try launch_history.clone(alloc, e);
        const k = by_session.get(try std.fmt.allocPrint(alloc, "{t}:{s}", .{ e.provider, e.session })) orelse continue;
        if (k.name.len > 0) merged.title = try alloc.dupe(u8, k.name);
        merged.updated_at = @max(merged.updated_at, k.at);
    }
    std.mem.sort(Entry, out, {}, newer);
    return out;
}
fn newer(_: void, x: Entry, y: Entry) bool {
    return x.updated_at > y.updated_at;
}

/// How many conversations show before the list is expanded.
pub const collapsed_rows = 5;

/// One row of the list.
pub const Line = union(enum) {
    /// A local day's heading; the value is any second in that day.
    day: i64,
    heading: enum { open, results },
    entry: u16,
    /// An open conversation, by entry index.
    open: u16,
    /// Matches left out of the current scope.
    elsewhere: u16,
    /// Expands the list; the value counts conversations not shown yet.
    more: u16,
};
/// Entries plus a heading per day, at most.
pub const max_lines = 2 * launch_history.capacity + 4;

pub const View = struct {
    expanded: bool = false,
    /// The keyboard is in this list rather than on the agent rows.
    focused: bool = false,
    searching: bool = false,
    query: naming.Dialog = naming.Dialog.init(.{ .pane = @enumFromInt(0) }, ""),
    scope: Scope = .workspace,
    /// Kept by identity, so a refreshed list keeps the selection.
    selected: ?Key = null,
    scroll: usize = 0,

    const Key = union(enum) {
        conversation: struct { provider: Provider, session: agents.Text },
        more,
        fn of(c: Context, line: Line) ?Key {
            return switch (line) {
                .entry, .open => |i| .{ .conversation = .{ .provider = c.history.entries[i].provider, .session = .initTruncated(c.history.entries[i].session) } },
                .more => .more,
                else => null,
            };
        }
        fn eql(k: Key, other: Key) bool {
            return switch (k) {
                .more => other == .more,
                .conversation => |a| other == .conversation and a.provider == other.conversation.provider and
                    std.mem.eql(u8, a.session.text(), other.conversation.session.text()),
            };
        }
    };

    pub fn search(v: *const View) []const u8 {
        return if (v.searching) v.query.name() else "";
    }
    fn matches(v: *const View, e: *const Entry) bool {
        var words = std.mem.tokenizeScalar(u8, v.search(), ' ');
        while (words.next()) |word| {
            if (!contains(e.title, word) and !contains(e.first, word) and !contains(e.last, word)) return false;
        }
        return true;
    }

    /// The rows to show, in order.
    pub fn lines(v: *const View, c: Context, out: *[max_lines]Line) []Line {
        var n: usize = 0;
        const entries = c.history.entries;
        if (v.search().len > 0) return v.found(c, out);
        if (!v.expanded) {
            // The newest in this folder; "more" counts what the expanded
            // list adds in its starting scope.
            var total: usize = 0;
            for (entries, 0..) |*e, i| {
                total += @intFromBool(c.listed(e, .workspace));
                if (n == collapsed_rows or !c.listed(e, .folder)) continue;
                out[n] = .{ .entry = @intCast(i) };
                n += 1;
            }
            out[n] = .{ .more = @intCast(total -| n) };
            return out[0 .. n + 1];
        }
        var day: ?i64 = null;
        for (entries, 0..) |*e, i| {
            if (!c.listed(e, v.scope)) continue;
            const start = dayStart(e.updated_at);
            if (day != start) {
                out[n] = .{ .day = e.updated_at };
                n += 1;
                day = start;
            }
            out[n] = .{ .entry = @intCast(i) };
            n += 1;
        }
        return out[0..n];
    }
    /// Search results: open matches first, then closed ones in scope,
    /// commit chores included.
    fn found(v: *const View, c: Context, out: *[max_lines]Line) []Line {
        var n: usize = 0;
        const entries = c.history.entries;
        var open: usize = 0;
        for (entries, 0..) |*e, i| if (open < 3 and c.opened(e) != null and v.matches(e)) {
            if (open == 0) {
                out[n] = .{ .heading = .open };
                n += 1;
            }
            out[n] = .{ .open = @intCast(i) };
            n += 1;
            open += 1;
        };
        out[n] = .{ .heading = .results };
        n += 1;
        var elsewhere: u16 = 0;
        for (entries, 0..) |*e, i| {
            if (c.opened(e) != null or !v.matches(e)) continue;
            if (!c.inScope(e, v.scope)) {
                elsewhere += 1;
                continue;
            }
            out[n] = .{ .entry = @intCast(i) };
            n += 1;
        }
        if (elsewhere > 0) {
            out[n] = .{ .elsewhere = elsewhere };
            n += 1;
        }
        return out[0..n];
    }
    /// Matches in the current scope, for the results heading.
    fn count(rows: []const Line) usize {
        var n: usize = 0;
        for (rows) |line| n += @intFromBool(line == .entry);
        return n;
    }
    /// The selected row's index in `rows`: the kept selection when still
    /// listed, else the first row that can be selected.
    pub fn index(v: *const View, c: Context, rows: []const Line) ?usize {
        var first: ?usize = null;
        for (rows, 0..) |line, i| if (Key.of(c, line)) |k| {
            if (first == null) first = i;
            if (v.selected) |kept| if (kept.eql(k)) return i;
        };
        return first;
    }
    /// The selected conversation; null on the "more" row.
    pub fn entry(v: *const View, c: Context, rows: []const Line) ?*const Entry {
        const i = v.index(c, rows) orelse return null;
        return switch (rows[i]) {
            .entry, .open => |e| &c.history.entries[e],
            else => null,
        };
    }
    /// Move by `delta` rows that can be selected, stopping at the end. False
    /// when already at the top and moving up, so the caller can leave the list.
    pub fn move(v: *View, c: Context, rows: []const Line, delta: isize) bool {
        var at = v.index(c, rows) orelse return false;
        var left = @abs(delta);
        var moved = false;
        var i = at;
        while (left > 0) {
            if (delta > 0) {
                if (i + 1 >= rows.len) break;
                i += 1;
            } else {
                if (i == 0) break;
                i -= 1;
            }
            if (Key.of(c, rows[i]) != null) {
                at = i;
                left -= 1;
                moved = true;
            }
        }
        if (delta < 0 and !moved) return false;
        v.selected = Key.of(c, rows[at]);
        return true;
    }
    /// Select row `row`; false when it cannot be selected.
    pub fn select(v: *View, c: Context, row: usize) bool {
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        if (row >= rows.len) return false;
        v.selected = Key.of(c, rows[row]) orelse return false;
        v.focused = true;
        return true;
    }
    pub fn home(v: *View) void {
        v.selected = null;
        v.scroll = 0;
    }
    pub fn expand(v: *View) void {
        v.expanded = true;
        v.focused = true;
        v.home();
    }
    pub fn collapse(v: *View) void {
        v.expanded = false;
        v.stopSearch();
        v.scope = .workspace;
    }
    pub fn startSearch(v: *View) void {
        v.expand();
        v.searching = true;
    }
    pub fn stopSearch(v: *View) void {
        v.searching = false;
        v.query.clear();
        v.home();
    }
    pub fn nextScope(v: *View, forward: bool) void {
        const n = std.enums.values(Scope).len;
        v.scope = @enumFromInt((@intFromEnum(v.scope) + if (forward) @as(usize, 1) else n - 1) % n);
        v.home();
    }
    /// The first row shown in `height` rows: `scroll`, moved just enough
    /// to show the selected row and the heading above it.
    fn firstRow(v: *const View, rows: []const Line, at: ?usize, height: usize) usize {
        var first = @min(v.scroll, rows.len -| height);
        const i = at orelse return first;
        const top = if (i > 0 and rows[i - 1] == .day) i - 1 else i;
        if (top < first) first = top;
        if (i >= first + height) first = i + 1 - height;
        return first;
    }
    /// Keep the selection in view after it moves.
    pub fn reveal(v: *View, c: Context, area: Area) void {
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        v.scroll = v.firstRow(rows, v.index(c, rows), area.listHeight());
    }

    // ---------- Drawing ----------

    const panel = (palette.Style{ .fg = .faint, .bg = .surface }).sgr();
    const rule = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
    const row_style = (palette.Style{ .fg = .text, .bg = .surface }).sgr();
    const selected_style = (palette.Style{ .fg = .strong, .bg = .selected }).sgr();
    const dim = palette.fg(.faint);
    /// The run's rail; faint is too dim on a selected row.
    fn rail(selected: bool) []const u8 {
        return if (selected) palette.fg(.muted) else dim;
    }

    pub const Columns = struct { title: u16, folder: u16, last: u16 };
    /// Title, folder and last-message widths for an inner width; the last
    /// message goes first when space runs out.
    fn columns(v: *const View, inner: u16) Columns {
        // Marker, provider and their gaps, the gap after the title, and the age.
        const room = inner -| 16;
        const folder: u16 = if (v.expanded and v.scope != .folder and room >= 60) 15 else 0;
        const title = if (room -| folder >= 70) @max(30, (room - folder) * 2 / 5) else @min(room -| folder, @max(@as(u16, 24), (room -| folder) * 3 / 5));
        return .{ .title = title, .folder = folder, .last = room -| folder -| title -| 2 };
    }
    /// Rows the collapsed list takes, its heading included.
    pub fn collapsedHeight(v: *const View, c: Context) u16 {
        var storage: [max_lines]Line = undefined;
        return @intCast(1 + v.lines(c, &storage).len);
    }

    /// The collapsed list from terminal row `y`, inside a border at column
    /// `x` that is `width` wide.
    pub fn drawCollapsed(v: *const View, w: *std.Io.Writer, c: Context, x: u16, y: u16, width: u16) !void {
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        const cols = v.columns(width -| 4);
        var total: usize = 0;
        for (c.history.entries) |*e| total += @intFromBool(c.listed(e, .folder));
        var heading: [std.fs.max_path_bytes + 32]u8 = undefined;
        try w.print("\x1b[{d};{d}H{s}\x1b[1m" ++ palette.fg(.strong) ++ "Resume{s}", .{ y, x + 3, panel, panel });
        try sidebar.writeEllipsis(w, try std.fmt.bufPrint(&heading, " · {d} in {s}", .{ total, std.fs.path.basename(c.folder) }), cols.title + 3);
        if (cols.last > 12) {
            try w.print("\x1b[{d};{d}H", .{ y, x + 3 + 9 + cols.title + 2 });
            try sidebar.writeEllipsis(w, "You last said", cols.last);
        }
        try w.print("\x1b[{d};{d}HActive", .{ y, x + width - 3 - 6 });
        const at = v.index(c, rows);
        for (rows, 0..) |line, k| {
            try v.drawLine(w, c, line, rows, v.focused and at == k, startsRun(c, rows, k, 0), x, y + 1 + @as(u16, @intCast(k)), width, cols);
        }
    }
    /// The expanded list in `area`, terminal coordinates inside the border.
    pub fn draw(v: *const View, w: *std.Io.Writer, c: Context, area: Area) !void {
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        const at = v.index(c, rows);
        const x = area.x;
        const y = area.y;
        const width = area.width;
        const list_top = area.listTop();
        const list_height = area.listHeight();
        const first = v.firstRow(rows, at, list_height);
        const cols = v.columns(width -| 4);
        // Search line and scope.
        try w.print("\x1b[{d};{d}H{s}", .{ y, x + 3, panel });
        try writeKey(w, "/", panel);
        try w.writeAll(" ");
        const scope = v.scope.label();
        const field = width -| @as(u16, @intCast(scope.len + 19));
        if (v.searching) {
            try w.writeAll(palette.fg(.strong));
            try sidebar.writeEllipsis(w, v.query.name(), field -| 1);
            try w.writeAll("\x1b[7m \x1b[27m");
        } else {
            try w.writeAll(dim);
            try sidebar.writeEllipsis(w, "search titles and what was said", field);
        }
        try w.print("\x1b[{d};{d}H", .{ y, x + width - 2 - @as(u16, @intCast(scope.len + 2 + 6)) });
        try writeKey(w, "tab", panel);
        try w.writeAll(" ");
        try writeKey(w, scope, panel);
        // Column headings.
        try w.print("\x1b[{d};{d}H{s}", .{ y + 1, x + 3 + 9, panel });
        try sidebar.writeEllipsis(w, "Title", cols.title);
        if (cols.folder > 0) {
            try w.print("\x1b[{d};{d}H", .{ y + 1, x + 3 + 9 + cols.title + 2 });
            try w.writeAll("Folder");
        }
        if (cols.last > 12) {
            try w.print("\x1b[{d};{d}H", .{ y + 1, x + 3 + 9 + cols.title + 2 + cols.folder });
            try sidebar.writeEllipsis(w, "You last said", cols.last);
        }
        try w.print("\x1b[{d};{d}HActive", .{ y + 1, x + width - 3 - 6 });
        if (rows.len == 0 or (rows.len == 1 and rows[0] == .heading)) {
            try w.print("\x1b[{d};{d}H{s}", .{ list_top + @as(u16, @intFromBool(rows.len == 1)), x + 3 + 9, panel });
            try w.writeAll(if (v.search().len > 0) "No matches." else "Nothing closed here. Tab widens the scope.");
        }
        for (rows[first..@min(rows.len, first + list_height)], 0..) |line, k| {
            const row: u16 = list_top + @as(u16, @intCast(k));
            try v.drawLine(w, c, line, rows, v.focused and at == first + k, startsRun(c, rows, first + k, first), x, row, width, cols);
        }
        if (rows.len > list_height) {
            const thumb: usize = @max(1, list_height * list_height / rows.len);
            const top = (list_height - thumb) * first / (rows.len - list_height);
            for (0..list_height) |k| {
                try w.print("\x1b[{d};{d}H{s}", .{ list_top + k, x + width - 2, if (k >= top and k < top + thumb) panel ++ "┃" else rule ++ "│" });
            }
        }
    }
    /// `named` rows show their agent's name; the rows below continue its run
    /// as a rail.
    fn drawLine(v: *const View, w: *std.Io.Writer, c: Context, line: Line, rows: []const Line, selected: bool, named: bool, x: u16, row: u16, width: u16, cols: Columns) !void {
        const style = if (selected) selected_style else row_style;
        switch (line) {
            .day => |at| {
                var label: [32]u8 = undefined;
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 3, panel });
                const text = dayLabel(&label, at, c.now);
                try w.writeAll(text);
                try w.writeAll(comptime " " ++ palette.fg(.line));
                for (0..width -| @as(u16, @intCast(6 + text.len))) |_| try w.writeAll("─");
            },
            .heading => |which| {
                var label: [64]u8 = undefined;
                const text = switch (which) {
                    .open => "Open · jumps to its tab",
                    .results => try std.fmt.bufPrint(&label, "{d} in {s}", .{ count(rows), v.scope.label() }),
                };
                try w.print("\x1b[{d};{d}H{s}\x1b[1m{s}\x1b[22m", .{ row, x + 3, panel, text });
            },
            .elsewhere => |n| {
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 3 + 9, panel });
                try w.print("{d} more outside {s} · tab widens", .{ n, v.scope.label() });
            },
            .more => |n| {
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 1, style });
                try w.splatByteAll(' ', width -| 3);
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 1, if (selected) "›" else " " });
                // The rail above runs on, dashed, into the conversations left out.
                if (n > 0) try w.print("\x1b[{d};{d}H{s}┊{s}", .{ row, x + 3, rail(selected), style });
                try w.print("\x1b[{d};{d}H", .{ row, x + 3 + 9 });
                if (n > 0) try w.print("Show {d} more…", .{n}) else try w.writeAll("Search every folder…");
                try w.print("\x1b[{d};{d}H", .{ row, x + width - 3 - 10 });
                try writeKey(w, "/", style);
                try w.writeAll(" search");
            },
            .entry, .open => |i| {
                const e = &c.history.entries[i];
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 1, style });
                try w.splatByteAll(' ', width -| 3);
                try w.print("\x1b[{d};{d}H{s}", .{ row, x + 1, if (selected) "›" else " " });
                if (named) {
                    try w.print("\x1b[{d};{d}H{s}", .{ row, x + 3, providerLabel(e.provider) });
                } else try w.print("\x1b[{d};{d}H{s}│{s}", .{ row, x + 3, rail(selected), style });
                var col: u16 = x + 3 + 9;
                try w.print("\x1b[{d};{d}H", .{ row, col });
                const branch = if (line == .entry) otherBranch(c, e) else "";
                const title = if (e.title.len > 0) e.title else e.first;
                if (branch.len > 0 and cols.title > 16) {
                    const room = cols.title -| @as(u16, @intCast(@min(branch.len, cols.title / 2) + 1));
                    try sidebar.writeEllipsis(w, title, room);
                    try w.print("\x1b[{d};{d}H" ++ palette.fg(.muted), .{ row, col + room + 1 });
                    try sidebar.writeEllipsis(w, branch, cols.title - room - 1);
                    try w.writeAll(style);
                } else try sidebar.writeEllipsis(w, title, cols.title);
                col += cols.title + 2;
                if (cols.folder > 0) {
                    try w.print("\x1b[{d};{d}H" ++ palette.fg(.muted), .{ row, col });
                    try sidebar.writeEllipsis(w, std.fs.path.basename(e.cwd), cols.folder - 1);
                    try w.writeAll(style);
                    col += cols.folder;
                }
                if (line == .open) {
                    try w.print("\x1b[{d};{d}H" ++ palette.fg(.muted), .{ row, col });
                    try sidebar.writeEllipsis(w, "↗ open in a tab", cols.last);
                } else if (cols.last > 12) {
                    try w.print("\x1b[{d};{d}H", .{ row, col });
                    var room = cols.last;
                    if (e.interrupted) {
                        try w.writeAll(comptime palette.fg(.hot) ++ "✕ ");
                        room -|= 2;
                    }
                    try w.writeAll(if (selected) palette.fg(.text) else dim);
                    try sidebar.writeEllipsis(w, e.last, room);
                }
                var age: [8]u8 = undefined;
                const text = ageLabel(&age, c.now - e.updated_at);
                try w.print("\x1b[{d};{d}H{s}{s}", .{ row, x + width - 3 - @as(u16, @intCast(text.len)), if (selected) "" else dim, text });
            },
        }
    }
    pub const Hit = union(enum) { row: usize, scope };
    /// What terminal cell `x`, `y` holds in the expanded list drawn in `area`.
    pub fn hit(v: *const View, c: Context, area: Area, x: u16, y: u16) ?Hit {
        if (x <= area.x or x >= area.x + area.width - 1) return null;
        if (y == area.y and x >= area.x + area.width - 2 - @as(u16, @intCast(v.scope.label().len + 8))) return .scope;
        const top = area.listTop();
        if (y < top or y >= top + area.listHeight()) return null;
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        const row = v.firstRow(rows, v.index(c, rows), area.listHeight()) + (y - top);
        return if (row < rows.len and Key.of(c, rows[row]) != null) .{ .row = row } else null;
    }
    /// The collapsed list's row at `line`, counted from its first row.
    pub fn collapsedHit(v: *const View, c: Context, line: usize) ?usize {
        var storage: [max_lines]Line = undefined;
        const rows = v.lines(c, &storage);
        return if (line < rows.len and Key.of(c, rows[line]) != null) line else null;
    }
};

/// Terminal coordinates for the expanded list inside the launcher's border:
/// `x` is the left border's column, `y` the search line's row, `height` the
/// rows from there to the footer.
pub const Area = struct {
    x: u16,
    y: u16,
    width: u16,
    height: u16,
    fn listTop(a: Area) u16 {
        return a.y + 2;
    }
    fn listHeight(a: Area) u16 {
        return a.height -| 2;
    }
};

/// The branch `e` ran on when the folder's newest conversation used another.
fn otherBranch(c: Context, e: *const Entry) []const u8 {
    if (e.branch.len == 0) return "";
    for (c.history.entries) |*newest| if (std.mem.eql(u8, newest.cwd, e.cwd) and newest.branch.len > 0) {
        return if (std.mem.eql(u8, newest.branch, e.branch)) "" else e.branch;
    };
    return "";
}
/// The agent of a conversation row; null for any other row.
fn agentOf(c: Context, line: Line) ?Provider {
    return switch (line) {
        .entry, .open => |i| c.history.entries[i].provider,
        else => null,
    };
}
/// Whether conversation row `i` names its agent: the first row shown from
/// `first`, and wherever the agent differs from the row above.
fn startsRun(c: Context, rows: []const Line, i: usize, first: usize) bool {
    const agent = agentOf(c, rows[i]) orelse return false;
    if (i == first) return true;
    const above = agentOf(c, rows[i - 1]) orelse return true;
    return above != agent;
}
fn providerLabel(p: Provider) []const u8 {
    return switch (p) {
        .claude => "Claude",
        .codex => "Codex",
    };
}
/// Draw a keycap, then restore the surrounding style.
pub fn writeKey(w: *std.Io.Writer, key: []const u8, after: []const u8) !void {
    try w.print(palette.keycap ++ " {s} {s}", .{ key, after });
}
fn contains(text: []const u8, query: []const u8) bool {
    if (query.len > text.len) return false;
    for (0..text.len - query.len + 1) |i| if (std.ascii.eqlIgnoreCase(text[i..][0..query.len], query)) return true;
    return false;
}

fn local(seconds: i64) ?time_c.struct_tm {
    const t: time_c.time_t = @intCast(seconds);
    var tm: time_c.struct_tm = undefined;
    return if (time_c.localtime_r(&t, &tm) != null) tm else null;
}
/// Seconds at local midnight starting the day of `seconds`.
fn dayStart(seconds: i64) i64 {
    const tm = local(seconds) orelse return @divFloor(seconds, 86400) * 86400;
    return seconds - @as(i64, tm.tm_hour) * 3600 - @as(i64, tm.tm_min) * 60 - @as(i64, tm.tm_sec);
}
fn dayLabel(buf: []u8, seconds: i64, now: i64) []const u8 {
    const days = @divFloor(dayStart(now) - dayStart(seconds) + 43200, 86400);
    if (days <= 0) return "Today";
    if (days == 1) return "Yesterday";
    const tm = local(seconds) orelse return "Earlier";
    const weekdays = [_][]const u8{ "Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday" };
    const months = [_][]const u8{ "January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December" };
    if (days < 7) return weekdays[@intCast(tm.tm_wday)];
    const month = months[@intCast(tm.tm_mon)];
    const this_year = if (local(now)) |today| today.tm_year == tm.tm_year else true;
    if (this_year) return std.fmt.bufPrint(buf, "{s} {d}", .{ month, tm.tm_mday }) catch month;
    return std.fmt.bufPrint(buf, "{s} {d}, {d}", .{ month, tm.tm_mday, tm.tm_year + 1900 }) catch month;
}
fn ageLabel(buf: []u8, seconds: i64) []const u8 {
    const s = @max(0, seconds);
    const Unit = struct { below: i64, size: i64, name: []const u8 };
    const units = [_]Unit{
        .{ .below = 3600, .size = 60, .name = "m" },
        .{ .below = 86400, .size = 3600, .name = "h" },
        .{ .below = 14 * 86400, .size = 86400, .name = "d" },
        .{ .below = 60 * 86400, .size = 7 * 86400, .name = "w" },
        .{ .below = std.math.maxInt(i64), .size = 30 * 86400, .name = "mo" },
    };
    for (units) |unit| if (s < unit.below) {
        return std.fmt.bufPrint(buf, "{d}{s}", .{ @max(1, @divTrunc(s, unit.size)), unit.name }) catch "";
    };
    unreachable;
}

fn testEntry(session: []const u8, cwd: []const u8, title: []const u8, updated_at: i64) Entry {
    return .{ .provider = .claude, .session = session, .title = title, .first = title, .last = "last", .cwd = cwd, .updated_at = updated_at };
}

test "collapsed shows this folder's newest closed conversations, then more" {
    var entries: [9]Entry = undefined;
    const names = "abcdefghi";
    for (&entries, 0..) |*e, i| e.* = testEntry(names[i..][0..1], "/w/corgi", "Work", 900 - @as(i64, @intCast(i)));
    entries[1].chore = true;
    entries[2].cwd = "/w/other";
    const open = [_]Open{.{ .provider = .claude, .session = .initTruncated("d"), .pane = @enumFromInt(4) }};
    const c: Context = .{ .history = .{ .pending = false, .entries = &entries }, .folder = "/w/corgi", .workspace_folder = "/w", .open = &open, .now = 1000 };
    var v: View = .{};
    var storage: [max_lines]Line = undefined;
    const rows = v.lines(c, &storage);
    // a, e, f, g, h and i are listed; b is a chore, c is in another folder
    // of the workspace, d is open.
    try std.testing.expectEqual(@as(usize, collapsed_rows + 1), rows.len);
    try std.testing.expectEqual(@as(u16, 0), rows[0].entry);
    try std.testing.expectEqual(@as(u16, 4), rows[1].entry);
    // The search starts on the workspace, so c counts among the rest.
    try std.testing.expectEqual(@as(u16, 2), rows[collapsed_rows].more);
    try std.testing.expect(v.move(c, rows, 10));
    try std.testing.expect(v.entry(c, rows) == null);
    try std.testing.expect(v.move(c, rows, -10));
    try std.testing.expectEqualStrings("a", v.entry(c, rows).?.session);
    // At the top, moving up leaves the list.
    try std.testing.expect(!v.move(c, rows, -1));
}

test "expanded groups by day and widens; search finds open conversations and counts the rest" {
    const entries = [_]Entry{
        testEntry("a", "/w/corgi", "Sidebar flicker fix", 900),
        testEntry("b", "/w/other", "Sidebar width", 800),
        testEntry("c", "/w/corgi", "Sidebar scroll", 700),
    };
    const open = [_]Open{.{ .provider = .claude, .session = .initTruncated("c"), .pane = @enumFromInt(4) }};
    const c: Context = .{ .history = .{ .pending = false, .entries = &entries }, .folder = "/w/corgi", .workspace_folder = "/w/corgi", .open = &open, .now = 1000 };
    var v: View = .{};
    v.expand();
    try std.testing.expectEqual(Scope.workspace, v.scope);
    var storage: [max_lines]Line = undefined;
    var rows = v.lines(c, &storage);
    try std.testing.expectEqual(@as(usize, 2), rows.len);
    try std.testing.expect(rows[0] == .day);
    v.nextScope(true);
    rows = v.lines(c, &storage);
    try std.testing.expectEqual(@as(usize, 3), rows.len);
    v.nextScope(true);
    v.startSearch();
    for ("sidebar") |ch| _ = v.query.key(ch);
    rows = v.lines(c, &storage);
    try std.testing.expectEqual(@as(usize, 5), rows.len);
    try std.testing.expect(rows[0].heading == .open);
    try std.testing.expectEqual(@as(u16, 2), rows[1].open);
    try std.testing.expect(rows[2].heading == .results);
    try std.testing.expectEqual(@as(u16, 0), rows[3].entry);
    try std.testing.expectEqual(@as(u16, 1), rows[4].elsewhere);
    // The open match comes first, so it is what Enter jumps to.
    try std.testing.expectEqualStrings("Sidebar scroll", v.entry(c, rows).?.title);
    for (" fix") |ch| _ = v.query.key(ch);
    rows = v.lines(c, &storage);
    try std.testing.expectEqual(@as(usize, 2), rows.len);
    try std.testing.expectEqualStrings("Sidebar flicker fix", v.entry(c, rows).?.title);
    v.collapse();
    try std.testing.expect(!v.expanded and !v.searching);
    try std.testing.expectEqual(Scope.workspace, v.scope);
}

test "a run of one agent names it once" {
    var entries = [_]Entry{
        testEntry("a", "/w/corgi", "Sticky agent", 900),
        testEntry("b", "/w/corgi", "Unread hotkey", 800),
        testEntry("c", "/w/corgi", "CPU check", 700),
        testEntry("d", "/w/corgi", "Compacting", 600),
        testEntry("e", "/w/corgi", "Review", 500),
    };
    entries[2].provider = .codex;
    entries[3].provider = .codex;
    const c: Context = .{ .history = .{ .pending = false, .entries = &entries }, .folder = "/w/corgi", .workspace_folder = "/w/corgi", .open = &.{}, .now = 1000 };
    var v: View = .{};
    var storage: [max_lines]Line = undefined;
    const rows = v.lines(c, &storage);
    var named: [collapsed_rows]bool = undefined;
    for (&named, 0..) |*n, i| n.* = startsRun(c, rows, i, 0);
    try std.testing.expectEqualSlices(bool, &.{ true, false, true, false, true }, &named);
    // A list scrolled past a run's first row names it again.
    try std.testing.expect(startsRun(c, rows, 1, 1));
    // Show more.
    try std.testing.expect(!startsRun(c, rows, rows.len - 1, 0));
}

test "day headings and ages" {
    var buf: [32]u8 = undefined;
    const now = dayStart(1_790_000_000) + 12 * 3600;
    try std.testing.expectEqualStrings("Today", dayLabel(&buf, now - 3600, now));
    try std.testing.expectEqualStrings("Yesterday", dayLabel(&buf, now - 86400, now));
    try std.testing.expectEqualStrings("36m", ageLabel(&buf, 36 * 60));
    try std.testing.expectEqualStrings("3d", ageLabel(&buf, 3 * 86400 + 5));
    try std.testing.expectEqualStrings("5w", ageLabel(&buf, 35 * 86400));
}

test "a conversation closed here comes first, under the name the sidebar showed" {
    var entries: [7]Entry = undefined;
    const names = "abcdefg";
    for (&entries, 0..) |*e, i| e.* = testEntry(names[i..][0..1], "/w/corgi", "Busy", 900 - @as(i64, @intCast(i)));
    // "review" last wrote its transcript long before it was closed.
    entries[6].title = "5b5101b6 review";
    entries[6].updated_at = 100;
    const known = [_]Known{
        .{ .provider = .claude, .session = "g", .name = "Review of 5b5101b6", .at = 500 },
        .{ .provider = .claude, .session = "g", .at = 1000 },
    };
    var arena: std.heap.ArenaAllocator = .init(std.testing.allocator);
    defer arena.deinit();
    const merged = try merge(arena.allocator(), &entries, &known);
    const c: Context = .{ .history = .{ .pending = false, .entries = merged }, .folder = "/w/corgi", .workspace_folder = "/w", .open = &.{}, .now = 1000 };
    var v: View = .{};
    var storage: [max_lines]Line = undefined;
    const rows = v.lines(c, &storage);
    try std.testing.expectEqualStrings("Review of 5b5101b6", v.entry(c, rows).?.title);
    try std.testing.expectEqual(@as(i64, 1000), v.entry(c, rows).?.updated_at);
}
