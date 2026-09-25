//! Launch previews never run inference. The daemon worker reads provider settings;
//! viewers own popover interaction, and the shared runtime remembers the choice.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
pub const Provider = enum { codex, claude };
/// Launcher rows: one per provider, then a plain terminal.
pub const Row = enum {
    codex,
    claude,
    terminal,
    pub fn of(provider: Provider) Row {
        return @enumFromInt(@intFromEnum(provider));
    }
    pub fn agent(row: Row) ?Provider {
        return if (row == .terminal) null else @enumFromInt(@intFromEnum(row));
    }
};
const metadata = @import("account_preview.zig");
pub const Text = metadata.Text;
pub const Option = struct { model: Text = .{}, source: Text = .{}, account: Text = .{}, plan: Text = .{}, usage: Text = .{}, resets: metadata.Resets = .{}, usage_needs_consent: bool = false };
pub const Preview = struct { pending: bool = true, options: [2]Option = @splat(.{}) };
const Job = struct {
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    len: usize = 0,
    preview: Preview = .{},
    queued: bool = true,
    request_access: bool = false,
    accessing: bool = false,
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
        return w.request(cwd, false);
    }
    pub fn trackUsage(w: *Worker, cwd: []const u8) Preview {
        return w.request(cwd, true);
    }
    fn request(w: *Worker, cwd: []const u8, request_access: bool) Preview {
        if (cwd.len > std.fs.max_path_bytes) return .{};
        w.mutex.lock();
        defer w.mutex.unlock();
        const now = std.time.milliTimestamp();
        var oldest: usize = 0;
        for (&w.jobs, 0..) |*entry, i| {
            if (entry.*) |*job| {
                if (std.mem.eql(u8, cwd, job.cwd[0..job.len])) {
                    job.used = now;
                    if (request_access and !job.accessing) {
                        job.request_access = true;
                        job.queued = true;
                        job.preview.pending = true;
                    }
                    if (now - job.updated >= 60000 and !job.preview.pending) {
                        job.queued = true;
                        job.preview.pending = true;
                    }
                    w.wake.signal();
                    return job.preview;
                }
                if (w.jobs[oldest] != null and job.used < w.jobs[oldest].?.used) oldest = i;
            } else oldest = i;
        }
        var job: Job = .{ .len = cwd.len, .used = now, .request_access = request_access };
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
            w.jobs[index].?.request_access = false;
            w.jobs[index].?.accessing = job.request_access;
            w.mutex.unlock();
            var result: Preview = .{ .pending = false };
            if (pool.configuredModel(job.cwd[0..job.len], &w.stopping)) |model| {
                result.options[0].model.set(model.text());
                result.options[0].source.set("Effective Codex settings");
            } else |_| result.options[0].source.set("Model resolved by Codex at startup");
            if (pool.configuredAccount(&w.stopping)) |account| {
                result.options[0].account = account.account;
                result.options[0].plan = account.plan;
                result.options[0].usage = account.usage;
                result.options[0].resets = account.resets;
            } else |_| {}
            result.options[1] = claude(job.cwd[0..job.len]);
            const account = claudeAccount(job.cwd[0..job.len], &w.stopping, job.request_access);
            result.options[1].account = account.account;
            result.options[1].plan = account.plan;
            result.options[1].usage = account.usage;
            result.options[1].resets = account.resets;
            result.options[1].usage_needs_consent = account.usage_needs_consent;
            w.mutex.lock();
            if (w.jobs[index]) |*current| if (std.mem.eql(u8, current.cwd[0..current.len], job.cwd[0..job.len])) {
                current.preview = result;
                // A click may have queued access while a silent read was running.
                current.preview.pending = current.queued;
                current.accessing = false;
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
fn claudeAccount(cwd: []const u8, stopping: *const std.atomic.Value(bool), request_access: bool) metadata.Info {
    // Never invoke `claude auth status` here: the CLI can perform its own
    // prompt-capable Keychain read outside our helper's interaction guard.
    var info: metadata.Info = .{};
    if (os.env("ANTHROPIC_API_KEY") != null or os.env("ANTHROPIC_AUTH_TOKEN") != null) {
        info.account.set("API key");
        info.plan.set("API");
        info.usage.set("Metered");
        return info;
    }
    if (os.env("CLAUDE_CODE_OAUTH_TOKEN") != null) {
        info.account.set("OAuth token");
        return info;
    }
    for ([_][:0]const u8{ "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY" }) |name| {
        if (std.mem.eql(u8, os.env(name) orelse "", "1")) {
            info.account.set("External provider");
            info.usage.set("Metered");
            return info;
        }
    }
    const executable = std.fs.selfExePathAlloc(a) catch return info;
    defer a.free(executable);
    const response_bytes = command(&.{ executable, "__claude-credentials", if (request_access) "interactive" else "silent" }, cwd, null, stopping, if (request_access) 120000 else 3000) orelse {
        info.usage_needs_consent = true;
        return info;
    };
    defer a.free(response_bytes);
    const response_json = std.json.parseFromSlice(std.json.Value, a, response_bytes, .{}) catch return info;
    defer response_json.deinit();
    const needs_consent = @import("providers/common.zig").field(response_json.value, "needs_consent");
    info.usage_needs_consent = needs_consent == .bool and needs_consent.bool;
    const credentials = @import("providers/common.zig").str(response_json.value, "credentials");
    if (credentials.len == 0) {
        if (info.usage_needs_consent) info.account.set("Access required");
        return info;
    }
    const json = std.json.parseFromSlice(std.json.Value, a, credentials, .{}) catch return info;
    defer json.deinit();
    const common = @import("providers/common.zig");
    const oauth = common.field(json.value, "claudeAiOauth");
    if (info.plan.len == 0) info.plan.set(common.str(oauth, "subscriptionType"));
    if (std.mem.eql(u8, info.plan.text(), "max")) {
        const tier = common.str(oauth, "rateLimitTier");
        if (std.mem.endsWith(u8, tier, "_max_5x")) info.plan.set("Max 5x") else if (std.mem.endsWith(u8, tier, "_max_20x")) info.plan.set("Max 20x");
    }
    const token = common.str(oauth, "accessToken");
    if (token.len == 0 or token.len > 4096) return info;
    // Restrict header syntax; the token goes through stdin, never process argv.
    for (token) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '-' and ch != '_' and ch != '.') return info;
    const expires = common.field(oauth, "expiresAt");
    if (expires == .integer and expires.integer <= std.time.milliTimestamp()) return info;
    const headers = std.fmt.allocPrint(a, "Authorization: Bearer {s}\nanthropic-beta: oauth-2025-04-20\nAccept: application/json\n", .{token}) catch return info;
    defer a.free(headers);
    const response = command(&.{ "curl", "-q", "--silent", "--fail", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/usage" }, cwd, headers, stopping, 3000) orelse return info;
    defer a.free(response);
    const usage_json = std.json.parseFromSlice(std.json.Value, a, response, .{}) catch return info;
    defer usage_json.deinit();
    info.usage = metadata.usage(usage_json.value, false);
    info.resets = metadata.resets(usage_json.value, false);
    if (info.usage.len > 0) info.account.set("Signed in");
    // Read the identity with the very same token, not a potentially stale local
    // account cache or a CLI that may independently ask Keychain for access.
    const profile = command(&.{ "curl", "-q", "--silent", "--fail", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/profile" }, cwd, headers, stopping, 3000) orelse return info;
    defer a.free(profile);
    const profile_json = std.json.parseFromSlice(std.json.Value, a, profile, .{}) catch return info;
    defer profile_json.deinit();
    const account = common.field(profile_json.value, "account");
    for ([_][]const u8{ "emailAddress", "email_address", "email" }) |key| {
        const email = common.str(account, key);
        if (email.len > 0) {
            info.account.set(email);
            break;
        }
    }
    return info;
}
// Serial metadata worker owns this child slot, including the daemon's reaper.
fn command(argv: []const []const u8, cwd: []const u8, input: ?[]const u8, stopping: *const std.atomic.Value(bool), timeout_ms: u32) ?[]u8 {
    var child = std.process.Child.init(argv, a);
    child.cwd = cwd;
    child.stdin_behavior = if (input != null) .Pipe else .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    child_mutex.lock();
    child.spawn() catch {
        child_mutex.unlock();
        return null;
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
        if (child.stdin) |file| file.close();
        if (child.stdout) |file| file.close();
    }
    child.waitForSpawn() catch return null;
    if (input) |bytes| {
        os.writeAll(child.stdin.?.handle, bytes) catch return null;
        child.stdin.?.close();
        child.stdin = null;
    }
    const fd = child.stdout.?.handle;
    os.nonblock(fd);
    var output: [16384]u8 = undefined;
    var len: usize = 0;
    const deadline = std.time.milliTimestamp() + timeout_ms;
    while (!stopping.load(.acquire) and std.time.milliTimestamp() < deadline) {
        if (len == output.len) return null;
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
            return a.dupe(u8, output[0..len]) catch null;
        }
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return null;
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
    selected: Row,
    yolo: [2]bool = .{ false, false },
    last: Provider,
    pinned: bool,
    preview: Preview = .{},
    checked: i64 = 0,
    const headings = [_][]const u8{ "Agent", "YOLO", "Model", "Account", "Plan", "Usage (used)", "Resets in" };
    fn cells(m: *const Menu, index: usize, reset_text: *Text) [7][]const u8 {
        const option = &m.preview.options[index];
        reset_text.* = option.resets.text(std.time.timestamp());
        return .{
            if (index == 0) "Codex" else "Claude Code",
            if (m.yolo[index]) "[x]" else "[ ]",
            if (option.model.len > 0) option.model.text() else if (m.preview.pending) "Reading…" else "Default",
            if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading…" else "Unavailable",
            if (option.plan.len > 0) option.plan.text() else if (m.preview.pending) "…" else "Unknown",
            if (m.trackable(@enumFromInt(index))) "Track usage" else if (option.usage.len > 0) option.usage.text() else if (m.preview.pending) "Reading…" else "Unavailable",
            if (reset_text.len > 0) reset_text.text() else if (m.preview.pending) "Reading…" else "—",
        };
    }
    pub fn bounds(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View) @import("layout.zig").Rect {
        var content: u16 = 4;
        for (m.columns(cols)) |width| content += width;
        const width = @min(cols, @max(@as(u16, 40), content));
        const height = @min(rows, 7);
        return .{ .x = @min(side.width -| 10, cols - width), .y = @min(side.middle() + 1, rows - height), .w = width, .h = height };
    }
    fn columns(m: *const Menu, width: u16) [7]u16 {
        var widths: [7]u16 = undefined;
        var reset_text: [2]Text = undefined;
        const first = m.cells(0, &reset_text[0]);
        const second = m.cells(1, &reset_text[1]);
        for (headings, first, second, &widths, 0..) |heading, one, two, *size, column| {
            size.* = @intCast(@max(@import("sidebar.zig").displayWidth(heading), @max(@import("sidebar.zig").displayWidth(one), @import("sidebar.zig").displayWidth(two))) + @as(usize, if (column == 6) 1 else 2));
        }
        const available = width -| 4;
        var minimum = [_]u16{ 13, 6, 7, 9, 6, 14, 10 };
        if (available < 65) {
            widths[3] = 0;
            widths[2] = 0;
            minimum[3] = 0;
            minimum[2] = 0;
        }
        var total: u16 = 0;
        for (widths) |size| total += size;
        while (total > available) : (total -= 1) {
            // Remove spare space from the most oversized column first. Keep
            // headings readable until even their minimum widths cannot fit.
            var largest: usize = 0;
            for (widths, 0..) |size, i| {
                if (size -| minimum[i] > widths[largest] -| minimum[largest]) largest = i;
            }
            if (widths[largest] <= minimum[largest]) {
                for (widths, 0..) |size, i| if (size > widths[largest]) {
                    largest = i;
                };
            }
            widths[largest] -= 1;
        }
        return widths;
    }
    pub fn hit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Row {
        const b = m.bounds(cols, rows, side);
        if (x <= b.x or x >= b.x + b.w - 1 or y < b.y + 2 or y >= b.y + @min(b.h -| 1, 5)) return null;
        return @enumFromInt(y - b.y - 2);
    }
    fn providerHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        return (m.hit(cols, rows, side, x, y) orelse return null).agent();
    }
    pub fn yoloHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < 7) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0];
        return if (x >= start and x < start + widths[1] -| 2) provider else null;
    }
    pub fn trackable(m: *const Menu, row: Row) bool {
        const provider = row.agent() orelse return false;
        return !m.preview.pending and m.preview.options[@intFromEnum(provider)].usage_needs_consent;
    }
    pub fn usageHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < 7) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
        return if (x >= start and x < start + widths[5] -| 1) provider else null;
    }
    pub fn draw(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: @import("sidebar.zig").View) !void {
        const sidebar = @import("sidebar.zig");
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < 7) return;
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
        const widths = m.columns(b.w);
        var heading_x: u16 = b.x + 4;
        for (headings, widths, 0..) |heading, width, column| {
            if (width == 0) continue;
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + 2, heading_x, panel });
            try sidebar.writeEllipsis(w, heading, width -| @as(u16, if (column == 6) 1 else 2));
            heading_x += width;
        }
        for (0..m.preview.options.len + 1) |i| {
            const selected = @as(Row, @enumFromInt(i)) == m.selected;
            const row = b.y + 3 + i;
            const style = if (selected) "\x1b[0;38;2;226;230;233;48;2;47;64;59m" else "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, style });
            try w.splatByteAll(' ', b.w - 2);
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, if (selected) "›" else " " });
            if (i == m.preview.options.len) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try sidebar.writeEllipsis(w, "New terminal", b.w -| 6);
                continue;
            }
            var x: u16 = b.x + 4;
            var reset_text: Text = undefined;
            for (m.cells(i, &reset_text), widths, 0..) |text, width, column| {
                if (width == 0) continue;
                try w.print("\x1b[{d};{d}H", .{ row, x });
                if (column == 5 and m.trackable(@enumFromInt(i))) try w.writeAll("\x1b[4m");
                const room = width -| @as(u16, if (column == 6) 1 else 2);
                if (column >= 5) {
                    try writeWindowCell(w, text, room, style);
                } else try sidebar.writeEllipsis(w, text, room);
                try w.writeAll("\x1b[24m");
                x += width;
            }
        }
        try w.print("\x1b[{d};{d}H{s}", .{ b.y + 6, b.x + 3, panel });
        const directory = std.fs.path.basename(m.cwd[0..m.cwd_len]);
        var buffer: [std.fs.max_path_bytes + 32]u8 = undefined;
        const footer = try std.fmt.bufPrint(&buffer, "{s} · new tab", .{directory});
        try sidebar.writeEllipsis(w, footer, b.w - 24);
        const hint = if (m.selected == .terminal) "t: new terminal" else if (m.trackable(m.selected)) "u: Track usage" else "a: launch  y: YOLO";
        try w.print("\x1b[{d};{d}H{s}\x1b[0m\x1b[?25l", .{ b.y + 6, b.x + b.w - 19, hint });
    }
};

// Clip plain text before adding SGR so styling never consumes column width.
fn writeWindowCell(w: *std.Io.Writer, text: []const u8, width: usize, row_style: []const u8) !void {
    var buffer: [192]u8 = undefined;
    var clipped = std.Io.Writer.fixed(&buffer);
    try @import("sidebar.zig").writeEllipsis(&clipped, text, width);
    var windows = std.mem.splitSequence(u8, clipped.buffered(), " / ");
    var first = true;
    while (windows.next()) |part| {
        if (!first) try w.writeAll(" / ");
        first = false;
        const end = std.mem.indexOfScalar(u8, part, ' ') orelse part.len;
        const label = part[0..end];
        const is_window = std.mem.eql(u8, label, "Window") or (label.len >= 2 and
            std.mem.indexOfScalar(u8, "mhd", label[label.len - 1]) != null and
            for (label[0 .. label.len - 1]) |ch| {
                if (!std.ascii.isDigit(ch)) break false;
            } else true);
        if (is_window) {
            try w.writeAll("\x1b[1;38;2;137;190;226m");
            try w.writeAll(label);
            try w.writeAll(row_style);
            try w.writeAll(part[end..]);
        } else try w.writeAll(part);
    }
}

test "launch preview settings overlay and menu bounds" {
    var result: Option = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"model\":\"opus\"}", .{});
    defer parsed.deinit();
    applyModel(&result, parsed.value, "Project");
    try std.testing.expectEqualStrings("opus", result.model.text());
    const side = @import("sidebar.zig").View.init(80, 24, true, 0, 0);
    const menu: Menu = .{ .workspace = 1, .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    const b = menu.bounds(80, 24, side);
    try std.testing.expect(b.x + b.w <= 80 and b.y + b.h <= 24);
    try std.testing.expectEqual(Row.codex, menu.hit(80, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Row.claude, menu.hit(80, 24, side, b.x + 2, b.y + 3).?);
    try std.testing.expectEqual(Row.terminal, menu.hit(80, 24, side, b.x + 2, b.y + 4).?);
    try std.testing.expectEqual(@as(?Row, null), menu.hit(80, 24, side, b.x + 2, b.y + 5));
}

test "account preview shows identities or auth mode and never credential fields" {
    const account = parseAccount("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"person@example.com\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("person@example.com", account.text());
    const key = parseAccount("{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("API key", key.text());
    const logged_out = parseAccount("{\"loggedIn\":false,\"email\":\"stale@example.com\"}");
    try std.testing.expectEqualStrings("Not signed in", logged_out.text());
}

test "launcher fits long content and keeps usage hit targets aligned" {
    var menu: Menu = .{ .workspace = 1, .cwd_len = 0, .selected = .claude, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    menu.preview.options[0].model.set("a-long-model-name-that-needs-room");
    menu.preview.options[1].account.set("person.with.a.long.name@example.com");
    menu.preview.options[1].usage_needs_consent = true;
    const widths = menu.columns(200);
    try std.testing.expectEqual(@as(u16, 35), widths[2]);
    try std.testing.expectEqual(@as(u16, 37), widths[3]);
    for ([_]u16{ 24, 40, 64, 80, 120, 200 }) |cols| {
        const side = @import("sidebar.zig").View.init(cols, 24, true, 0, 0);
        const b = menu.bounds(cols, 24, side);
        try std.testing.expect(b.x + b.w <= cols);
        const fitted = menu.columns(b.w);
        var used: u16 = 4;
        for (fitted) |width| used += width;
        try std.testing.expect(used <= b.w);
        const usage_x = b.x + 3 + fitted[0] + fitted[1] + fitted[2] + fitted[3] + fitted[4];
        try std.testing.expectEqual(Provider.claude, menu.usageHit(cols, 24, side, usage_x, b.y + 3).?);
    }
}

fn parseAccount(bytes: []const u8) Text {
    const parsed = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return .{};
    defer parsed.deinit();
    return metadata.claudeAccount(parsed.value).account;
}
