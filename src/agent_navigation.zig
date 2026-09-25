//! Agent navigation uses the sidebar's complete, workspace-local list.
const std = @import("std");
const sidebar = @import("sidebar.zig");
const naming = @import("name_dialog.zig");
const Target = sidebar.Target;

pub fn indexOf(entries: []const sidebar.Entry, target: ?Target) ?usize {
    const wanted = target orelse return null;
    for (entries, 0..) |entry, i| if (std.meta.eql(entry.target, wanted)) return i;
    return null;
}

pub fn relative(entries: []const sidebar.Entry, current: ?Target, next: bool) ?Target {
    if (entries.len == 0) return null;
    const index = if (indexOf(entries, current)) |i|
        (i + if (next) @as(usize, 1) else entries.len - 1) % entries.len
    else if (next) @as(usize, 0) else entries.len - 1;
    return entries[index].target;
}

pub const History = struct {
    current: ?Target = null,
    previous: ?Target = null,

    pub fn observe(h: *History, target: ?Target) void {
        if (target == null or std.meta.eql(h.current, target)) return;
        h.previous = h.current;
        h.current = target;
    }
    pub fn destination(h: History, entries: []const sidebar.Entry, focused: ?Target) ?Target {
        const target = if (focused == null) h.current else h.previous;
        return if (indexOf(entries, target) != null) target else null;
    }
};

pub const Picker = struct {
    workspace: u32,
    query: naming.Dialog = naming.Dialog.init(.{ .pane = 0 }, ""),
    selected: ?Target = null,
    offset: usize = 0,

    pub fn matches(p: *const Picker, entry: sidebar.Entry) bool {
        const query = p.query.name();
        return contains(entry.name, query) or contains(@tagName(entry.provider), query) or
            contains(@tagName(entry.state), query) or contains(entry.cwd, query) or contains(entry.activity, query);
    }
    pub fn list(p: *const Picker, entries: []const sidebar.Entry, out: *[sidebar.max_entries]sidebar.Entry) []sidebar.Entry {
        var count: usize = 0;
        for (entries) |entry| if (p.matches(entry)) {
            out[count] = entry;
            count += 1;
        };
        return out[0..count];
    }
    pub fn reconcile(p: *Picker, entries: []const sidebar.Entry, capacity: usize) void {
        const index = indexOf(entries, p.selected) orelse 0;
        p.selected = if (entries.len > 0) entries[index].target else null;
        p.offset = @min(p.offset, entries.len -| capacity);
        if (index < p.offset) p.offset = index else if (index >= p.offset + capacity) p.offset = index + 1 - capacity;
    }
    pub fn move(p: *Picker, entries: []const sidebar.Entry, next: bool, capacity: usize) void {
        p.reconcile(entries, capacity);
        p.selected = relative(entries, p.selected, next);
        p.reconcile(entries, capacity);
    }
};

fn contains(text: []const u8, query: []const u8) bool {
    if (query.len > text.len) return false;
    for (0..text.len - query.len + 1) |i| if (std.ascii.eqlIgnoreCase(text[i..][0..query.len], query)) return true;
    return false;
}

test "agent navigation wraps, excludes shells, and validates history against the current list" {
    const entries = [_]sidebar.Entry{
        .{ .target = .{ .pane = 2 }, .provider = .codex, .state = .idle, .attention = .none },
        .{ .target = .{ .native = 2 }, .provider = .claude, .state = .blocked, .attention = .needs_input },
    };
    try std.testing.expectEqual(entries[1].target, relative(&entries, entries[0].target, false).?);
    try std.testing.expectEqual(entries[0].target, relative(&entries, entries[1].target, true).?);
    try std.testing.expect(relative(&.{}, null, true) == null);
    var history: History = .{};
    history.observe(entries[0].target);
    history.observe(entries[1].target);
    try std.testing.expectEqual(entries[0].target, history.destination(&entries, entries[1].target).?);
    try std.testing.expect(history.destination(entries[1..], entries[1].target) == null);
}

test "picker preserves target identity across reordering and removes filtered or deleted selections" {
    var entries = [_]sidebar.Entry{
        .{ .name = "Alpha", .target = .{ .pane = 1 }, .provider = .codex, .state = .idle, .attention = .none },
        .{ .name = "Beta", .target = .{ .native = 1 }, .provider = .claude, .state = .blocked, .attention = .needs_input },
    };
    var p: Picker = .{ .workspace = 1, .selected = entries[1].target };
    p.reconcile(&entries, 1);
    try std.testing.expectEqual(@as(usize, 1), p.offset);
    std.mem.swap(sidebar.Entry, &entries[0], &entries[1]);
    p.reconcile(&entries, 1);
    try std.testing.expectEqual(@as(usize, 0), p.offset);
    _ = p.query.key('A');
    _ = p.query.key('L');
    var storage: [sidebar.max_entries]sidebar.Entry = undefined;
    const filtered = p.list(&entries, &storage);
    p.reconcile(filtered, 1);
    try std.testing.expectEqual(entries[1].target, p.selected.?);
    p.reconcile(&.{}, 1);
    try std.testing.expect(p.selected == null);
}
