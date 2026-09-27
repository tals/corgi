//! "Now" for policy timers (cooldowns, retries, evidence windows). Test builds
//! add an offset that the `test.advance` operation moves forward, so tests
//! can let a window pass without waiting. Other builds read the system clock.
//!
//! Only compare these readings with each other or with stamps from the past.
//! Stamps other processes create (hook sequence numbers, transcript times)
//! use the system clock and must not be ordered against a shifted reading.
const std = @import("std");
const enabled = @import("corgi_options").test_build;

var offset_ms: std.atomic.Value(i64) = .init(0);

pub fn milliTimestamp() i64 {
    return std.time.milliTimestamp() + offset();
}
pub fn microTimestamp() i64 {
    return std.time.microTimestamp() + offset() * std.time.us_per_ms;
}
pub fn advance(ms: i64) void {
    if (enabled) _ = offset_ms.fetchAdd(ms, .monotonic);
}
fn offset() i64 {
    return if (enabled) offset_ms.load(.monotonic) else 0;
}
