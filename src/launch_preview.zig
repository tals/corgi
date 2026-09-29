//! Daemon-side launcher previews: installed providers, signed-in accounts,
//! plan limits and models. Launch previews never run inference; viewers show
//! `Preview`.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const providers = @import("providers.zig");
const Provider = providers.Provider;
const discovery = @import("discovery.zig");
const inference = @import("inference.zig");
const common = @import("providers/common.zig");
const agents = @import("agents.zig");
const Path = @import("bounded_text.zig").Path;
const metadata = @import("account_preview.zig");
const account_cache = @import("account_cache.zig");
const limit_history = @import("limit_history.zig");
const log = std.log.scoped(.launch_preview);
pub const Text = metadata.Text;
pub const Option = struct {
    signed_in: ?bool = null,
    model: Text = .{},
    source: Text = .{},
    account: Text = .{},
    plan: Text = .{},
    limits: metadata.Limits = .none,
    usage_fetched_at: i64 = 0,
    usage_error: Text = .{},
    usage_needs_consent: bool = false,
    /// Readings across each limit window, in the order of `limits.windows`.
    history: [2]limit_history.Spark = limit_history.none,
};
pub const Preview = struct { pending: bool = true, options: providers.Each(Option, .{}) = .{}, installed: providers.Each(bool, true) = .{} };
fn installed() providers.Each(bool, true) {
    var result: providers.Each(bool, true) = .{};
    for (Provider.all) |provider| result.set(provider, discovery.installed(provider));
    return result;
}
const Job = struct {
    cwd: Path,
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
        const dir = Path.init(cwd) catch return .{};
        w.mutex.lock();
        defer w.mutex.unlock();
        const now = std.time.milliTimestamp();
        var oldest: usize = 0;
        for (&w.jobs, 0..) |*entry, i| {
            if (entry.*) |*job| {
                if (std.mem.eql(u8, cwd, job.cwd.text())) {
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
        var job: Job = .{ .cwd = dir, .used = now, .request_access = request_access };
        // Filesystem-only, so the first reply already hides missing providers.
        job.preview.installed = installed();
        w.jobs[oldest] = job;
        w.wake.signal();
        return job.preview;
    }
    fn run(w: *Worker) void {
        var pool: inference.Pool = .{ .config = .{ .timeout_ms = 5000 } };
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
            if (result.installed.get(.codex)) {
                const codex = result.options.getPtr(.codex);
                if (pool.configuredModel(job.cwd.text(), &w.stopping)) |model| {
                    codex.model = .ascii(model.text());
                    codex.source = .ascii("Effective Codex settings");
                } else |_| codex.source = .ascii("Model resolved by Codex at startup");
                if (codexAccount(&pool, &w.stopping)) |account| {
                    codex.signed_in = account.signed_in;
                    codex.account = account.account;
                    codex.plan = account.plan;
                    codex.limits = account.limits;
                    codex.usage_fetched_at = account.usage_fetched_at;
                    codex.usage_error = account.usage_error;
                    codex.history = limit_history.update(.codex, account, &w.stopping);
                } else |_| codex.usage_error = .ascii("account read failed");
            }
            if (result.installed.get(.claude)) {
                const option = result.options.getPtr(.claude);
                option.* = claude(job.cwd.text());
                const account = claudeAccount(job.cwd.text(), &w.stopping, job.request_access);
                option.signed_in = account.signed_in;
                option.account = account.account;
                option.plan = account.plan;
                option.limits = account.limits;
                option.usage_fetched_at = account.usage_fetched_at;
                option.usage_error = account.usage_error;
                option.usage_needs_consent = account.usage_needs_consent;
                option.history = limit_history.update(.claude, account, &w.stopping);
            }
            w.mutex.lock();
            if (w.jobs[index]) |*current| if (std.mem.eql(u8, current.cwd.text(), job.cwd.text())) {
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
fn codexAccount(pool: *inference.Pool, stopping: *const std.atomic.Value(bool)) !metadata.Info {
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
    info.usage_error = .ascii("credentials unavailable");
    if (os.env("ANTHROPIC_API_KEY") != null or os.env("ANTHROPIC_AUTH_TOKEN") != null) {
        info.signed_in = true;
        info.account = .ascii("API key");
        info.plan = .ascii("API");
        info.limits = .metered;
        info.usage_error = .{};
        return info;
    }
    if (os.env("CLAUDE_CODE_OAUTH_TOKEN") != null) {
        info.signed_in = true;
        info.account = .ascii("OAuth token");
        info.usage_error = .ascii("token usage unsupported");
        return info;
    }
    for ([_][:0]const u8{ "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY" }) |name| {
        if (std.mem.eql(u8, os.env(name) orelse "", "1")) {
            info.signed_in = true;
            info.account = .ascii("External provider");
            info.limits = .metered;
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
    const needs_consent = common.field(response_json.value, "needs_consent");
    info.usage_needs_consent = needs_consent == .bool and needs_consent.bool;
    const credentials = common.str(response_json.value, "credentials");
    if (credentials.len == 0) {
        if (info.usage_needs_consent) {
            info.account = .ascii("Access required");
        } else {
            info.signed_in = false;
            info.account = .ascii("Not signed in");
        }
        return info;
    }
    const json = std.json.parseFromSlice(std.json.Value, a, credentials, .{}) catch return info;
    defer json.deinit();
    const oauth = common.field(json.value, "claudeAiOauth");
    const subscription_type = common.str(oauth, "subscriptionType");
    if (info.plan.len == 0) info.plan = .ascii(subscription_type);
    if (std.mem.eql(u8, subscription_type, "max")) {
        const tier = common.str(oauth, "rateLimitTier");
        if (std.mem.endsWith(u8, tier, "_max_5x")) info.plan = .ascii("Max 5x") else if (std.mem.endsWith(u8, tier, "_max_20x")) info.plan = .ascii("Max 20x");
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
        info.usage_error = .ascii("cache read failed");
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
        const usage_argv = [_][]const u8{ "curl", "-q", "--silent", "--include", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/usage" };
        if (command(&usage_argv, cwd, headers, stopping, 3500)) |bytes| {
            defer a.free(bytes);
            const reply = account_cache.response(bytes, now);
            cache.state.next_usage = account_cache.nextAttempt(reply, now);
            cache.state.failedResponse(reply.status);
            if (reply.status == 200) {
                cache.state.failed("invalid usage response");
                if (std.json.parseFromSlice(std.json.Value, a, reply.body, .{})) |parsed| {
                    defer parsed.deinit();
                    const limits = metadata.limits(parsed.value, .claude);
                    if (limits != .none) {
                        cache.state.info.limits = limits;
                        cache.state.info.usage_fetched_at = std.time.timestamp();
                        cache.state.info.usage_error = .{};
                    }
                } else |_| {}
            }
        }
    }
    // Profile failures and usage failures are independent. Never erase identity
    // just because the usage endpoint is rate limited.
    if (fetch_profile) {
        const profile_argv = [_][]const u8{ "curl", "-q", "--silent", "--include", "--connect-timeout", "2", "--max-time", "3", "--header", "@-", "--", "https://api.anthropic.com/api/oauth/profile" };
        if (command(&profile_argv, cwd, headers, stopping, 3500)) |bytes| {
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
                            cache.state.info.account = .ascii(email);
                            break;
                        }
                    }
                } else |_| {}
            }
        }
    }
    if (cache.state.info.account.len == 0) cache.state.info.account = .ascii("Signed in");
    cache.save() catch |err| log.warn("claude account cache save failed: {}", .{err});
    return cache.state.display(std.time.timestamp());
}
fn command(argv: []const []const u8, cwd: []const u8, input: ?[]const u8, stopping: *const std.atomic.Value(bool), timeout_ms: u32) ?[]u8 {
    var child = std.process.Child.init(argv, a);
    child.cwd = cwd;
    child.stdin_behavior = if (input != null) .Pipe else .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    child.spawn() catch return null;
    var reaped = false;
    defer {
        if (!reaped) {
            _ = os.c.kill(-child.id, os.c.SIGKILL);
            var status: c_int = 0;
            _ = os.c.waitpid(child.id, &status, 0);
        }
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
        if (os.c.waitpid(child.id, &status, os.c.WNOHANG) == child.id) {
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
    result.source = .ascii("Account default / provider selection");
    const home = os.env("HOME") orelse "";
    const root = os.env("CLAUDE_CONFIG_DIR") orelse std.fs.path.join(a, &.{ home, ".claude" }) catch return result;
    defer if (os.env("CLAUDE_CONFIG_DIR") == null) a.free(root);
    readModel(&result, root, "settings.json", "User settings");
    readModel(&result, cwd, ".claude/settings.json", "Project settings (if trusted)");
    readModel(&result, cwd, ".claude/settings.local.json", "Local settings (if trusted)");
    if (os.env("ANTHROPIC_MODEL")) |model| if (model.len > 0) {
        result.model = .ascii(model);
        result.source = .ascii("ANTHROPIC_MODEL");
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
    const model = agents.str(value, "model");
    if (model.len == 0) return;
    out.model = .ascii(model);
    out.source = .ascii(source);
}

test "launch preview settings overlay" {
    var result: Option = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"model\":\"opus\"}", .{});
    defer parsed.deinit();
    applyModel(&result, parsed.value, "Project");
    try std.testing.expectEqualStrings("opus", result.model.text());
}

test "account preview shows identities or auth mode and never credential fields" {
    const account = parseAccount("{\"loggedIn\":true,\"authMethod\":\"claude.ai\",\"email\":\"person@example.com\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("person@example.com", account.text());
    const key = parseAccount("{\"loggedIn\":true,\"authMethod\":\"api_key\",\"apiKey\":\"secret\"}");
    try std.testing.expectEqualStrings("API key", key.text());
    const logged_out = parseAccount("{\"loggedIn\":false,\"email\":\"stale@example.com\"}");
    try std.testing.expectEqualStrings("Not signed in", logged_out.text());
}

fn parseAccount(bytes: []const u8) Text {
    const parsed = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return .{};
    defer parsed.deinit();
    return metadata.claudeAccount(parsed.value).account;
}
