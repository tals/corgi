//! Corgi's UI colors: one gray ramp, sage for live work, warm for work that
//! needs the user. docs/ui_styleguide.md says when to use each token, and
//! termhtml's corgi theme carries the same values.
const std = @import("std");
const os = @import("os.zig");

pub const Rgb = [3]u8;

pub const Token = enum {
    /// Sidebar, cards and panels.
    bg,
    /// Raised areas on bg: launcher panel, inputs, buttons.
    surface,
    /// Selected rows; empty meter and spark cells.
    selected,
    /// Borders and rules.
    line,
    /// Labels, column headings, secondary numbers, footers.
    faint,
    muted,
    text,
    /// Titles and the number a table ranks by.
    strong,
    /// Live: working agents, the current step, usage that is fine.
    accent,
    /// Needs the user: waiting for input, limits past 80%, a filling context.
    warm,
    /// Past a limit, or failed.
    hot,

    pub fn rgb(t: Token) Rgb {
        return switch (t) {
            .bg => .{ 0x18, 0x1b, 0x20 },
            .surface => .{ 0x23, 0x28, 0x2f },
            .selected => .{ 0x33, 0x39, 0x41 },
            .line => .{ 0x50, 0x5a, 0x65 },
            .faint => .{ 0x83, 0x90, 0x9e },
            .muted => .{ 0xa5, 0xae, 0xb8 },
            .text => .{ 0xd1, 0xd6, 0xdb },
            .strong => .{ 0xee, 0xf1, 0xf4 },
            .accent => .{ 0x7b, 0xf1, 0xa8 },
            .warm => .{ 0xe5, 0xc3, 0x8b },
            .hot => .{ 0xed, 0xa3, 0x98 },
        };
    }
};

/// Sets only the foreground: "\x1b[38;2;R;G;Bm".
pub fn fg(comptime t: Token) []const u8 {
    return comptime "\x1b[38;2;" ++ channels(t) ++ "m";
}
/// Sets only the background: "\x1b[48;2;R;G;Bm".
pub fn bg(comptime t: Token) []const u8 {
    return comptime "\x1b[48;2;" ++ channels(t) ++ "m";
}
/// Sets only the underline color (SGR 58): "\x1b[58:2::R:G:Bm".
pub fn underline(comptime t: Token) []const u8 {
    return comptime "\x1b[58:2::" ++ underline_channels[@intFromEnum(t)] ++ "m";
}
/// `fg` for a color worked out at comptime, such as a `mix`.
pub fn fgRgb(comptime c: Rgb) []const u8 {
    return comptime std.fmt.comptimePrint("\x1b[38;2;{d};{d};{d}m", .{ c[0], c[1], c[2] });
}
/// `bg` for a color worked out at comptime, such as a `mix`.
pub fn bgRgb(comptime c: Rgb) []const u8 {
    return comptime std.fmt.comptimePrint("\x1b[48;2;{d};{d};{d}m", .{ c[0], c[1], c[2] });
}
/// `fg` for a color worked out at runtime.
pub fn writeFg(w: *std.Io.Writer, c: Rgb) !void {
    try w.print("\x1b[38;2;{d};{d};{d}m", .{ c[0], c[1], c[2] });
}

/// Keys drawn as caps in hints, menus and dialogs.
pub const keycap = (Style{ .fg = .strong, .bg = .line, .bold = true }).sgr();

/// A whole SGR state. `sgr` resets first, so nothing leaks from earlier writes.
pub const Style = struct {
    fg: ?Token = null,
    bg: ?Token = null,
    bold: bool = false,
    strike: bool = false,

    pub fn sgr(comptime s: Style) []const u8 {
        return comptime blk: {
            var out: []const u8 = "\x1b[0";
            if (s.bold) out = out ++ ";1";
            if (s.strike) out = out ++ ";9";
            if (s.fg) |t| out = out ++ ";38;2;" ++ channels(t);
            if (s.bg) |t| out = out ++ ";48;2;" ++ channels(t);
            break :blk out ++ "m";
        };
    }
};

/// `from` moved `percent` of the way to `to`. Terminals have no alpha, so a
/// dimmed or fading color blends against the background it sits on.
pub fn mix(from: Rgb, to: Rgb, percent: u8) Rgb {
    var out: Rgb = undefined;
    const p: u16 = @min(percent, 100);
    for (&out, from, to) |*c, a, b| c.* = @intCast((@as(u16, a) * (100 - p) + @as(u16, b) * p + 50) / 100);
    return out;
}

fn channels(comptime t: Token) []const u8 {
    return channel_table[@intFromEnum(t)];
}
// Formatted once, rather than against each caller's comptime branch quota.
const channel_table = formatAll("{d};{d};{d}");
const underline_channels = formatAll("{d}:{d}:{d}");
fn formatAll(comptime format: []const u8) [std.meta.tags(Token).len][]const u8 {
    @setEvalBranchQuota(20_000);
    var out: [std.meta.tags(Token).len][]const u8 = undefined;
    for (std.meta.tags(Token), &out) |t, *entry| {
        const c = t.rgb();
        entry.* = std.fmt.comptimePrint(format, .{ c[0], c[1], c[2] });
    }
    return out;
}

/// termhtml's `corgi` theme: each token by name, plus `fg` and `danger`, the
/// roles its renderer names differently.
fn termhtmlTheme() []const u8 {
    comptime var out: []const u8 = "corgi: { ";
    inline for (comptime std.meta.tags(Token)) |t| out = out ++ @tagName(t) ++ ": \"" ++ hex(t) ++ "\", ";
    return out ++ "fg: \"" ++ hex(.text) ++ "\", danger: \"" ++ hex(.hot) ++ "\" },";
}
fn hex(comptime t: Token) []const u8 {
    const c = t.rgb();
    return std.fmt.comptimePrint("#{x:0>2}{x:0>2}{x:0>2}", .{ c[0], c[1], c[2] });
}

/// WCAG contrast ratio, from 1 to 21.
fn contrast(a: Token, b: Token) f64 {
    const la = luminance(a.rgb());
    const lb = luminance(b.rgb());
    return (@max(la, lb) + 0.05) / (@min(la, lb) + 0.05);
}
fn luminance(c: Rgb) f64 {
    var sum: f64 = 0;
    for (c, [_]f64{ 0.2126, 0.7152, 0.0722 }) |channel, weight| {
        const v = @as(f64, @floatFromInt(channel)) / 255;
        sum += weight * (if (v <= 0.04045) v / 12.92 else std.math.pow(f64, (v + 0.055) / 1.055, 2.4));
    }
    return sum;
}

test "text tokens stay readable on the backgrounds the guide allows" {
    for ([_]Token{ .faint, .muted, .text, .strong, .accent, .warm, .hot }) |ink| {
        for ([_]Token{ .bg, .surface }) |ground| try std.testing.expect(contrast(ink, ground) >= 4.5);
        // Selected rows take muted or brighter.
        if (ink != .faint) try std.testing.expect(contrast(ink, .selected) >= 4.5);
    }
    try std.testing.expect(contrast(.line, .bg) >= 2.2);
}

test "styles render to SGR, called at runtime" {
    try std.testing.expectEqualStrings("\x1b[38;2;123;241;168m", fg(.accent));
    try std.testing.expectEqualStrings("\x1b[48;2;35;40;47m", bg(.surface));
    try std.testing.expectEqualStrings("\x1b[0;1;38;2;238;241;244;48;2;24;27;32m", (Style{ .fg = .strong, .bg = .bg, .bold = true }).sgr());
    try std.testing.expectEqualStrings("\x1b[0m", (Style{}).sgr());
    const label = comptime fg(.muted);
    try std.testing.expectEqualStrings("\x1b[38;2;165;174;184m", label);
}

test "underlines, computed colors and keycaps render to SGR" {
    try std.testing.expectEqualStrings("\x1b[58:2::80:90:101m", underline(.line));
    try std.testing.expectEqualStrings("\x1b[38;2;1;2;3m", fgRgb(.{ 1, 2, 3 }));
    try std.testing.expectEqualStrings("\x1b[48;2;1;2;3m", bgRgb(.{ 1, 2, 3 }));
    var out: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer out.deinit();
    try writeFg(&out.writer, .{ 4, 5, 6 });
    try std.testing.expectEqualStrings("\x1b[38;2;4;5;6m", out.written());
    try std.testing.expectEqualStrings("\x1b[0;1;38;2;238;241;244;48;2;80;90;101m", keycap);
    try std.testing.expect(contrast(.strong, .line) >= 4.5);
}

test "mix blends toward the second color" {
    try std.testing.expectEqual(Rgb{ 100, 50, 0 }, mix(.{ 100, 50, 0 }, .{ 0, 0, 0 }, 0));
    try std.testing.expectEqual(Rgb{ 50, 25, 0 }, mix(.{ 100, 50, 0 }, .{ 0, 0, 0 }, 50));
    try std.testing.expectEqual(Rgb{ 0, 0, 0 }, mix(.{ 100, 50, 0 }, .{ 0, 0, 0 }, 100));
}

test "termhtml's corgi theme matches the palette" {
    const html = try std.Io.Dir.cwd().readFileAlloc(os.io(), "termhtml/index.html", std.testing.allocator, .limited(1 << 20));
    defer std.testing.allocator.free(html);
    if (std.mem.indexOf(u8, html, comptime termhtmlTheme()) != null) return;
    std.debug.print("termhtml/index.html needs this line in `themes`:\n    {s}\n", .{comptime termhtmlTheme()});
    return error.TestUnexpectedResult;
}
