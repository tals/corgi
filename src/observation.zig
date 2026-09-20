//! Provider-independent completion receipts. Observation sources describe facts;
//! presentation and notification code consume these monotonic receipts.
const std = @import("std");
pub const Source = enum { unknown, screen, hook, transcript, protocol };
pub const Outcome = enum { completed, interrupted, failed };
pub const State = struct {
    source: Source = .unknown,
    pending_stop: bool = false,
    completed: u64 = 0,
    read: u64 = 0,
    outcome: Outcome = .completed,

    pub fn unread(s: State) bool {
        return s.completed > s.read;
    }
    pub fn finish(s: *State, outcome: Outcome, source: Source) void {
        s.pending_stop = false;
        s.source = source;
        s.outcome = outcome;
        s.completed +|= 1;
    }
    pub fn acknowledge(s: *State, through: u64) void {
        s.read = @max(s.read, @min(through, s.completed));
    }
};

test "late receipts cannot read newer completions; starting work does not read results" {
    var s: State = .{};
    s.finish(.completed, .transcript);
    const displayed = s.completed;
    s.finish(.completed, .protocol);
    s.acknowledge(displayed);
    try std.testing.expect(s.unread());
    s.acknowledge(s.completed);
    try std.testing.expect(!s.unread());
}
