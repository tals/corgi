import { expect, test } from "bun:test";
import type { Rgb, Token } from "./palette";
import { contrast, onBackground, tokens, type Colors } from "./terminal_palette";

const hex = (value: string): Rgb => [0, 2, 4].map(i => parseInt(value.slice(i + 1, i + 3), 16)) as Rgb;
function theme(background: string, foreground: string, ansi: string[]): Colors {
  return { background: hex(background), foreground: hex(foreground), ansi: ansi.map(hex) };
}
// Ghostty's own theme files, covering dark, light, mid-toned and monochrome.
const themes: Record<string, Colors> = {
  tokyo_night: theme("#1a1b26", "#c0caf5", [
    "#15161e",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#a9b1d6",
    "#414868",
    "#f7768e",
    "#9ece6a",
    "#e0af68",
    "#7aa2f7",
    "#bb9af7",
    "#7dcfff",
    "#c0caf5",
  ]),
  gruvbox_light: theme("#fbf1c7", "#3c3836", [
    "#fbf1c7",
    "#cc241d",
    "#98971a",
    "#d79921",
    "#458588",
    "#b16286",
    "#689d6a",
    "#7c6f64",
    "#928374",
    "#9d0006",
    "#79740e",
    "#b57614",
    "#076678",
    "#8f3f71",
    "#427b58",
    "#3c3836",
  ]),
  hot_dog_stand: theme("#ea3323", "#ffffff", [
    "#000000",
    "#ffff54",
    "#ffff54",
    "#ffff54",
    "#000000",
    "#ffff54",
    "#ffffff",
    "#c6c6c6",
    "#000000",
    "#ffff54",
    "#ffff54",
    "#ffff54",
    "#000000",
    "#ffff54",
    "#ffffff",
    "#c6c6c6",
  ]),
  amber_crt: theme("#1a1200", "#ffb000", [
    "#2a1e00",
    "#ff6a00",
    "#ffb000",
    "#ffc742",
    "#ff8c00",
    "#ffa033",
    "#ffd27f",
    "#ffd9a0",
    "#6a4e00",
    "#ff8a1e",
    "#ffc742",
    "#ffe08a",
    "#ffab3d",
    "#ffc266",
    "#ffe3b0",
    "#fff0d6",
  ]),
};
/** palette.test's rules, for any set of tokens. */
function readable(t: Record<Token, Rgb>): string[] {
  const fails: string[] = [];
  for (const ink of ["faint", "muted", "text", "strong", "accent", "warm", "hot"] as Token[]) {
    for (const ground of ["bg", "surface"] as Token[])
      if (contrast(t[ink], t[ground]) < 4.5) fails.push(`${ink}/${ground}`);
    if (ink !== "faint" && contrast(t[ink], t.selected) < 4.5) fails.push(`${ink}/selected`);
  }
  if (contrast(t.line, t.bg) < 2.2) fails.push("line/bg");
  if (contrast(t.strong, t.line) < 4.5) fails.push("strong/line");
  return fails;
}
const distance = (a: Rgb, b: Rgb) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

test("tokens from any theme pass Corgi's readability rules", () => {
  for (const [name, colors] of Object.entries(themes))
    expect([name, readable(tokens(colors).colors)]).toEqual([name, []]);
  // Random themes, from a fixed seed, light and dark and in between.
  let seed = 1;
  const random = () => ((seed = (seed * 48271) % 0x7fffffff) & 0xff) as number;
  const rgb = (): Rgb => [random(), random(), random()];
  for (let i = 0; i < 300; i++) {
    const colors = { background: rgb(), foreground: rgb(), ansi: Array.from({ length: 16 }, rgb) };
    expect([i, readable(tokens(colors).colors)]).toEqual([i, []]);
  }
});
test("a theme keeps its own background, foreground and status hues", () => {
  const { colors, clear } = tokens(themes.tokyo_night);
  expect(clear).toBe(true);
  expect(colors.bg).toEqual([26, 27, 38]);
  expect(colors.text).toEqual([192, 202, 245]);
  expect(colors.accent).toEqual([158, 206, 106]);
  expect(colors.warm).toEqual([224, 175, 104]);
  // Red lifts a little to read on the selected row.
  expect(distance(colors.hot, [247, 118, 142])).toBeLessThan(12);
});
test("a light theme gets dark text and darker grounds", () => {
  const { colors } = tokens(themes.gruvbox_light);
  expect(colors.text).toEqual([60, 56, 54]);
  for (const step of ["surface", "selected", "line"] as Token[])
    expect(colors[step].reduce((a, b) => a + b)).toBeLessThan(colors.bg.reduce((a, b) => a + b));
});
test("a mid-toned background is deepened and painted", () => {
  const { colors, clear } = tokens(themes.hot_dog_stand);
  expect(clear).toBe(false);
  expect(colors.bg[0]).toBeLessThan(0xea);
});
test("statuses stay apart when a theme colors them alike", () => {
  for (const name of ["hot_dog_stand", "amber_crt"]) {
    const { colors } = tokens(themes[name]);
    expect(distance(colors.accent, colors.warm)).toBeGreaterThan(20);
    expect(distance(colors.warm, colors.hot)).toBeGreaterThan(20);
    expect(distance(colors.accent, colors.hot)).toBeGreaterThan(20);
  }
});

const corgi: Record<Token, Rgb> = {
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
};
test("Corgi keeps a dark terminal background and its own colors on it", () => {
  const kept = onBackground(corgi, themes.tokyo_night.background)!;
  expect(kept.bg).toEqual([26, 27, 38]);
  for (const token of ["muted", "text", "strong", "accent", "warm", "hot"] as Token[])
    expect([token, kept[token]]).toEqual([token, corgi[token]]);
  // Panels step from the background, so they take its tint.
  expect(kept.surface[2]).toBeGreaterThan(kept.surface[0]);
  expect(readable(kept)).toEqual([]);
  // Nord's background is lighter: faint lifts to stay readable, still below muted.
  const nord = onBackground(corgi, [46, 52, 64])!,
    sum = (rgb: Rgb) => rgb[0] + rgb[1] + rgb[2];
  expect(readable(nord)).toEqual([]);
  expect(sum(nord.faint)).toBeGreaterThan(sum(corgi.faint));
  expect(sum(nord.faint)).toBeLessThan(sum(nord.muted));
});
test("Corgi paints over a light or mid-toned background", () => {
  expect(onBackground(corgi, themes.gruvbox_light.background)).toBeNull();
  expect(onBackground(corgi, themes.hot_dog_stand.background)).toBeNull();
  // Any background it keeps leaves Corgi readable.
  let seed = 7;
  const random = () => ((seed = (seed * 48271) % 0x7fffffff) & 0x3f) as number;
  for (let i = 0; i < 300; i++) {
    const kept = onBackground(corgi, [random(), random(), random()]);
    if (kept) expect([i, readable(kept)]).toEqual([i, []]);
  }
});
