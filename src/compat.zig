//! Standard library code Corgi needs before its Zig version has it.
//!
//! `timedWait` is Zig 0.17's `std.Io.Condition.waitTimeout`, by way of
//! Ghostty's `lib/compat/thread.zig`. Zig is MIT licensed, Copyright (c) Zig
//! contributors. Remove it once Corgi builds with Zig 0.17.
const std = @import("std");
const assert = std.debug.assert;

/// Blocks until `cond` is signaled or `ns` pass. Like `Condition.wait`, it
/// releases `mutex` while waiting and holds it again on return.
pub fn timedWait(cond: *std.Io.Condition, io: std.Io, mutex: *std.Io.Mutex, ns: u64) (std.Io.Cancelable || std.Io.Timeout.Error)!void {
    const timeout: std.Io.Timeout = .{ .duration = .{ .clock = .awake, .raw = .fromNanoseconds(ns) } };
    const deadline = timeout.toDeadline(io);

    var epoch = cond.epoch.load(.acquire); // `.acquire` to ensure ordered before state load

    {
        const prev_state = cond.state.fetchAdd(.{ .waiters = 1, .signals = 0 }, .monotonic);
        assert(prev_state.waiters < std.math.maxInt(u16)); // overflow caused by too many waiters
    }

    mutex.unlock(io);
    defer mutex.lockUncancelable(io);

    while (true) {
        const result = io.futexWaitTimeout(u32, &cond.epoch.raw, epoch, deadline);

        epoch = cond.epoch.load(.acquire); // `.acquire` to ensure ordered before `state` load

        // Even on error, try to consume a pending signal first. Otherwise a race might
        // cause a signal to get stuck in the state with no corresponding waiter.
        {
            var prev_state = cond.state.load(.monotonic);
            while (prev_state.signals > 0) {
                prev_state = cond.state.cmpxchgWeak(prev_state, .{
                    .waiters = prev_state.waiters - 1,
                    .signals = prev_state.signals - 1,
                }, .acquire, .monotonic) orelse {
                    // We successfully consumed a signal.
                    return;
                };
            }
        }

        // There are no more signals available; this was a spurious wakeup or an error. If it
        // was an error, we will remove ourselves as a waiter and return that error. If the
        // deadline has passed, we remove ourselves as a waiter and return `error.Timeout`.
        // Otherwise, we'll loop back to the futex wait.
        result catch |err| {
            const prev_state = cond.state.fetchSub(.{ .waiters = 1, .signals = 0 }, .monotonic);
            assert(prev_state.waiters > 0); // underflow caused by illegal state
            return err;
        };
        if (deadline.deadline.untilNow(io).raw.nanoseconds >= 0) {
            const prev_state = cond.state.fetchSub(.{ .waiters = 1, .signals = 0 }, .monotonic);
            assert(prev_state.waiters > 0); // underflow caused by illegal state
            return error.Timeout;
        }
    }
}

test "a timed wait times out without a signal and returns on one" {
    const io = std.testing.io;
    var mutex: std.Io.Mutex = .init;
    var cond: std.Io.Condition = .init;
    mutex.lockUncancelable(io);
    defer mutex.unlock(io);
    try std.testing.expectError(error.Timeout, timedWait(&cond, io, &mutex, std.time.ns_per_ms));

    const Signaler = struct {
        fn run(c: *std.Io.Condition, m: *std.Io.Mutex) void {
            m.lockUncancelable(std.testing.io);
            defer m.unlock(std.testing.io);
            c.signal(std.testing.io);
        }
    };
    const thread = try std.Thread.spawn(.{}, Signaler.run, .{ &cond, &mutex });
    defer thread.join();
    try timedWait(&cond, io, &mutex, 10 * std.time.ns_per_s);
}
