//! One pane's terminal: its PTY and Ghostty state, the rendered surface a
//! viewer draws, and the hyperlinks under its cells.
pub const Terminal = @import("pane/terminal.zig").Terminal;
pub const hyperlinks = @import("pane/hyperlinks.zig");
pub const surface = @import("pane/surface.zig");
pub const terminal = @import("pane/terminal.zig");

test {
    _ = @import("pane/hyperlinks.zig");
    _ = @import("pane/surface.zig");
    _ = @import("pane/terminal.zig");
}
