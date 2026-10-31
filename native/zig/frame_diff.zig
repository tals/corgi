//! The host terminal's screen as the viewer last left it. A frame that changes
//! only cells is written as the runs that differ. Kitty commands that leave
//! the cursor in place travel separately; other controls keep the full-frame fallback.
const std = @import("std");
const vt = @import("ghostty-vt");
const os = @import("os.zig");
const a = os.allocator;

pub const Differ = struct {
    vt: vt.Terminal,
    stream: vt.TerminalStream,
    render: vt.RenderState = .empty,
    cols: u16,
    rows: u16,
    saved: []OwnedRow,
    scratch: OwnedRow,
    changed: []bool,
    damage: []std.ArrayList(Range),
    receipts: std.ArrayList(Receipt) = .empty,
    controls: u64 = 0,
    images: u64 = 0,
    images_stale: bool = false,
    has_images: bool = false,
    image_fallback: bool = false,
    cursor: Cursor = .{},
    stale: bool = true,
    chrome_valid: bool = false,
    timing: ?*Timing = null,
    damaged_rows: u64 = 0,
    compared_cells: u64 = 0,

    pub const Cursor = struct { x: u16 = 0, y: u16 = 0, visible: bool = false };
    pub const ChromeMode = enum(u8) { full, reuse };
    pub const Pane = struct {
        state: *const vt.RenderState,
        identity: u64 = 0,
        epochs: []const u64 = &.{},
        x: u16,
        y: u16,
        w: u16,
        h: u16,
        fn id(p: Pane) u64 {
            return if (p.identity != 0) p.identity else @intFromPtr(p.state);
        }
    };
    pub const Timing = struct { parse_ns: u64 = 0, render_ns: u64 = 0, compare_ns: u64 = 0, emit_ns: u64 = 0 };
    const Range = struct { first: usize, end: usize };
    const Raw = @FieldType(vt.RenderState.Cell, "raw");
    const Cell = struct {
        raw: Raw,
        style: vt.Style,
        managed: ?*const Managed = null,
        inline fn grapheme(c: Cell) []const u21 {
            return if (c.managed) |value| value.grapheme else &.{};
        }
        inline fn target(c: Cell) ?Link {
            return if (c.managed) |value| value.target else null;
        }
        inline fn eqlSource(c: Cell, cells: std.MultiArrayList(vt.RenderState.Cell), pin: vt.Pin, col: usize, colors: ?*const vt.RenderState) bool {
            const original = cells.items(.raw)[col];
            if (@as(u64, @bitCast(c.raw)) != @as(u64, @bitCast(visibleRaw(original, colors != null))) or !c.style.eql(cellStyle(cells, col, colors))) return false;
            if (original.content_tag == .codepoint_grapheme and !std.mem.eql(u21, c.grapheme(), cells.items(.grapheme)[col])) return false;
            if (original.hyperlink) return sameLink(c.target(), link(pin, col));
            return c.target() == null;
        }
    };
    const Managed = struct {
        grapheme: []const u21 = &.{},
        target: ?Link = null,
    };
    const OwnedRow = struct {
        cells: []Cell,
        arena: std.heap.ArenaAllocator,
        valid: bool = false,
        fn init(cols: usize) !OwnedRow {
            return .{ .cells = try a.alloc(Cell, cols), .arena = .init(a) };
        }
        fn deinit(r: *OwnedRow) void {
            r.arena.deinit();
            a.free(r.cells);
        }
        inline fn put(r: *OwnedRow, col: usize, source: Cell) !void {
            r.cells[col] = source;
            if (source.managed) |value| r.cells[col].managed = try r.copyManaged(col, value.grapheme, value.target);
        }
        inline fn putSource(r: *OwnedRow, col: usize, cells: std.MultiArrayList(vt.RenderState.Cell), pin: vt.Pin, source_col: usize, colors: ?*const vt.RenderState) !void {
            const original = cells.items(.raw)[source_col];
            r.cells[col] = .{ .raw = visibleRaw(original, colors != null), .style = cellStyle(cells, source_col, colors) };
            if (original.content_tag == .codepoint_grapheme or original.hyperlink) {
                r.cells[col].managed = try r.copyManaged(col, if (original.content_tag == .codepoint_grapheme) cells.items(.grapheme)[source_col] else &.{}, if (original.hyperlink) link(pin, source_col) else null);
            }
        }
        fn copyManaged(r: *OwnedRow, col: usize, grapheme: []const u21, target: ?Link) !?*const Managed {
            if (grapheme.len == 0 and target == null) return null;
            const previous = if (col > 0) r.cells[col - 1].managed else null;
            if (previous) |value| if (std.mem.eql(u21, value.grapheme, grapheme) and sameLink(value.target, target)) return value;
            const alloc = r.arena.allocator();
            const value = try alloc.create(Managed);
            value.* = .{};
            if (grapheme.len > 0) value.grapheme = try alloc.dupe(u21, grapheme);
            if (target) |item| {
                if (previous != null and sameLink(previous.?.target, target)) {
                    value.target = previous.?.target;
                } else value.target = .{ .uri = try alloc.dupe(u8, item.uri), .id = if (item.id) |id| try alloc.dupe(u8, id) else null };
            }
            return value;
        }
    };
    const Receipt = struct {
        valid: bool = false,
        identity: u64 = 0,
        x: u16 = 0,
        y: u16 = 0,
        w: u16 = 0,
        h: u16 = 0,
        epochs: std.ArrayList(u64) = .empty,
        fn matches(r: Receipt, p: Pane) bool {
            return r.valid and r.identity == p.id() and r.x == p.x and r.y == p.y and r.w == p.w and r.h == p.h;
        }
    };
    const Span = struct { state: *const vt.RenderState, row: usize, col: usize, len: usize };
    const Parsed = struct { controls: u64, images: std.Io.Writer.Allocating, image_hash: u64, image_fallback: bool };
    const Paint = struct { style: ?vt.Style = null, open: ?Link = null };

    fn stamp(d: *const Differ) i96 {
        return if (d.timing != null) std.Io.Timestamp.now(os.io(), .awake).toNanoseconds() else 0;
    }
    fn record(d: *Differ, comptime field: std.meta.FieldEnum(Timing), start: i96) void {
        if (d.timing) |timing| @field(timing, @tagName(field)) += @intCast(d.stamp() - start);
    }
    pub fn create(cols: u16, rows: u16) !*Differ {
        const d = try a.create(Differ);
        errdefer a.destroy(d);
        var terminal = try vt.Terminal.init(os.io(), a, .{ .cols = cols, .rows = rows, .max_scrollback_bytes = 0 });
        errdefer terminal.deinit(a);
        const saved = try a.alloc(OwnedRow, rows);
        errdefer a.free(saved);
        var initialized: usize = 0;
        errdefer for (saved[0..initialized]) |*row| row.deinit();
        for (saved) |*row| {
            row.* = try OwnedRow.init(cols);
            initialized += 1;
        }
        var scratch = try OwnedRow.init(cols);
        errdefer scratch.deinit();
        const changed = try a.alloc(bool, cols);
        errdefer a.free(changed);
        const damage = try a.alloc(std.ArrayList(Range), rows);
        @memset(damage, .empty);
        d.* = .{ .vt = terminal, .stream = undefined, .cols = cols, .rows = rows, .saved = saved, .scratch = scratch, .changed = changed, .damage = damage };
        d.stream = .init(.{ .handler = d.vt.vtHandler(), .allocator = a });
        return d;
    }
    pub fn destroy(d: *Differ) void {
        d.stream.deinit();
        d.render.deinit(a);
        d.vt.deinit(a);
        for (d.saved) |*row| row.deinit();
        d.scratch.deinit();
        a.free(d.saved);
        a.free(d.changed);
        for (d.damage) |*ranges| ranges.deinit(a);
        a.free(d.damage);
        for (d.receipts.items) |*receipt| receipt.epochs.deinit(a);
        d.receipts.deinit(a);
        a.destroy(d);
    }
    pub fn invalidate(d: *Differ) void {
        d.stale = true;
        d.chrome_valid = false;
        for (d.receipts.items) |*receipt| receipt.valid = false;
    }
    pub fn managedCapacity(d: *const Differ) u64 {
        var bytes: u64 = d.scratch.arena.queryCapacity();
        for (d.saved) |row| bytes += row.arena.queryCapacity();
        return bytes;
    }
    fn resetDamage(d: *Differ) void {
        for (d.damage) |*ranges| ranges.clearRetainingCapacity();
        d.damaged_rows = 0;
        d.compared_cells = 0;
    }
    fn addDamage(d: *Differ, row: usize, first: usize, end: usize) !void {
        if (first < end) try d.damage[row].append(a, .{ .first = first, .end = end });
    }
    fn rectangle(d: *Differ, x: u16, y: u16, w: u16, h: u16) !void {
        for (y..@as(usize, y) + h) |row| try d.addDamage(row, x, @as(usize, x) + w);
    }
    fn normalize(ranges: *std.ArrayList(Range)) void {
        std.mem.sort(Range, ranges.items, {}, struct {
            fn less(_: void, l: Range, r: Range) bool {
                return l.first < r.first;
            }
        }.less);
        var len: usize = 0;
        for (ranges.items) |range| {
            if (len > 0 and range.first <= ranges.items[len - 1].end) {
                ranges.items[len - 1].end = @max(ranges.items[len - 1].end, range.end);
            } else {
                ranges.items[len] = range;
                len += 1;
            }
        }
        ranges.shrinkRetainingCapacity(len);
    }
    fn sourceSpan(d: *Differ, panes: []const Pane, row: usize, col: usize, end: usize) Span {
        var stop = end;
        for (panes) |pane| {
            if (row < pane.y or row - pane.y >= pane.h) continue;
            if (col >= pane.x and col - pane.x < pane.w) return .{ .state = pane.state, .row = row - pane.y, .col = col - pane.x, .len = @min(end - col, @as(usize, pane.x) + pane.w - col) };
            if (pane.x > col) stop = @min(stop, pane.x);
        }
        return .{ .state = &d.render, .row = row, .col = col, .len = stop - col };
    }
    inline fn visibleRaw(original: Raw, pane: bool) Raw {
        var raw = original;
        raw.style_id = 0;
        raw.hyperlink = false;
        raw.semantic_content = .output;
        if (pane and raw.wide == .narrow and raw.codepoint() == 0) {
            raw.content_tag = .codepoint;
            raw.content = .{ .codepoint = .{ .data = ' ' } };
        }
        return raw;
    }
    fn compareRow(d: *Differ, panes: []const Pane, row: usize) bool {
        @memset(d.changed, false);
        var changed = false;
        for (d.damage[row].items) |range| {
            d.compared_cells += range.end - range.first;
            var col = range.first;
            while (col < range.end) {
                const span = d.sourceSpan(panes, row, col, range.end);
                const cells = span.state.row_data.items(.cells)[span.row];
                const pin = span.state.row_data.items(.pin)[span.row];
                for (0..span.len) |offset| {
                    const unequal = !d.saved[row].valid or !d.saved[row].cells[col + offset].eqlSource(cells, pin, span.col + offset, if (span.state == &d.render) null else span.state);
                    d.changed[col + offset] = unequal;
                    changed = changed or unequal;
                }
                col += span.len;
            }
        }
        return changed;
    }
    fn captureRow(d: *Differ, panes: []const Pane, row: usize) !void {
        _ = d.scratch.arena.reset(.retain_capacity);
        var col: usize = 0;
        for (d.damage[row].items) |range| {
            while (col < range.first) : (col += 1) try d.scratch.put(col, d.saved[row].cells[col]);
            while (col < range.end) {
                const span = d.sourceSpan(panes, row, col, range.end);
                const cells = span.state.row_data.items(.cells)[span.row];
                const pin = span.state.row_data.items(.pin)[span.row];
                for (0..span.len) |offset| try d.scratch.putSource(col + offset, cells, pin, span.col + offset, if (span.state == &d.render) null else span.state);
                col += span.len;
            }
        }
        while (col < d.cols) : (col += 1) try d.scratch.put(col, d.saved[row].cells[col]);
        d.scratch.valid = true;
    }
    fn begin(out: *std.Io.Writer, started: *bool) !void {
        if (started.*) return;
        try out.writeAll("\x1b[?2026h\x1b[?25l");
        started.* = true;
    }
    fn present(d: *Differ, out: *std.Io.Writer, panes: []const Pane, cursor: Cursor, image_bytes: []const u8, images_changed: bool, whole: ?[]const u8) !void {
        var started = false;
        var paint: Paint = .{};
        for (d.damage, 0..) |*ranges, row| {
            if (ranges.items.len == 0) continue;
            normalize(ranges);
            d.damaged_rows += 1;
            const comparing = d.stamp();
            if (whole == null and !d.compareRow(panes, row)) {
                d.record(.compare_ns, comparing);
                continue;
            }
            try d.captureRow(panes, row);
            d.record(.compare_ns, comparing);
            if (whole == null) {
                const emitting = d.stamp();
                try begin(out, &started);
                try d.emitRow(out, &paint, row);
                d.record(.emit_ns, emitting);
            }
            std.mem.swap(OwnedRow, &d.saved[row], &d.scratch);
        }
        const emitting = d.stamp();
        defer d.record(.emit_ns, emitting);
        if (whole) |frame| return out.writeAll(frame);
        if (!started and !images_changed and std.meta.eql(cursor, d.cursor)) return;
        try begin(out, &started);
        if (paint.open != null) try out.writeAll("\x1b]8;;\x1b\\");
        if (paint.style != null) try out.writeAll("\x1b[0m");
        if (images_changed) try out.writeAll(image_bytes);
        try out.print("\x1b[{d};{d}H", .{ cursor.y + 1, cursor.x + 1 });
        if (cursor.visible) try out.writeAll("\x1b[?25h");
        try out.writeAll("\x1b[?2026l");
    }
    fn emitRow(d: *Differ, out: *std.Io.Writer, paint: *Paint, row: usize) !void {
        const cells = d.scratch.cells;
        var first = std.mem.indexOfScalar(bool, d.changed, true) orelse return;
        while (first > 0 and (cells[first].raw.wide == .spacer_tail or (d.saved[row].valid and d.saved[row].cells[first].raw.wide == .spacer_tail))) first -= 1;
        try out.print("\x1b[{d};{d}H", .{ row + 1, first + 1 });
        while (first < d.cols) {
            var end = first + 1;
            while (end < d.cols and (d.changed[end] or cells[end].raw.wide == .spacer_tail)) end += 1;
            try writeCells(out, paint, cells, first, end);
            var next = end;
            while (next < d.cols and !d.changed[next]) next += 1;
            if (next == d.cols) break;
            while (next > end and cells[next].raw.wide == .spacer_tail) next -= 1;
            if (bridgeGap(paint.*, cells, row, end, next)) {
                try writeCells(out, paint, cells, end, next);
            } else try out.print("\x1b[{d};{d}H", .{ row + 1, next + 1 });
            first = next;
        }
    }
    pub fn diff(d: *Differ, out: *std.Io.Writer, frame: []const u8) !void {
        const stale = d.stale;
        d.invalidate();
        d.resetDamage();
        var parsed = try d.parse(frame);
        defer parsed.images.deinit();
        for (0..d.rows) |row| try d.addDamage(row, 0, d.cols);
        const screen = d.vt.screens.active;
        const cursor: Cursor = .{ .x = @intCast(screen.cursor.x), .y = @intCast(screen.cursor.y), .visible = d.vt.modes.get(.cursor_visible) };
        const whole = stale or parsed.controls != d.controls or parsed.image_fallback or d.image_fallback;
        try d.present(out, &.{}, cursor, parsed.images.written(), d.images_stale or parsed.image_hash != d.images, if (whole) frame else null);
        d.commit(&parsed, cursor);
    }
    pub fn compose(d: *Differ, out: *std.Io.Writer, chrome: ?[]const u8, panes: []const Pane, cursor: Cursor, mode: ChromeMode) !bool {
        d.resetDamage();
        if (d.stale or d.image_fallback or cursor.x >= d.cols or cursor.y >= d.rows) return false;
        if (mode != .full and (!d.chrome_valid or d.images_stale or !d.defaultModes())) return false;
        if (mode != .reuse and chrome == null) return false;
        for (panes, 0..) |pane, i| {
            if (!d.validPane(pane)) return false;
            for (panes[0..i]) |previous| if (@as(u32, pane.x) < @as(u32, previous.x) + previous.w and @as(u32, previous.x) < @as(u32, pane.x) + pane.w and
                @as(u32, pane.y) < @as(u32, previous.y) + previous.h and @as(u32, previous.y) < @as(u32, pane.y) + pane.h) return false;
        }
        d.stale = true;
        var parsed: ?Parsed = null;
        defer if (parsed) |*value| value.images.deinit();
        if (mode == .full) {
            parsed = try d.parse(chrome.?);
            if (parsed.?.controls != d.controls or parsed.?.image_fallback or !d.defaultModes()) return false;
        }
        if (mode != .reuse) {
            for (0..d.rows) |row| if (d.render.dirty == .full or d.render.row_data.items(.dirty)[row]) {
                var col: usize = 0;
                while (col < d.cols) {
                    const span = d.sourceSpan(panes, row, col, d.cols);
                    if (span.state == &d.render) try d.addDamage(row, col, col + span.len);
                    col += span.len;
                }
            };
        }
        for (panes) |pane| for (0..pane.h) |row| {
            const raw = d.render.row_data.items(.cells)[@as(usize, pane.y) + row].items(.raw);
            if (raw[pane.x].wide == .spacer_tail or raw[@as(usize, pane.x) + pane.w - 1].wide == .wide) return false;
        };
        for (d.receipts.items) |receipt| if (receipt.valid) {
            var found = false;
            for (panes) |pane| if (receipt.matches(pane)) {
                found = true;
                break;
            };
            if (!found) try d.rectangle(receipt.x, receipt.y, receipt.w, receipt.h);
        };
        for (panes) |pane| {
            const previous: ?*const Receipt = for (d.receipts.items) |*receipt| {
                if (receipt.matches(pane)) break receipt;
            } else null;
            for (0..pane.h) |row| {
                if (previous == null or pane.epochs.len != pane.h or previous.?.epochs.items.len != pane.h or previous.?.epochs.items[row] != pane.epochs[row])
                    try d.addDamage(@as(usize, pane.y) + row, pane.x, @as(usize, pane.x) + pane.w);
            }
        }
        while (d.receipts.items.len < panes.len) try d.receipts.append(a, .{});
        for (d.receipts.items[0..panes.len], panes) |*receipt, pane| try receipt.epochs.ensureTotalCapacity(a, pane.h);
        const image_bytes = if (parsed) |*value| value.images.written() else "";
        const images_changed = if (parsed) |value| d.images_stale or value.image_hash != d.images else false;
        try d.present(out, panes, cursor, image_bytes, images_changed, null);
        for (d.receipts.items[0..panes.len], panes) |*receipt, pane| {
            receipt.valid = true;
            receipt.identity = pane.id();
            receipt.x = pane.x;
            receipt.y = pane.y;
            receipt.w = pane.w;
            receipt.h = pane.h;
            receipt.epochs.resize(a, pane.h) catch unreachable;
            if (pane.epochs.len == pane.h) @memcpy(receipt.epochs.items, pane.epochs) else @memset(receipt.epochs.items, 0);
        }
        for (d.receipts.items[panes.len..]) |*receipt| receipt.valid = false;
        if (parsed) |*value| d.commit(value, cursor) else {
            d.cursor = cursor;
            d.stale = false;
        }
        d.chrome_valid = true;
        return true;
    }
    fn defaultModes(d: *const Differ) bool {
        const screen = d.vt.screens.active;
        return !d.vt.modes.get(.origin) and !d.vt.modes.get(.insert) and std.meta.eql(screen.charset, @as(@TypeOf(screen.charset), .{}));
    }
    fn validPane(d: *const Differ, pane: Pane) bool {
        const state = pane.state;
        if (pane.w == 0 or pane.h == 0 or state.cols != pane.w or state.rows != pane.h or @as(u32, pane.x) + pane.w > d.cols or @as(u32, pane.y) + pane.h > d.rows) return false;
        for (state.row_data.items(.selection)[0..pane.h]) |selection| if (selection != null) return false;
        for (state.row_data.items(.cells)[0..pane.h]) |cells| {
            const raw = cells.items(.raw);
            if (raw.len < pane.w or raw[0].wide == .spacer_tail or raw[pane.w - 1].wide == .wide) return false;
        }
        return true;
    }
    fn parse(d: *Differ, frame: []const u8) !Parsed {
        const parsing = d.stamp();
        var hasher = std.hash.Wyhash.init(0);
        var images: std.Io.Writer.Allocating = .init(a);
        errdefer images.deinit();
        var image_fallback = false;
        var chunks = false;
        var resets_images = std.mem.indexOfAny(u8, frame, "\n\x0b\x0c") != null;
        var start: usize = 0;
        var i: usize = 0;
        while (std.mem.indexOfScalarPos(u8, frame, i, 0x1b)) |at| {
            const sequence = scan(frame[at..]);
            i = at + sequence.len;
            if (sequence.kind == .cells) continue;
            d.stream.nextSlice(frame[start..at]);
            if (sequence.kind == .image) {
                if (!imageCommand(frame[at..i], &chunks)) image_fallback = true;
                const cursor = d.vt.screens.active.cursor;
                try images.writer.print("\x1b[{d};{d}H", .{ cursor.y + 1, cursor.x + 1 });
                try images.writer.writeAll(frame[at..i]);
            } else {
                if (sequence.kind == .reset) resets_images = true;
                hasher.update(frame[at..i]);
                d.stream.nextSlice(frame[at..i]);
            }
            start = i;
        }
        d.stream.nextSlice(frame[start..]);
        const image_hash = std.hash.Wyhash.hash(0, images.written());
        image_fallback = image_fallback or chunks or (resets_images and (images.written().len > 0 or d.has_images));
        d.record(.parse_ns, parsing);
        try d.updateRender();
        return .{ .controls = hasher.final(), .images = images, .image_hash = image_hash, .image_fallback = image_fallback };
    }
    fn updateRender(d: *Differ) !void {
        const rendering = d.stamp();
        d.render.clean();
        try d.render.update(a, &d.vt);
        d.record(.render_ns, rendering);
    }
    fn commit(d: *Differ, parsed: *Parsed, cursor: Cursor) void {
        d.controls = parsed.controls;
        d.images = parsed.image_hash;
        d.images_stale = false;
        d.has_images = parsed.images.written().len > 0;
        d.image_fallback = parsed.image_fallback;
        d.cursor = cursor;
        d.stale = false;
    }
    inline fn cellStyle(cells: anytype, col: usize, colors: ?*const vt.RenderState) vt.Style {
        const cell = cells.items(.raw)[col];
        var style: vt.Style = switch (cell.content_tag) {
            .bg_color_palette => .{ .bg_color = .{ .palette = cell.content.color_palette.data } },
            .bg_color_rgb => .{ .bg_color = .{ .rgb = .{ .r = cell.content.color_rgb.r, .g = cell.content.color_rgb.g, .b = cell.content.color_rgb.b } } },
            else => if (cell.style_id == 0) .{} else cells.items(.style)[col],
        };
        // Pane colors belong to its terminal; chrome defaults belong to the host.
        if (colors) |state| {
            var fg = style.fg(.{ .default = state.colors.foreground, .palette = &state.colors.palette });
            var bg = style.bg(&cell, &state.colors.palette) orelse state.colors.background;
            if (style.flags.inverse) std.mem.swap(vt.color.RGB, &fg, &bg);
            style.fg_color = .{ .rgb = fg };
            style.bg_color = .{ .rgb = bg };
            style.flags.inverse = false;
        }
        return style;
    }
    fn digits(value: usize) usize {
        var n = value;
        var count: usize = 1;
        while (n >= 10) : (n /= 10) count += 1;
        return count;
    }
    fn bridgeGap(paint: Paint, cells: []const Cell, row: usize, from: usize, to: usize) bool {
        const move_bytes = 4 + digits(row + 1) + digits(to + 1);
        if (to - from > move_bytes) return false;
        if (paint.open == null) if (paint.style) |style| {
            var bytes: usize = 0;
            var col = from;
            while (col < to) : (col += 1) {
                const cell = cells[col];
                if (cell.raw.wide == .spacer_tail) continue;
                if (cell.target() != null or !style.eql(cell.style)) break;
                bytes += if (cell.raw.wide == .spacer_head or cell.raw.codepoint() == 0) 1 else std.unicode.utf8CodepointSequenceLength(cell.raw.codepoint()) catch 1;
                for (cell.grapheme()) |extra| bytes += std.unicode.utf8CodepointSequenceLength(extra) catch 1;
                if (bytes > move_bytes) return false;
            }
            if (col == to) return true;
        };
        var across_bytes: [256]u8 = undefined;
        var jump_bytes: [256]u8 = undefined;
        var across: std.Io.Writer = .fixed(&across_bytes);
        var jump: std.Io.Writer = .fixed(&jump_bytes);
        var across_paint = paint;
        var jump_paint = paint;
        writeCells(&across, &across_paint, cells, from, to + 1) catch return false;
        jump.print("\x1b[{d};{d}H", .{ row + 1, to + 1 }) catch return false;
        writeCells(&jump, &jump_paint, cells, to, to + 1) catch return false;
        return across.end <= jump.end;
    }
    fn writeCells(out: *std.Io.Writer, paint: *Paint, cells: []const Cell, first: usize, end: usize) !void {
        for (cells[first..end]) |cell| {
            if (cell.raw.wide == .spacer_tail) continue;
            const target = cell.target();
            if (!sameLink(paint.open, target)) {
                if (paint.open != null) try out.writeAll("\x1b]8;;\x1b\\");
                if (target) |value| try out.print("\x1b]8;{s}{s};{s}\x1b\\", .{ if (value.id != null) "id=" else "", value.id orelse "", value.uri });
                paint.open = target;
            }
            if (paint.style == null or !paint.style.?.eql(cell.style)) {
                if (paint.style) |previous| try writeStyle(out, previous, cell.style) else try out.print("{f}", .{cell.style.formatterVt()});
                paint.style = cell.style;
            }
            const cp = cell.raw.codepoint();
            if (cell.raw.wide == .spacer_head or cp == 0 or cell.raw.content_tag == .bg_color_palette or cell.raw.content_tag == .bg_color_rgb) {
                try out.writeByte(' ');
                continue;
            }
            try writeCodepoint(out, cp);
            for (cell.grapheme()) |extra| try writeCodepoint(out, extra);
        }
    }
};

/// Only detach graphics whose execution cannot change the text cursor.
/// Ghostty parses the header; payload bytes are forwarded without decoding.
fn imageCommand(bytes: []const u8, chunks: *bool) bool {
    if (!std.mem.startsWith(u8, bytes, "\x1b_G") or !std.mem.endsWith(u8, bytes, "\x1b\\")) return false;
    const body = bytes[3 .. bytes.len - 2];
    const header = body[0 .. std.mem.indexOfScalar(u8, body, ';') orelse body.len];
    const command = vt.kitty.graphics.CommandParser.parseString(a, header) catch return false;
    defer command.deinit(a);
    if (chunks.* and command.control != .transmit) return false;
    switch (command.control) {
        .display, .transmit_and_display => {
            if (command.display().?.cursor_movement != .none) return false;
        },
        .transmit, .delete => {},
        else => return false,
    }
    chunks.* = if (command.transmission()) |t| t.more_chunks else false;
    return true;
}

/// A frame starts with a complete style; later cells only change attributes
/// that differ. SGR 22 clears both bold and faint, so restore either survivor.
fn writeStyle(out: *std.Io.Writer, previous: vt.Style, next: vt.Style) !void {
    if (next.default()) return out.writeAll("\x1b[0m");
    const old = previous.flags;
    const new = next.flags;
    if ((old.bold and !new.bold) or (old.faint and !new.faint)) {
        try out.writeAll("\x1b[22m");
        if (new.bold) try out.writeAll("\x1b[1m");
        if (new.faint) try out.writeAll("\x1b[2m");
    } else {
        if (!old.bold and new.bold) try out.writeAll("\x1b[1m");
        if (!old.faint and new.faint) try out.writeAll("\x1b[2m");
    }
    inline for (.{
        .{ "italic", 3, 23 },
        .{ "blink", 5, 25 },
        .{ "inverse", 7, 27 },
        .{ "invisible", 8, 28 },
        .{ "strikethrough", 9, 29 },
        .{ "overline", 53, 55 },
    }) |flag| {
        if (@field(old, flag[0]) != @field(new, flag[0]))
            try out.print("\x1b[{d}m", .{if (@field(new, flag[0])) @as(u8, flag[1]) else @as(u8, flag[2])});
    }
    if (old.underline != new.underline) try out.writeAll(switch (new.underline) {
        .none => "\x1b[24m",
        .single => "\x1b[4m",
        .double => "\x1b[4:2m",
        .curly => "\x1b[4:3m",
        .dotted => "\x1b[4:4m",
        .dashed => "\x1b[4:5m",
    });
    if (!previous.fg_color.eql(next.fg_color)) try writeColor(out, 38, next.fg_color);
    if (!previous.bg_color.eql(next.bg_color)) try writeColor(out, 48, next.bg_color);
    if (!previous.underline_color.eql(next.underline_color)) try writeColor(out, 58, next.underline_color);
}

fn writeColor(out: *std.Io.Writer, prefix: u8, color: vt.Style.Color) !void {
    switch (color) {
        .none => try out.print("\x1b[{d}m", .{prefix + 1}),
        .palette => |index| try out.print("\x1b[{d};5;{d}m", .{ prefix, index }),
        .rgb => |rgb| try out.print("\x1b[{d};2;{d};{d};{d}m", .{ prefix, rgb.r, rgb.g, rgb.b }),
    }
}

const Link = struct { uri: []const u8, id: ?[]const u8 };
fn link(pin: vt.Pin, col: usize) ?Link {
    const page = pin.node.page();
    const cell = page.getRowAndCell(@intCast(col), pin.y).cell;
    const id = page.lookupHyperlink(cell) orelse return null;
    const entry = page.hyperlink_set.get(page.memory, id);
    return .{
        .uri = entry.uri.slice(page.memory),
        .id = switch (entry.id) {
            .explicit => |value| value.slice(page.memory),
            .implicit => null,
        },
    };
}
fn sameLink(lhs: ?Link, rhs: ?Link) bool {
    const l = lhs orelse return rhs == null;
    const r = rhs orelse return false;
    return std.mem.eql(u8, l.uri, r.uri) and std.mem.eql(u8, l.id orelse "", r.id orelse "") and (l.id == null) == (r.id == null);
}
fn writeCodepoint(out: *std.Io.Writer, cp: u21) !void {
    var bytes: [4]u8 = undefined;
    const n = std.unicode.utf8Encode(cp, &bytes) catch return out.writeByte(' ');
    try out.writeAll(bytes[0..n]);
}

const Sequence = struct {
    len: usize,
    kind: enum { cells, image, control, reset },
};
/// Sorts the escape sequence at the start of `bytes`. Cells are what the
/// mirror can redraw: text, styles, links, cursor moves and erases within
/// the screen. Everything else is a control.
fn scan(bytes: []const u8) Sequence {
    if (bytes.len < 2) return .{ .len = bytes.len, .kind = .cells };
    switch (bytes[1]) {
        '_' => {
            const end = std.mem.indexOfPos(u8, bytes, 2, "\x1b\\") orelse return .{ .len = bytes.len, .kind = .image };
            return .{ .len = end + 2, .kind = .image };
        },
        ']' => {
            var end: usize = 2;
            const len = while (end < bytes.len) : (end += 1) {
                if (bytes[end] == 0x07) break end + 1;
                if (bytes[end] == 0x1b and end + 1 < bytes.len and bytes[end + 1] == '\\') break end + 2;
            } else bytes.len;
            return .{ .len = len, .kind = if (std.mem.startsWith(u8, bytes[2..], "8;")) .cells else .control };
        },
        '[' => {
            var end: usize = 2;
            while (end < bytes.len and (bytes[end] < 0x40 or bytes[end] > 0x7e)) end += 1;
            if (end == bytes.len) return .{ .len = bytes.len, .kind = .cells };
            const params = bytes[2..end];
            const kind: @FieldType(Sequence, "kind") = switch (bytes[end]) {
                // Cursor visibility is the cursor's; the frame's own
                // synchronized update is replaced by the diff's.
                'h', 'l' => if (std.mem.eql(u8, params, "?25") or std.mem.eql(u8, params, "?2026"))
                    .cells
                else if (std.mem.eql(u8, params, "?1049") or std.mem.eql(u8, params, "?1047") or std.mem.eql(u8, params, "?47"))
                    .reset
                else
                    .control,
                // A full clear also drops the host's images.
                'J' => if (std.mem.eql(u8, params, "2") or std.mem.eql(u8, params, "3")) .reset else .cells,
                // Scrolling can move image anchors along with the text.
                'S', 'T', 'L', 'M' => .reset,
                'q' => .control,
                else => .cells,
            };
            return .{ .len = end + 1, .kind = kind };
        },
        'c', 'D', 'E', 'M' => return .{ .len = 2, .kind = .reset },
        else => return .{ .len = 2, .kind = .cells },
    }
}

fn render(d: *Differ, frame: []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    errdefer out.deinit();
    try d.diff(&out.writer, frame);
    return out.toOwnedSlice();
}

fn paneRows(x: usize, y: usize, cols: usize, lines: []const []const u8) ![]u8 {
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    errdefer out.deinit();
    for (lines, 0..) |line, row| {
        try out.writer.print("\x1b[{d};{d}H\x1b[0;38;2;255;255;255;48;2;0;0;0m", .{ y + row + 1, x + 1 });
        for (0..cols) |_| try out.writer.writeByte(' ');
        try out.writer.print("\x1b[{d};{d}H{s}\x1b[0m", .{ y + row + 1, x + 1, line });
    }
    return out.toOwnedSlice();
}

test "composed chrome and multiple panes match complete frames" {
    const full = try Differ.create(40, 8);
    defer full.destroy();
    const composed = try Differ.create(40, 8);
    defer composed.destroy();
    var timing: Differ.Timing = .{};
    composed.timing = &timing;
    const left = try Differ.create(12, 2);
    defer left.destroy();
    const right = try Differ.create(12, 2);
    defer right.destroy();
    const panes = [_]Differ.Pane{
        .{ .state = &left.render, .x = 4, .y = 2, .w = 12, .h = 2 },
        .{ .state = &right.render, .x = 22, .y = 2, .w = 12, .h = 2 },
    };
    const samples = [_][2][]const u8{
        .{ "first", "second" },
        .{ "\x1b[1;38;2;90;100;110m🦊e\xcc\x81界\x1b[0m", "\x1b]8;id=corgi-17-deadbeef;https://example.com\x1b\\linked\x1b]8;;\x1b\\" },
        .{ "1234567890界", "\x1b[48;5;120;4:3munderline\x1b[0m" },
        .{ "a🦊b", "\x1b]8;id=corgi-21-cafe;https://other.example\x1b\\changed\x1b]8;;\x1b\\" },
    };
    for (samples, 0..) |lines, index| {
        const ordered = if (index % 2 == 0) panes else [_]Differ.Pane{ panes[1], panes[0] };
        for ([_]*Differ{ left, right }, 0..) |source, side| {
            const rows = try paneRows(0, 0, 12, &.{ lines[side], lines[1 - side] });
            defer std.testing.allocator.free(rows);
            const pane_frame = try std.fmt.allocPrint(std.testing.allocator, "\x1b[?7l{s}", .{rows});
            defer std.testing.allocator.free(pane_frame);
            const ignored = try render(source, pane_frame);
            defer std.testing.allocator.free(ignored);
        }
        const prefix = try std.fmt.allocPrint(std.testing.allocator, "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome {d}\x1b[6;3Hinline 界", .{index});
        defer std.testing.allocator.free(prefix);
        const suffix = "\x1b[0m\x1b[8;20H\x1b[?25h";
        const chrome = try std.fmt.allocPrint(std.testing.allocator, "{s}{s}", .{ prefix, suffix });
        defer std.testing.allocator.free(chrome);
        // The pane owns palette 120; its serialized equivalent uses that RGB.
        const canonical = [_][]const u8{ lines[0], if (index == 2) "\x1b[48;2;135;255;135;4:3munderline\x1b[0m" else lines[1] };
        const left_rows = try paneRows(4, 2, 12, &canonical);
        defer std.testing.allocator.free(left_rows);
        const right_rows = try paneRows(22, 2, 12, &.{ canonical[1], canonical[0] });
        defer std.testing.allocator.free(right_rows);
        const frame = try std.fmt.allocPrint(std.testing.allocator, "{s}{s}{s}{s}", .{ prefix, left_rows, right_rows, suffix });
        defer std.testing.allocator.free(frame);
        const expected = try render(full, frame);
        defer std.testing.allocator.free(expected);
        var actual: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer actual.deinit();
        const accepted = try composed.compose(&actual.writer, chrome, &ordered, .{ .x = 19, .y = 7, .visible = true }, .full);
        try std.testing.expectEqual(index != 0, accepted);
        if (!accepted) try composed.diff(&actual.writer, frame);
        try std.testing.expectEqualStrings(expected, actual.written());
        actual.clearRetainingCapacity();
        try std.testing.expect(try composed.compose(&actual.writer, chrome, &ordered, .{ .x = 19, .y = 7, .visible = true }, .full));
        try std.testing.expectEqualStrings("", actual.written());
        // Returning to full replay must compare against the composited cells.
        const whole = try render(composed, frame);
        defer std.testing.allocator.free(whole);
        try std.testing.expectEqualStrings("", whole);
    }
    try std.testing.expect(timing.parse_ns > 0 and timing.render_ns > 0 and timing.compare_ns > 0 and timing.emit_ns > 0);
}

test "composed frames reject overlap wide chrome edges and changed controls safely" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const source = try Differ.create(8, 2);
    defer source.destroy();
    const ignored = try render(source, "\x1b[H\x1b[Jnew");
    defer std.testing.allocator.free(ignored);
    const pane: Differ.Pane = .{ .state = &source.render, .x = 4, .y = 1, .w = 8, .h = 2 };
    const first = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome";
    const initial = try render(d, first);
    defer std.testing.allocator.free(initial);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try std.testing.expect(!try d.compose(&out.writer, first, &.{ pane, pane }, .{}, .full));
    try std.testing.expect(!d.stale);
    try std.testing.expect(!try d.compose(&out.writer, "\x1b[?7l\x1b[H\x1b[0m\x1b[J\x1b[2;4H界", &.{pane}, .{}, .full));
    try std.testing.expect(d.stale);
    const recover = try render(d, first);
    defer std.testing.allocator.free(recover);
    try std.testing.expectEqualStrings(first, recover);
    const control = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome\x1b]22;pointer\x1b\\";
    try std.testing.expect(!try d.compose(&out.writer, control, &.{pane}, .{}, .full));
    try std.testing.expect(d.stale);
    const fallback = try render(d, control);
    defer std.testing.allocator.free(fallback);
    try std.testing.expectEqualStrings(control, fallback);
    try std.testing.expectEqualStrings("", out.written());
}

test "composed chrome preserves cursor-independent Kitty image batches" {
    const full = try Differ.create(20, 4);
    defer full.destroy();
    const composed = try Differ.create(20, 4);
    defer composed.destroy();
    const source = try Differ.create(8, 2);
    defer source.destroy();
    const source_rows = try paneRows(0, 0, 8, &.{ "pane", "" });
    defer std.testing.allocator.free(source_rows);
    const source_frame = try std.fmt.allocPrint(std.testing.allocator, "\x1b[?7l{s}", .{source_rows});
    defer std.testing.allocator.free(source_frame);
    const ignored = try render(source, source_frame);
    defer std.testing.allocator.free(ignored);
    const panes = [_]Differ.Pane{.{ .state = &source.render, .x = 4, .y = 1, .w = 8, .h = 2 }};
    for (0..3) |step| {
        const prefix = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome";
        const suffix = try std.fmt.allocPrint(std.testing.allocator, "\x1b[1;{d}H\x1b_Ga=p,i=1,p=1,C=1\x1b\\\x1b[4;20H\x1b[?25l", .{step + 1});
        defer std.testing.allocator.free(suffix);
        const rows = try paneRows(4, 1, 8, &.{ "pane", "" });
        defer std.testing.allocator.free(rows);
        const frame = try std.fmt.allocPrint(std.testing.allocator, "{s}{s}{s}", .{ prefix, rows, suffix });
        defer std.testing.allocator.free(frame);
        const chrome = try std.fmt.allocPrint(std.testing.allocator, "{s}{s}", .{ prefix, suffix });
        defer std.testing.allocator.free(chrome);
        const expected = try render(full, frame);
        defer std.testing.allocator.free(expected);
        var actual: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer actual.deinit();
        if (step == 0) {
            try composed.diff(&actual.writer, frame);
        } else {
            try std.testing.expect(try composed.compose(&actual.writer, chrome, &panes, .{ .x = 19, .y = 3 }, .full));
        }
        try std.testing.expectEqualStrings(expected, actual.written());
    }
}

test "a frame that changes one cell writes that cell" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const first = "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mworld\x1b[0m\x1b[?2026l";
    const whole = try render(d, first);
    defer std.testing.allocator.free(whole);
    try std.testing.expectEqualStrings(first, whole);
    const same = try render(d, first);
    defer std.testing.allocator.free(same);
    try std.testing.expectEqualStrings("", same);
    const changed = try render(d, "\x1b[?1003h\x1b[?2026h\x1b[H\x1b[Jhello\x1b[2;1H\x1b[31mwOrld\x1b[0m\x1b[?2026l");
    defer std.testing.allocator.free(changed);
    try std.testing.expectEqualStrings("\x1b[?2026h\x1b[?25l\x1b[2;2H\x1b[0m\x1b[38;5;1mO\x1b[0m\x1b[2;6H\x1b[?25h\x1b[?2026l", changed);
}

test "a changed control sends the whole frame" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const frames = [_][]const u8{
        "\x1b[H\x1b[Jtext\x1b]22;default\x1b\\",
        "\x1b[H\x1b[Jtext\x1b]22;pointer\x1b\\",
        "\x1b[H\x1b[J\x1b[2;3H\x1b_Ga=p,i=1\x1b\\text",
        "\x1b[H\x1b[J\x1b[3;3H\x1b_Ga=p,i=1\x1b\\text",
    };
    for (frames) |frame| {
        const out = try render(d, frame);
        defer std.testing.allocator.free(out);
        try std.testing.expectEqualStrings(frame, out);
    }
}

test "a moved cursor is written without cells" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const first = try render(d, "\x1b[H\x1b[J$ \x1b[1;3H\x1b[?25h");
    defer std.testing.allocator.free(first);
    const moved = try render(d, "\x1b[H\x1b[J$ \x1b[2;5H\x1b[?25h");
    defer std.testing.allocator.free(moved);
    try std.testing.expectEqualStrings("\x1b[?2026h\x1b[?25l\x1b[2;5H\x1b[?25h\x1b[?2026l", moved);
}

test "wide characters and links are rewritten whole" {
    const d = try Differ.create(20, 2);
    defer d.destroy();
    const first = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://a.example\x1b\\ab\x1b]8;;\x1b\\界c");
    defer std.testing.allocator.free(first);
    const changed = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界d");
    defer std.testing.allocator.free(changed);
    try std.testing.expect(std.mem.indexOf(u8, changed, "\x1b]8;id=x;https://b.example\x1b\\") != null);
    try std.testing.expect(std.mem.indexOf(u8, changed, "界d") != null);
    const tail = try render(d, "\x1b[H\x1b[J\x1b]8;id=x;https://b.example\x1b\\ab\x1b]8;;\x1b\\界e");
    defer std.testing.allocator.free(tail);
    try std.testing.expect(std.mem.indexOf(u8, tail, "\x1b[1;5H") != null);
    try std.testing.expect(std.mem.indexOf(u8, tail, "界") == null);
}

test "pane row epochs survive intervening updates and independent consumers" {
    const first = try Differ.create(20, 4);
    defer first.destroy();
    const second = try Differ.create(20, 4);
    defer second.destroy();
    const source = try Differ.create(8, 2);
    defer source.destroy();
    var epochs = [_]u64{ 1, 1 };
    const pane: Differ.Pane = .{ .state = &source.render, .identity = 7, .epochs = &epochs, .x = 4, .y = 1, .w = 8, .h = 2 };
    const chrome = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome";
    const initial = try render(source, "\x1b[?7l\x1b[H\x1b[Jfirst\x1b[2;1Hsecond");
    defer std.testing.allocator.free(initial);
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    for ([_]*Differ{ first, second }) |d| {
        try d.diff(&out.writer, chrome);
        out.clearRetainingCapacity();
        try std.testing.expect(try d.compose(&out.writer, chrome, &.{pane}, .{}, .full));
        out.clearRetainingCapacity();
        try std.testing.expect(try d.compose(&out.writer, null, &.{pane}, .{}, .reuse));
        try std.testing.expectEqualStrings("", out.written());
        try std.testing.expectEqual(@as(u64, 0), d.damaged_rows);
        try std.testing.expectEqual(@as(u64, 0), d.compared_cells);
    }
    try std.testing.expect(try first.compose(&out.writer, null, &.{pane}, .{ .x = 3, .y = 3, .visible = true }, .reuse));
    try std.testing.expectEqualStrings("\x1b[?2026h\x1b[?25l\x1b[4;4H\x1b[?25h\x1b[?2026l", out.written());
    try std.testing.expectEqual(@as(u64, 0), first.compared_cells);
    out.clearRetainingCapacity();

    source.stream.nextSlice("\x1b[1;1HFIRST");
    try source.render.update(a, &source.vt);
    epochs[0] = 2;
    try std.testing.expect(try first.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 1), first.damaged_rows);
    try std.testing.expectEqual(@as(u64, 8), first.compared_cells);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "FIRST") != null);
    out.clearRetainingCapacity();
    // Clearing Ghostty's dirty flags cannot consume another differ's receipt.
    source.render.clean();
    source.stream.nextSlice("\x1b[2;1HSECOND");
    try source.render.update(a, &source.vt);
    epochs[1] = 3;
    source.render.clean();
    try source.render.update(a, &source.vt);
    try std.testing.expect(try second.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 2), second.damaged_rows);
    try std.testing.expectEqual(@as(u64, 16), second.compared_cells);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "FIRST") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "SECOND") != null);
    out.clearRetainingCapacity();
    try std.testing.expect(try first.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 1), first.damaged_rows);
    try std.testing.expectEqual(@as(u64, 8), first.compared_cells);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), "SECOND") != null);
}

test "retained managed cells own their bytes after the source is destroyed" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const source = try Differ.create(8, 2);
    var source_live = true;
    defer if (source_live) source.destroy();
    const initial = try render(source, "\x1b[?7l\x1b[H\x1b[J\x1b]8;id=owned-id;https://owned.example\x1b\\e\xcc\x81x\x1b]8;;\x1b\\");
    defer std.testing.allocator.free(initial);
    const pane: Differ.Pane = .{ .state = &source.render, .identity = 11, .epochs = &.{ 1, 1 }, .x = 4, .y = 1, .w = 8, .h = 2 };
    const chrome = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome";
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try d.diff(&out.writer, chrome);
    out.clearRetainingCapacity();
    try std.testing.expect(try d.compose(&out.writer, chrome, &.{pane}, .{}, .full));
    const original = source.render.row_data.items(.cells)[0].items(.grapheme)[0];
    try std.testing.expect(d.saved[1].cells[4].grapheme().ptr != original.ptr);
    source.destroy();
    source_live = false;
    try std.testing.expectEqualSlices(u21, &.{0x301}, d.saved[1].cells[4].grapheme());
    try std.testing.expectEqualStrings("https://owned.example", d.saved[1].cells[4].target().?.uri);
    try std.testing.expectEqualStrings("owned-id", d.saved[1].cells[4].target().?.id.?);
    // Dropping the pane damages its old rectangle and consumes only owned bytes.
    out.clearRetainingCapacity();
    try std.testing.expect(try d.compose(&out.writer, null, &.{}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 2), d.damaged_rows);
    try std.testing.expectEqual(@as(u64, 16), d.compared_cells);
    try std.testing.expect(d.saved[1].cells[4].target() == null);
    try std.testing.expectEqual(@as(usize, 0), d.saved[1].cells[4].grapheme().len);
}

test "pane identity geometry and full replay invalidate their own receipts" {
    const d = try Differ.create(20, 4);
    defer d.destroy();
    const source = try Differ.create(8, 2);
    defer source.destroy();
    const source_rows = try paneRows(0, 0, 8, &.{ "pane", "" });
    defer std.testing.allocator.free(source_rows);
    const source_frame = try std.fmt.allocPrint(std.testing.allocator, "\x1b[?7l{s}", .{source_rows});
    defer std.testing.allocator.free(source_frame);
    const initial = try render(source, source_frame);
    defer std.testing.allocator.free(initial);
    var pane: Differ.Pane = .{ .state = &source.render, .identity = 5, .epochs = &.{ 1, 1 }, .x = 4, .y = 1, .w = 8, .h = 2 };
    const chrome = "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome";
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try d.diff(&out.writer, chrome);
    out.clearRetainingCapacity();
    try std.testing.expect(try d.compose(&out.writer, chrome, &.{pane}, .{}, .full));
    out.clearRetainingCapacity();
    pane.identity = 6;
    try std.testing.expect(try d.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 16), d.compared_cells);
    try std.testing.expectEqualStrings("", out.written());
    pane.x = 8;
    try std.testing.expect(try d.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expectEqual(@as(u64, 24), d.compared_cells);
    try std.testing.expectEqual(@as(u21, 0), d.saved[1].cells[4].raw.codepoint());
    try std.testing.expectEqual(@as(u21, 'p'), d.saved[1].cells[8].raw.codepoint());
    out.clearRetainingCapacity();
    const moved_rows = try paneRows(8, 1, 8, &.{ "pane", "" });
    defer std.testing.allocator.free(moved_rows);
    const full = try std.fmt.allocPrint(std.testing.allocator, "\x1b[?7l\x1b[H\x1b[0m\x1b[Jchrome{s}\x1b[H\x1b[?25l", .{moved_rows});
    defer std.testing.allocator.free(full);
    try d.diff(&out.writer, full);
    try std.testing.expectEqualStrings("", out.written());
    try std.testing.expect(!try d.compose(&out.writer, null, &.{pane}, .{}, .reuse));
    try std.testing.expect(try d.compose(&out.writer, chrome, &.{pane}, .{}, .full));
    try std.testing.expectEqualStrings("", out.written());
    try std.testing.expect(d.chrome_valid);
}

test "native retained row layout diagnostic" {
    if (os.env("CORGI_NATIVE_LAYOUT_DIAGNOSTIC") == null) return;
    std.debug.print("retained layout: Cell={d} Style={d} Managed={d} OwnedRow={d} Receipt={d} Range={d} ArrayListRange={d} Differ={d}\n", .{ @sizeOf(Differ.Cell), @sizeOf(vt.Style), @sizeOf(Differ.Managed), @sizeOf(Differ.OwnedRow), @sizeOf(Differ.Receipt), @sizeOf(Differ.Range), @sizeOf(std.ArrayList(Differ.Range)), @sizeOf(Differ) });
    for ([_][2]u16{ .{ 160, 48 }, .{ 64, 12 } }) |size| {
        const d = try Differ.create(size[0], size[1]);
        defer d.destroy();
        var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer out.deinit();
        try d.diff(&out.writer, "\x1b[?7l\x1b[H\x1b[0m\x1b[J");
        var ranges: usize = 0;
        for (d.damage) |row| ranges += row.capacity;
        std.debug.print("retained {d}x{d}: cell_bytes={d} row_descriptors={d} damage_descriptors={d} damage_capacity_bytes={d} changed_bytes={d} managed_bytes={d}\n", .{ size[0], size[1], @as(usize, size[0]) * (1 + @as(usize, size[1])) * @sizeOf(Differ.Cell), @as(usize, size[1]) * @sizeOf(Differ.OwnedRow), @as(usize, size[1]) * @sizeOf(std.ArrayList(Differ.Range)), ranges * @sizeOf(Differ.Range), size[0], d.managedCapacity() });
    }
}
