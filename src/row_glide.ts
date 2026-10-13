//! The tint that carries an agent's row into another group: a Kitty image
//! under the text that glides from where the row was to where it lands,
//! then fades there. The text itself only moves by whole rows. Hosts
//! without Kitty graphics get a truecolor tint where the row lands.
import { deflateSync } from "node:zlib";
import { colors } from "./palette";
import type { Cell } from "./fork_motion";

export const glide_ms = 300,
  land_ms = 700,
  /** The truecolor tint's fade, where there is no image to glide. */
  tint_ms = 900;
/** How long after a move its row still animates. */
export const total_ms = Math.max(glide_ms + land_ms, tint_ms);
const strength = 0.2,
  appear_ms = 70,
  /** The row's text fades in from halfway through the glide, over this long. */
  reveal_ms = 170;
const image_id = 730120;
/** Removes the tint. A frame that shows it sends it again. */
export const hide = `\x1b7\x1b[1;1H\x1b_Ga=d,d=I,i=${image_id},q=2\x1b\\\x1b8`;

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
/** The tint's opacity `ms` after the move: it appears as it sets off, and
 * fades where it lands. */
export function opacity(ms: number): number {
  if (ms < glide_ms) return strength * smooth(ms / appear_ms);
  return strength * (1 - clamp01((ms - glide_ms) / land_ms)) ** 2;
}
/** How faded the moved row's text is, as `writeExit` takes it: gone while
 * the tint is on its way, then in as it lands; null once it is in. */
export function fade(ms: number): number | null {
  const shown = (ms - glide_ms / 2) / reveal_ms;
  return shown >= 1 ? null : 1 - clamp01(shown);
}
/** How far the truecolor fallback tints the row toward accent. */
export function tint(ms: number): number {
  return ms >= tint_ms ? 0 : strength * (1 - ms / tint_ms) ** 2;
}

const encoded = new Map<string, string>();
function pixels(width: number, height: number, alpha: number): string {
  const key = `${width}x${height}:${alpha}`;
  let data = encoded.get(key);
  if (data === undefined) {
    const rgba = Buffer.alloc(width * height * 4);
    const [r, g, b] = colors.accent;
    for (let i = 0; i < rgba.length; i += 4) {
      rgba[i] = r;
      rgba[i + 1] = g;
      rgba[i + 2] = b;
      rgba[i + 3] = alpha;
    }
    data = deflateSync(rgba, { level: 1 }).toString("base64");
    if (encoded.size >= 128) encoded.clear();
    encoded.set(key, data);
  }
  return data;
}
/** Places the tint, `cols` by `rows` cells, with its top at row `y` (a
 * fraction moves it by the pixel) in column `x`, cut to the rows from `top`
 * to `bottom`. Empty when none of it shows. */
export function place(
  x: number,
  y: number,
  cols: number,
  rows: number,
  clip: { top: number; bottom: number },
  alpha: number,
  cell: Cell,
): string {
  const width = cols * cell.width,
    height = rows * cell.height,
    top = Math.round(y * cell.height),
    from = Math.max(0, clip.top * cell.height - top),
    to = Math.min(height, clip.bottom * cell.height - top),
    // In 64 steps: each change sends the whole frame again.
    level = Math.round((Math.round(clamp01(alpha) * 64) * 255) / 64);
  if (width <= 0 || to <= from || level === 0) return "";
  const shown = top + from,
    row = Math.floor(shown / cell.height);
  const keys = `a=T,f=32,o=z,s=${width},v=${height},i=${image_id},p=1,Y=${shown - row * cell.height},y=${from},h=${to - from},z=-1,C=1,q=2`;
  const data = pixels(width, height, level);
  let out = `\x1b7\x1b[${row + 1};${x + 1}H`;
  for (let offset = 0; offset < data.length; offset += 4096) {
    const end = Math.min(offset + 4096, data.length),
      more = Number(end < data.length);
    out += (offset === 0 ? `\x1b_G${keys},m=${more};` : `\x1b_Gm=${more};`) + data.slice(offset, end) + "\x1b\\";
  }
  return out + "\x1b8";
}
