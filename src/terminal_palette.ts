//! Tokens from the terminal's own colors. Animal Style takes them all: grays
//! are steps from the background toward the foreground, so they carry the
//! theme's tint, and accent, warm and hot take the hues of its ANSI green,
//! yellow and red. Corgi keeps its own colors and takes only a dark enough
//! background. Every step is placed by contrast, so the readability rules
//! hold for any theme, light or dark. A background too mid-toned for that is
//! deepened and painted instead of left to the terminal.
import type { Rgb, Token } from "./palette";

export interface Colors {
  foreground: Rgb;
  background: Rgb;
  /** The 16 ANSI colors; null where the terminal didn't say. */
  ansi: (Rgb | null)[];
}
type Lab = [number, number, number];

/** Contrast steps from the background, as Corgi's own colors take them. */
const steps = { surface: 1.17, selected: 1.5, line: 2.4 };
/** Below this border step the background can't stay the terminal's. */
const min_line = 2.2;
/** Text tokens clear 4.5:1 with a little room for rounding. */
const readable = 4.6;
/** Keycaps put `strong` on `line`; the most `line` can step and leave them readable. */
const keycap_room = 4.7;
const min_text = 7.5;
/** Corgi keeps a terminal background that leaves its body text this much
 * contrast; its own background gives 11.7. */
const dark_enough = 8;
/** Below this chroma an ANSI color reads as gray and can't carry a status. */
const min_chroma = 0.04;
type Status = "accent" | "warm" | "hot";
/** ANSI slots, normal then bright, for each status color. */
const slots: Record<Status, number[]> = { accent: [2, 10], warm: [3, 11], hot: [1, 9] };
/** Hues for a status a gray theme can't color: Corgi's own first (mint,
 * sand, coral), then a neighbor. The first is also where a theme's own
 * color turns to when it matches another status. */
const fallback_hues: Record<Status, number[]> = { accent: [155, 230], warm: [80, 55], hot: [30, 0] };
/** The OKLab distance at which two status colors read apart at a glance. */
const apart = 0.06;
/** OKLCH hue ranges that read as needs you (amber to yellow) and failed
 * (pink-red to red-orange) in any theme. Live may take any hue. */
const families: Partial<Record<Status, [number, number]>> = { warm: [45, 125], hot: [330, 50] };
function inFamily(name: Status, hue: number): boolean {
  const range = families[name];
  if (!range) return true;
  const h = (hue + 360) % 360;
  return range[0] <= range[1] ? h >= range[0] && h <= range[1] : h >= range[0] || h <= range[1];
}

/** `clear` is false when `bg` had to be deepened and must be painted. */
export function tokens(c: Colors): { colors: Record<Token, Rgb>; clear: boolean } {
  const terminal = c.background,
    dark =
      luminance(c.foreground) !== luminance(terminal)
        ? luminance(c.foreground) > luminance(terminal)
        : luminance(terminal) < 0.18,
    extreme: Rgb = dark ? [255, 255, 255] : [0, 0, 0],
    opposite: Rgb = dark ? [0, 0, 0] : [255, 255, 255],
    clear = contrast(extreme, terminal) / keycap_room >= min_line,
    bg = clear ? terminal : reach(terminal, opposite, g => contrast(extreme, g) / keycap_room >= steps.line),
    // A theme with little room between its background and the extreme takes
    // proportionally smaller steps.
    scale = Math.log(Math.min(steps.line, contrast(extreme, bg) / keycap_room)) / Math.log(steps.line),
    // The foreground when it lies on the extreme's side of the background.
    ink = luminance(c.foreground) > luminance(bg) === dark ? c.foreground : extreme,
    text = reach(ink, extreme, ground => contrast(ground, bg) >= min_text),
    along = (to: Rgb, target: number) => reach(bg, to, ground => contrast(ground, bg) >= target ** scale),
    surface = along(text, steps.surface),
    selected = along(text, steps.selected),
    line = along(text, steps.line),
    faint = reach(bg, text, ink => contrast(ink, surface) >= readable && contrast(ink, bg) >= readable),
    // Halfway between faint and text in contrast, which near black climbs
    // faster than lightness does.
    middle = Math.sqrt(contrast(faint, bg) * contrast(text, bg)),
    muted = reach(faint, text, ink => contrast(ink, bg) >= middle && contrast(ink, selected) >= readable),
    strong = reach(mixLab(text, extreme, 0.55), extreme, ink => contrast(ink, line) >= readable),
    status = statuses(c.ansi, [bg, surface, selected], extreme);
  return {
    colors: {
      bg,
      surface,
      selected,
      line,
      faint,
      muted,
      text,
      strong,
      accent: status.accent,
      warm: status.warm,
      hot: status.hot,
    },
    clear,
  };
}
/** Corgi's own colors on the terminal's background, when it is dark enough:
 * panels step from it, so they carry its tint, and text and status colors
 * stay Corgi's, lifted only where the background asks. Null for a background
 * Corgi paints over with its own. */
export function onBackground(own: Record<Token, Rgb>, background: Rgb): Record<Token, Rgb> | null {
  if (luminance(background) >= luminance(own.text) || contrast(own.text, background) < dark_enough) return null;
  const bg = background,
    white: Rgb = [255, 255, 255],
    along = (target: number) => reach(bg, own.text, ground => contrast(ground, bg) >= target),
    surface = along(steps.surface),
    selected = along(steps.selected),
    line = along(steps.line),
    // 4.5:1 exactly, as Corgi's own colors are tuned to.
    keep = (ink: Rgb, grounds: Rgb[]) =>
      lift(ink, white, lifted => grounds.every(ground => contrast(lifted, ground) >= 4.5)).rgb,
    grounds = [bg, surface, selected];
  return {
    bg,
    surface,
    selected,
    line,
    faint: keep(own.faint, [bg, surface]),
    muted: keep(own.muted, grounds),
    text: keep(own.text, grounds),
    strong: keep(own.strong, [...grounds, line]),
    accent: keep(own.accent, grounds),
    warm: keep(own.warm, grounds),
    hot: keep(own.hot, grounds),
  };
}
/** Each status color from the theme's ANSI slots, readable on every ground
 * and apart from the ones chosen before it. Needs you and failed choose
 * first; live gives way to them. When a slot's color matches an earlier
 * status, as in a theme of one hue, it turns the least that sets it apart;
 * a status the theme can't color in its family takes a fallback hue at the
 * theme's typical chroma. */
function statuses(ansi: (Rgb | null)[], grounds: Rgb[], extreme: Rgb): Record<Status, Rgb> {
  const fits = (ink: Rgb) => grounds.every(ground => contrast(ink, ground) >= readable),
    chromas = ansi.flatMap(color => (color ? [lch(oklab(color))[1]] : [])).filter(c => c >= min_chroma),
    chroma = chromas.length > 0 ? Math.min(0.16, Math.max(0.08, median(chromas))) : 0.12,
    chosen: Rgb[] = [],
    out = {} as Record<Status, Rgb>;
  for (const name of ["warm", "hot", "accent"] as Status[]) {
    const distinct = (ink: Rgb) => chosen.every(other => distance(ink, other) >= apart);
    const own = slots[name]
      .map(slot => ansi[slot])
      .filter((color): color is Rgb => color !== null && lch(oklab(color))[1] >= min_chroma)
      .filter(color => inFamily(name, lch(oklab(color))[2]));
    const candidates = own.map(color => lift(color, extreme, fits)).filter(candidate => distinct(candidate.rgb));
    const fallbacks = () => fallback_hues[name].map(hue => lift(fromLch([0.75, chroma, hue]), extreme, fits).rgb);
    const pick =
      candidates.length > 0
        ? // The slot that needed the smallest change keeps the theme's look best.
          candidates.reduce((best, next) => (next.moved < best.moved ? next : best)).rgb
        : ((own.length > 0
            ? turn(
                own[0],
                fallback_hues[name][0],
                ink => distinct(ink) && inFamily(name, lch(oklab(ink))[2]),
                extreme,
                fits,
              )
            : null) ??
          fallbacks().find(distinct) ??
          fallbacks()[0]);
    out[name] = pick;
    chosen.push(pick);
  }
  return out;
}
/** `color` turned toward `hue` by the least that makes it `distinct`, readable by `fits`. */
function turn(
  color: Rgb,
  hue: number,
  distinct: (ink: Rgb) => boolean,
  extreme: Rgb,
  fits: (ink: Rgb) => boolean,
): Rgb | null {
  const [l, c, h] = lch(oklab(color)),
    way = Math.sign(((hue - h + 540) % 360) - 180) || 1;
  for (let degrees = 5; degrees <= 120; degrees += 5) {
    const ink = lift(fromLch([l, c, h + way * degrees]), extreme, fits).rgb;
    if (distinct(ink)) return ink;
  }
  return null;
}
function distance(a: Rgb, b: Rgb): number {
  const x = oklab(a),
    y = oklab(b);
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}
/** Moves `color`'s lightness toward `extreme`, keeping its hue, until `ok`.
 * A yellow darkened for a light theme loses its chroma to the gamut and
 * turns olive; it turns a little toward orange instead, which keeps it. */
function lift(color: Rgb, extreme: Rgb, ok: (ink: Rgb) => boolean): { rgb: Rgb; moved: number } {
  if (ok(color)) return { rgb: color, moved: 0 };
  const [l, c, h] = lch(oklab(color)),
    end = oklab(extreme)[0],
    at = (hue: number) => {
      const t = solve(t => ok(fromLch([l + (end - l) * t, c, hue])));
      return { rgb: fromLch([l + (end - l) * t, c, hue]), moved: t };
    },
    keeps = (lifted: { rgb: Rgb }) => lch(oklab(lifted.rgb))[1] >= c * 0.75,
    straight = at(h);
  if (end > l || h < 60 || h > 120 || keeps(straight)) return straight;
  for (let degrees = 5; degrees <= 25; degrees += 5) {
    const turned = at(h - degrees);
    if (keeps(turned)) return turned;
  }
  return straight;
}
/** The first color from `from` toward `to`, mixed in OKLab, for which `ok` holds. */
function reach(from: Rgb, to: Rgb, ok: (color: Rgb) => boolean): Rgb {
  return ok(from)
    ? from
    : mixLab(
        from,
        to,
        solve(t => ok(mixLab(from, to, t))),
      );
}
/** The smallest t in [0, 1] where `ok` turns true, for an `ok` that stays true once it does. */
function solve(ok: (t: number) => boolean): number {
  let lo = 0,
    hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (ok(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}
function luminance(rgb: Rgb): number {
  const [r, g, b] = rgb.map(linear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export function contrast(a: Rgb, b: Rgb): number {
  const x = luminance(a),
    y = luminance(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}
function mixLab(a: Rgb, b: Rgb, t: number): Rgb {
  const x = oklab(a),
    y = oklab(b);
  return fromLab(x.map((v, i) => v + (y[i] - v) * t) as Lab);
}
const linear = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
function oklab(rgb: Rgb): Lab {
  const [r, g, b] = rgb.map(linear),
    l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b),
    m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b),
    s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}
function linearRgb([L, a, b]: Lab): [number, number, number] {
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3,
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3,
    s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}
/** Out-of-gamut colors keep lightness and hue and give up chroma. */
function fromLab(lab: Lab): Rgb {
  const inGamut = (x: Lab) => linearRgb(x).every(v => v >= -1e-4 && v <= 1 + 1e-4);
  let fitted = lab;
  if (!inGamut(lab)) {
    const keep = 1 - solve(t => inGamut([lab[0], lab[1] * (1 - t), lab[2] * (1 - t)]));
    fitted = [lab[0], lab[1] * keep, lab[2] * keep];
  }
  return linearRgb(fitted).map(v => Math.round(encode(Math.min(1, Math.max(0, v))) * 255)) as Rgb;
}
function lch(lab: Lab): Lab {
  return [lab[0], Math.hypot(lab[1], lab[2]), (Math.atan2(lab[2], lab[1]) * 180) / Math.PI];
}
function fromLch([l, c, h]: Lab): Rgb {
  const rad = (h * Math.PI) / 180;
  return fromLab([l, c * Math.cos(rad), c * Math.sin(rad)]);
}
