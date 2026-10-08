//! The Bun viewer's terminal-protocol mechanics, done by the same Corgi and
//! Ghostty code the Zig viewer runs: mirroring a pane surface, drawing its
//! rows, and encoding keys, mouse reports and pastes for its program.
//! Results go to one buffer that `viewer_take` copies out.
const std = @import("std");
const pane = @import("pane");
const keyboard = @import("keyboard");
const vt = pane.terminal.vt;
const a = std.heap.c_allocator;

var out: std.Io.Writer.Allocating = .init(a);

fn written() i64 {
    return @intCast(out.written().len);
}
pub export fn viewer_take(dst: [*]u8, cap: usize) i64 {
    const bytes = out.written();
    if (bytes.len > cap) return -5;
    @memcpy(dst[0..bytes.len], bytes);
    return @intCast(bytes.len);
}

/// `mirror.Terminal.receive` on the terminal itself: installs a surface the
/// daemon sent and the modes its program asked for.
pub export fn viewer_receive(t: *pane.Terminal, data: [*]const u8, len: usize) i32 {
    var arena = std.heap.ArenaAllocator.init(a);
    defer arena.deinit();
    const view = std.json.parseFromSliceLeaky(pane.surface.View, arena.allocator(), data[0..len], .{ .ignore_unknown_fields = true }) catch return -1;
    const frame = view.surface;
    if (frame.cols == 0 or frame.rows == 0) return 1;
    t.resize(frame.cols, frame.rows) catch return -2;
    t.feed("\x1b[?7l\x1b[0m\x1b[H\x1b[2J");
    var bytes: std.Io.Writer.Allocating = .init(a);
    defer bytes.deinit();
    for (frame.lines, 0..) |line, row| bytes.writer.print("\x1b[{d};1H{s}", .{ row + 1, line }) catch return -3;
    (if (frame.cursor) |cursor| bytes.writer.print("\x1b[{d};{d}H\x1b[?25h", .{ cursor.y + 1, cursor.x + 1 }) else bytes.writer.writeAll("\x1b[?25l")) catch return -3;
    t.feed(bytes.written());
    const modes = view.modes;
    const screen_ = &t.vt;
    screen_.modes.set(.bracketed_paste, modes.bracketed_paste);
    screen_.modes.set(.kitty_paste_events, modes.paste_events);
    screen_.modes.set(.cursor_keys, modes.cursor_keys);
    screen_.modes.set(.keypad_keys, modes.keypad_keys);
    screen_.modes.set(.backarrow_key_mode, modes.backarrow);
    screen_.modes.set(.ignore_keypad_with_numlock, modes.numlock);
    screen_.modes.set(.alt_esc_prefix, modes.alt_escape);
    screen_.flags.modify_other_keys_2 = modes.modify_other;
    screen_.screens.active.kitty_keyboard.set(.set, @bitCast(modes.kitty));
    screen_.flags.mouse_event = modes.mouse_event;
    screen_.flags.mouse_format = modes.mouse_format;
    return 0;
}

pub export fn viewer_update_render(t: *pane.Terminal) i32 {
    t.updateRender() catch return -1;
    return 0;
}

/// The pane's rows inside `x, y, w, h`, as render.zig draws them.
pub export fn viewer_rows(t: *pane.Terminal, id: u32, x: u16, y: u16, w: u16, h: u16, dimmed: bool, hovering: bool, hovered: u64) i64 {
    out.clearRetainingCapacity();
    const state = &t.render;
    for (0..@min(state.rows, h)) |row| {
        out.writer.print("\x1b[{d};{d}H", .{ y + row + 1, x + 1 }) catch return -1;
        pane.surface.writeRowHovered(&out.writer, state, t.hyperlinks(), @enumFromInt(id), row, w, dimmed, if (hovering) hovered else null) catch return -1;
    }
    return written();
}

/// The render state's cursor: `x << 16 | y` when in the viewport (and
/// visible, when asked), else -1.
pub export fn viewer_cursor(t: *pane.Terminal, visible: bool) i64 {
    const cursor = t.render.cursor;
    if (visible and !cursor.visible) return -1;
    const at = cursor.viewport orelse return -1;
    return (@as(i64, at.x) << 16) | @as(i64, at.y);
}

/// The program's mouse event mode: 0 when it takes no mouse input.
pub export fn viewer_mouse_event(t: *pane.Terminal) i32 {
    return @intFromEnum(t.vt.flags.mouse_event);
}
pub export fn viewer_mode(t: *pane.Terminal, which: u32) bool {
    return switch (which) {
        0 => t.vt.modes.get(.bracketed_paste),
        1 => t.vt.modes.get(.kitty_paste_events),
        else => false,
    };
}

/// A decoded key, encoded for `t`'s program, or with the default options
/// (the legacy encoding Corgi's own shortcuts read) when `t` is null.
pub export fn viewer_encode_key(t: ?*pane.Terminal, codepoint: u32, mods: u32) i64 {
    out.clearRetainingCapacity();
    const key: keyboard.Key = .{ .codepoint = @intCast(codepoint), .mods = .{
        .shift = mods & 1 != 0,
        .alt = mods & 2 != 0,
        .ctrl = mods & 4 != 0,
        .super = mods & 8 != 0,
        .caps_lock = mods & 64 != 0,
        .num_lock = mods & 128 != 0,
    } };
    const options: vt.input.KeyEncodeOptions = if (t) |term| .fromTerminal(&term.vt) else .{};
    key.encode(&out.writer, options) catch return -1;
    return written();
}

/// `Controller.sendMouse`: a host SGR report re-encoded for the program, at
/// `x, y` relative to its pane.
pub export fn viewer_encode_mouse(t: *pane.Terminal, button: u16, x: f32, y: f32, release: bool) i64 {
    out.clearRetainingCapacity();
    var opts = vt.input.MouseEncodeOptions.fromTerminal(&t.vt, .{
        .screen = .{ .width = t.vt.cols, .height = t.vt.rows },
        .cell = .{ .width = 1, .height = 1 },
        .padding = .{},
    });
    opts.any_button_pressed = !release and button & 3 != 3;
    const btn: ?vt.input.MouseButton = switch (button & 0xc3) {
        0 => .left,
        1 => .middle,
        2 => .right,
        64 => .four,
        65 => .five,
        66 => .six,
        67 => .seven,
        else => null,
    };
    vt.input.encodeMouse(&out.writer, .{
        .action = if (release) .release else if (button & 32 != 0) .motion else .press,
        .button = btn,
        .mods = .{ .shift = button & 4 != 0, .alt = button & 8 != 0, .ctrl = button & 16 != 0 },
        .pos = .{ .x = x, .y = y },
    }, opts) catch return -1;
    return written();
}

/// Ghostty's paste encoding; `part` picks one of its three parts, or -1 all.
pub export fn viewer_paste(data: [*]const u8, len: usize, bracketed: bool, part: i32) i64 {
    out.clearRetainingCapacity();
    const text = a.dupe(u8, data[0..len]) catch return -1;
    defer a.free(text);
    const parts = vt.input.encodePaste(text, .{ .bracketed = bracketed });
    for (parts, 0..) |bytes, i| if (part < 0 or part == i) out.writer.writeAll(bytes) catch return -1;
    return written();
}
pub export fn viewer_paste_safe(data: [*]const u8, len: usize) bool {
    return vt.input.isSafePasteWith(data[0..len], .{ .bracketed = true });
}
