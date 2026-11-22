//! The picture a link card shows for an image file on this machine: shrunk
//! on Bun's image worker and placed, as a Kitty image, by each frame that
//! shows the card. An animated GIF is sent as a Kitty animation, which hosts
//! that can't play it show as its first frame.
import { hostname } from "node:os";
import type { Cell } from "./fork_hero";
import * as gif from "./gif";
import * as hostImages from "./host_images";
import type { Rect } from "./layout";
import { filePath, thumbnailCells, type Thumbnail } from "./link_tooltip";

/** The most of the screen a thumbnail covers, in cells. */
export const max_cols = 64,
  max_rows = 24;
/** The most pixels an animation's frames hold together: hosts keep each
 * frame whole, and refuse images past a limit of their own. A longer one
 * plays smaller. */
const animation_pixels = 24_000_000;
const extensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif"]);

/** The image file `uri` links to on this machine, or null for other links. */
export function imagePath(uri: string): string | null {
  const path = filePath(uri);
  if (path === null) return null;
  const host = new URL(uri).hostname;
  // URLs lowercase their host; macOS names often aren't.
  if (host !== "" && host !== "localhost" && host !== hostname().toLowerCase()) return null;
  return extensions.has(path.slice(path.lastIndexOf(".") + 1).toLowerCase()) ? path : null;
}
/** Places `t` in the card at `rect`, centered in the rows below its copy row's rule. */
export function place(frame: hostImages.FrameImages, rect: Rect, t: Thumbnail): void {
  const left = Math.floor(((rect.w - 2) * t.cell.width - t.width) / 2),
    top = Math.floor((thumbnailCells(t).rows * t.cell.height - t.height) / 2);
  placeAt(frame, rect.x + 1, rect.y + 3, t, left, top);
}
/** Places `t` with its corner at column `col` of row `row`, shifted `left`
 * and `top` pixels further in. */
export function placeAt(
  frame: hostImages.FrameImages,
  col: number,
  row: number,
  t: Thumbnail,
  left = 0,
  top = 0,
): void {
  const image = (t.of ?? t).image;
  if (!image) return;
  frame.show(image, {
    top: true,
    col: col + Math.floor(left / t.cell.width),
    row: row + Math.floor(top / t.cell.height),
    x: left % t.cell.width,
    y: top % t.cell.height,
    ...(t.of ? { cols: t.width / t.cell.width, rows: t.height / t.cell.height } : {}),
  });
}
/** A frame after the first: a picture drawn at (`x`, `y`) over frame `base`
 * (1-based, 0 for a clear canvas), shown for `delay` ms. */
interface Frame {
  png: Buffer;
  x: number;
  y: number;
  base: number;
  delay: number;
}
interface Loaded {
  thumbnail: Thumbnail;
  png: Buffer;
  /** How long the first frame shows, when there are more. */
  delay: number;
  frames: Frame[];
}
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
/** The frames of the GIF at `path` shrunk to fit `box`, or null to show it
 * still: a single frame, a first frame that leaves part of the canvas blank,
 * which a host that can't animate would show as it is, frames Kitty can't
 * compose, or a GIF no longer `wanted`. */
async function animate(
  path: string,
  box: { width: number; height: number },
  wanted: () => boolean,
): Promise<Loaded | null> {
  const a = gif.animation(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const first = a?.frames[0],
    under = a && bases(a);
  if (!a || !first || !under || first.width !== a.width || first.height !== a.height) return null;
  const scale = Math.min(
      box.width / a.width,
      box.height / a.height,
      1,
      Math.sqrt(animation_pixels / (a.frames.length * a.width * a.height)),
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
  const png = await shrink(first.still, width, height);
  return { thumbnail: { width, height, cell: { width: 0, height: 0 } }, png, delay: first.delay, frames };
}
/** Holds the thumbnail of the last image link hovered. */
export class Loader {
  private key: string | null = null;
  private loaded: Loaded | null = null;
  /** The load in flight, for tests to wait on. */
  loading: Promise<void> | null = null;
  constructor(private wake: () => void) {}
  /** The thumbnail of the image `uri` links to, at `cell`; null until it loads. */
  get(uri: string, cell: Cell): Thumbnail | null {
    const path = imagePath(uri);
    if (path === null) return null;
    const key = `${cell.width}x${cell.height}:${path}`;
    if (key !== this.key) {
      this.key = key;
      this.loaded = null;
      this.loading = this.load(key, path, cell);
    }
    return this.loaded?.thumbnail ?? null;
  }
  private async load(key: string, path: string, cell: Cell): Promise<void> {
    const box = { width: max_cols * cell.width, height: max_rows * cell.height };
    let loaded: Loaded;
    try {
      const wanted = () => this.key === key,
        animated = /\.gif$/i.test(path) ? await animate(path, box, wanted).catch(() => null) : null;
      if (!wanted()) return;
      if (animated) loaded = { ...animated, thumbnail: { ...animated.thumbnail, cell } };
      else {
        const png = await new Bun.Image(path, { maxPixels: 100_000_000 })
          .resize(box.width, box.height, { fit: "inside", withoutEnlargement: true })
          .png()
          .buffer();
        loaded = {
          thumbnail: { width: png.readUInt32BE(16), height: png.readUInt32BE(20), cell },
          png,
          delay: 0,
          frames: [],
        };
      }
    } catch {
      // Gone, or not an image after all: the card goes without one.
      return;
    }
    if (this.key !== key) return;
    loaded.thumbnail.image = new hostImages.Image({
      png: loaded.png,
      animation: loaded.frames.length ? { delay: loaded.delay, frames: loaded.frames } : undefined,
    });
    this.loaded = loaded;
    this.wake();
  }
}
