//! Lets a caller wait until a polling worker finishes a pass that began after
//! its request (tests use it to settle the daemon). Guarded by the worker's mutex.
const os = @import("os.zig");
pub const Passes = struct {
    done: u64 = 0,
    wanted: u64 = 0,

    /// Worker loop: call at the top of each iteration; true while a waiter
    /// wants more passes, so the worker should not sleep.
    pub fn next(p: *Passes) bool {
        p.done +%= 1;
        return p.done < p.wanted;
    }
    /// The pass count that proves a full pass began after this call.
    pub fn request(p: *Passes) u64 {
        p.wanted = @max(p.wanted, p.done + 2);
        return p.wanted;
    }
};

/// Wake `worker` (anything with `mutex`, `wake` and `passes`) and return the
/// pass count to wait for.
pub fn settle(worker: anytype) u64 {
    worker.mutex.lockUncancelable(os.io());
    defer worker.mutex.unlock(os.io());
    worker.wake.signal(os.io());
    return worker.passes.request();
}
pub fn reached(worker: anytype, target: u64) bool {
    worker.mutex.lockUncancelable(os.io());
    defer worker.mutex.unlock(os.io());
    return worker.passes.done >= target;
}
