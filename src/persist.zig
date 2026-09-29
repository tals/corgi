//! Saved state. The checkpoint is the runtime state a live handoff passes to
//! the next daemon and a recovery snapshot keeps on disk; migrations read
//! both from older releases through the released steps.
pub const handoff = @import("persist/handoff.zig");
pub const migrations = @import("persist/migrations.zig");
pub const recovery = @import("persist/recovery.zig");

test {
    _ = @import("persist/checkpoint.zig");
    _ = @import("persist/checkpoint_test.zig");
    _ = @import("persist/handoff.zig");
    _ = @import("persist/migrations.zig");
    _ = @import("persist/probe.zig");
    _ = @import("persist/recovery.zig");
    _ = @import("persist/steps.zig");
}
