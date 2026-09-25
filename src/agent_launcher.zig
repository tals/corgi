//! Launch previews never run inference. The daemon worker reads provider settings;
//! viewers own popover interaction, and the shared runtime remembers the choice.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
pub const Provider = enum { codex, claude };
pub const Text = struct {
    bytes: [160]u8 = @splat(0),
    len: usize = 0,
    pub fn set(t: *Text, value: []const u8) void {
        t.len = @import("agents.zig").clean(&t.bytes, value);
    }
    pub fn text(t: *const Text) []const u8 {
        return t.bytes[0..t.len];
    }
};
pub const Option = struct { model: Text = .{}, source: Text = .{}, account: Text = .{} };
pub const Preview = struct { pending: bool = true, options: [2]Option = @splat(.{}) };
const Job = struct {
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    len: usize = 0,
    preview: Preview = .{},
    queued: bool = true,
    updated: i64 = 0,
    used: i64 = 0,
};
pub const Worker = struct {
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: std.atomic.Value(bool) = .init(false),
    thread: ?std.Thread = null,
    jobs: [8]?Job = @splat(null),
    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{};
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.stopping.store(true, .release);
        w.wake.signal();
        w.thread.?.join();
        a.destroy(w);
    }
    pub fn preview(w: *Worker, cwd: []const u8) Preview {
        if (cwd.len > std.fs.max_path_bytes) return .{};
        w.mutex.lock();
        defer w.mutex.unlock();
        const now = std.time.milliTimestamp();
        var oldest: usize = 0;
        for (&w.jobs, 0..) |*entry, i| {
            if (entry.*) |*job| {
                if (std.mem.eql(u8, cwd, job.cwd[0..job.len])) {
                    job.used = now;
                    if (now - job.updated >= 10000 and !job.preview.pending) {
                        job.queued = true;
                        job.preview.pending = true;
                    }
                    w.wake.signal();
                    return job.preview;
                }
                if (w.jobs[oldest] != null and job.used < w.jobs[oldest].?.used) oldest = i;
            } else oldest = i;
        }
        var job: Job = .{ .len = cwd.len, .used = now };
        @memcpy(job.cwd[0..cwd.len], cwd);
        w.jobs[oldest] = job;
        w.wake.signal();
        return job.preview;
    }
    fn run(w: *Worker) void {
        var pool: @import("inference.zig").Pool = .{ .config = .{ .timeout_ms = 5000 } };
        defer pool.deinit();
        while (!w.stopping.load(.acquire)) {
            w.mutex.lock();
            const index = for (w.jobs, 0..) |entry, i| {
                if (entry != null and entry.?.queued) break i;
            } else {
                w.wake.timedWait(&w.mutex, 250 * std.time.ns_per_ms) catch {};
                w.mutex.unlock();
                continue;
            };
            const job = w.jobs[index].?;
            w.jobs[index].?.queued = false;
            w.mutex.unlock();
            var result: Preview = .{ .pending = false };
            if (pool.configuredModel(job.cwd[0..job.len], &w.stopping)) |model| {
                result.options[0].model.set(model.text());
                result.options[0].source.set("Effective Codex settings");
            } else |_| result.options[0].source.set("Model resolved by Codex at startup");
            if (pool.configuredAccount(&w.stopping)) |account| {
                result.options[0].account.set(account.text());
            } else |_| {}
            result.options[1] = claude(job.cwd[0..job.len]);
            result.options[1].account = claudeAccount(job.cwd[0..job.len], &w.stopping);
            w.mutex.lock();
            if (w.jobs[index]) |*current| if (std.mem.eql(u8, current.cwd[0..current.len], job.cwd[0..job.len])) {
                current.preview = result;
                current.updated = std.time.milliTimestamp();
            };
            w.mutex.unlock();
        }
    }
};
const child_mutex = &@import("git_status.zig").child_mutex;
var auth_pid: c_int = 0;
var auth_status: ?c_int = null;
// Called by the daemon reaper while holding child_mutex.
pub fn recordExit(pid: c_int, status: c_int) void {
    if (pid == auth_pid) auth_status = status;
}
fn claudeAccount(cwd: []const u8, stopping: *const std.atomic.Value(bool)) Text {
    const binary = @import("discovery.zig").resolve(.claude, cwd) catch return .{};
    defer a.free(binary);
    var child = std.process.Child.init(&.{ binary, "auth", "status", "--json" }, a);
    child.cwd = cwd;
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    child_mutex.lock();
    child.spawn() catch {
        child_mutex.unlock();
        return .{};
    };
    auth_pid = child.id;
    auth_status = null;
    child_mutex.unlock();
    var reaped = false;
    defer {
        child_mutex.lock();
        defer child_mutex.unlock();
        if (!reaped and auth_status == null) {
            _ = os.c.kill(-child.id, os.c.SIGKILL);
            var status: c_int = 0;
            _ = os.c.waitpid(child.id, &status, 0);
        }
        auth_pid = 0;
        auth_status = null;
        if (child.stdout) |file| file.close();
    }
    child.waitForSpawn() catch return .{};
    const fd = child.stdout.?.handle;
    os.nonblock(fd);
    var output: [16384]u8 = undefined;
    var len: usize = 0;
    const deadline = std.time.milliTimestamp() + 3000;
    while (!stopping.load(.acquire) and std.time.milliTimestamp() < deadline) {
        if (len == output.len) return .{};
        const n = os.c.read(fd, output[len..].ptr, output.len - len);
        if (n > 0) len += @intCast(n);
        var status: c_int = 0;
        child_mutex.lock();
        const exited = if (auth_status) |saved| blk: {
            status = saved;
            break :blk true;
        } else os.c.waitpid(child.id, &status, os.c.WNOHANG) == child.id;
        child_mutex.unlock();
        if (exited) {
            reaped = true;
            if (len < output.len) {
                const tail = os.c.read(fd, output[len..].ptr, output.len - len);
                if (tail > 0) len += @intCast(tail);
            }
            // The CLI also returns JSON with an unsuccessful login status.
            return parseAccount(output[0..len]);
        }
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return .{};
}
fn parseAccount(bytes: []const u8) Text {
    const parsed = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return .{};
    defer parsed.deinit();
    const value = parsed.value;
    if (value != .object) return .{};
    const logged = value.object.get("loggedIn") orelse return .{};
    if (logged != .bool) return .{};
    const email = @import("agents.zig").str(value, "email");
    const method = @import("agents.zig").str(value, "authMethod");
    var account: Text = .{};
    account.set(if (!logged.bool) "Not signed in" else if (std.mem.eql(u8, method, "api_key")) "API key" else if (email.len > 0) email else if (method.len > 0) method else "Signed in");
    return account;
}
fn claude(cwd: []const u8) Option {
    var result: Option = .{};
    result.source.set("Account default / provider selection");
    const home = os.env("HOME") orelse "";
    const root = os.env("CLAUDE_CONFIG_DIR") orelse std.fs.path.join(a, &.{ home, ".claude" }) catch return result;
    defer if (os.env("CLAUDE_CONFIG_DIR") == null) a.free(root);
    readModel(&result, root, "settings.json", "User settings");
    readModel(&result, cwd, ".claude/settings.json", "Project settings (if trusted)");
    readModel(&result, cwd, ".claude/settings.local.json", "Local settings (if trusted)");
    if (os.env("ANTHROPIC_MODEL")) |model| if (model.len > 0) {
        result.model.set(model);
        result.source.set("ANTHROPIC_MODEL");
    };
    readModel(&result, "/Library/Application Support/ClaudeCode", "managed-settings.json", "Managed settings");
    return result;
}
fn readModel(out: *Option, root: []const u8, relative: []const u8, source: []const u8) void {
    const path = std.fs.path.join(a, &.{ root, relative }) catch return;
    defer a.free(path);
    const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true }, 0) catch return;
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = file.stat() catch return;
    if (stat.kind != .file or stat.size > 1024 * 1024) return;
    const bytes = file.readToEndAlloc(a, 1024 * 1024) catch return;
    defer a.free(bytes);
    const json = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return;
    defer json.deinit();
    applyModel(out, json.value, source);
}
fn applyModel(out: *Option, value: std.json.Value, source: []const u8) void {
    const model = @import("agents.zig").str(value, "model");
    if (model.len == 0) return;
    out.model.set(model);
    out.source.set(source);
}
pub const Menu = struct {
    workspace: u32,
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    cwd_len: usize,
    selected: Provider,
    last: Provider,
    pinned: bool,
    preview: Preview = .{},
    checked: i64 = 0,
    pub fn bounds(cols: u16, rows: u16, side: @import("sidebar.zig").View) @import("layout.zig").Rect {
        const width = @min(cols, 76);
        const height = @min(rows, 6);
        return .{ .x = @min(side.width -| 10, cols - width), .y = @min(side.middle() + 1, rows - height), .w = width, .h = height };
    }
    pub fn hit(cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        const b = bounds(cols, rows, side);
        if (x <= b.x or x >= b.x + b.w - 1 or y < b.y + 2 or y >= b.y + @min(b.h -| 1, 4)) return null;
        return if (y == b.y + 2) .codex else .claude;
    }
    pub fn draw(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: @import("sidebar.zig").View) !void {
        const sidebar = @import("sidebar.zig");
        const b = bounds(cols, rows, side);
        if (b.w < 24 or b.h < 6) return;
        const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
        for (0..b.h) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, panel });
            try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
            if (row == 0 or row == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
        }
        try w.print("\x1b[{d};{d}H\x1b[1;38;2;226;230;233m New agent ", .{ b.y + 1, b.x + 3 });
        try w.print("\x1b[{d};{d}H{s}Agent\x1b[{d};{d}HModel", .{ b.y + 2, b.x + 4, panel, b.y + 2, b.x + 18 });
        const account_x = @min(@as(u16, 41), b.w -| 16);
        try w.print("\x1b[{d};{d}HAccount", .{ b.y + 2, b.x + account_x });
        for (&m.preview.options, 0..) |*option, i| {
            const selected = @as(Provider, @enumFromInt(i)) == m.selected;
            const row = b.y + 3 + i;
            const style = if (selected) "\x1b[0;38;2;226;230;233;48;2;47;64;59m" else "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, style });
            try w.splatByteAll(' ', b.w - 2);
            try w.print("\x1b[{d};{d}H\x1b[38;2;161;194;178m{s} \x1b[1;38;2;226;230;233m{s}\x1b[22m", .{ row, b.x + 2, if (selected) "›" else " ", if (i == 0) "Codex" else "Claude Code" });
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 18, style });
            const model = if (option.model.len > 0) option.model.text() else if (m.preview.pending) "Reading settings…" else "Provider default";
            try sidebar.writeEllipsis(w, model, account_x -| 20);
            try w.print("\x1b[{d};{d}H", .{ row, b.x + account_x });
            const account = if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading…" else "Unavailable";
            try sidebar.writeEllipsis(w, account, b.w - account_x -| 1);
        }
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 5, b.x + 3, panel });
        const directory = std.fs.path.basename(m.cwd[0..m.cwd_len]);
        var buffer: [std.fs.max_path_bytes + 32]u8 = undefined;
        const footer = try std.fmt.bufPrint(&buffer, "{s} · new tab", .{directory});
        try sidebar.writeEllipsis(w, footer, b.w - 24);
        try w.print("\x1b[{d};{d}HPress a to launch\x1b[0m\x1b[?25l", .{ b.y + 5, b.x + b.w - 19 });
    }
};

test "launch preview settings overlay and menu bounds" {
    var result: Option = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"model\":\"opus\"}", .{});
    defer parsed.deinit();
    applyModel(&result, parsed.value, "Project");
    try std.testing.expectEqualStrings("opus", result.model.text());
    const side = @import("sidebar.zig").View.init(80, 24, true, 0, 0);
    const b = Menu.bounds(80, 24, side);
    try std.testing.expect(b.x + b.w <= 80 and b.y + b.h <= 24);
    try std.testing.expectEqual(Provider.codex, Menu.hit(80, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Provider.claude, Menu.hit(80, 24, side, b.x + 2, b.y + 3).?);
}

test "account preview shows identities or auth mode and never credential fields" {
    const account = parseAccount("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"person@example.com\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("person@example.com", account.text());
    const key = parseAccount("{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("API key", key.text());
    const logged_out = parseAccount("{\"loggedIn\":false,\"email\":\"stale@example.com\"}");
    try std.testing.expectEqualStrings("Not signed in", logged_out.text());
}
