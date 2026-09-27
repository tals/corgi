//! Presets resolve to the controller's action keys; terminal input stays untouched
//! unless a prefix or an explicitly bound modifier is present.
const keyboard = @import("keyboard.zig");
pub const Preset = enum { corgi, tmux, herdr, cmux };
pub const available_presets: []const Preset = if (@import("builtin").os.tag == .macos) &.{ .corgi, .tmux, .herdr, .cmux } else &.{ .corgi, .tmux, .herdr };
pub fn supportedPreset(preset: Preset) Preset {
    return if (preset == .cmux and @import("builtin").os.tag != .macos) .corgi else preset;
}
pub const Prefix = enum { ctrl_b, ctrl_a };
pub fn prefixByte(p: Prefix) u8 {
    return if (p == .ctrl_a) 1 else 2;
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
pub const workspace_picker: u8 = 240;
pub const cycle_next: u8 = 241;
pub const cycle_prev: u8 = 242;
pub const close_workspace: u8 = 243;
pub const paste: u8 = 244;
pub fn resolve(p: Preset, key: u8) ?u8 {
    if (p == .corgi or p == .cmux) return key;
    if (p == .tmux) return switch (key) {
        'c', 'a', 'n', 'p', 'z', 'x', 'b', '?', 'u', 'm', '!', '{', '}' => key,
        '0'...'8' => key + 1,
        '9' => 245,
        ',' => 'T',
        '&' => 'X',
        '$' => 'W',
        'N' => 'w',
        's' => workspace_picker,
        '%' => 'v',
        '"' => '-',
        'o' => cycle_next,
        '[' => 's',
        ']' => paste,
        'd' => 'q',
        'G' => 'g',
        'F' => 'f',
        'C' => 'i',
        else => null,
    };
    return switch (key) {
        'c', 'a', 'n', 'p', '1'...'9', 'T', 'X', 'W', 'v', '-', 'h', 'j', 'k', 'l', 'H', 'J', 'K', 'L', 'z', 'r', 'x', 'q', 'b', '?', 'u', 'm', '!', '{', '}' => key,
        'w', 'g' => workspace_picker,
        'N' => 'w',
        'D' => close_workspace,
        9 => cycle_next,
        '[' => 's',
        'f' => 'g',
        'o' => 'f',
        's' => 'i',
        else => null,
    };
}
pub fn shortcut(p: Preset, action: u8) ?u8 {
    if (p == .corgi or p == .cmux) return action;
    // Choose the first printable spelling (Tab is handled separately).
    var k: u16 = 32;
    while (k < 127) : (k += 1) if (resolve(p, @intCast(k)) == action) return @intCast(k);
    if (resolve(p, 9) == action) return 9;
    return null;
}
pub const Modified = union(enum) { action: u8, workspace: usize, resize: u8 };
pub fn modified(p: Preset, prefixed: bool, k: keyboard.Key) ?Modified {
    const cp: u21 = if (k.codepoint >= 'A' and k.codepoint <= 'Z')
        k.codepoint + 32
    else if (k.mods.shift and k.codepoint == '}')
        ']'
    else if (k.mods.shift and k.codepoint == '{')
        '['
    else
        k.codepoint;
    const m = k.mods;
    const dir: ?u8 = switch (cp) {
        57350 => 'h',
        57351 => 'l',
        57352 => 'k',
        57353 => 'j',
        else => null,
    };
    if (prefixed and p == .tmux) if (dir) |d| return if (m.ctrl) .{ .resize = d } else .{ .action = d };
    if (prefixed and p == .herdr and (cp == 9 or cp == 57346) and m.shift) return .{ .action = cycle_prev };
    if (p != .cmux) return null;
    if (m.ctrl and !m.super and !m.alt) {
        if (!m.shift and cp >= '1' and cp <= '9') return .{ .action = @intCast(cp) };
        if (m.shift and (cp == 'h' or cp == 'j' or cp == 'k' or cp == 'l')) return .{ .resize = @intCast(cp) };
    }
    if (!m.super or m.ctrl) return null;
    if (m.alt) {
        if (dir) |d| return .{ .action = d };
        return null;
    }
    if (m.shift) return .{ .action = switch (cp) {
        'd' => '-',
        'r' => 'W',
        'w' => close_workspace,
        ']' => 'n',
        '[' => 'p',
        13, 57345 => 'z',
        'm' => 's',
        'p' => 'g',
        'u' => 'f',
        else => return null,
    } };
    if (cp >= '1' and cp <= '9') return .{ .workspace = cp - '1' };
    return .{ .action = switch (cp) {
        't' => 'c',
        'n' => 'w',
        'r' => 'T',
        'p' => workspace_picker,
        'd' => 'v',
        'w' => 'x',
        'b' => 'b',
        ',' => 'i',
        else => return null,
    } };
}

pub const HelpSection = enum { tabs, workspaces, agents, panes, terminal, corgi };
pub const HelpHint = struct {
    section: HelpSection,
    key: []const u8,
    label: []const u8,
    prefixed: bool = true,
};
pub fn helpHints(preset: Preset) []const HelpHint {
    return switch (preset) {
        .cmux => &.{
            .{ .section = .tabs, .key = "Cmd+T", .label = "New tab → agent picker", .prefixed = false },
            .{ .section = .tabs, .key = "Ctrl+1–9", .label = "Select tab", .prefixed = false },
            .{ .section = .tabs, .key = "Cmd+R", .label = "Rename tab", .prefixed = false },
            .{ .section = .tabs, .key = "Cmd+Shift+] / [", .label = "Next / previous tab", .prefixed = false },
            .{ .section = .workspaces, .key = "Cmd+N", .label = "New workspace", .prefixed = false },
            .{ .section = .workspaces, .key = "Cmd+1–9", .label = "Select workspace", .prefixed = false },
            .{ .section = .workspaces, .key = "Cmd+Shift+R", .label = "Rename workspace", .prefixed = false },
            .{ .section = .workspaces, .key = "Cmd+Shift+W", .label = "Close workspace", .prefixed = false },
            .{ .section = .workspaces, .key = "Cmd+P", .label = "Choose workspace", .prefixed = false },
            .{ .section = .panes, .key = "Cmd+D", .label = "Split right", .prefixed = false },
            .{ .section = .panes, .key = "Cmd+Shift+D", .label = "Split down", .prefixed = false },
            .{ .section = .panes, .key = "Cmd+Opt+arrows", .label = "Focus pane", .prefixed = false },
            .{ .section = .panes, .key = "Cmd+Shift+Enter", .label = "Zoom pane", .prefixed = false },
            .{ .section = .panes, .key = "Ctrl+Shift+HJKL", .label = "Resize pane", .prefixed = false },
            .{ .section = .panes, .key = "Cmd+W", .label = "Close focused pane", .prefixed = false },
            .{ .section = .terminal, .key = "Cmd+Shift+M", .label = "Scroll / copy", .prefixed = false },
            .{ .section = .terminal, .key = "Cmd+V", .label = "Paste (host terminal)", .prefixed = false },
            .{ .section = .agents, .key = "Cmd+Shift+P", .label = "Find agent", .prefixed = false },
            .{ .section = .agents, .key = "Cmd+Shift+U", .label = "Jump to attention", .prefixed = false },
            .{ .section = .corgi, .key = "Cmd+B", .label = "Toggle sidebar", .prefixed = false },
            .{ .section = .corgi, .key = "Cmd+,", .label = "Corgi setup", .prefixed = false },
        },
        .tmux => &.{
            .{ .section = .panes, .key = "← ↓ ↑ →", .label = "Focus pane" },
            .{ .section = .panes, .key = "Ctrl+arrows", .label = "Resize pane" },
            .{ .section = .tabs, .key = "0–9", .label = "Select tab" },
        },
        .herdr => &.{
            .{ .section = .panes, .key = "Shift+Tab", .label = "Previous pane" },
            .{ .section = .tabs, .key = "1–9", .label = "Select tab" },
            .{ .section = .workspaces, .key = "g", .label = "Choose workspace" },
        },
        .corgi => &.{
            .{ .section = .tabs, .key = "Ctrl+T", .label = "New tab → agent picker", .prefixed = false },
            .{ .section = .tabs, .key = "1–9", .label = "Select tab" },
        },
    };
}
