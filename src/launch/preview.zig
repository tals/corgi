//! Daemon-side launcher previews: installed providers, signed-in accounts,
//! plan limits and models. Launch previews never run inference; viewers show
//! `Preview`.
const std = @import("std");
const compat = @import("../compat.zig");
const os = @import("../os.zig");
const a = os.allocator;
const providers = @import("../providers.zig");
const Provider = providers.Provider;
const discovery = @import("../discovery.zig");
const inference = @import("../inference.zig");
const common = @import("../providers/common.zig");
const agents = @import("../agents.zig");
const Path = @import("../bounded_text.zig").Path;
const metadata = @import("../usage.zig").account;
const account_cache = @import("../usage.zig").account_cache;
const limit_history = @import("../usage.zig").limits;
const launch_command = @import("command.zig");
const Model = @import("../providers/model.zig").Model;
const subprocess = @import("../subprocess.zig");
const log = std.log.scoped(.launch_preview);
pub const Text = metadata.Text;
pub const Option = struct {
    signed_in: ?bool = null,
    /// As configured, such as "opus" or "gpt-6-astra".
    model: Text = .{},
    /// Its name, such as "Opus" or "GPT-6 Astra"; empty for an unknown shape.
    model_name: Text = .{},
    source: Text = .{},
    account: Text = .{},
    plan: Text = .{},
    limits: metadata.Limits = .none,
    usage_fetched_at: i64 = 0,
    usage_error: Text = .{},
    usage_needs_consent: bool = false,
    /// Readings across each limit window, in the order of `limits.windows`.
    history: [2]limit_history.Spark = limit_history.none,

    /// The model's name, or its id when it has none.
    pub fn modelLabel(o: *const Option) []const u8 {
        return if (o.model_name.len > 0) o.model_name.text() else o.model.text();
    }
    fn setModel(o: *Option, model: []const u8, source: []const u8) void {
        o.model = .ascii(model);
        o.model_name = Model.resolve(model).name;
        o.source = .ascii(source);
    }
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
    mutex: std.Io.Mutex = .init,
    wake: std.Io.Condition = .init,
    stopping: std.atomic.Value(bool) = .init(false),
    quit: subprocess.Quit = .{},
    thread: ?std.Thread = null,
    // Enough slots for every connected client's subscribed directory.
    jobs: [32]?Job = @splat(null),
    pub fn start() !*Worker {
        const w = try a.create(Worker);
        errdefer a.destroy(w);
        w.* = .{ .quit = try .init() };
        errdefer w.quit.deinit();
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.stopping.store(true, .release);
        w.quit.signal();
        w.wake.signal(os.io());
        w.thread.?.join();
        w.quit.deinit();
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
        w.mutex.lockUncancelable(os.io());
        defer w.mutex.unlock(os.io());
        const now = os.milliTimestamp();
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
                    w.wake.signal(os.io());
                    return job.preview;
                }
                if (w.jobs[oldest] != null and job.used < w.jobs[oldest].?.used) oldest = i;
            } else oldest = i;
        }
        var job: Job = .{ .cwd = dir, .used = now, .request_access = request_access };
        // Filesystem-only, so the first reply already hides missing providers.
        job.preview.installed = installed();
        w.jobs[oldest] = job;
        w.wake.signal(os.io());
        return job.preview;
    }
    fn run(w: *Worker) void {
        var pool: inference.Pool = .{ .config = .{ .timeout_ms = 5000 } };
        defer pool.deinit();
        while (!w.stopping.load(.acquire)) {
            w.mutex.lockUncancelable(os.io());
            const index = for (w.jobs, 0..) |entry, i| {
                if (entry != null and entry.?.queued) break i;
            } else {
                compat.timedWait(&w.wake, os.io(), &w.mutex, 250 * std.time.ns_per_ms) catch {};
                w.mutex.unlock(os.io());
                continue;
            };
            const job = w.jobs[index].?;
            w.jobs[index].?.queued = false;
            w.jobs[index].?.request_access = false;
            w.jobs[index].?.accessing = job.request_access;
            w.mutex.unlock(os.io());
            var result: Preview = .{ .pending = false, .installed = installed() };
            // Skip reads for missing providers; their rows are hidden.
            for (Provider.all) |provider| {
                if (result.installed.get(provider)) result.options.set(provider, option(provider, &pool, &job, w));
            }
            w.mutex.lockUncancelable(os.io());
            if (w.jobs[index]) |*current| if (std.mem.eql(u8, current.cwd.text(), job.cwd.text())) {
                current.preview = result;
                // A click may have queued access while a silent read was running.
                current.preview.pending = current.queued;
                current.accessing = false;
                current.updated = os.milliTimestamp();
            };
            w.mutex.unlock(os.io());
        }
    }
};
/// One provider's launcher row: the model it would run and its account.
fn option(provider: Provider, pool: *inference.Pool, job: *const Job, w: *const Worker) Option {
    const cwd = job.cwd.text();
    const stopping = &w.stopping;
    var result = switch (provider) {
        .codex => codexModel(pool, cwd, stopping),
        .claude => claudeModel(cwd),
    };
    const account = switch (provider) {
        .codex => codexAccount(pool, stopping) catch {
            result.usage_error = .ascii("account read failed");
            return result;
        },
        .claude => claudeAccount(cwd, stopping, &w.quit, job.request_access),
    };
    result.signed_in = account.signed_in;
    result.account = account.account;
    result.plan = account.plan;
    result.limits = account.limits;
    result.usage_fetched_at = account.usage_fetched_at;
    result.usage_error = account.usage_error;
    result.usage_needs_consent = account.usage_needs_consent;
    result.history = limit_history.update(provider, account, stopping);
    return result;
}
fn codexModel(pool: *inference.Pool, cwd: []const u8, stopping: *const std.atomic.Value(bool)) Option {
    var result: Option = .{};
    if (pool.configuredModel(cwd, stopping)) |model| {
        result.setModel(model.text(), "Effective Codex settings");
    } else |_| result.source = .ascii("Model resolved by Codex at startup");
    return result;
}
fn codexAccount(pool: *inference.Pool, stopping: *const std.atomic.Value(bool)) !metadata.Info {
    const root = try providers.Codex.info.configDir(a);
    defer a.free(root);
    const path = try std.fs.path.join(a, &.{ root, "auth.json" });
    defer a.free(path);
    const auth = std.Io.Dir.cwd().readFileAlloc(os.io(), path, a, .limited(65536)) catch try a.dupe(u8, root);
    defer a.free(auth);
    const identity = try std.fmt.allocPrint(a, "{s}\n{s}", .{ auth, os.env("OPENAI_API_KEY") orelse "" });
    defer a.free(identity);
    var cache = try account_cache.Cache.open("codex", identity, stopping);
    defer cache.close();
    const now = os.timestamp();
    if (now < cache.state.next_usage) return cache.state.display(now);
    cache.state.next_usage = now + account_cache.interval;
    try cache.save();
    const fresh = pool.configuredAccount(stopping) catch |err| {
        cache.state.failed(if (err == error.Timeout) "request timed out" else "account read failed");
        try cache.save();
        return cache.state.display(os.timestamp());
    };
    cache.state.update(fresh, os.timestamp());
    try cache.save();
    return cache.state.display(os.timestamp());
}
fn claudeAccount(cwd: []const u8, stopping: *const std.atomic.Value(bool), quit: *const subprocess.Quit, request_access: bool) metadata.Info {
    // Never invoke `claude auth status` here: the CLI can perform its own
    // prompt-capable Keychain read outside our helper's interaction guard.
    var info: metadata.Info = .{};
    info.usage_error = .ascii("credentials unavailable");
    var env = os.environMap(a) catch return info;
    defer env.deinit();
    if (claudeEnvAccount(&env)) |selected| return selected;
    const executable = std.process.executablePathAlloc(os.io(), a) catch return info;
    defer a.free(executable);
    const response_bytes = command(&.{ executable, "__claude-credentials", if (request_access) "interactive" else "silent" }, cwd, null, quit, if (request_access) 120000 else 3000) orelse {
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
    info.plan = providers.Claude.plan(common.str(oauth, "subscriptionType"), common.str(oauth, "rateLimitTier"));
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
    // The login keeps the plan from sign-in; the profile's is current.
    if (cache.state.info.plan.len == 0) cache.state.info.plan = info.plan;
    const now = os.timestamp();
    const expires = common.field(oauth, "expiresAt");
    if (expires == .integer and expires.integer <= os.milliTimestamp()) {
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
        if (command(&usage_argv, cwd, headers, quit, 3500)) |bytes| {
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
                        cache.state.info.usage_fetched_at = os.timestamp();
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
        if (command(&profile_argv, cwd, headers, quit, 3500)) |bytes| {
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
                    const organization = common.field(parsed.value, "organization");
                    const plan = providers.Claude.plan(common.str(organization, "organization_type"), common.str(organization, "rate_limit_tier"));
                    if (plan.len > 0) cache.state.info.plan = plan;
                } else |_| {}
            }
        }
    }
    if (cache.state.info.account.len == 0) cache.state.info.account = .ascii("Signed in");
    cache.save() catch |err| log.warn("claude account cache save failed: {}", .{err});
    return cache.state.display(os.timestamp());
}
fn command(argv: []const []const u8, cwd: []const u8, input: ?[]const u8, quit: *const subprocess.Quit, timeout_ms: u32) ?[]u8 {
    const out = subprocess.run(a, argv, .{ .cwd = cwd, .input = input, .timeout_ms = timeout_ms, .max_output = 16384, .quit = quit }) catch return null;
    a.free(out.stderr);
    // The CLI also returns JSON with an unsuccessful login status.
    return out.stdout;
}
/// The account Claude's variables in `env` select over the default login,
/// read as a launch command's prefix would read them.
fn claudeEnvAccount(env: *const std.process.Environ.Map) ?metadata.Info {
    var found: std.EnumSet(common.EnvOverride) = .initEmpty();
    var entries = env.iterator();
    while (entries.next()) |entry| {
        if (providers.Claude.info.envOverride(entry.key_ptr.*, entry.value_ptr.*)) |override| found.insert(override);
    }
    var info: metadata.Info = .{ .signed_in = true };
    if (found.contains(.credential)) {
        info.account = .ascii("API key");
        info.plan = .ascii("API");
        info.limits = .metered;
    } else if (found.contains(.oauth)) {
        info.account = .ascii("OAuth token");
        info.usage_error = .ascii("token usage unsupported");
    } else if (found.contains(.endpoint)) {
        info.account = .ascii("External provider");
        info.limits = .metered;
    } else return null;
    return info;
}
fn claudeModel(cwd: []const u8) Option {
    var result: Option = .{};
    result.source = .ascii("Account default / provider selection");
    if (providers.Claude.info.configDir(a)) |root| {
        defer a.free(root);
        readModel(&result, root, "settings.json", "User settings");
    } else |_| {}
    readModel(&result, cwd, ".claude/settings.json", "Project settings (if trusted)");
    readModel(&result, cwd, ".claude/settings.local.json", "Local settings (if trusted)");
    if (os.env("ANTHROPIC_MODEL")) |model| if (model.len > 0) result.setModel(model, "ANTHROPIC_MODEL");
    readModel(&result, "/Library/Application Support/ClaudeCode", "managed-settings.json", "Managed settings");
    return result;
}
fn readModel(out: *Option, root: []const u8, relative: []const u8, source: []const u8) void {
    const path = std.fs.path.join(a, &.{ root, relative }) catch return;
    defer a.free(path);
    const fd = std.posix.openat(std.posix.AT.FDCWD, path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true }, 0) catch return;
    const file: std.Io.File = .{ .handle = fd, .flags = .{ .nonblocking = true } };
    defer file.close(os.io());
    const stat = file.stat(os.io()) catch return;
    if (stat.kind != .file or stat.size > 1024 * 1024) return;
    const bytes = os.readToEndAlloc(file, a, 1024 * 1024) catch return;
    defer a.free(bytes);
    const json = std.json.parseFromSlice(std.json.Value, a, bytes, .{}) catch return;
    defer json.deinit();
    applyModel(out, json.value, source);
}
fn applyModel(out: *Option, value: std.json.Value, source: []const u8) void {
    const model = agents.str(value, "model");
    if (model.len == 0) return;
    out.setModel(model, source);
}

test "launch preview settings overlay" {
    var result: Option = .{};
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator, "{\"model\":\"opus\"}", .{});
    defer parsed.deinit();
    applyModel(&result, parsed.value, "Project");
    try std.testing.expectEqualStrings("opus", result.model.text());
    try std.testing.expectEqualStrings("Opus", result.modelLabel());
}

test "Claude's account follows the variables a launch command would name" {
    const cases = [_]struct { name: []const u8, value: []const u8, account: ?[]const u8 }{
        .{ .name = "TERM", .value = "xterm", .account = null },
        .{ .name = "ANTHROPIC_BASE_URL", .value = "https://proxy.example", .account = "External provider" },
        .{ .name = "ANTHROPIC_BASE_URL", .value = "", .account = null },
        .{ .name = "CLAUDE_CODE_USE_BEDROCK", .value = "1", .account = "External provider" },
        .{ .name = "CLAUDE_CODE_USE_VERTEX", .value = " True ", .account = "External provider" },
        .{ .name = "CLAUDE_CODE_USE_BEDROCK", .value = "0", .account = null },
        .{ .name = "CLAUDE_CODE_USE_BEDROCK", .value = "", .account = null },
        .{ .name = "CLAUDE_CODE_USE_POWERSHELL_TOOL", .value = "1", .account = null },
        .{ .name = "ANTHROPIC_API_KEY", .value = "key", .account = "API key" },
        .{ .name = "ANTHROPIC_API_KEY", .value = "", .account = null },
        .{ .name = "CLAUDE_CODE_OAUTH_TOKEN", .value = "token", .account = "OAuth token" },
        .{ .name = "CLAUDE_CODE_OAUTH_TOKEN", .value = "", .account = null },
    };
    for (cases) |case| {
        var env = std.process.Environ.Map.init(std.testing.allocator);
        defer env.deinit();
        try env.put(case.name, case.value);
        const source = try std.fmt.allocPrint(std.testing.allocator, "{s}='{s}' claude", .{ case.name, case.value });
        defer std.testing.allocator.free(source);
        const analyzed = launch_command.analyze(source, "/tmp");
        if (case.account) |account| {
            try std.testing.expectEqualStrings(account, claudeEnvAccount(&env).?.account.text());
            try std.testing.expect(!analyzed.default_account);
        } else {
            try std.testing.expect(claudeEnvAccount(&env) == null);
            try std.testing.expect(analyzed.default_account);
        }
    }
    // A credential outranks an OAuth token, which outranks an endpoint.
    var env = std.process.Environ.Map.init(std.testing.allocator);
    defer env.deinit();
    try env.put("CLAUDE_CODE_USE_BEDROCK", "yes");
    try env.put("CLAUDE_CODE_OAUTH_TOKEN", "token");
    try std.testing.expectEqualStrings("OAuth token", claudeEnvAccount(&env).?.account.text());
    try env.put("ANTHROPIC_API_KEY", "key");
    try std.testing.expect(claudeEnvAccount(&env).?.limits == .metered);
}
