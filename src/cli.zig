//! Agent CLI: parse command payloads directly, then send one request.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const session = @import("session.zig");
const layout = @import("layout.zig");
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
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
    for ([_][]const u8{ "tab", "pane", "workspace", "current", "list", "focus", "--skill" }) |name| if (eq(args[1], name)) return true;
    return false;
}

pub fn run(path: []const u8, args: []const [:0]u8) !void {
    if (eq(args[1], "--skill")) {
        if (args.len != 2) return error.Usage;
        return os.writeAll(1, @embedFile("corgi-skill.md"));
    }
    const group = eq(args[1], "tab") or eq(args[1], "pane") or eq(args[1], "workspace");
    if (group and args.len == 2) return os.writeAll(1, help);
    for (args[2..]) |arg| if (eq(arg, "--help") or eq(arg, "-h")) return os.writeAll(1, help);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const mem = arena.allocator();
    const raw_action = if (group) try std.fmt.allocPrint(mem, "{s}.{s}", .{ args[1], args[2] }) else args[1];
    const action = if (eq(raw_action, "workspace.list")) "list" else raw_action;
    const caller = if (os.env("CORGI_PANE")) |value| std.fmt.parseInt(u32, value, 10) catch 0 else 0;
    var start: usize = if (group) 3 else 2;
    var current = false;
    var target: u32 = 0;
    if (!eq(action, "list") and !eq(action, "current") and !eq(action, "tab.new") and !eq(action, "workspace.new")) {
        if (start == args.len) return error.Usage;
        current = eq(args[start], "current");
        if (current and eq(args[1], "workspace")) return error.Usage;
        target = if (current) caller else try id(args[start]);
        if (current and caller == 0) return error.NoCallerPane;
        start += 1;
    }
    var parsed = try Args.parse(mem, args[start..]);
    const text_mode = try parsed.flag("--text");
    const viewer = if (eq(action, "focus"))
        try id(try parsed.required("--viewer"))
    else if (eq(action, "workspace.switch"))
        if (try parsed.option("--viewer")) |value| try id(value) else @as(?u32, null)
    else
        null;
    var command: ?session.Command = if (eq(action, "list") or eq(action, "current") or eq(action, "focus") or eq(action, "workspace.switch")) null else try parseCommand(action, target, &parsed);
    try parsed.end();
    if (eq(action, "current") and caller == 0) return error.NoCallerPane;
    if (command) |cmd| if (cmd == .@"pane.create" and cmd.@"pane.create".workspace == 0 and caller == 0) return error.MissingWorkspace;

    const fd = try os.connect(path);
    defer _ = os.c.close(fd);
    if ((current and eq(args[1], "tab")) or (eq(action, "tab.new") and caller != 0)) {
        const located = try call(fd, .{ .op = "session.locate", .protocol = 1, .pane = caller });
        defer located.deinit();
        const here = located.value.object.get("result").?;
        const tab = try @import("protocol.zig").id(here, "tab");
        const workspace = try @import("protocol.zig").id(here, "workspace");
        switch (command.?) {
            .@"tab.rename" => |*q| q.target = tab,
            .@"tab.move" => |*q| q.target = tab,
            .@"tab.merge" => |*q| q.target = tab,
            .@"tab.close" => |*q| q.target = tab,
            .@"pane.create" => |*q| {
                if (q.workspace == 0) q.workspace = workspace;
                if (q.workspace == workspace) q.from = caller;
            },
            else => unreachable,
        }
    }
    const response = if (command) |cmd|
        try call(fd, .{ .op = "session.command", .protocol = 1, .command = cmd })
    else if (eq(action, "list"))
        try call(fd, .{ .op = "session.list", .protocol = 1 })
    else if (eq(action, "current"))
        try call(fd, .{ .op = "session.locate", .protocol = 1, .pane = caller })
    else if (eq(action, "workspace.switch"))
        if (viewer) |selected| try call(fd, .{ .op = "workspace.switch", .workspace = target, .viewer = selected }) else try call(fd, .{ .op = "workspace.switch", .workspace = target })
    else
        try call(fd, .{ .op = "focus", .pane = target, .viewer = viewer });
    defer response.deinit();
    if (text_mode) {
        if (response.value.object.get("result")) |result| if (result.object.get("text")) |text| if (text == .string) return os.writeAll(1, text.string);
    }
    const output = try std.json.Stringify.valueAlloc(mem, response.value, .{ .whitespace = if (text_mode) .indent_2 else .minified });
    try os.writeAll(1, output);
    try os.writeAll(1, "\n");
}

fn parseCommand(action: []const u8, target: u32, args: *Args) !session.Command {
    if (eq(action, "tab.new")) return .{ .@"pane.create" = .{
        .workspace = if (try args.option("--workspace")) |value| try id(value) else 0,
        .title = (try args.option("--name")) orelse "",
        .cwd = try args.cwd(),
        .command = try args.option("--command"),
    } };
    if (eq(action, "workspace.new")) return .{ .@"workspace.create" = .{
        .name = try args.next(),
        .cwd = try args.directory((try args.option("--cwd")) orelse "."),
    } };
    const tag = std.meta.stringToEnum(std.meta.Tag(session.Command), action) orelse return error.Usage;
    return switch (tag) {
        .@"workspace.close" => .{ .@"workspace.close" = .{ .target = target } },
        .@"workspace.edit" => .{ .@"workspace.edit" = .{
            .target = target,
            .name = if (try args.flag("--clear")) "" else try args.option("--name"),
            .cwd = if (try args.option("--cwd")) |value| try args.directory(value) else null,
        } },
        .@"tab.rename" => .{ .@"tab.rename" = .{ .target = target, .name = if (try args.flag("--clear")) "" else try args.next() } },
        .@"tab.close" => .{ .@"tab.close" = .{ .target = target } },
        .@"pane.close" => .{ .@"pane.close" = .{ .target = target } },
        .@"pane.swap" => .{ .@"pane.swap" = .{ .target = target, .other = try id(try args.next()) } },
        .@"pane.split" => .{ .@"pane.split" = .{
            .target = target,
            .direction = try args.direction(),
            .cwd = try args.cwd(),
            .command = try args.option("--command"),
        } },
        .@"tab.merge" => blk: {
            const beside = try args.beside();
            break :blk .{ .@"tab.merge" = .{ .target = target, .other = beside.other, .direction = beside.direction } };
        },
        .@"tab.move" => .{ .@"tab.move" = .{
            .target = target,
            .destination = if (try args.option("--before")) |value|
                .{ .before = try id(value) }
            else if (try args.option("--after")) |value|
                .{ .after = try id(value) }
            else
                .{ .workspace = try id(try args.required("--workspace")) },
        } },
        .@"pane.move" => .{ .@"pane.move" = .{
            .target = target,
            .destination = if (try args.flag("--new-tab"))
                .{ .new_tab = (try args.option("--name")) orelse "" }
            else
                .{ .beside = try args.beside() },
        } },
        .@"pane.resize" => blk: {
            const width = try args.option("--width");
            const value = width orelse try args.required("--height");
            if (!std.mem.endsWith(u8, value, "%")) return error.Usage;
            const percent = try std.fmt.parseInt(u16, value[0 .. value.len - 1], 10);
            if (percent < 10 or percent > 90) return error.Usage;
            break :blk .{ .@"pane.resize" = .{
                .target = target,
                .axis = if (width != null) .horizontal else .vertical,
                .ratio = percent * 10,
            } };
        },
        .@"pane.read" => blk: {
            const lines = if (try args.option("--lines")) |value| try std.fmt.parseInt(usize, value, 10) else 100;
            if (lines == 0 or lines > 10000) return error.Usage;
            break :blk .{ .@"pane.read" = .{ .target = target, .lines = lines } };
        },
        .@"pane.send" => .{ .@"pane.send" = .{
            .target = target,
            .text = if (try args.flag("--stdin")) try std.fs.File.stdin().readToEndAlloc(args.mem, 1024 * 1024) else try args.next(),
            .enter = try args.flag("--enter"),
        } },
        .@"pane.keys" => blk: {
            if (args.positional.items.len == 0) return error.Usage;
            for (args.positional.items) |key| _ = try session.logicalKey(key);
            const text = try std.mem.join(args.mem, " ", args.positional.items);
            args.positional.clearRetainingCapacity();
            break :blk .{ .@"pane.keys" = .{ .target = target, .text = text } };
        },
        else => error.Usage,
    };
}

/// Command-line syntax only. Each operation consumes its own accepted options.
const Args = struct {
    mem: std.mem.Allocator,
    options: std.StringHashMap(?[]const u8),
    positional: std.ArrayList([]const u8) = .empty,
    fn parse(mem: std.mem.Allocator, values: []const [:0]u8) !Args {
        var result: Args = .{ .mem = mem, .options = .init(mem) };
        var literal = false;
        var i: usize = 0;
        while (i < values.len) : (i += 1) {
            const arg = values[i];
            if (!literal and eq(arg, "--")) {
                literal = true;
            } else if (!literal and std.mem.startsWith(u8, arg, "--")) {
                const entry = try result.options.getOrPut(arg);
                if (entry.found_existing) return error.Usage;
                const flag_ = for ([_][]const u8{ "--text", "--clear", "--stdin", "--enter", "--new-tab", "--left", "--right", "--up", "--down" }) |name| {
                    if (eq(arg, name)) break true;
                } else false;
                entry.value_ptr.* = if (flag_) null else blk: {
                    i += 1;
                    if (i == values.len) return error.Usage;
                    break :blk values[i];
                };
            } else try result.positional.append(mem, arg);
        }
        return result;
    }
    fn flag(args: *Args, name: []const u8) !bool {
        const entry = args.options.fetchRemove(name) orelse return false;
        if (entry.value != null) return error.Usage;
        return true;
    }
    fn option(args: *Args, name: []const u8) !?[]const u8 {
        const entry = args.options.fetchRemove(name) orelse return null;
        return entry.value orelse error.Usage;
    }
    fn required(args: *Args, name: []const u8) ![]const u8 {
        return (try args.option(name)) orelse error.Usage;
    }
    fn next(args: *Args) ![]const u8 {
        if (args.positional.items.len == 0) return error.Usage;
        return args.positional.orderedRemove(0);
    }
    fn end(args: *Args) !void {
        if (args.options.count() != 0 or args.positional.items.len != 0) return error.Usage;
    }
    fn cwd(args: *Args) ![]const u8 {
        const value = (try args.option("--cwd")) orelse return "";
        return args.directory(value);
    }
    fn directory(args: *Args, value: []const u8) ![]const u8 {
        const resolved = try @import("workspace.zig").Store.directory(value);
        defer a.free(resolved);
        return args.mem.dupe(u8, resolved);
    }
    fn direction(args: *Args) !layout.Direction {
        const flags = [_][]const u8{ "--left", "--right", "--up", "--down" };
        const directions = [_]layout.Direction{ .left, .right, .up, .down };
        for (flags, directions) |name, value| if (try args.flag(name)) return value;
        return error.Usage;
    }
    fn beside(args: *Args) !session.Beside {
        const flags = [_][]const u8{ "--left-of", "--right-of", "--above", "--below" };
        const directions = [_]layout.Direction{ .left, .right, .up, .down };
        for (flags, directions) |name, value| if (try args.option(name)) |other| return .{ .other = try id(other), .direction = value };
        return error.Usage;
    }
};

fn call(fd: c_int, request: anytype) !std.json.Parsed(std.json.Value) {
    var connection: @import("rpc.zig").Connection = .{ .fd = fd };
    const response = try connection.request(request);
    errdefer response.deinit();
    const err = @import("agents.zig").str(response.value, "err");
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
