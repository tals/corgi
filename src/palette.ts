//! The Omarchy panel runs this in Qt's QML engine (corgi-omarchy/tools/motion-build.ts):
//! no BigInt literals or `Intl`, and builtins Qt lacks only through
//! the Omarchy plugin's qml_shims.js.
import * as terminalPalette from "./terminal_palette";

export type Rgb = [number, number, number];
const corgi = {
  bg: [24, 27, 32],
  surface: [35, 40, 47],
  selected: [51, 57, 65],
  line: [80, 90, 101],
  faint: [131, 144, 158],
  muted: [165, 174, 184],
  text: [209, 214, 219],
  strong: [238, 241, 244],
  accent: [123, 241, 168],
  warm: [229, 195, 139],
  hot: [237, 163, 152],
} satisfies Record<string, Rgb>;
export type Token = keyof typeof corgi;
/** Corgi keeps its own colors, on the terminal's background when that is
 * dark enough and on its own otherwise; Animal Style takes all its colors
 * from the terminal's. */
export type Theme = "corgi" | "animal_style";
export const themes: Record<Theme, { label: string }> = {
  corgi: { label: "Corgi" },
  animal_style: { label: "Animal Style" },
};
export const available_themes = Object.keys(themes) as Theme[];
export function parseTheme(name: string): Theme | null {
  return Object.hasOwn(themes, name) ? (name as Theme) : null;
}
/** The colors in use. `use` repaints them in place, so a held token stays current. */
export const colors = Object.fromEntries(
  Object.entries(corgi).map(([token, rgb]) => [token, [...rgb] as Rgb]),
) as Record<Token, Rgb>;
let current: Theme = "corgi";
/** Each theme's tokens on the terminal's colors, and whether its `bg` is left to the terminal. */
type Look = { colors: Record<Token, Rgb>; clear: boolean };
function looks(host: terminalPalette.Colors | null): Record<Theme, Look> {
  const kept = host && terminalPalette.onBackground(corgi, host.background);
  return {
    corgi: kept ? { colors: kept, clear: true } : { colors: corgi, clear: false },
    animal_style: host ? terminalPalette.tokens(host) : { colors: corgi, clear: true },
  };
}
/** The terminal's colors as `use` last had them, and each theme's look on them. */
let terminal: terminalPalette.Colors | null = null,
  look = looks(null);
const refreshers: (() => void)[] = [];
/** Runs `refresh` now and after every theme change, for strings and colors
 * a module computes from tokens once. */
export function derived(refresh: () => void) {
  refresh();
  refreshers.push(refresh);
}
/** `host` holds the terminal's colors, when it answered. Without them,
 * Corgi paints its own background and Animal Style keeps Corgi's colors on
 * the terminal's. Without a `choice`, the terminal picks (`chosen`). */
export function use(choice: Theme | undefined, host: terminalPalette.Colors | null = null) {
  const recolored = host !== terminal;
  if (recolored) {
    terminal = host;
    look = looks(host);
  }
  const name = chosen(choice);
  if (name === current && !recolored) return;
  current = name;
  const next = tokensOf(name);
  for (const token of Object.keys(colors) as Token[]) colors[token].splice(0, 3, ...next[token]);
  for (const refresh of refreshers) refresh();
}
/** The theme a choice means: one picked, or Animal Style on a light
 * terminal and Corgi otherwise. */
export function chosen(choice: Theme | undefined): Theme {
  return choice ?? (terminal && terminalPalette.light(terminal) ? "animal_style" : "corgi");
}
/** The background the theme in use paints under everything, or null when it
 * leaves the terminal's own. */
export function painted(): Rgb | null {
  return paints(current) ? colors.bg : null;
}
function tokensOf(theme: Theme): Record<Token, Rgb> {
  return look[theme].colors;
}
/** Whether `theme` paints `bg` rather than leave it to the terminal. */
function paints(theme: Theme): boolean {
  return !look[theme].clear;
}
/** `theme` lets a preview show another theme's colors. */
export function fg(t: Token, theme: Theme = current) {
  return fgRgb(tokensOf(theme)[t]);
}
/** `t` painted in `theme`'s colors even where the theme leaves `bg` to the
 * terminal: a preview beside another theme can't use the terminal's, which
 * Corgi may have moved to its own (`host_background.ts`). */
export function swatch(t: Token, theme: Theme): string {
  return bgRgb(tokensOf(theme)[t]);
}
export function bg(t: Token, theme: Theme = current) {
  return `\x1b[${bgFields(t, theme).join(";")}m`;
}
function bgFields(t: Token, theme: Theme): string[] {
  if (t === "bg" && !paints(theme)) return ["49"];
  return ["48", "2", ...tokensOf(theme)[t].map(String)];
}
export function fgRgb(c: Rgb) {
  return `\x1b[38;2;${c.join(";")}m`;
}
export function bgRgb(c: Rgb) {
  return `\x1b[48;2;${c.join(";")}m`;
}
export function mix(a: Rgb, b: Rgb, percentage: number): Rgb {
  return a.map((v, i) =>
    Math.floor((v * (100 - Math.min(100, percentage)) + b[i] * Math.min(100, percentage) + 50) / 100),
  ) as Rgb;
}
export class Style {
  constructor(
    public value: {
      fg?: Token;
      bg?: Token;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      strike?: boolean;
    } = {},
  ) {}
  sgr() {
    const fields = ["0"];
    if (this.value.bold) fields.push("1");
    if (this.value.italic) fields.push("3");
    if (this.value.underline) fields.push("4");
    if (this.value.strike) fields.push("9");
    if (this.value.fg) fields.push("38", "2", ...colors[this.value.fg].map(String));
    if (this.value.bg) fields.push(...bgFields(this.value.bg, current));
    return `\x1b[${fields.join(";")}m`;
  }
}
export let keycap: string;
/** The focused pane's or sidebar list's outline: `accent` halfway into
 * `line`, so a long edge doesn't shout. */
export let outline: Rgb;
/** Selected text in any text box, and its background alone: a tint of the
 * accent on `selected`, so it doesn't glare. */
export let selection: string;
export let selection_bg: Rgb;
/** A button that does what's chosen, such as creating it: bold accent on a
 * tint of the accent, not its full strength, so it doesn't glare on `surface`. */
export let call_to_action: string;
export let call_to_action_bg: Rgb;
derived(() => {
  keycap = new Style({ fg: "strong", bg: "line", bold: true }).sgr();
  outline = mix(colors.accent, colors.line, 50);
  selection_bg = mix(colors.selected, colors.accent, 30);
  selection = fgRgb(colors.strong) + bgRgb(selection_bg);
  call_to_action_bg = mix(colors.surface, colors.accent, 22);
  call_to_action = "\x1b[0m" + bgRgb(call_to_action_bg) + "\x1b[1m" + fgRgb(colors.accent);
});

/** Code colors, a family apart from the UI tokens: in code, green, warm and
 * coral still mean added, needs you and removed. Corgi has its own; Animal
 * Style takes the terminal's magenta, blue and cyan. Each is lifted toward
 * `text` until it reads on `bg`. */
export type Syntax = "keyword" | "string" | "number" | "type" | "function" | "property" | "comment" | "punctuation";
const corgi_syntax = {
  keyword: [196, 167, 242],
  string: [167, 201, 234],
  number: [230, 177, 214],
  type: [134, 207, 208],
  property: [180, 196, 221],
} satisfies Record<string, Rgb>;
/** ANSI slots, normal then bright, each syntax hue takes in Animal Style. */
const syntax_slots: Record<keyof typeof corgi_syntax, number[]> = {
  keyword: [5, 13],
  string: [4, 12],
  number: [13, 5],
  type: [6, 14],
  property: [12, 4],
};
export const syntax = {} as Record<Syntax, Rgb>;
function readableOnBg(rgb: Rgb): Rgb {
  let out = rgb;
  for (let step = 10; step <= 100 && terminalPalette.contrast(out, colors.bg) < 4.6; step += 10)
    out = mix(rgb, colors.text, step);
  return out;
}
derived(() => {
  const host = current === "animal_style" ? terminal : null;
  for (const name of Object.keys(corgi_syntax) as (keyof typeof corgi_syntax)[]) {
    const own = syntax_slots[name].map(slot => host?.ansi[slot] ?? null).find(c => c !== null);
    syntax[name] = readableOnBg(own ?? corgi_syntax[name]);
  }
  syntax.function = colors.strong;
  syntax.comment = colors.faint;
  syntax.punctuation = colors.muted;
});

export function underline(token: Token) {
  return `\x1b[58:2::${colors[token].join(":")}m`;
}
export function writeFg(writer: { write(value: string): unknown }, rgb: Rgb) {
  writer.write(fgRgb(rgb));
}
export function luminance(rgb: Rgb) {
  return rgb.reduce((sum, channel, index) => {
    const value = channel / 255;
    return (
      sum + [0.2126, 0.7152, 0.0722][index] * (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}
export function contrast(first: Token, second: Token) {
  const a = luminance(corgi[first]),
    b = luminance(corgi[second]);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
export function termhtmlTheme() {
  const hex = (token: Token) => "#" + corgi[token].map(value => value.toString(16).padStart(2, "0")).join("");
  return (
    "corgi: { " +
    (Object.keys(corgi) as Token[]).map(token => `${token}: "${hex(token)}", `).join("") +
    `fg: "${hex("text")}", danger: "${hex("hot")}" },`
  );
}
