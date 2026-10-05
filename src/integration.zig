const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const Provider = @import("providers.zig").Provider;
const agents = @import("agents.zig");
const detection = @import("detection.zig");
const discovery = @import("discovery.zig");
const protocol = @import("protocol.zig");
pub fn hook(provider: Provider, path: []const u8) !void {
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
    switch (provider) {
        // Codex tools/subagents inherit the pane environment. Their sessions
        // must not take ownership of the parent terminal's sidebar entry.
        .codex => if (os.env("CODEX_THREAD_ID")) |parent| {
            const session = agents.str(parsed.value, "session_id");
            if (parent.len > 0 and !std.mem.eql(u8, parent, session)) return;
        },
        .claude => {},
    }
    // Claude's background daemon inherits the environment of whichever pane
    // first spawned it, and so does a `claude -p` an agent runs from a tool.
    // CORGI_PANE identifies neither session's pane.
    const origin: detection.HookOrigin = switch (provider) {
        .claude => detection.hookOrigin(),
        .codex => .{},
    };
    const background = switch (provider) {
        .claude => std.mem.eql(u8, os.env("CLAUDE_CODE_SESSION_KIND") orelse "", "bg") or origin.background,
        .codex => false,
    };
    const fd = os.connect(path) catch return;
    defer _ = os.c.close(fd);
    try os.sendJson(fd, protocol.Envelope(.hook){ .payload = .{
        .provider = provider,
        .event = parsed.value,
        .pane = @enumFromInt(id),
        .seq = os.microTimestamp(),
        .background = background,
        .pid = origin.pid,
    } });
}
pub fn config(provider: Provider, executable: []const u8) ![]u8 {
    const command = try hookCommand(provider, executable);
    defer a.free(command);
    return configCommand(provider, command);
}
fn configCommand(provider: Provider, command: []const u8) ![]u8 {
    var hooks: std.json.ObjectMap = .empty;
    defer {
        var it = hooks.iterator();
        while (it.next()) |entry| {
            var groups = entry.value_ptr.array;
            var group = groups.items[0].object;
            var handlers = group.get("hooks").?.array;
            var handler = handlers.items[0].object;
            handler.deinit(a);
            handlers.deinit();
            group.deinit(a);
            groups.deinit();
        }
        hooks.deinit(a);
    }
    for (provider.backend().hookEvents()) |event| try addHook(&hooks, event, command);
    var root: std.json.ObjectMap = .empty;
    defer root.deinit(a);
    try root.put(a, "hooks", .{ .object = hooks });
    return std.json.Stringify.valueAlloc(a, std.json.Value{ .object = root }, .{ .whitespace = .indent_2 });
}
fn addHook(hooks: *std.json.ObjectMap, event: []const u8, command: []const u8) !void {
    var handler: std.json.ObjectMap = .empty;
    try handler.put(a, "type", .{ .string = "command" });
    try handler.put(a, "command", .{ .string = command });
    try handler.put(a, "timeout", .{ .integer = 2 });
    var handlers: std.array_list.Managed(std.json.Value) = .init(a);
    try handlers.append(.{ .object = handler });
    var group: std.json.ObjectMap = .empty;
    try group.put(a, "hooks", .{ .array = handlers });
    var groups: std.array_list.Managed(std.json.Value) = .init(a);
    try groups.append(.{ .object = group });
    try hooks.put(a, event, .{ .array = groups });
}
fn hookCommand(provider: Provider, executable: []const u8) ![]u8 {
    const quoted = try os.shellQuote(a, executable);
    defer a.free(quoted);
    return std.fmt.allocPrint(a, "{s} hook {t}", .{ quoted, provider });
}
// A stable definition survives moving/rebuilding Corgi and is a no-op in
// ordinary terminals. The pane sets CORGI_BIN to its actual executable.
fn installedCommand(provider: Provider) ![]u8 {
    return std.fmt.allocPrint(a, "if [ -n \"${{CORGI_PANE:-}}\" ] && [ -n \"${{CORGI_SOCKET:-}}\" ] && [ -x \"${{CORGI_BIN:-}}\" ]; then \"$CORGI_BIN\" hook {t}; fi", .{provider});
}

/// Merge into the existing provider JSON; never replace other hook handlers.
/// The arena owns both parsed data and appended entries until serialization.
pub fn mergedConfig(allocator: std.mem.Allocator, provider: Provider, existing: []const u8) !?[]u8 {
    var arena = std.heap.ArenaAllocator.init(allocator);
    defer arena.deinit();
    const mem = arena.allocator();
    const parsed = try std.json.parseFromSlice(std.json.Value, mem, existing, .{ .allocate = .alloc_always });
    var root = parsed.value;
    if (root != .object) return error.InvalidHookSettings;
    const entry = try root.object.getOrPut(mem, "hooks");
    if (!entry.found_existing) entry.value_ptr.* = .{ .object = .empty };
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
        const groups = try hooks.getOrPut(mem, event.key_ptr.*);
        if (!groups.found_existing) groups.value_ptr.* = .{ .array = .init(mem) };
        if (groups.value_ptr.* != .array) return error.InvalidHookSettings;
        var found = false;
        for (groups.value_ptr.array.items) |group| {
            if (group != .object) return error.InvalidHookSettings;
            const handlers = group.object.get("hooks") orelse return error.InvalidHookSettings;
            if (handlers != .array) return error.InvalidHookSettings;
            for (handlers.array.items) |handler| {
                if (std.mem.eql(u8, agents.str(handler, "command"), command)) found = true;
            }
        }
        if (found) continue;
        try groups.value_ptr.array.append(event.value_ptr.array.items[0]);
        changed = true;
    }
    if (!changed) return null;
    return try std.json.Stringify.valueAlloc(allocator, root, .{ .whitespace = .indent_2 });
}

pub fn install(provider: Provider) !void {
    const info = provider.info();
    const directory = info.configDir(a) catch |err| switch (err) {
        error.NoHome => return,
        error.OutOfMemory => |e| return e,
    };
    defer a.free(directory);
    var dir = std.Io.Dir.cwd().openDir(os.io(), directory, .{}) catch |err| {
        if (err == error.FileNotFound) return;
        return err;
    };
    defer dir.close(os.io());
    const lock = try dir.createFile(os.io(), ".corgi-hooks.lock", .{ .truncate = false, .permissions = .fromMode(0o600) });
    defer lock.close(os.io());
    if (!try lock.tryLock(os.io(), .exclusive)) return error.HookSettingsBusy;
    defer lock.unlock(os.io());
    const filename = info.hooks_file;
    // Don't replace a symlink, FIFO, or other user-managed indirection.
    const path = try std.fs.path.join(a, &.{ directory, filename });
    defer a.free(path);
    const stat = std.Io.Dir.cwd().statFile(os.io(), path, .{ .follow_symlinks = false }) catch null;
    const exists = stat != null;
    if (exists and stat.?.kind != .file) return error.HookSettingsNotRegular;
    const before = if (exists) try dir.readFileAlloc(os.io(), filename, a, .limited(1024 * 1024)) else try a.dupe(u8, "{}");
    defer a.free(before);
    const after = try mergedConfig(a, provider, before) orelse return;
    defer a.free(after);
    if (exists) {
        const backup_name = try std.fmt.allocPrint(a, "{s}.corgi-backup", .{filename});
        defer a.free(backup_name);
        if (dir.createFile(os.io(), backup_name, .{ .exclusive = true, .permissions = .fromMode(0o600) })) |backup| {
            defer backup.close(os.io());
            try backup.writeStreamingAll(os.io(), before);
        } else |err| if (err != error.PathAlreadyExists) return err;
    }
    var buffer: [4096]u8 = undefined;
    var output = try dir.createFileAtomic(os.io(), filename, .{ .permissions = if (exists) stat.?.permissions else .fromMode(0o600), .replace = true });
    defer output.deinit(os.io());
    var writer = output.file.writer(os.io(), &buffer);
    try writer.interface.writeAll(after);
    try writer.interface.writeAll("\n");
    try writer.interface.flush();
    // Catch concurrent edits by tools which don't use our installation lock.
    if (exists) {
        const latest = try dir.readFileAlloc(os.io(), filename, a, .limited(1024 * 1024));
        defer a.free(latest);
        if (!std.mem.eql(u8, latest, before)) return error.HookSettingsChanged;
    } else {
        if (std.Io.Dir.cwd().statFile(os.io(), path, .{ .follow_symlinks = false })) |_| return error.HookSettingsChanged else |_| {}
    }
    try output.replace(os.io());
}
pub fn launch(provider: Provider, args: []const []const u8, executable: []const u8) !noreturn {
    _ = executable;
    if (os.env("CORGI_PANE") == null) return error.LaunchInsideCorgi;
    var argv: std.ArrayList([]const u8) = .empty;
    const binary = try discovery.resolve(provider, null);
    defer a.free(binary);
    try argv.append(a, binary);
    try argv.appendSlice(a, args);
    return os.exec(argv.items);
}
