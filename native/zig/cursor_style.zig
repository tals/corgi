//! The cursor shape a program picks with DECSCUSR (`CSI Ps SP q`).
const vt = @import("ghostty-vt");

/// Each value is its DECSCUSR `Ps`. `default` is the terminal's own cursor.
pub const Style = enum(u8) {
    default,
    blinking_block,
    steady_block,
    blinking_underline,
    steady_underline,
    blinking_bar,
    steady_bar,
};

/// The DECSCUSR that selects `t`'s cursor, as Ghostty reports it to DECRQSS.
pub fn of(t: *const vt.Terminal) Style {
    if (t.cursor.is_default) return .default;
    const blink = t.modes.get(.cursor_blinking);
    return switch (t.screens.active.cursor.cursor_style) {
        .block, .block_hollow => if (blink) .blinking_block else .steady_block,
        .underline => if (blink) .blinking_underline else .steady_underline,
        .bar => if (blink) .blinking_bar else .steady_bar,
    };
}
