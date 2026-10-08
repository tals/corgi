//! Warn once per distinct failure of a repeating job (AGENTS.md "Logging").
const std = @import("std");

pub const Failure = struct {
    last: ?anyerror = null,

    /// True when `err` differs from the last failure; remembers it.
    pub fn changed(f: *Failure, err: anyerror) bool {
        defer f.last = err;
        return if (f.last) |previous| previous != err else true;
    }
    /// The job succeeded. True if it had been failing.
    pub fn clear(f: *Failure) bool {
        defer f.last = null;
        return f.last != null;
    }
};

test "logs a failure once until it changes or recovers" {
    var f: Failure = .{};
    try std.testing.expect(f.changed(error.A));
    try std.testing.expect(!f.changed(error.A));
    try std.testing.expect(f.changed(error.B));
    try std.testing.expect(f.clear());
    try std.testing.expect(f.changed(error.B));
}
