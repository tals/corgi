//! The tint that carries an agent's row into another group: a Kitty image
//! under the text that glides from where the row was to where it lands,
//! then fades there. The text itself only moves by whole rows. Hosts
//! without Kitty graphics get a truecolor tint where the row lands.
import { crc32, deflateSync } from "node:zlib";
import * as hostImages from "./host_images";
import { Rect } from "./layout";
import { colors } from "./palette";
import type { Cell } from "./fork_hero";

export const glide_ms = 300,
  /** How long the tint stays where it lands, at full strength, so the eye finds it. */
  linger_ms = 900,
  land_ms = 700,
  /** The truecolor tint's fade, where there is no image to glide. */
  tint_ms = 900;
/** How long after a move its row still animates. */
export const total_ms = Math.max(glide_ms + linger_ms + land_ms, linger_ms + tint_ms);
const strength = 0.2,
  appear_ms = 70,
  /** The row's text fades in from halfway through the glide, over this long. */
  reveal_ms = 170;
/** A tint as last drawn, and the size, level and color it was drawn at. */
export interface Tint {
  drawn: { key: string; image: hostImages.Image } | null;
}
/** The tints the sidebar and the agent manager glide. */
export const sidebar_tint: Tint = { drawn: null },
  manager_tint: Tint = { drawn: null };

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
function ease(x: number) {
  return x < 0.5 ? 4 * x * x * x : 1 - (-2 * x + 2) ** 3 / 2;
}
function smooth(x: number) {
  const t = clamp01(x);
  return t * t * (3 - 2 * t);
}
/** Where the tint's top is `ms` after the move, in rows, going from row
 * `from` to row `to`. */
export function position(from: number, to: number, ms: number): number {
  return from + (to - from) * ease(clamp01(ms / glide_ms));
}
/** The tint's opacity `ms` after the move: it appears as it sets off,
 * lingers where it lands, then fades. */
export function opacity(ms: number): number {
  if (ms < glide_ms) return strength * smooth(ms / appear_ms);
  return strength * (1 - smooth((ms - glide_ms - linger_ms) / land_ms));
}
/** How faded the moved row's text is, as `writeExit` takes it: gone while
 * the tint is on its way, then in as it lands; null once it is in. */
export function fade(ms: number): number | null {
  const shown = (ms - glide_ms / 2) / reveal_ms;
  return shown >= 1 ? null : 1 - clamp01(shown);
}
/** How far the truecolor fallback tints the row toward accent: fully while
 * it lingers, then fading. */
export function tint(ms: number): number {
  return strength * (1 - smooth((ms - linger_ms) / tint_ms));
}

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A 1-bit PNG whose one palette entry is the accent at `alpha`. PNG
 * rather than o=z: Ghostty 1.3.1 crashes inflating o=z images over 64 KiB. */
function png(width: number, height: number, alpha: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  ihdr.set([1, 3, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("PLTE", Uint8Array.from(colors.accent)),
    chunk("tRNS", Uint8Array.of(alpha)),
    chunk("IDAT", deflateSync(new Uint8Array((Math.ceil(width / 8) + 1) * height))),
    chunk("IEND", new Uint8Array()),
  ]);
}
/** Shows the tint, `cols` by `rows` cells, with its top at row `y` (a
 * fraction moves it by the pixel) in column `x`, cut to the rows from `top`
 * to `bottom`; `over` when it sits in a card drawn over the rest. */
export function place(
  frame: hostImages.FrameImages,
  x: number,
  y: number,
  cols: number,
  rows: number,
  clip: { top: number; bottom: number },
  alpha: number,
  cell: Cell,
  tint = sidebar_tint,
  over = false,
): void {
  const width = cols * cell.width,
    height = rows * cell.height,
    top = Math.round(y * cell.height),
    from = Math.max(0, clip.top * cell.height - top),
    to = Math.min(height, clip.bottom * cell.height - top),
    // In 64 steps: each change sends a new tint image.
    level = Math.round((Math.round(clamp01(alpha) * 64) * 255) / 64);
  if (width <= 0 || to <= from || level === 0) return;
  const key = `${width}x${height}:${level}:${colors.accent}`;
  if (tint.drawn?.key !== key) {
    tint.drawn = { key, image: new hostImages.Image({ png: png(width, height, level) }) };
  }
  const shown = top + from,
    row = Math.floor(shown / cell.height);
  frame.show(tint.drawn.image, {
    col: x,
    row,
    y: shown - row * cell.height,
    region: new Rect(0, from, width, to - from),
    z: -1,
    top: over,
  });
}
