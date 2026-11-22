//! The picture a link card shows for an image file: shrunk where the file
//! is, by Bun's image worker here or another computer's daemon, and placed,
//! as a Kitty image, by each frame that shows the card. An animated GIF is
//! sent as a Kitty animation, which hosts that can't play it show as its
//! first frame.
import type * as fileAccess from "./file_access";
import type { Cell } from "./fork_hero";
import * as hostImages from "./host_images";
import type { Rect } from "./layout";
import { thumbnailCells, type Thumbnail } from "./link_tooltip";

/** The most of the screen a thumbnail covers, in cells. */
export const max_cols = 64,
  max_rows = 24;
const extensions = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "avif"]);

/** Whether `path` names an image, by its extension. */
export function isImage(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot > path.lastIndexOf("/") && extensions.has(path.slice(dot + 1).toLowerCase());
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
/** An image asked for: its path on the computer `files` reads, at a cell size. */
interface Ask {
  path: string;
  files: fileAccess.Files;
  cell: Cell;
}
/** Holds the thumbnail of the last image link hovered. */
export class Loader {
  private ask: Ask | null = null;
  private loaded: Thumbnail | null = null;
  /** The load in flight, for tests to wait on. */
  loading: Promise<void> | null = null;
  constructor(private wake: () => void) {}
  /** The thumbnail of the image at `path`, which `files` reads, at `cell`; null until it loads. */
  get(path: string, files: fileAccess.Files, cell: Cell): Thumbnail | null {
    if (!isImage(path)) return null;
    const ask = this.ask;
    if (
      !ask ||
      ask.path !== path ||
      ask.files !== files ||
      ask.cell.width !== cell.width ||
      ask.cell.height !== cell.height
    ) {
      const next = { path, files, cell };
      this.ask = next;
      this.loaded = null;
      this.loading = this.load(next);
    }
    return this.loaded;
  }
  private async load(ask: Ask): Promise<void> {
    const { path, files, cell } = ask,
      wanted = () => this.ask === ask;
    let shrunk: Awaited<ReturnType<fileAccess.Files["thumbnail"]>>;
    try {
      shrunk = await files.thumbnail(path, { width: max_cols * cell.width, height: max_rows * cell.height }, wanted);
    } catch {
      // Gone, or not an image after all: the card goes without one.
      return;
    }
    if (!wanted()) return;
    this.loaded = {
      width: shrunk.width,
      height: shrunk.height,
      cell,
      image: new hostImages.Image({
        png: shrunk.png,
        animation: shrunk.frames.length ? { delay: shrunk.delay, frames: shrunk.frames } : undefined,
      }),
    };
    this.wake();
  }
}
