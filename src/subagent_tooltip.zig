//! Viewer-only grouping. Usage always belongs to individual conversations;
//! changing a role/activity label cannot move, reset, or duplicate its tokens.
const std = @import("std");
const protocol = @import("protocol.zig");
const sidebar = @import("sidebar.zig");
const usage = @import("live_usage.zig");
const max = @import("conversations.zig").max_actors;
const base = "\x1b[0;38;2;205;214;244;48;2;30;30;46m";
const Tone = enum {
    text,
    title,
    muted,
    border,
    tokens,
    input,
    output,
    recent,
    working,
    blocked,
    idle,
    group,
    fn ansi(tone: Tone) []const u8 {
        return switch (tone) {
            .text => "\x1b[38;2;205;214;244m",
            .title => "\x1b[1;38;2;205;214;244m",
            .muted => "\x1b[38;2;147;153;178m",
            .border => "\x1b[38;2;88;91;112m",
            .tokens => "\x1b[1;38;2;148;226;213m",
            .input => "\x1b[38;2;137;180;250m",
            .output => "\x1b[38;2;203;166;247m",
            .recent => "\x1b[38;2;250;179;135m",
            .working => "\x1b[38;2;249;226;175m",
            .blocked => "\x1b[38;2;243;139;168m",
            .idle => "\x1b[38;2;166;227;161m",
            .group => "\x1b[1;38;2;180;190;254m",
        };
    }
};

fn find(all: []const protocol.Conversation, id: u32) ?*const protocol.Conversation {
    for (all) |*item| if (item.id == id) return item;
    return null;
}
pub fn descendant(all: []const protocol.Conversation, item: protocol.Conversation, parent: u32) bool {
    if (parent == 0 or item.id == parent) return false;
    var current = item.parent;
    for (0..@min(max, all.len)) |_| {
        const id = current orelse return false;
        if (id == parent) return true;
        current = (find(all, id) orelse return false).parent;
    }
    return false;
}
pub fn childCount(all: []const protocol.Conversation, parent: u32) usize {
    var count: usize = 0;
    for (all) |item| if (descendant(all, item, parent)) {
        count += 1;
    };
    return count;
}
fn groupName(child: protocol.Conversation) []const u8 {
    if (child.role.len > 0) return child.role;
    if (child.agent.activity.len > 0) return child.agent.activity;
    return "Agents";
}
fn add(total: *usage.View, next: usage.View) void {
    total.tokens.add(next.tokens);
    total.recent_tokens +|= next.recent_tokens;
    total.known = total.known or next.known;
    total.partial = total.partial or next.partial or !next.known;
}
pub const Model = struct {
    pub const Group = struct { name: []const u8, count: usize = 0, usage: usage.View = .{} };
    groups: [max]Group = undefined,
    group_count: usize = 0,
    children: usize = 0,
    total: usage.View = .{},
    pub fn init(all: []const protocol.Conversation, parent: u32) Model {
        var m: Model = .{};
        if (find(all, parent)) |root| add(&m.total, root.usage);
        for (all) |child| {
            if (!descendant(all, child, parent)) continue;
            const name = groupName(child);
            const index = for (m.groups[0..m.group_count], 0..) |group, i| {
                if (std.ascii.eqlIgnoreCase(group.name, name)) break i;
            } else blk: {
                if (m.group_count == max) break;
                const index = m.group_count;
                m.groups[index] = .{ .name = name };
                m.group_count += 1;
                break :blk index;
            };
            m.groups[index].count += 1;
            add(&m.groups[index].usage, child.usage);
            add(&m.total, child.usage);
            m.children += 1;
        }
        return m;
    }
};
fn compact(buf: []u8, value: u64) []const u8 {
    if (value < 1000) return std.fmt.bufPrint(buf, "{d}", .{value}) catch unreachable;
    const suffixes = "kMBTPE";
    var scale: u64 = 1000;
    var index: usize = 0;
    while (true) {
        // Integer rounding avoids overflow and promotes 999.95k to 1M.
        const tenths: u64 = @intCast((@as(u128, value) * 10 + scale / 2) / scale);
        if (tenths >= 10_000 and index + 1 < suffixes.len) {
            scale *= 1000;
            index += 1;
            continue;
        }
        return if (tenths % 10 == 0)
            std.fmt.bufPrint(buf, "{d}{c}", .{ tenths / 10, suffixes[index] }) catch unreachable
        else
            std.fmt.bufPrint(buf, "{d}.{d}{c}", .{ tenths / 10, tenths % 10, suffixes[index] }) catch unreachable;
    }
}
fn tokenText(buf: []u8, value: usage.View) []const u8 {
    if (!value.known) return "— tokens";
    var number: [32]u8 = undefined;
    return std.fmt.bufPrint(buf, "{s}{s} tokens", .{ if (value.partial) "≥" else "", compact(&number, value.tokens.total()) }) catch unreachable;
}
fn activity(agent: protocol.Agent) []const u8 {
    if (agent.compacting) return "Compacting";
    if (agent.state == .working and agent.subagents.waiting) return "Waiting on subagents";
    if (agent.activity.len > 0) return agent.activity;
    if (agent.recent_activity.len > 0) return agent.recent_activity;
    if (agent.tool_active and agent.state == .working) return "Running a tool";
    return switch (agent.state) {
        .working => "Working",
        .blocked => "Needs input",
        .idle => "Idle",
        .done => "Session ended",
        .initializing => "Starting session",
        .unknown => "Waiting for activity",
    };
}
const Status = struct { icon: []const u8, label: []const u8, tone: Tone };
fn status(agent: protocol.Agent, stale: bool) Status {
    if (stale) return .{ .icon = "?", .label = "Last seen", .tone = .muted };
    if (agent.state == .blocked or agent.attention == .needs_input) return .{ .icon = "!", .label = "Needs input", .tone = .blocked };
    return switch (agent.state) {
        .working => .{ .icon = "●", .label = "Working", .tone = .working },
        .idle => .{ .icon = "○", .label = "Idle", .tone = .idle },
        .done => .{ .icon = "○", .label = "Ended", .tone = .muted },
        .initializing => .{ .icon = "◌", .label = "Starting", .tone = .group },
        .unknown => .{ .icon = "?", .label = "Unknown", .tone = .muted },
        .blocked => unreachable,
    };
}
const Card = struct {
    w: *std.Io.Writer,
    x: usize,
    width: usize,
    fn line(card: Card, row: usize, left: []const u8, right: []const u8, left_tone: Tone, right_tone: Tone) !void {
        const right_width = sidebar.displayWidth(right);
        const left_room = (card.width - 6) -| (right_width + @as(usize, if (right_width > 0) 2 else 0));
        try card.w.print("\x1b[{d};{d}H{s}{s}", .{ row + 1, card.x + 4, base, left_tone.ansi() });
        var clean: [512]u8 = undefined;
        try sidebar.writeEllipsis(card.w, sidebar.directoryLabel(&clean, left, null), left_room);
        try card.w.print("\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, card.x + card.width - 2 - right_width, base, right_tone.ansi(), right });
    }
    fn metrics(card: Card, row: usize, value: usage.View) !void {
        if (!value.known) return card.line(row, "Usage not reported yet", "", .muted, .muted);
        var left: [64]u8 = undefined;
        var right: [64]u8 = undefined;
        var n1: [32]u8 = undefined;
        var n2: [32]u8 = undefined;
        try card.line(row, try std.fmt.bufPrint(&left, "{s} input", .{compact(&n1, value.tokens.input)}), try std.fmt.bufPrint(&right, "{s} output", .{compact(&n2, value.tokens.output)}), .input, .output);
        try card.line(row + 1, try std.fmt.bufPrint(&left, "{s} cached", .{compact(&n1, value.tokens.cached_input)}), try std.fmt.bufPrint(&right, "{s} recent", .{compact(&n2, value.recent_tokens)}), .muted, .recent);
    }
};
pub fn draw(w: *std.Io.Writer, all: []const protocol.Conversation, entry: sidebar.Entry, cols: u16, rows: u16, px: u16, py: u16) !void {
    if (cols < 40 or rows < 13) return;
    const parent = entry.conversation;
    // A detected agent can have a visible row before it has a session binding.
    // Keep that row inspectable, with unknown usage until telemetry arrives.
    const provisional: protocol.Conversation = .{ .id = parent, .agent = .{
        .provider = entry.provider,
        .state = entry.state,
        .attention = entry.attention,
        .name = entry.name,
        .session = "",
        .activity = entry.activity,
        .cwd = entry.cwd,
        .tool_active = entry.tool_active,
        .compacting = entry.compacting,
        .subagents = entry.subagents,
    } };
    const root = find(all, parent) orelse &provisional;
    var root_agent = root.agent;
    root_agent.state = entry.state;
    const name = if (entry.name.len > 0) entry.name else if (root_agent.name.len > 0) root_agent.name else @tagName(entry.provider);
    const model = Model.init(all, parent);
    const width: usize = @min(58, cols);
    const wanted = if (model.children == 0) 12 else 14 + model.group_count * 2 + model.children * 3;
    const height = @min(wanted, rows - 2);
    const x: usize = @min(@as(usize, px) + 2, cols - width);
    const y: usize = @min(@as(usize, py) + 1, rows - 1 - height);
    try w.writeAll("\x1b7\x1b]8;;\x1b\\");
    for (0..height) |row| {
        try w.print("\x1b[{d};{d}H{s}{s}", .{ y + row + 1, x + 1, base, Tone.border.ansi() });
        try w.writeAll(if (row == 0) "╭" else if (row == height - 1) "╰" else "│");
        for (0..width - 2) |_| try w.writeAll(if (row == 0 or row == height - 1) "─" else " ");
        try w.writeAll(if (row == 0) "╮" else if (row == height - 1) "╯" else "│");
    }
    const card: Card = .{ .w = w, .x = x, .width = width };
    var text: [512]u8 = undefined;
    var tokens_buf: [64]u8 = undefined;
    const top = y + @as(usize, if (height >= 12) 2 else 1);
    const root_status = status(root_agent, false);
    try card.line(top, name, try std.fmt.bufPrint(&text, "{s} {s}", .{ root_status.icon, root_status.label }), .title, root_status.tone);
    const root_activity = if (root_agent.activity.len == 0 and root_agent.recent_activity.len == 0 and
        !root_agent.tool_active and !root_agent.compacting and !root_agent.subagents.waiting and (root_agent.state == .working or root_agent.state == .idle))
        "Activity not reported yet"
    else
        activity(root_agent);
    const subtitle = if (std.ascii.eqlIgnoreCase(name, @tagName(root_agent.provider))) root_activity else try std.fmt.bufPrint(&text, "{s} · {s}", .{ @tagName(root_agent.provider), root_activity });
    try card.line(top + 1, subtitle, "", .muted, .muted);
    try card.line(top + 3, "Own usage", tokenText(&tokens_buf, root.usage), .text, if (root.usage.known) .tokens else .muted);
    try card.metrics(top + 4, root.usage);
    var row = top + 7;
    const footer_row = y + height - 3;
    const end = footer_row - 1; // Blank separator, coverage footer, bottom padding.
    if (model.children > 0 and row < end) {
        try card.line(row, try std.fmt.bufPrint(&text, "Total · agent + {d} subagent{s}", .{ model.children, if (model.children == 1) "" else "s" }), tokenText(&tokens_buf, model.total), .text, if (model.total.known) .tokens else .muted);
        row += 2;
    }
    var shown: usize = 0;
    for (model.groups[0..model.group_count], 0..) |group, group_index| {
        if (group_index > 0) row += 1;
        if (row + 3 >= end) break;
        try card.line(row, try std.fmt.bufPrint(&text, "{s} · {d}", .{ group.name, group.count }), tokenText(&tokens_buf, group.usage), .group, if (group.usage.known) .tokens else .muted);
        row += 1;
        for (all) |child| {
            if (!descendant(all, child, parent) or !std.ascii.eqlIgnoreCase(groupName(child), group.name)) continue;
            if (row + 2 >= end) break;
            const stale = child.observed_at == 0 or std.time.microTimestamp() - child.observed_at > 10 * std.time.us_per_s;
            const child_status = status(child.agent, stale);
            const child_name = if (child.agent.name.len > 0) child.agent.name else child.agent.session[0..@min(8, child.agent.session.len)];
            const label = try std.fmt.bufPrint(&text, "{s} {s}", .{ child_status.icon, child_name });
            try card.line(row, label, tokenText(&tokens_buf, child.usage), .text, if (child.usage.known) .tokens else .muted);
            try w.print("\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, x + 4, base, child_status.tone.ansi(), child_status.icon });
            row += 1;
            var metrics: [128]u8 = undefined;
            var n1: [32]u8 = undefined;
            var n2: [32]u8 = undefined;
            const requests = if (child.usage.known)
                try std.fmt.bufPrint(&metrics, "{s} in · {s} out", .{ compact(&n1, child.usage.tokens.input), compact(&n2, child.usage.tokens.output) })
            else
                "—";
            try card.line(row, try std.fmt.bufPrint(&text, "  {s}", .{activity(child.agent)}), requests, .muted, .input);
            row += 1;
            if (child.usage.known) {
                try card.line(row, try std.fmt.bufPrint(&text, "  {s} cached", .{compact(&n1, child.usage.tokens.cached_input)}), try std.fmt.bufPrint(&metrics, "{s} recent", .{compact(&n2, child.usage.recent_tokens)}), .muted, .recent);
            } else try card.line(row, "  Usage not reported yet", "", .muted, .muted);
            row += 1;
            shown += 1;
        }
    }
    const footer = if (model.children == 0 and (entry.subagents.running > 0 or entry.subagents.blocked > 0)) "Updating child details…" else if (shown < model.children)
        try std.fmt.bufPrint(&text, "+{d} more{s}", .{ model.children - shown, if (model.total.partial) " · ≥ partial" else "" })
    else if (model.total.partial and model.total.known) "≥ Partial coverage" else if (model.children == 0) "No subagents" else "Live usage";
    try card.line(footer_row, footer, "Recent ≈ 5 min", if (model.total.partial and model.total.known) .working else .muted, .muted);
    try w.writeAll("\x1b[0m\x1b8");
}

test "role groups aggregate each descendant once and exclude other trees" {
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "Scanning", .cwd = "", .tool_active = false };
    const all = [_]protocol.Conversation{
        .{ .id = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 10 } } },
        .{ .id = 2, .parent = 1, .role = "Explorer", .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 20 } } },
        .{ .id = 3, .parent = 2, .role = "explorer", .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 30 } } },
        .{ .id = 4, .parent = 99, .role = "Explorer", .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 900 } } },
    };
    const model = Model.init(&all, 1);
    try std.testing.expectEqual(@as(usize, 1), model.group_count);
    try std.testing.expectEqual(@as(usize, 2), model.children);
    try std.testing.expectEqual(@as(u64, 50), model.groups[0].usage.tokens.total());
    try std.testing.expectEqual(@as(u64, 60), model.total.tokens.total());
    try std.testing.expect(!model.total.partial);
}

test "both agent rows open one safe card before a session is bound and exiting rows do not" {
    var entries = [_]sidebar.Entry{.{ .target = .{ .pane = 1 }, .provider = .codex, .state = .initializing, .attention = .none, .name = "探索\x1b[2J" }};
    const view = sidebar.View.init(100, 30, true, 0, 1);
    const top = view.middle() + 2;
    try std.testing.expectEqual(&entries[0], sidebar.agentAt(view, &entries, 5, top).?);
    try std.testing.expectEqual(&entries[0], sidebar.agentAt(view, &entries, 24, top + 1).?);
    try std.testing.expectEqual(null, sidebar.agentAt(view, &entries, view.width, top));
    try std.testing.expectEqual(null, sidebar.agentAt(view, &entries, 5, top + 2));
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try draw(&output.writer, &.{}, entries[0], 100, 30, 5, top);
    const text = output.written();
    try std.testing.expect(std.mem.indexOf(u8, text, "探索?[2J") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "\x1b[2J") == null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Own usage") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Usage not reported yet") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "Starting session") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "No subagents") != null);
    entries[0].exit = .{ .frame_ms = 1, .progress = 0.5 };
    try std.testing.expectEqual(null, sidebar.agentAt(view, &entries, 5, top));
}

test "compact token counts round through unit boundaries without overflow" {
    var buf: [32]u8 = undefined;
    const examples = .{
        .{ @as(u64, 0), "0" },
        .{ @as(u64, 999), "999" },
        .{ @as(u64, 1000), "1k" },
        .{ @as(u64, 12_345), "12.3k" },
        .{ @as(u64, 12_350), "12.4k" },
        .{ @as(u64, 999_949), "999.9k" },
        .{ @as(u64, 999_950), "1M" },
        .{ @as(u64, 2_345_678), "2.3M" },
        .{ std.math.maxInt(u64), "18.4E" },
    };
    inline for (examples) |example| try std.testing.expectEqualStrings(example[1], compact(&buf, example[0]));
}
