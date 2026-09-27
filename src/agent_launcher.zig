//! Launch previews never run inference. The daemon worker reads provider settings;
//! viewers own popover interaction, and the shared runtime remembers the choice.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
pub const Provider = @import("providers.zig").Provider;
const WorkspaceId = @import("workspace.zig").Workspace.Id;
/// Launcher rows: one per provider, then saved commands and a plain terminal.
pub const Row = enum {
    codex,
    claude,
    custom0,
    custom1,
    custom2,
    custom3,
    custom4,
    custom5,
    terminal,
    add,
    manage,
    pub fn of(provider: Provider) Row {
        return @enumFromInt(@intFromEnum(provider));
    }
    pub fn custom(row: Row) ?usize {
        const i = @intFromEnum(row);
        return if (i >= @intFromEnum(Row.custom0) and i <= @intFromEnum(Row.custom5)) i - @intFromEnum(Row.custom0) else null;
    }
    pub fn agent(row: Row) ?Provider {
        const i = @intFromEnum(row);
        return if (i < Provider.all.len) @enumFromInt(i) else null;
    }
    comptime {
        for (Provider.all) |provider| std.debug.assert(std.mem.eql(u8, @tagName(provider), @tagName(Row.of(provider))));
    }
};
/// The agent a launcher key starts.
pub fn keyAgent(byte: u8) ?Provider {
    for (Provider.all) |provider| if (provider.info().launcher_key == byte) return provider;
    return null;
}
const metadata = @import("account_preview.zig");
const account_cache = @import("account_cache.zig");
const usage_cell = @import("launcher_usage.zig");
pub const Text = metadata.Text;
pub const Option = struct { signed_in: ?bool = null, model: Text = .{}, source: Text = .{}, account: Text = .{}, plan: Text = .{}, usage: Text = .{}, usage_fetched_at: i64 = 0, usage_error: Text = .{}, resets: metadata.Resets = .{}, usage_needs_consent: bool = false };
pub const Preview = struct { pending: bool = true, options: [Provider.all.len]Option = @splat(.{}), installed: [Provider.all.len]bool = @splat(true) };
fn installed() [Provider.all.len]bool {
    var result: [Provider.all.len]bool = undefined;
    for (Provider.all, &result) |provider, *found| found.* = @import("discovery.zig").installed(provider);
    return result;
}
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
    // Enough slots for every connected client's subscribed directory.
    jobs: [32]?Job = @splat(null),
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
        // Filesystem-only, so the first reply already hides missing providers.
        job.preview.installed = installed();
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
            var result: Preview = .{ .pending = false, .installed = installed() };
            // Skip reads for missing providers; their rows are hidden.
            if (result.installed[0]) {
                if (pool.configuredModel(job.cwd[0..job.len], &w.stopping)) |model| {
                    result.options[0].model.set(model.text());
                    result.options[0].source.set("Effective Codex settings");
                } else |_| result.options[0].source.set("Model resolved by Codex at startup");
                if (codexAccount(&pool, &w.stopping)) |account| {
                    result.options[0].signed_in = account.signed_in;
                    result.options[0].account = account.account;
                    result.options[0].plan = account.plan;
                    result.options[0].usage = account.usage;
                    result.options[0].usage_fetched_at = account.usage_fetched_at;
                    result.options[0].usage_error = account.usage_error;
                    result.options[0].resets = account.resets;
                } else |_| result.options[0].usage_error.set("account read failed");
            }
            if (result.installed[1]) {
                result.options[1] = claude(job.cwd[0..job.len]);
                const account = claudeAccount(job.cwd[0..job.len], &w.stopping, job.request_access);
                result.options[1].signed_in = account.signed_in;
                result.options[1].account = account.account;
                result.options[1].plan = account.plan;
                result.options[1].usage = account.usage;
                result.options[1].usage_fetched_at = account.usage_fetched_at;
                result.options[1].usage_error = account.usage_error;
                result.options[1].resets = account.resets;
                result.options[1].usage_needs_consent = account.usage_needs_consent;
            }
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
fn codexAccount(pool: *@import("inference.zig").Pool, stopping: *const std.atomic.Value(bool)) !metadata.Info {
    const root = os.env("CODEX_HOME") orelse try std.fs.path.join(a, &.{ os.env("HOME") orelse return error.NoHome, ".codex" });
    defer if (os.env("CODEX_HOME") == null) a.free(root);
    const path = try std.fs.path.join(a, &.{ root, "auth.json" });
    defer a.free(path);
    const auth = std.fs.cwd().readFileAlloc(a, path, 65536) catch try a.dupe(u8, root);
    defer a.free(auth);
    const identity = try std.fmt.allocPrint(a, "{s}\n{s}", .{ auth, os.env("OPENAI_API_KEY") orelse "" });
    defer a.free(identity);
    var cache = try account_cache.Cache.open("codex", identity, stopping);
    defer cache.close();
    const now = std.time.timestamp();
    if (now < cache.state.next_usage) return cache.state.display(now);
    cache.state.next_usage = now + account_cache.interval;
    try cache.save();
    const fresh = pool.configuredAccount(stopping) catch |err| {
        cache.state.failed(if (err == error.Timeout) "request timed out" else "account read failed");
        try cache.save();
        return cache.state.display(std.time.timestamp());
    };
    cache.state.update(fresh, std.time.timestamp());
    try cache.save();
    return cache.state.display(std.time.timestamp());
}
fn claudeAccount(cwd: []const u8, stopping: *const std.atomic.Value(bool), request_access: bool) metadata.Info {
    // Never invoke `claude auth status` here: the CLI can perform its own
    // prompt-capable Keychain read outside our helper's interaction guard.
    var info: metadata.Info = .{};
    info.usage_error.set("credentials unavailable");
    if (os.env("ANTHROPIC_API_KEY") != null or os.env("ANTHROPIC_AUTH_TOKEN") != null) {
        info.signed_in = true;
        info.account.set("API key");
        info.plan.set("API");
        info.usage.set("Metered");
        info.usage_error = .{};
        return info;
    }
    if (os.env("CLAUDE_CODE_OAUTH_TOKEN") != null) {
        info.signed_in = true;
        info.account.set("OAuth token");
        info.usage_error.set("token usage unsupported");
        return info;
    }
    for ([_][:0]const u8{ "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY" }) |name| {
        if (std.mem.eql(u8, os.env(name) orelse "", "1")) {
            info.signed_in = true;
            info.account.set("External provider");
            info.usage.set("Metered");
            info.usage_error = .{};
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
        if (info.usage_needs_consent) {
            info.account.set("Access required");
        } else {
            info.signed_in = false;
            info.account.set("Not signed in");
        }
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
    if (token.len == 0) {
        info.signed_in = false;
        return info;
    }
    if (token.len > 4096) return info;
    // Expired access tokens can be refreshed by Claude at launch.
    info.signed_in = true;
    // Restrict header syntax; the token goes through stdin, never process argv.
    for (token) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '-' and ch != '_' and ch != '.') return info;
    var cache = account_cache.Cache.open("claude", token, stopping) catch {
        info.usage_error.set("cache read failed");
        return info;
    };
    defer cache.close();
    cache.state.info.signed_in = true;
    cache.state.info.plan = info.plan;
    const now = std.time.timestamp();
    const expires = common.field(oauth, "expiresAt");
    if (expires == .integer and expires.integer <= std.time.milliTimestamp()) {
        cache.state.failed("access token expired");
        return cache.state.display(now);
    }
    const fetch_usage = now >= cache.state.next_usage;
    const fetch_profile = now >= cache.state.next_profile;
    // Persist reservations before making requests, including failures/reloads.
    if (fetch_usage) cache.state.next_usage = now + account_cache.interval;
    if (fetch_profile) cache.state.next_profile = now + account_cache.interval;
    cache.save() catch {
        cache.state.failed("cache write failed");
        return cache.state.display(now);
    };
    const headers = std.fmt.allocPrint(a, "Authorization: Bearer {s}\nanthropic-beta: oauth-2025-04-20\nAccept: application/json\nContent-Type: application/json\n", .{token}) catch return info;
    defer a.free(headers);
    if (fetch_usage) {
        cache.state.failed("request failed or timed out");
        if (command(&.{ "curl", "-q", "--silent", "--include", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/usage" }, cwd, headers, stopping, 3500)) |bytes| {
            defer a.free(bytes);
            const reply = account_cache.response(bytes, now);
            cache.state.next_usage = account_cache.nextAttempt(reply, now);
            cache.state.failedResponse(reply.status);
            if (reply.status == 200) {
                cache.state.failed("invalid usage response");
                if (std.json.parseFromSlice(std.json.Value, a, reply.body, .{})) |parsed| {
                    defer parsed.deinit();
                    const usage = metadata.usage(parsed.value, .claude);
                    if (usage.len > 0) {
                        cache.state.info.usage = usage;
                        cache.state.info.usage_fetched_at = std.time.timestamp();
                        cache.state.info.usage_error = .{};
                        cache.state.info.resets = metadata.resets(parsed.value, .claude);
                    }
                } else |_| {}
            }
        }
    }
    // Profile failures and usage failures are independent. Never erase identity
    // just because the usage endpoint is rate limited.
    if (fetch_profile) {
        if (command(&.{ "curl", "-q", "--silent", "--include", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/profile" }, cwd, headers, stopping, 3500)) |bytes| {
            defer a.free(bytes);
            const reply = account_cache.response(bytes, now);
            cache.state.next_profile = account_cache.nextAttempt(reply, now);
            if (reply.status == 200) {
                if (std.json.parseFromSlice(std.json.Value, a, reply.body, .{})) |parsed| {
                    defer parsed.deinit();
                    const account = common.field(parsed.value, "account");
                    for ([_][]const u8{ "emailAddress", "email_address", "email" }) |key| {
                        const email = common.str(account, key);
                        if (email.len > 0) {
                            cache.state.info.account.set(email);
                            break;
                        }
                    }
                } else |_| {}
            }
        }
    }
    if (cache.state.info.account.len == 0) cache.state.info.account.set("Signed in");
    cache.save() catch {};
    return cache.state.display(std.time.timestamp());
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
    workspace: WorkspaceId,
    cwd: [std.fs.max_path_bytes]u8 = undefined,
    cwd_len: usize,
    selected: Row,
    yolo: [Provider.all.len]bool = @splat(false),
    hidden: [Provider.all.len]bool = @splat(false),
    managing: bool = false,
    editor: @import("name_dialog.zig").Dialog = .{ .target = .{ .agent_command = 0 }, .selected = false },
    name_editor: @import("name_dialog.zig").Dialog = .{ .target = .{ .rename = @enumFromInt(0) }, .selected = false },
    name_focused: bool = false,
    show_command: bool = false,
    name_customized: bool = false,
    edit_index: ?usize = null,
    edit_provider: ?Provider = null,
    save_error: Text = .{},
    draft: @import("launch_command.zig").Entry = .{},
    draft_changed: i64 = 0,
    request_id: u32 = 0,
    resolution_checked: i64 = 0,
    resolution: @import("launch_command.zig").Resolution = .{},
    save_requested: bool = false,
    commands: [@import("launch_command.zig").capacity]@import("launch_command.zig").Entry = @splat(.{}),
    last: Provider,
    pinned: bool,
    /// Ctrl-B arrived while pinned; Cmd+T sends Ctrl-B A, so a repeat opens a terminal.
    prefix: bool = false,
    preview: Preview = .{},
    const headings = [_][]const u8{ "Agent", "YOLO", "Model", "Account", "Plan", "Usage (used) · resets in" };
    fn cells(m: *const Menu, provider: Provider) [6][]const u8 {
        const index = @intFromEnum(provider);
        const option = &m.preview.options[index];
        return .{
            provider.info().label,
            if (m.yolo[index]) "✓" else "·",
            if (option.model.len > 0) option.model.text() else if (m.preview.pending) "Reading…" else "Default",
            if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading…" else "Unavailable",
            if (option.plan.len > 0) option.plan.text() else if (m.preview.pending) "…" else "Unknown",
            if (m.trackable(.of(provider))) "Track usage" else if (option.usage.len > 0)
                (if (option.usage_fetched_at > 0 and std.time.timestamp() -| option.usage_fetched_at >= metadata.usage_max_age and !std.mem.eql(u8, option.usage.text(), "Metered")) "Unavailable" else option.usage.text())
            else if (m.preview.pending) "Reading…" else "Unavailable",
        };
    }
    fn customCells(m: *const Menu, index: usize) [6][]const u8 {
        const entry = &m.commands[index];
        const info = &entry.semantics;
        const shared = if (info.default_account) info.provider else null;
        var values: [6][]const u8 = if (shared) |provider| m.cells(provider) else .{ "", "", "Default", "", "—", "—" };
        values[0] = entry.label();
        values[1] = if (std.mem.eql(u8, info.mode.text(), "Skips permission checks")) "✓" else "·";
        if (info.model.len > 0) values[2] = info.model.text();
        values[3] = m.account(info);
        // Tracking actions belong to built-in rows; saved commands only show data.
        if (shared) |provider| if (m.trackable(.of(provider))) {
            values[5] = "Unavailable";
        };
        return values;
    }
    fn usageCell(m: *const Menu, row: Row, text: []const u8) usage_cell.Cell {
        const provider = row.agent() orelse if (row.custom()) |i| blk: {
            const info = m.commands[i].semantics;
            break :blk if (info.default_account) info.provider else null;
        } else null;
        if (std.mem.eql(u8, text, "Unavailable") or std.mem.eql(u8, text, "Rate limited")) {
            if (provider) |p| {
                const option = &m.preview.options[@intFromEnum(p)];
                return usage_cell.Cell.unavailable(if (option.usage_error.len > 0) option.usage_error.text() else if (option.usage_fetched_at > 0) "last success 10m+ ago" else "no usage received");
            }
        }
        return usage_cell.Cell.init(text, if (provider) |p| m.preview.options[@intFromEnum(p)].resets else .{}, std.time.timestamp());
    }
    /// Management includes unavailable providers so preferences stay editable.
    pub fn shown(m: *const Menu, row: Row) bool {
        if (row == .manage) return true;
        if (row == .add) return m.managing;
        if (row.custom()) |index| return m.commands[index].len > 0 and (m.managing or !m.commands[index].hidden);
        if (row == .terminal) return !m.managing;
        if (m.managing) return true;
        const index = @intFromEnum(row.agent().?);
        return m.preview.installed[index] and !m.hidden[index] and m.preview.options[index].signed_in != false;
    }
    pub fn emptyCommand(m: *const Menu) ?usize {
        for (m.commands, 0..) |entry, i| if (entry.len == 0) return i;
        return null;
    }
    pub fn countRows(m: *const Menu) usize {
        return m.count() - 2;
    }
    fn count(m: *const Menu) usize {
        var n: usize = 0;
        for (std.enums.values(Row)) |row| n += @intFromBool(m.shown(row));
        return n;
    }
    fn rowAt(m: *const Menu, index: usize) ?Row {
        var n: usize = 0;
        for (std.enums.values(Row)) |row| if (m.shown(row)) {
            if (n == index) return row;
            n += 1;
        };
        return null;
    }
    fn position(m: *const Menu, row: Row) usize {
        var n: usize = 0;
        for (std.enums.values(Row)) |candidate| {
            if (candidate == row) return n;
            n += @intFromBool(m.shown(candidate));
        }
        return n;
    }
    /// Keep the selection on a visible row after the installed set changes.
    pub fn normalize(m: *Menu) void {
        if (!m.shown(m.selected)) m.selected = m.rowAt(0).?;
    }
    pub fn first(m: *const Menu) Row {
        return m.rowAt(0).?;
    }
    /// Digits enumerate visible agents only, matching the picker keycaps.
    pub fn shortcutRow(m: *const Menu, key: u8) ?Row {
        if (m.managing or key < '0' or key > '9') return null;
        const row = m.rowAt(key - '0') orelse return null;
        return if (row.agent() != null or row.custom() != null) row else null;
    }
    pub fn move(m: *Menu, next: bool, wrap: bool) void {
        m.normalize();
        const n = m.count();
        const index = m.position(m.selected);
        m.selected = m.rowAt(if (wrap)
            (if (next) index + 1 else index + n - 1) % n
        else if (next) @min(index + 1, n - 1) else index -| 1).?;
    }
    fn rowsHeight(m: *const Menu) u16 {
        if (m.managing) return @intCast(m.count() + 20);
        return @intCast(7 + m.count());
    }
    pub fn bounds(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View) @import("layout.zig").Rect {
        var content: u16 = 4;
        for (m.columnSizes().preferred) |width| content += width;
        const width = @min(cols, if (m.managing) @as(u16, 82) else @max(@as(u16, 40), content));
        const height = @min(rows, m.rowsHeight());
        return .{ .x = @min(side.width -| 10, cols - width), .y = @min(side.middle() + 1, rows - height), .w = width, .h = height };
    }
    fn columnSizes(m: *const Menu) struct { preferred: [6]u16, usage_minimum: u16 } {
        var widths: [6]u16 = undefined;
        for (headings, &widths) |heading, *size| size.* = @intCast(@import("sidebar.zig").displayWidth(heading));
        var usage_minimum = widths[5];
        for (std.enums.values(Row)) |row| {
            if (!m.shown(row) or (row.agent() == null and row.custom() == null)) continue;
            const values = if (row.custom()) |i| m.customCells(i) else m.cells(row.agent().?);
            for (values[0..5], widths[0..5]) |text, *size| size.* = @max(size.*, @as(u16, @intCast(@import("sidebar.zig").displayWidth(text))));
            const cell = m.usageCell(row, values[5]);
            widths[5] = @max(widths[5], @as(u16, @intCast(cell.preferredWidth())));
            usage_minimum = @max(usage_minimum, @as(u16, @intCast(cell.minimumWidth())));
        }
        for (&widths, 0..) |*size, column| size.* += if (column == 5) 1 else 2;
        widths[0] += 4; // Left shortcut keycap and its following space.
        return .{ .preferred = widths, .usage_minimum = usage_minimum + 1 };
    }
    fn columns(m: *const Menu, width: u16) [6]u16 {
        const sizes = m.columnSizes();
        var widths = sizes.preferred;
        const available = width -| 4;
        var minimum = [_]u16{ 17, 6, 9, 18, 6, sizes.usage_minimum };
        if (width < 64) {
            widths[1] = 3; // A one-cell Y heading and toggle, plus its gutter.
            minimum[1] = 3;
        }
        // Give up metadata columns before truncating reported limits and resets.
        for ([_]usize{ 3, 2, 4 }) |column| {
            var needed: u16 = 0;
            for (minimum, widths) |size, preferred| needed += @min(size, preferred);
            if (needed <= available) break;
            widths[column] = 0;
            minimum[column] = 0;
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
        if (m.managing) {
            if (x <= b.x or x >= b.x + b.w - 1) return null;
            const n = m.count() - 2;
            if (y >= b.y + 4 and y < b.y + 4 + n) return m.rowAt(y - b.y - 4);
            if (y >= b.y + n + 5 and y <= b.y + n + 17 + @as(u16, if (m.show_command) 2 else 0)) return .add;
            if (y == b.y + b.h - 2 and x >= b.x + b.w -| 10) return .manage;
            return null;
        }
        if (x <= b.x or x >= b.x + b.w - 1 or y < b.y + 2) return null;
        const index = y - b.y - 2;
        const manage_index = m.count() - 1;
        if (index == manage_index + 2) return .manage;
        if (index >= manage_index) return null;
        return m.rowAt(index);
    }
    pub fn visibilityHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?usize {
        if (!m.managing) return null;
        const row = m.hit(cols, rows, side, x, y) orelse return null;
        const index = row.custom() orelse return null;
        const b = m.bounds(cols, rows, side);
        return if (x < b.x + 9) index else null;
    }
    fn providerHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        if (m.managing) return null;
        return (m.hit(cols, rows, side, x, y) orelse return null).agent();
    }
    pub fn yoloHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0];
        return if (x >= start and x < start + widths[1] -| 2) provider else null;
    }
    pub fn trackable(m: *const Menu, row: Row) bool {
        if (m.managing) return false;
        const provider = row.agent() orelse return false;
        return !m.preview.pending and m.preview.options[@intFromEnum(provider)].usage_needs_consent;
    }
    pub fn usageHit(m: *const Menu, cols: u16, rows: u16, side: @import("sidebar.zig").View, x: u16, y: u16) ?Provider {
        const provider = m.providerHit(cols, rows, side, x, y) orelse return null;
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return null;
        const widths = m.columns(b.w);
        const start = b.x + 3 + widths[0] + widths[1] + widths[2] + widths[3] + widths[4];
        return if (x >= start and x < start + widths[5] -| 1) provider else null;
    }
    pub fn edit(m: *Menu, row: Row) void {
        m.draft = .{};
        m.request_id = 0;
        m.resolution = .{};
        m.save_requested = false;
        m.edit_index = row.custom();
        m.edit_provider = row.agent();
        const source = if (m.edit_index) |i| m.commands[i].inputText() else if (m.edit_provider) |provider| @tagName(provider) else "";
        m.editor = @import("name_dialog.zig").Dialog.init(.{ .agent_command = 0 }, source);
        m.name_focused = false;
        m.show_command = false;
        m.name_customized = m.edit_index != null;
        m.name_editor = @import("name_dialog.zig").Dialog.init(.{ .rename = @enumFromInt(0) }, if (m.edit_index) |i| m.commands[i].label() else "");
        if (m.edit_index) |i| {
            m.draft.set(source) catch {};
            m.resolution = .{ .pending = false, .command = m.commands[i], .semantics = m.commands[i].semantics };
        }
        m.selected = .add;
        m.pinned = true;
    }
    pub fn fieldWidth(b: @import("layout.zig").Rect) u16 {
        return b.w -| 17;
    }
    pub fn fieldOffset(m: *const Menu, width: u16) usize {
        var offset = m.editor.cursor -| (width -| 1);
        while (offset < m.editor.cursor and m.editor.text[offset] & 0xc0 == 0x80) offset += 1;
        return offset;
    }
    pub fn input(m: *Menu) *@import("name_dialog.zig").Dialog {
        return if (m.name_focused) &m.name_editor else &m.editor;
    }
    fn account(m: *const Menu, info: *const @import("launch_command.zig").Semantics) []const u8 {
        if (info.account.len > 0) return info.account.text();
        if (info.default_account) if (info.provider) |provider| {
            const option = &m.preview.options[@intFromEnum(provider)];
            return if (option.account.len > 0) option.account.text() else if (m.preview.pending) "Reading default account…" else "Default account · unavailable";
        };
        return "Account unknown";
    }
    fn drawInput(w: *std.Io.Writer, editor: @import("name_dialog.zig").Dialog, placeholder: []const u8, x: u16, y: usize, width: u16, focused: bool) !void {
        const sidebar = @import("sidebar.zig");
        var offset = editor.cursor -| (width -| 1);
        while (offset < editor.cursor and editor.text[offset] & 0xc0 == 0x80) offset += 1;
        const end = editor.byteAtColumn(offset, width);
        try w.print("\x1b[{d};{d}H\x1b[48;2;{s}m", .{ y, x, if (focused) "47;64;59" else "43;48;55" });
        try w.splatByteAll(' ', width);
        try w.print("\x1b[{d};{d}H", .{ y, x });
        if (editor.len == 0) try sidebar.writeEllipsis(w, placeholder, width) else {
            if (focused and editor.selected) try w.writeAll("\x1b[7m");
            for (editor.text[offset..end]) |ch| try w.writeByte(if (ch < 32 or ch == 127) ' ' else ch);
        }
        try w.writeAll("\x1b[0;38;2;201;208;215;48;2;35;40;47m");
    }
    fn drawManager(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: @import("sidebar.zig").View) !void {
        const sidebar = @import("sidebar.zig");
        const b = m.bounds(cols, rows, side);
        if (b.w < 40 or b.h < m.rowsHeight()) return;
        const panel = "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
        for (0..b.h) |y| {
            try w.print("\x1b[{d};{d}H{s}{s}", .{ b.y + y + 1, b.x + 1, panel, if (y == 0) "╭" else if (y == b.h - 1) "╰" else "│" });
            if (y == 0 or y == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (y == 0) "╮" else if (y == b.h - 1) "╯" else "│");
        }
        try w.print("\x1b[{d};{d}H Manage agents ", .{ b.y + 1, b.x + 3 });
        const name_width: u16 = @min(24, b.w / 3);
        const command_x = b.x + 10 + name_width;
        try w.print("\x1b[{d};{d}HShow\x1b[{d};{d}HAgent\x1b[{d};{d}HAccount", .{ b.y + 3, b.x + 4, b.y + 3, b.x + 10, b.y + 3, command_x });
        try w.print("\x1b[{d};{d}H", .{ b.y + 4, b.x + 4 });
        for (0..b.w - 6) |_| try w.writeAll("─");
        const n = m.count() - 2;
        for (0..n) |i| {
            const row = m.rowAt(i).?;
            const custom = row.custom();
            const hidden = if (custom) |index| m.commands[index].hidden else m.hidden[@intFromEnum(row)];
            const label = if (custom) |index| m.commands[index].label() else row.agent().?.info().label;
            const info = if (custom) |index| m.commands[index].semantics else @import("launch_command.zig").Semantics{ .provider = row.agent().?, .default_account = true };
            const source = m.account(&info);
            try w.print("\x1b[{d};{d}H{s} [{s}]\x1b[{d};{d}H", .{ b.y + 5 + i, b.x + 2, if (m.selected == row) "›" else " ", if (hidden) " " else "✓", b.y + 5 + i, b.x + 10 });
            try sidebar.writeEllipsis(w, label, name_width - 2);
            try w.print("\x1b[{d};{d}H", .{ b.y + 5 + i, command_x });
            var clean: [2048]u8 = undefined;
            for (source, 0..) |ch, j| clean[j] = if (ch < 32 or ch == 127) ' ' else ch;
            try sidebar.writeEllipsis(w, clean[0..source.len], b.x + b.w -| 19 -| command_x);
            try w.print("\x1b[{d};{d}H[Edit]", .{ b.y + 5 + i, b.x + b.w - 17 });
            if (custom != null) try w.print("\x1b[{d};{d}H[Delete]", .{ b.y + 5 + i, b.x + b.w - 10 });
        }
        const field_y = b.y + n + 6;
        const input_x = b.x + 5;
        const width = b.w -| 10;
        const dim = "\x1b[38;2;112;124;135m";
        for (0..2) |i| {
            const top = field_y + i * 4;
            const focused = m.selected == .add and m.name_focused == (i == 1);
            try w.print("\x1b[{d};{d}H{s}{s}", .{ top, b.x + 4, dim, if (i == 0) "Command" else "Name" });
            const border = if (focused) "\x1b[38;2;139;190;167m" else dim;
            for (0..3) |line| {
                try w.print("\x1b[{d};{d}H{s}{s}", .{ top + line + 1, b.x + 4, border, if (line == 0) "┌" else if (line == 2) "└" else "│" });
                if (line != 1) {
                    for (0..width + 2) |_| try w.writeAll("─");
                } else try w.splatByteAll(' ', width + 2);
                try w.writeAll(if (line == 0) "┐" else if (line == 2) "┘" else "│");
            }
            try w.writeAll(panel);
            try drawInput(w, if (i == 0) m.editor else m.name_editor, if (i == 0) "Paste a command…" else "Suggested automatically", input_x + 1, top + 2, width, focused);
        }
        if (m.editor.len > 0) {
            const matches = std.mem.eql(u8, m.draft.text(), m.editor.name());
            const resolved = matches and !m.resolution.pending and m.resolution.error_message.len == 0;
            const status = if (m.editor.failed and m.save_error.len > 0) m.save_error.text() else if (m.editor.overflow) "Command too long" else if (!matches or m.resolution.pending) "Resolving command…" else if (m.resolution.error_message.len > 0) m.resolution.error_message.text() else m.account(&m.resolution.semantics);
            try w.print("\x1b[{d};{d}H", .{ field_y + 9, b.x + 4 });
            var summary: [512]u8 = undefined;
            const info = &m.resolution.semantics;
            const provider = if (info.provider) |known| known.info().label else "Custom agent";
            try sidebar.writeEllipsis(w, if (resolved) std.fmt.bufPrint(&summary, "{s} · {s}", .{ provider, status }) catch status else status, b.w - 8);
            try w.print("\x1b[{d};{d}H{s}", .{ field_y + 10, b.x + 4, dim });
            if (resolved) {
                var detail: [340]u8 = undefined;
                const mode = if (std.mem.eql(u8, info.mode.text(), "Provider permission settings")) "" else info.mode.text();
                const text = std.fmt.bufPrint(&detail, "{s}{s}{s}", .{ info.model.text(), if (info.model.len > 0 and mode.len > 0) " · " else "", mode }) catch "";
                try sidebar.writeEllipsis(w, text, b.w - 26);
                try w.print("\x1b[{d};{d}H[{s} command]", .{ field_y + 10, b.x + b.w - 17, if (m.show_command) "Hide" else "Show" });
                if (m.show_command) {
                    try w.print("\x1b[{d};{d}HRuns: ", .{ field_y + 12, b.x + 4 });
                    var clean: [2048]u8 = undefined;
                    const source = m.resolution.command.text();
                    for (source, 0..) |ch, j| clean[j] = if (ch < 32 or ch == 127) ' ' else ch;
                    try sidebar.writeEllipsis(w, clean[0..source.len], b.w - 14);
                }
            }
        }
        try w.print("{s}\x1b[{d};{d}H[Cancel]  [{s}]", .{ panel, field_y + 12 + @as(usize, if (m.show_command) 2 else 0), b.x + b.w - 19, if (m.edit_index != null or m.edit_provider != null) "Save" else "Add" });
        try w.print("\x1b[{d};{d}H{s}Tab: command / name\x1b[{d};{d}H{s}[Done]\x1b[?25l", .{ b.y + b.h - 1, b.x + 4, dim, b.y + b.h - 1, b.x + b.w - 9, panel });
        if (m.selected == .add) {
            const editor = if (m.name_focused) m.name_editor else m.editor;
            var offset = editor.cursor -| (width -| 1);
            while (offset < editor.cursor and editor.text[offset] & 0xc0 == 0x80) offset += 1;
            const cursor = @min(width -| 1, sidebar.displayWidth(editor.text[offset..editor.cursor]));
            try w.print("\x1b[{d};{d}H\x1b[?25h", .{ field_y + 2 + @as(usize, if (m.name_focused) 4 else 0), input_x + 1 + cursor });
        }
    }

    pub fn draw(m: *const Menu, w: *std.Io.Writer, cols: u16, rows: u16, side: @import("sidebar.zig").View) !void {
        if (m.managing) return m.drawManager(w, cols, rows, side);
        const sidebar = @import("sidebar.zig");
        const b = m.bounds(cols, rows, side);
        if (b.w < 24 or b.h < m.rowsHeight()) return;
        const panel = "\x1b[0;38;2;112;124;135;48;2;35;40;47m";
        for (0..b.h) |row| {
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + row + 1, b.x + 1, panel });
            try w.writeAll(if (row == 0) "╭" else if (row == b.h - 1) "╰" else "│");
            if (row == 0 or row == b.h - 1) {
                for (0..b.w - 2) |_| try w.writeAll("─");
            } else try w.splatByteAll(' ', b.w - 2);
            try w.writeAll(if (row == 0) "╮" else if (row == b.h - 1) "╯" else "│");
        }
        try w.print("\x1b[{d};{d}H\x1b[1;38;2;226;230;233m {s} ", .{ b.y + 1, b.x + 3, if (m.managing) "Manage agents" else "New agent" });
        const widths = m.columns(b.w);
        var heading_x: u16 = b.x + 4;
        for (headings, widths, 0..) |heading, width, column| {
            if (width == 0 or (m.managing and column != 0)) continue;
            try w.print("\x1b[{d};{d}H{s}", .{ b.y + 2, heading_x + @as(u16, if (column == 0) 4 else 0), panel });
            const room = width -| @as(u16, if (column == 0) 6 else if (column == 5) 1 else 2);
            try sidebar.writeEllipsis(w, if (column == 1 and room < 4) "Y" else if (column == 5 and room < sidebar.displayWidth(heading)) (if (room >= 14) "Usage · resets" else "Usage") else heading, room);
            heading_x += width;
        }
        for (0..m.count()) |visible| {
            const current = m.rowAt(visible).?;
            const i = @intFromEnum(current);
            const selected = current == m.selected;
            const row = b.y + 3 + visible + @as(usize, if (current == .manage) 2 else 0);
            if (current == .manage) {
                try w.print("\x1b[{d};{d}H{s}\x1b[38;2;112;124;135m", .{ row - 1, b.x + 4, panel });
                for (0..b.w - 6) |_| try w.writeAll("─");
            }
            const style = if (selected) "\x1b[0;38;2;226;230;233;48;2;47;64;59m" else "\x1b[0;38;2;201;208;215;48;2;35;40;47m";
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, style });
            try w.splatByteAll(' ', b.w - 2);
            try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 2, if (selected) "›" else " " });
            if (current.agent() != null or current.custom() != null) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                const digit = [_]u8{'0' + @as(u8, @intCast(visible))};
                try writeKey(w, &digit, style);
            }
            if (current == .add) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try sidebar.writeEllipsis(w, "+ Add agent…", b.w -| 6);
                continue;
            }
            if (current == .manage) {
                const button = if (selected) "\x1b[0;1;38;2;242;247;244;48;2;65;94;80m" else "\x1b[0;1;38;2;226;230;233;48;2;58;68;79m";
                try w.print("\x1b[{d};{d}H{s}", .{ row, b.x + 4, button });
                try sidebar.writeEllipsis(w, " → Manage agents… ", b.w -| 6);
                try w.writeAll(style);
                continue;
            }
            if (m.managing) {
                var line: [160]u8 = undefined;
                const status = if (!m.preview.installed[i]) "Not installed" else if (m.preview.options[i].signed_in == false) "Not signed in" else if (m.hidden[i]) "Hidden" else "In picker";
                const text = try std.fmt.bufPrint(&line, "{s} · {s}   [{s}]", .{ current.agent().?.info().label, status, if (m.hidden[i]) "Add" else "Remove" });
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try sidebar.writeEllipsis(w, text, b.w -| 6);
                continue;
            }
            if (current == .terminal) {
                try w.print("\x1b[{d};{d}H", .{ row, b.x + 4 });
                try writeKey(w, "t", style);
                try w.writeAll(" ");
                try sidebar.writeEllipsis(w, "New terminal", b.w -| 10);
                continue;
            }
            var x: u16 = b.x + 4;
            const values = if (current.custom()) |index| m.customCells(index) else m.cells(current.agent().?);
            const yolo = std.mem.eql(u8, values[1], "✓");
            for (values, widths, 0..) |text, width, column| {
                if (width == 0) continue;
                try w.print("\x1b[{d};{d}H", .{ row, x + @as(u16, if (column == 0) 4 else 0) });
                if (column == 5 and m.trackable(current)) try w.writeAll("\x1b[4m");
                if (column == 1 and yolo) try w.writeAll("\x1b[1;38;2;255;255;255m");
                const room = width -| @as(u16, if (column == 0) 6 else if (column == 5) 1 else 2);
                if (column == 5) {
                    try m.usageCell(current, text).write(w, room, style);
                } else try sidebar.writeEllipsis(w, text, room);
                try w.writeAll("\x1b[24m");
                if (column == 1 and yolo) try w.writeAll(style);
                x += width;
            }
        }
        const Hint = struct { key: []const u8, label: []const u8 };
        const hints: []const Hint = if (m.managing or m.selected == .manage)
            &.{.{ .key = "↵", .label = if (m.selected == .manage) "back/open" else if (m.selected == .add) "add" else if (m.selected.custom() != null) "edit" else if (m.hidden[@intFromEnum(m.selected)]) "add" else "remove" }}
        else if (m.selected.custom() != null)
            &.{.{ .key = "a", .label = "launch" }}
        else if (m.selected == .terminal)
            &.{.{ .key = "a", .label = "open" }}
        else if (m.trackable(m.selected))
            &.{ .{ .key = "u", .label = "Track usage" }, .{ .key = "a", .label = "launch" }, .{ .key = "y", .label = "YOLO" } }
        else
            &.{ .{ .key = "a", .label = "launch" }, .{ .key = "y", .label = "YOLO" } };
        var hint_width: u16 = 0;
        for (hints, 0..) |hint, i| hint_width += @intCast(3 + 1 + hint.label.len + @as(usize, if (i > 0) 2 else 0));
        const footer_row = b.y + b.h - 1;
        try w.print("\x1b[{d};{d}H{s}", .{ footer_row, b.x + 3, panel });
        const directory = std.fs.path.basename(m.cwd[0..m.cwd_len]);
        var buffer: [std.fs.max_path_bytes + 32]u8 = undefined;
        const footer = try std.fmt.bufPrint(&buffer, "{s} · new tab", .{directory});
        try sidebar.writeEllipsis(w, footer, b.w -| (hint_width + 6));
        try w.print("\x1b[{d};{d}H", .{ footer_row, b.x + b.w - 1 - hint_width });
        for (hints, 0..) |hint, i| {
            if (i > 0) try w.writeAll("  ");
            try writeKey(w, hint.key, panel);
            try w.print(" {s}", .{hint.label});
        }
        try w.writeAll("\x1b[0m\x1b[?25l");
    }
};

/// Draw a one-letter keycap, then restore the surrounding style.
fn writeKey(w: *std.Io.Writer, key: []const u8, after: []const u8) !void {
    try w.print("\x1b[0;1;38;2;226;230;233;48;2;74;83;94m {s} {s}", .{ key, after });
}

test "launch preview settings overlay and menu bounds" {
    var result: Option = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"model\":\"opus\"}", .{});
    defer parsed.deinit();
    applyModel(&result, parsed.value, "Project");
    try std.testing.expectEqualStrings("opus", result.model.text());
    const side = @import("sidebar.zig").View.init(80, 24, true, 0, 0);
    const menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    const b = menu.bounds(80, 24, side);
    try std.testing.expect(b.x + b.w <= 80 and b.y + b.h <= 24);
    try std.testing.expectEqual(Row.codex, menu.hit(80, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Row.claude, menu.hit(80, 24, side, b.x + 2, b.y + 3).?);
    try std.testing.expectEqual(Row.terminal, menu.hit(80, 24, side, b.x + 2, b.y + 4).?);
    try std.testing.expectEqual(@as(?Row, .manage), menu.hit(80, 24, side, b.x + 2, b.y + 7));
    try std.testing.expectEqual(@as(?Row, null), menu.hit(80, 24, side, b.x + 2, b.y + 6));
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
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .claude, .last = .codex, .pinned = true };
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

test "single-line limit groups survive narrow terminal rendering" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    menu.preview.options[0].usage.set("7d 48%");
    menu.preview.options[1].usage.set("5h 17% / 7d 35%");
    const now = std.time.timestamp();
    menu.preview.options[0].resets.at[1] = now + 6 * 86400 + 18 * 3600;
    menu.preview.options[0].resets.labels[1].set("7d");
    menu.preview.options[1].resets.at = .{ now + 99 * 60, now + 86400 + 15 * 3600 };
    menu.preview.options[1].resets.labels[0].set("5h");
    menu.preview.options[1].resets.labels[1].set("7d");
    for (&menu.preview.options) |*option| {
        option.usage_fetched_at = now;
        option.account.set("toasty.tal@gmail.com");
        option.model.set("gpt-6-astra");
        option.plan.set("pro");
    }
    for ([_]u16{ 60, 80, 100, 124 }) |cols| {
        const side = @import("sidebar.zig").View.init(cols, 24, true, 0, 0);
        var output: std.Io.Writer.Allocating = .init(a);
        defer output.deinit();
        try menu.draw(&output.writer, cols, 24, side);
        const terminal = try @import("terminal.zig").Terminal.create(cols, 24);
        defer terminal.destroy();
        terminal.feed(output.written());
        const rendered = try terminal.text();
        defer a.free(rendered);
        var found: [2]usize = .{ 0, 0 };
        var lines = std.mem.splitScalar(u8, rendered, '\n');
        while (lines.next()) |line| {
            if (std.mem.indexOf(u8, line, "Codex") != null) {
                found[0] += 1;
                try std.testing.expect(std.mem.indexOf(u8, line, "7d") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "48%") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "6d 18h") != null);
                try std.testing.expect(std.mem.indexOf(u8, line, "5h") == null);
            }
            if (std.mem.indexOf(u8, line, "Claude Code") != null) {
                found[1] += 1;
                for ([_][]const u8{ "5h", "17%", "1h 39m", " │ 7d", "35%", "1d 15h" }) |value|
                    try std.testing.expect(std.mem.indexOf(u8, line, value) != null);
            }
            try std.testing.expect(@import("sidebar.zig").displayWidth(line) <= cols);
        }
        try std.testing.expectEqual([2]usize{ 1, 1 }, found);
        const b = menu.bounds(cols, 24, side);
        const x = b.x + 3 + menu.columns(b.w)[0];
        try std.testing.expectEqual(Provider.codex, menu.yoloHit(cols, 24, side, x, b.y + 2).?);
    }
}

test "viewer expires a delivered usage reading after ten minutes" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.pending = false;
    const option = &menu.preview.options[0];
    option.usage.set("7d 48%");
    option.usage_fetched_at = std.time.timestamp() - 590;
    try std.testing.expectEqualStrings("7d 48%", menu.cells(.codex)[5]);
    option.usage_fetched_at = std.time.timestamp() - metadata.usage_max_age;
    try std.testing.expectEqualStrings("Unavailable", menu.cells(.codex)[5]);
    option.usage.set("Metered");
    try std.testing.expectEqualStrings("Metered", menu.cells(.codex)[5]);
}

fn parseAccount(bytes: []const u8) Text {
    const parsed = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return .{};
    defer parsed.deinit();
    return metadata.claudeAccount(parsed.value).account;
}

test "launcher hides providers that are not installed" {
    const side = @import("sidebar.zig").View.init(120, 24, true, 0, 0);
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.installed = .{ false, true };
    menu.normalize();
    try std.testing.expectEqual(Row.claude, menu.selected);
    const b = menu.bounds(120, 24, side);
    try std.testing.expectEqual(@as(u16, 10), b.h);
    try std.testing.expectEqual(Row.claude, menu.hit(120, 24, side, b.x + 2, b.y + 2).?);
    try std.testing.expectEqual(Row.terminal, menu.hit(120, 24, side, b.x + 2, b.y + 3).?);
    try std.testing.expectEqual(@as(?Row, .manage), menu.hit(120, 24, side, b.x + 2, b.y + 6));
    menu.move(true, true);
    try std.testing.expectEqual(Row.terminal, menu.selected);
    menu.move(true, true);
    try std.testing.expectEqual(Row.manage, menu.selected);
    menu.move(true, true);
    try std.testing.expectEqual(Row.claude, menu.selected);
    menu.preview.installed = .{ false, false };
    menu.normalize();
    try std.testing.expectEqual(Row.terminal, menu.selected);
    try std.testing.expectEqual(Row.terminal, menu.first());
}

test "signed-out and hidden agents remain editable in management" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    menu.preview.options[0].signed_in = false;
    menu.hidden[1] = true;
    menu.normalize();
    try std.testing.expectEqual(Row.terminal, menu.selected);
    try std.testing.expect(!menu.shown(.codex) and !menu.shown(.claude));
    menu.managing = true;
    try std.testing.expect(menu.shown(.codex) and menu.shown(.claude) and menu.shown(.add));
    try menu.commands[0].set("FOO=123 claude --whatever");
    menu.commands[0].hidden = true;
    try std.testing.expect(menu.shown(.custom0));
    menu.managing = false;
    try std.testing.expect(!menu.shown(.custom0));
    menu.commands[0].hidden = false;
    try std.testing.expect(menu.shown(.custom0));
    menu.preview.options[0].signed_in = null;
    try std.testing.expect(menu.shown(.codex));
}

test "digit shortcuts enumerate visible agents and exclude terminal and management" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .codex, .last = .codex, .pinned = true };
    try std.testing.expectEqual(Row.codex, menu.shortcutRow('0').?);
    try std.testing.expectEqual(Row.claude, menu.shortcutRow('1').?);
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('2'));
    menu.hidden[0] = true;
    try menu.commands[3].set("claude --model opus");
    try std.testing.expectEqual(Row.claude, menu.shortcutRow('0').?);
    try std.testing.expectEqual(Row.custom3, menu.shortcutRow('1').?);
    menu.preview.options[1].signed_in = false;
    try std.testing.expectEqual(Row.custom3, menu.shortcutRow('0').?);
    menu.commands[3].hidden = true;
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('0'));
    menu.managing = true;
    try std.testing.expectEqual(@as(?Row, null), menu.shortcutRow('0'));
}

test "custom picker cells preserve account scope and permission state" {
    var menu: Menu = .{ .workspace = @enumFromInt(1), .cwd_len = 0, .selected = .custom0, .last = .claude, .pinned = true };
    menu.preview.pending = false;
    menu.preview.options[1].account.set("personal@example.com");
    menu.preview.options[1].plan.set("Max");
    menu.preview.options[1].model.set("opus");
    try menu.commands[0].set("claude --dangerously-skip-permissions");
    menu.commands[0].semantics = @import("launch_command.zig").analyze(menu.commands[0].text(), "/tmp");
    var values = menu.customCells(0);
    try std.testing.expectEqualStrings("personal@example.com", values[3]);
    try std.testing.expectEqualStrings("✓", values[1]);
    try std.testing.expectEqualStrings("Max", values[4]);
    menu.commands[0].semantics.default_account = false;
    menu.commands[0].semantics.account.set("work@example.com (cached)");
    values = menu.customCells(0);
    try std.testing.expectEqualStrings("work@example.com (cached)", values[3]);
    try std.testing.expectEqualStrings("—", values[4]);
    try std.testing.expectEqualStrings("—", values[5]);
}
