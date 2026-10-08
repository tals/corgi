//! The agent session last seen in a pane, saved so recovery can name it
//! and offer the command that resumes it.
const std = @import("std");
const agents = @import("agents.zig");
const claude_daemon = @import("claude_daemon.zig");

pub const ResumeHint = struct {
    name: agents.Text = .{},
    touched_at: i64 = 0,
    provider: ?agents.Provider = null,
    session: agents.Text = .{},
    pub fn observe(r: *ResumeHint, agent: *const agents.Agent) void {
        const provider = agent.provider orelse return;
        if (agent.session.len > 0) {
            if (r.provider != provider or !std.mem.eql(u8, r.session.text(), agent.sessionId())) {
                r.name = .{};
                r.touched_at = 0;
            }
            if (agent.name.len > 0) r.name = agent.name;
            r.touched_at = @max(r.touched_at, @max(agent.updated_at, @divTrunc(agent.changed_at, std.time.us_per_s)));
            r.provider = provider;
            r.session = agent.session;
        } else if (r.provider == null) r.provider = provider;
    }
    pub fn banner(r: ResumeHint, alloc: std.mem.Allocator, now: i64) ![]const u8 {
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try out.writer.writeAll("\x1b[0m\r\n\r\n");
        if (r.name.len > 0) {
            try out.writer.writeAll("# ");
            for (r.name.text()) |ch| try out.writer.writeByte(if (ch < 32 or ch == 127) ' ' else ch);
            try out.writer.writeAll("\r\n");
        }
        if (r.touched_at > 0) {
            const seconds = @max(0, now - r.touched_at);
            try out.writer.writeAll("\x1b[2m# Last active ");
            if (seconds < 60) try out.writer.writeAll("just now") else {
                const unit: i64 = if (seconds < 3600) 60 else if (seconds < 86400) 3600 else 86400;
                const label: []const u8 = if (unit == 60) "minute" else if (unit == 3600) "hour" else "day";
                const count = @divTrunc(seconds, unit);
                try out.writer.print("{d} {s}{s} ago", .{ count, label, if (count == 1) "" else "s" });
            }
            try out.writer.writeAll("\x1b[0m\r\n");
        }
        return out.toOwnedSlice();
    }
    /// The argv that resumes the session, or null when none is known.
    pub fn args(r: *const ResumeHint) ?[3][]const u8 {
        const provider = r.provider orelse return null;
        return provider.info().resumeArgs(.{ .id = r.session.text() }) catch null;
    }
    /// The job Claude's background daemon runs the session as, if it does.
    /// `claude --resume` refuses such a session; `claude attach` opens it.
    pub fn backgroundJob(r: *const ResumeHint) ?claude_daemon.JobId {
        if (r.provider != .claude or r.args() == null) return null;
        return claude_daemon.job(r.session.text());
    }
    /// The command that reopens the session now, or "" when none is known.
    pub fn command(r: ResumeHint, alloc: std.mem.Allocator) ![]const u8 {
        if (r.backgroundJob()) |job| return claude_daemon.attachCommand(alloc, job);
        const argv = r.args() orelse return alloc.dupe(u8, "");
        var out: std.Io.Writer.Allocating = .init(alloc);
        errdefer out.deinit();
        try out.writer.print("{s} {s} '", .{ argv[0], argv[1] });
        for (argv[2]) |ch| {
            if (ch == '\'') try out.writer.writeAll("'\\''") else try out.writer.writeByte(ch);
        }
        try out.writer.writeByte('\'');
        return out.toOwnedSlice();
    }
};

test "resume command quotes session text as one shell argument" {
    const alloc = std.testing.allocator;
    var hint: ResumeHint = .{ .provider = .codex };
    hint.session = .ascii("session'with quote");
    const command = try hint.command(alloc);
    defer alloc.free(command);
    try std.testing.expectEqualStrings("codex resume 'session'\\''with quote'", command);
}

test "recovery metadata survives observation and clears on session switch" {
    const alloc = std.testing.allocator;
    var agent: agents.Agent = .{ .provider = .codex, .updated_at = 1000 };
    agent.session = .ascii("first");
    agent.setName("A session\nwith controls\x1b");
    var hint: ResumeHint = .{};
    hint.observe(&agent);
    const banner = try hint.banner(alloc, 1120);
    defer alloc.free(banner);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# A session with controls ") != null);
    try std.testing.expect(std.mem.indexOf(u8, banner, "# Last active 2 minutes ago") != null);
    agent.session = .ascii("second");
    agent.name = .{};
    agent.updated_at = 0;
    hint.observe(&agent);
    try std.testing.expectEqual(@as(usize, 0), hint.name.len);
    try std.testing.expectEqual(@as(i64, 0), hint.touched_at);
}

test "recovery never prefills selection or control characters" {
    const alloc = std.testing.allocator;
    var hint: ResumeHint = .{ .provider = .codex };
    const missing = try hint.command(alloc);
    defer alloc.free(missing);
    try std.testing.expectEqualStrings("", missing);
    hint.session = .initTruncated("a\nbc");
    const unsafe = try hint.command(alloc);
    defer alloc.free(unsafe);
    try std.testing.expectEqualStrings("", unsafe);
}
