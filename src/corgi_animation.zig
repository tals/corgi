const std = @import("std");
const os = @import("os.zig");
const palette = @import("palette.zig");
const frames = @import("corgi_frames.zig");

const gait_right = [_][]const u8{ "~[/\\]o>", "~[||]o>", "~[\\/]o>", "~[||]o>" };
const gait_left_carry = [_][]const u8{ "●‹o[/\\]~", "●‹o[||]~", "●‹o[\\/]~", "●‹o[||]~" };
/// How the ball leaves the corgi, in dots per tick: forward, up (down when
/// negative) and its spin (see `Ball.spin`). `seed` makes each bounce's
/// unevenness, so every frame replays the same throw. The default is a
/// middling lob.
const Throw = struct {
    speed: f64 = 1.6,
    lift: f64 = 1.1,
    spin: f64 = 0,
    seed: u64 = 0,

    /// A roll, a lob or a smash, equally often. A roll leaves just off the
    /// floor with some forward spin and skips before it rolls. A lob leaves
    /// at 15° to 50° with backspin. A smash is slammed down into the floor
    /// at 30° to 45°, so it bounces between the floor and the ceiling.
    fn random(r: std.Random) Throw {
        const seed = r.int(u64);
        switch (r.uintLessThan(u32, 3)) {
            0 => {
                const speed = 1.5 + 0.4 * r.float(f64);
                return .{ .speed = speed, .lift = -(0.4 + 0.4 * r.float(f64)), .spin = -speed * (0.5 + 0.5 * r.float(f64)), .seed = seed };
            },
            1 => {
                const angle = std.math.degreesToRadians(15 + 35 * r.float(f64));
                const force = 1.8 + 0.8 * r.float(f64);
                const speed = force * @cos(angle);
                return .{ .speed = speed, .lift = force * @sin(angle), .spin = speed * (0.5 + 0.5 * r.float(f64)), .seed = seed };
            },
            else => {
                const angle = std.math.degreesToRadians(30 + 15 * r.float(f64));
                const force = 2.6 + 0.8 * r.float(f64);
                return .{ .speed = force * @cos(angle), .lift = -force * @sin(angle), .seed = seed };
            },
        }
    }
};

/// The ball in braille dots, two across and four down a cell. `y` rises
/// from the floor's dot row. The row ends in a slant: a 45° rise two dots
/// tall in its last cell, with the far wall above it.
const Ball = struct {
    x: f64 = nose,
    y: f64 = 1,
    vx: f64,
    vy: f64,
    /// The speed of the ball's surface as it spins: `-vx` rolls it along
    /// the floor and `vx` along the ceiling.
    spin: f64,
    random: std.Random.DefaultPrng,

    /// The near wall while the corgi sits: the cell after its nose.
    const nose = 12;
    const ceiling = 3;
    const gravity = 0.16;
    /// The share of its speed into a surface the ball keeps, different each
    /// bounce. A rolling ball meets the slant's rounded foot softly and
    /// rides up it.
    const bounciness = [2]f64{ 0.7, 0.9 };
    const ride = [2]f64{ 0.25, 0.65 };
    /// A surface sits up to this many degrees askew, different each bounce.
    const tilt = 5;
    /// How much of a bounce's push friction can turn into spin.
    const grip = 0.15;
    /// A hop slower than this barely leaves the floor's dot row, so the
    /// ball rolls instead.
    const settle = 0.3;
    /// Rolling slows by this over the row, so wide rows roll as far.
    const friction = 0.6;
    /// A rolling ball this slow stops rather than creep a dot every few ticks.
    const stall = 0.25;
    /// The highest dot row the corgi's mouth reaches.
    const reach = 1;
    /// The slant's line, in the row's last cell.
    const slant: u8 = 0x60;

    fn thrown(throw: Throw) Ball {
        return .{ .vx = throw.speed, .vy = throw.lift, .spin = throw.spin, .random = .init(throw.seed) };
    }

    fn resting(ball: Ball) bool {
        return ball.y == 0 and ball.vx == 0 and ball.vy == 0;
    }

    fn reachable(ball: Ball) bool {
        return @round(ball.y) <= reach;
    }

    /// One tick: fly under gravity or roll against friction. The ball stops
    /// at the floor, the ceiling, the slant, the row's end and the corgi's
    /// nose, `near`, for a tick, so each bounce is drawn.
    fn step(ball: *Ball, width: usize, near: usize) void {
        // The slant rises a dot per dot from `foot`, and the ball keeps a
        // dot above its line. Over it, the slant is the ground.
        const foot: f64 = @floatFromInt(2 * width - 3);
        const far: f64 = @floatFromInt(2 * width - 1);
        const rolling = ball.y == 0 and ball.vy == 0;
        if (rolling) {
            const drag = friction / @as(f64, @floatFromInt(2 * width - nose));
            ball.vx = if (@abs(ball.vx) <= stall) 0 else ball.vx - std.math.copysign(drag, ball.vx);
            ball.spin = -ball.vx;
        } else {
            ball.vy -= gravity;
            ball.y += ball.vy;
            if (ball.y >= ceiling) {
                ball.y = ceiling;
                _ = ball.bounce(.{ 0, -1 }, bounciness);
            } else if (ball.y <= 0 and ball.x <= foot) ball.land();
        }
        ball.x += ball.vx;
        const surface = @min(ball.x, far) - foot;
        if (surface > 0 and ball.y < surface) {
            const depth = (surface - ball.y) / 2;
            ball.x -= depth;
            ball.y = @max(0, ball.y + depth);
            _ = ball.bounce(.{ -std.math.sqrt1_2, std.math.sqrt1_2 }, if (rolling) ride else bounciness);
        } else if (ball.y < 0) ball.land();
        if (ball.x >= far) {
            ball.x = far;
            _ = ball.bounce(.{ -1, 0 }, bounciness);
            ball.vx = -@abs(ball.vx);
        } else if (ball.x <= @as(f64, @floatFromInt(near))) {
            ball.x = @floatFromInt(near);
            _ = ball.bounce(.{ 1, 0 }, bounciness);
            ball.vx = @abs(ball.vx);
        }
    }

    fn land(ball: *Ball) void {
        ball.y = 0;
        _ = ball.bounce(.{ 0, 1 }, bounciness);
        ball.vy = @abs(ball.vy);
        if (ball.vy < settle) {
            // Too low to hop: it skids until it rolls.
            ball.vy = 0;
            ball.vx -= 2.0 / 7.0 * (ball.vx + ball.spin);
            ball.spin = -ball.vx;
        }
    }

    /// Off a surface facing the room along `normal`, keeping a share of its
    /// speed into it from `kept`. Friction trades sliding for spin, as for
    /// a solid ball: at most 2/7 of the slip comes off its speed and the
    /// rest goes to spin, and `grip` caps it by how hard the ball hits.
    fn bounce(ball: *Ball, normal: [2]f64, kept: [2]f64) bool {
        const r = ball.random.random();
        const askew = std.math.degreesToRadians((r.float(f64) - 0.5) * 2 * tilt);
        const nx = normal[0] * @cos(askew) - normal[1] * @sin(askew);
        const ny = normal[0] * @sin(askew) + normal[1] * @cos(askew);
        const into = ball.vx * nx + ball.vy * ny;
        if (into >= 0) return false;
        const kept_share = kept[0] + (kept[1] - kept[0]) * r.float(f64);
        // Along the surface, a quarter turn clockwise from the normal.
        const along = ball.vx * ny - ball.vy * nx;
        const slip = along + ball.spin;
        const rub = -std.math.copysign(@min(2.0 / 7.0 * @abs(slip), grip * (1 + kept_share) * -into), slip);
        const out = -kept_share * into;
        ball.spin += 2.5 * rub;
        ball.vx = (along + rub) * ny + out * nx;
        ball.vy = -(along + rub) * nx + out * ny;
        return true;
    }

    fn dot(ball: Ball) Dot {
        const col: usize = @intFromFloat(@round(ball.x));
        const row: usize = @intFromFloat(@round(ball.y));
        return .{ .cell = col / 2, .dots = braille_dots[col % 2][row] };
    }
};
/// The ball's cell, and its dot in braille's bits.
const Dot = struct { cell: usize, dots: u8 };
/// Braille's dot bits by column, from the floor up.
const braille_dots = [2][4]u8{ .{ 0x40, 0x04, 0x02, 0x01 }, .{ 0x80, 0x20, 0x10, 0x08 } };
/// The braille character with `dots` raised.
fn braille(dots: u8) [3]u8 {
    return .{ 0xe2, 0xa0 | dots >> 6, 0x80 | (dots & 0x3f) };
}

/// Ticks the corgi watches the ball after it lands, before setting off.
const react = 4;

const Gait = struct { x: usize, pose: []const u8 };
/// A throw `ticks` in: the ball, the corgi once it is up, the tick the ball
/// first lands, and the tick and column at which the corgi catches it.
const Chase = struct { ball: Ball, dog: ?Gait = null, landed: usize = 0, caught: usize = 0, stop: usize = 0 };
/// The corgi gets up once the ball has landed and left room for it to stand.
/// It stands for two steps, then each step runs a cell after the ball, up to
/// the foot of the slant, or waits while the ball is just past its nose. A
/// ball there low enough to reach is caught on the next tick; a higher one
/// bounces off its head.
fn chase(width: usize, throw: Throw, ticks: usize) Chase {
    var ball: Ball = .thrown(throw);
    var result: Chase = .{ .ball = ball };
    var up: ?usize = null;
    var x: usize = 0;
    var ran = false;
    var tick: usize = 0;
    while (true) : (tick += 1) {
        // `x + 7` is the cell just past the running corgi's nose.
        const cell = ball.dot().cell;
        const ready = result.landed > 0 and tick >= result.landed + react;
        if (up) |since| {
            if (tick - since >= 4 and (tick - since) % 2 == 0) {
                ran = cell > x + 7 and x + 8 < width;
                if (ran) x += 1;
            }
        } else if (ready and cell >= x + 7) up = tick;
        if (tick == ticks) {
            result.ball = ball;
            if (up != null) result.dog = .{ .x = x, .pose = if (ran) gait_right[x % 4] else gait_right[1] };
        }
        const near: usize = if (up != null) x + 7 else Ball.nose / 2;
        // A ball still loose after `give_up` is caught where the corgi is.
        if ((ready and cell <= near and ball.reachable()) or tick == give_up) {
            result.caught = tick + 1;
            result.stop = x;
            return result;
        }
        ball.step(width, 2 * near);
        if (ball.y == 0 and result.landed == 0) result.landed = tick + 1;
    }
}
const give_up = 1000;

/// Ticks before the throw, while the corgi sits and blinks.
const windup = 16;

const FetchScene = struct {
    dog: []const u8,
    x: usize = 0,
    ball: ?Dot = null,
};
fn stage(phase: *usize, duration: usize) bool {
    if (phase.* < duration) return true;
    phase.* -= duration;
    return false;
}
/// The ball and the chase move every tick; the rest in steps of two ticks.
fn fetchScene(width: usize, throw: Throw, tick: usize) FetchScene {
    std.debug.assert(width >= 18);
    const rest = "~ᐯ•ᴥ•ᐯ";
    const alert = "~ᐯ•ᴥ•ᐱ";
    const held = "~ᐯ•●•ᐯ";
    var p = tick;
    if (stage(&p, windup)) return .{ .dog = if (p / 2 == 4) "~ᐯ◡ᴥ◡ᐯ" else rest };
    const run = chase(width, throw, p);
    if (stage(&p, run.caught)) {
        const ball = run.ball.dot();
        if (run.dog) |gait| return .{ .dog = gait.pose, .x = gait.x, .ball = ball };
        // React on the very next tick after floor contact.
        return .{ .dog = if (p > run.landed) alert else rest, .ball = ball };
    }
    p /= 2;
    const stop = run.stop;
    // A ball caught within reach is held without turning around.
    const turn: usize = if (stop > 0) 2 else 0;
    if (stage(&p, 2)) return .{ .dog = "~[||]o●", .x = stop };
    if (stage(&p, 5)) return .{ .dog = held, .x = stop };
    if (stage(&p, turn)) return .{ .dog = gait_left_carry[1], .x = stop - 1 };
    if (stage(&p, stop)) return .{ .dog = gait_left_carry[p % 4], .x = stop - 1 - p };
    if (stage(&p, 3)) return .{ .dog = held };
    return .{ .dog = rest };
}
/// Ticks in a whole fetch, from the throw to the corgi resting again.
fn fetchTicks(width: usize, throw: Throw) usize {
    const run = chase(width, throw, 0);
    const turn: usize = if (run.stop > 0) 2 else 0;
    return windup + run.caught + 2 * (turn + run.stop + 13);
}
/// Ticks that fill the activity budget: one every 50 ms, or a longer trip's
/// own, so it speeds up to fit.
fn fetchPace(width: usize, throw: Throw) usize {
    return @max(fetchTicks(width, throw), Playback.max_activity_ms / 50);
}
/// The slant is faint, and lit while the ball shares its cell.
const slant_color = palette.Token.faint.rgb();
fn writeFetch(out: *std.Io.Writer, width: usize, throw: Throw, tick: usize) !void {
    const scene = fetchScene(width, throw, tick);
    var dog = (std.unicode.Utf8View.init(scene.dog) catch unreachable).iterator();
    for (0..width) |col| {
        const ball: u8 = if (scene.ball) |b| (if (b.cell == col) b.dots else 0) else 0;
        if (col == width - 1) {
            if (ball == 0) try writeColor(out, slant_color);
            try out.writeAll(&braille(Ball.slant | ball));
            if (ball == 0) try writeColor(out, awake_color);
        } else if (ball != 0) {
            try out.writeAll(&braille(ball));
        } else if (col >= scene.x) {
            const glyph = dog.nextCodepointSlice() orelse " ";
            try out.writeAll(if (std.mem.eql(u8, glyph, "~")) wagTail(tick / 4) else glyph);
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
    throw: Throw = .{},

    fn enter(self: *Playback, routine: Routine, now_ms: i64) void {
        self.routine = routine;
        self.started_ms = now_ms;
        if (routine == .fetch) self.throw = .random(self.random.random());
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
                try writeFetch(out, room, self.throw, @min(elapsed, max_activity_ms - 1) * fetchPace(room, self.throw) / max_activity_ms);
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

/// A corgi that wags until it is thrown a ball, then fetches it.
pub const Fetch = struct {
    thrown_ms: ?i64 = null,
    throw: Throw = .{},

    /// Throws a ball, unless the corgi is still fetching the last one.
    pub fn throwBall(self: *Fetch, room: usize, now_ms: i64) void {
        if (room < 18 or self.tick(room, now_ms) != null) return;
        self.* = .{ .thrown_ms = now_ms, .throw = .random(os.random) };
    }

    /// The fetch from the throw on, or null once the corgi is back.
    fn tick(self: Fetch, room: usize, now_ms: i64) ?usize {
        const thrown = self.thrown_ms orelse return null;
        const elapsed: usize = @intCast(@max(now_ms - thrown, 0));
        if (room < 18 or elapsed >= Playback.max_activity_ms) return null;
        const at = windup + elapsed * fetchPace(room, self.throw) / Playback.max_activity_ms;
        return if (at < fetchTicks(room, self.throw)) at else null;
    }

    pub fn write(self: Fetch, out: *std.Io.Writer, room: usize, now_ms: i64) !void {
        try writeColor(out, awake_color);
        if (self.tick(room, now_ms)) |at| return writeFetch(out, room, self.throw, at);
        const step: usize = @intCast(@divFloor(@max(now_ms, 0), 200));
        try writeFrame(out, room, frames.wag[step % frames.wag.len]);
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

test "the corgi perks up as the ball lands, chases it while it moves, and pauses to hold it" {
    const throw: Throw = .{};
    const run = chase(18, throw, 0);
    try std.testing.expect(chase(18, throw, run.landed - 1).ball.y > 0);
    try std.testing.expectEqual(@as(f64, 0), chase(18, throw, run.landed).ball.y);
    try std.testing.expectEqualStrings("~ᐯ•ᴥ•ᐯ", fetchScene(18, throw, windup + run.landed).dog);
    try std.testing.expectEqualStrings("~ᐯ•ᴥ•ᐱ", fetchScene(18, throw, windup + run.landed + 1).dog);
    try std.testing.expectEqualStrings("~[||]o>", fetchScene(18, throw, windup + run.landed + react).dog);
    try std.testing.expect(!chase(18, throw, run.caught - 1).ball.resting());
    var tick: usize = windup;
    while (!std.mem.eql(u8, fetchScene(18, throw, tick).dog, "~ᐯ•●•ᐯ")) tick += 1;
    try std.testing.expectEqualStrings("~[||]o●", fetchScene(18, throw, tick - 1).dog);
    for (tick..tick + 10) |held| try std.testing.expectEqualStrings("~ᐯ•●•ᐯ", fetchScene(18, throw, held).dog);
    try std.testing.expectEqualStrings("●‹o[||]~", fetchScene(18, throw, tick + 10).dog);
}

test "the corgi catches the ball low at its nose, and waits beside it while it is high" {
    // The bottom two dot rows.
    const low: u8 = 0xe4;
    var prng: std.Random.DefaultPrng = .init(11);
    var waited = false;
    for ([_]usize{ 18, 26, 40 }) |width| for (0..40) |_| {
        const throw: Throw = .random(prng.random());
        var before = fetchScene(width, throw, windup);
        for (windup + 1..fetchTicks(width, throw)) |tick| {
            const scene = fetchScene(width, throw, tick);
            const ball = before.ball.?;
            const reachable = ball.dots & low != 0;
            const past_nose = before.x + try std.unicode.utf8CountCodepoints(before.dog);
            if (scene.ball == null) {
                try std.testing.expectEqualStrings("~[||]o●", scene.dog);
                try std.testing.expectEqual(before.x, scene.x);
                try std.testing.expect(reachable and ball.cell == past_nose);
                break;
            }
            waited = waited or (std.mem.eql(u8, before.dog, "~[||]o>") and ball.cell == past_nose and !reachable);
            before = scene;
        }
    };
    try std.testing.expect(waited);
}

test "every throw carries off, from lobs under the ceiling to smashes that bounce off it" {
    var prng: std.Random.DefaultPrng = .init(1);
    var under = false;
    var smashed = false;
    for (0..100) |_| {
        const throw: Throw = .random(prng.random());
        try std.testing.expect(throw.speed >= 1);
        var ball: Ball = .thrown(throw);
        var hits: usize = 0;
        for (0..give_up) |_| {
            if (ball.resting()) break;
            ball.step(40, Ball.nose);
            if (ball.y == Ball.ceiling) hits += 1;
        } else return error.TestUnexpectedResult;
        under = under or hits == 0;
        // Only a smash leaves the hand this steeply down.
        smashed = smashed or (throw.lift < -1 and hits >= 3);
    }
    try std.testing.expect(under and smashed);
}

test "a roll skips before it rolls, the slant kicks it up, and lights while the ball is over it" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    // The floor's dot row, and the top two.
    const floor: u8 = 0xc0;
    const high: u8 = 0x1b;
    var skipped = false;
    var kicked = false;
    for (0..30) |seed| {
        const throw: Throw = .{ .speed = 1.8, .lift = -0.6, .spin = -1.4, .seed = seed };
        var landed = false;
        for (windup..fetchTicks(26, throw)) |tick| {
            const ball = fetchScene(26, throw, tick).ball orelse break;
            if (ball.dots & floor != 0) landed = true else if (landed and ball.cell < 24) skipped = true;
            output.clearRetainingCapacity();
            try writeFetch(&output.writer, 26, throw, tick);
            if (ball.cell == 25) {
                kicked = kicked or ball.dots & high != 0;
                try std.testing.expect(std.mem.endsWith(u8, try withoutColors(&plain, output.written()), &braille(Ball.slant | ball.dots)));
                try std.testing.expect(std.mem.indexOf(u8, output.written(), comptime palette.fg(.faint)) == null);
            } else try std.testing.expect(std.mem.endsWith(u8, output.written(), comptime palette.fg(.faint) ++ "⡠" ++ palette.fg(.text)));
        }
    }
    try std.testing.expect(skipped and kicked);
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

test "every throw fits the row, bounces off its walls, and keeps clear of the corgi" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    var prng: std.Random.DefaultPrng = .init(7);
    for ([_]usize{ 18, 22, 40, 80, 294 }) |width| {
        var far = false;
        var ceiling = false;
        var catches: std.DynamicBitSetUnmanaged = try .initEmpty(std.testing.allocator, width);
        defer catches.deinit(std.testing.allocator);
        for (0..12) |n| {
            const throw: Throw = switch (n) {
                // Dropped at the corgi's feet, picked up without a run.
                0 => .{ .speed = 0, .lift = 0.5 },
                1 => .{ .speed = 2.2, .lift = 0.6 },
                2 => .{ .speed = 1.0, .lift = 1.6 },
                else => .random(prng.random()),
            };
            const ticks = fetchTicks(width, throw);
            for (0..ticks) |tick| {
                const scene = fetchScene(width, throw, tick);
                const dog_width = try std.unicode.utf8CountCodepoints(scene.dog);
                // Clear of the slant, too.
                try std.testing.expect(scene.x + dog_width < width);
                if (scene.ball) |ball| {
                    try std.testing.expect(ball.cell < width);
                    try std.testing.expect(ball.cell < scene.x or ball.cell >= scene.x + dog_width);
                    far = far or ball.cell == width - 1;
                    ceiling = ceiling or ball.dots & 0x09 != 0;
                }
                output.clearRetainingCapacity();
                try writeFetch(&output.writer, width, throw, tick);
                const text = try withoutColors(&plain, output.written());
                try std.testing.expectEqual(width, try std.unicode.utf8CountCodepoints(text));
                try std.testing.expect(std.mem.indexOfAny(u8, text, "~-^") != null);
            }
            const last = fetchScene(width, throw, ticks - 1);
            try std.testing.expectEqualStrings("~ᐯ•ᴥ•ᐯ", last.dog);
            try std.testing.expect(last.x == 0 and last.ball == null);
            catches.set(chase(width, throw, 0).stop);
        }
        try std.testing.expect(far and ceiling);
        try std.testing.expect(catches.count() >= 6);
    }
}

test "each fetch throws anew and finishes within the activity budget" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer plain.deinit();
    var playback: Playback = .{ .random = .init(3) };
    var previous: Throw = .{};
    for (0..20) |_| {
        playback.enter(.fetch, 0);
        try std.testing.expect(!std.meta.eql(previous, playback.throw));
        previous = playback.throw;
        for ([_]usize{ 18, 26, 40, 80 }) |room| {
            output.clearRetainingCapacity();
            try playback.write(&output.writer, room, Playback.max_activity_ms - 1);
            const text = try withoutColors(&plain, output.written());
            // At rest, with the slant still at the row's end.
            try std.testing.expect(std.mem.endsWith(u8, text, "⡠"));
            try std.testing.expectEqualStrings("ᐯ•ᴥ•ᐯ", std.mem.trimEnd(u8, text[1 .. text.len - "⡠".len], " "));
        }
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
