const std = @import("std");
const frames = @import("corgi_frames.zig");

fn tick(now_ms: i64, seed: u64) usize {
    return @intCast(@as(u64, @intCast(@divFloor(@max(now_ms, 0), 200))) + seed % 997);
}

const routines = [_][]const []const u8{ &frames.wag, &frames.fetch, &frames.sniff };

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
    const rest = "ᐯ•ᴥ•ᐯ";
    const alert = "ᐯ•ᴥ•ᐱ";
    const held = "ᐯ•●•ᐱ";
    const end = width - 1;
    if (stage(&p, 8)) return .{ .dog = if (p == 4) "ᐯ◡ᴥ◡ᐯ" else rest };
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
    if (stage(&p, 3)) return .{ .dog = alert };
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
                if (std.mem.eql(u8, current.dog, "ᐯ•ᴥ•ᐯ") and std.mem.eql(u8, next.dog, "ᐯ•ᴥ•ᐱ")) current.dog = next.dog;
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
            try out.writeAll(dog.nextCodepointSlice() orelse " ");
        } else try out.writeByte(' ');
    }
}

pub const Playback = struct {
    active: bool = false,
    choice: ?usize = null,
    started_ms: i64 = 0,

    fn update(self: *Playback, active: bool, now_ms: i64) void {
        if (active and !self.active) {
            // A fresh fallback period gets a new routine; never switch mid-period.
            self.choice = if (self.choice) |previous|
                (previous + 1 + std.crypto.random.uintLessThan(usize, routines.len - 1)) % routines.len
            else
                std.crypto.random.uintLessThan(usize, routines.len);
            self.started_ms = now_ms;
        }
        self.active = active;
    }

    pub fn write(self: Playback, out: *std.Io.Writer, room: usize, now_ms: i64) !void {
        if (self.choice == 1 and room >= 18) {
            try writeFetch(out, room, @intCast(@divFloor(@max(now_ms - self.started_ms, 0), 100)));
            return;
        }
        var glyphs = (std.unicode.Utf8View.init(self.frame(room, now_ms)) catch unreachable).iterator();
        for (0..room) |_| {
            try out.writeAll(glyphs.nextCodepointSlice() orelse break);
        }
    }

    pub fn frame(self: Playback, room: usize, now_ms: i64) []const u8 {
        const choice = self.choice orelse 0;
        const routine = if (choice == 1 and room < 18) &frames.wag else routines[choice];
        const phase = tick(@max(now_ms - self.started_ms, 0), 0);
        return routine[phase % routine.len];
    }
};

// Viewer-local state: enough slots for more than two full agent sidebars.
const Slot = struct { key: ?u64 = null, seen: bool = false, playback: Playback = .{} };
var slots: [256]Slot = @splat(.{});

pub fn beginFrame() void {
    for (&slots) |*slot| slot.seen = false;
}
pub fn endFrame() void {
    for (&slots) |*slot| if (!slot.seen) {
        slot.playback.active = false;
    };
}
pub fn observe(key: u64, active: bool, now_ms: i64) ?*Playback {
    for (&slots) |*slot| if (slot.key == key) {
        slot.seen = true;
        slot.playback.update(active, now_ms);
        return &slot.playback;
    };
    if (!active) return null;
    for (&slots) |*slot| if (!slot.playback.active and !slot.seen) {
        slot.* = .{ .key = key, .seen = true };
        slot.playback.update(true, now_ms);
        return &slot.playback;
    };
    unreachable; // At most 80 entries are rendered by a sidebar.
}

/// 4C: an eight-frame brightness handoff, alternating high/low every 600 ms.
pub fn idle(out: *std.Io.Writer, width: usize, now_ms: i64, seed: u64, focused: bool) !void {
    const face = [_][]const u8{ "ᐯ", "◡", "ᴥ", "◡", "ᐯ" };
    const travel = width -| 6;
    const elapsed: u64 = @intCast(@max(now_ms, 0));
    // Retain the quiet eight-second pause between traversals.
    const phase = (elapsed + (seed % 997) * 600) % (travel * 600 + 8000);
    const position = phase / 600;
    const t: f64 = @as(f64, @floatFromInt((phase % 600) / 75)) / 8;
    const shift = t * t * (3 - 2 * t);
    const background: [3]u8 = if (focused) .{ 35, 40, 47 } else .{ 24, 27, 32 };
    const foreground = [3]u8{ 108, 112, 134 };
    for (0..width) |col| {
        if (col < face.len) {
            try out.writeAll(face[col]);
        } else if (col >= 6 and position < travel and
            (col - 6 == position or (col - 6 == position + 1 and shift > 0)))
        {
            const amount = if (col - 6 == position) 1 - shift else shift;
            var color: [3]u8 = undefined;
            for (background, foreground, &color) |bg, fg, *channel| {
                channel.* = @intFromFloat(@round(@as(f64, @floatFromInt(bg)) + @as(f64, @floatFromInt(fg - bg)) * amount));
            }
            try out.print("\x1b[38;2;{d};{d};{d}m{s}\x1b[38;2;108;112;134m", .{
                color[0], color[1], color[2], if ((col - 6) % 2 == 0) "ᶻ" else "z",
            });
        } else try out.writeByte(' ');
    }
}

test "half-cell ball travel keeps the impact before the perk and preserves pickup pause" {
    const landed = fetchScene(18, 26);
    try std.testing.expectEqualStrings("ᐯ•ᴥ•ᐯ", landed.dog);
    try std.testing.expectEqualStrings("⡀", landed.mark);
    const reacted = fetchScene(18, 27);
    try std.testing.expectEqualStrings("ᐯ•ᴥ•ᐱ", reacted.dog);
    try std.testing.expectEqualStrings("⢀", reacted.mark);
    for (78..88) |step| try std.testing.expectEqualStrings("ᐯ•●•ᐱ", fetchScene(18, step).dog);
    const left = fetchScene(22, 36);
    const right = fetchScene(22, 37);
    const advance = fetchScene(22, 38);
    try std.testing.expectEqual(left.ball, right.ball);
    try std.testing.expectEqual(left.ball.? + 1, advance.ball.?);
    try std.testing.expectEqualStrings("⡀", left.mark);
    try std.testing.expectEqualStrings("⢀", right.mark);
    try std.testing.expectEqualStrings("⡀", advance.mark);
}

test "sleeping Z crossfade reaches last column without changing face or overflowing" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    for ([_]usize{ 0, 1, 5, 6, 7, 18, 22, 80, 256, 294, 512 }) |width| {
        var reached_end = false;
        var rested = false;
        for (0..(width + 20) * 8) |step| {
            output.clearRetainingCapacity();
            try idle(&output.writer, width, @intCast(step * 75), 0, false);
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
            if (width >= 5) try std.testing.expect(std.mem.startsWith(u8, text, "ᐯ◡ᴥ◡ᐯ"));
            if (width > 6) {
                reached_end = reached_end or !std.mem.endsWith(u8, text, " ");
                rested = rested or std.mem.eql(u8, std.mem.trimEnd(u8, text, " "), "ᐯ◡ᴥ◡ᐯ");
            }
        }
        if (width > 6) try std.testing.expect(reached_end and rested);
    }
}

test "one routine loops for the entire fallback period then a different one is picked" {
    var playback: Playback = .{};
    for (0..20) |period| {
        const previous = playback.choice;
        const start: i64 = @intCast(period * 1000000);
        playback.update(true, start);
        const choice = playback.choice.?;
        if (previous) |old| try std.testing.expect(old != choice);
        for (0..300) |step| {
            const now = start + @as(i64, @intCast(step * 200));
            playback.update(true, now);
            try std.testing.expectEqual(choice, playback.choice.?);
            try std.testing.expectEqualStrings(routines[choice][step % routines[choice].len], playback.frame(22, now));
        }
        playback.update(false, start + 100000);
    }
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
        }
        try std.testing.expect(reached_edge);
    }
}

test "4C handoff lasts 600 ms and alternates heights" {
    var output: std.Io.Writer.Allocating = .init(std.testing.allocator);
    defer output.deinit();
    try idle(&output.writer, 22, 300, 0, false);
    // Halfway: both neighboring glyphs have half the original brightness.
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;66;70;83mᶻ") != null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;66;70;83mz") != null);
    output.clearRetainingCapacity();
    try idle(&output.writer, 22, 600, 0, false);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "ᶻ") == null);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;108;112;134mz") != null);
    output.clearRetainingCapacity();
    try idle(&output.writer, 22, 300, 0, true);
    try std.testing.expect(std.mem.indexOf(u8, output.written(), "\x1b[38;2;72;76;91mᶻ") != null);
}
