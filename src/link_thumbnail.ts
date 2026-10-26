//! The picture a link card shows for an image file on this machine: shrunk
//! on Bun's image worker, sent to the host once as a Kitty image, and placed
//! by each frame that shows the card.
import { hostname } from "node:os";
import type { Cell } from "./fork_hero";
import type { Rect } from "./layout";
import { filePath, thumbnailCells, type Thumbnail } from "./link_tooltip";

/** The most of the screen a thumbnail covers, in cells. */
export const max_cols = 28,
  max_rows = 10;
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
  return `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${image_id},p=1,X=${left % t.cell.width},Y=${top % t.cell.height},z=1,C=1,q=2\x1b\\\x1b8`;
}
function transmit(png: Buffer): string {
  const data = png.toString("base64");
  let out = "";
  for (let offset = 0; offset < data.length; offset += 4096) {
    const end = Math.min(offset + 4096, data.length),
      more = Number(end < data.length);
    out +=
      (offset === 0 ? `\x1b_Ga=t,t=d,f=100,i=${image_id},q=2,m=${more};` : `\x1b_Gm=${more};`) +
      data.slice(offset, end) +
      "\x1b\\";
  }
  return out;
}
/** Holds the thumbnail of the last image link hovered, and which one the host has. */
export class Loader {
  private key: string | null = null;
  private loaded: { thumbnail: Thumbnail; png: Buffer } | null = null;
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
    let png: Buffer;
    try {
      png = await new Bun.Image(path, { maxPixels: 100_000_000 })
        .resize(max_cols * cell.width, max_rows * cell.height, { fit: "inside", withoutEnlargement: true })
        .png()
        .buffer();
    } catch {
      // Gone, or not an image after all: the card goes without one.
      return;
    }
    if (this.key !== key) return;
    this.loaded = { thumbnail: { width: png.readUInt32BE(16), height: png.readUInt32BE(20), cell }, png };
    this.wake();
  }
  /** What the host needs written to hold `shown`, the thumbnail a card shows
   * now: it is sent once, and freed once no card shows it. */
  sync(shown: Thumbnail | null): string {
    if (shown !== null && this.loaded?.thumbnail === shown) {
      if (this.sent === this.key) return "";
      this.sent = this.key;
      return transmit(this.loaded.png);
    }
    if (shown !== null || this.sent === null) return "";
    this.sent = null;
    return remove;
  }
}
