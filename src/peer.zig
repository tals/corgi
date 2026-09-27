//! Daemon socket connection, subscriptions and queued viewer controls.
const std = @import("std");
const os = @import("os.zig");
const c = os.c;
const a = os.allocator;
const layout = @import("layout.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
pub const Interest = struct { pane: layout.PaneId, cols: u16, rows: u16, offset: ?usize = null, known: ?@import("surface.zig").Stamp = null };
pub const Control = struct { seq: u64 = 0, kind: enum { focus, workspace, action }, id: u32 = 0, name: []const u8 = "", value: []const u8 = "" };
pub const LaunchPreview = struct {
    cwd: [std.fs.max_path_bytes]u8 = @splat(0),
    len: usize,
    preview: @import("agent_launcher.zig").Preview,
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
    dead: bool = false,
    touched: i64 = 0,
    pub fn queue(cl: *Client, value: anytype) !void {
        const data = try std.json.Stringify.valueAlloc(a, value, .{});
        defer a.free(data);
        if (cl.output.items.len + data.len > 4 * 1024 * 1024) {
            cl.dead = true;
            return;
        }
        try cl.output.appendSlice(a, data);
        try cl.output.append(a, '\n');
    }
    pub fn deinit(cl: *Client) void {
        @import("viewer_protocol.zig").clearControls(cl);
        cl.controls.deinit(a);
        _ = c.close(cl.fd);
        cl.input.deinit(a);
        cl.output.deinit(a);
    }
};
