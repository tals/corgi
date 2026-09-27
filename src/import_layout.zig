//! Import-only split trees: pane values index the tab's source panes. Children
//! precede parents and the final node is the root. Runtime IDs are assigned later.
const std = @import("std");
const layout = @import("layout.zig");
pub const Node = union(enum) {
    pane: usize,
    split: struct { axis: layout.Axis, ratio: u16, first: usize, second: usize },
};

pub fn validate(nodes: []const Node, panes: usize) !void {
    if (panes == 0 or panes > layout.max_panes or nodes.len != panes * 2 - 1) return error.InvalidImportLayout;
    var children: [layout.max_panes * 2]bool = @splat(false);
    var leaves: [layout.max_panes]bool = @splat(false);
    for (nodes, 0..) |node, i| switch (node) {
        .pane => |p| {
            if (p >= panes or leaves[p]) return error.InvalidImportLayout;
            leaves[p] = true;
        },
        .split => |s| {
            if (s.ratio < 100 or s.ratio > 900 or s.first >= i or s.second >= i or s.first == s.second) return error.InvalidImportLayout;
            if (children[s.first] or children[s.second]) return error.InvalidImportLayout;
            children[s.first] = true;
            children[s.second] = true;
        },
    };
    for (children[0 .. nodes.len - 1]) |used| if (!used) return error.InvalidImportLayout;
    for (leaves[0..panes]) |used| if (!used) return error.InvalidImportLayout;
}

pub fn install(model: *layout.Model, nodes: []const Node, ids: []const layout.PaneId) !u8 {
    try validate(nodes, ids.len);
    var mapped: [layout.max_panes * 2]u8 = undefined;
    for (nodes, 0..) |node, i| mapped[i] = try model.alloc(switch (node) {
        .pane => |p| .{ .pane = ids[p] },
        .split => |s| .{ .split = .{ .axis = s.axis, .ratio = s.ratio, .first = mapped[s.first], .second = mapped[s.second] } },
    });
    return mapped[nodes.len - 1];
}

test "import trees reject reused panes, cycles and disconnected nodes" {
    const good = [_]Node{ .{ .pane = 0 }, .{ .pane = 1 }, .{ .split = .{ .axis = .horizontal, .ratio = 600, .first = 0, .second = 1 } } };
    try validate(&good, 2);
    var bad = good;
    bad[1] = .{ .pane = 0 };
    try std.testing.expectError(error.InvalidImportLayout, validate(&bad, 2));
    bad = good;
    bad[2].split.first = 2;
    try std.testing.expectError(error.InvalidImportLayout, validate(&bad, 2));
    bad = good;
    bad[2].split.second = 0;
    try std.testing.expectError(error.InvalidImportLayout, validate(&bad, 2));
    bad = good;
    bad[2].split.ratio = 0;
    try std.testing.expectError(error.InvalidImportLayout, validate(&bad, 2));
    try std.testing.expectError(error.InvalidImportLayout, validate(&.{}, 0));
}
