//! Bringing workspaces over from tmux, cmux and Herdr. The onboarding wizard
//! scans each source through the read-only catalog in the viewer; the daemon
//! then copies the chosen workspaces into the runtime, or takes over Herdr's
//! live panes through its handoff.
pub const catalog = @import("import/catalog.zig");
pub const herdr = @import("import/herdr.zig");
pub const onboarding = @import("import/onboarding.zig");

test {
    _ = @import("import/catalog.zig");
    _ = @import("import/cmux.zig");
    _ = @import("import/cmux_test.zig");
    _ = @import("import/herdr.zig");
    _ = @import("import/layout.zig");
    _ = @import("import/onboarding.zig");
    _ = @import("import/tmux_layout.zig");
    _ = @import("import/tmux_resume.zig");
}
