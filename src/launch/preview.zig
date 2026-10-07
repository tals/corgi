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
const Model = @import("../providers/model.zig").Model;
const subprocess = @import("../subprocess.zig");
const claude = @import("claude.zig");
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
        var claude_client: claude.Client = .{};
        defer claude_client.deinit();
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
                if (result.installed.get(provider)) result.options.set(provider, option(provider, &pool, &claude_client, &job, w));
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
fn option(provider: Provider, pool: *inference.Pool, claude_client: *claude.Client, job: *const Job, w: *const Worker) Option {
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
        .claude => claude_client.preview(stopping, &w.quit),
    };
    if (provider == .claude and result.model.len == 0 and claude_client.default_model.len > 0) {
        result.setModel(claude_client.default_model.text(), "Claude Code default");
    }
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
