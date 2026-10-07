//! Starting agents: the command line a pane runs, parsed from saved shell
//! source without evaluating it, the daemon's launcher previews of
//! installed providers, signed-in accounts, plan limits and models, and the
//! closed conversations the launcher can resume.
pub const Preview = @import("launch/preview.zig").Preview;
pub const command = @import("launch/command.zig");
pub const preview = @import("launch/preview.zig");
pub const history = @import("launch/history.zig");

test {
    _ = @import("launch/claude.zig");
    _ = @import("launch/command.zig");
    _ = @import("launch/preview.zig");
    _ = @import("launch/history.zig");
}
