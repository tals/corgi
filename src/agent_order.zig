//! Shared sidebar order, independent of tab and pane layout.
const std = @import("std");
const layout = @import("layout.zig");
const NativeId = @import("native.zig").Session.Id;
pub const capacity = layout.max_panes + 16;
pub const Target = union(enum) { pane: layout.PaneId, native: NativeId };

pub fn index(targets: []const Target, target: Target) ?usize {
    for (targets, 0..) |item, i| if (std.meta.eql(item, target)) return i;
    return null;
}
pub fn rank(targets: []const Target, target: Target) usize {
    return index(targets, target) orelse targets.len;
}

pub const Order = struct {
    items: [capacity]Target = undefined,
    len: usize = 0,

    pub fn slice(self: *const Order) []const Target {
        return self.items[0..self.len];
    }
    pub fn restore(targets: []const Target) !Order {
        if (targets.len > capacity) return error.InvalidAgentOrder;
        for (targets, 0..) |target, i| {
            const id: u32 = switch (target) {
                .pane => |id| @intFromEnum(id),
                .native => |id| @intFromEnum(id),
            };
            if (id == 0 or index(targets[0..i], target) != null) return error.InvalidAgentOrder;
        }
        var result: Order = .{};
        @memcpy(result.items[0..targets.len], targets);
        result.len = targets.len;
        return result;
    }
    /// Prune removed targets, retain surviving identities, append new targets
    /// in layout order, then insert before the destination (null means end).
    pub fn move(self: *Order, live: []const Target, target: Target, before: ?Target) !void {
        if (live.len > capacity) return error.TooManyAgents;
        if (index(live, target) == null) return error.NoAgent;
        if (before) |other| {
            if (index(live, other) == null) return error.InvalidDestination;
            if (std.meta.eql(target, other)) return;
        }
        var next: Order = .{};
        for (self.slice()) |item| if (index(live, item) != null and !std.meta.eql(item, target)) {
            next.items[next.len] = item;
            next.len += 1;
        };
        for (live) |item| if (index(next.slice(), item) == null and !std.meta.eql(item, target)) {
            next.items[next.len] = item;
            next.len += 1;
        };
        const at = if (before) |other| index(next.slice(), other).? else next.len;
        std.mem.copyBackwards(Target, next.items[at + 1 .. next.len + 1], next.items[at..next.len]);
        next.items[at] = target;
        next.len += 1;
        self.* = next;
    }
};

test "agent order mixes pane and native identities and reconciles removal and insertion" {
    const a: Target = .{ .pane = @enumFromInt(1) };
    const b: Target = .{ .pane = @enumFromInt(2) };
    const c: Target = .{ .native = @enumFromInt(1) };
    const d: Target = .{ .pane = @enumFromInt(3) };
    var order: Order = .{};
    try order.move(&.{ a, b, c }, c, a);
    try std.testing.expectEqualSlices(Target, &.{ c, a, b }, order.slice());
    try order.move(&.{ a, b, c }, c, null);
    try std.testing.expectEqualSlices(Target, &.{ a, b, c }, order.slice());
    try order.move(&.{ c, b, d }, d, b);
    try std.testing.expectEqualSlices(Target, &.{ d, b, c }, order.slice());
    try std.testing.expectError(error.InvalidDestination, order.move(&.{ b, c, d }, b, a));
    try std.testing.expectEqualSlices(Target, &.{ d, b, c }, order.slice());
    try std.testing.expectError(error.InvalidAgentOrder, Order.restore(&.{ a, a }));
}
