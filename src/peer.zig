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
pub const Interest = struct { pane: layout.PaneId, cols: u16, rows: u16, offset: ?usize = null, known: ?surface.Stamp = null };
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
pub const LaunchPreview = struct {
    cwd: [std.fs.max_path_bytes]u8 = @splat(0),
    len: usize,
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
        const data = std.json.Stringify.valueAlloc(a, value, .{}) catch {
            cl.dead = true;
            return;
        };
        defer a.free(data);
        if (cl.output.items.len + data.len > 4 * 1024 * 1024) {
            cl.dead = true;
            return;
        }
        cl.output.ensureUnusedCapacity(a, data.len + 1) catch {
            cl.dead = true;
            return;
        };
        cl.output.appendSliceAssumeCapacity(data);
        cl.output.appendAssumeCapacity('\n');
    }
    pub fn deinit(cl: *Client) void {
        viewer_protocol.clearControls(cl);
        cl.controls.deinit(a);
        _ = c.close(cl.fd);
        cl.input.deinit(a);
        cl.output.deinit(a);
    }
};
