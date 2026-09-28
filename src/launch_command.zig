//! Saved shell source is never rewritten or evaluated for a preview.
const std = @import("std");
const Provider = @import("providers.zig").Provider;
const os = @import("os.zig");
const detection = @import("detection.zig");
const common = @import("providers/common.zig");
const Text = @import("account_preview.zig").Text;
const Path = @import("bounded_text.zig").Path;
const BoundedText = @import("bounded_text.zig").BoundedText;
const log = std.log.scoped(.launch_command);
pub const capacity = 6;
pub const max_length = 2048;
pub const Command = BoundedText(max_length);
pub const Entry = struct {
    command: Command = .{},
    /// What the user typed, when it was resolved into `command`.
    original: Command = .{},
    hidden: bool = false,
    name: Text = .{},
    semantics: Semantics = .{},

    pub fn text(e: *const Entry) []const u8 {
        return e.command.text();
    }
    pub fn inputText(e: *const Entry) []const u8 {
        return if (e.original.len > 0) e.original.text() else e.text();
    }
    pub fn setOriginal(e: *Entry, source: []const u8) !void {
        e.original = Command.init(source) catch return error.InvalidCommand;
    }
    pub fn set(e: *Entry, source: []const u8) !void {
        const value = std.mem.trim(u8, source, " \t\r\n");
        if (std.mem.indexOfScalar(u8, value, 0) != null) return error.InvalidCommand;
        e.command = Command.init(value) catch return error.InvalidCommand;
    }
    pub fn label(e: *const Entry) []const u8 {
        if (e.name.len > 0) return e.name.text();
        const provider = identify(e.text()) orelse return "Shell command";
        return switch (provider) {
            inline else => |known| comptime known.info().name ++ " command",
        };
    }
};

/// SHELL is inherited from the user's session; passwd covers app/launchd starts.
pub fn shell() []const u8 {
    if (os.env("SHELL")) |value| if (value.len > 0 and value[0] == '/') return value;
    if (os.c.getpwuid(os.c.getuid())) |user| {
        if (user.*.pw_shell) |value| {
            const path = std.mem.span(value);
            if (path.len > 0) return path;
        }
    }
    return "/bin/sh";
}

/// Interactive startup is essential for aliases/functions. Bash login shells do
/// not necessarily source .bashrc, so use -ic; zsh/fish also load their normal rc.
pub fn flags() []const u8 {
    return "-ic";
}

// A conservative label only. The actual shell owns expansions and execution,
// and process discovery identifies the real provider after aliases/functions run.
pub fn identify(source: []const u8) ?Provider {
    var tokens: Tokens = .{ .source = source };
    var buffer: [max_length]u8 = undefined;
    var word = tokens.next(&buffer) orelse return null;
    while (assignment(word)) word = tokens.next(&buffer) orelse return null;
    if (std.mem.eql(u8, std.fs.path.basename(word), "env")) {
        word = tokens.next(&buffer) orelse return null;
        while (true) {
            if (std.mem.eql(u8, word, "-u") or std.mem.eql(u8, word, "--unset")) {
                _ = tokens.next(&buffer) orelse return null;
            } else if (!assignment(word) and !std.mem.eql(u8, word, "-i") and !std.mem.eql(u8, word, "--ignore-environment") and !std.mem.eql(u8, word, "--")) break;
            word = tokens.next(&buffer) orelse return null;
        }
    }
    if (std.mem.eql(u8, word, "command") or std.mem.eql(u8, word, "exec")) word = tokens.next(&buffer) orelse return null;
    const base = std.fs.path.basename(word);
    if (std.mem.eql(u8, base, "bunx")) {
        word = tokens.next(&buffer) orelse return null;
        if (std.mem.eql(u8, word, "--bun")) word = tokens.next(&buffer) orelse return null;
    } else if (std.mem.eql(u8, base, "bun")) {
        word = tokens.next(&buffer) orelse return null;
        if (!std.mem.eql(u8, word, "x")) return null;
        word = tokens.next(&buffer) orelse return null;
    }
    for (Provider.all) |provider| {
        const package = provider.info().package;
        if (std.mem.startsWith(u8, word, package) and (word.len == package.len or word[package.len] == '@')) return provider;
    }
    return detection.identify(&.{word});
}
fn assignment(word: []const u8) bool {
    const end = std.mem.indexOfScalar(u8, word, '=') orelse return false;
    if (end == 0 or (!std.ascii.isAlphabetic(word[0]) and word[0] != '_')) return false;
    for (word[0..end]) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '_') return false;
    return true;
}
const Tokens = struct {
    source: []const u8,
    pos: usize = 0,
    fn next(t: *Tokens, buffer: []u8) ?[]const u8 {
        while (t.pos < t.source.len and std.ascii.isWhitespace(t.source[t.pos])) t.pos += 1;
        if (t.pos == t.source.len) return null;
        var quote: u8 = 0;
        var n: usize = 0;
        while (t.pos < t.source.len) {
            const ch = t.source[t.pos];
            if (quote == 0 and std.ascii.isWhitespace(ch)) break;
            t.pos += 1;
            if (ch == quote) {
                quote = 0;
                continue;
            }
            if (quote == 0 and (ch == '\'' or ch == '"')) {
                quote = ch;
                continue;
            }
            if (ch == '\\' and quote != '\'' and t.pos < t.source.len) {
                buffer[n] = t.source[t.pos];
                t.pos += 1;
            } else {
                if (quote == 0 and std.mem.indexOfScalar(u8, ";|&<>()$`", ch) != null) return null;
                buffer[n] = ch;
            }
            n += 1;
            if (n == buffer.len) return null;
        }
        return if (quote == 0) buffer[0..n] else null;
    }
};

test "command labels skip inline assignments and wrappers without changing source" {
    for ([_][]const u8{ "FOO=123 claude code --whatever", "FOO='two words' BAR=3 /opt/bin/claude --model sonnet", "env -u OLD FOO=123 claude", "bunx @anthropic-ai/claude-code@latest" }) |source| {
        var entry: Entry = .{};
        try entry.set(source);
        try std.testing.expectEqualStrings(source, entry.text());
        try std.testing.expectEqual(@as(?Provider, .claude), identify(source));
    }
    try std.testing.expectEqual(@as(?Provider, .codex), identify("KEY=abc bun x @openai/codex"));
    try std.testing.expectEqual(@as(?Provider, null), identify("my-agent --fast"));
    try std.testing.expectEqual(@as(?Provider, null), identify("echo claude"));
}

/// Resolve simple shell aliases/wrapper functions only while adding/editing.
/// Introspection never invokes the supplied command or the function body.
pub fn resolve(source: []const u8, cwd: ?[]const u8, allocator: std.mem.Allocator) ![]u8 {
    var current = try allocator.dupe(u8, source);
    errdefer allocator.free(current);
    var expanded = false;
    var previous: [max_length]u8 = undefined;
    var previous_len: usize = 0;
    const deadline = std.time.milliTimestamp() + 2000;
    for (0..8) |_| {
        var tokens: Tokens = .{ .source = current };
        var buffer: [max_length]u8 = undefined;
        var start: usize = 0;
        var word = tokens.next(&buffer) orelse return current;
        while (assignment(word)) {
            start = tokens.pos;
            while (start < current.len and std.ascii.isWhitespace(current[start])) start += 1;
            word = tokens.next(&buffer) orelse return current;
        }
        // Already frozen, explicit executable paths, and compound shell syntax
        // remain literal. Aliases are command-position names, not arguments.
        if (std.mem.eql(u8, word, "command") or std.mem.indexOfScalar(u8, word, '/') != null) {
            if (expanded and !std.mem.eql(u8, word, "command")) {
                const frozen = try std.fmt.allocPrint(allocator, "{s}command {s}", .{ current[0..start], current[start..] });
                allocator.free(current);
                current = frozen;
            }
            return current;
        }
        for (word) |ch| if (!std.ascii.isAlphanumeric(ch) and ch != '_' and ch != '-') return error.UnsupportedShorthand;
        if (expanded and std.mem.eql(u8, word, previous[0..previous_len])) {
            const frozen = try std.fmt.allocPrint(allocator, "{s}command {s}", .{ current[0..start], current[start..] });
            allocator.free(current);
            return frozen;
        }
        previous_len = word.len;
        @memcpy(previous[0..word.len], word);
        const definition = try definitionOf(word, cwd, deadline, allocator);
        defer allocator.free(definition);
        const replacement = try wrapperBody(definition, allocator);
        defer if (replacement) |body| allocator.free(body);
        if (replacement) |body| {
            const next = try std.fmt.allocPrint(allocator, "{s}{s}{s}", .{ current[0..start], body, current[tokens.pos..] });
            if (next.len > max_length) {
                allocator.free(next);
                return error.InvalidCommand;
            }
            allocator.free(current);
            current = next;
            expanded = true;
        } else {
            if (expanded) {
                const frozen = try std.fmt.allocPrint(allocator, "{s}command {s}", .{ current[0..start], current[start..] });
                allocator.free(current);
                current = frozen;
            }
            return current;
        }
    }
    return error.RecursiveShorthand;
}

fn definitionOf(name: []const u8, cwd: ?[]const u8, deadline: i64, allocator: std.mem.Allocator) ![]u8 {
    const chosen = shell();
    const base = std.fs.path.basename(chosen);
    const query = if (std.mem.eql(u8, base, "fish"))
        try std.fmt.allocPrint(allocator, "builtin functions -- '{s}'", .{name})
    else if (std.mem.eql(u8, base, "bash"))
        try std.fmt.allocPrint(allocator, "builtin alias -- '{s}' 2>/dev/null || builtin declare -f -- '{s}'", .{ name, name })
    else if (std.mem.eql(u8, base, "zsh"))
        try std.fmt.allocPrint(allocator, "builtin alias -- '{s}' 2>/dev/null || builtin functions -- '{s}'", .{ name, name })
    else
        return allocator.dupe(u8, "");
    defer allocator.free(query);
    const script = try std.fmt.allocPrint(allocator, "printf '\\036CORGI_BEGIN\\n'; {s} 2>/dev/null; printf '\\036CORGI_END\\n'", .{query});
    defer allocator.free(script);
    var child = std.process.Child.init(&.{ chosen, flags(), script }, allocator);
    child.cwd = cwd;
    child.stdin_behavior = .Ignore;
    child.stdout_behavior = .Pipe;
    child.stderr_behavior = .Ignore;
    child.pgid = 0;
    try child.spawn();
    var reaped = false;
    defer {
        if (!reaped) {
            _ = os.c.kill(-child.id, os.c.SIGKILL);
            var status: c_int = 0;
            _ = os.c.waitpid(child.id, &status, 0);
        }
        if (child.stdout) |file| file.close();
    }
    try child.waitForSpawn();
    os.nonblock(child.stdout.?.handle);
    var output: [16384]u8 = undefined;
    var len: usize = 0;
    while (std.time.milliTimestamp() < deadline) {
        if (len == output.len) return error.ShorthandOutputTooLarge;
        const n = os.c.read(child.stdout.?.handle, output[len..].ptr, output.len - len);
        if (n > 0) len += @intCast(n);
        var status: c_int = 0;
        if (os.c.waitpid(child.id, &status, os.c.WNOHANG) == child.id) {
            reaped = true;
            const tail = os.c.read(child.stdout.?.handle, output[len..].ptr, output.len - len);
            if (tail > 0) len += @intCast(tail);
            const begin = (std.mem.indexOf(u8, output[0..len], "\x1eCORGI_BEGIN\n") orelse return error.ShorthandLookupFailed) + "\x1eCORGI_BEGIN\n".len;
            const end = std.mem.indexOfPos(u8, output[0..len], begin, "\x1eCORGI_END\n") orelse return error.ShorthandLookupFailed;
            return allocator.dupe(u8, std.mem.trim(u8, output[begin..end], " \r\n\t"));
        }
        std.Thread.sleep(5 * std.time.ns_per_ms);
    }
    return error.ShorthandLookupTimeout;
}

fn wrapperBody(definition: []const u8, allocator: std.mem.Allocator) !?[]u8 {
    if (definition.len == 0) return null;
    // Bash/zsh aliases quote the complete expansion after '='.
    if (std.mem.indexOfScalar(u8, definition, '=') != null and std.mem.indexOfScalar(u8, definition, '\n') == null and !std.mem.startsWith(u8, definition, "function ")) {
        const equal = std.mem.indexOfScalar(u8, definition, '=') orelse return error.UnsupportedShorthand;
        var tokens: Tokens = .{ .source = definition[equal + 1 ..] };
        var buffer: [max_length]u8 = undefined;
        return try allocator.dupe(u8, tokens.next(&buffer) orelse return error.UnsupportedShorthand);
    }
    // Fish aliases are functions. Read the actual body, not --wraps metadata:
    // fish may retain stale --wraps values when an alias is redefined.
    var lines = std.mem.splitScalar(u8, definition, '\n');
    var body: ?[]const u8 = null;
    var header = false;
    while (lines.next()) |raw| {
        const line = std.mem.trim(u8, raw, " \t\r");
        if (line.len == 0 or line[0] == '#') continue;
        if (!header) {
            if (!std.mem.startsWith(u8, line, "function ") and std.mem.indexOf(u8, line, "()") == null) return error.UnsupportedShorthand;
            header = true;
            continue;
        }
        if (std.mem.eql(u8, line, "end") or std.mem.eql(u8, line, "{") or std.mem.eql(u8, line, "}")) continue;
        if (body != null) return error.ComplexShellFunction;
        body = line;
    }
    var result = body orelse return error.ComplexShellFunction;
    result = std.mem.trimEnd(u8, result, " \t;");
    const suffix: []const u8 = if (std.mem.endsWith(u8, result, "$argv")) "$argv" else if (std.mem.endsWith(u8, result, "\"$@\"")) "\"$@\"" else return error.ComplexShellFunction;
    result = std.mem.trimEnd(u8, result[0 .. result.len - suffix.len], " \t");
    if (std.mem.indexOfAny(u8, result, ";\n|&<>()$`") != null) return error.ComplexShellFunction;
    return try allocator.dupe(u8, result);
}

pub const Resolution = struct {
    semantics: Semantics = .{},
    pending: bool = true,
    command: Entry = .{},
    error_message: Text = .{},
};
pub const Worker = struct {
    const Job = struct {
        id: u64,
        source: Entry,
        cwd: Path,
        result: Resolution = .{},
        queued: bool = true,
    };
    mutex: std.Thread.Mutex = .{},
    wake: std.Thread.Condition = .{},
    stopping: bool = false,
    thread: ?std.Thread = null,
    jobs: [8]?Job = @splat(null),
    next: usize = 0,
    pub fn start() !*Worker {
        const w = try os.allocator.create(Worker);
        errdefer os.allocator.destroy(w);
        w.* = .{};
        w.thread = try std.Thread.spawn(.{}, run, .{w});
        return w;
    }
    pub fn stop(w: *Worker) void {
        w.mutex.lock();
        w.stopping = true;
        w.wake.signal();
        w.mutex.unlock();
        w.thread.?.join();
        os.allocator.destroy(w);
    }
    pub fn request(w: *Worker, id: u64, source: []const u8, cwd: []const u8) !Resolution {
        const dir = Path.init(cwd) catch return error.InvalidDirectory;
        w.mutex.lock();
        defer w.mutex.unlock();
        for (w.jobs) |entry| if (entry) |job| {
            if (job.id == id and std.mem.eql(u8, job.source.text(), source) and std.mem.eql(u8, job.cwd.text(), cwd)) return job.result;
        };
        var job: Job = .{ .id = id, .source = .{}, .cwd = dir };
        try job.source.set(source);
        w.jobs[w.next] = job;
        w.next = (w.next + 1) % w.jobs.len;
        w.wake.signal();
        return .{};
    }
    fn run(w: *Worker) void {
        while (true) {
            w.mutex.lock();
            if (w.stopping) {
                w.mutex.unlock();
                return;
            }
            const index = for (w.jobs, 0..) |entry, i| {
                if (entry != null and entry.?.queued) break i;
            } else {
                w.wake.wait(&w.mutex);
                w.mutex.unlock();
                continue;
            };
            const job = w.jobs[index].?;
            w.jobs[index].?.queued = false;
            w.mutex.unlock();
            var result: Resolution = .{ .pending = false };
            if (resolve(job.source.text(), job.cwd.text(), os.allocator)) |source| {
                defer os.allocator.free(source);
                result.command.set(source) catch |err| {
                    result.error_message = .ascii(@errorName(err));
                };
                result.semantics = analyze(source, job.cwd.text());
            } else |err| result.error_message = .ascii(@errorName(err));
            w.mutex.lock();
            if (w.jobs[index]) |*current| {
                const matches = current.id == job.id and
                    std.mem.eql(u8, current.source.text(), job.source.text()) and
                    std.mem.eql(u8, current.cwd.text(), job.cwd.text());
                if (matches) current.result = result;
            }
            w.mutex.unlock();
        }
    }
};

pub const Semantics = struct {
    provider: ?Provider = null,
    suggested_name: Text = .{},
    model: Text = .{},
    account: Text = .{},
    mode: Text = .{},
    /// Skips the provider's permission checks; `mode` is its display text.
    yolo: bool = false,
    default_account: bool = false,
};

/// Only public identity metadata leaves this analysis. Explicit auth/profile
/// overrides must never inherit the default account's email from the picker.
pub fn analyze(source: []const u8, cwd: []const u8) Semantics {
    var info: Semantics = .{ .provider = identify(source) };
    info.default_account = info.provider != null;
    const facts = if (info.provider) |provider| provider.info() else null;
    var tokens: Tokens = .{ .source = source };
    var buffer: [max_length]u8 = undefined;
    var config: [max_length]u8 = undefined;
    var config_len: usize = 0;
    var home: [max_length]u8 = undefined;
    var home_len: usize = 0;
    var credential_override = false;
    var settings_override = false;
    var before_command = true;
    var next_model = false;
    var next_profile = false;
    var yolo = false;
    while (tokens.next(&buffer)) |word| {
        if (next_model) {
            info.model = .ascii(word);
            next_model = false;
            continue;
        }
        if (next_profile) {
            info.account = .ascii("Profile selected; identity unknown");
            next_profile = false;
            continue;
        }
        if (before_command and assignment(word)) {
            const equal = std.mem.indexOfScalar(u8, word, '=').?;
            const key = word[0..equal];
            const value = word[equal + 1 ..];
            if (std.mem.eql(u8, key, "HOME")) {
                home_len = value.len;
                @memcpy(home[0..home_len], value);
                info.default_account = false;
            } else if (facts) |known| {
                if (std.mem.eql(u8, key, known.config_env)) {
                    config_len = value.len;
                    @memcpy(config[0..config_len], value);
                    info.default_account = false;
                } else if (envMatches(key, known.credential_env)) {
                    credential_override = true;
                    info.default_account = false;
                    info.account = .ascii(if (value.len > 0) "API key - identity unavailable" else "Credential cleared - identity unknown");
                } else if (known.oauth_env != null and std.mem.eql(u8, key, known.oauth_env.?)) {
                    credential_override = true;
                    info.default_account = false;
                    info.account = .ascii("Explicit OAuth token - identity unknown");
                } else if (envMatches(key, known.endpoint_env)) {
                    settings_override = true;
                    info.default_account = false;
                    info.account = .ascii("External endpoint/provider - identity unknown");
                } else if (known.model_env != null and std.mem.eql(u8, key, known.model_env.?)) info.model = .ascii(value);
            }
            continue;
        }
        if (before_command and (std.mem.eql(u8, word, "command") or std.mem.eql(u8, word, "env"))) continue;
        if (before_command and word.len > 0 and word[0] == '-') {
            settings_override = true;
            info.default_account = false;
        }
        before_command = false;
        if (std.mem.eql(u8, word, "--model") or std.mem.eql(u8, word, "-m")) next_model = true;
        if (std.mem.startsWith(u8, word, "--model=")) info.model = .ascii(word[8..]);
        // Wrapper scripts may forward any agent's flag.
        for (Provider.all) |provider| {
            if ((info.provider == null or info.provider == provider) and std.mem.eql(u8, word, provider.info().yolo_flag)) yolo = true;
        }
        const known = facts orelse continue;
        const profile = option(word, known.profile_flags);
        const settings = option(word, known.settings_flags);
        if (profile != .none or settings != .none) {
            settings_override = true;
            info.default_account = false;
        }
        // A separate profile name follows; an inline one is opaque settings.
        if (profile == .separate) next_profile = true;
        if (profile == .inline_value or settings != .none) info.account = .ascii("Custom settings - identity unknown");
    }
    if (facts) |known| if (!info.default_account and !credential_override and !settings_override) {
        var root: ?[]u8 = null;
        if (config_len > 0 and std.mem.indexOfAny(u8, config[0..config_len], "$~`") == null) {
            root = std.fs.path.resolve(os.allocator, &.{ cwd, config[0..config_len] }) catch |err| blk: {
                log.warn("resolving config override path failed: {}", .{err});
                break :blk null;
            };
        } else if (home_len > 0 and std.mem.indexOfAny(u8, home[0..home_len], "$~`") == null) {
            root = std.fs.path.resolve(os.allocator, &.{ cwd, home[0..home_len], known.account_home }) catch |err| blk: {
                log.warn("resolving home override path failed: {}", .{err});
                break :blk null;
            };
        }
        defer if (root) |value| os.allocator.free(value);
        info.account = .ascii("Custom profile - identity unknown");
        if (root) |value| readIdentity(&info, value);
    };
    if (!info.default_account and info.account.len == 0) info.account = .ascii("Account cannot be determined");
    info.yolo = yolo;
    info.mode = .ascii(if (yolo) "Skips permission checks" else "Provider permission settings");
    var label: [160]u8 = undefined;
    const provider_name = if (info.provider) |provider| provider.info().label else "Custom agent";
    info.suggested_name = .ascii(std.fmt.bufPrint(&label, "{s}{s}{s}", .{ provider_name, if (info.model.len > 0) " - " else "", if (info.model.len > 0) info.model.text() else "" }) catch provider_name);
    return info;
}
/// Whether `word` is one of `flags`, either alone or as `--flag=value`.
fn option(word: []const u8, names: []const []const u8) enum { none, separate, inline_value } {
    for (names) |flag| {
        if (std.mem.eql(u8, word, flag)) return .separate;
        if (std.mem.startsWith(u8, word, flag) and word.len > flag.len and word[flag.len] == '=') return .inline_value;
    }
    return .none;
}
/// Exact names, or `PREFIX_*` patterns.
fn envMatches(key: []const u8, names: []const []const u8) bool {
    for (names) |name| {
        if (std.mem.endsWith(u8, name, "*")) {
            if (std.mem.startsWith(u8, key, name[0 .. name.len - 1])) return true;
        } else if (std.mem.eql(u8, key, name)) return true;
    }
    return false;
}
fn readIdentity(info: *Semantics, root: []const u8) void {
    const provider = info.provider orelse return;
    const path = std.fs.path.join(os.allocator, &.{ root, provider.info().account_file }) catch return;
    defer os.allocator.free(path);
    const fd = std.posix.open(path, .{ .ACCMODE = .RDONLY, .CLOEXEC = true, .NONBLOCK = true }, 0) catch return;
    const file: std.fs.File = .{ .handle = fd };
    defer file.close();
    const stat = file.stat() catch return;
    if (stat.kind != .file or stat.size > 65536) return;
    const bytes = file.readToEndAlloc(os.allocator, 65536) catch return;
    defer os.allocator.free(bytes);
    const json = std.json.parseFromSlice(std.json.Value, os.allocator, bytes, .{}) catch return;
    defer json.deinit();
    var email: []const u8 = "";
    var decoded: [16384]u8 = undefined;
    var jwt_json: ?std.json.Parsed(std.json.Value) = null;
    defer if (jwt_json) |parsed| parsed.deinit();
    switch (provider) {
        .claude => email = common.str(common.field(json.value, "oauthAccount"), "emailAddress"),
        .codex => {
            if (common.str(json.value, "OPENAI_API_KEY").len > 0) {
                info.account = .ascii("Profile API key - identity unavailable");
                return;
            }
            const token = common.str(common.field(json.value, "tokens"), "id_token");
            var parts = std.mem.splitScalar(u8, token, '.');
            _ = parts.next();
            const payload = parts.next() orelse return;
            const decoder = std.base64.url_safe_no_pad.Decoder;
            const size = decoder.calcSizeForSlice(payload) catch return;
            if (size > decoded.len) return;
            decoder.decode(decoded[0..size], payload) catch return;
            jwt_json = std.json.parseFromSlice(std.json.Value, os.allocator, decoded[0..size], .{}) catch return;
            email = common.str(jwt_json.?.value, "email");
        },
    }
    if (email.len > 0) {
        var text: [160]u8 = undefined;
        info.account = .ascii(std.fmt.bufPrint(&text, "{s} (cached)", .{email}) catch "Cached profile identity");
    }
}

test "command semantics distinguish default accounts from auth overrides" {
    const base = analyze("command claude --model sonnet --dangerously-skip-permissions", "/tmp");
    try std.testing.expect(base.default_account);
    try std.testing.expectEqualStrings("sonnet", base.model.text());
    try std.testing.expectEqualStrings("Skips permission checks", base.mode.text());
    const permission_only = analyze("claude --dangerously-skip-permissions", "/tmp");
    try std.testing.expectEqualStrings("Claude Code", permission_only.suggested_name.text());
    try std.testing.expectEqualStrings("Claude Code - sonnet", base.suggested_name.text());
    const api = analyze("ANTHROPIC_API_KEY=private-value claude", "/tmp");
    try std.testing.expect(!api.default_account);
    try std.testing.expectEqualStrings("API key - identity unavailable", api.account.text());
    try std.testing.expect(std.mem.indexOf(u8, api.account.text(), "private-value") == null);
    const profile = analyze("codex --profile work", "/tmp");
    try std.testing.expect(!profile.default_account);
    try std.testing.expectEqualStrings("Profile selected; identity unknown", profile.account.text());
    const unknown = analyze("CLAUDE_CONFIG_DIR=$WORK_PROFILE claude", "/tmp");
    try std.testing.expect(!unknown.default_account);
    try std.testing.expectEqualStrings("Account cannot be determined", unknown.account.text());
}

test "explicit Codex home uses only that profile's cached public identity" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = "auth.json", .data = "{\"tokens\":{\"id_token\":\"x.eyJlbWFpbCI6IndvcmtAZXhhbXBsZS5jb20ifQ.x\"}}" });
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const source = try std.fmt.allocPrint(std.testing.allocator, "CODEX_HOME='{s}' codex", .{root});
    defer std.testing.allocator.free(source);
    const info = analyze(source, "/tmp");
    try std.testing.expect(!info.default_account);
    try std.testing.expectEqualStrings("work@example.com (cached)", info.account.text());
}

test "Claude HOME override reads the home identity cache" {
    var tmp = std.testing.tmpDir(.{});
    defer tmp.cleanup();
    try tmp.dir.writeFile(.{ .sub_path = ".claude.json", .data = "{\"oauthAccount\":{\"emailAddress\":\"claude-work@example.com\"}}" });
    const root = try tmp.dir.realpathAlloc(std.testing.allocator, ".");
    defer std.testing.allocator.free(root);
    const source = try std.fmt.allocPrint(std.testing.allocator, "HOME='{s}' claude", .{root});
    defer std.testing.allocator.free(source);
    const info = analyze(source, "/tmp");
    try std.testing.expect(!info.default_account);
    try std.testing.expectEqualStrings("claude-work@example.com (cached)", info.account.text());
}
