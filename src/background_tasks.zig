//! Provider task identities are the unit of work, not individual OS processes.
const std = @import("std");
const common = @import("providers/common.zig");
const clean = @import("agents.zig").clean;
pub const capacity = 32;
pub const Group = enum {
    tests,
    builds,
    servers,
    commands,
    pub fn label(g: Group) []const u8 {
        return switch (g) {
            .tests => "Tests",
            .builds => "Builds",
            .servers => "Servers",
            .commands => "Commands",
        };
    }
};
pub const Task = struct {
    id: [96]u8 = @splat(0),
    id_len: usize = 0,
    label: [256]u8 = @splat(0),
    label_len: usize = 0,
    group: Group = .commands,
};
pub const View = struct {
    pub const Item = struct { id: []const u8, label: []const u8, group: Group };
    items: []const Item = &.{},
    observed_at: i64 = 0,
    live: bool = false,
    truncated: bool = false,
};
pub const Inventory = struct {
    items: [capacity]Task = @splat(.{}),
    len: usize = 0,
    observed_at: i64 = 0,
    live: bool = false,
    truncated: bool = false,

    pub fn append(t: *Inventory, id: []const u8, description: []const u8, command: []const u8) void {
        if (id.len == 0 or id.len > 96 or (description.len == 0 and command.len == 0)) return;
        for (t.items[0..t.len]) |item| if (std.mem.eql(u8, item.id[0..item.id_len], id)) return;
        if (t.len == capacity) {
            t.truncated = true;
            return;
        }
        const item = &t.items[t.len];
        item.id_len = clean(&item.id, id);
        item.group = classify(command);
        item.label_len = summarize(&item.label, description, command, item.group);
        t.len += 1;
    }
    pub fn claude(value: std.json.Value, now: i64) ?Inventory {
        if (value != .array) return null;
        var t: Inventory = .{ .observed_at = now };
        for (value.array.items) |item| {
            if (!common.eq(common.str(item, "type"), "shell")) continue;
            const status = common.str(item, "status");
            if (common.eq(status, "completed") or common.eq(status, "failed") or common.eq(status, "killed")) continue;
            t.append(common.str(item, "id"), common.str(item, "description"), common.str(item, "command"));
        }
        return t;
    }
    pub fn view(t: *const Inventory, allocator: std.mem.Allocator) !View {
        const items = try allocator.alloc(View.Item, t.len);
        for (items, t.items[0..t.len]) |*out, *item| out.* = .{ .id = item.id[0..item.id_len], .label = item.label[0..item.label_len], .group = item.group };
        return .{ .items = items, .observed_at = t.observed_at, .live = t.live, .truncated = t.truncated };
    }
};

/// Keep shell syntax, flags and inline programs out of display labels. Provider
/// prose is useful, but is bounded too so it cannot dominate the tooltip.
fn summarize(out: []u8, description: []const u8, command: []const u8, group: Group) usize {
    const prose = std.mem.trim(u8, description, " \t\r\n");
    if (prose.len > 0 and !common.eq(prose, std.mem.trim(u8, command, " \t\r\n"))) {
        var words = std.mem.tokenizeAny(u8, prose, " \t\r\n");
        var len: usize = 0;
        var count: usize = 0;
        while (words.next()) |word| {
            if (count == 6 or len + word.len + @as(usize, @intFromBool(len > 0)) > 45) {
                if (len == 0) break; // A path or unbroken command is not prose.
                @memcpy(out[len..][0..3], "…");
                return len + 3;
            }
            if (len > 0) {
                out[len] = ' ';
                len += 1;
            }
            len += clean(out[len..], word);
            count += 1;
        }
        if (len > 0) return len;
    }
    const label = switch (group) {
        .tests => "Running tests",
        .builds => "Building project",
        .servers => "Running development server",
        .commands => blk: {
            var words = std.mem.tokenizeAny(u8, command, " \t\r\n");
            const exe = std.fs.path.basename(words.next() orelse "");
            if (common.eq(exe, "rg") or common.eq(exe, "grep") or common.eq(exe, "find")) break :blk "Searching files";
            if (common.eq(exe, "curl") or common.eq(exe, "wget")) break :blk "Fetching data";
            if (common.eq(exe, "sleep") or common.eq(exe, "wait")) break :blk "Waiting";
            if (common.eq(exe, "tail")) break :blk "Watching output";
            if (common.eq(exe, "git")) break :blk "Running Git task";
            if (std.mem.startsWith(u8, exe, "python")) break :blk "Running Python task";
            if (common.eq(exe, "bun")) break :blk "Running Bun task";
            if (common.eq(exe, "node")) break :blk "Running JavaScript task";
            break :blk "Running shell task";
        },
    };
    return clean(out, label);
}

fn classify(command: []const u8) Group {
    var words = std.mem.tokenizeAny(u8, command, " \t\r\n");
    const executable = std.fs.path.basename(words.next() orelse return .commands);
    if (common.eq(executable, "pytest") or common.eq(executable, "jest") or common.eq(executable, "vitest")) return .tests;
    // Inspect only the invocation prefix; arguments and quoted source text do
    // not turn an arbitrary command into a test or a server.
    for (0..2) |_| {
        const word = words.next() orelse break;
        if (common.eq(word, "test") or (common.eq(word, "pytest") and std.mem.startsWith(u8, executable, "python"))) return .tests;
        if (common.eq(word, "build")) {
            if (common.eq(words.next() orelse "", "test")) return .tests;
            return .builds;
        }
        if (common.eq(word, "dev") or common.eq(word, "serve") or common.eq(word, "http.server")) return .servers;
        if (!common.eq(word, "run") and !common.eq(word, "-m")) break;
    }
    return .commands;
}

test "provider tasks retain identity, descriptions and bounded categories" {
    const parsed = try std.json.parseFromSlice(std.json.Value, std.testing.allocator,
        \\[{"id":"1","type":"shell","status":"running","description":"Check parser","command":"bun test"},{"id":"1","type":"shell","command":"bun test"},{"id":"2","type":"subagent","description":"Ignore"},{"id":"3","type":"shell","status":"completed","command":"bun build"}]
    , .{});
    defer parsed.deinit();
    var t = Inventory.claude(parsed.value, 123).?;
    try std.testing.expectEqual(@as(usize, 1), t.len);
    try std.testing.expectEqualStrings("Check parser", t.items[0].label[0..t.items[0].label_len]);
    try std.testing.expectEqual(Group.tests, t.items[0].group);
    try std.testing.expect(!t.live);
    try std.testing.expectEqual(Group.tests, classify("./scripts/zig build test"));
    try std.testing.expectEqual(Group.servers, classify("bun run dev"));
    try std.testing.expectEqual(Group.tests, classify("python3 -m pytest tests"));
    try std.testing.expectEqual(Group.servers, classify("python3 -m http.server 8000"));
    try std.testing.expectEqual(Group.commands, classify("echo 'test server'"));
    for (0..capacity + 1) |i| {
        var id: [20]u8 = undefined;
        t.append(try std.fmt.bufPrint(&id, "task-{d}", .{i}), "Build", "bun run build");
    }
    try std.testing.expectEqual(capacity, t.len);
    try std.testing.expect(t.truncated);
}

test "task labels summarize commands and bound provider prose" {
    var inventory: Inventory = .{};
    const examples = .{
        .{ "", "./scripts/zig build test -Doptimize=ReleaseSafe -Dcodesign=false", "Running tests" },
        .{ "", "bun run dev --host 0.0.0.0 --port 3000", "Running development server" },
        .{ "", "python3 -c 'a very long inline program'", "Running Python task" },
        .{ "", "sh -c 'cd /long/path && complex-command --many-flags'", "Running shell task" },
        .{ "Check parser", "bun test", "Check parser" },
        .{ "bun test", "bun test", "Running tests" },
        .{ "Run the parser tests and validate all generated fixtures", "bun test", "Run the parser tests and validate…" },
    };
    inline for (examples, 0..) |example, i| {
        var id: [16]u8 = undefined;
        inventory.append(try std.fmt.bufPrint(&id, "{d}", .{i}), example[0], example[1]);
        const task = inventory.items[i];
        try std.testing.expectEqualStrings(example[2], task.label[0..task.label_len]);
    }
}
