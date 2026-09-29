//! Starting agents: the command line a pane runs, parsed from saved shell
//! source without evaluating it, and the daemon's launcher previews of
//! installed providers, signed-in accounts, plan limits and models.
pub const Preview = @import("launch/preview.zig").Preview;
pub const command = @import("launch/command.zig");
pub const preview = @import("launch/preview.zig");

test {
    _ = @import("launch/command.zig");
    _ = @import("launch/preview.zig");
}
