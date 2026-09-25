const std = @import("std");
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
            .sniff => @as(i64, @intCast(2 + self.random.random().uintLessThan(u32, 3))) * frames.sniff.len * 200,
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

pub const Mode = enum { awake, asleep, content };

/// Keeps the last corgi pose underneath a content reveal. Content changes during
/// a reveal update its top layer without restarting the wipe.
pub const Presentation = struct {
    pub const reveal_duration_ms = 450;
    playback: Playback = .{},
    mode: Mode = .content,
    last_corgi: ?struct { mode: Mode, at_ms: i64 } = null,
    reveal_started_ms: ?i64 = null,

    pub fn update(self: *Presentation, mode: Mode, now_ms: i64) void {
        self.playback.update(mode == .awake, now_ms);
        if (mode != .content) {
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

    pub fn writeCorgi(self: Presentation, out: *std.Io.Writer, room: usize, seed: u64, focused: bool, working: bool) !void {
        const pose = self.last_corgi orelse return;
        if (pose.mode == .asleep and !working) {
            try out.writeAll("\x1b[38;2;108;112;134m");
            try idle(out, room, pose.at_ms, seed, focused);
        } else {
            try out.writeAll("\x1b[38;2;249;226;175m");
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
        slot.* = .{ .key = key, .seen = true, .presentation = .{ .playback = .{ .random = .init(std.crypto.random.int(u64)) } } };
        slot.presentation.update(mode, now_ms);
        return &slot.presentation;
    };
    unreachable; // At most 80 entries are rendered by a sidebar.
}

/// Temporarily off: the sleeping corgi keeps its still face without drifting Z's.
const sleep_zs_enabled = false;

/// 4C: an eight-frame brightness handoff, alternating high/low every 1200 ms.
pub fn idle(out: *std.Io.Writer, width: usize, now_ms: i64, seed: u64, focused: bool) !void {
    const face = [_][]const u8{ "ᐯ", "◡", "ᴥ", "◡", "ᐯ" };
    const travel = width -| 7;
    const elapsed: u64 = @intCast(@max(now_ms, 0));
    const tail_phase = (elapsed + (seed % 997) * 600) % 12000;
    const tail: []const u8 = if (tail_phase >= 11000 and tail_phase < 11800 and
        ((tail_phase - 11000) / 200) % 2 == 0) "-" else "~";
    // Leave a quiet sixteen-second pause between traversals.
    const phase = (elapsed + (seed % 997) * 600) % (travel * 1200 + 16000);
    const position = phase / 1200;
    const t: f64 = @as(f64, @floatFromInt((phase % 1200) / 150)) / 8;
    const shift = t * t * (3 - 2 * t);
    const background: [3]u8 = if (focused) .{ 35, 40, 47 } else .{ 24, 27, 32 };
    const foreground = [3]u8{ 108, 112, 134 };
    for (0..width) |col| {
        if (col == 0) {
            try out.writeAll(tail);
        } else if (col <= face.len) {
            try out.writeAll(face[col - 1]);
        } else if (sleep_zs_enabled and col >= 7 and position < travel and
            (col - 7 == position or (col - 7 == position + 1 and shift > 0)))
        {
            const amount = if (col - 7 == position) 1 - shift else shift;
            var color: [3]u8 = undefined;
            for (background, foreground, &color) |bg, fg, *channel| {
                channel.* = @intFromFloat(@round(@as(f64, @floatFromInt(bg)) + @as(f64, @floatFromInt(fg - bg)) * amount));
            }
            try out.print("\x1b[38;2;{d};{d};{d}m{s}\x1b[38;2;108;112;134m", .{
                color[0], color[1], color[2], if ((col - 7) % 2 == 0) "ᶻ" else "z",
            });
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

test "sleeping Z crossfade keeps a still face without overflowing" {
    if (!sleep_zs_enabled) return error.SkipZigTest;
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for ([_]usize{ 0, 1, 5, 6, 7, 18, 22, 80, 256, 294, 512 }) |width| {
        var reached_end = false;
        var rested = false;
        for (0..(width + 20) * 8) |step| {
            output.clearRetainingCapacity();
            try idle(&output.writer, width, @intCast(step * 150), 0, false);
            var plain: std.Io.Writer.Allocating = .init(std.testing.allocator);
            defer plain.deinit();
            var ansi = false;
            for (output.written()) |byte| {
                if (byte == 0x1b) ansi = true else if (ansi) {
                    if (byte == 'm') ansi = false;
                } else try plain.writer.writeByte(byte);
            }
            const text = plain.written();
            try std.testing.expectEqual(width, try std.unicode.utf8CountCodepoints(text));
            var letters: usize = 0;
            var glyphs = (try std.unicode.Utf8View.init(text)).iterator();
            while (glyphs.nextCodepoint()) |cp| {
                if (cp == 'z' or cp == 'ᶻ') letters += 1;
            }
            try std.testing.expect(letters <= 2);
            if (width >= 6) {
                try std.testing.expect(std.mem.startsWith(u8, text[1..], "ᐯ◡ᴥ◡ᐯ"));
            }
            if (width > 7) {
                reached_end = reached_end or !std.mem.endsWith(u8, text, " ");
                rested = rested or std.mem.eql(u8, std.mem.trimEnd(u8, text[1..], " "), "ᐯ◡ᴥ◡ᐯ");
            }
        }
        if (width > 7) try std.testing.expect(reached_end and rested);
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
                try std.testing.expect(duration >= 4800);
                try std.testing.expectEqual(@as(i64, 0), @mod(duration, frames.sniff.len * 200));
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
    var seen = [_]bool{false} ** 3;
    var resumed = false;
    var stayed_idle = false;
    for (0..100) |seed| {
        var playback: Playback = .{ .random = .init(seed) };
        playback.update(true, 0);
        seen[@intFromEnum(playback.routine)] = true;
        playback.enter(.idle, 0);
        playback.update(true, Playback.minimum_idle_ms);
        resumed = resumed or playback.routine != .idle;
        stayed_idle = stayed_idle or playback.routine == .idle;
        var sparse = playback;
        for (1..Playback.retry_ms) |ms| playback.update(true, Playback.minimum_idle_ms + @as(i64, @intCast(ms)));
        sparse.update(true, Playback.minimum_idle_ms + Playback.retry_ms - 1);
        try std.testing.expectEqualDeep(sparse, playback);
    }
    try std.testing.expect(seen[0] and seen[1] and seen[2]);
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

test "4C handoff lasts 1200 ms and alternates heights" {
    if (!sleep_zs_enabled) return error.SkipZigTest;
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try idle(&output.writer, 22, 600, 0, false);
    // Halfway: both neighboring glyphs have half the original brightness.
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;66;70;83mᶻ") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;66;70;83mz") != null);
    output.clearRetainingCapacity();
    try idle(&output.writer, 22, 1200, 0, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᶻ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;108;112;134mz") != null);
    output.clearRetainingCapacity();
    try idle(&output.writer, 22, 600, 0, true);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;72;76;91mᶻ") != null);
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
