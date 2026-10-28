const std = @import("std");
const pane = @import("pane");
const a = std.heap.c_allocator;
const Theme = @typeInfo(@TypeOf(pane.Terminal.applyTheme)).@"fn".param_types[1].?;
const Request = struct {
    op: enum { info, surface, image, pixels, search, select, selection, clearSelection, liveText, text, history, snapshot, fadedSnapshot, theme, paste, prefill, flush, refreshRedraw, tick, takeCopied, takePending, restore, adopt, stop, reap, links, probeFormat },
    pane: u32 = 0,
    offset: ?usize = null,
    text: []const u8 = "",
    skip: usize = 0,
    start_x: u16 = 0,
    start_y: u16 = 0,
    end_x: u16 = 0,
    end_y: u16 = 0,
    theme: ?Theme = null,
    now: i64 = 0,
    exited: bool = false,
    imported: bool = false,
    pid: i32 = -1,
    title_pid: i32 = 0,
    contents: ?[]const struct { mime: []const u8, data: []const u8 } = null,
};

pub export fn app_terminal_fd(t: *pane.Terminal, fd: i32, pid: i32) void {
    t.fd = fd;
    t.pid = pid;
    // The Bun owner handles process lifetime; Ghostty may write protocol replies.
    t.owner = .candidate;
}
pub export fn app_terminal_json(t: *pane.Terminal, data: [*]const u8, len: usize, out: [*]u8, cap: usize) i64 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const req = std.json.parseFromSliceLeaky(Request, alloc, data[0..len], .{ .ignore_unknown_fields = false }) catch |err| return failure(alloc, @errorName(err), out, cap);
    return perform(t, alloc, req, out, cap) catch |err| failure(alloc, @errorName(err), out, cap);
}
fn result(alloc: std.mem.Allocator, value: anytype, out: [*]u8, cap: usize) i64 {
    const bytes = std.json.Stringify.valueAlloc(alloc, .{ .value = value }, .{}) catch return -1;
    if (bytes.len > cap) return -@as(i64, @intCast(bytes.len));
    @memcpy(out[0..bytes.len], bytes);
    return @intCast(bytes.len);
}
fn failure(alloc: std.mem.Allocator, name: []const u8, out: [*]u8, cap: usize) i64 {
    const bytes = std.json.Stringify.valueAlloc(alloc, .{ .err = name }, .{}) catch return -1;
    if (bytes.len > cap) return -1;
    @memcpy(out[0..bytes.len], bytes);
    return @intCast(bytes.len);
}
fn perform(t: *pane.Terminal, alloc: std.mem.Allocator, req: Request, out: [*]u8, cap: usize) !i64 {
    switch (req.op) {
        .info => return result(alloc, .{
            .title = t.vt.getTitle() orelse "",
            .surface_identity = t.surface_identity,
            .surface_revision = t.surface_revision,
            .title_pid = t.title_pid,
            .title_revision = t.title_revision,
            .modes = pane.surface.modes(t),
            .initial_input = t.initial_input,
            .synchronized_since = t.synchronized_since,
            .active_screen = t.vt.screens.active_key,
            .cursor = .{ .x = t.vt.screens.active.cursor.x, .y = t.vt.screens.active.cursor.y },
            .synchronized_output = t.vt.modes.get(.synchronized_output),
        }, out, cap),
        .surface => return result(alloc, try pane.surface.captureView(alloc, @enumFromInt(req.pane), t, req.offset), out, cap),
        .image => return result(alloc, try t.graphics.chunk(alloc, req.text, req.skip), out, cap),
        .pixels => t.setCellSize(req.start_x, req.start_y),
        .links => {
            try t.updateRender();
            return result(alloc, t.hyperlinks(), out, cap);
        },
        .probeFormat => {
            var writer: std.Io.Writer.Allocating = .init(alloc);
            var formatter = pane.terminal.vt.formatter.TerminalFormatter.init(&t.vt, .{ .emit = .vt, .trim = false });
            formatter.extra = .all;
            try formatter.format(&writer.writer);
            const cursor = t.vt.screens.active.cursor;
            try writer.writer.print("\x1b[{d};{d}H", .{ cursor.y + 1, cursor.x + 1 });
            return result(alloc, writer.written(), out, cap);
        },
        .search => return result(alloc, try t.search(req.text, req.skip), out, cap),
        .select => try t.select(req.start_x, req.start_y, req.end_x, req.end_y),
        .clearSelection => try t.clearSelection(),
        .selection => {
            const text = try t.selectedText();
            defer a.free(text);
            return result(alloc, text, out, cap);
        },
        .history => {
            var writer: std.Io.Writer.Allocating = .init(alloc);
            const formatter: pane.terminal.vt.formatter.ScreenFormatter = .init(t.vt.screens.active, .{ .emit = .plain, .unwrap = true });
            try formatter.format(&writer.writer);
            return result(alloc, writer.written(), out, cap);
        },
        .snapshot, .fadedSnapshot => {
            const text = if (req.op == .snapshot) try t.snapshot() else try t.fadedSnapshot();
            defer a.free(text);
            return result(alloc, text, out, cap);
        },
        .text, .liveText => {
            const text = if (req.op == .text) try t.text() else try t.liveText();
            defer a.free(text);
            return result(alloc, text, out, cap);
        },
        .theme => if (req.theme) |theme| t.applyTheme(theme),
        .paste => {
            if (req.contents) |contents| {
                if (contents.len > 2) return error.InvalidContents;
                const decoded = try alloc.alloc(pane.terminal.vt.clipboard.Content, contents.len);
                for (contents, decoded) |content, *item| {
                    const bytes = try alloc.alloc(u8, try std.base64.standard.Decoder.calcSizeForSlice(content.data));
                    try std.base64.standard.Decoder.decode(bytes, content.data);
                    item.* = .{ .mime = content.mime, .data = bytes };
                }
                return result(alloc, try t.pasteEvent(decoded), out, cap);
            }
            return result(alloc, try t.pasteEvent(&.{.{ .mime = "text/plain", .data = req.text }}), out, cap);
        },
        .prefill => try t.prefill(req.text),
        .flush => t.flush(),
        .refreshRedraw => {
            const owner = t.owner;
            t.owner = .runtime;
            defer t.owner = owner;
            t.refreshRedraw(req.now);
            return result(alloc, t.redraw_pending or t.redraw_restore_at != null, out, cap);
        },
        .tick => {
            t.exited = req.exited;
            const changed = t.read();
            return result(alloc, .{ .changed = changed, .expecting = t.expecting() }, out, cap);
        },
        .reap => {
            t.pid = req.pid;
            t.imported = req.imported;
            t.exited = req.exited;
            const reaped = t.reap();
            return result(alloc, .{ .reaped = reaped, .exited = t.exited, .exit_status = t.exit_status }, out, cap);
        },
        .stop => t.stop(),
        .takeCopied => {
            const copied = t.copied;
            const written = result(alloc, copied, out, cap);
            if (written >= 0) {
                t.copied = null;
                if (copied) |bytes| a.free(bytes);
            }
            return written;
        },
        .takePending => {
            const written = result(alloc, t.pending.items, out, cap);
            if (written >= 0) t.pending.clearRetainingCapacity();
            return written;
        },
        .restore => {
            t.restoring = true;
            defer t.restoring = false;
            t.feed(req.text);
            t.title_pid = req.title_pid;
        },
        .adopt => {
            t.imported = true;
            t.redraw_pending = true;
        },
    }
    return result(alloc, true, out, cap);
}
