const std = @import("std");
const vt = @import("ghostty-vt");
const os = @import("os.zig");
const a = os.allocator;

/// The host's default colors and its configurable ANSI palette. Applications
/// still own their OSC overrides; changing the host only changes defaults.
pub const Theme = struct {
    foreground: ?vt.color.RGB = null,
    background: ?vt.color.RGB = null,
    palette: [16]?vt.color.RGB = .{null} ** 16,

    pub fn fromJson(value: std.json.Value) Theme {
        const parsed = std.json.parseFromValue(Theme, a, value, .{ .ignore_unknown_fields = true }) catch return .{};
        defer parsed.deinit();
        return parsed.value;
    }
    pub fn merge(t: *Theme, other: Theme) void {
        if (other.foreground) |color| t.foreground = color;
        if (other.background) |color| t.background = color;
        for (other.palette, 0..) |entry, i| if (entry) |color| {
            t.palette[i] = color;
        };
    }
    pub fn apply(t: Theme, terminal: *vt.Terminal) void {
        if (t.foreground) |color| terminal.colors.foreground.default = color;
        if (t.background) |color| terminal.colors.background.default = color;
        var palette = terminal.colors.palette.original;
        for (t.palette, 0..) |entry, i| if (entry) |color| {
            palette[i] = color;
        };
        terminal.colors.palette.changeDefault(palette);
        terminal.flags.dirty.palette = true;
    }
    pub fn complete(t: Theme) bool {
        if (t.foreground == null or t.background == null) return false;
        for (t.palette) |entry| if (entry == null) return false;
        return true;
    }
    const OscKind = enum { @"4", @"10", @"11" };
    pub fn accept(t: *Theme, body: []const u8) bool {
        var fields = std.mem.splitScalar(u8, body, ';');
        const kind = std.meta.stringToEnum(OscKind, fields.next() orelse return false) orelse return false;
        const entry = fields.next() orelse return false;
        switch (kind) {
            .@"4" => {
                const index = std.fmt.parseInt(u8, entry, 10) catch return false;
                if (index >= t.palette.len) return false;
                const rgb = fields.next() orelse return false;
                if (fields.next() != null) return false;
                t.palette[index] = vt.color.RGB.parse(rgb) catch return false;
            },
            .@"10", .@"11" => {
                if (fields.next() != null) return false;
                const color = vt.color.RGB.parse(entry) catch return false;
                if (kind == .@"10") t.foreground = color else t.background = color;
            },
        }
        return true;
    }
};
