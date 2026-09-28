//! Daemon socket connection, subscriptions and queued viewer controls.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const surface = @import("surface.zig");
const agent_launcher = @import("agent_launcher.zig");
const viewer_protocol = @import("viewer_protocol.zig");
const Path = @import("bounded_text.zig").Path;
pub const Interest = struct { pane: layout.PaneId, cols: u16, rows: u16, offset: ?usize = null, known: ?surface.Stamp = null };
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
pub const LaunchPreview = struct {
    cwd: Path,
    preview: agent_launcher.Preview,
    checked: i64 = 0,
};
pub const Client = struct {
    viewer_id: u32 = 0,
    /// Server-wide activity order; the highest stamp sizes shared panes.
    active_seq: u64 = 0,
    next_control: u64 = 1,
    last_control: u64 = 0,
    view_workspace: WorkspaceId = .none,
    controls: std.ArrayList(Control) = .empty,
    viewer: bool = false,
    view_focus: ?layout.PaneId = null,
    interests: [layout.max_panes]Interest = undefined,
    interest_count: usize = 0,
    fd: c_int,
    input: std.ArrayList(u8) = .empty,
    output: std.ArrayList(u8) = .empty,
    sent: usize = 0,
    protocol_version: ?u32 = null,
    subscribed: bool = false,
    launch_preview: ?LaunchPreview = null,
    snapshot_revision: ?u64 = null,
    last_snapshot: i64 = 0,
    watched: bool = true,
    resource_detail: ?WorkspaceId = null,
    /// False once this viewer's resource row is off; see `server.zig`.
    resources: bool = true,
    dead: bool = false,
    touched: i64 = 0,
    /// Queue one reply line. A client whose reply cannot be queued (too much
    /// pending output, or no memory) is disconnected; the daemon keeps serving.
    pub fn queue(cl: *Client, value: anytype) void {
        // Serialize in place: a session snapshot is hundreds of KB, and a
        // separate buffer would be allocated, copied and freed every sync.
        const start = cl.output.items.len;
        var out: std.Io.Writer.Allocating = .fromArrayList(a, &cl.output);
        defer cl.output = out.toArrayList();
        const written = if (std.json.Stringify.value(value, .{}, &out.writer)) out.writer.writeByte('\n') else |err| err;
        if (written) {
            if (out.writer.end <= 4 * 1024 * 1024) return;
        } else |_| {}
        out.writer.end = start;
        cl.dead = true;
    }
    pub fn deinit(cl: *Client) void {
        viewer_protocol.clearControls(cl);
        cl.controls.deinit(a);
        _ = c.close(cl.fd);
        cl.input.deinit(a);
        cl.output.deinit(a);
    }
};

test "replies queue as lines and an oversized one drops the client without a partial line" {
    var cl: Client = .{ .fd = -1 };
    defer cl.output.deinit(a);
    cl.queue(.{ .ok = true });
    cl.queue(.{ .n = 1 });
    try std.testing.expectEqualStrings("{\"ok\":true}\n{\"n\":1}\n", cl.output.items);
    const big = try a.alloc(u8, 4 * 1024 * 1024);
    defer a.free(big);
    @memset(big, 'x');
    cl.queue(.{ .text = big });
    try std.testing.expect(cl.dead);
    try std.testing.expectEqualStrings("{\"ok\":true}\n{\"n\":1}\n", cl.output.items);
}
