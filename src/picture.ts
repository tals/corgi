//! An image shrunk to fit a box, as a link's card shows it: one PNG, or an
//! animated GIF's frames, each drawn over one before it. It's made where the
//! image is, so another computer's daemon sends only the shrunk picture.
import * as gif from "./gif";

export interface Box {
  width: number;
  height: number;
}
/** A frame after the first: a picture drawn at (`x`, `y`) over frame `base`
 * (1-based, 0 for a clear canvas), shown for `delay` ms. */
export interface Frame {
  png: Uint8Array;
  x: number;
  y: number;
  base: number;
  delay: number;
}
export interface Picture {
  width: number;
  height: number;
  png: Uint8Array;
  /** How long the first frame shows, when there are more. */
  delay: number;
  frames: Frame[];
}
/** The most pixels an image may decode to. */
const max_pixels = 100_000_000;

/** The Kitty frame each GIF frame after the first is drawn over (0 for a
 * clear canvas), following the frame before's disposal; null when that
 * would clear part of a picture, which Kitty can't compose. */
export function bases(a: gif.Animation): number[] | null {
  // Kitty numbers frames from 1, so GIF frame `i` is Kitty frame `i + 1`.
  const under = [0];
  for (let i = 1; i < a.frames.length; i++) {
    const before = a.frames[i - 1];
    switch (before.disposal) {
      case 2:
        // Clearing its rectangle leaves a clear canvas only if the canvas was clear or it covered it all.
        if (under[i - 1] !== 0 && (before.width !== a.width || before.height !== a.height)) return null;
        under.push(0);
        break;
      case 3:
        under.push(under[i - 1]);
        break;
      default:
        under.push(i);
    }
  }
  return under.slice(1);
}
/** The GIF `bytes` hold shrunk to fit `box`, with all its frames at most
 * `pixels` together, or null to show it still: a single frame, a first frame
 * that leaves part of the canvas blank, which a host that can't animate
 * would show as it is, frames Kitty can't compose, or a GIF no longer `wanted`. */
async function animate(bytes: Uint8Array, box: Box, pixels: number, wanted: () => boolean): Promise<Picture | null> {
  const a = gif.animation(bytes);
  const first = a?.frames[0],
    under = a && bases(a);
  if (!a || !first || !under || first.width !== a.width || first.height !== a.height) return null;
  const scale = Math.min(
      box.width / a.width,
      box.height / a.height,
      1,
      Math.sqrt(pixels / (a.frames.length * a.width * a.height)),
    ),
    width = Math.max(1, Math.round(a.width * scale)),
    height = Math.max(1, Math.round(a.height * scale));
  const shrink = (still: Uint8Array, w: number, h: number) => new Bun.Image(still).resize(w, h).png().buffer();
  const frames: Frame[] = [];
  for (const [i, f] of a.frames.entries()) {
    if (!wanted()) return null;
    if (i === 0) continue;
    const x = Math.floor(f.left * scale),
      y = Math.floor(f.top * scale),
      w = Math.max(1, Math.min(width, Math.ceil((f.left + f.width) * scale)) - x),
      h = Math.max(1, Math.min(height, Math.ceil((f.top + f.height) * scale)) - y);
    frames.push({ png: await shrink(f.still, w, h), x, y, base: under[i - 1], delay: f.delay });
  }
  return { width, height, png: await shrink(first.still, width, height), delay: first.delay, frames };
}
/** The image `bytes` hold shrunk to fit `box`, never enlarged. A GIF whose
 * frames can play keeps them, together at most `pixels` (0 shows it still):
 * hosts keep each frame whole, so a longer one plays smaller. Throws when it
 * isn't an image. */
export async function shrink(
  bytes: Uint8Array,
  box: Box,
  pixels: number,
  wanted: () => boolean = () => true,
): Promise<Picture> {
  const is_gif = bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46;
  const animated = is_gif && pixels > 0 ? await animate(bytes, box, pixels, wanted).catch(() => null) : null;
  if (animated) return animated;
  if (!wanted()) throw Error("Aborted");
  const png = await new Bun.Image(bytes, { maxPixels: max_pixels })
    .resize(box.width, box.height, { fit: "inside", withoutEnlargement: true })
    .png()
    .buffer();
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), png, delay: 0, frames: [] };
}
