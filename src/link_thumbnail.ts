//! The picture a link card shows for an image file on this machine: shrunk
//! on Bun's image worker, sent to the host once as a Kitty image, and placed
//! by each frame that shows the card. An animated GIF is sent as a Kitty
//! animation, which hosts that can't play it show as its first frame.
import { hostname } from "node:os";
import type { Cell } from "./fork_hero";
import * as gif from "./gif";
import type { Rect } from "./layout";
import { filePath, thumbnailCells, type Thumbnail } from "./link_tooltip";

/** The most of the screen a thumbnail covers, in cells. */
export const max_cols = 64,
  max_rows = 24;
/** The most pixels an animation's frames hold together: hosts keep each
 * frame whole, and refuse images past a limit of their own. A longer one
 * plays smaller. */
const animation_pixels = 24_000_000;
const image_id = 730140;
/** Takes the thumbnail off the screen. A frame that shows it places it again. */
export const hide = `\x1b_Ga=d,d=i,i=${image_id},q=2\x1b\\`;
/** Frees the thumbnail's pixels on the host. */
export const remove = `\x1b_Ga=d,d=I,i=${image_id},q=2\x1b\\`;
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
export function place(rect: Rect, t: Thumbnail): string {
  const left = Math.floor(((rect.w - 2) * t.cell.width - t.width) / 2),
    top = Math.floor((thumbnailCells(t).rows * t.cell.height - t.height) / 2),
    col = rect.x + 1 + Math.floor(left / t.cell.width),
    row = rect.y + 3 + Math.floor(top / t.cell.height);
  const size = t.of ? `,c=${t.width / t.cell.width},r=${t.height / t.cell.height}` : "";
  return `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${image_id},p=1,X=${left % t.cell.width},Y=${top % t.cell.height}${size},z=1,C=1,q=2\x1b\\\x1b8`;
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
function chunks(keys: string, png: Buffer): string {
  const data = png.toString("base64");
  let out = "";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const end = Math.min(offset + 4096, data.length),
      more = Number(end < data.length);
    out += (offset === 0 ? `\x1b_G${keys},q=2,m=${more};` : `\x1b_Gm=${more};`) + data.slice(offset, end) + "\x1b\\";
  }
  return out;
}
function transmit(loaded: Loaded): string {
  let out = chunks(`a=t,t=d,f=100,i=${image_id}`, loaded.png);
  if (loaded.frames.length === 0) return out;
  for (const f of loaded.frames)
    out += chunks(`a=f,t=d,f=100,i=${image_id},x=${f.x},y=${f.y},c=${f.base},z=${f.delay}`, f.png);
  return out + `\x1b_Ga=a,i=${image_id},r=1,z=${loaded.delay},q=2\x1b\\\x1b_Ga=a,i=${image_id},s=3,v=1,q=2\x1b\\`;
}
/** The frames of the GIF at `path` shrunk to fit `box`, or null to show it
 * still: a single frame, or a first frame that leaves part of the canvas
 * blank, which a host that can't animate would show as it is. */
async function animate(path: string, box: { width: number; height: number }): Promise<Loaded | null> {
  const a = gif.animation(new Uint8Array(await Bun.file(path).arrayBuffer()));
  const first = a?.frames[0];
  if (!a || !first || first.width !== a.width || first.height !== a.height) return null;
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
    if (i === 0) continue;
    const x = Math.floor(f.left * scale),
      y = Math.floor(f.top * scale),
      w = Math.max(1, Math.min(width, Math.ceil((f.left + f.width) * scale)) - x),
      h = Math.max(1, Math.min(height, Math.ceil((f.top + f.height) * scale)) - y);
    const before = a.frames[i - 1],
      cleared = before.width === a.width && before.height === a.height;
    // Kitty numbers frames from 1, so GIF frame `i` is Kitty frame `i + 1`.
    const base = before.disposal === 3 ? i - 1 : before.disposal === 2 && cleared ? 0 : i;
    frames.push({ png: await shrink(f.still, w, h), x, y, base, delay: f.delay });
  }
  const png = await shrink(first.still, width, height);
  return { thumbnail: { width, height, cell: { width: 0, height: 0 } }, png, delay: first.delay, frames };
}
/** Holds the thumbnail of the last image link hovered, and which one the host has. */
export class Loader {
  private key: string | null = null;
  private loaded: Loaded | null = null;
  /** The thumbnail the host holds. */
  sent: string | null = null;
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
      const animated = /\.gif$/i.test(path) ? await animate(path, box).catch(() => null) : null;
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
    this.loaded = loaded;
    this.wake();
  }
  /** What the host needs written to hold `shown`, the thumbnail a card shows
   * now: it is sent once, and freed once no card shows it. */
  sync(shown: Thumbnail | null): string {
    if (shown !== null && this.loaded?.thumbnail === (shown.of ?? shown)) {
      if (this.sent === this.key) return "";
      this.sent = this.key;
      return transmit(this.loaded);
    }
    if (shown !== null || this.sent === null) return "";
    this.sent = null;
    return remove;
  }
}
