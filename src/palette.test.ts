import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  contrast,
  Style,
  fg,
  bg,
  underline,
  fgRgb,
  bgRgb,
  writeFg,
  keycap,
  mix,
  termhtmlTheme,
  colors,
  derived,
  use,
  chosen,
  painted,
  type Rgb,
  type Token,
} from "./palette";
test("text tokens stay readable on the backgrounds the guide allows", () => {
  for (const ink of ["faint", "muted", "text", "strong", "accent", "warm", "hot", "gold"] as Token[]) {
    for (const ground of ["bg", "surface"] as Token[]) expect(contrast(ink, ground)).toBeGreaterThanOrEqual(4.5);
    if (ink !== "faint") expect(contrast(ink, "selected")).toBeGreaterThanOrEqual(4.5);
  }
  expect(contrast("line", "bg")).toBeGreaterThanOrEqual(2.2);
});
test("Animal Style takes its colors from the terminal and leaves bg to it", () => {
  use("corgi");
  const text = colors.text,
    own = { text: fg("text"), rgb: [...text] as Rgb, bg: bg("bg") },
    tokyo_night = {
      foreground: [192, 202, 245] as Rgb,
      background: [26, 27, 38] as Rgb,
      ansi: [null, [247, 118, 142], [158, 206, 106], [224, 175, 104], ...Array(12).fill(null)] as (Rgb | null)[],
    };
  let derivedText = "";
  derived(() => (derivedText = fg("text")));
  try {
    use("animal_style", tokyo_night);
    expect(bg("bg")).toBe("\x1b[49m");
    expect(new Style({ fg: "text", bg: "bg" }).sgr()).toBe("\x1b[0;38;2;192;202;245;49m");
    // Tokyo Night's background is dark enough for Corgi to keep too.
    expect(bg("bg", "corgi")).toBe("\x1b[49m");
    expect(colors.bg).toEqual([26, 27, 38]);
    expect(text).toEqual([192, 202, 245]);
    expect(derivedText).toBe("\x1b[38;2;192;202;245m");
    // Setup's swatches show each theme in its own colors.
    expect(fg("text", "corgi")).toBe(own.text);
    // A background too mid-toned for readable text is deepened and painted.
    use("animal_style", { foreground: [255, 255, 255], background: [234, 51, 35], ansi: Array(16).fill(null) });
    expect(bg("bg")).toBe(`\x1b[48;2;${colors.bg.join(";")}m`);
    expect(colors.bg[0]).toBeLessThan(234);
    // Without the terminal's colors, Corgi's own on the terminal's background.
    use("animal_style");
    expect(text).toEqual(own.rgb);
    expect(bg("bg")).toBe("\x1b[49m");
  } finally {
    use("corgi");
  }
  expect(bg("bg")).toBe(own.bg);
  expect(bg("bg", "animal_style")).toBe("\x1b[49m");
  expect(derivedText).toBe(own.text);
  use("corgi", tokyo_night);
  expect(fg("text", "animal_style")).toBe("\x1b[38;2;192;202;245m");
  expect(fg("text")).toBe(own.text);
  expect(bg("bg")).toBe("\x1b[49m");
  expect(colors.bg).toEqual([26, 27, 38]);
  // A light background is Corgi's to paint over with its own.
  use("corgi", { foreground: [0, 0, 0], background: [250, 250, 250], ansi: Array(16).fill(null) });
  expect(bg("bg")).toBe(own.bg);
  use("corgi");
});
test("styles, underlines, computed colors and keycaps render the current colors to SGR", () => {
  const rgb = (token: Token) => colors[token].join(";");
  expect(fg("accent")).toBe(`\x1b[38;2;${rgb("accent")}m`);
  expect(bg("surface")).toBe(`\x1b[48;2;${rgb("surface")}m`);
  expect(new Style({ fg: "strong", bg: "bg", bold: true }).sgr()).toBe(
    `\x1b[0;1;38;2;${rgb("strong")};48;2;${rgb("bg")}m`,
  );
  expect(new Style().sgr()).toBe("\x1b[0m");
  expect(underline("line")).toBe(`\x1b[58:2::${colors.line.join(":")}m`);
  expect(fgRgb([1, 2, 3])).toBe("\x1b[38;2;1;2;3m");
  expect(bgRgb([1, 2, 3])).toBe("\x1b[48;2;1;2;3m");
  let out = "";
  writeFg({ write: value => (out += value) }, [4, 5, 6]);
  expect(out).toBe("\x1b[38;2;4;5;6m");
  expect(keycap).toBe(`\x1b[0;1;38;2;${rgb("strong")};48;2;${rgb("line")}m`);
  expect(contrast("strong", "line")).toBeGreaterThanOrEqual(4.5);
});
test("mix blends toward the second color", () => {
  expect(mix([100, 50, 0], [0, 0, 0], 0)).toEqual([100, 50, 0]);
  expect(mix([100, 50, 0], [0, 0, 0], 50)).toEqual([50, 25, 0]);
  expect(mix([100, 50, 0], [0, 0, 0], 100)).toEqual([0, 0, 0]);
});
test("termhtml's corgi theme matches the palette", () => {
  expect(readFileSync(resolve(import.meta.dir, "../termhtml/index.html"), "utf8")).toContain(termhtmlTheme());
});
test("unpicked, a light terminal gets Animal Style and only a painted background goes to the host", () => {
  const day = { foreground: [74, 69, 67] as Rgb, background: [247, 247, 247] as Rgb, ansi: Array(16).fill(null) },
    night = { foreground: [192, 202, 245] as Rgb, background: [26, 27, 38] as Rgb, ansi: Array(16).fill(null) };
  try {
    use(undefined, day);
    expect(chosen(undefined)).toBe("animal_style");
    expect(painted()).toBeNull();
    // Corgi paints its own over a light terminal.
    use("corgi", day);
    expect(painted()).toEqual([24, 27, 32]);
    use(undefined, night);
    expect(chosen(undefined)).toBe("corgi");
    // Night is dark enough for Corgi to keep.
    expect(painted()).toBeNull();
    expect(chosen("animal_style")).toBe("animal_style");
  } finally {
    use(undefined, null);
  }
});
