//! What the daemon watches beside the agents, each on its own background
//! refresh: git status and pushes, listening ports and the names inferred
//! for their links, and the CPU and memory each pane's processes use.
pub const git_push = @import("trackers/git_push.zig");
pub const git_status = @import("trackers/git_status.zig");
pub const link_labels = @import("trackers/link_labels.zig");
pub const ports = @import("trackers/ports.zig");
pub const resources = @import("trackers/resources.zig");

test {
    _ = @import("trackers/git_push.zig");
    _ = @import("trackers/git_status.zig");
    _ = @import("trackers/link_labels.zig");
    _ = @import("trackers/ports.zig");
    _ = @import("trackers/resource_os.zig");
    _ = @import("trackers/resources.zig");
}
