//! Claude owns authentication and quota reads. This worker sends control
//! requests only; no model prompt or user status-line configuration is used.
const std = @import("std");
const os = @import("../os.zig");
const native = @import("../native.zig");
const conversations = @import("../conversations.zig");
const discovery = @import("../discovery.zig");
const subprocess = @import("../subprocess.zig");
const Claude = @import("../providers/claude.zig").Claude;
const common = @import("../providers/common.zig");
const metadata = @import("../usage.zig").account;
const account_cache = @import("../usage.zig").account_cache;
const a = os.allocator;

pub const Client = struct {
    session: ?native.Session = null,
    registry: conversations.Registry = .{ .allocator = a },
    cursor: u64 = 0,
    next_id: u64 = 0,
    identity: ?[]const u8 = null,
    account: metadata.Info = .{},
    next_auth: i64 = 0,

    pub fn deinit(c: *Client) void {
        c.close();
        if (c.identity) |identity| a.free(identity);
    }
    fn close(c: *Client) void {
        if (c.session) |*session| session.destroy();
        c.session = null;
        c.registry.deinit();
        c.registry = .{ .allocator = a };
        c.cursor = 0;
    }
    pub fn preview(c: *Client, stopping: *const std.atomic.Value(bool), quit: *const subprocess.Quit) metadata.Info {
        return c.read(stopping, quit) catch |err| {
            c.account.usage_error = .ascii(if (err == error.TimedOut or err == error.Timeout) "request timed out" else "Claude account unavailable");
            return c.account;
        };
    }
    fn read(c: *Client, stopping: *const std.atomic.Value(bool), quit: *const subprocess.Quit) !metadata.Info {
        const now = os.timestamp();
        const executable = try discovery.resolve(.claude, null);
        defer a.free(executable);
        if (now >= c.next_auth) {
            c.next_auth = now + account_cache.interval;
            c.account = .{};
            errdefer c.close();
            const output = try subprocess.run(a, &.{ executable, "auth", "status", "--json" }, .{
                .cwd = "/tmp",
                .timeout_ms = 5000,
                .max_output = 16384,
                .quit = quit,
            });
            defer output.deinit(a);
            const parsed = try std.json.parseFromSlice(std.json.Value, a, output.stdout, .{});
            defer parsed.deinit();
            var account = metadata.claudeAccount(parsed.value);
            // A failed process is not evidence of sign-out, except the CLI's
            // documented exit 1 with an explicit loggedIn:false response.
            if (account.signed_in == null or (!output.ok() and !(output.term == .exited and output.term.exited == 1 and account.signed_in == false))) return error.InvalidAccount;
            if (account.signed_in == true and account.limits != .metered and common.str(parsed.value, "email").len == 0) {
                account.usage_error = .ascii("usage account unavailable");
            }
            const root = try Claude.info.configDir(a);
            defer a.free(root);
            const identity = try std.json.Stringify.valueAlloc(a, .{
                .executable = executable,
                .root = root,
                .email = common.str(parsed.value, "email"),
                .organization = common.str(parsed.value, "orgId"),
                .method = common.str(parsed.value, "authMethod"),
                .provider = common.str(parsed.value, "apiProvider"),
            }, .{});
            if (c.identity == null or !std.mem.eql(u8, c.identity.?, identity)) {
                c.close();
                if (c.identity) |previous| a.free(previous);
                c.identity = identity;
            } else a.free(identity);
            c.account = account;
        }
        if (c.account.signed_in != true or c.account.limits == .metered or c.account.usage_error.len != 0) {
            c.close();
            return c.account;
        }
        var cache = try account_cache.Cache.open("claude-cli", c.identity.?, stopping);
        defer cache.close();
        cache.state.info.signed_in = c.account.signed_in;
        cache.state.info.account = c.account.account;
        if (c.account.plan.len > 0) cache.state.info.plan = c.account.plan;
        if (now < cache.state.next_usage) return cache.state.display(now);
        cache.state.next_usage = now + account_cache.interval;
        try cache.save();
        var fresh = c.account;
        c.usage(executable, &fresh, stopping, quit) catch |err| {
            c.close();
            fresh.usage_error = .ascii(switch (err) {
                error.Timeout => "request timed out",
                error.UnsupportedUsage => "Claude usage request unsupported",
                error.UsageUnavailable => "usage unavailable for this login",
                else => "Claude usage unavailable",
            });
            cache.state.next_usage = now + account_cache.cooldown;
        };
        cache.state.update(fresh, now);
        try cache.save();
        return cache.state.display(now);
    }
    fn usage(c: *Client, executable: []const u8, info: *metadata.Info, stopping: *const std.atomic.Value(bool), quit: *const subprocess.Quit) !void {
        const deadline = os.milliTimestamp() + 5000;
        if (c.session == null) {
            c.session = try native.Session.startWithOptions(native.Session.Id.none, .claude, "/tmp", .{
                .executable = executable,
                .inference = true,
                .args = &.{ "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json", "--no-session-persistence", "--setting-sources", "", "--settings", "{\"disableAllHooks\":true,\"remoteControlAtStartup\":false}", "--strict-mcp-config", "--mcp-config", "{\"mcpServers\":{}}", "--tools", "" },
            });
            const initialized = try c.request(.initialize, stopping, quit, deadline);
            initialized.deinit();
        }
        const reply = try c.request(.get_usage, stopping, quit, deadline);
        defer reply.deinit();
        try applyUsage(info, common.field(common.field(reply.value, "response"), "response"));
    }
    fn request(c: *Client, method: Claude.ControlMethod, stopping: *const std.atomic.Value(bool), quit: *const subprocess.Quit, deadline: i64) !std.json.Parsed(std.json.Value) {
        c.next_id += 1;
        var buffer: [32]u8 = undefined;
        const id = try std.fmt.bufPrint(&buffer, "usage-{d}", .{c.next_id});
        const bytes = try std.json.Stringify.valueAlloc(a, .{ .type = "control_request", .request_id = id, .request = .{ .subtype = @tagName(method), .skip_behaviors = true } }, .{});
        defer a.free(bytes);
        const message = try std.json.parseFromSlice(std.json.Value, a, bytes, .{});
        defer message.deinit();
        const session = &c.session.?;
        try session.send(&c.registry, message.value);
        while (true) {
            if (stopping.load(.acquire)) return error.Cancelled;
            const remaining = deadline - os.milliTimestamp();
            if (remaining <= 0) return error.Timeout;
            _ = try session.poll(&c.registry);
            if (session.approvals.items.len != 0) return error.UnexpectedRequest;
            for (session.events.items) |event| {
                if (event.seq <= c.cursor) continue;
                c.cursor = event.seq;
                const parsed = try std.json.parseFromSlice(std.json.Value, a, event.line, .{ .allocate = .alloc_always });
                const response = common.field(parsed.value, "response");
                if (std.meta.stringToEnum(Claude.MessageType, common.str(parsed.value, "type")) == .control_response and std.mem.eql(u8, common.str(response, "request_id"), id)) {
                    if (!std.mem.eql(u8, common.str(response, "subtype"), "success")) {
                        parsed.deinit();
                        return error.UnsupportedUsage;
                    }
                    return parsed;
                }
                parsed.deinit();
            }
            if (session.exited or session.reap()) return error.HarnessExited;
            var fds = [_]std.posix.pollfd{
                .{ .fd = session.child.stdout.?.handle, .events = std.posix.POLL.IN, .revents = 0 },
                .{ .fd = quit.read, .events = std.posix.POLL.IN, .revents = 0 },
            };
            _ = try std.posix.poll(&fds, @intCast(@min(remaining, 5000)));
            if (fds[1].revents != 0) return error.Cancelled;
        }
    }
};

fn applyUsage(info: *metadata.Info, value: std.json.Value) !void {
    const available = common.field(value, "rate_limits_available");
    if (available != .bool) return error.InvalidUsage;
    if (!available.bool) return error.UsageUnavailable;
    const limits = metadata.limits(common.field(value, "rate_limits"), .claude);
    if (limits == .none) return error.InvalidUsage;
    info.limits = limits;
    info.usage_error = .{};
    const plan = common.str(value, "subscription_type");
    if (plan.len > 0) info.plan = Claude.plan(plan, "");
}

test "Claude control usage preserves login on unsupported or malformed quota data" {
    var info: metadata.Info = .{ .signed_in = true, .account = .ascii("account@example.com") };
    try std.testing.expectError(error.InvalidUsage, applyUsage(&info, .null));
    const missing = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"rate_limits_available\":false}", .{});
    defer missing.deinit();
    try std.testing.expectError(error.UsageUnavailable, applyUsage(&info, missing.value));
    try std.testing.expectEqual(true, info.signed_in.?);
    try std.testing.expectEqualStrings("account@example.com", info.account.text());
    try std.testing.expect(info.limits == .none);
    const valid = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\{"rate_limits_available":true,"subscription_type":"pro","rate_limits":{"five_hour":{"utilization":0},"seven_day":{"utilization":33}}}
    , .{});
    defer valid.deinit();
    try applyUsage(&info, valid.value);
    try std.testing.expectEqual(@as(u8, 0), info.limits.windows[0].?.used);
    try std.testing.expectEqual(@as(u8, 33), info.limits.windows[1].?.used);
}
