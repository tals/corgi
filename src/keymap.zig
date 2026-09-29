//! Key presets and the prefix key. What each key does is in bindings.zig.
pub const Preset = enum { corgi, tmux, herdr, cmux };
pub const available_presets: []const Preset = if (@import("builtin").os.tag == .macos) &.{ .corgi, .tmux, .herdr, .cmux } else &.{ .corgi, .tmux, .herdr };
pub fn supportedPreset(preset: Preset) Preset {
    return if (preset == .cmux and @import("builtin").os.tag != .macos) .corgi else preset;
}
pub const Prefix = enum { ctrl_b, ctrl_a };
pub fn prefixByte(p: Prefix) u8 {
    return if (p == .ctrl_a) 1 else 2;
}
pub fn prefixName(p: Prefix) []const u8 {
    return switch (p) {
        .ctrl_b => "Ctrl+B",
        .ctrl_a => "Ctrl+A",
    };
}
pub fn name(p: Preset) []const u8 {
    return switch (p) {
        .corgi => "Corgi",
        .tmux => "tmux",
        .herdr => "Herdr",
        .cmux => "cmux",
    };
}
pub fn description(p: Preset) []const u8 {
    return switch (p) {
        .corgi => "Made for Corgi",
        .tmux => "Prefix + classic splits",
        .herdr => "Prefix + home row",
        .cmux => "Command shortcuts",
    };
}
