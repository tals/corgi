//! The tint that carries an agent's row into another group: a Kitty image
//! under the text that glides from where the row was to where it lands,
//! then fades there. The text itself only moves by whole rows. Hosts
//! without Kitty graphics get a truecolor tint where the row lands.
import { crc32, deflateSync } from "node:zlib";
import { colors } from "./palette";
import type { Cell } from "./fork_hero";

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
/** Hides the tint. Freeing it also discards unrelated unplaced images on old Kitty. */
export const hide = `\x1b7\x1b[1;1H\x1b_Ga=d,d=i,i=${image_id},q=2\x1b\\\x1b8`;

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

function chunk(type: string, data: Uint8Array): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length);
  out.write(type, 4, "latin1");
  out.set(data, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
const encoded = new Map<string, string>();
/** A 1-bit PNG whose one palette entry is the accent at `alpha`. PNG
 * rather than o=z: Ghostty 1.3.1 crashes inflating o=z images over 64 KiB. */
function pixels(width: number, height: number, alpha: number): string {
  const key = `${width}x${height}:${alpha}`;
  let data = encoded.get(key);
  if (data === undefined) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width);
    ihdr.writeUInt32BE(height, 4);
    ihdr.set([1, 3, 0, 0, 0], 8);
    data = Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      chunk("IHDR", ihdr),
      chunk("PLTE", Uint8Array.from(colors.accent)),
      chunk("tRNS", Uint8Array.of(alpha)),
      chunk("IDAT", deflateSync(new Uint8Array((Math.ceil(width / 8) + 1) * height))),
      chunk("IEND", new Uint8Array()),
    ]).toString("base64");
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
    // In 64 steps: each change uploads a new tint image.
    level = Math.round((Math.round(clamp01(alpha) * 64) * 255) / 64);
  if (width <= 0 || to <= from || level === 0) return "";
  const shown = top + from,
    row = Math.floor(shown / cell.height);
  const keys = `a=T,f=100,i=${image_id},p=1,Y=${shown - row * cell.height},y=${from},h=${to - from},z=-1,C=1,q=2`;
  const data = pixels(width, height, level);
  let out = `\x1b7\x1b[${row + 1};${x + 1}H`;
  for (let offset = 0; offset < data.length; offset += 4096) {
    const end = Math.min(offset + 4096, data.length),
      more = Number(end < data.length);
    out += (offset === 0 ? `\x1b_G${keys},m=${more};` : `\x1b_Gm=${more};`) + data.slice(offset, end) + "\x1b\\";
  }
  return out + "\x1b8";
}
