//! What each agent is doing: the evidence gathered from its transcript and
//! tools, the timeline of its activity, its background tasks, and the worker
//! that turns evidence into a short label through Corgi's own inference.
pub const background_tasks = @import("activity/background_tasks.zig");
pub const prompt = @import("activity/prompt.zig");
pub const summary = @import("activity/summary.zig");
pub const timeline = @import("activity/timeline.zig");
pub const tools = @import("activity/tools.zig");
pub const worker = @import("activity/worker.zig");

test {
    _ = @import("activity/background_tasks.zig");
    _ = @import("activity/prompt.zig");
    _ = @import("activity/summary.zig");
    _ = @import("activity/timeline.zig");
    _ = @import("activity/tools.zig");
    _ = @import("activity/worker.zig");
}
