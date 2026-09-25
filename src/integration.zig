const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const providers = @import("providers.zig");
pub fn hook(provider: []const u8, path: []const u8) !void {
    const pane = os.env("CORGI_PANE") orelse return;
    const id = std.fmt.parseInt(u32, pane, 10) catch return;
    var input: std.ArrayList(u8) = .empty;
    defer input.deinit(a);
    var buf: [8192]u8 = undefined;
    while (input.items.len < 1024 * 1024) {
        const n = os.c.read(0, &buf, buf.len);
        if (n <= 0) break;
        try input.appendSlice(a, buf[0..@intCast(n)]);
    }
    const parsed = std.json.parseFromSlice(std.json.Value, a, input.items, .{}) catch return;
    defer parsed.deinit();
    if (std.mem.eql(u8, provider, "codex")) {
        // Codex tools/subagents inherit the pane environment. Their sessions
        // must not take ownership of the parent terminal's sidebar entry.
        if (os.env("CODEX_THREAD_ID")) |parent| {
            const session = @import("agents.zig").str(parsed.value, "session_id");
            if (parent.len > 0 and !std.mem.eql(u8, parent, session)) return;
        }
    }
    // Claude's background daemon inherits the environment of whichever pane
    // first spawned it, so CORGI_PANE does not identify its sessions' pane.
    const background = std.mem.eql(u8, provider, "claude") and std.mem.eql(u8, os.env("CLAUDE_CODE_SESSION_KIND") orelse "", "bg");
    const fd = os.connect(path) catch return;
    defer _ = os.c.close(fd);
    try os.sendJson(fd, .{ .op = "hook", .provider = provider, .pane = id, .event = parsed.value, .seq = std.time.microTimestamp(), .background = background });
}
pub fn config(provider: []const u8, executable: []const u8) ![]u8 {
    const command = try hookCommand(provider, executable);
    defer a.free(command);
    return configCommand(provider, command);
}
fn configCommand(provider: []const u8, command: []const u8) ![]u8 {
    var hooks: std.json.ObjectMap = .init(a);
    defer {
        var it = hooks.iterator();
        while (it.next()) |entry| {
            var groups = entry.value_ptr.array;
            var group = groups.items[0].object;
            var handlers = group.get("hooks").?.array;
            var handler = handlers.items[0].object;
            handler.deinit();
            handlers.deinit();
            group.deinit();
            groups.deinit();
        }
        hooks.deinit();
    }
    const kind = std.meta.stringToEnum(providers.Provider, provider) orelse return error.BadProvider;
    for (try providers.Backend.init(kind).hookEvents()) |event| try addHook(&hooks, event, command);
    var root: std.json.ObjectMap = .init(a);
    defer root.deinit();
    try root.put("hooks", .{ .object = hooks });
    return std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{ .whitespace = .indent_2 });
}
fn addHook(hooks: *std.json.ObjectMap, event: []const u8, command: []const u8) !void {
    var handler: std.json.ObjectMap = .init(a);
    try handler.put("type", .{ .string = "command" });
    try handler.put("command", .{ .string = command });
    try handler.put("timeout", .{ .integer = 2 });
    var handlers: std.array_list.Managed(std.json.Value) = .init(a);
    try handlers.append(.{ .object = handler });
    var group: std.json.ObjectMap = .init(a);
    try group.put("hooks", .{ .array = handlers });
    var groups: std.array_list.Managed(std.json.Value) = .init(a);
    try groups.append(.{ .object = group });
    try hooks.put(event, .{ .array = groups });
}
fn hookCommand(provider: []const u8, executable: []const u8) ![]u8 {
    const quoted = try shellQuote(executable);
    defer a.free(quoted);
    return std.fmt.allocPrint(a, "{s} hook {s}", .{ quoted, provider });
}
// A stable definition survives moving/rebuilding Corgi and is a no-op in
// ordinary terminals. The pane sets CORGI_BIN to its actual executable.
fn installedCommand(provider: []const u8) ![]u8 {
    return std.fmt.allocPrint(a, "if [ -n \"${{CORGI_PANE:-}}\" ] && [ -n \"${{CORGI_SOCKET:-}}\" ] && [ -x \"${{CORGI_BIN:-}}\" ]; then \"$CORGI_BIN\" hook {s}; fi", .{provider});
}

/// Merge into the existing provider JSON; never replace other hook handlers.
/// The arena owns both parsed data and appended entries until serialization.
pub fn mergedConfig(allocator: std.mem.Allocator, provider: []const u8, existing: []const u8) !?[]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const mem = arena.allocator();
    const parsed = try std.json.parseFromSlice(std.json.Value, mem, existing, .{ .allocate = .alloc_always });
    var root = parsed.value;
    if (root != .object) return error.InvalidHookSettings;
    const entry = try root.object.getOrPut("hooks");
    if (!entry.found_existing) entry.value_ptr.* = .{ .object = .init(mem) };
    if (entry.value_ptr.* != .object) return error.InvalidHookSettings;
    const hooks = &entry.value_ptr.object;
    const command = try installedCommand(provider);
    defer a.free(command);
    const generated = try configCommand(provider, command);
    defer a.free(generated);
    const template = try std.json.parseFromSlice(std.json.Value, mem, generated, .{});
    var events = template.value.object.get("hooks").?.object.iterator();
    var changed = false;
    while (events.next()) |event| {
        const groups = try hooks.getOrPut(event.key_ptr.*);
        if (!groups.found_existing) groups.value_ptr.* = .{ .array = .init(mem) };
        if (groups.value_ptr.* != .array) return error.InvalidHookSettings;
        var found = false;
        for (groups.value_ptr.array.items) |group| {
            if (group != .object) return error.InvalidHookSettings;
            const handlers = group.object.get("hooks") orelse return error.InvalidHookSettings;
            if (handlers != .array) return error.InvalidHookSettings;
            for (handlers.array.items) |handler| {
                if (std.mem.eql(u8, @import("agents.zig").str(handler, "command"), command)) found = true;
            }
        }
        if (found) continue;
        try groups.value_ptr.array.append(event.value_ptr.array.items[0]);
        changed = true;
    }
    if (!changed) return null;
    return try std.json.Stringify.valueAlloc(allocator, root, .{ .whitespace = .indent_2 });
}

pub fn install(provider: []const u8) !void {
    const home_dir = os.env("HOME") orelse return;
    const override = os.env(if (std.mem.eql(u8, provider, "codex")) "CODEX_HOME" else "CLAUDE_CONFIG_DIR");
    const directory = if (override) |dir| try a.dupe(u8, dir) else try std.fs.path.join(a, &.{ home_dir, if (std.mem.eql(u8, provider, "codex")) ".codex" else ".claude" });
    defer a.free(directory);
    var dir = std.fs.cwd().openDir(directory, .{}) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    defer dir.close();
    const lock = try dir.createFile(".corgi-hooks.lock", .{ .truncate = false, .mode = 0o600 });
    defer lock.close();
    if (!try lock.tryLock(.exclusive)) return error.HookSettingsBusy;
    defer lock.unlock();
    const filename = if (std.mem.eql(u8, provider, "codex")) "hooks.json" else "settings.json";
    // Don't replace a symlink, FIFO, or other user-managed indirection.
    const path = try std.fs.path.join(a, &.{ directory, filename });
    defer a.free(path);
    const stat = std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch null;
    const exists = stat != null;
    if (exists and (stat.?.mode & os.c.S_IFMT) != os.c.S_IFREG) return error.HookSettingsNotRegular;
    const before = if (exists) try dir.readFileAlloc(a, filename, 1024 * 1024) else try a.dupe(u8, "{}");
    defer a.free(before);
    const after = try mergedConfig(a, provider, before) orelse return;
    defer a.free(after);
    if (exists) {
        const backup_name = try std.fmt.allocPrint(a, "{s}.corgi-backup", .{filename});
        defer a.free(backup_name);
        if (dir.createFile(backup_name, .{ .exclusive = true, .mode = 0o600 })) |backup| {
            defer backup.close();
            try backup.writeAll(before);
        } else |err| if (err != error.PathAlreadyExists) return err;
    }
    var buffer: [4096]u8 = undefined;
    var output = try dir.atomicFile(filename, .{ .mode = if (exists) @intCast(stat.?.mode & 0o777) else 0o600, .write_buffer = &buffer });
    defer output.deinit();
    try output.file_writer.interface.writeAll(after);
    try output.file_writer.interface.writeAll("\n");
    // Catch concurrent edits by tools which don't use our installation lock.
    if (exists) {
        const latest = try dir.readFileAlloc(a, filename, 1024 * 1024);
        defer a.free(latest);
        if (!std.mem.eql(u8, latest, before)) return error.HookSettingsChanged;
    } else {
        if ((std.posix.fstatat(std.posix.AT.FDCWD, path, std.posix.AT.SYMLINK_NOFOLLOW) catch null) != null) return error.HookSettingsChanged;
    }
    try output.finish();
}
pub fn shellQuote(text: []const u8) ![]u8 {
    var out: std.ArrayList(u8) = .empty;
    try out.append(a, '\'');
    for (text) |ch| if (ch == '\'') try out.appendSlice(a, "'\\''") else try out.append(a, ch);
    try out.append(a, '\'');
    return out.toOwnedSlice(a);
}
pub fn launch(provider: []const u8, args: []const []const u8, executable: []const u8) !noreturn {
    _ = executable;
    if (os.env("CORGI_PANE") == null) return error.LaunchInsideCorgi;
    var argv: std.ArrayList([]const u8) = .empty;
    const provider_kind = std.meta.stringToEnum(@import("agents.zig").Provider, provider) orelse return error.BadProvider;
    const binary = try @import("discovery.zig").resolve(provider_kind, null);
    defer a.free(binary);
    try argv.append(a, binary);
    try argv.appendSlice(a, args);
    return os.exec(argv.items);
}
test "shell quoting protects binary paths containing shell syntax" {
    const result = try shellQuote("/tmp/a'b$(echo bad)/corgi");
    defer a.free(result);
    try std.testing.expectEqualStrings("'/tmp/a'\\''b$(echo bad)/corgi'", result);
}
