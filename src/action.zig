//! What a viewer can be asked to do: by a key, a click, `corgi action NAME
//! [VALUE]`, or a daemon control. `@tagName` is the wire name, so the
//! protocol keeps its strings.
const std = @import("std");
const layout = @import("layout.zig");

pub const Action = union(enum) {
    onboard,
    new,
    split: Split,
    zoom,
    close,
    @"close-tab",
    sidebar,
    mute,
    @"undo-close",
    attention,
    @"workspace-next",
    @"workspace-prev",
    rename: []const u8,
    resize: layout.Direction,
    focus: layout.Direction,
    swap: layout.Direction,
    @"move-tab": Side,
    @"break",
    next,
    prev,
    /// 1-based, as `corgi action tab 3`.
    tab: usize,
    join: usize,
    /// Sent by `corgi` after an update; viewer.sync execs the new binary.
    relaunch: []const u8,

    pub const Split = enum {
        right,
        down,
        pub const default: Split = .right;
    };
    pub const Side = enum {
        left,
        right,
        pub const default: Side = .right;
    };

    /// The wire form: a name and an optional value. `rename` and `relaunch`
    /// borrow `value`.
    pub fn parse(name: []const u8, value: []const u8) !Action {
        inline for (@typeInfo(Action).@"union".fields) |field| {
            if (std.mem.eql(u8, name, field.name))
                return @unionInit(Action, field.name, try parseValue(field.type, value));
        }
        return error.UnknownAction;
    }
    fn parseValue(comptime T: type, value: []const u8) !T {
        return switch (@typeInfo(T)) {
            .void => {},
            .@"enum" => std.meta.stringToEnum(T, value) orelse
                if (value.len == 0 and @hasDecl(T, "default")) T.default else error.BadValue,
            .int => std.fmt.parseInt(T, value, 10) catch error.BadValue,
            .pointer => value,
            else => @compileError("unsupported action value: " ++ @typeName(T)),
        };
    }
};

test "wire names used by the CLI and the test suites parse" {
    try std.testing.expectEqual(Action{ .split = .down }, try Action.parse("split", "down"));
    try std.testing.expectEqual(Action{ .split = .right }, try Action.parse("split", ""));
    try std.testing.expectEqual(Action{ .@"move-tab" = .left }, try Action.parse("move-tab", "left"));
    try std.testing.expectEqual(Action{ .@"move-tab" = .right }, try Action.parse("move-tab", ""));
    try std.testing.expectEqual(Action{ .join = 1 }, try Action.parse("join", "1"));
    try std.testing.expectEqual(Action{ .focus = .up }, try Action.parse("focus", "up"));
    try std.testing.expectEqual(Action.@"undo-close", try Action.parse("undo-close", ""));
    try std.testing.expectEqualStrings("Renamed", (try Action.parse("rename", "Renamed")).rename);
    try std.testing.expectError(error.UnknownAction, Action.parse("close_tab", ""));
    try std.testing.expectError(error.BadValue, Action.parse("focus", "north"));
    try std.testing.expectError(error.BadValue, Action.parse("resize", ""));
    try std.testing.expectError(error.BadValue, Action.parse("tab", "two"));
}
