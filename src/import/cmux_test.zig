const std = @import("std");
const cmux = @import("cmux.zig");
const catalog = @import("catalog.zig");
const tree = @import("layout.zig");
const layout = @import("../layout.zig");
const a = std.testing.allocator;

fn value(alloc: std.mem.Allocator, json: []const u8) !std.json.Value {
    return (try std.json.parseFromSlice(std.json.Value, alloc, json, .{ .allocate = .alloc_always })).value;
}
fn shape(w: *std.Io.Writer, tab: catalog.Tab, index: usize) anyerror!void {
    switch (tab.nodes[index]) {
        .pane => |p| try w.writeAll(tab.panes[p].id),
        .split => |s| {
            try w.print("{s}{d}(", .{ if (s.axis == .horizontal) "h" else "v", s.ratio });
            try shape(w, tab, s.first);
            try w.writeByte(',');
            try shape(w, tab, s.second);
            try w.writeByte(')');
        },
    }
}
fn expectShape(expected: []const u8, tab: catalog.Tab) !void {
    try tree.validate(tab.nodes, tab.panes.len);
    var text: std.Io.Writer.Allocating = .init(a);
    defer text.deinit();
    try shape(&text.writer, tab, tab.nodes.len - 1);
    try std.testing.expectEqualStrings(expected, text.written());
    var model: layout.Model = .{};
    var ids: [layout.max_panes]layout.PaneId = undefined;
    for (tab.panes, 0..) |_, i| ids[i] = @enumFromInt(i + 100);
    _ = try tree.install(&model, tab.nodes, ids[0..tab.panes.len]);
}

test "cmux selected surfaces first then stable layers, every surface exactly once" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const root = try value(alloc, @embedFile("../testdata/cmux-tree.json"));
    const source = root.object.get("windows").?.array.items[0].object.get("workspaces").?.array.items;
    const ws = (try cmux.convert(alloc, source[0], .null)).?;
    try std.testing.expectEqual(.full, ws.recovery);
    try std.testing.expectEqual(@as(usize, 3), ws.tabs.len);
    try expectShape("h600(A,Y)", ws.tabs[0]);
    try expectShape("h600(B,X)", ws.tabs[1]);
    try expectShape("C", ws.tabs[2]);
    try std.testing.expectEqualStrings("Editor", ws.tabs[0].panes[0].name);
    try std.testing.expectEqualStrings("/tmp", ws.tabs[0].panes[0].cwd);
    try std.testing.expectEqualStrings("https://example.test/docs", ws.tabs[2].panes[0].url);
    const guessed = (try cmux.convert(alloc, source[1], .null)).?;
    try std.testing.expectEqual(.layout, guessed.recovery);
    try expectShape("h500(Q,Z)", guessed.tabs[0]);
    const fallback = (try cmux.convert(alloc, source[2], .null)).?;
    try std.testing.expectEqual(.workspace, fallback.recovery);
    try std.testing.expectEqualStrings("research", fallback.name);
    try expectShape("new-shell", fallback.tabs[0]);
}

test "cmux nested layouts collapse empty branches without losing split ratios" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const source = try value(alloc,
        \\{"id":"ws","panes":[
        \\ {"id":"left","surfaces":[{"id":"A"},{"id":"B"}]},
        \\ {"id":"top","surfaces":[{"id":"C"}]},
        \\ {"id":"bottom","surfaces":[{"id":"D"},{"id":"E"}]}],
        \\ "layout":{"direction":"horizontal","split":0.7,"children":[
        \\ {"pane":{"id":"left"}},{"direction":"vertical","split":0.3,"children":[
        \\ {"pane":{"id":"top"}},{"pane":{"id":"bottom"}}]}]}}
    );
    const ws = (try cmux.convert(alloc, source, .null)).?;
    try expectShape("h700(A,v300(C,D))", ws.tabs[0]);
    try expectShape("h700(B,E)", ws.tabs[1]);
}

test "cmux malformed tree falls back to pixel geometry joined by pane id" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const source = try value(alloc,
        \\{"id":"ws","panes":[{"id":"bottom","surfaces":[{"id":"B"}]},
        \\ {"id":"top","surfaces":[{"id":"A"}]}],
        \\ "layout":{"direction":"horizontal","split":0.5,"children":[
        \\ {"pane":{"id":"top"}},{"pane":{"id":"not-a-pane"}}]}}
    );
    const details = try value(alloc,
        \\{"panes":[{"id":"top","pixel_frame":{"x":100,"y":50,"width":100,"height":30}},
        \\ {"id":"bottom","pixel_frame":{"x":100,"y":80,"width":100,"height":70}}]}
    );
    const ws = (try cmux.convert(alloc, source, details)).?;
    try std.testing.expectEqual(.layout, ws.recovery);
    try expectShape("v300(A,B)", ws.tabs[0]);
}

test "cmux keeps readable surfaces despite malformed and duplicate entries" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const source = try value(alloc,
        \\{"name":"old workspace","panes":[{"surfaces":[false,{},
        \\ {"id":"A","title":"kept"},{"id":"A","title":"duplicate"},
        \\ {"name":"missing id","selected":true}]},null,{"id":"broken","surfaces":"new schema"}]}
    );
    const ws = (try cmux.convert(alloc, source, .null)).?;
    try std.testing.expectEqual(.partial, ws.recovery);
    try std.testing.expectEqual(@as(usize, 2), ws.tabs.len);
    try std.testing.expectEqualStrings("missing id", ws.tabs[0].panes[0].name);
    try std.testing.expectEqualStrings("A", ws.tabs[1].panes[0].id);
    try std.testing.expectEqual(@as(usize, 1), ws.tabs[0].panes.len);
    const metadata = (try cmux.convert(alloc, try value(alloc, "{\"name\":\"names survive\"}"), .null)).?;
    try std.testing.expectEqual(.workspace, metadata.recovery);
    try std.testing.expectEqualStrings("names survive", metadata.name);
    for ([_][]const u8{
        "{\"panes\":[{\"surfaces\":[{\"id\":\"A\"},{\"id\":\"B\"}]}]}",
        "{\"surfaces\":[{\"id\":\"A\"},{\"id\":\"B\"}]}",
    }) |json| {
        const unnamed = (try cmux.convert(alloc, try value(alloc, json), .null)).?;
        try std.testing.expectEqualStrings("Untitled", unnamed.name);
        try std.testing.expectEqual(.partial, unnamed.recovery);
        try std.testing.expectEqual(@as(usize, 2), unnamed.tabs.len);
        try expectShape("A", unnamed.tabs[0]);
        try expectShape("B", unnamed.tabs[1]);
    }
    try std.testing.expectEqual(@as(?catalog.Workspace, null), try cmux.convert(alloc, .null, .null));
}

test "cmux projection retains each surface once across uneven stack sizes and selections" {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const alloc = arena.allocator();
    const Surface = struct { id: []const u8, selected: bool };
    const Pane = struct { id: []const u8, surfaces: []const Surface };
    for (1..5) |left| for (1..5) |middle| for (1..5) |right| {
        var panes: [3]Pane = undefined;
        const counts = [_]usize{ left, middle, right };
        for (counts, 0..) |count, pi| {
            const surfaces = try alloc.alloc(Surface, count);
            for (surfaces, 0..) |*s, si| s.* = .{ .id = try std.fmt.allocPrint(alloc, "{d}-{d}", .{ pi, si }), .selected = si == (left + middle + right + pi) % count };
            panes[pi] = .{ .id = try std.fmt.allocPrint(alloc, "pane-{d}", .{pi}), .surfaces = surfaces };
        }
        const input = try std.json.Stringify.valueAlloc(alloc, .{ .id = "ws", .panes = panes }, .{});
        const ws = (try cmux.convert(alloc, try value(alloc, input), .null)).?;
        try std.testing.expectEqual(@max(left, middle, right), ws.tabs.len);
        var seen = std.StringHashMap(void).init(alloc);
        for (ws.tabs) |tab| {
            try tree.validate(tab.nodes, tab.panes.len);
            for (tab.panes) |p| try std.testing.expect(!(try seen.getOrPut(p.id)).found_existing);
        }
        try std.testing.expectEqual(left + middle + right, seen.count());
        for (ws.tabs[0].panes, 0..) |p, pi| try std.testing.expectEqualStrings(panes[pi].surfaces[(left + middle + right + pi) % counts[pi]].id, p.id);
    };
}
