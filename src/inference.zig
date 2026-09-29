//! Corgi's own inference: fresh, tool-free conversations with an agent's
//! native harness that name activity and links. `Pool` runs them, `setup`
//! picks whose harness answers, and inference/usage.zig meters their tokens.
pub const Checkpoint = @import("inference/harness.zig").Checkpoint;
pub const Pool = @import("inference/harness.zig").Pool;
pub const Provider = @import("inference/harness.zig").Provider;
pub const setup = @import("inference/setup.zig");

test {
    _ = @import("inference/harness.zig");
    _ = @import("inference/setup.zig");
    _ = @import("inference/usage.zig");
}
