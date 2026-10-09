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
  available_themes,
  colors,
  derived,
  themes,
  use,
  type Token,
} from "./palette";
test("text tokens stay readable on the backgrounds the guide allows, in every theme", () => {
  for (const name of available_themes) {
    for (const ink of ["faint", "muted", "text", "strong", "accent", "warm", "hot"] as Token[]) {
      for (const ground of ["bg", "surface"] as Token[])
        expect(contrast(ink, ground, name)).toBeGreaterThanOrEqual(4.5);
      if (ink !== "faint") expect(contrast(ink, "selected", name)).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrast("line", "bg", name)).toBeGreaterThanOrEqual(2.2);
    expect(contrast("strong", "line", name)).toBeGreaterThanOrEqual(4.5);
  }
});
test("a theme repaints the tokens in place and what modules derived from them", () => {
  const accent = colors.accent;
  let derivedAccent = "";
  derived(() => (derivedAccent = fg("accent")));
  try {
    use("tokyo_night");
    expect(accent).toEqual(themes.tokyo_night.colors.accent);
    expect(derivedAccent).toBe("\x1b[38;2;122;162;247m");
    expect(keycap).toBe("\x1b[0;1;38;2;224;229;250;48;2;74;81;114m");
  } finally {
    use("corgi");
  }
  expect(colors.accent).toEqual([123, 241, 168]);
  expect(derivedAccent).toBe("\x1b[38;2;123;241;168m");
});
test("styles render to SGR, called at runtime", () => {
  expect(fg("accent")).toBe("\x1b[38;2;123;241;168m");
  expect(bg("surface")).toBe("\x1b[48;2;35;40;47m");
  expect(new Style({ fg: "strong", bg: "bg", bold: true }).sgr()).toBe("\x1b[0;1;38;2;238;241;244;48;2;24;27;32m");
  expect(new Style().sgr()).toBe("\x1b[0m");
  expect(fg("muted")).toBe("\x1b[38;2;165;174;184m");
});
test("underlines, computed colors and keycaps render to SGR", () => {
  expect(underline("line")).toBe("\x1b[58:2::80:90:101m");
  expect(fgRgb([1, 2, 3])).toBe("\x1b[38;2;1;2;3m");
  expect(bgRgb([1, 2, 3])).toBe("\x1b[48;2;1;2;3m");
  let out = "";
  writeFg({ write: value => (out += value) }, [4, 5, 6]);
  expect(out).toBe("\x1b[38;2;4;5;6m");
  expect(keycap).toBe("\x1b[0;1;38;2;238;241;244;48;2;80;90;101m");
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
