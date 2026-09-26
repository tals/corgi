//! Viewer-only grouping. Usage always belongs to individual conversations;
//! changing a role/activity label cannot move, reset, or duplicate its tokens.
const std = @import("std");
const protocol = @import("protocol.zig");
const sidebar = @import("sidebar.zig");
const usage = @import("live_usage.zig");
const max = @import("conversations.zig").max_actors;
const time_c = @cImport(@cInclude("time.h"));
const background = @import("background_tasks.zig");
const prices = @import("model_prices.zig");
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
/// Working with nothing reported yet: animated dots advance with the sidebar
/// spinner's redraws.
fn thinking() []const u8 {
    const dots: usize = @intCast(@mod(@divFloor(std.time.milliTimestamp(), 400), 3));
    return "..."[0 .. dots + 1];
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
    fn backgroundTasks(card: Card, row: usize, tasks: background.View, budget: usize) !usize {
        if (budget < 2 or tasks.items.len == 0) return 0;
        const age = std.time.microTimestamp() - tasks.observed_at;
        const live = tasks.live and age >= 0 and age <= 10 * std.time.us_per_s;
        try card.line(row, "Background commands", if (live) "Running" else "Last reported", .group, .muted);
        const shown = @min(tasks.items.len, budget - 1 - @as(usize, @intFromBool(tasks.items.len + 1 > budget or tasks.truncated)));
        var offset: usize = 1;
        inline for (std.meta.tags(background.Group)) |group| {
            for (tasks.items) |task| {
                if (task.group != group or offset > shown) continue;
                var label: [384]u8 = undefined;
                try card.line(row + offset, try std.fmt.bufPrint(&label, "{s} · {s}", .{ group.label(), task.label }), "", .text, .muted);
                offset += 1;
            }
        }
        if (shown < tasks.items.len or tasks.truncated) {
            var more: [64]u8 = undefined;
            try card.line(row + offset, try std.fmt.bufPrint(&more, "+{d}{s} more commands", .{ tasks.items.len - shown, if (tasks.truncated) "+" else "" }), "", .muted, .muted);
            offset += 1;
        }
        return offset;
    }
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
    const number_width: usize = 8;
    fn textWidth(card: Card) usize {
        return card.width - 6 - 2 * (number_width + 1);
    }
    /// Tokens are uncached input plus output; cached input is its own column.
    /// Null draws the column headings. Overview rows and the timeline share it.
    fn tokenColumns(card: Card, row: usize, value: ?usage.View, live: bool, tone: Tone) !void {
        const text_width = card.textWidth();
        var token_buf: [32]u8 = undefined;
        var cache_buf: [32]u8 = undefined;
        var tokens_text: [48]u8 = undefined;
        var cached_text: [48]u8 = undefined;
        const suffix = if (live) "+" else "";
        const tokens = if (value) |v| (if (v.known)
            try std.fmt.bufPrint(&tokens_text, "{s}{s}{s}", .{ if (v.partial) "≥" else "", compact(&token_buf, (v.tokens.input -| v.tokens.cached_input) +| v.tokens.output), suffix })
        else
            "—") else "Tokens";
        const cached = if (value) |v| (if (v.known)
            try std.fmt.bufPrint(&cached_text, "{s}{s}", .{ compact(&cache_buf, v.tokens.cached_input), suffix })
        else
            "—") else "Cached";
        try card.cell(row, text_width + 1, number_width, tokens, tone, true);
        try card.cell(row, text_width + number_width + 2, number_width, cached, .muted, true);
    }
    fn childRow(card: Card, row: usize, child: protocol.Conversation) !void {
        const text_width = card.textWidth();
        const prefix_width: usize = 11;
        const available = text_width -| prefix_width;
        const label = activity(child.agent);
        const name = if (child.agent.name.len > 0) child.agent.name else child.agent.session[0..@min(8, child.agent.session.len)];
        // Activity gets the space first; names use only the remainder, capped
        // so a long identity never displaces the description of the work.
        const name_width = @min(@as(usize, 18), available -| (sidebar.displayWidth(label) + 1));
        const label_width = available -| (if (name_width > 0) name_width + 1 else 0);
        const marker: Status = if (child.agent.attention == .needs_input or child.agent.state == .blocked)
            .{ .icon = "●", .label = "Needs input", .tone = .recent }
        else switch (child.agent.state) {
            .working => .{ .icon = "●", .label = "Working", .tone = .working },
            .done => .{ .icon = "✓", .label = "Done", .tone = .idle },
            .idle => .{ .icon = "●", .label = "Idle", .tone = .muted },
            else => status(child.agent, false),
        };
        try card.cell(row, 0, 9, "       ↳", .muted, false);
        try card.cell(row, 9, 1, marker.icon, marker.tone, false);
        try card.cell(row, prefix_width, label_width, label, .text, false);
        if (name_width > 0) try card.cell(row, text_width - name_width, name_width, name, .muted, true);
        try card.tokenColumns(row, child.usage, child.agent.state == .working, if (child.usage.known) .tokens else .muted);
    }
    /// Token columns plus a trailing column in reference-model tokens.
    fn overviewRow(card: Card, row: usize, name: []const u8, model: []const u8, value: ?usage.View, equivalent: []const u8, tone: Tone) !void {
        const columns: Card = .{ .w = card.w, .x = card.x, .width = card.width - (number_width + 1) };
        const text_width = columns.textWidth();
        // Model ids are short; the extra column comes out of their share.
        const model_width = @min(text_width / 2, 22);
        const name_width = text_width - model_width - 1;
        try card.cell(row, 0, name_width, name, tone, false);
        try card.cell(row, name_width + 1, model_width, model, .muted, false);
        try columns.tokenColumns(row, value, false, if (value == null) .tokens else .text);
        try card.cell(row, text_width + 2 * number_width + 3, number_width, equivalent, .tokens, true);
    }
    fn drawPoint(card: Card, row: usize, stamp: []const u8, label: []const u8, value: usage.View, live: bool, tone: Tone) !void {
        var text: [512]u8 = undefined;
        const icon = if (live) "●" else "○";
        try card.cell(row, 0, card.textWidth(), try std.fmt.bufPrint(&text, "{s}  {s}  {s}", .{ stamp, icon, label }), .text, false);
        try card.tokenColumns(row, value, live, if (value.known) .tokens else .muted);
        try card.w.print("\x1b[{d};{d}H{s}{s}{s}\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, card.x + 4, base, Tone.muted.ansi(), stamp, row + 1, card.x + 11, base, tone.ansi(), icon });
    }
    fn timeline(card: Card, row: usize, root: *const protocol.Conversation, agent: protocol.Agent, nodes: usize, pending: bool) !void {
        // A working agent without a summary has no current named phase. Keep
        // the previous interval in history until a fresh summary arrives.
        const unreported = agent.state == .working and agent.activity.len == 0 and !agent.compacting;
        const history_nodes = nodes - @intFromBool(unreported);
        const show_pending = pending and history_nodes > 0;
        const rule = "─" ** 88;
        const divider_width = card.width - 6;
        const label = " Recent ";
        try card.cell(row, 0, divider_width, rule[0 .. divider_width * "─".len], .border, false);
        try card.cell(row, (divider_width - label.len) / 2, label.len, label, .text, false);
        const completed = history_nodes - @intFromBool(show_pending);
        const history_end = root.timeline.points.len - @intFromBool(pending);
        for (root.timeline.points[history_end - completed .. history_end], 0..) |point, i| {
            const seconds: time_c.time_t = @divFloor(point.at, 1000);
            var local: time_c.struct_tm = undefined;
            var stamp: [16]u8 = undefined;
            const time = if (time_c.localtime_r(&seconds, &local) != null)
                try std.fmt.bufPrint(&stamp, "{d:0>2}:{d:0>2}", .{ @as(u8, @intCast(local.tm_hour)), @as(u8, @intCast(local.tm_min)) })
            else
                "--:--";
            try card.drawPoint(row + 1 + i, time, point.activity, point.usage, false, .muted);
        }
        if (show_pending) {
            const active = agent.state == .working and !unreported;
            const blocked = agent.state == .blocked;
            const latest = root.timeline.points[root.timeline.points.len - 1];
            try card.drawPoint(row + 1 + completed, if (active or blocked) "  now" else " last", latest.activity, root.timeline.pending, active, if (active) .working else if (blocked) .blocked else .muted);
        }
        if (unreported) {
            const current = if (agent.compacting) "Compacting…" else if (agent.subagents.waiting) "Waiting on subagents" else thinking();
            try card.drawPoint(row + nodes, "  now", current, .{}, true, .working);
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
/// The runtime's release and any newer one downloaded for the next launch.
pub const Release = struct { running: []const u8 = "", commit: []const u8 = "", staged: []const u8 = "" };
pub fn drawOverview(w: *std.Io.Writer, all: []const protocol.Conversation, system_usage: usage.View, system_working: bool, system_model: []const u8, release: Release, cols: u16, rows: u16) !void {
    if (cols < 40 or rows < 13) return;
    var total: usage.View = system_usage;
    const Row = struct {
        conversation: ?*const protocol.Conversation = null,
        value: usage.View,
        model: []const u8,
        // Uncached input plus output in reference-model tokens; raw for unknown models.
        equivalent: u64 = 0,
    };
    var ranked: [max + 1]Row = undefined;
    ranked[0] = .{ .value = system_usage, .model = system_model };
    var count: usize = 1;
    const now = std.time.microTimestamp();
    // Rows use exclusive own usage. Parents never include their children here.
    for (all) |*item| {
        add(&total, item.usage);
        if (!runningSomewhere(all, item.*, now)) continue;
        if (count < ranked.len) {
            ranked[count] = .{ .conversation = item, .value = item.usage, .model = item.model };
            count += 1;
        }
    }
    // Rank by spend: express every row in tokens of the priciest listed model.
    var reference: ?prices.Price = null;
    for (ranked[0..count]) |row| {
        const price = prices.lookup(row.model) orelse continue;
        if (reference == null or price.input > reference.?.input or (price.input == reference.?.input and price.output > reference.?.output)) {
            reference = price;
        }
    }
    for (ranked[0..count]) |*row| {
        const uncached = row.value.tokens.input -| row.value.tokens.cached_input;
        row.equivalent = if (reference != null and prices.lookup(row.model) != null)
            prices.equivalent(prices.lookup(row.model).?, reference.?, uncached, row.value.tokens.output)
        else
            uncached +| row.value.tokens.output;
    }
    std.mem.sort(Row, ranked[0..count], {}, struct {
        fn less(_: void, lhs: Row, rhs: Row) bool {
            const l = lhs.equivalent;
            const r = rhs.equivalent;
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
    // Keep Corgi's own row in the same list, replacing the last visible agent if needed.
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
    var reference_heading: [32]u8 = undefined;
    try card.overviewRow(heading, "Top agents", "Model", null, if (reference) |price| try std.fmt.bufPrint(&reference_heading, "≈{s}", .{price.label}) else "", .text);
    var equivalent_text: [48]u8 = undefined;
    for (ranked[0..shown], 0..) |ranked_row, i| {
        const model = if (ranked_row.model.len == 0)
            "—"
        else
            ranked_row.model;
        const equivalent = if (reference == null)
            ""
        else if (!ranked_row.value.known)
            "—"
        else if (prices.lookup(ranked_row.model) == null)
            "?"
        else
            try std.fmt.bufPrint(&equivalent_text, "{s}{s}", .{ if (ranked_row.value.partial) "≥" else "", compact(&tokens, ranked_row.equivalent) });
        if (ranked_row.conversation == null) {
            try card.overviewRow(heading + 1 + i, if (system_working) "● Corgi (Activity summarizer)" else "○ Corgi (Activity summarizer)", model, ranked_row.value, equivalent, if (system_working) .working else .idle);
            continue;
        }
        const item = ranked_row.conversation.?;
        const row = heading + 1 + i;
        const agent_status = status(item.agent, false);
        var fallback: [80]u8 = undefined;
        const name = if (item.agent.name.len > 0) item.agent.name else try std.fmt.bufPrint(&fallback, "{s} · {s}", .{ @tagName(item.agent.provider), item.agent.session[0..@min(8, item.agent.session.len)] });
        try card.overviewRow(row, try std.fmt.bufPrint(&text, "{s} {s}", .{ agent_status.icon, name }), model, item.usage, equivalent, .text);
        try w.print("\x1b[{d};{d}H{s}{s}{s}", .{ row + 1, x + 4, base, agent_status.tone.ansi(), agent_status.icon });
    }
    const more = if (shown < count) try std.fmt.bufPrint(&text, "... {d} more agents", .{count - shown}) else "";
    var running_buf: [64]u8 = undefined;
    var staged_buf: [64]u8 = undefined;
    var version_text: [160]u8 = undefined;
    const running = @import("updates.zig").label(&running_buf, release.running, release.commit);
    const staged = @import("updates.zig").label(&staged_buf, release.staged, "");
    // Prefer the most complete version text that still leaves room for the agent count.
    const room = (width - 6) -| (if (more.len > 0) sidebar.displayWidth(more) + 2 else 0);
    const candidates = if (staged.len > 0) [_][]const u8{
        try std.fmt.bufPrint(&version_text, "↑ Update {s} ready · relaunch Corgi", .{staged}),
        "↑ Update ready · relaunch Corgi",
        "↑ Update ready",
    } else [_][]const u8{ if (running.len > 0) try std.fmt.bufPrint(&version_text, "Corgi {s}", .{running}) else "", running, "" };
    const version_line = for (candidates) |candidate| {
        if (sidebar.displayWidth(candidate) <= room) break candidate;
    } else "";
    try card.line(footer, more, version_line, .muted, if (staged.len > 0) .idle else .muted);
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
    const pending = root.timeline.points.len > 0;
    const timeline_nodes: usize = @min(4, root.timeline.points.len + @intFromBool(root_agent.state == .working and root_agent.activity.len == 0 and !root_agent.compacting));
    const timeline_height = if (timeline_nodes > 0) timeline_nodes + 1 else 0;
    const child_footer = children_available and model.children == 0;
    const task_height = if (root.background_tasks.items.len > 0) @min(8, root.background_tasks.items.len + 1 + @as(usize, @intFromBool(root.background_tasks.truncated))) else 0;
    const wanted = 7 + timeline_height + task_height +
        (if (model.children > 0) model.children + 3 else @as(usize, @intFromBool(child_footer)));
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
    const top = y + 1;
    const root_status = status(root_agent, false);
    try card.line(top, name, try std.fmt.bufPrint(&text, "{s} {s}", .{ root_status.icon, root_status.label }), .title, root_status.tone);
    const root_activity = if (root_agent.activity.len == 0 and root_agent.recent_activity.len == 0 and
        !root_agent.tool_active and !root_agent.compacting and !root_agent.subagents.waiting and root_agent.state == .working)
        thinking()
    else
        activity(root_agent);
    const subtitle = if (timeline_nodes > 0)
        @tagName(root_agent.provider)
    else if (std.ascii.eqlIgnoreCase(name, @tagName(root_agent.provider)))
        root_activity
    else
        try std.fmt.bufPrint(&text, "{s} · {s}", .{ @tagName(root_agent.provider), root_activity });
    try card.line(top + 1, subtitle, "", .muted, .muted);
    try card.tokenColumns(top + 2, null, false, .muted);
    try card.cell(top + 3, 0, card.textWidth(), "Total", .text, false);
    try card.tokenColumns(top + 3, root.usage, false, if (root.usage.known) .tokens else .muted);
    var row = top + 4;
    const footer_row = y + height - 2;
    const end = if (model.children > 0 or child_footer) footer_row else y + height - 1;
    // Give requested background work priority on short terminals. The section
    // stays bounded and reports omitted commands explicitly.
    row += try card.backgroundTasks(row, root.background_tasks, @min(task_height, end -| row));
    // Reserve child rows and the combined total; use the rest for recent phases.
    const room = end -| row;
    const total_rows: usize = if (model.children > 0) 2 else 0;
    const reserved_children = @min(model.children, room -| (total_rows + @as(usize, if (timeline_nodes > 0) 2 else 0)));
    const visible_nodes = @min(timeline_nodes, (room -| (reserved_children + total_rows)) -| 1);
    if (visible_nodes > 0) {
        try card.timeline(row, root, root_agent, visible_nodes, pending);
        row += visible_nodes + 1;
    }
    var shown: usize = 0;
    if (children_available) for (all) |child| {
        if (!visibleChild(all, child, parent)) continue;
        if (row + total_rows >= end) break;
        var display_child = child;
        if (!childrenAvailable(all, child.id, std.time.microTimestamp())) display_child.agent.subagents = .{};
        try card.childRow(row, display_child);
        row += 1;
        shown += 1;
    };
    if (model.children > 0 and row + 1 < end) {
        row += 1;
        try card.cell(row, 0, card.textWidth(), "Including subagents", .text, false);
        try card.tokenColumns(row, model.total, false, if (model.total.known) .tokens else .muted);
    }
    const footer = if (!children_available) "" else if (model.children == 0 and (entry.subagents.running > 0 or entry.subagents.blocked > 0)) "Updating child details…" else if (shown < model.children)
        try std.fmt.bufPrint(&text, "+{d} more", .{model.children - shown})
    else if (model.children == 0) "No subagents" else "Live usage";
    if (model.children > 0 or child_footer) try card.line(footer_row, footer, "", .muted, .muted);
    try w.writeAll("\x1b[0m\x1b8");
}

test "compact child rows prioritize activity and color only the status and secondary name" {
    var child: protocol.Conversation = .{ .id = 2, .agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .name = "Maxwell with a long name", .activity = "Tracing activity integration", .cwd = "", .tool_active = false }, .usage = .{ .known = true, .tokens = .{ .input = 1000, .cached_input = 800 } } };
    for ([_]@import("agents.zig").State{ .working, .blocked, .idle, .done }) |state| {
        child.agent.state = state;
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        const card: Card = .{ .w = &output.writer, .x = 0, .width = 88 };
        try card.childRow(0, child);
        const frame = output.written();
        try std.testing.expect(std.mem.indexOf(u8, frame, "Tracing activity integration") != null);
        try std.testing.expect(std.mem.indexOf(u8, frame, "Maxwell with a lo…") != null);
        const tone: Tone = switch (state) {
            .working => .working,
            .blocked => .recent,
            .done => .idle,
            else => .muted,
        };
        var marker: [64]u8 = undefined;
        try std.testing.expect(std.mem.indexOf(u8, frame, try std.fmt.bufPrint(&marker, "{s}{s}", .{ tone.ansi(), if (state == .done) "✓" else "●" })) != null);
        try std.testing.expect(std.mem.indexOf(u8, frame, "200") != null);
        try std.testing.expect(std.mem.indexOf(u8, frame, "800") != null);
    }
    var narrow: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer narrow.deinit();
    try (Card{ .w = &narrow.writer, .x = 0, .width = 64 }).childRow(0, child);
    try std.testing.expect(std.mem.indexOf(u8, narrow.written(), "Tracing activity integration") != null);
    try std.testing.expect(std.mem.indexOf(u8, narrow.written(), "Maxwell") == null);
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
    try drawOverview(&overview.writer, &all, .{}, false, "gpt-6-luna", .{}, 100, 30);
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
    try drawOverview(&output.writer, &all, .{}, false, "gpt-6-luna", .{}, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "960 tokens") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Corgi (Activity summarizer)") != null);
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
    try std.testing.expect(std.mem.indexOf(u8, text, "Total") != null);
    try std.testing.expectEqual(@as(usize, 2), std.mem.count(u8, text, "—"));
    try std.testing.expect(std.mem.indexOf(u8, text, "Starting session") != null);
    try std.testing.expect(std.mem.indexOf(u8, text, "No subagents") == null);
    entries[0].exit = .{ .frame_ms = 1, .progress = 0.5 };
    try std.testing.expectEqual(null, sidebar.agentAt(view, &entries, 5, top));
}

test "total shares one set of timeline columns with compact child rows" {
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
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output.written(), "Tokens"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output.written(), "Cached"));
    for ([_][]const u8{ "Total", "Tokens", "Cached", "6.9k", "7.8k", "Reading source", "Tracing usage", "Running tests", "500+", "Including subagents", "↳" }) |text| {
        try std.testing.expect(std.mem.indexOf(u8, output.written(), text) != null);
    }
}

test "timeline renders each phase once with its own interval including idle and clipped views" {
    const points = [_]protocol.Conversation.ActivityPoint{
        .{ .at = 1000, .activity = "Reviewing pending changes", .usage = .{ .known = true, .tokens = .{ .input = 21500, .cached_input = 12800 } } },
        .{ .at = 2000, .activity = "Inspecting repository changes", .usage = .{ .known = true } },
    };
    var root: protocol.Conversation = .{ .id = 1, .agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "Inspecting repository changes", .cwd = "", .tool_active = false }, .timeline = .{ .points = &points, .pending = .{ .known = true, .tokens = .{ .input = 99600, .cached_input = 78700 } } } };
    for ([_]@import("agents.zig").State{ .working, .blocked, .idle }) |state| {
        root.agent.state = state;
        for (1..3) |nodes| {
            var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
            defer output.deinit();
            const card: Card = .{ .w = &output.writer, .x = 0, .width = 88 };
            try card.timeline(0, &root, root.agent, nodes, true);
            const frame = output.written();
            const latest = std.mem.indexOf(u8, frame, "Inspecting repository changes").?;
            try std.testing.expect(std.mem.indexOf(u8, frame[latest + 1 ..], "Inspecting repository changes") == null);
            try std.testing.expect(std.mem.indexOf(u8, frame[latest..], if (state == .working) "20.9k+" else "20.9k") != null);
            try std.testing.expect(std.mem.indexOf(u8, frame[latest..], "78.7k") != null);
            try std.testing.expect(std.mem.indexOf(u8, frame, "In progress") == null);
            if (nodes == 2) {
                try std.testing.expect(std.mem.indexOf(u8, frame[0..latest], "Reviewing pending changes") != null);
                try std.testing.expect(std.mem.indexOf(u8, frame[0..latest], "8.7k") != null);
                try std.testing.expect(std.mem.indexOf(u8, frame[0..latest], "12.8k") != null);
            } else try std.testing.expect(std.mem.indexOf(u8, frame, "Reviewing pending changes") == null);
        }
    }
}

test "new turn without a summary keeps the old label historical even when clipped" {
    const points = [_]protocol.Conversation.ActivityPoint{
        .{ .at = 1000, .activity = "Inspecting installer script", .usage = .{ .known = true } },
    };
    var root: protocol.Conversation = .{ .id = 1, .agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "", .recent_activity = "Old tool", .cwd = "", .tool_active = false }, .timeline = .{ .points = &points, .pending = .{ .known = true, .tokens = .{ .input = 345 } } } };
    for (1..3) |nodes| {
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        const card: Card = .{ .w = &output.writer, .x = 0, .width = 88 };
        try card.timeline(0, &root, root.agent, nodes, true);
        const frame = output.written();
        try std.testing.expect(std.mem.indexOf(u8, frame, "  now  ●  .") != null);
        try std.testing.expect(std.mem.indexOf(u8, frame, "Old tool") == null);
        try std.testing.expect(std.mem.indexOf(u8, frame, "345+") == null);
        if (nodes == 2) {
            try std.testing.expect(std.mem.indexOf(u8, frame, " last  ○  Inspecting installer script") != null);
        } else try std.testing.expect(std.mem.indexOf(u8, frame, "Inspecting installer script") == null);
    }
    root.timeline = .{};
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const card: Card = .{ .w = &output.writer, .x = 0, .width = 88 };
    try card.timeline(0, &root, root.agent, 1, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "  now  ●  .") != null);
}

test "compaction is the current timeline phase even before the first summary" {
    const points = [_]protocol.Conversation.ActivityPoint{
        .{ .at = 1000, .activity = "Compacting context", .usage = .{ .known = true } },
    };
    for ([_][]const u8{ "", "Old inferred activity" }) |label| {
        const root: protocol.Conversation = .{ .id = 1, .agent = .{
            .provider = .codex,
            .state = .working,
            .attention = .none,
            .session = "test",
            .activity = label,
            .cwd = "",
            .tool_active = false,
            .compacting = true,
        }, .timeline = .{ .points = &points, .pending = .{ .known = true, .tokens = .{ .input = 345 } } } };
        const entry: sidebar.Entry = .{ .target = .{ .pane = 1 }, .conversation = 1, .provider = .codex, .state = .working, .attention = .none };
        var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
        defer output.deinit();
        try draw(&output.writer, &.{root}, entry, 64, 13, 5, 8);
        try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, output.written(), "Compacting context"));
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "now  ●  Compacting context") != null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "345+") != null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "Old inferred activity") == null);
    }
}

test "overview excludes detached history and shows Corgi activity" {
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
        try drawOverview(&output.writer, &all, .{}, working, "gpt-6-luna", .{}, 100, 30);
        const frame = output.written();
        for ([_][]const u8{ "Open session", "Live child", "900 tokens", if (working) "● Corgi (Activity summarizer)" else "○ Corgi (Activity summarizer)" }) |text|
            try std.testing.expect(std.mem.indexOf(u8, frame, text) != null);
        for ([_][]const u8{ "Detached history", "Detached child", "Stale child", "Ended session", "more agents" }) |text|
            try std.testing.expect(std.mem.indexOf(u8, frame, text) == null);
    }
}

test "overview ranks all agents together and keeps Corgi in small windows" {
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
    try drawOverview(&output.writer, &all, system, false, "gpt-6-luna", .{}, 100, 30);
    const frame = output.written();
    try std.testing.expect(std.mem.indexOf(u8, frame, "gpt-6-luna") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "gpt-6") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Cached") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "1.4k tokens") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "50") != null);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Largest task").? < std.mem.indexOf(u8, frame, "Child task").?);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Child task").? < std.mem.indexOf(u8, frame, "Parent task").?);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Unreported task") != null);
    var small: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer small.deinit();
    try drawOverview(&small.writer, &all, system, false, "gpt-6-luna", .{}, 64, 13);
    // Narrow cards clip the label; the Corgi prefix stays visible.
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "○ Corgi") != null);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "Largest") != null);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "Child") != null);

    // Cached-heavy agents must not outrank larger displayed Tokens values.
    all[0].usage.tokens = .{ .input = 10000, .cached_input = 9990 };
    var sorted: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer sorted.deinit();
    try drawOverview(&sorted.writer, &all, system, false, "gpt-6-luna", .{}, 100, 30);
    const sorted_frame = sorted.written();
    try std.testing.expect(std.mem.indexOf(u8, sorted_frame, "Child task").? < std.mem.indexOf(u8, sorted_frame, "Corgi (Activity summarizer)").?);
    try std.testing.expect(std.mem.indexOf(u8, sorted_frame, "Corgi (Activity summarizer)").? < std.mem.indexOf(u8, sorted_frame, "Parent task").?);

    var many: [12]protocol.Conversation = undefined;
    for (&many, 0..) |*item, i| {
        item.* = .{ .id = @intCast(i + 1), .attachments = 1, .agent = agent, .usage = .{ .known = true, .tokens = .{ .input = 1000 + i } } };
        item.agent.name = "Ranked task";
    }
    var capped: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer capped.deinit();
    try drawOverview(&capped.writer, &many, .{ .known = true, .tokens = .{ .input = 50, .cached_input = 30, .output = 5 } }, false, "gpt-6-luna", .{}, 100, 30);
    try std.testing.expectEqual(@as(usize, 9), std.mem.count(u8, capped.written(), "Ranked task"));
    try std.testing.expectEqual(@as(usize, 1), std.mem.count(u8, capped.written(), "Corgi (Activity summarizer)"));
    try std.testing.expect(std.mem.indexOf(u8, capped.written(), "25") != null);
    try std.testing.expect(std.mem.indexOf(u8, capped.written(), "... 3 more agents") != null);
}

test "overview ranks by tokens of the priciest listed model" {
    const agent: protocol.Agent = .{ .provider = .claude, .state = .working, .attention = .none, .session = "test", .activity = "Running tests", .cwd = "", .tool_active = false };
    var all = [_]protocol.Conversation{
        .{ .id = 1, .attachments = 1, .agent = agent, .model = "claude-haiku-4-5-20251001", .usage = .{ .known = true, .tokens = .{ .input = 42_000, .cached_input = 2_000, .output = 2_000 } } },
        .{ .id = 2, .attachments = 1, .agent = agent, .model = "claude-opus-5", .usage = .{ .known = true, .tokens = .{ .input = 12_000, .cached_input = 2_000, .output = 1_000 } } },
        .{ .id = 3, .attachments = 1, .agent = agent, .model = "codex-auto-review", .usage = .{ .known = true, .tokens = .{ .input = 5_000 } } },
    };
    all[0].agent.name = "Haiku task";
    all[1].agent.name = "Opus task";
    all[2].agent.name = "Unpriced task";
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try drawOverview(&output.writer, &all, .{}, false, "gpt-6-luna", .{}, 100, 30);
    const frame = output.written();
    // Haiku 42k raw is 8.4k in Opus tokens, below Opus's own 11k.
    try std.testing.expect(std.mem.indexOf(u8, frame, "Opus task").? < std.mem.indexOf(u8, frame, "Haiku task").?);
    try std.testing.expect(std.mem.indexOf(u8, frame, "Haiku task").? < std.mem.indexOf(u8, frame, "Unpriced task").?);
    for ([_][]const u8{ "≈opus", "claude-opus-5", "8.4k", "11k", "42k", "?" }) |text| {
        try std.testing.expect(std.mem.indexOf(u8, frame, text) != null);
    }
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
        for ([_][]const u8{ "subagent", "Explorer", "Updating child", "Including subagents" }) |text| try std.testing.expect(std.mem.indexOf(u8, output.written(), text) == null);
        try std.testing.expect(std.mem.indexOf(u8, output.written(), "Total") != null);
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
        for ([_][]const u8{ "?", "subagent", "Explorer", "Including subagents" }) |text| try std.testing.expect(std.mem.indexOf(u8, hidden.written(), text) == null);
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

test "background command rows group tasks and bound overflow without claiming stale work is live" {
    const items = [_]background.View.Item{
        .{ .id = "server", .label = "bun run dev", .group = .servers },
        .{ .id = "tests", .label = "Parser tests", .group = .tests },
        .{ .id = "build", .label = "Release build", .group = .builds },
    };
    var tasks: background.View = .{ .items = &items, .observed_at = std.time.microTimestamp(), .live = true };
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    const card: Card = .{ .w = &output.writer, .x = 0, .width = 64 };
    try std.testing.expectEqual(@as(usize, 4), try card.backgroundTasks(0, tasks, 4));
    const frame = output.written();
    try std.testing.expect(std.mem.indexOf(u8, frame, "Tests · Parser tests").? < std.mem.indexOf(u8, frame, "Servers · bun run dev").?);
    tasks.observed_at -= 11 * std.time.us_per_s;
    var small: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer small.deinit();
    try std.testing.expectEqual(@as(usize, 3), try (Card{ .w = &small.writer, .x = 0, .width = 40 }).backgroundTasks(0, tasks, 3));
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "Last reported") != null);
    try std.testing.expect(std.mem.indexOf(u8, small.written(), "+2 more commands") != null);
}

test "overview footer shows the running release and a staged update" {
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "", .cwd = "", .tool_active = false };
    const all = [_]protocol.Conversation{.{ .id = 1, .attachments = 1, .agent = agent }};
    var current: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer current.deinit();
    try drawOverview(&current.writer, &all, .{}, false, "", .{ .running = "20260925T183012Z-be82c7b9090a", .commit = "be82c7b9090a5f7e" }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, current.written(), "Corgi 2026-09-25 · be82c7b") != null);
    try std.testing.expect(std.mem.indexOf(u8, current.written(), "Update") == null);
    var ready: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer ready.deinit();
    const release: Release = .{ .running = "20260925T183012Z-be82c7b9090a", .staged = "20260926T090000Z-a1b2c3d4e5f6" };
    try drawOverview(&ready.writer, &all, .{}, false, "", release, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, ready.written(), "↑ Update 2026-09-26 · a1b2c3d ready · relaunch Corgi") != null);
    var narrow: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer narrow.deinit();
    try drawOverview(&narrow.writer, &all, .{}, false, "", release, 40, 13);
    try std.testing.expect(std.mem.indexOf(u8, narrow.written(), "↑ Update ready · relaunch Corgi") != null);
}

test "overview footer names a development build's commit" {
    const agent: protocol.Agent = .{ .provider = .codex, .state = .working, .attention = .none, .session = "test", .activity = "", .cwd = "", .tool_active = false };
    const all = [_]protocol.Conversation{.{ .id = 1, .attachments = 1, .agent = agent }};
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try drawOverview(&output.writer, &all, .{}, false, "", .{ .running = "0.1.0-dev", .commit = "0123abcdef45-dirty" }, 100, 30);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "Corgi 0.1.0-dev · 0123abc-dirty") != null);
}
