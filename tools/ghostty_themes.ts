/**
 * Ghostty's bundled themes, for the probe to answer color queries with and
 * for the theme browser to list, led by the colors Ghostty uses when no
 * theme is set. `GHOSTTY_THEMES` overrides the folder.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { Rgb } from "../src/palette";

export const themes_dir = process.env.GHOSTTY_THEMES ?? "/Applications/Ghostty.app/Contents/Resources/ghostty/themes";

export interface GhosttyTheme {
  name: string;
  foreground: Rgb;
  background: Rgb;
  palette: (Rgb | null)[];
}
const hex = (value: string): Rgb | null => {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [n >> 16, (n >> 8) & 255, n & 255];
};
/** The name for Ghostty's colors without a theme. */
export const default_name = "Ghostty default";
const ghostty_bin = process.env.GHOSTTY_BIN ?? join(themes_dir, "../../../MacOS/ghostty");
function defaults(): string | null {
  if (!existsSync(ghostty_bin)) return null;
  const run = spawnSync(ghostty_bin, ["+show-config", "--default"], { encoding: "utf8" });
  return run.status === 0 ? run.stdout : null;
}
export function names(): string[] {
  const bundled = readdirSync(themes_dir).sort((a, b) => a.localeCompare(b));
  return defaults() === null ? bundled : [default_name, ...bundled];
}
/** A theme by name, or by path to a theme file. */
export function load(name: string): GhosttyTheme {
  if (name === default_name) return parse(name, defaults() ?? "");
  const file = existsSync(name) ? name : join(themes_dir, name);
  return parse(name, readFileSync(file, "utf8"));
}
function parse(name: string, config: string): GhosttyTheme {
  const theme: GhosttyTheme = {
    name,
    foreground: [255, 255, 255],
    background: [0, 0, 0],
    palette: Array(16).fill(null),
  };
  for (const line of config.split("\n")) {
    const m = /^\s*([a-z-]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    if (m[1] === "palette") {
      const [index, color] = m[2].split("=");
      if (+index < 16) theme.palette[+index] = hex(color);
    } else if (m[1] === "background") theme.background = hex(m[2]) ?? theme.background;
    else if (m[1] === "foreground") theme.foreground = hex(m[2]) ?? theme.foreground;
  }
  return theme;
}
/** The theme as Corgi's `Terminal.applyTheme` and the daemon take it. */
export function asTerminalTheme(theme: GhosttyTheme) {
  const rgb = (c: Rgb | null) => (c ? { r: c[0], g: c[1], b: c[2] } : null);
  return { foreground: rgb(theme.foreground), background: rgb(theme.background), palette: theme.palette.map(rgb) };
}
/** The reply a terminal gives to an OSC 10, 11 or 4 query. */
export function reply(theme: GhosttyTheme, query: string): string | null {
  const color = query === "10" ? theme.foreground : query === "11" ? theme.background : null;
  const indexed = /^4;(\d+)$/.exec(query);
  const rgb = color ?? (indexed ? theme.palette[+indexed[1]] : null);
  if (!rgb) return null;
  const four = (v: number) => (v * 257).toString(16).padStart(4, "0");
  return `\x1b]${query};rgb:${rgb.map(four).join("/")}\x1b\\`;
}
