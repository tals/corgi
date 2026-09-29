//! One pane's terminal: its PTY and Ghostty state, the rendered surface a
//! viewer draws, the hyperlinks under its cells, and its display label.
pub const Terminal = @import("pane/terminal.zig").Terminal;
pub const hyperlinks = @import("pane/hyperlinks.zig");
pub const label = @import("pane/label.zig");
pub const surface = @import("pane/surface.zig");
pub const terminal = @import("pane/terminal.zig");

test {
    _ = @import("pane/hyperlinks.zig");
    _ = @import("pane/label.zig");
    _ = @import("pane/surface.zig");
    _ = @import("pane/terminal.zig");
}
