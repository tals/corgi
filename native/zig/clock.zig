//! "Now" for policy timers (cooldowns, retries, evidence windows, the
//! viewer's hover cards and copy feedback). Test builds add an offset that
//! the `test.advance` operation (or the viewer test driver's `advance`) moves
//! forward, so tests can let a window pass without waiting. Other builds read
//! the system clock.
//!
//! Use it only where every stamp being compared is also taken from this
//! clock (a cooldown's deadline, a rescan's schedule). A window measured from
//! system-clock stamps that keep being refreshed, such as hook sequence
//! numbers from other processes, would stay expired after an advance even
//! though fresh evidence arrives. Stamp such evidence from this clock when
//! the daemon applies it instead, as `Agent.protocol_at` does.
const std = @import("std");
const os = @import("os.zig");
const enabled = @import("corgi_options").test_build;

var offset_ms: std.atomic.Value(i64) = .init(0);

pub fn milliTimestamp() i64 {
    return os.milliTimestamp() + offset();
}
pub fn microTimestamp() i64 {
    return os.microTimestamp() + offset() * std.time.us_per_ms;
}
pub fn advance(ms: i64) void {
    if (enabled) _ = offset_ms.fetchAdd(ms, .monotonic);
}
fn offset() i64 {
    return if (enabled) offset_ms.load(.monotonic) else 0;
}
