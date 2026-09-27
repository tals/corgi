//! Tooltip timing is viewer-local. Interaction suppresses it until a fresh move.
const std = @import("std");
const ActorId = @import("conversations.zig").Actor.Id;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const layout = @import("layout.zig");
const sidebar = @import("sidebar.zig");
pub const Target = struct { resource: ?WorkspaceId = null, pane: layout.PaneId, link: u64, git: bool = false, usage: bool = false, conversation: ActorId = .none, agent: ?sidebar.Target = null };
pub const State = struct {
    suppressed: bool = true,
    target: ?Target = null,
    since: i64 = 0,
    shown: bool = false,
    pub fn cancel(s: *State) void {
        s.suppressed = true;
        s.target = null;
        s.shown = false;
    }
    pub fn move(s: *State) void {
        s.suppressed = false;
        s.target = null;
        s.shown = false;
    }
    pub fn due(s: *const State, now: i64) bool {
        return !s.suppressed and s.target != null and !s.shown and now - s.since >= 500;
    }
    pub fn ready(s: *State, target: ?Target, now: i64) bool {
        if (s.suppressed or target == null) {
            s.target = null;
            s.shown = false;
            return false;
        }
        if (s.target == null or !std.meta.eql(s.target.?, target.?)) {
            s.target = target;
            s.since = now;
            s.shown = false;
            return false;
        }
        s.shown = now - s.since >= 500;
        return s.shown;
    }
};

test "tooltip waits for rest and requires fresh movement after interaction" {
    var s: State = .{};
    const target: Target = .{ .pane = @enumFromInt(1), .link = 2 };
    try std.testing.expect(!s.ready(target, 0));
    s.move();
    try std.testing.expect(!s.ready(target, 100));
    try std.testing.expect(!s.ready(target, 599));
    try std.testing.expect(s.ready(target, 600));
    s.cancel();
    try std.testing.expect(!s.ready(target, 2000));
    s.move();
    try std.testing.expect(!s.ready(target, 2001));
    try std.testing.expect(s.ready(target, 2501));
    try std.testing.expect(!s.ready(.{ .pane = @enumFromInt(2), .link = 2 }, 2502));
    try std.testing.expect(!s.ready(null, 4000));
    try std.testing.expect(!s.ready(target, 4001));
}
