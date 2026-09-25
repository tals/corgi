//! Viewer-only grouping. Usage always belongs to individual conversations;
//! changing a role/activity label cannot move, reset, or duplicate its tokens.
const std = @import("std");
const protocol = @import("protocol.zig");
const sidebar = @import("sidebar.zig");
const usage = @import("live_usage.zig");
const max = @import("conversations.zig").max_actors;
const time_c = @cImport(@cInclude("time.h"));
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
fn visibleChild(all: []const protocol.Conversation, item: protocol.Conversation, parent: u32) bool {
    return item.agent.state != .idle and descendant(all, item, parent);
}
pub fn childCount(all: []const protocol.Conversation, parent: u32) usize {
    var count: usize = 0;
    for (all) |item| if (visibleChild(all, item, parent)) {
        count += 1;
    };
    return count;
}
pub fn childrenAvailable(all: []const protocol.Conversation, parent: u32, now: i64) bool {
    const root = find(all, parent) orelse return false;
    const age = now - root.children_observed_at;
    if (root.children_observed_at <= 0 or age < 0 or age > 10 * std.time.us_per_s) return false;
    // Omit the whole section when child status cannot be presented reliably.
    for (all) |child| {
        if (!descendant(all, child, parent)) continue;
        const child_age = now - child.observed_at;
        if (child.agent.state == .unknown or child.observed_at <= 0 or child_age < 0 or child_age > 10 * std.time.us_per_s) return false;
    }
    return true;
}
pub fn presentChildren(entry: *sidebar.Entry, all: []const protocol.Conversation, now: i64) void {
    entry.children = 0;
    if (childrenAvailable(all, entry.conversation, now)) {
        entry.children = childCount(all, entry.conversation);
    } else entry.subagents = .{};
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
            add(&m.total, child.usage);
            if (!visibleChild(all, child, parent)) continue;
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
        try sidebar.writeEllipsis(card.w, if (left.len == 0) "" else sidebar.directoryLabel(&clean, left, null), left_room);
        try card.w.print("\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, card.x + card.width - 2 - right_width, base, right_tone.ansi(), right });
    }
    fn cell(card: Card, row: usize, offset: usize, width: usize, text: []const u8, tone: Tone, right: bool) !void {
        var clean: [512]u8 = undefined;
        const label = sidebar.directoryLabel(&clean, text, null);
        const padding = if (right) width -| sidebar.displayWidth(label) else 0;
        try card.w.print("\x1b[{d};{d}H{s}{s}", .{ row + 1, card.x + 4 + offset + padding, base, tone.ansi() });
        try sidebar.writeEllipsis(card.w, label, width - padding);
    }
    fn overviewRow(card: Card, row: usize, name: []const u8, model: []const u8, value: ?usage.View, tone: Tone) !void {
        const number_width: usize = 8;
        const text_width = card.width - 6 - 2 * (number_width + 1);
        const model_width = text_width / 2;
        const name_width = text_width - model_width - 1;
        try card.cell(row, 0, name_width, name, tone, false);
        try card.cell(row, name_width + 1, model_width, model, .muted, false);
        var token_buf: [32]u8 = undefined;
        var cache_buf: [32]u8 = undefined;
        var partial_buf: [40]u8 = undefined;
        const tokens = if (value) |v| (if (v.known)
            try std.fmt.bufPrint(&partial_buf, "{s}{s}", .{ if (v.partial) "≥" else "", compact(&token_buf, (v.tokens.input -| v.tokens.cached_input) +| v.tokens.output) })
        else
            "—") else "Tokens";
        const cached = if (value) |v| (if (v.known) compact(&cache_buf, v.tokens.cached_input) else "—") else "Cached";
        try card.cell(row, text_width + 1, number_width, tokens, .tokens, true);
        try card.cell(row, text_width + number_width + 2, number_width, cached, .muted, true);
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
    fn drawPoint(card: Card, row: usize, stamp: []const u8, label: []const u8, value: usage.View, live: bool, tone: Tone) !void {
        var text: [512]u8 = undefined;
        var cost: [64]u8 = undefined;
        var number: [32]u8 = undefined;
        const icon = if (live) "●" else "○";
        const right = if (value.known) try std.fmt.bufPrint(&cost, "{s}{s}{s}", .{ if (value.partial) "≥" else "", compact(&number, value.tokens.total()), if (live) "+" else "" }) else "—";
        try card.line(row, try std.fmt.bufPrint(&text, "{s}  {s}  {s}", .{ stamp, icon, label }), right, .text, if (value.known) .tokens else .muted);
        try card.w.print("\x1b[{d};{d}H{s}{s}{s}\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, card.x + 4, base, Tone.muted.ansi(), stamp, row + 1, card.x + 11, base, tone.ansi(), icon });
    }
    fn timeline(card: Card, row: usize, root: *const protocol.Conversation, agent: protocol.Agent, nodes: usize, pending: bool) !void {
        try card.line(row, "Recent activity", "Reported tokens", .text, .muted);
        const completed = nodes - @intFromBool(pending);
        for (root.timeline.points[root.timeline.points.len - completed ..], 0..) |point, i| {
            const seconds: time_c.time_t = @divFloor(point.at, 1000);
            var local: time_c.struct_tm = undefined;
            var stamp: [16]u8 = undefined;
            const time = if (time_c.localtime_r(&seconds, &local) != null)
                try std.fmt.bufPrint(&stamp, "{d:0>2}:{d:0>2}", .{ @as(u8, @intCast(local.tm_hour)), @as(u8, @intCast(local.tm_min)) })
            else
                "--:--";
            try card.drawPoint(row + 2 + i * 2, time, point.activity, point.usage, false, .muted);
            if (i + 1 < nodes) try card.line(row + 3 + i * 2, "       │", "", .border, .muted);
        }
        if (pending) {
            const active = agent.state == .working;
            const blocked = agent.state == .blocked;
            try card.drawPoint(row + 2 + completed * 2, if (active or blocked) "  now" else " last", if (active) "In progress" else if (blocked) "Needs input" else "Since last update", root.timeline.pending, active, if (active) .working else if (blocked) .blocked else .muted);
        }
    }
};
fn overviewTokens(buf: []u8, value: usage.View) []const u8 {
    if (!value.known) return "— tokens";
    var tokens: [32]u8 = undefined;
    var cached: [32]u8 = undefined;
    return std.fmt.bufPrint(buf, "{s}{s} tokens (+{s} cached)", .{
        if (value.partial) "≥" else "",
        compact(&tokens, (value.tokens.input -| value.tokens.cached_input) +| value.tokens.output),
        compact(&cached, value.tokens.cached_input),
    }) catch unreachable;
}
fn runningSomewhere(all: []const protocol.Conversation, item: protocol.Conversation, now: i64) bool {
    if (item.agent.state == .done) return false;
    if (item.attachments > 0) return true;
    switch (item.agent.state) {
        .working, .blocked, .initializing => {},
        else => return false,
    }
    const age = now - item.observed_at;
    if (item.observed_at <= 0 or age < 0 or age > 10 * std.time.us_per_s) return false;
    var parent = item.parent;
    for (0..@min(max, all.len)) |_| {
        const ancestor = find(all, parent orelse return false) orelse return false;
        if (ancestor.attachments > 0 and ancestor.agent.state != .done) return true;
        parent = ancestor.parent;
    }
    return false;
}
pub fn drawOverview(w: *std.Io.Writer, all: []const protocol.Conversation, system_usage: usage.View, system_working: bool, cols: u16, rows: u16) !void {
    if (cols < 40 or rows < 13) return;
    var total: usage.View = system_usage;
    const Row = struct {
        conversation: ?*const protocol.Conversation = null,
        value: usage.View,
    };
    var ranked: [max + 1]Row = undefined;
    ranked[0] = .{ .value = system_usage };
    var count: usize = 1;
    const now = std.time.microTimestamp();
    // Rows use exclusive own usage. Parents never include their children here.
    for (all) |*item| {
        add(&total, item.usage);
        if (!runningSomewhere(all, item.*, now)) continue;
        if (count < ranked.len) {
            ranked[count] = .{ .conversation = item, .value = item.usage };
            count += 1;
        }
    }
    std.mem.sort(Row, ranked[0..count], {}, struct {
        fn less(_: void, lhs: Row, rhs: Row) bool {
            const l = lhs.value.tokens.total();
            const r = rhs.value.tokens.total();
            return if (l == r)
                (if (lhs.conversation) |item| item.id else 0) < (if (rhs.conversation) |item| item.id else 0)
            else
                l > r;
        }
    }.less);
    // This total is observed runtime usage, rather than full session history.
    total.partial = false;
    const width: usize = @min(88, cols);
    const x: usize = @min(1, cols - width);
    const y: usize = 2;
    const shown: usize = @min(@min(10, count), rows - 9);
    const height: usize = 6 + shown;
    // Keep System in the same list, replacing the last visible agent if needed.
    const system_index = for (ranked[0..count], 0..) |item, i| {
        if (item.conversation == null) break i;
    } else unreachable;
    if (system_index >= shown) ranked[shown - 1] = ranked[system_index];
    try w.writeAll("\x1b7\x1b]8;;\x1b\\");
    for (0..height) |row| {
        try w.print("\x1b[{d};{d}H{s}{s}", .{ y + row + 1, x + 1, base, Tone.border.ansi() });
        try w.writeAll(if (row == 0) "╭" else if (row == height - 1) "╰" else "│");
        for (0..width - 2) |_| try w.writeAll(if (row == 0 or row == height - 1) "─" else " ");
        try w.writeAll(if (row == 0) "╮" else if (row == height - 1) "╯" else "│");
    }
    const card: Card = .{ .w = w, .x = x, .width = width };
    var text: [512]u8 = undefined;
    var tokens: [64]u8 = undefined;
    try card.line(y + 1, "Observed tokens", overviewTokens(&tokens, total), .title, .tokens);
    const heading = y + 3;
    const footer = y + height - 2;
    try card.overviewRow(heading, "Top agents", "Model", null, .text);
    for (ranked[0..shown], 0..) |ranked_row, i| {
        if (ranked_row.conversation == null) {
            try card.overviewRow(heading + 1 + i, if (system_working) "● System" else "○ System", "—", ranked_row.value, if (system_working) .working else .idle);
            continue;
        }
        const item = ranked_row.conversation.?;
        const row = heading + 1 + i;
        const agent_status = status(item.agent, false);
        var fallback: [80]u8 = undefined;
        const name = if (item.agent.name.len > 0) item.agent.name else try std.fmt.bufPrint(&fallback, "{s} · {s}", .{ @tagName(item.agent.provider), item.agent.session[0..@min(8, item.agent.session.len)] });
        try card.overviewRow(row, try std.fmt.bufPrint(&text, "{s} {s}", .{ agent_status.icon, name }), if (item.model.len > 0) item.model else "—", item.usage, .text);
        try w.print("\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, x + 4, base, agent_status.tone.ansi(), agent_status.icon });
    }
    if (shown < count) try card.line(footer, try std.fmt.bufPrint(&text, "... {d} more agents", .{count - shown}), "", .muted, .muted);
    try w.writeAll("\x1b[0m\x1b8");
}

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
    const children_available = childrenAvailable(all, parent, std.time.microTimestamp());
    if (!children_available) root_agent.subagents = .{};
    const name = if (entry.name.len > 0) entry.name else if (root_agent.name.len > 0) root_agent.name else @tagName(entry.provider);
    const model = if (children_available) Model.init(all, parent) else Model{ .total = root.usage };
    const width: usize = @min(88, cols);
    const pending = root_agent.state == .working or root_agent.state == .blocked or root.timeline.pending.tokens.total() > 0;
    const timeline_nodes: usize = if (root.timeline.points.len == 0) 0 else @min(4, root.timeline.points.len + @intFromBool(pending));
    const timeline_height = if (timeline_nodes > 0) timeline_nodes * 2 + 2 else 0;
    const wanted = (if (model.children == 0) @as(usize, if (timeline_height > 0) 13 else 12) else 14 + model.group_count * 2 + model.children * 3) + timeline_height;
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
    // Keep own metrics and group counts visible before spending vertical space
    // on older checkpoints or individual child details.
    const reserved_groups: usize = @min(model.group_count, 3);
    const child_rows = if (model.children > 0) 1 + 2 * reserved_groups else 0;
    const timeline_room = (end -| row) -| child_rows;
    const visible_nodes = @min(timeline_nodes, (timeline_room -| 2) / 2);
    if (visible_nodes > 0) {
        try card.timeline(row, root, root_agent, visible_nodes, pending);
        row += visible_nodes * 2 + 2;
    }
    if (model.children > 0 and row < end) {
        try card.line(row, try std.fmt.bufPrint(&text, "Total · agent + {d} subagent{s}", .{ model.children, if (model.children == 1) "" else "s" }), tokenText(&tokens_buf, model.total), .text, if (model.total.known) .tokens else .muted);
        row += 2;
    }
    var shown: usize = 0;
    for (model.groups[0..model.group_count], 0..) |group, group_index| {
        if (group_index > 0) row += 1;
        if (row >= end) break;
        try card.line(row, try std.fmt.bufPrint(&text, "{s} · {d}", .{ group.name, group.count }), tokenText(&tokens_buf, group.usage), .group, if (group.usage.known) .tokens else .muted);
        row += 1;
        for (all) |child| {
            if (!visibleChild(all, child, parent) or !std.ascii.eqlIgnoreCase(groupName(child), group.name)) continue;
            const remaining_headers = (model.group_count - group_index - 1) * 2;
            if (row + 3 + remaining_headers > end) break;
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
            var child_agent = child.agent;
            if (!childrenAvailable(all, child.id, std.time.microTimestamp())) child_agent.subagents = .{};
            try card.line(row, try std.fmt.bufPrint(&text, "  {s}", .{activity(child_agent)}), requests, .muted, .input);
            row += 1;
            if (child.usage.known) {
                try card.line(row, try std.fmt.bufPrint(&text, "  {s} cached", .{compact(&n1, child.usage.tokens.cached_input)}), try std.fmt.bufPrint(&metrics, "{s} recent", .{compact(&n2, child.usage.recent_tokens)}), .muted, .recent);
            } else try card.line(row, "  Usage not reported yet", "", .muted, .muted);
            row += 1;
            shown += 1;
        }
    }
    const footer = if (!children_available) (if (root.usage.known and root.usage.partial) "≥ Partial coverage" else "") else if (model.children == 0 and (entry.subagents.running > 0 or entry.subagents.blocked > 0)) "Updating child details…" else if (shown < model.children)
        try std.fmt.bufPrint(&text, "+{d} more{s}", .{ model.children - shown, if (model.total.partial) " · ≥ partial" else "" })
    else if (model.total.partial and model.total.known) "≥ Partial coverage" else if (model.children == 0) "No subagents" else "Live usage";
    try card.line(footer_row, footer, "Recent ≈ 5 min", if (model.total.partial and model.total.known) .working else .muted, .muted);
    try w.writeAll("\x1b[0m\x1b8");
}

test "idle children stay hidden while active descendants and usage remain" {
    const now = std.time.microTimestamp();
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "Scanning", .cwd = "", .tool_active = false };
    var all = [_]protocol.Conversation{
        .{ .id = 1, .attachments = 1, .agent = agent, .children_observed_at = now },
        .{ .id = 2, .parent = 1, .role = "Hidden role", .agent = agent, .observed_at = now, .usage = .{ .known = true, .tokens = .{ .input = 20 } } },
        .{ .id = 3, .parent = 2, .role = "Explorer", .agent = agent, .observed_at = now, .usage = .{ .known = true, .tokens = .{ .input = 30 } } },
    };
    all[0].agent.state = .idle;
    all[0].agent.name = "Visible parent";
    all[1].agent.state = .idle;
    all[1].agent.name = "Hidden child";
    all[2].agent.name = "Visible grandchild";
    var entry: sidebar.Entry = .{ .target = .{ .pane = 1 }, .conversation = 1, .provider = .codex, .state = .idle, .attention = .none };
    presentChildren(&entry, &all, now);
    try std.testing.expectEqual(@as(usize, 1), entry.children);
    const model = Model.init(&all, 1);
    try std.testing.expectEqual(@as(usize, 1), model.children);
    try std.testing.expectEqual(@as(usize, 1), model.group_count);
    try std.testing.expectEqual(@as(u64, 50), model.total.tokens.total());
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try draw(&output.writer, &all, entry, 100, 45, 5, 14);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Hidden child") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Hidden role") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Visible grandchild") != null);
    var overview: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer overview.deinit();
    try drawOverview(&overview.writer, &all, .{}, false, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, overview.written(), "Hidden child") == null);
    try std.testing.expect(std.mem.indexOf(u8, overview.written(), "Visible parent") != null);
    try std.testing.expect(std.mem.indexOf(u8, overview.written(), "50 tokens") != null);
    all[2].agent.state = .idle;
    presentChildren(&entry, &all, now);
    try std.testing.expectEqual(@as(usize, 0), entry.children);
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
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try drawOverview(&output.writer, &all, .{}, false, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "960 tokens") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "System") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Top agents") != null);
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
    try std.testing.expect(std.mem.indexOf(u8, text, "No subagents") == null);
    entries[0].exit = .{ .frame_ms = 1, .progress = 0.5 };
    try std.testing.expectEqual(null, sidebar.agentAt(view, &entries, 5, top));
}

test "timeline keeps own breakdown and child group counts in a compact terminal" {
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "Running tests", .cwd = "", .tool_active = false };
    const own: usage.View = .{ .known = true, .tokens = .{ .input = 11900, .cached_input = 7800, .output = 2800 }, .recent_tokens = 14700 };
    const points = [_]protocol.Conversation.ActivityPoint{
        .{ .at = 1000, .activity = "Reading source", .usage = .{ .known = true, .tokens = .{ .input = 1200 } } },
        .{ .at = 2000, .activity = "Tracing usage", .usage = .{ .known = true, .tokens = .{ .input = 5400 } } },
        .{ .at = 3000, .activity = "Running tests", .usage = .{ .known = true, .tokens = .{ .input = 7600 } } },
    };
    const all = [_]protocol.Conversation{
        .{ .id = 1, .agent = agent, .children_observed_at = std.time.microTimestamp(), .usage = own, .timeline = .{ .points = &points, .pending = .{ .known = true, .tokens = .{ .input = 500 } } } },
        .{ .id = 2, .parent = 1, .role = "Explorer", .agent = agent, .observed_at = std.time.microTimestamp() },
        .{ .id = 3, .parent = 1, .role = "Explorer", .agent = agent, .observed_at = std.time.microTimestamp() },
        .{ .id = 4, .parent = 1, .role = "Reviewer", .agent = agent, .observed_at = std.time.microTimestamp() },
    };
    const entry: sidebar.Entry = .{ .target = .{ .pane = 1 }, .conversation = 1, .provider = .codex, .state = .working, .attention = .none };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try draw(&output.writer, &all, entry, 64, 30, 5, 14);
    for ([_][]const u8{ "11.9k input", "2.8k output", "7.8k cached", "14.7k recent", "Reading source", "Tracing usage", "Running tests", "500+", "Explorer · 2", "Reviewer · 1" }) |text| {
        try std.testing.expect(std.mem.indexOf(u8, output.written(), text) != null);
    }
}

test "overview excludes detached history and shows System activity" {
    const now = std.time.microTimestamp();
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "", .cwd = "", .tool_active = false };
    var all = [_]protocol.Conversation{
        .{ .id = 1, .attachments = 1, .agent = agent },
        .{ .id = 2, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 900 } } },
        .{ .id = 3, .parent = 1, .observed_at = now, .agent = agent },
        .{ .id = 4, .parent = 2, .observed_at = now, .agent = agent },
        .{ .id = 5, .parent = 1, .observed_at = now - 11 * std.time.us_per_s, .agent = agent },
        .{ .id = 6, .attachments = 1, .agent = agent },
    };
    all[0].agent.state = .idle;
    all[0].agent.name = "Open session";
    all[1].agent.name = "Detached history";
    all[2].agent.name = "Live child";
    all[3].agent.name = "Detached child";
    all[4].agent.name = "Stale child";
    all[5].agent.state = .done;
    all[5].agent.name = "Ended session";
    for ([_]bool{ false, true }) |working| {
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        try drawOverview(&output.writer, &all, .{}, working, 100, 30);
        const frame = output.written();
        for ([_][]const u8{ "Open session", "Live child", "900 tokens", if (working) "● System" else "○ System" }) |text|
            try std.testing.expect(std.mem.indexOf(u8, frame, text) != null);
        for ([_][]const u8{ "Detached history", "Detached child", "Stale child", "Ended session", "more agents" }) |text|
            try std.testing.expect(std.mem.indexOf(u8, frame, text) == null);
    }
}

test "overview ranks all agents together and keeps System in small windows" {
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "Running tests", .cwd = "", .tool_active = false };
    var all = [_]protocol.Conversation{
        .{ .id = 1, .attachments = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 100 } } },
        .{ .id = 2, .parent = 1, .attachments = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 300 } } },
        .{ .id = 3, .attachments = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 900 } } },
        .{ .id = 4, .attachments = 1, .agent = agent },
    };
    all[0].model = "gpt-6";
    all[0].agent.name = "Parent task";
    all[1].agent.name = "Child task";
    all[2].agent.name = "Largest task";
    all[3].agent.name = "Unreported task";
    const system: usage.View = .{ .known = true, .tokens = .{ .input = 50 } };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try drawOverview(&output.writer, &all, system, false, 100, 30);
    const frame = output.written();
    try std.testing.expect(std.mem.indexOf(u8, frame, "gpt-6") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Cached") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "1.4k tokens") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "50") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Largest task").? < std.mem.indexOf(u8, frame, "Child task").?);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Child task").? < std.mem.indexOf(u8, frame, "Parent task").?);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Unreported task") != null);
    var small: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer small.deinit();
    try drawOverview(&small.writer, &all, system, false, 64, 13);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "System") != null);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "Largest") != null);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "Child") != null);

    var many: [12]protocol.Conversation = undefined;
    for (&many, 0..) |*item, i| {
        item.* = .{ .id = @intCast(i + 1), .attachments = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 1000 + i } } };
        item.agent.name = "Ranked task";
    }
    var capped: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer capped.deinit();
    try drawOverview(&capped.writer, &many, .{ .known = true, .tokens = .{ .input = 50, .cached_input = 30, .output = 5 } }, false, 100, 30);
    try std.testing.expectEqual(@as(usize, 9), std.mem.count(u8, capped.written(), "Ranked task"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, capped.written(), "System"));
    try std.testing.expect(std.mem.indexOf(u8, capped.written(), "25") != null);
    try std.testing.expect(std.mem.indexOf(u8, capped.written(), "... 3 more agents") != null);
}

test "unavailable or stale child discovery makes no subagent claims" {
    const now = std.time.microTimestamp();
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "parent", .activity = "Reading source", .cwd = "", .tool_active = false, .subagents = .{ .running = 2, .waiting = true } };
    var all = [_]protocol.Conversation{
        .{ .id = 1, .agent = agent },
        .{ .id = 2, .parent = 1, .agent = agent, .role = "Explorer" },
    };
    var entry: sidebar.Entry = .{ .target = .{ .pane = 1 }, .conversation = 1, .provider = .codex, .state = .working, .attention = .none };
    for ([_]i64{ 0, now - 11 * std.time.us_per_s }) |stamp| {
        all[0].children_observed_at = stamp;
        entry.subagents = agent.subagents;
        presentChildren(&entry, &all, now);
        try std.testing.expectEqual(@as(usize, 0), entry.children);
        try std.testing.expectEqual(@as(u32, 0), entry.subagents.running);
        try std.testing.expect(!entry.subagents.waiting);
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        try draw(&output.writer, &all, entry, 100, 30, 5, 14);
        for ([_][]const u8{ "subagent", "Explorer", "Updating child", "Total · agent" }) |text| try std.testing.expect(std.mem.indexOf(u8, output.written(), text) == null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "Own usage") != null);
    }
    all[0].children_observed_at = now;
    for (0..3) |case| {
        all[1].observed_at = if (case == 0) 0 else if (case == 1) now - 11 * std.time.us_per_s else now;
        all[1].agent.state = if (case == 2) .unknown else .working;
        entry.subagents = agent.subagents;
        presentChildren(&entry, &all, now);
        try std.testing.expectEqual(@as(usize, 0), entry.children);
        try std.testing.expect(!entry.subagents.waiting);
        var hidden: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer hidden.deinit();
        try draw(&hidden.writer, &all, entry, 100, 30, 5, 14);
        for ([_][]const u8{ "?", "subagent", "Explorer", "Total · agent" }) |text| try std.testing.expect(std.mem.indexOf(u8, hidden.written(), text) == null);
    }
    all[1].observed_at = now;
    all[1].agent.state = .working;
    entry.subagents = agent.subagents;
    presentChildren(&entry, &all, now);
    try std.testing.expectEqual(@as(usize, 1), entry.children);
    try std.testing.expectEqual(@as(u32, 2), entry.subagents.running);
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    entry.subagents = .{};
    all[0].agent.subagents = .{};
    try draw(&output.writer, all[0..1], entry, 100, 30, 5, 14);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "No subagents") != null);
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
