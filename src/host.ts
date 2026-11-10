//! The terminal a viewer draws on and the preferences it keeps. Every
//! machine's controller in one viewer shares the one host.
import type * as corgiBadge from "./corgi_badge";
import type * as forkMotion from "./fork_hero";
import type { Pacer } from "./frame_pacing";
import type { State as ClipboardState } from "./host_clipboard";
import type { Probe } from "./terminal_info";
import type { Rgb } from "./palette";
import { Preferences } from "./preferences";
import type { Colors as TerminalColors } from "./terminal_palette";
import type { RGB } from "./theme";

export class Host {
  /** Saved preferences as this viewer last loaded or set them. The sidebar
   * width is live while dragging and saved on release. */
  prefs: Preferences;
  corgi_badge: corgiBadge.Mode = "none";
  supports_kitty_graphics = false;
  /** The host's cell in pixels, when it reports it. */
  cell_pixels: forkMotion.Cell | null = null;
  /** Whether the host draws Kitty's branch drawing characters. */
  branch_glyphs = false;
  /** The host's colors, when it reports them; both themes follow them. */
  colors: TerminalColors | null = null;
  /** OSC 22 uses X11 names in iTerm2, CSS names in Ghostty/Kitty. */
  iterm2_pointer = false;
  /** The host terminal's clipboard, read over SSH. */
  clipboard: ClipboardState | null = null;
  /** The host terminal's frame pacing, for Terminal capabilities. */
  pacer: Pacer | null = null;
  constructor(prefs = new Preferences()) {
    this.prefs = prefs;
  }
  /** Takes the colors the terminal answered with. */
  recolor(probe: Probe): void {
    this.colors = colors(probe);
  }
  /** Takes what the terminal reported since the last frame. True when the
   * badge changed, which every frame shows. */
  observe(probe: Probe, cell: forkMotion.Cell | null): boolean {
    this.cell_pixels = cell;
    // Over SSH, TERM may not name the terminal; XTVERSION does.
    if (branchGlyphs(probe.clipboard.terminal.text())) this.branch_glyphs = true;
    const badge = probe.badge.mode(),
      graphics = probe.badge.supports_kitty_graphics && cell !== null;
    if (badge === this.corgi_badge && graphics === this.supports_kitty_graphics) return false;
    this.corgi_badge = badge;
    this.supports_kitty_graphics = graphics;
    return true;
  }
}
/** The host this process draws on. Read the attaching viewer's environment:
 * one daemon can serve several terminals. */
export function attach(prefs: Preferences, probe: Probe | null): Host {
  const host = new Host(prefs);
  host.iterm2_pointer = process.env.TERM_PROGRAM === "iTerm.app";
  host.branch_glyphs = branchGlyphs(process.env.TERM ?? "") || branchGlyphs(process.env.TERM_PROGRAM ?? "");
  if (probe) {
    host.clipboard = probe.clipboard;
    host.pacer = probe.pacer;
    host.colors = colors(probe);
  }
  return host;
}
/** The host's colors, when it answered the probe with its foreground and background. */
function colors(probe: Probe): TerminalColors | null {
  const { foreground, background, palette } = probe.theme,
    rgb = (c: RGB | null): Rgb | null => (c ? [c.r, c.g, c.b] : null);
  if (!foreground || !background) return null;
  return { foreground: rgb(foreground)!, background: rgb(background)!, ansi: palette.map(rgb) };
}
/** Whether a terminal by this name draws Kitty's branch drawing characters:
 * Ghostty and Kitty do. */
function branchGlyphs(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("ghostty") || lower.includes("kitty");
}
