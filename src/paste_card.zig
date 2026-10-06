//! The card that says why a paste brought no image and what fixes it. It
//! opens above the focused pane's caret, pointing at where the paste would
//! have landed, until Esc, a click or the next key. Corgi captures the
//! mouse, so Ghostty opens its links only on Cmd+Shift-click, which skips
//! the capture; a plain click reaches Corgi, which copies the link.
const std = @import("std");
const palette = @import("palette.zig");
const sidebar = @import("sidebar.zig");
const layout = @import("layout.zig");
const Rect = layout.Rect;
const host_clipboard = @import("host_clipboard.zig");
const Notice = host_clipboard.Notice;

const title = " Image not pasted ";
const keycap = " esc ";
const close = " close ";
const download = "Download: ";
const copied_label = " Copied to clipboard ";
const open_hint = " ⇧⌘-click opens · click copies ";
/// Columns between the border and the text.
const pad = 3;
/// Border, blank, reason, blank, fix, the download link when there is one,
/// blank, border.
fn height(notice: *const Notice) u16 {
    return if (hasLink(notice)) 8 else 7;
}
fn hasLink(notice: *const Notice) bool {
    for (notice.fix()) |part| if (part.kind == .link) return true;
    return false;
}

const text = (palette.Style{ .fg = .text, .bg = .surface }).sgr();
const border = (palette.Style{ .fg = .line, .bg = .surface }).sgr();
const heading = (palette.Style{ .fg = .strong, .bg = .surface, .bold = true }).sgr();
const quiet = (palette.Style{ .fg = .faint, .bg = .surface }).sgr();
const pointer = (palette.Style{ .fg = .line }).sgr();
const check = (palette.Style{ .fg = .accent, .bg = .surface }).sgr();

pub const Caret = struct { x: u16, y: u16 };
pub const Placement = struct {
    x: u16,
    y: u16,
    w: u16,
    h: u16,
    /// The arrow at the caret: below the card, or above it when the card
    /// sits under the caret.
    arrow: ?struct { x: u16, y: u16, glyph: []const u8 } = null,
};

fn fixWidth(notice: *const Notice) usize {
    var n: usize = 0;
    for (notice.fix()) |part| n += sidebar.displayWidth(part.text.text());
    return n;
}

/// The card's width around `inner` columns of text. The top border holds
/// the title and the close hint with a dash either side.
fn frameWidth(inner: usize) u16 {
    return @intCast(@max(inner + 2 * pad + 2, 2 + title.len + 1 + keycap.len + close.len + 2));
}

/// Above the caret when the pane has room, else below it, else at the
/// pane's foot without an arrow when the caret is unknown. A narrow pane
/// shortens the download link; null when even the rest doesn't fit.
pub fn place(notice: *const Notice, pane: Rect, caret: ?Caret) ?Placement {
    const lines = @max(sidebar.displayWidth(notice.body.text()), fixWidth(notice));
    const full = if (hasLink(notice)) @max(lines, download.len + host_clipboard.nightly_url.len) else lines;
    const w = @min(frameWidth(full), pane.w);
    const h = height(notice);
    if (w < frameWidth(lines) or pane.h < h) return null;
    const c = caret orelse return .{ .x = pane.x, .y = pane.y + pane.h - h, .w = w, .h = h };
    const x = std.math.clamp(c.x -| 2, pane.x, pane.x + pane.w - w);
    if (c.y >= pane.y + h + 1) return .{ .x = x, .y = c.y - 1 - h, .w = w, .h = h, .arrow = .{ .x = c.x, .y = c.y - 1, .glyph = "▾" } };
    if (c.y + 2 + h <= pane.y + pane.h) return .{ .x = x, .y = c.y + 2, .w = w, .h = h, .arrow = .{ .x = c.x, .y = c.y + 1, .glyph = "▴" } };
    return null;
}

/// The card in the focused pane, at its caret.
pub fn locate(view: layout.View, panes: anytype, area: Rect, notice: *const Notice) ?Placement {
    if (view.model.count == 0) return null;
    var locations: [layout.max_panes]layout.Placement = undefined;
    for (view.placements(area, &locations)) |spot| {
        if (spot.id != view.selection.tabs[view.selection.active].focus) continue;
        for (panes) |p| if (p.id == spot.id) {
            const r = spot.rect;
            const caret: ?Caret = if (p.terminal.renderState().cursor.viewport) |c|
                (if (c.x < r.w and c.y < r.h) .{ .x = r.x + c.x, .y = r.y + c.y } else null)
            else
                null;
            return place(notice, r, caret);
        };
    }
    return null;
}

/// Whether (`x`, `y`) is on one of the card's links: "Ghostty Nightly" in
/// the fix, or the download URL under it.
pub fn linkAt(notice: *const Notice, at: Placement, x: u16, y: u16) bool {
    if (!hasLink(notice)) return false;
    const left = at.x + 1 + pad;
    if (y == at.y + 4) {
        var start: usize = left;
        for (notice.fix()) |part| {
            const end = start + sidebar.displayWidth(part.text.text());
            if (part.kind == .link and x >= start and x < end) return true;
            start = end;
        }
        return false;
    }
    if (y == at.y + 5) {
        const start = left + download.len;
        return x >= start and x < start + @min(host_clipboard.nightly_url.len, urlRoom(at));
    }
    return false;
}

fn urlRoom(at: Placement) usize {
    return (at.w - 2) -| (2 * pad + download.len);
}

/// Draws the card at `at`, leaving the cursor where it was. Its bottom
/// border says how to open the link, or that a click copied it.
pub fn draw(w: *std.Io.Writer, notice: *const Notice, at: Placement, copied: bool) !void {
    try w.writeAll("\x1b7");
    const inner: usize = at.w - 2;
    try w.print("\x1b[{d};{d}H{s}╭─{s}{s}{s}", .{ at.y + 1, at.x + 1, border, heading, title, border });
    for (0..at.w - (2 + title.len + keycap.len + close.len + 2)) |_| try w.writeAll("─");
    try w.writeAll(palette.keycap ++ keycap ++ quiet ++ close ++ border ++ "─╮");
    for (1..at.h - 1) |row| {
        try w.print("\x1b[{d};{d}H│{s}", .{ at.y + row + 1, at.x + 1, text });
        try w.splatByteAll(' ', inner);
        try w.writeAll(border ++ "│");
    }
    try w.print("\x1b[{d};{d}H╰", .{ at.y + at.h, at.x + 1 });
    const label: usize = if (copied) 2 + copied_label.len else if (hasLink(notice)) sidebar.displayWidth(open_hint) else 0;
    const shown = label > 0 and label + 2 <= inner;
    for (0..inner - if (shown) label + 1 else 0) |_| try w.writeAll("─");
    if (shown) {
        if (copied) try w.writeAll(" " ++ check ++ "✓" ++ text ++ copied_label ++ border) else try w.writeAll(quiet ++ open_hint ++ border);
        try w.writeAll("─");
    }
    try w.writeAll("╯");
    try w.print("\x1b[{d};{d}H{s}", .{ at.y + 3, at.x + 2 + pad, text });
    try sidebar.writeEllipsis(w, notice.body.text(), inner - 2 * pad);
    try w.print("\x1b[{d};{d}H", .{ at.y + 5, at.x + 2 + pad });
    for (notice.fix()) |part| switch (part.kind) {
        .text => try w.print("{s}{s}", .{ text, part.text.text() }),
        .link => try writeLink(w, part.text.text(), part.text.text().len),
        .key => try w.print("{s}{s}", .{ heading, part.text.text() }),
    };
    if (hasLink(notice)) {
        try w.print("\x1b[{d};{d}H{s}" ++ download, .{ at.y + 6, at.x + 2 + pad, text });
        try writeLink(w, host_clipboard.nightly_url, urlRoom(at));
    }
    if (at.arrow) |arrow| try w.print("\x1b[{d};{d}H{s}{s}", .{ arrow.y + 1, arrow.x + 1, pointer, arrow.glyph });
    try w.writeAll("\x1b[0m\x1b8");
}

/// A terminal hyperlink to Ghostty's nightly release, which the host opens
/// on the user's machine.
fn writeLink(w: *std.Io.Writer, label: []const u8, room: usize) !void {
    try w.writeAll(text ++ "\x1b]8;;" ++ host_clipboard.nightly_url ++ "\x1b\\\x1b[4m");
    try sidebar.writeEllipsis(w, label, room);
    try w.writeAll("\x1b[24m\x1b]8;;\x1b\\");
}

fn sample() Notice {
    var s: host_clipboard.State = .{ .support = .unsupported };
    s.terminalName("ghostty 1.3.1");
    return s.notice(.cmd, "Codex", "nocap").?;
}

test "the card opens above the caret, or below it when the pane has no room" {
    const notice = sample();
    const pane: Rect = .{ .x = 26, .y = 1, .w = 80, .h = 14 };
    const above = place(&notice, pane, .{ .x = 29, .y = 10 }).?;
    try std.testing.expectEqual(@as(u16, 27), above.x);
    try std.testing.expectEqual(@as(u16, 1), above.y);
    try std.testing.expectEqual(@as(u16, 8), above.h);
    try std.testing.expectEqual(@as(u16, 9), above.arrow.?.y);
    try std.testing.expectEqualStrings("▾", above.arrow.?.glyph);
    const below = place(&notice, pane, .{ .x = 29, .y = 3 }).?;
    try std.testing.expectEqual(@as(u16, 5), below.y);
    try std.testing.expectEqualStrings("▴", below.arrow.?.glyph);
    // Near the right edge the card stays inside the pane.
    try std.testing.expectEqual(pane.x + pane.w - above.w, place(&notice, pane, .{ .x = 94, .y = 10 }).?.x);
    // A narrow pane shortens the download link before giving up.
    try std.testing.expectEqual(@as(u16, 60), place(&notice, .{ .x = 0, .y = 0, .w = 60, .h = 14 }, .{ .x = 3, .y = 10 }).?.w);
    try std.testing.expect(place(&notice, .{ .x = 0, .y = 0, .w = 30, .h = 14 }, .{ .x = 3, .y = 9 }) == null);
    try std.testing.expect(place(&notice, .{ .x = 0, .y = 0, .w = 80, .h = 8 }, .{ .x = 3, .y = 4 }) == null);
    try std.testing.expect(place(&notice, pane, null).?.arrow == null);
}

test "the card shows its title, close key, reason and fix with a link" {
    const notice = sample();
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    const at = place(&notice, .{ .x = 26, .y = 1, .w = 80, .h = 14 }, .{ .x = 29, .y = 10 }).?;
    try draw(&out.writer, &notice, at, false);
    const drawn = out.written();
    try std.testing.expect(std.mem.startsWith(u8, drawn, "\x1b7"));
    try std.testing.expect(std.mem.endsWith(u8, drawn, "\x1b8"));
    for ([_][]const u8{
        title,
        palette.keycap ++ " esc ",
        " close ",
        "Ghostty 1.3.1 can't send images over SSH.",
        "\x1b]8;;" ++ host_clipboard.nightly_url ++ "\x1b\\\x1b[4mGhostty Nightly\x1b[24m",
        heading ++ "⌘+V",
        "Download: " ++ text ++ "\x1b]8;;" ++ host_clipboard.nightly_url ++ "\x1b\\\x1b[4m" ++ host_clipboard.nightly_url,
        "\x1b[10;30H" ++ pointer ++ "▾",
    }) |part| try std.testing.expect(std.mem.indexOf(u8, drawn, part) != null);
    try std.testing.expect(std.mem.indexOf(u8, drawn, "Copied") == null);
    try std.testing.expect(std.mem.indexOf(u8, drawn, quiet ++ open_hint ++ border ++ "─╯") != null);
    out.clearRetainingCapacity();
    try draw(&out.writer, &notice, at, true);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), check ++ "✓" ++ text ++ " Copied to clipboard ") != null);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), open_hint) == null);
}

test "both links answer the pointer, and nothing else on the card does" {
    const notice = sample();
    const at = place(&notice, .{ .x = 26, .y = 1, .w = 80, .h = 14 }, .{ .x = 29, .y = 10 }).?;
    const left = at.x + 1 + pad;
    // "Use " then "Ghostty Nightly" on the fix row.
    try std.testing.expect(!linkAt(&notice, at, left + 3, at.y + 4));
    try std.testing.expect(linkAt(&notice, at, left + 4, at.y + 4));
    try std.testing.expect(linkAt(&notice, at, left + 18, at.y + 4));
    try std.testing.expect(!linkAt(&notice, at, left + 19, at.y + 4));
    try std.testing.expect(!linkAt(&notice, at, left + 9, at.y + 5));
    try std.testing.expect(linkAt(&notice, at, left + 10, at.y + 5));
    try std.testing.expect(!linkAt(&notice, at, left + 10, at.y + 2));
    var tmux: host_clipboard.State = .{ .support = .unsupported };
    tmux.terminalName("tmux 3.4");
    const plain = tmux.notice(.cmd, "Codex", "nocap").?;
    const plain_at = place(&plain, .{ .x = 26, .y = 1, .w = 80, .h = 14 }, .{ .x = 29, .y = 10 }).?;
    try std.testing.expectEqual(@as(u16, 7), plain_at.h);
    // Nothing to open, so no hint.
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try draw(&out.writer, &plain, plain_at, false);
    try std.testing.expect(std.mem.indexOf(u8, out.written(), open_hint) == null);
}
