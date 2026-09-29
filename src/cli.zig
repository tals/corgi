//! Agent CLI: parse command payloads directly, then send one request.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const layout = @import("layout.zig");
const WorkspaceId = @import("workspace.zig").Workspace.Id;
const Store = @import("workspace.zig").Store;
const protocol = @import("protocol.zig");
const keys = @import("keys.zig");
const rpc = @import("rpc.zig");
const agents = @import("agents.zig");

const Group = enum {
    tab,
    pane,
    workspace,
    current,
    list,
    focus,
    @"--skill",
    fn nested(g: Group) bool {
        return g == .tab or g == .pane or g == .workspace;
    }
};
const Action = enum {
    list,
    current,
    focus,
    @"tab.new",
    @"tab.rename",
    @"tab.move",
    @"tab.merge",
    @"tab.close",
    @"pane.split",
    @"pane.move",
    @"pane.swap",
    @"pane.resize",
    @"pane.close",
    @"pane.read",
    @"pane.send",
    @"pane.keys",
    @"workspace.new",
    @"workspace.edit",
    @"workspace.close",
    @"workspace.switch",
};
pub const help =
    \\Agent controls (JSON by default; --text for readable output):
    \\  corgi list [--text]                 layout, panes, agents, viewers
    \\  corgi workspace list|new NAME [--cwd DIR]
    \\  corgi workspace edit ID [--name NAME|--clear] [--cwd DIR]
    \\  corgi workspace close ID          requires an empty workspace
    \\  corgi workspace switch ID [--viewer ID]
    \\  corgi current                      calling pane's live location
    \\  corgi tab new [--name NAME] [--cwd DIR] [--workspace ID]
    \\  corgi tab rename ID|current NAME|--clear
    \\  corgi tab move ID|current --before ID|--after ID|--workspace ID
    \\  corgi tab merge ID|current --right-of ID|--left-of ID|--above ID|--below ID
    \\  corgi tab close ID|current
    \\  corgi pane split ID|current --right|--left|--up|--down [--cwd DIR]
    \\  corgi pane move ID|current --right-of ID|--left-of ID|--above ID|--below ID
    \\  corgi pane move ID|current --new-tab [--name NAME]
    \\  corgi pane swap ID|current ID
    \\  corgi pane resize ID|current --width PERCENT|--height PERCENT (10%-90%)
    \\  corgi pane close ID|current
    \\  corgi pane read ID|current [--lines N] [--text]
    \\  corgi pane send ID|current TEXT|--stdin [--enter]
    \\  corgi pane keys ID|current KEY...    enter, esc, ctrl+c, arrows, etc.
    \\  corgi focus ID|current --viewer ID  select in exactly one viewer
    \\  corgi --skill                      print bundled agent instructions
    \\
    \\Tab new and pane split accept --command SHELL_COMMAND.
    \\IDs come from list; current means CORGI_PANE, never UI focus.
    \\New tabs outside Corgi require --workspace. Operations never auto-start a server.
    \\Layout changes preserve processes and do not select another pane in a viewer.
    \\
    \\Control Corgi panes, agents, or workspaces:
    \\  SKIP if a Corgi skill is already in your context. Otherwise run: corgi --skill
    \\
    \\
;

pub fn handles(args: []const [:0]u8) bool {
    if (args.len < 2) return false;
    return std.meta.stringToEnum(Group, args[1]) != null;
}

pub fn run(path: []const u8, args: []const [:0]u8) !void {
    const group = std.meta.stringToEnum(Group, args[1]).?;
    if (group == .@"--skill") {
        if (args.len != 2) return error.Usage;
        return os.writeAll(1, @embedFile("corgi-skill.md"));
    }
    if (group.nested() and args.len == 2) return os.writeAll(1, help);
    for (args[2..]) |arg| if (std.mem.eql(u8, arg, "--help") or std.mem.eql(u8, arg, "-h")) return os.writeAll(1, help);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const mem = arena.allocator();
    const caller = if (os.env("CORGI_PANE")) |value| std.fmt.parseInt(u32, value, 10) catch 0 else 0;
    var invocation = try parse(mem, args[1..], caller);
    const action = invocation.action;
    const target = invocation.target;

    const fd = try os.connect(path);
    defer _ = os.c.close(fd);
    if ((invocation.current and group == .tab) or (action == .@"tab.new" and caller != 0)) {
        const located = try call(fd, .@"session.locate", .{ .pane = @enumFromInt(caller) });
        defer located.deinit();
        const reply = try std.json.parseFromValueLeaky(protocol.Reply(.@"session.locate"), mem, located.value, .{ .ignore_unknown_fields = true });
        const tab = reply.result.tab;
        const workspace = reply.result.workspace;
        switch (invocation.command.?) {
            .@"tab.rename" => |*q| q.target = tab,
            .@"tab.move" => |*q| q.target = tab,
            .@"tab.merge" => |*q| q.target = tab,
            .@"tab.close" => |*q| q.target = tab,
            .@"pane.create" => |*q| {
                if (q.workspace == WorkspaceId.none) q.workspace = workspace;
                if (q.workspace == workspace) q.from = @enumFromInt(caller);
            },
            else => unreachable,
        }
    }
    const response = if (invocation.command) |cmd|
        try call(fd, .@"session.command", .{ .command = cmd })
    else if (action == .list)
        try call(fd, .@"session.list", {})
    else if (action == .current)
        try call(fd, .@"session.locate", .{ .pane = @enumFromInt(caller) })
    else if (action == .@"workspace.switch")
        try call(fd, .@"workspace.switch", .{ .workspace = @enumFromInt(target), .viewer = invocation.viewer })
    else
        try call(fd, .focus, .{ .pane = @enumFromInt(target), .viewer = invocation.viewer });
    defer response.deinit();
    if (invocation.text_mode) {
        if (response.value.object.get("result")) |result| if (result.object.get("text")) |text| if (text == .string) return os.writeAll(1, text.string);
    }
    const output = try std.json.Stringify.valueAlloc(mem, response.value, .{ .whitespace = if (invocation.text_mode) .indent_2 else .minified });
    try os.writeAll(1, output);
    try os.writeAll(1, "\n");
}

/// A command line checked and parsed before anything connects to the daemon.
const Invocation = struct {
    action: Action,
    target: u32 = 0,
    current: bool = false,
    text_mode: bool = false,
    viewer: ?u32 = null,
    command: ?protocol.Command = null,
};

/// `words` starts at the group (`pane`, `list`, ...).
fn parse(mem: std.mem.Allocator, words: []const [:0]const u8, caller: u32) !Invocation {
    const group = std.meta.stringToEnum(Group, words[0]) orelse return error.Usage;
    if (group.nested() and words.len == 1) return error.Usage;
    const raw_action = if (group.nested()) try std.fmt.allocPrint(mem, "{s}.{s}", .{ words[0], words[1] }) else words[0];
    const mapped_action = if (std.mem.eql(u8, raw_action, "workspace.list")) "list" else raw_action;
    const action = std.meta.stringToEnum(Action, mapped_action);
    var start: usize = if (group.nested()) 2 else 1;
    var current = false;
    var target: u32 = 0;
    if (action != .list and action != .current and action != .@"tab.new" and action != .@"workspace.new") {
        if (start == words.len) return error.Usage;
        current = std.mem.eql(u8, words[start], "current");
        if (current and group == .workspace) return error.Usage;
        target = if (current) caller else try id(words[start]);
        if (current and caller == 0) return error.NoCallerPane;
        start += 1;
    }
    var parsed = try Args.parse(mem, words[start..]);
    const text_mode = parsed.flag(.text);
    const viewer = if (action == .focus)
        try id(try parsed.required(.viewer))
    else if (action == .@"workspace.switch")
        if (parsed.option(.viewer)) |value| try id(value) else @as(?u32, null)
    else
        null;
    const command: ?protocol.Command = switch (action orelse return error.Usage) {
        .list, .current, .focus, .@"workspace.switch" => null,
        else => |value| try parseCommand(value, target, &parsed),
    };
    try parsed.end();
    if (action == .current and caller == 0) return error.NoCallerPane;
    if (command) |cmd| if (cmd == .@"pane.create" and cmd.@"pane.create".workspace == WorkspaceId.none and caller == 0) return error.MissingWorkspace;
    return .{ .action = action.?, .target = target, .current = current, .text_mode = text_mode, .viewer = viewer, .command = command };
}

fn parseCommand(action: Action, target: u32, args: *Args) !protocol.Command {
    return switch (action) {
        .@"tab.new" => .{ .@"pane.create" = .{
            .workspace = if (args.option(.workspace)) |value| @enumFromInt(try id(value)) else .none,
            .title = args.option(.name) orelse "",
            .cwd = try args.cwd(),
            .command = args.option(.command),
        } },
        .@"workspace.new" => .{ .@"workspace.create" = .{
            .name = try args.next(),
            .cwd = try args.directory(args.option(.cwd) orelse "."),
        } },
        .@"workspace.close" => .{ .@"workspace.close" = .{ .target = @enumFromInt(target) } },
        .@"workspace.edit" => .{ .@"workspace.edit" = .{
            .target = @enumFromInt(target),
            .name = if (args.flag(.clear)) "" else args.option(.name),
            .cwd = if (args.option(.cwd)) |value| try args.directory(value) else null,
        } },
        .@"tab.rename" => .{ .@"tab.rename" = .{ .target = @enumFromInt(target), .name = if (args.flag(.clear)) "" else try args.next() } },
        .@"tab.close" => .{ .@"tab.close" = .{ .target = @enumFromInt(target) } },
        .@"pane.close" => .{ .@"pane.close" = .{ .target = @enumFromInt(target) } },
        .@"pane.swap" => .{ .@"pane.swap" = .{ .target = @enumFromInt(target), .other = @enumFromInt(try id(try args.next())) } },
        .@"pane.split" => .{ .@"pane.split" = .{
            .target = @enumFromInt(target),
            .direction = try args.direction(),
            .cwd = try args.cwd(),
            .command = args.option(.command),
        } },
        .@"tab.merge" => blk: {
            const beside = try args.beside();
            break :blk .{ .@"tab.merge" = .{ .target = @enumFromInt(target), .other = beside.other, .direction = beside.direction } };
        },
        .@"tab.move" => .{ .@"tab.move" = .{
            .target = @enumFromInt(target),
            .destination = if (args.option(.before)) |value|
                .{ .before = @enumFromInt(try id(value)) }
            else if (args.option(.after)) |value|
                .{ .after = @enumFromInt(try id(value)) }
            else
                .{ .workspace = @enumFromInt(try id(try args.required(.workspace))) },
        } },
        .@"pane.move" => .{ .@"pane.move" = .{
            .target = @enumFromInt(target),
            .destination = if (args.flag(.@"new-tab"))
                .{ .new_tab = args.option(.name) orelse "" }
            else
                .{ .beside = try args.beside() },
        } },
        .@"pane.resize" => blk: {
            const width = args.option(.width);
            const value = width orelse try args.required(.height);
            if (!std.mem.endsWith(u8, value, "%")) return error.Usage;
            const percent = try std.fmt.parseInt(u16, value[0 .. value.len - 1], 10);
            if (percent < 10 or percent > 90) return error.Usage;
            break :blk .{ .@"pane.resize" = .{
                .target = @enumFromInt(target),
                .axis = if (width != null) .horizontal else .vertical,
                .ratio = percent * 10,
            } };
        },
        .@"pane.read" => blk: {
            const lines = if (args.option(.lines)) |value| try std.fmt.parseInt(usize, value, 10) else 100;
            if (lines == 0 or lines > 10000) return error.Usage;
            break :blk .{ .@"pane.read" = .{ .target = @enumFromInt(target), .lines = lines } };
        },
        .@"pane.send" => .{ .@"pane.send" = .{
            .target = @enumFromInt(target),
            .text = if (args.flag(.stdin)) try std.fs.File.stdin().readToEndAlloc(args.mem, 1024 * 1024) else try args.next(),
            .enter = args.flag(.enter),
        } },
        .@"pane.keys" => blk: {
            if (args.positional.items.len == 0) return error.Usage;
            for (args.positional.items) |key| _ = try keys.logicalKey(key);
            const text = try std.mem.join(args.mem, " ", args.positional.items);
            args.positional.clearRetainingCapacity();
            break :blk .{ .@"pane.keys" = .{ .target = @enumFromInt(target), .text = text } };
        },
        else => error.Usage,
    };
}

/// Every `--name` a command accepts. Flags take no value.
const Opt = enum {
    text,
    clear,
    stdin,
    enter,
    @"new-tab",
    left,
    right,
    up,
    down,
    viewer,
    workspace,
    name,
    command,
    cwd,
    before,
    after,
    width,
    height,
    lines,
    @"left-of",
    @"right-of",
    above,
    below,

    fn isFlag(opt: Opt) bool {
        return switch (opt) {
            .text, .clear, .stdin, .enter, .@"new-tab", .left, .right, .up, .down => true,
            else => false,
        };
    }
};

/// Command-line syntax only. Each operation consumes its own accepted options.
const Args = struct {
    mem: std.mem.Allocator,
    /// A flag's value is empty.
    options: std.EnumMap(Opt, []const u8) = .{},
    positional: std.ArrayList([]const u8) = .empty,
    fn parse(mem: std.mem.Allocator, values: []const [:0]const u8) !Args {
        var result: Args = .{ .mem = mem };
        var literal = false;
        var i: usize = 0;
        while (i < values.len) : (i += 1) {
            const arg = values[i];
            if (!literal and std.mem.eql(u8, arg, "--")) {
                literal = true;
            } else if (!literal and std.mem.startsWith(u8, arg, "--")) {
                const opt = std.meta.stringToEnum(Opt, arg[2..]) orelse return error.Usage;
                if (result.options.contains(opt)) return error.Usage;
                result.options.put(opt, if (opt.isFlag()) "" else blk: {
                    i += 1;
                    if (i == values.len) return error.Usage;
                    break :blk values[i];
                });
            } else try result.positional.append(mem, arg);
        }
        return result;
    }
    fn flag(args: *Args, comptime opt: Opt) bool {
        if (comptime !opt.isFlag()) @compileError("--" ++ @tagName(opt) ++ " takes a value");
        return args.options.fetchRemove(opt) != null;
    }
    fn option(args: *Args, comptime opt: Opt) ?[]const u8 {
        if (comptime opt.isFlag()) @compileError("--" ++ @tagName(opt) ++ " is a flag");
        return args.options.fetchRemove(opt);
    }
    fn required(args: *Args, comptime opt: Opt) ![]const u8 {
        return args.option(opt) orelse error.Usage;
    }
    fn next(args: *Args) ![]const u8 {
        if (args.positional.items.len == 0) return error.Usage;
        return args.positional.orderedRemove(0);
    }
    fn end(args: *Args) !void {
        if (args.options.count() != 0 or args.positional.items.len != 0) return error.Usage;
    }
    fn cwd(args: *Args) ![]const u8 {
        const value = args.option(.cwd) orelse return "";
        return args.directory(value);
    }
    fn directory(args: *Args, value: []const u8) ![]const u8 {
        const resolved = try Store.directory(value);
        defer a.free(resolved);
        return args.mem.dupe(u8, resolved);
    }
    fn direction(args: *Args) !layout.Direction {
        const flags = [_]Opt{ .left, .right, .up, .down };
        const directions = [_]layout.Direction{ .left, .right, .up, .down };
        inline for (flags, directions) |opt, value| if (args.flag(opt)) return value;
        return error.Usage;
    }
    fn beside(args: *Args) !protocol.Beside {
        const flags = [_]Opt{ .@"left-of", .@"right-of", .above, .below };
        const directions = [_]layout.Direction{ .left, .right, .up, .down };
        inline for (flags, directions) |opt, value| if (args.option(opt)) |other| return .{ .other = @enumFromInt(try id(other)), .direction = value };
        return error.Usage;
    }
};

/// The daemon's reply as it sent it, which the CLI prints. An `err` reply
/// exits with the daemon's error name.
fn call(fd: c_int, comptime op: protocol.Op, payload: protocol.Payload(op)) !std.json.Parsed(std.json.Value) {
    var connection: rpc.Connection = .{ .fd = fd };
    const response = try connection.request(protocol.Envelope(op){ .payload = payload });
    errdefer response.deinit();
    const err = agents.str(response.value, "err");
    if (err.len > 0) try failure(err, 1);
    return response;
}
fn id(value: []const u8) !u32 {
    const result = try std.fmt.parseInt(u32, value, 10);
    if (result == 0) return error.Usage;
    return result;
}
pub fn failure(code: []const u8, status: u8) !void {
    const out = try std.json.Stringify.valueAlloc(a, .{ .ok = false, .err = code }, .{});
    defer a.free(out);
    try os.writeAll(2, out);
    try os.writeAll(2, "\n");
    std.process.exit(status);
}

test "command lines are rejected before connecting" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const Case = struct { words: []const [:0]const u8, caller: u32 = 0, err: anyerror = error.Usage };
    for ([_]Case{
        .{ .words = &.{ "pane", "split" } },
        .{ .words = &.{ "pane", "split", "0", "--right" } },
        .{ .words = &.{ "pane", "split", "x", "--right" }, .err = error.InvalidCharacter },
        .{ .words = &.{ "pane", "split", "current", "--right" }, .err = error.NoCallerPane },
        .{ .words = &.{ "pane", "split", "3" } },
        .{ .words = &.{ "pane", "split", "3", "--right", "--up" } },
        .{ .words = &.{ "pane", "split", "3", "--right", "--unknown" } },
        .{ .words = &.{ "pane", "split", "3", "--right", "--unknown", "value" } },
        .{ .words = &.{ "pane", "split", "3", "--right", "--right" } },
        .{ .words = &.{ "pane", "split", "3", "--righ" } },
        .{ .words = &.{ "tab", "new", "--workspace", "1", "--name" } },
        .{ .words = &.{ "pane", "move", "3" } },
        .{ .words = &.{ "pane", "move", "3", "--new-tab", "--below", "3" } },
        .{ .words = &.{ "pane", "move", "3", "--right-of", "0" } },
        .{ .words = &.{ "pane", "swap", "3" } },
        .{ .words = &.{ "pane", "resize", "3", "--width", "50%", "--height", "50%" } },
        .{ .words = &.{ "pane", "resize", "3", "--width", "50" } },
        .{ .words = &.{ "pane", "resize", "3", "--width", "95%" } },
        .{ .words = &.{ "pane", "close", "3", "--cwd", "/tmp" } },
        .{ .words = &.{ "pane", "read", "3", "--lines", "0" } },
        .{ .words = &.{ "pane", "send", "3" } },
        .{ .words = &.{ "pane", "keys", "3" } },
        .{ .words = &.{ "pane", "keys", "3", "enter", "invalid-key" }, .err = error.InvalidKey },
        .{ .words = &.{ "pane", "bogus", "3" } },
        .{ .words = &.{ "tab", "new" }, .err = error.MissingWorkspace },
        .{ .words = &.{ "tab", "new", "--workspace", "1", "--name", "one", "--name", "two" } },
        .{ .words = &.{ "tab", "rename", "4", "--clear", "oops" } },
        .{ .words = &.{ "tab", "move", "4", "--before", "6", "--workspace", "1" } },
        .{ .words = &.{ "tab", "merge", "4" } },
        .{ .words = &.{ "workspace", "edit", "2", "--name", "Oops", "--clear" } },
        .{ .words = &.{ "workspace", "close", "2", "--cwd", "/tmp" } },
        .{ .words = &.{ "workspace", "close", "current" }, .caller = 3 },
        .{ .words = &.{ "focus", "3" } },
        .{ .words = &.{"current"}, .err = error.NoCallerPane },
        .{ .words = &.{ "list", "extra" } },
        .{ .words = &.{ "list", "--text", "--text" } },
    }) |case| {
        errdefer std.debug.print("rejected: {f}\n", .{std.json.fmt(case.words, .{})});
        try std.testing.expectError(case.err, parse(arena.allocator(), case.words, case.caller));
    }
}

test "command lines parse to the request the daemon receives" {
    var arena = std.heap.ArenaAllocator.init(std.testing.allocator);
    defer arena.deinit();
    const tmp = try std.fs.realpathAlloc(arena.allocator(), "/tmp");
    const Case = struct {
        words: []const [:0]const u8,
        caller: u32 = 0,
        want: Invocation,
    };
    for ([_]Case{
        .{ .words = &.{ "list", "--text" }, .want = .{ .action = .list, .text_mode = true } },
        .{ .words = &.{ "workspace", "list" }, .want = .{ .action = .list } },
        .{ .words = &.{"current"}, .caller = 5, .want = .{ .action = .current } },
        .{ .words = &.{ "focus", "3", "--viewer", "9" }, .want = .{ .action = .focus, .target = 3, .viewer = 9 } },
        .{ .words = &.{ "workspace", "switch", "2" }, .want = .{ .action = .@"workspace.switch", .target = 2 } },
        .{ .words = &.{ "tab", "new", "--workspace", "2", "--name", "Build", "--command", "make" }, .want = .{ .action = .@"tab.new", .command = .{ .@"pane.create" = .{ .workspace = @enumFromInt(2), .title = "Build", .command = "make" } } } },
        .{ .words = &.{ "tab", "new" }, .caller = 5, .want = .{ .action = .@"tab.new", .command = .{ .@"pane.create" = .{ .workspace = .none } } } },
        .{ .words = &.{ "tab", "rename", "4", "Backend" }, .want = .{ .action = .@"tab.rename", .target = 4, .command = .{ .@"tab.rename" = .{ .target = @enumFromInt(4), .name = "Backend" } } } },
        .{ .words = &.{ "tab", "rename", "4", "--clear" }, .want = .{ .action = .@"tab.rename", .target = 4, .command = .{ .@"tab.rename" = .{ .target = @enumFromInt(4), .name = "" } } } },
        .{ .words = &.{ "tab", "move", "4", "--after", "6" }, .want = .{ .action = .@"tab.move", .target = 4, .command = .{ .@"tab.move" = .{ .target = @enumFromInt(4), .destination = .{ .after = @enumFromInt(6) } } } } },
        .{ .words = &.{ "tab", "move", "4", "--workspace", "2" }, .want = .{ .action = .@"tab.move", .target = 4, .command = .{ .@"tab.move" = .{ .target = @enumFromInt(4), .destination = .{ .workspace = @enumFromInt(2) } } } } },
        .{ .words = &.{ "tab", "merge", "4", "--below", "7" }, .want = .{ .action = .@"tab.merge", .target = 4, .command = .{ .@"tab.merge" = .{ .target = @enumFromInt(4), .other = @enumFromInt(7), .direction = .down } } } },
        .{ .words = &.{ "tab", "close", "4" }, .want = .{ .action = .@"tab.close", .target = 4, .command = .{ .@"tab.close" = .{ .target = @enumFromInt(4) } } } },
        .{ .words = &.{ "pane", "split", "3", "--left", "--command", "make" }, .want = .{ .action = .@"pane.split", .target = 3, .command = .{ .@"pane.split" = .{ .target = @enumFromInt(3), .direction = .left, .command = "make" } } } },
        .{ .words = &.{ "pane", "move", "3", "--left-of", "7" }, .want = .{ .action = .@"pane.move", .target = 3, .command = .{ .@"pane.move" = .{ .target = @enumFromInt(3), .destination = .{ .beside = .{ .other = @enumFromInt(7), .direction = .left } } } } } },
        .{ .words = &.{ "pane", "move", "3", "--new-tab", "--name", "Logs" }, .want = .{ .action = .@"pane.move", .target = 3, .command = .{ .@"pane.move" = .{ .target = @enumFromInt(3), .destination = .{ .new_tab = "Logs" } } } } },
        .{ .words = &.{ "pane", "swap", "3", "7" }, .want = .{ .action = .@"pane.swap", .target = 3, .command = .{ .@"pane.swap" = .{ .target = @enumFromInt(3), .other = @enumFromInt(7) } } } },
        .{ .words = &.{ "pane", "resize", "3", "--height", "60%" }, .want = .{ .action = .@"pane.resize", .target = 3, .command = .{ .@"pane.resize" = .{ .target = @enumFromInt(3), .axis = .vertical, .ratio = 600 } } } },
        .{ .words = &.{ "pane", "close", "3" }, .want = .{ .action = .@"pane.close", .target = 3, .command = .{ .@"pane.close" = .{ .target = @enumFromInt(3) } } } },
        .{ .words = &.{ "pane", "send", "3", "--enter", "--", "--literal" }, .want = .{ .action = .@"pane.send", .target = 3, .command = .{ .@"pane.send" = .{ .target = @enumFromInt(3), .text = "--literal", .enter = true } } } },
        .{ .words = &.{ "pane", "keys", "3", "ctrl+c", "enter" }, .want = .{ .action = .@"pane.keys", .target = 3, .command = .{ .@"pane.keys" = .{ .target = @enumFromInt(3), .text = "ctrl+c enter" } } } },
        .{ .words = &.{ "workspace", "new", "Project", "--cwd", "/tmp" }, .want = .{ .action = .@"workspace.new", .command = .{ .@"workspace.create" = .{ .name = "Project", .cwd = tmp } } } },
        .{ .words = &.{ "workspace", "edit", "2", "--clear", "--cwd", "/tmp" }, .want = .{ .action = .@"workspace.edit", .target = 2, .command = .{ .@"workspace.edit" = .{ .target = @enumFromInt(2), .name = "", .cwd = tmp } } } },
        .{ .words = &.{ "workspace", "close", "2" }, .want = .{ .action = .@"workspace.close", .target = 2, .command = .{ .@"workspace.close" = .{ .target = @enumFromInt(2) } } } },
    }) |case| {
        errdefer std.debug.print("accepted: {f}\n", .{std.json.fmt(case.words, .{})});
        try std.testing.expectEqualDeep(case.want, try parse(arena.allocator(), case.words, case.caller));
    }
    const read = try parse(arena.allocator(), &.{ "pane", "read", "current", "--lines", "10", "--text" }, 5);
    try std.testing.expect(read.current and read.text_mode);
    try std.testing.expectEqualDeep(protocol.Command{ .@"pane.read" = .{ .target = @enumFromInt(5), .lines = 10 } }, read.command.?);
}
