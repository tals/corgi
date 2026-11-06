import { expect, test } from "bun:test";
import * as style from "./trick_style";
import * as palette from "./palette";
import * as terminalPalette from "./terminal_palette";
import * as tricks from "./tricks";
import * as trickUi from "./trick_ui";
import * as process_name from "./process_name";
import * as markup from "./trick_markup";
import { Provider, adapter } from "./providers";
import { Writer } from "./text";
import { Rect } from "./layout";

test("brand helpers share provider names, glyphs and the existing logo aliases", () => {
  for (const provider of Provider.all) {
    const brand = style.brand.of(provider);
    expect(brand.name).toBe(adapter(provider).name);
    expect(markup.icon(brand.icon)?.text).toBe(adapter(provider).glyph);
    expect(
      tricks.view({ kind: "decorate", color: brand.color, suffix: markup.parse(`!(${brand.icon})`) }),
    ).toMatchObject({
      color: brand.color,
    });
  }
  expect(style.brand.of("codex").icon).toBe("brand:openai");
  expect(style.brand.of("claude").icon).toBe("brand:claude");
  expect(style.brand.of("python3").icon).toBe("brand:python");
  expect(style.brand.of("missing")).toMatchObject({ name: "Unknown", color: "text", icon: "unknown" });
});

test("palette references and brand colors resolve in each viewer's theme", () => {
  const mixed = style.palette.mix(style.palette.accent, style.palette.bg, 25);
  const before: palette.Rgb = [...style.rgb(mixed)];
  try {
    for (const background of [
      [24, 27, 32],
      [250, 250, 250],
    ] as palette.Rgb[]) {
      palette.use("animal_style", {
        background,
        foreground: background[0] > 100 ? [20, 20, 20] : [230, 230, 230],
        ansi: Array(16).fill(null),
      });
      expect(style.rgb(mixed)).toEqual(palette.mix(palette.colors.accent, palette.colors.bg, 25));
      for (const color of style.palette.identity) {
        expect(tricks.color(JSON.parse(JSON.stringify(color)))).toEqual(color);
        expect(style.rgb(color)).toEqual(palette.identity[color.hue]);
        expect(terminalPalette.contrast(style.rgb(color), palette.colors.bg)).toBeGreaterThanOrEqual(4.6);
      }
      for (const name of process_name.brands)
        for (const token of ["bg", "surface", "selected"] as const)
          expect(
            terminalPalette.contrast(style.rgb(style.brand.of(name).color), palette.colors[token]),
          ).toBeGreaterThanOrEqual(4.5);
    }
    expect(style.rgb(mixed)).not.toEqual(before);
    expect(tricks.color(JSON.parse(JSON.stringify(mixed)))).toEqual(mixed);
  } finally {
    palette.use("corgi");
  }
  expect(style.rgb(mixed)).toEqual(before);
});

test("automatic category colors follow each terminal even in the Corgi theme, while fixed palettes stay fixed", () => {
  try {
    for (const theme of ["corgi", "animal_style"] as const) {
      const blue: palette.Rgb = [100, 180, 240];
      const ansi = Array(16).fill(null);
      ansi[4] = blue;
      palette.use(theme, { background: [15, 20, 25], foreground: [240, 240, 240], ansi });
      expect(style.rgb(style.palette.identity[0])).toEqual(blue);
      expect(style.rgb(style.palette.schemes.tableau10[0])).toEqual([78, 121, 167]);
      ansi[4] = [10, 20, 40];
      ansi[12] = blue;
      palette.use(theme, { background: [15, 20, 25], foreground: [240, 240, 240], ansi });
      expect(style.rgb(style.palette.identity[0])).toEqual(blue);
    }
    expect(tricks.color("steelblue")).toBe("#4682b4");
    expect(tricks.color("hsl(120, 100%, 50%)")).toBe("#00ff00");
    expect(tricks.color("#abc")).toBe("#aabbcc");
    expect(() => tricks.color("rgba(0, 0, 0, .5)")).toThrow("InvalidColor");
  } finally {
    palette.use("corgi");
  }
});

test("color recipes reject invalid brands, weights and excessive nesting", () => {
  expect(() => tricks.color({ syntax: "missing" })).toThrow("InvalidSyntaxColor");
  expect(() => tricks.color({ syntax: "constructor" })).toThrow("InvalidSyntaxColor");
  expect(() => tricks.color({ syntax: "string", brand: "claude" })).toThrow("UnknownField");
  expect(() => tricks.color({ brand: "missing" })).toThrow("InvalidBrand");
  expect(() => style.palette.mix("accent", "bg", NaN)).toThrow("InvalidMix");
  expect(() => style.palette.mix("accent", "bg", 101)).toThrow("InvalidMix");
  let value: unknown = "accent";
  for (let i = 0; i < 7; i++) value = { mix: [value, "bg"], amount: 50 };
  expect(() => tricks.color(value)).toThrow("ColorTooDeep");
  expect(() => tricks.view({ kind: "decorate", suffix: [{ text: "x", icon: "missing" }] })).toThrow("InvalidBrand");
});

test("brand spans reserve two cells, fall back to text, and clip as a unit", () => {
  const icon = markup.icon(style.brand.of("claude").icon)!;
  const spans = [{ text: "猫" }, icon, { text: "!" }];
  expect(trickUi.width(spans)).toBe(5);
  const fallback = new Writer();
  trickUi.write(fallback, spans, 5);
  expect(fallback.s).toContain("* ");
  const icons: trickUi.Icon[] = [],
    w = new Writer();
  trickUi.write(w, spans, 5, { icons, x: 3, y: 2, covered: 0 });
  expect(icons).toEqual([{ brand: "claude", x: 5, y: 2, covered: 0 }]);
  icons.length = 0;
  trickUi.write(w, spans, 3, { icons, x: 3, y: 2, covered: 0 });
  expect(icons).toEqual([]);
  const views = tricks.views([{ kind: "overlay", lines: [[icon]] }]);
  const boxes = trickUi.overlays(w, views, new Rect(10, 1, 40, 20), icons, 3);
  expect(icons).toEqual([{ brand: "claude", x: boxes[0].x + 1, y: boxes[0].y, covered: 4 }]);
});
