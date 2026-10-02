//! Viewer-owned exit presentation. Keep departing rows inert and in place until
//! their last visible content has faded; never retain borrowed snapshot strings.
const std = @import("std");
const sidebar = @import("sidebar.zig");
const ActorId = @import("conversations.zig").Actor.Id;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const PaneId = @import("layout.zig").PaneId;
const BoundedText = @import("bounded_text.zig").BoundedText;
const capacity = sidebar.max_entries;
const Stored = struct {
    entry: sidebar.Entry = undefined,
    name: BoundedText(160) = .{},
    activity: BoundedText(512) = .{},
    cwd: BoundedText(std.fs.max_path_bytes) = .{},
    at_ms: i64 = 0,
    opening_ms: ?i64 = null,
    closing_ms: ?i64 = null,
    unbound_ms: ?i64 = null,
    ended: bool = false,
    occupied: bool = false,
    seen: bool = false,

    fn capture(self: *Stored, entry: sidebar.Entry, now_ms: i64) void {
        self.entry = entry;
        self.name = .initTruncated(entry.name);
        self.activity = .initTruncated(entry.activity);
        self.cwd = .initTruncated(entry.cwd);
        self.at_ms = now_ms;
        self.closing_ms = null;
        self.unbound_ms = null;
        self.ended = false;
        self.occupied = true;
    }
    fn view(self: *const Stored, now_ms: i64) sidebar.Entry {
        var entry = self.entry;
        entry.name = self.name.text();
        entry.activity = self.activity.text();
        entry.cwd = self.cwd.text();
        if (self.closing_ms) |start| entry.exit = .{
            .frame_ms = self.at_ms,
            .progress = @as(f64, @floatFromInt(std.math.clamp(now_ms - start, 0, State.duration_ms))) / State.duration_ms,
        };
        if (self.opening_ms) |start| if (now_ms - start < State.duration_ms) {
            entry.enter = @as(f64, @floatFromInt(@max(now_ms - start, 0))) / State.duration_ms;
        };
        return entry;
    }
};

pub const State = struct {
    pub const duration_ms = 240;
    workspace: ?WorkspaceId = null,
    slots: [capacity * 2]Stored = @splat(.{}),
    order: [capacity]usize = undefined,
    count: usize = 0,

    /// Drops retained rows so the next update shows the list as is, without
    /// fading out rows that left it (folding a group removes rows instantly).
    pub fn discard(self: *State) void {
        self.workspace = null;
    }
    /// `workspace` keys the list; a new key discards retained rows.
    pub fn update(self: *State, workspace: WorkspaceId, live: []const sidebar.Entry, out: *[capacity]sidebar.Entry, now_ms: i64) []sidebar.Entry {
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
            const arrived = !slot.occupied;
            const lost_binding = slot.occupied and entry.target == .pane and
                slot.entry.provider == entry.provider and slot.entry.conversation != ActorId.none and entry.conversation == ActorId.none and
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
            if (arrived) slot.opening_ms = if (entry.reopened) now_ms else null;
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
        .{ .target = .{ .pane = @enumFromInt(1) }, .provider = .codex, .state = .working, .attention = .none, .name = &name },
        .{ .target = .{ .pane = @enumFromInt(2) }, .provider = .claude, .state = .idle, .attention = .none },
    };
    _ = rows.update(@enumFromInt(1), &live, &out, 0);
    name[0] = 'X';
    live[0].state = .done;
    var shown = rows.update(@enumFromInt(1), &live, &out, 10);
    try std.testing.expectEqualStrings("Dog", shown[0].name);
    try std.testing.expectEqual(.working, shown[0].state);
    try std.testing.expect(shown[0].exit != null);
    shown = rows.update(@enumFromInt(1), live[1..], &out, 130);
    try std.testing.expectEqual(@as(usize, 2), shown.len);
    try std.testing.expectEqual(@as(PaneId, @enumFromInt(2)), shown[1].target.pane);
    try std.testing.expectEqual(@as(f64, 0.5), shown[0].exit.?.progress);
    shown = rows.update(@enumFromInt(1), live[1..], &out, 250);
    try std.testing.expectEqual(@as(usize, 1), shown.len);
    try std.testing.expectEqual(@as(PaneId, @enumFromInt(2)), shown[0].target.pane);
    shown = rows.update(@enumFromInt(2), &.{}, &out, 260);
    try std.testing.expectEqual(@as(usize, 0), shown.len);
}

test "a reopened row fades in as long as a closing one fades out; other new rows just appear" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    const shown_before: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .provider = .claude, .state = .idle, .attention = .none };
    var reopened: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(2) }, .provider = .claude, .state = .idle, .attention = .none, .reopened = true };
    const launched: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(3) }, .provider = .codex, .state = .idle, .attention = .none };
    _ = rows.update(@enumFromInt(1), &.{shown_before}, &out, 0);
    var shown = rows.update(@enumFromInt(1), &.{ shown_before, reopened, launched }, &out, 10);
    try std.testing.expectEqual(null, shown[0].enter);
    try std.testing.expectEqual(@as(?f64, 0), shown[1].enter);
    try std.testing.expectEqual(null, shown[2].enter);
    // It keeps fading in after the agent catches up.
    reopened.reopened = false;
    shown = rows.update(@enumFromInt(1), &.{ shown_before, reopened, launched }, &out, 130);
    try std.testing.expectEqual(@as(?f64, 0.5), shown[1].enter);
    shown = rows.update(@enumFromInt(1), &.{ shown_before, reopened, launched }, &out, 250);
    try std.testing.expectEqual(null, shown[1].enter);
}

test "lost terminal binding holds the label until exit or a real replacement" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    var entry: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .conversation = @enumFromInt(42), .provider = .codex, .state = .idle, .attention = .none, .name = "Stable name" };
    _ = rows.update(@enumFromInt(1), &.{entry}, &out, 0);
    entry.conversation = ActorId.none;
    entry.name = "";
    entry.state = .initializing;
    var shown = rows.update(@enumFromInt(1), &.{entry}, &out, 10);
    try std.testing.expectEqualStrings("Stable name", shown[0].name);
    shown = rows.update(@enumFromInt(1), &.{}, &out, 510);
    try std.testing.expectEqualStrings("Stable name", shown[0].name);
    try std.testing.expect(shown[0].exit != null);
    entry.conversation = @enumFromInt(43);
    entry.name = "New session";
    shown = rows.update(@enumFromInt(1), &.{entry}, &out, 520);
    try std.testing.expect(shown[0].exit == null);
    try std.testing.expectEqualStrings("New session", shown[0].name);
    entry.conversation = ActorId.none;
    _ = rows.update(@enumFromInt(1), &.{entry}, &out, 530);
    shown = rows.update(@enumFromInt(1), &.{entry}, &out, 1180);
    try std.testing.expectEqual(ActorId.none, shown[0].conversation);
}

test "pane removal fades once while ended natives stay visible and same-workspace reordering stays live" {
    var rows: State = .{};
    var out: [capacity]sidebar.Entry = undefined;
    const pane: sidebar.Entry = .{ .target = .{ .pane = @enumFromInt(1) }, .provider = .codex, .state = .idle, .attention = .none };
    var native: sidebar.Entry = .{ .target = .{ .native = @enumFromInt(1) }, .provider = .claude, .state = .working, .attention = .none };
    _ = rows.update(@enumFromInt(1), &.{ pane, native }, &out, 0);
    var shown = rows.update(@enumFromInt(1), &.{ native, pane }, &out, 10);
    try std.testing.expectEqual(sidebar.Target{ .native = @enumFromInt(1) }, shown[0].target);
    native.state = .done;
    shown = rows.update(@enumFromInt(1), &.{native}, &out, 20);
    try std.testing.expectEqual(@as(usize, 2), shown.len);
    try std.testing.expect(shown[0].exit == null);
    try std.testing.expect(shown[1].exit != null);
    shown = rows.update(@enumFromInt(1), &.{native}, &out, 260);
    try std.testing.expectEqual(@as(usize, 1), shown.len);
    try std.testing.expectEqual(.done, shown[0].state);
}
