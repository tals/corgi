const std = @import("std");
const os = @import("os.zig");
const palette = @import("palette.zig");
const frames = @import("corgi_frames.zig");

const gait_right = [_][]const u8{ "~[/\\]o>", "~[||]o>", "~[\\/]o>", "~[||]o>" };
const gait_left_carry = [_][]const u8{ "●‹o[/\\]~", "●‹o[||]~", "●‹o[\\/]~", "●‹o[||]~" };
const FetchScene = struct {
    dog: []const u8,
    x: usize = 0,
    ball: ?usize = null,
    mark: []const u8 = "⢀",
};
fn stage(phase: *usize, duration: usize) bool {
    if (phase.* < duration) return true;
    phase.* -= duration;
    return false;
}
fn fetchKeyframe(width: usize, step: usize) FetchScene {
    std.debug.assert(width >= 18);
    var p = step % (3 * width + 11);
    const rest = "~ᐯ•ᴥ•ᐯ";
    const alert = "~ᐯ•ᴥ•ᐱ";
    const held = "~ᐯ•●•ᐯ";
    const end = width - 1;
    if (stage(&p, 8)) return .{ .dog = if (p == 4) "~ᐯ◡ᴥ◡ᐯ" else rest };
    if (stage(&p, 6)) return .{ .dog = rest, .ball = 6 + p, .mark = ([_][]const u8{ "⠄", "⠂", "⠁", "⠂", "⠄", "⡀" })[p] };
    if (stage(&p, 4)) return .{ .dog = alert, .ball = 12 + p, .mark = ([_][]const u8{ "⠄", "⠂", "⠄", "⡀" })[p] };
    if (stage(&p, width - 16)) return .{ .dog = alert, .ball = 16 + p, .mark = "⡀" };
    if (stage(&p, 3)) return .{ .dog = alert, .ball = end };
    if (stage(&p, 2)) return .{ .dog = gait_right[1], .ball = end };
    if (stage(&p, width - 8)) return .{ .dog = gait_right[(p + 1) % 4], .x = p + 1, .ball = end };
    if (stage(&p, 2)) return .{ .dog = gait_right[1], .x = width - 8, .ball = end };
    if (stage(&p, 2)) return .{ .dog = "~[||]o●", .x = width - 8 };
    if (stage(&p, 5)) return .{ .dog = held, .x = width - 8 };
    if (stage(&p, 2)) return .{ .dog = gait_left_carry[1], .x = width - 9 };
    if (stage(&p, width - 8)) return .{ .dog = gait_left_carry[p % 4], .x = width - 9 - p };
    if (stage(&p, 3)) return .{ .dog = held };
    if (stage(&p, 3)) return .{ .dog = rest };
    return .{ .dog = rest };
}
// Insert a right-half dot between adjacent whole-cell ball positions.
// Dog motion and pauses remain at their original 200 ms timing.
fn fetchScene(width: usize, step: usize) FetchScene {
    var current = fetchKeyframe(width, step / 2);
    if (step % 2 == 0) return current;
    const next = fetchKeyframe(width, step / 2 + 1);
    if (current.ball) |ball| {
        if (next.ball) |next_ball| {
            if (next_ball == ball or next_ball == ball + 1) {
                const left = [_][]const u8{ "⠁", "⠂", "⠄", "⡀" };
                const right = [_][]const u8{ "⠈", "⠐", "⠠", "⢀" };
                for (left, right) |from, to| {
                    if (std.mem.eql(u8, current.mark, from)) {
                        current.mark = to;
                        break;
                    }
                }
                // React on the very next (100 ms) frame after floor contact.
                if (std.mem.eql(u8, current.dog, "~ᐯ•ᴥ•ᐯ") and std.mem.eql(u8, next.dog, "~ᐯ•ᴥ•ᐱ")) current.dog = next.dog;
            }
        }
    }
    return current;
}
fn writeFetch(out: *std.Io.Writer, width: usize, step: usize) !void {
    const scene = fetchScene(width, step);
    var dog = (std.unicode.Utf8View.init(scene.dog) catch unreachable).iterator();
    for (0..width) |col| {
        if (scene.ball == col) {
            try out.writeAll(scene.mark);
        } else if (col >= scene.x) {
            const glyph = dog.nextCodepointSlice() orelse " ";
            try out.writeAll(if (std.mem.eql(u8, glyph, "~")) wagTail(step / 4) else glyph);
        } else try out.writeByte(' ');
    }
}

fn wagTail(step: usize) []const u8 {
    return ([_][]const u8{ "~", "-", "~", "^" })[step % 4];
}

// Once per compaction, the corgi herds the scattered letters of the word
// together, sits, and curls up into the ellipsis after it.
pub const herd_width = 18;
const herd_step_ms = 110;
const herd_sit_steps = 10;
const herd_word = "Compacting";
const walk_left = [_][]const u8{ "‹o[/\\]~", "‹o[||]~", "‹o[\\/]~", "‹o[||]~" };
const word_bright = palette.Token.text.rgb();
const word_dim = palette.Token.faint.rgb();
/// The corgi is gray, never a status color.
const awake_color = palette.Token.text.rgb();
/// Tail tucked, ears folded, rolled into "…": each pose's column after the word.
const curl = [_]struct { after: usize, pose: []const u8 }{
    .{ .after = 2, .pose = "ᐯ◡ᴥ◡ᐯ" },
    .{ .after = 2, .pose = "ᐯ◡ᴥ◡ᐯ" },
    .{ .after = 3, .pose = "◡ᴥ◡" },
    .{ .after = 2, .pose = "•ᴥ•" },
    .{ .after = 1, .pose = "•.•" },
    .{ .after = 0, .pose = "..." },
    .{ .after = 0, .pose = "…" },
};

const HerdScene = struct {
    letters: [herd_word.len]usize,
    /// Settled letters, and those being pushed, are bright.
    lit: [herd_word.len]bool,
    dog: []const u8,
    x: usize,
};
/// Where each letter rests while scattered. The gaps sum to 10, so the last
/// letter stops one cell short of the edge.
fn herdSpread(width: usize) [herd_word.len]usize {
    const gaps = [_]usize{ 1, 2, 0, 2, 1, 0, 2, 1, 1 };
    var spread: [herd_word.len]usize = undefined;
    spread[0] = 0;
    var sum: usize = 0;
    for (gaps, 1..) |gap, i| {
        sum += gap;
        spread[i] = i + sum * (width - herd_word.len - 1) / 10;
    }
    return spread;
}
fn herdScene(width: usize, step: usize) HerdScene {
    std.debug.assert(width >= herd_width);
    const last = herd_word.len - 1;
    const spread = herdSpread(width);
    // The nose enters from past the edge and stops just after the word.
    const roundup = width - last;
    if (step < roundup) {
        const nose = width - step;
        var scene: HerdScene = .{ .letters = spread, .lit = undefined, .dog = walk_left[step % 4], .x = nose };
        scene.letters[last] = @min(spread[last], nose - 1);
        var i: usize = last;
        while (i > 0) : (i -= 1) scene.letters[i - 1] = @min(spread[i - 1], scene.letters[i] - 1);
        for (&scene.lit, scene.letters, spread, 0..) |*lit, at, rest, n| lit.* = at == n or at < rest;
        return scene;
    }
    var scene: HerdScene = .{ .letters = undefined, .lit = @splat(true), .dog = "~ᐯ•ᴥ•ᐯ", .x = herd_word.len + 1 };
    for (&scene.letters, 0..) |*letter, i| letter.* = i;
    const p = step - roundup;
    if (p == 6) scene.dog = "~ᐯ◡ᴥ◡ᐯ";
    if (p >= herd_sit_steps) {
        const pose = curl[@min(p - herd_sit_steps, curl.len - 1)];
        scene.dog = pose.pose;
        scene.x = herd_word.len + pose.after;
    }
    return scene;
}
fn writeHerd(out: *std.Io.Writer, width: usize, step: usize) !void {
    const scene = herdScene(width, step);
    var dog = (std.unicode.Utf8View.init(scene.dog) catch unreachable).iterator();
    var letter: usize = 0;
    var color: ?[3]u8 = null;
    for (0..width) |col| {
        if (col >= scene.x) if (dog.nextCodepointSlice()) |glyph| {
            try tint(out, &color, awake_color);
            try out.writeAll(if (std.mem.eql(u8, glyph, "~")) wagTail(step / 2) else glyph);
            continue;
        };
        if (letter < herd_word.len and scene.letters[letter] == col) {
            try tint(out, &color, if (scene.lit[letter]) word_bright else word_dim);
            try out.writeByte(herd_word[letter]);
            letter += 1;
        } else try out.writeByte(' ');
    }
}
fn tint(out: *std.Io.Writer, current: *?[3]u8, color: [3]u8) !void {
    if (current.*) |shown| if (std.mem.eql(u8, &shown, &color)) return;
    current.* = color;
    try writeColor(out, color);
}

// While a reopened agent resumes, the corgi digs "Restoring…" out from
// under dirt, nearest letter first, flinging the dirt onto a pile behind
// it, then turns and wags.
pub const unearth_width = 27;
const unearth_step_ms = 80;
/// Steps the corgi digs at each letter.
const unearth_dig_steps = 2;
const unearth_word = [_][]const u8{ "R", "e", "s", "t", "o", "r", "i", "n", "g", "…" };
const buried = [_][]const u8{ "⣶", "⣿", "⣷", "⣾", "⣿", "⣶", "⣷", "⣿", "⣾", "⣶" };
/// A clod's flight from behind the corgi, a cell a step, before it lands.
const clod = [_]struct { col: usize, glyph: []const u8 }{
    .{ .col = 18, .glyph = "⠂" },
    .{ .col = 19, .glyph = "⠁" },
    .{ .col = 20, .glyph = "⠁" },
    .{ .col = 21, .glyph = "⠂" },
    .{ .col = 22, .glyph = "⠄" },
};
const pile_col = 23;
/// The pile column each letter's clod lands on, and the pile's heights.
const pile_order = [_]usize{ 1, 2, 0, 3, 1, 2, 1, 2, 0, 3 };
const pile_glyph = [_][]const u8{ " ", "⣀", "⣤", "⣶", "⣿" };
/// Pixel art, not a UI color.
const dirt = [3]u8{ 150, 126, 96 };
/// The word is live progress; the corgi digging it out stays gray.
const restored = palette.Token.accent.rgb();
const UnearthCell = struct { glyph: []const u8 = " ", color: [3]u8 = dirt, bold: bool = false };

fn unearthScene(step: usize) [unearth_width]UnearthCell {
    var cells: [unearth_width]UnearthCell = @splat(.{});
    for (unearth_word, buried, 0..) |letter, cover, i| {
        const at = (unearth_word.len - 1 - i) * unearth_dig_steps;
        cells[i] = if (step < at) .{ .glyph = cover } else .{
            .glyph = letter,
            .color = blend(dirt, restored, @as(f64, @floatFromInt(@min(step - at, 2))) / 2),
            .bold = true,
        };
    }
    var heights: [4]usize = @splat(0);
    for (pile_order, 0..) |column, n| {
        if (step < n * unearth_dig_steps) continue;
        const age = step - n * unearth_dig_steps;
        if (age < clod.len) cells[clod[age].col] = .{ .glyph = clod[age].glyph } else heights[column] = @min(heights[column] + 1, pile_glyph.len - 1);
    }
    for (heights, 0..) |height, i| cells[pile_col + i] = .{ .glyph = pile_glyph[height] };
    const dug = unearth_word.len * unearth_dig_steps;
    const dog = if (step < dug) (if (step % 2 == 1) "‹o[/\\]~" else "‹o[\\/]~") else if (step - dug < 5) "ᐱ•ᴥ•ᐱ" else "ᐯ•ᴥ•ᐯ";
    var col: usize = if (step < dug) 11 else 12;
    if (step >= dug) {
        cells[col] = .{ .glyph = wagTail(step / 2), .color = awake_color };
        col += 1;
    }
    var glyphs = (std.unicode.Utf8View.init(dog) catch unreachable).iterator();
    while (glyphs.nextCodepointSlice()) |glyph| : (col += 1) cells[col] = .{ .glyph = glyph, .color = awake_color };
    return cells;
}
/// The restoring band's title `shown_ms` after it appeared, in `width` cells.
/// Narrower than `unearth_width`, it is the word alone.
pub fn writeUnearth(out: *std.Io.Writer, width: usize, shown_ms: i64) !void {
    if (width < unearth_width) {
        try out.writeAll("\x1b[1m");
        try writeColor(out, restored);
        for (unearth_word) |letter| try out.writeAll(letter);
        return;
    }
    const step: usize = @intCast(@divFloor(@max(shown_ms, 0), unearth_step_ms));
    var bold: ?bool = null;
    var color: ?[3]u8 = null;
    for (unearthScene(step)) |cell| {
        if (bold != cell.bold) {
            bold = cell.bold;
            try out.writeAll(if (cell.bold) "\x1b[1m" else "\x1b[22m");
        }
        try tint(out, &color, cell.color);
        try out.writeAll(cell.glyph);
    }
}

pub const Routine = enum { idle, sniff, fetch };

pub const Playback = struct {
    pub const minimum_idle_ms = 10_000;
    pub const retry_ms = 2_000;
    pub const activity_probability_percent = 35;
    pub const max_activity_ms = 9_600;

    active: bool = false,
    routine: Routine = .idle,
    started_ms: i64 = 0,
    deadline_ms: i64 = 0,
    random: std.Random.DefaultPrng = .init(0),

    fn enter(self: *Playback, routine: Routine, now_ms: i64) void {
        self.routine = routine;
        self.started_ms = now_ms;
        const duration: i64 = switch (routine) {
            .idle => minimum_idle_ms,
            .sniff => @as(i64, @intCast(1 + self.random.random().uintLessThan(u32, 2))) * frames.sniff.len * 200,
            .fetch => max_activity_ms,
        };
        self.deadline_ms = now_ms + duration;
    }

    fn update(self: *Playback, active: bool, now_ms: i64) void {
        defer self.active = active;
        if (!active) return;
        if (!self.active) {
            self.enter(@enumFromInt(self.random.random().uintLessThan(u32, 3)), now_ms);
            return;
        }
        if (now_ms < self.deadline_ms) return;
        if (self.routine != .idle) {
            // Rest from the observed transition, even after a delayed redraw.
            self.enter(.idle, now_ms);
        } else if (self.random.random().uintLessThan(u32, 100) < activity_probability_percent) {
            self.enter(if (self.random.random().boolean()) .sniff else .fetch, now_ms);
        } else {
            // One decision per interval, independent of redraw frequency.
            self.deadline_ms = now_ms + retry_ms;
        }
    }

    pub fn write(self: Playback, out: *std.Io.Writer, room: usize, now_ms: i64) !void {
        const elapsed: usize = @intCast(@max(now_ms - self.started_ms, 0));
        switch (self.routine) {
            // This is awake rest. Sleep is owned by the agent lifecycle in the sidebar.
            .idle => try writeFrame(out, room, frames.wag[(elapsed / 200) % frames.wag.len]),
            .fetch => if (room >= 18) {
                // Fit one complete trip into the activity budget at any width.
                const steps = 2 * (3 * room + 11);
                try writeFetch(out, room, @min(elapsed, max_activity_ms - 1) * steps / max_activity_ms);
            } else {
                // Keep the dog and tail visible when there is no room for a chase.
                const phase = @min(elapsed, max_activity_ms - 1) * 4 / max_activity_ms;
                try out.writeAll(if (room > 0) wagTail(elapsed / 300) else "");
                try writeFrame(out, room -| 1, ([_][]const u8{ "ᐯ•ᴥ•ᐯ", "ᐯ•ᴥ•ᐱ", "ᐯ•●•ᐯ", "ᐯ•ᴥ•ᐯ" })[phase]);
            },
            .sniff => try writeFrame(out, room, frames.sniff[(elapsed / 200) % frames.sniff.len]),
        }
    }
};

fn writeFrame(out: *std.Io.Writer, room: usize, frame: []const u8) !void {
    var glyphs = (std.unicode.Utf8View.init(frame) catch unreachable).iterator();
    for (0..room) |_| try out.writeAll(glyphs.nextCodepointSlice() orelse break);
}

pub const Mode = enum { awake, asleep, herding, content };

/// Keeps the last corgi pose underneath a content reveal. Content changes during
/// a reveal update its top layer without restarting the wipe.
pub const Presentation = struct {
    pub const reveal_duration_ms = 450;
    playback: Playback = .{},
    mode: Mode = .content,
    last_corgi: ?struct { mode: Mode, at_ms: i64 } = null,
    reveal_started_ms: ?i64 = null,
    herd_started_ms: i64 = 0,

    pub fn update(self: *Presentation, mode: Mode, now_ms: i64) void {
        self.playback.update(mode == .awake, now_ms);
        if (mode == .herding) {
            // Each compaction starts from scattered letters; its end reveals nothing.
            if (self.mode != .herding) self.herd_started_ms = now_ms;
            self.last_corgi = null;
            self.reveal_started_ms = null;
        } else if (mode != .content) {
            self.last_corgi = .{ .mode = mode, .at_ms = now_ms };
            self.reveal_started_ms = null;
        } else if (self.mode == .asleep) {
            self.last_corgi = null;
            self.reveal_started_ms = null;
        } else if (self.mode == .awake and self.last_corgi != null) {
            self.reveal_started_ms = now_ms;
        }
        if (self.reveal_started_ms) |start| {
            if (now_ms - start >= reveal_duration_ms) {
                self.reveal_started_ms = null;
                self.last_corgi = null;
            }
        }
        self.mode = mode;
    }

    pub fn skipReveal(self: *Presentation) void {
        if (self.mode != .content) return;
        self.reveal_started_ms = null;
        self.last_corgi = null;
    }

    pub const reveal_feather = 3.0;

    pub fn revealPosition(self: Presentation, room: usize, now_ms: i64) f64 {
        const distance = @as(f64, @floatFromInt(room)) + reveal_feather;
        const start = self.reveal_started_ms orelse return distance;
        const elapsed: f64 = @floatFromInt(std.math.clamp(now_ms - start, 0, reveal_duration_ms));
        return distance * elapsed / reveal_duration_ms;
    }

    pub fn revealedColumns(self: Presentation, room: usize, now_ms: i64) usize {
        return @min(room, @as(usize, @intFromFloat(self.revealPosition(room, now_ms))));
    }

    pub fn writeHerding(self: Presentation, out: *std.Io.Writer, room: usize, now_ms: i64) !void {
        const elapsed: usize = @intCast(@max(now_ms - self.herd_started_ms, 0));
        try writeHerd(out, room, elapsed / herd_step_ms);
    }

    pub fn writeCorgi(self: Presentation, out: *std.Io.Writer, room: usize, working: bool, sleep: Sleep) !void {
        const pose = self.last_corgi orelse return;
        if (pose.mode == .asleep and !working) {
            try idle(out, room, sleep);
        } else {
            try writeColor(out, awake_color);
            // If work starts while sleep is being covered, wake immediately.
            const playback = if (pose.mode == .asleep) Playback{} else self.playback;
            try playback.write(out, room, pose.at_ms);
        }
    }

    fn hide(self: *Presentation) void {
        self.playback.active = false;
        self.mode = .content;
        self.last_corgi = null;
        self.reveal_started_ms = null;
    }
};

// Viewer-local state: enough slots for more than two full agent sidebars.
const Slot = struct { key: ?u64 = null, seen: bool = false, presentation: Presentation = .{} };
var slots: [256]Slot = @splat(.{});

pub fn beginFrame() void {
    for (&slots) |*slot| slot.seen = false;
}
pub fn endFrame() void {
    for (&slots) |*slot| if (!slot.seen) {
        slot.presentation.hide();
    };
}
pub fn observe(key: u64, mode: Mode, now_ms: i64) ?*Presentation {
    for (&slots) |*slot| if (slot.key == key) {
        slot.seen = true;
        slot.presentation.update(mode, now_ms);
        return &slot.presentation;
    };
    if (mode == .content) return null;
    // Use empty/finished slots first, preserving other visible corgis even if
    // their rows have not been visited yet in this frame.
    for (&slots) |*slot| if (!slot.seen and slot.presentation.last_corgi == null) {
        slot.* = .{ .key = key, .seen = true, .presentation = .{ .playback = .{ .random = .init(os.random.int(u64)) } } };
        slot.presentation.update(mode, now_ms);
        return &slot.presentation;
    };
    unreachable; // At most 80 entries are rendered by a sidebar.
}

/// How a sleeping corgi is drawn. Seen naps dim so a long idle list stays
/// quiet; `bright` keeps unseen and focused ones at full grey.
pub const Sleep = struct {
    background: [3]u8 = palette.Token.bg.rgb(),
    bright: bool = false,
    /// On a `selected` row the sleeper is `muted`, as faint is too dark there.
    selected: bool = false,
    /// Milliseconds into this corgi's Z puff, while it is the one dreaming.
    puff_ms: ?u64 = null,
};

const sleeping_grey = palette.Token.faint.rgb();
/// Dim sleepers sit this far from the background toward `sleeping_grey`.
const dim_amount = 0.42;
/// A puff drifts right from the nose one cell per step, fading as it rises.
pub const puff_steps = 5;
pub const puff_step_ms = 900;
pub const puff_duration_ms = puff_steps * puff_step_ms;
/// Each period, one corgi in a list puffs; the list is still for the rest.
pub const dream_period_ms = 11_000;

pub const Dream = struct { key: u64, puff_ms: u64 };

/// The one sleeper that dreams now, so an idle list has at most one moving
/// Z. Rendezvous hashing keeps the pick when other corgis wake or doze off.
/// The previous period's top pick sits out, so repeats are rare.
pub fn dreamer(sleepers: []const u64, now_ms: i64) ?Dream {
    const now: u64 = @intCast(@max(now_ms, 0));
    const period = now / dream_period_ms;
    const elapsed = now % dream_period_ms;
    if (elapsed >= puff_duration_ms) return null;
    const previous = if (period > 0 and sleepers.len > 1) pick(sleepers, period - 1, null) else null;
    const key = pick(sleepers, period, previous) orelse return null;
    return .{ .key = key, .puff_ms = elapsed };
}

fn pick(sleepers: []const u64, period: u64, skip: ?u64) ?u64 {
    var best: ?u64 = null;
    var best_score: u64 = 0;
    for (sleepers) |key| {
        if (skip != null and key == skip.?) continue;
        const score = std.hash.Wyhash.hash(period, std.mem.asBytes(&key));
        if (best == null or score > best_score) {
            best = key;
            best_score = score;
        }
    }
    return best;
}

fn blend(from: [3]u8, to: [3]u8, amount: f64) [3]u8 {
    var color: [3]u8 = undefined;
    for (from, to, &color) |start, end, *channel| {
        const low: f64 = @floatFromInt(start);
        channel.* = @intFromFloat(@round(low + (@as(f64, @floatFromInt(end)) - low) * amount));
    }
    return color;
}

const writeColor = palette.writeFg;

/// Brightness of the puff at `col`, or null where it is not drawn. The Z
/// crossfades to the next cell in 150 ms steps.
fn puffAmount(puff_ms: ?u64, col: usize) ?f64 {
    const elapsed = puff_ms orelse return null;
    if (elapsed >= puff_duration_ms or col < 7) return null;
    const step = elapsed / puff_step_ms;
    const t = @as(f64, @floatFromInt((elapsed % puff_step_ms) / 150)) / 6;
    const shift = t * t * (3 - 2 * t);
    const amount = if (col - 7 == step)
        (1 - shift) * fade(step)
    else if (col - 7 == step + 1)
        shift * fade(step + 1)
    else
        return null;
    return if (amount > 0) amount else null;
}

fn fade(step: u64) f64 {
    return 1 - @as(f64, @floatFromInt(step)) / puff_steps;
}

/// A still sleeping corgi; a dreaming one puffs a Z from its nose.
pub fn idle(out: *std.Io.Writer, width: usize, sleep: Sleep) !void {
    const sprite = [_][]const u8{ "~", "ᐯ", "◡", "ᴥ", "◡", "ᐯ" };
    const grey = if (sleep.selected) palette.Token.muted.rgb() else sleeping_grey;
    const body = if (sleep.bright or sleep.selected) grey else blend(sleep.background, grey, dim_amount);
    try writeColor(out, body);
    for (0..width) |col| {
        if (col < sprite.len) {
            try out.writeAll(sprite[col]);
        } else if (puffAmount(sleep.puff_ms, col)) |amount| {
            try writeColor(out, blend(sleep.background, grey, amount));
            try out.writeAll(if ((col - 7) % 2 == 0) "ᶻ" else "z");
            try writeColor(out, body);
        } else try out.writeByte(' ');
    }
}

test "half-cell ball travel keeps the impact before the perk and preserves pickup pause" {
    const landed = fetchScene(18, 26);
    try std.testing.expectEqualStrings("~ᐯ•ᴥ•ᐯ", landed.dog);
    try std.testing.expectEqualStrings("⡀", landed.mark);
    const reacted = fetchScene(18, 27);
    try std.testing.expectEqualStrings("~ᐯ•ᴥ•ᐱ", reacted.dog);
    try std.testing.expectEqualStrings("⢀", reacted.mark);
    for (78..88) |step| try std.testing.expectEqualStrings("~ᐯ•●•ᐯ", fetchScene(18, step).dog);
    const left = fetchScene(22, 36);
    const right = fetchScene(22, 37);
    const advance = fetchScene(22, 38);
    try std.testing.expectEqual(left.ball, right.ball);
    try std.testing.expectEqual(left.ball.? + 1, advance.ball.?);
    try std.testing.expectEqualStrings("⡀", left.mark);
    try std.testing.expectEqualStrings("⢀", right.mark);
    try std.testing.expectEqualStrings("⡀", advance.mark);
}

/// `text` after the SGR writeColor writes for `color`.
fn testTinted(buffer: []u8, color: [3]u8, text: []const u8) []const u8 {
    return std.fmt.bufPrint(buffer, "\x1b[38;2;{d};{d};{d}m{s}", .{ color[0], color[1], color[2], text }) catch unreachable;
}

fn withoutColors(out: *std.Io.Writer.Allocating, bytes: []const u8) ![]const u8 {
    out.clearRetainingCapacity();
    var ansi = false;
    for (bytes) |byte| {
        if (byte == 0x1b) ansi = true else if (ansi) {
            if (byte == 'm') ansi = false;
        } else try out.writer.writeByte(byte);
    }
    return out.written();
}

test "sleeping corgi keeps a still face and fits its width while puffing" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    for ([_]usize{ 0, 1, 5, 6, 7, 8, 12, 22, 80 }) |width| {
        var puffed = false;
        var elapsed: u64 = 0;
        while (elapsed <= puff_duration_ms) : (elapsed += 50) {
            output.clearRetainingCapacity();
            try idle(&output.writer, width, .{ .puff_ms = elapsed });
            const text = try withoutColors(&plain, output.written());
            try std.testing.expectEqual(width, try std.unicode.utf8CountCodepoints(text));
            var letters: usize = 0;
            var glyphs = (try std.unicode.Utf8View.init(text)).iterator();
            while (glyphs.nextCodepoint()) |cp| {
                if (cp == 'z' or cp == 'ᶻ') letters += 1;
            }
            try std.testing.expect(letters <= 2);
            if (elapsed == puff_duration_ms) try std.testing.expectEqual(@as(usize, 0), letters);
            if (width >= 6) try std.testing.expect(std.mem.startsWith(u8, text, "~ᐯ◡ᴥ◡ᐯ"));
            puffed = puffed or letters > 0;
        }
        try std.testing.expectEqual(width > 7, puffed);
    }
}

test "activities finish whole loops within budget and rest for at least ten seconds" {
    for (0..100) |seed| {
        var playback: Playback = .{ .random = .init(seed) };
        for ([_]Routine{ .sniff, .fetch }) |routine| {
            playback.active = true;
            playback.enter(routine, 100);
            const duration = playback.deadline_ms - 100;
            try std.testing.expect(duration <= Playback.max_activity_ms);
            if (routine == .sniff) {
                const loop: i64 = frames.sniff.len * 200;
                try std.testing.expect(duration == loop or duration == 2 * loop);
            }
            playback.update(true, playback.deadline_ms - 1);
            try std.testing.expectEqual(routine, playback.routine);
            const end = playback.deadline_ms;
            playback.update(true, end);
            try std.testing.expectEqual(Routine.idle, playback.routine);
            playback.update(true, end + Playback.minimum_idle_ms - 1);
            try std.testing.expectEqual(Routine.idle, playback.routine);
        }
    }
}

test "random starts cover all routines and redraws do not reroll decisions" {
    var seen: std.EnumSet(Routine) = .initEmpty();
    var resumed = false;
    var stayed_idle = false;
    for (0..100) |seed| {
        var playback: Playback = .{ .random = .init(seed) };
        playback.update(true, 0);
        seen.insert(playback.routine);
        playback.enter(.idle, 0);
        playback.update(true, Playback.minimum_idle_ms);
        resumed = resumed or playback.routine != .idle;
        stayed_idle = stayed_idle or playback.routine == .idle;
        var sparse = playback;
        for (1..Playback.retry_ms) |ms| playback.update(true, Playback.minimum_idle_ms + @as(i64, @intCast(ms)));
        sparse.update(true, Playback.minimum_idle_ms + Playback.retry_ms - 1);
        try std.testing.expectEqualDeep(sparse, playback);
    }
    try std.testing.expect(seen.eql(.initFull()));
    try std.testing.expect(resumed and stayed_idle);
}

test "delayed activity transition still gets a full idle rest" {
    var playback: Playback = .{ .active = true };
    playback.enter(.fetch, 0);
    playback.update(true, 100_000);
    try std.testing.expectEqual(Routine.idle, playback.routine);
    try std.testing.expectEqual(@as(i64, 110_000), playback.deadline_ms);
}

test "half-cell fetch spans the full row without overlap or overflow" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for ([_]usize{ 18, 22, 40, 80, 294 }) |width| {
        var reached_edge = false;
        for (0..2 * (3 * width + 11)) |step| {
            const scene = fetchScene(width, step);
            const dog_width = try std.unicode.utf8CountCodepoints(scene.dog);
            try std.testing.expect(scene.x + dog_width <= width);
            if (scene.ball) |ball| {
                try std.testing.expect(ball < width);
                try std.testing.expect(ball < scene.x or ball >= scene.x + dog_width);
                reached_edge = reached_edge or ball == width - 1;
            }
            output.clearRetainingCapacity();
            try writeFetch(&output.writer, width, step);
            try std.testing.expectEqual(width, try std.unicode.utf8CountCodepoints(output.written()));
            try std.testing.expect(std.mem.indexOfAny(u8, output.written(), "~-^") != null);
        }
        try std.testing.expect(reached_edge);
    }
}

test "the corgi herds the word together, sits, and curls into the ellipsis" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    const expected = [_]struct { usize, []const u8 }{
        .{ 0, "C o  mp  a ct  i n  g " },
        .{ 7, "C o  mp  acting‹o[||]^" },
        .{ 12, "Compacting‹o[/\\]~     " },
        .{ 19, "Compacting -ᐯ◡ᴥ◡ᐯ     " },
        .{ 23, "Compacting  ᐯ◡ᴥ◡ᐯ     " },
        .{ 25, "Compacting   ◡ᴥ◡      " },
        .{ 27, "Compacting •.•        " },
        .{ 29, "Compacting…           " },
        .{ 1000, "Compacting…           " },
    };
    for (expected) |frame| {
        output.clearRetainingCapacity();
        try writeHerd(&output.writer, 22, frame[0]);
        try std.testing.expectEqualStrings(frame[1], try withoutColors(&plain, output.written()));
    }
    // Scattered letters are dim; the pushed ones light up.
    output.clearRetainingCapacity();
    try writeHerd(&output.writer, 22, 7);
    try std.testing.expect(std.mem.startsWith(u8, output.written(), comptime palette.fg(.text) ++ "C " ++ palette.fg(.faint) ++ "o  mp  a" ++ palette.fg(.text) ++ "cting‹o"));
    output.clearRetainingCapacity();
    try writeHerd(&output.writer, 22, 29);
    try std.testing.expectEqualStrings(comptime palette.fg(.text) ++ "Compacting…" ++ " " ** 11, output.written());
}

test "herding fits every width with letters in order and clear of the corgi" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for ([_]usize{ herd_width, 19, 22, 40, 80, 294 }) |width| {
        var packed_word = false;
        var scattered = false;
        for (0..width + herd_sit_steps + curl.len) |step| {
            const scene = herdScene(width, step);
            const dog_width = try std.unicode.utf8CountCodepoints(scene.dog);
            for (scene.letters, 0..) |at, i| {
                if (i > 0) try std.testing.expect(at > scene.letters[i - 1]);
                try std.testing.expect(at < scene.x or at >= scene.x + dog_width);
            }
            try std.testing.expect(scene.letters[herd_word.len - 1] <= width - 2);
            packed_word = packed_word or scene.letters[herd_word.len - 1] == herd_word.len - 1;
            scattered = scattered or scene.letters[herd_word.len - 1] == width - 2;
            output.clearRetainingCapacity();
            try writeHerd(&output.writer, width, step);
            var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
            defer plain.deinit();
            try std.testing.expectEqual(width, try std.unicode.utf8CountCodepoints(try withoutColors(&plain, output.written())));
        }
        try std.testing.expect(packed_word and scattered);
        try std.testing.expect(std.mem.startsWith(u8, output.written(), comptime palette.fg(.text) ++ "Compacting…"));
    }
}

test "each compaction herds from the start and ends without a reveal" {
    var presentation: Presentation = .{};
    presentation.update(.awake, 0);
    presentation.update(.herding, 100);
    try std.testing.expectEqual(@as(i64, 100), presentation.herd_started_ms);
    try std.testing.expect(presentation.last_corgi == null);
    presentation.update(.herding, 500);
    try std.testing.expectEqual(@as(i64, 100), presentation.herd_started_ms);
    presentation.update(.content, 600);
    try std.testing.expect(presentation.reveal_started_ms == null);
    presentation.update(.herding, 700);
    try std.testing.expectEqual(@as(i64, 700), presentation.herd_started_ms);
}

test "a puff starts lit, fades as it rises, and seen sleepers are dim" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try idle(&output.writer, 22, .{ .bright = true, .puff_ms = 0 });
    try std.testing.expect(std.mem.startsWith(u8, output.written(), comptime palette.fg(.faint) ++ "~ᐯ◡ᴥ◡ᐯ"));
    try std.testing.expect(std.mem.indexOf(u8, output.written(), comptime palette.fg(.faint) ++ "ᶻ") != null);
    output.clearRetainingCapacity();
    const bg = palette.Token.bg.rgb();
    var tinted: [64]u8 = undefined;
    // Halfway through the first step, the Z is split across two cells.
    try idle(&output.writer, 22, .{ .puff_ms = puff_step_ms / 2 });
    try std.testing.expect(std.mem.indexOf(u8, output.written(), testTinted(&tinted, blend(bg, sleeping_grey, 0.5), "ᶻ")) != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), testTinted(&tinted, blend(bg, sleeping_grey, 0.4), "z")) != null);
    output.clearRetainingCapacity();
    // Four cells out, the Z is 40% lit.
    try idle(&output.writer, 22, .{ .puff_ms = 3 * puff_step_ms });
    try std.testing.expect(std.mem.indexOf(u8, output.written(), testTinted(&tinted, blend(bg, sleeping_grey, 0.4), "z")) != null);
    output.clearRetainingCapacity();
    try idle(&output.writer, 22, .{});
    try std.testing.expectEqualStrings(testTinted(&tinted, blend(bg, sleeping_grey, dim_amount), "~ᐯ◡ᴥ◡ᐯ" ++ " " ** 16), output.written());
}

test "the corgi is gray: text awake, faint asleep, muted asleep on a selected row" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var presentation: Presentation = .{};
    presentation.update(.awake, 0);
    try presentation.writeCorgi(&output.writer, 20, true, .{});
    try std.testing.expect(std.mem.startsWith(u8, output.written(), comptime palette.fg(.text)));
    output.clearRetainingCapacity();
    try idle(&output.writer, 6, .{ .bright = true });
    try std.testing.expectEqualStrings(comptime palette.fg(.faint) ++ "~ᐯ◡ᴥ◡ᐯ", output.written());
    output.clearRetainingCapacity();
    try idle(&output.writer, 6, .{ .background = palette.Token.selected.rgb(), .selected = true });
    try std.testing.expectEqualStrings(comptime palette.fg(.muted) ++ "~ᐯ◡ᴥ◡ᐯ", output.written());
    output.clearRetainingCapacity();
    try writeUnearth(&output.writer, unearth_width, 3000);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), comptime palette.fg(.accent) ++ "Restoring…") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), comptime palette.fg(.text) ++ "~ᐯ•ᴥ•ᐯ") != null);
}

test "one sleeper dreams per period, holds through its puff, and rarely repeats" {
    try std.testing.expect(dreamer(&.{}, 0) == null);
    const keys = [_]u64{ 17, 34, 51, 68, 85, 102, 119, 136, 153 };
    var seen = [_]bool{false} ** keys.len;
    var previous: ?u64 = null;
    var repeats: usize = 0;
    for (1..300) |period| {
        const start: i64 = @intCast(period * dream_period_ms);
        const dream = dreamer(&keys, start + 100).?;
        try std.testing.expectEqual(@as(u64, 100), dream.puff_ms);
        try std.testing.expectEqual(dream.key, dreamer(&keys, start + puff_duration_ms - 1).?.key);
        try std.testing.expect(dreamer(&keys, start + puff_duration_ms) == null);
        // Another corgi waking up does not move the puff.
        var awake: [keys.len - 1]u64 = undefined;
        var n: usize = 0;
        const top = pick(&keys, period - 1, null).?;
        var woke = false;
        for (keys) |key| {
            if (!woke and key != dream.key and key != top) {
                woke = true;
                continue;
            }
            awake[n] = key;
            n += 1;
        }
        try std.testing.expectEqual(dream.key, dreamer(awake[0..n], start + 100).?.key);
        for (keys, &seen) |key, *hit| hit.* = hit.* or key == dream.key;
        if (previous != null and previous.? == dream.key) repeats += 1;
        previous = dream.key;
    }
    for (seen) |hit| try std.testing.expect(hit);
    try std.testing.expect(repeats < 15);
    // A lone sleeper dreams every period.
    for (0..5) |period| try std.testing.expectEqual(@as(u64, 7), dreamer(&.{7}, @intCast(period * dream_period_ms)).?.key);
}

test "content reveal preserves the old pose and cancels when a corgi returns" {
    var presentation: Presentation = .{};
    presentation.update(.asleep, 0);
    presentation.update(.content, 50);
    try std.testing.expect(presentation.last_corgi == null);
    try std.testing.expect(presentation.reveal_started_ms == null);
    try std.testing.expectEqual(@as(usize, 20), presentation.revealedColumns(20, 50));
    presentation.update(.awake, 100);
    presentation.update(.content, 200);
    try std.testing.expectEqual(@as(i64, 100), presentation.last_corgi.?.at_ms);
    try std.testing.expectEqual(@as(usize, 0), presentation.revealedColumns(20, 200));
    presentation.update(.content, 425);
    try std.testing.expectEqual(@as(usize, 11), presentation.revealedColumns(20, 425));
    try std.testing.expectEqual(@as(usize, 21), presentation.revealedColumns(40, 425));
    presentation.update(.awake, 430);
    try std.testing.expect(presentation.reveal_started_ms == null);
    try std.testing.expectEqual(Mode.awake, presentation.last_corgi.?.mode);
    presentation.update(.content, 500);
    presentation.update(.content, 950);
    try std.testing.expect(presentation.last_corgi == null);
    try std.testing.expect(presentation.reveal_started_ms == null);
    presentation.update(.awake, 1000);
    presentation.update(.content, 1010);
    presentation.skipReveal();
    try std.testing.expect(presentation.last_corgi == null);
    try std.testing.expect(presentation.reveal_started_ms == null);
    presentation.update(.awake, 1020);
    presentation.update(.content, 1030);
    presentation.update(.asleep, 1040); // An interrupted turn ends immediately.
    try std.testing.expect(presentation.reveal_started_ms == null);
    try std.testing.expectEqual(Mode.asleep, presentation.last_corgi.?.mode);
    presentation.hide();
    presentation.update(.content, 1100);
    try std.testing.expect(presentation.reveal_started_ms == null);
}

test "the corgi digs the word out nearest letter first, then turns and wags" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    const Case = struct { ms: i64, text: []const u8 };
    for ([_]Case{
        .{ .ms = 0, .text = "⣶⣿⣷⣾⣿⣶⣷⣿⣾… ‹o[\\/]~⠂        " },
        .{ .ms = 700, .text = "⣶⣿⣷⣾⣿ring… ‹o[\\/]~⠂ ⠁ ⠄ ⣀⣀ " },
        .{ .ms = 1700, .text = "Restoring…  ~ᐱ•ᴥ•ᐱ   ⠂ ⣤⣶⣶⣀" },
        .{ .ms = 3000, .text = "Restoring…  ~ᐯ•ᴥ•ᐯ     ⣤⣶⣶⣤" },
    }) |case| {
        output.clearRetainingCapacity();
        try writeUnearth(&output.writer, unearth_width, case.ms);
        try std.testing.expectEqualStrings(case.text, try withoutColors(&plain, output.written()));
    }
    // A narrow band shows the word alone.
    output.clearRetainingCapacity();
    try writeUnearth(&output.writer, unearth_width - 1, 0);
    try std.testing.expectEqualStrings("Restoring…", try withoutColors(&plain, output.written()));
}
