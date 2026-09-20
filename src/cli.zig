//! Small public agent CLI. Parsing completes before connecting to a runtime.
const std = @import("std");
const os = @import("os.zig");
const a = os.allocator;
const control = @import("control.zig");
fn eq(x: []const u8, y: []const u8) bool {
    return std.mem.eql(u8, x, y);
}
pub const help =
    \\Agent controls (JSON by default; --text for readable output):
    \\  corgi list [--text]                 layout, panes, agents, viewers
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
    for ([_][]const u8{ "tab", "pane", "current", "list", "focus", "--skill" }) |name| if (eq(args[1], name)) return true;
    return false;
}
pub fn run(path: []const u8, args: []const [:0]u8) !void {
    if (eq(args[1], "--skill")) {
        if (args.len != 2) return error.Usage;
        return os.writeAll(1, @embedFile("corgi-skill.md"));
    }
    const group = eq(args[1], "tab") or eq(args[1], "pane");
    if ((group and args.len == 2)) return os.writeAll(1, help);
    for (args[2..]) |arg| if (eq(arg, "--help") or eq(arg, "-h")) return os.writeAll(1, help);
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const mem = arena.allocator();
    var q: control.Request = .{ .action = if (group) try std.fmt.allocPrint(mem, "{s}.{s}", .{ args[1], args[2] }) else args[1] };
    q.caller = if (os.env("CORGI_PANE")) |value| std.fmt.parseInt(u32, value, 10) catch 0 else 0;
    var i: usize = if (group) 3 else 2;
    if (!eq(q.action, "list") and !eq(q.action, "current") and !eq(q.action, "tab.new")) {
        if (i == args.len) return error.Usage;
        q.current = eq(args[i], "current");
        if (!q.current) q.target = try id(args[i]);
        if (q.current and q.caller == 0) return error.NoCallerPane;
        i += 1;
    }
    var positional: std.ArrayList([]const u8) = .empty;
    var seen: std.StringHashMap(void) = .init(mem);
    var text_mode = false;
    var stdin = false;
    var direction_set = false;
    var ratio_set = false;
    var clear = false;
    var literal = false;
    while (i < args.len) : (i += 1) {
        const arg = args[i];
        if (!literal and eq(arg, "--")) {
            literal = true;
            continue;
        }
        if (literal or !std.mem.startsWith(u8, arg, "--")) {
            try positional.append(mem, arg);
            continue;
        }
        if (seen.contains(arg)) return error.Usage;
        try seen.put(arg, {});
        if (eq(arg, "--text")) {
            text_mode = true;
            continue;
        }
        if (eq(arg, "--clear")) {
            if (!eq(q.action, "tab.rename")) return error.Usage;
            clear = true;
            continue;
        }
        if (eq(arg, "--stdin") or eq(arg, "--enter")) {
            if (!eq(q.action, "pane.send")) return error.Usage;
            if (eq(arg, "--stdin")) stdin = true else q.enter = true;
            continue;
        }
        if (eq(arg, "--new-tab")) {
            if (!eq(q.action, "pane.move") or q.placement != .none) return error.Usage;
            q.placement = .new_tab;
            continue;
        }
        const dirs = [_][]const u8{ "--left", "--right", "--up", "--down" };
        const move_dirs = [_][]const u8{ "--left-of", "--right-of", "--above", "--below" };
        const values = [_]@import("layout.zig").Direction{ .left, .right, .up, .down };
        var matched = false;
        for (dirs, move_dirs, values) |d, md, value| {
            if (eq(arg, d)) {
                if (!eq(q.action, "pane.split") or direction_set) return error.Usage;
                q.direction = value;
                direction_set = true;
                matched = true;
            } else if (eq(arg, md)) {
                if ((!eq(q.action, "pane.move") and !eq(q.action, "tab.merge")) or q.placement != .none) return error.Usage;
                i += 1;
                if (i == args.len) return error.Usage;
                q.other = try id(args[i]);
                q.direction = value;
                q.placement = .beside;
                matched = true;
            }
        }
        if (matched) continue;
        i += 1;
        if (i == args.len) return error.Usage;
        const value = args[i];
        if (eq(arg, "--before") or eq(arg, "--after")) {
            if (!eq(q.action, "tab.move") or q.placement != .none) return error.Usage;
            q.placement = if (eq(arg, "--before")) .before else .after;
            q.other = try id(value);
        } else if (eq(arg, "--workspace")) {
            if (!eq(q.action, "tab.new") and !eq(q.action, "tab.move")) return error.Usage;
            if (eq(q.action, "tab.move")) {
                if (q.placement != .none) return error.Usage;
                q.placement = .workspace;
            }
            q.workspace = try id(value);
        } else if (eq(arg, "--name")) {
            if (!eq(q.action, "tab.new") and !eq(q.action, "pane.move")) return error.Usage;
            q.name = value;
        } else if (eq(arg, "--cwd")) {
            if (!eq(q.action, "tab.new") and !eq(q.action, "pane.split")) return error.Usage;
            const directory = try @import("workspace.zig").Store.directory(value);
            defer a.free(directory);
            q.cwd = try mem.dupe(u8, directory);
        } else if (eq(arg, "--viewer")) {
            if (!eq(q.action, "focus")) return error.Usage;
            q.viewer = try id(value);
        } else if (eq(arg, "--lines")) {
            if (!eq(q.action, "pane.read")) return error.Usage;
            q.lines = try std.fmt.parseInt(usize, value, 10);
            if (q.lines == 0 or q.lines > 10000) return error.Usage;
        } else if (eq(arg, "--width") or eq(arg, "--height")) {
            if (!eq(q.action, "pane.resize") or ratio_set or !std.mem.endsWith(u8, value, "%")) return error.Usage;
            const percent = try std.fmt.parseInt(u16, value[0 .. value.len - 1], 10);
            if (percent < 10 or percent > 90) return error.Usage;
            q.ratio = percent * 10;
            q.axis = if (eq(arg, "--width")) .horizontal else .vertical;
            ratio_set = true;
        } else return error.Usage;
    }
    const pos = positional.items;
    if (eq(q.action, "tab.rename")) {
        if ((clear and pos.len != 0) or (!clear and pos.len != 1)) return error.Usage;
        q.name = if (clear) "" else pos[0];
    } else if (eq(q.action, "pane.send")) {
        if ((stdin and pos.len != 0) or (!stdin and pos.len != 1)) return error.Usage;
        q.text = if (stdin) try std.fs.File.stdin().readToEndAlloc(mem, 1024 * 1024) else pos[0];
    } else if (eq(q.action, "pane.keys")) {
        if (pos.len == 0) return error.Usage;
        for (pos) |key| _ = try control.logicalKey(key);
        q.text = try std.mem.join(mem, " ", pos);
    } else if (eq(q.action, "pane.swap")) {
        if (pos.len != 1) return error.Usage;
        q.other = try id(pos[0]);
    } else if (pos.len != 0) return error.Usage;
    if (eq(q.action, "pane.split") and !direction_set) return error.Usage;
    if (eq(q.action, "pane.resize") and !ratio_set) return error.Usage;
    if (eq(q.action, "focus") and q.viewer == 0) return error.Usage;
    if (eq(q.action, "current") and q.caller == 0) return error.NoCallerPane;
    if (eq(q.action, "tab.new") and q.workspace == 0 and q.caller == 0) return error.MissingWorkspace;
    if ((eq(q.action, "pane.move") or eq(q.action, "tab.move") or eq(q.action, "tab.merge")) and q.placement == .none) return error.Usage;
    if (eq(q.action, "pane.move") and q.name.len > 0 and q.placement != .new_tab) return error.Usage;
    const supported = [_][]const u8{ "list", "current", "focus", "tab.new", "tab.rename", "tab.move", "tab.merge", "tab.close", "pane.split", "pane.move", "pane.swap", "pane.resize", "pane.close", "pane.read", "pane.send", "pane.keys" };
    for (supported) |action| if (eq(q.action, action)) break else {} else return error.Usage;
    const fd = try os.connect(path);
    defer _ = os.c.close(fd);
    try os.sendJson(fd, q);
    const line = try os.readLine(fd, 4 * 1024 * 1024);
    defer a.free(line);
    const response = try std.json.parseFromSlice(std.json.Value, mem, line, .{});
    const err = @import("agents.zig").str(response.value, "err");
    if (err.len > 0) {
        try failure(err, 1);
        return;
    }
    if (text_mode) {
        if (response.value.object.get("text")) |t| return os.writeAll(1, t.string);
        const pretty = try std.json.Stringify.valueAlloc(mem, response.value, .{ .whitespace = .indent_2 });
        try os.writeAll(1, pretty);
    } else try os.writeAll(1, line);
    try os.writeAll(1, "\n");
}
fn id(value: []const u8) !u32 {
    const result = std.fmt.parseInt(u32, value, 10) catch return error.Usage;
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
