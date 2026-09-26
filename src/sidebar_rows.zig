//! Viewer-owned exit presentation. Keep departing rows inert and in place until
//! their last visible content has faded; never retain borrowed snapshot strings.
const std = @import("std");
const sidebar = @import("sidebar.zig");
const capacity = sidebar.max_entries;
const Stored = struct {
    entry: sidebar.Entry = undefined,
    name: [160]u8 = undefined,
    activity: [512]u8 = undefined,
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    name_len: usize = 0,
    activity_len: usize = 0,
    cwd_len: usize = 0,
    at_ms: i64 = 0,
    closing_ms: ?i64 = null,
    unbound_ms: ?i64 = null,
    ended: bool = false,
    occupied: bool = false,
    seen: bool = false,

    fn copy(buffer: []u8, text: []const u8) usize {
        var n = @min(buffer.len, text.len);
        while (n > 0 and !std.unicode.utf8ValidateSlice(text[0..n])) n -= 1;
        @memcpy(buffer[0..n], text[0..n]);
        return n;
    }
    fn capture(self: *Stored, entry: sidebar.Entry, now_ms: i64) void {
        self.entry = entry;
        self.name_len = copy(&self.name, entry.name);
        self.activity_len = copy(&self.activity, entry.activity);
        self.cwd_len = copy(&self.cwd, entry.cwd);
        self.at_ms = now_ms;
        self.closing_ms = null;
        self.unbound_ms = null;
        self.ended = false;
        self.occupied = true;
    }
    fn view(self: *const Stored, now_ms: i64) sidebar.Entry {
        var entry = self.entry;
        entry.name = self.name[0..self.name_len];
        entry.activity = self.activity[0..self.activity_len];
        entry.cwd = self.cwd[0..self.cwd_len];
        if (self.closing_ms) |start| entry.exit = .{
            .frame_ms = self.at_ms,
            .progress = @as(f64, @floatFromInt(std.math.clamp(now_ms - start, 0, State.duration_ms))) / State.duration_ms,
        };
        return entry;
    }
};

pub const State = struct {
    pub const duration_ms = 240;
    workspace: ?u32 = null,
    slots: [capacity * 2]Stored = @splat(.{}),
    order: [capacity]usize = undefined,
    count: usize = 0,

    /// Drops retained rows so the next update shows the list as is, without
    /// fading out rows that left it (folding a group removes rows instantly).
    pub fn discard(self: *State) void {
        self.workspace = null;
    }
    /// `workspace` keys the list; a new key discards retained rows.
    pub fn update(self: *State, workspace: u32, live: []const sidebar.Entry, out: *[capacity]sidebar.Entry, now_ms: i64) []sidebar.Entry {
        if (self.workspace != workspace) {
            for (&self.slots) |*slot| slot.occupied = false;
            self.count = 0;
            self.workspace = workspace;
        }
        for (&self.slots, 0..) |*slot, index| {
            slot.seen = false;
            if (!slot.occupied or std.mem.indexOfScalar(usize, self.order[0..self.count], index) != null) continue;
            const present = for (live) |entry| {
                if (std.meta.eql(entry.target, slot.entry.target)) break true;
            } else false;
            if (!present) slot.occupied = false;
        }
        var next: [capacity]usize = undefined;
        var count: usize = 0;
        for (live) |entry| {
            const index = find: {
                for (&self.slots, 0..) |*slot, i| {
                    if (slot.occupied and std.meta.eql(slot.entry.target, entry.target)) break :find i;
                }
                for (&self.slots, 0..) |*slot, i| if (!slot.occupied) break :find i;
                unreachable; // At most one current and one departing list.
            };
            const slot = &self.slots[index];
            const lost_binding = slot.occupied and entry.target == .pane and
                slot.entry.provider == entry.provider and slot.entry.conversation != 0 and entry.conversation == 0 and
                (entry.state == .initializing or entry.state == .unknown);
            if (lost_binding and slot.unbound_ms == null) slot.unbound_ms = now_ms;
            // Foreground detection needs two 250 ms polls to confirm exit.
            // Preserve the stable row across temporary loss of title binding,
            // but allow a genuinely new startup to appear after that window.
            const hold = lost_binding and now_ms - slot.unbound_ms.? < 650;
            if (!hold) {
                const same = slot.occupied and slot.entry.conversation == entry.conversation and slot.entry.provider == entry.provider;
                // Native ended sessions remain inspectable history.
                if (same and entry.target == .pane and entry.state == .done and slot.entry.state != .done and slot.closing_ms == null) {
                    slot.closing_ms = now_ms;
                    slot.ended = true;
                }
                if (!same or slot.closing_ms == null or !slot.ended) slot.capture(entry, now_ms);
            }
            slot.seen = true;
            if (slot.closing_ms == null and count < capacity) {
                next[count] = index;
                count += 1;
            }
        }
        // Insert ghosts at their last displayed positions; live targets keep
        // canonical ordering and clicks use this same resulting list.
        for (self.order[0..self.count], 0..) |index, position| {
            const slot = &self.slots[index];
            if (!slot.seen and slot.closing_ms == null) slot.closing_ms = now_ms;
            if (slot.closing_ms) |start| {
                if (now_ms - start < duration_ms and count < capacity) {
                    const at = @min(position, count);
                    std.mem.copyBackwards(usize, next[at + 1 .. count + 1], next[at..count]);
                    next[at] = index;
                    count += 1;
                }
            }
        }
        for (&self.slots) |*slot| {
            if (!slot.occupied or slot.seen) continue;
            if (slot.closing_ms == null or now_ms - slot.closing_ms.? >= duration_ms) slot.occupied = false;
        }
        self.count = count;
        @memcpy(self.order[0..count], next[0..count]);
        for (next[0..count], out[0..count]) |index, *entry| entry.* = self.slots[index].view(now_ms);
        return out[0..count];
    }
};

test "end hook and disappearance share one frozen exit without changing adjacent rows" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    var name = [_]u8{ 'D', 'o', 'g' };
    var live = [_]sidebar.Entry{
        .{ .target = .{ .pane = 1 }, .provider = .codex, .state = .working, .attention = .none, .name = &name },
        .{ .target = .{ .pane = 2 }, .provider = .claude, .state = .idle, .attention = .none },
    };
    _ = rows.update(1, &live, &out, 0);
    name[0] = 'X';
    live[0].state = .done;
    var shown = rows.update(1, &live, &out, 10);
    try std.testing.expectEqualStrings("Dog", shown[0].name);
    try std.testing.expectEqual(.working, shown[0].state);
    try std.testing.expect(shown[0].exit != null);
    shown = rows.update(1, live[1..], &out, 130);
    try std.testing.expectEqual(@as(usize, 2), shown.len);
    try std.testing.expectEqual(@as(u32, 2), shown[1].target.pane);
    try std.testing.expectEqual(@as(f64, 0.5), shown[0].exit.?.progress);
    shown = rows.update(1, live[1..], &out, 250);
    try std.testing.expectEqual(@as(usize, 1), shown.len);
    try std.testing.expectEqual(@as(u32, 2), shown[0].target.pane);
    shown = rows.update(2, &.{}, &out, 260);
    try std.testing.expectEqual(@as(usize, 0), shown.len);
}

test "lost terminal binding holds the label until exit or a real replacement" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    var entry: sidebar.Entry = .{ .target = .{ .pane = 1 }, .conversation = 42, .provider = .codex, .state = .idle, .attention = .none, .name = "Stable name" };
    _ = rows.update(1, &.{entry}, &out, 0);
    entry.conversation = 0;
    entry.name = "";
    entry.state = .initializing;
    var shown = rows.update(1, &.{entry}, &out, 10);
    try std.testing.expectEqualStrings("Stable name", shown[0].name);
    shown = rows.update(1, &.{}, &out, 510);
    try std.testing.expectEqualStrings("Stable name", shown[0].name);
    try std.testing.expect(shown[0].exit != null);
    entry.conversation = 43;
    entry.name = "New session";
    shown = rows.update(1, &.{entry}, &out, 520);
    try std.testing.expect(shown[0].exit == null);
    try std.testing.expectEqualStrings("New session", shown[0].name);
    entry.conversation = 0;
    _ = rows.update(1, &.{entry}, &out, 530);
    shown = rows.update(1, &.{entry}, &out, 1180);
    try std.testing.expectEqual(@as(u32, 0), shown[0].conversation);
}

test "pane removal fades once while ended natives stay visible and same-workspace reordering stays live" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    const pane: sidebar.Entry = .{ .target = .{ .pane = 1 }, .provider = .codex, .state = .idle, .attention = .none };
    var native: sidebar.Entry = .{ .target = .{ .native = 1 }, .provider = .claude, .state = .working, .attention = .none };
    _ = rows.update(1, &.{ pane, native }, &out, 0);
    var shown = rows.update(1, &.{ native, pane }, &out, 10);
    try std.testing.expectEqual(sidebar.Target{ .native = 1 }, shown[0].target);
    native.state = .done;
    shown = rows.update(1, &.{native}, &out, 20);
    try std.testing.expectEqual(@as(usize, 2), shown.len);
    try std.testing.expect(shown[0].exit == null);
    try std.testing.expect(shown[1].exit != null);
    shown = rows.update(1, &.{native}, &out, 260);
    try std.testing.expectEqual(@as(usize, 1), shown.len);
    try std.testing.expectEqual(.done, shown[0].state);
}
