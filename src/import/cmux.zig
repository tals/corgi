//! Deterministic cmux snapshot -> ordinary Corgi tabs. No processes, inference,
//! or runtime state: the caller's arena owns the complete converted workspace.
const std = @import("std");
const catalog = @import("catalog.zig");
const layout = @import("../layout.zig");
const tree = @import("layout.zig");
const Value = std.json.Value;
const Allocator = std.mem.Allocator;
const Nodes = std.ArrayList(tree.Node);
const Rect = struct { x: f64, y: f64, w: f64, h: f64 };
const SourcePane = struct { value: Value, surfaces: []const Value, selected: usize, rect: ?Rect };

pub fn convert(a: Allocator, ws: Value, details: Value) !?catalog.Workspace {
    if (!recognizableWorkspace(ws)) return null;
    var source = list(ws, "panes");
    const flat = source.len == 0 and list(ws, "surfaces").len > 0;
    if (flat) source = &.{ws};
    if (source.len == 0) return workspaceOnly(a, ws, "Couldn't read its panes or tabs");
    if (source.len > layout.max_panes) return workspaceOnly(a, ws, "Too many panes for one import");
    var panes: [layout.max_panes]SourcePane = undefined;
    var total: usize = 0;
    var layers: usize = 0;
    var partial = flat or !recognizable(ws);
    var seen = std.StringHashMap(void).init(a);
    for (source, 0..) |p, i| {
        var kept: std.ArrayList(Value) = .empty;
        if (field(p, "surfaces") != .array) partial = true;
        for (list(p, "surfaces")) |surface| {
            if (!recognizable(surface)) {
                partial = true;
                continue;
            }
            if (id(surface).len > 0) {
                const entry = try seen.getOrPut(id(surface));
                if (entry.found_existing) {
                    partial = true;
                    continue;
                }
            }
            try kept.append(a, surface);
        }
        const surfaces = try kept.toOwnedSlice(a);
        total += surfaces.len;
        if (total > layout.max_panes) return workspaceOnly(a, ws, "Too many surfaces for one import");
        layers = @max(layers, surfaces.len);
        if (layers > layout.max_tabs) return workspaceOnly(a, ws, "Too many tabs for one import");
        var rectangle = rect(p);
        if (rectangle == null) for (list(details, "panes")) |detail| {
            if (matches(p, id(detail))) {
                rectangle = rect(detail);
                break;
            }
        };
        panes[i] = .{ .value = p, .surfaces = surfaces, .selected = selected(p, surfaces), .rect = rectangle };
    }
    if (total == 0) return workspaceOnly(a, ws, "Couldn't read its panes or tabs");
    const source_panes = panes[0..source.len];
    var nodes: Nodes = .empty;
    var approximate = false;
    snapshotTree(a, &nodes, field(ws, "layout"), source_panes, 0) catch |err| switch (err) {
        error.InvalidImportLayout => nodes.clearRetainingCapacity(),
        else => return err,
    };
    tree.validate(nodes.items, source.len) catch {
        approximate = true;
        nodes.clearRetainingCapacity();
        var indices: [layout.max_panes]usize = undefined;
        for (source, 0..) |_, i| indices[i] = i;
        geometry(a, &nodes, source_panes, indices[0..source.len]) catch |err| switch (err) {
            error.InvalidImportLayout => {
                nodes.clearRetainingCapacity();
                _ = try balanced(a, &nodes, indices[0..source.len], .horizontal);
            },
            else => return err,
        };
    };
    try tree.validate(nodes.items, source.len);

    var tabs: std.ArrayList(catalog.Tab) = .empty;
    for (0..layers) |layer| {
        var output: std.ArrayList(catalog.Pane) = .empty;
        var mapping: [layout.max_panes]?usize = @splat(null);
        for (source_panes, 0..) |p, i| {
            if (layer >= p.surfaces.len) continue;
            // Selected first, then every other surface in its original tab order.
            const si = if (layer == 0) p.selected else if (layer - 1 < p.selected) layer - 1 else layer;
            const surface = p.surfaces[si];
            mapping[i] = output.items.len;
            const dir = cwd(surface);
            const surface_id = if (id(surface).len > 0) id(surface) else try std.fmt.allocPrint(a, "surface:{d}:{d}", .{ i, si });
            try output.append(a, .{ .id = surface_id, .name = title(surface), .cwd = if (dir.len > 0) dir else cwd(p.value), .url = text(surface, "url") });
        }
        var projected: Nodes = .empty;
        _ = try project(a, &projected, nodes.items, nodes.items.len - 1, mapping[0..source.len]);
        try tree.validate(projected.items, output.items.len);
        const name = if (output.items.len == 1) output.items[0].name else if (layer == 0) title(ws) else try std.fmt.allocPrint(a, "{s} ({d})", .{ title(ws), layer + 1 });
        try tabs.append(a, .{
            .id = try std.fmt.allocPrint(a, "{s}:{d}", .{ id(ws), layer }),
            .name = name,
            .panes = try output.toOwnedSlice(a),
            .nodes = try projected.toOwnedSlice(a),
        });
    }
    const recovery: catalog.Recovery = if (partial) .partial else if (approximate and source.len > 1) .layout else .full;
    const recovery_note: []const u8 = if (partial) "Some pane or tab details couldn't be read" else if (approximate and source.len > 1) "Split layout approximated" else "";
    return .{ .id = workspaceId(ws), .name = title(ws), .cwd = cwd(ws), .tabs = try tabs.toOwnedSlice(a), .recovery = recovery, .recovery_note = recovery_note };
}

pub fn workspaceOnly(a: Allocator, ws: Value, reason: []const u8) !?catalog.Workspace {
    if (!recognizableWorkspace(ws)) return null;
    const panes = try a.alloc(catalog.Pane, 1);
    panes[0] = .{ .id = "new-shell", .name = "New shell" };
    const tabs = try a.alloc(catalog.Tab, 1);
    tabs[0] = .{ .id = "workspace-only", .name = "Terminal", .panes = panes, .nodes = &.{.{ .pane = 0 }} };
    return .{ .id = workspaceId(ws), .name = title(ws), .cwd = cwd(ws), .tabs = tabs, .recovery = .workspace, .recovery_note = reason };
}
fn recognizable(v: Value) bool {
    return v == .object and (id(v).len > 0 or firstText(v, &.{ "title", "name", "label", "cwd", "url" }).len > 0);
}
fn recognizableWorkspace(v: Value) bool {
    return recognizable(v) or list(v, "panes").len > 0 or list(v, "surfaces").len > 0;
}
fn workspaceId(v: Value) []const u8 {
    return if (id(v).len > 0) id(v) else title(v);
}

fn field(v: Value, key: []const u8) Value {
    return if (v == .object) v.object.get(key) orelse .null else .null;
}
fn text(v: Value, key: []const u8) []const u8 {
    const f = field(v, key);
    return if (f == .string) f.string else "";
}
fn list(v: Value, key: []const u8) []const Value {
    const f = field(v, key);
    return if (f == .array) f.array.items else &.{};
}
fn firstText(v: Value, keys: []const []const u8) []const u8 {
    for (keys) |key| {
        const s = text(v, key);
        if (s.len > 0) return s;
    }
    return "";
}
fn id(v: Value) []const u8 {
    return firstText(v, &.{ "id", "ref", "workspace_id", "pane_id", "surface_id" });
}
fn title(v: Value) []const u8 {
    const s = firstText(v, &.{ "title", "name", "label", "ref", "id", "workspace_id", "pane_id", "surface_id" });
    return if (s.len > 0) s else "Untitled";
}
fn cwd(v: Value) []const u8 {
    return firstText(v, &.{ "cwd", "current_directory", "requested_working_directory", "working_directory" });
}
fn matches(v: Value, handle: []const u8) bool {
    return handle.len > 0 and (std.mem.eql(u8, id(v), handle) or std.mem.eql(u8, text(v, "ref"), handle));
}
fn yes(v: Value, key: []const u8) bool {
    const f = field(v, key);
    return f == .bool and f.bool;
}
fn selected(pane: Value, surfaces: []const Value) usize {
    const handle = firstText(pane, &.{ "selected_surface_id", "selected_surface_ref" });
    for (surfaces, 0..) |surface, i| if (matches(surface, handle)) return i;
    for (surfaces, 0..) |surface, i| if (yes(surface, "selected") or yes(surface, "selected_in_pane")) return i;
    return 0;
}
fn number(v: Value) ?f64 {
    const n: f64 = switch (v) {
        .integer => @floatFromInt(v.integer),
        .float => v.float,
        else => return null,
    };
    return if (std.math.isFinite(n) and @abs(n) <= 1e9) n else null;
}
fn rect(p: Value) ?Rect {
    const f = field(p, "pixel_frame");
    const r: Rect = .{
        .x = number(field(f, "x")) orelse return null,
        .y = number(field(f, "y")) orelse return null,
        .w = number(field(f, "width")) orelse return null,
        .h = number(field(f, "height")) orelse return null,
    };
    return if (r.w > 0 and r.h > 0) r else null;
}
fn ratio(n: f64) u16 {
    return @intFromFloat(std.math.clamp(@round(n * 1000), 100, 900));
}
fn append(a: Allocator, nodes: *Nodes, node: tree.Node) !usize {
    const index = nodes.items.len;
    try nodes.append(a, node);
    return index;
}
fn snapshotTree(a: Allocator, nodes: *Nodes, v: Value, panes: []const SourcePane, depth: usize) anyerror!void {
    if (depth >= layout.max_panes or nodes.items.len >= layout.max_panes * 2 - 1) return error.InvalidImportLayout;
    const leaf = field(v, "pane");
    if (leaf == .object) {
        for (panes, 0..) |p, i| if (matches(p.value, id(leaf))) {
            _ = try append(a, nodes, .{ .pane = i });
            return;
        };
        return error.InvalidImportLayout;
    }
    const children = list(v, "children");
    const direction = text(v, "direction");
    const axis = std.meta.stringToEnum(layout.Axis, direction) orelse return error.InvalidImportLayout;
    const share = number(field(v, "split")) orelse return error.InvalidImportLayout;
    if (children.len != 2 or share <= 0 or share >= 1) return error.InvalidImportLayout;
    try snapshotTree(a, nodes, children[0], panes, depth + 1);
    const left = nodes.items.len - 1;
    try snapshotTree(a, nodes, children[1], panes, depth + 1);
    _ = try append(a, nodes, .{ .split = .{ .axis = axis, .ratio = ratio(share), .first = left, .second = nodes.items.len - 1 } });
}
fn balanced(a: Allocator, nodes: *Nodes, indices: []const usize, axis: layout.Axis) anyerror!usize {
    if (indices.len == 1) return append(a, nodes, .{ .pane = indices[0] });
    const middle = indices.len / 2;
    const next: layout.Axis = if (axis == .horizontal) .vertical else .horizontal;
    const left = try balanced(a, nodes, indices[0..middle], next);
    const right = try balanced(a, nodes, indices[middle..], next);
    return append(a, nodes, .{ .split = .{ .axis = axis, .ratio = ratio(@as(f64, @floatFromInt(middle)) / @as(f64, @floatFromInt(indices.len))), .first = left, .second = right } });
}
fn geometry(a: Allocator, nodes: *Nodes, panes: []const SourcePane, indices: []const usize) anyerror!void {
    for (indices) |i| if (panes[i].rect == null) return error.InvalidImportLayout;
    if (indices.len == 1) {
        _ = try append(a, nodes, .{ .pane = indices[0] });
        return;
    }
    for ([_]layout.Axis{ .horizontal, .vertical }) |axis| {
        var min: f64 = std.math.inf(f64);
        var max: f64 = -std.math.inf(f64);
        for (indices) |i| {
            const r = panes[i].rect.?;
            const start = if (axis == .horizontal) r.x else r.y;
            min = @min(min, start);
            max = @max(max, start + if (axis == .horizontal) r.w else r.h);
        }
        for (indices) |candidate| {
            const r = panes[candidate].rect.?;
            const cut = if (axis == .horizontal) r.x else r.y;
            if (cut <= min or cut >= max) continue;
            var left: [layout.max_panes]usize = undefined;
            var right: [layout.max_panes]usize = undefined;
            var nl: usize = 0;
            var nr: usize = 0;
            var left_end = min;
            for (indices) |i| {
                const p = panes[i].rect.?;
                const start = if (axis == .horizontal) p.x else p.y;
                const end = start + if (axis == .horizontal) p.w else p.h;
                if (end <= cut + 0.01) {
                    left[nl] = i;
                    nl += 1;
                    left_end = @max(left_end, end);
                } else if (start >= cut - 0.01) {
                    right[nr] = i;
                    nr += 1;
                } else break;
            }
            if (nl == 0 or nr == 0 or nl + nr != indices.len) continue;
            try geometry(a, nodes, panes, left[0..nl]);
            const first = nodes.items.len - 1;
            try geometry(a, nodes, panes, right[0..nr]);
            _ = try append(a, nodes, .{ .split = .{ .axis = axis, .ratio = ratio(((left_end + cut) / 2 - min) / (max - min)), .first = first, .second = nodes.items.len - 1 } });
            return;
        }
    }
    return error.InvalidImportLayout;
}
fn project(a: Allocator, out: *Nodes, source: []const tree.Node, index: usize, mapping: []const ?usize) anyerror!?usize {
    switch (source[index]) {
        .pane => |p| return if (mapping[p]) |i| try append(a, out, .{ .pane = i }) else null,
        .split => |s| {
            const left = try project(a, out, source, s.first, mapping);
            const right = try project(a, out, source, s.second, mapping);
            if (left == null) return right;
            if (right == null) return left;
            return try append(a, out, .{ .split = .{ .axis = s.axis, .ratio = s.ratio, .first = left.?, .second = right.? } });
        },
    }
}
