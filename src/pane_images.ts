import type { Image, ImagePlacement } from "./pane/surface";
import type { Cell } from "./fork_hero";
import * as hostImages from "./host_images";
import { Rect } from "./layout";

type Read = (id: string, offset: number) => Promise<string | null>;
interface Asset {
  image: Image;
  pixels: Uint8Array | null;
  used: boolean;
  loading: Promise<void>;
}
interface Drawing {
  image: hostImages.Image;
  used: boolean;
}
interface Crop {
  x: number;
  y: number;
  width: number;
  height: number;
  left: number;
  top: number;
  full_width: number;
  full_height: number;
}
/** Images belong to the viewer, with ids isolated from both child programs and
 * Corgi's own graphics. Only visible crops are sent to the host, one picture
 * each. */
export class Images {
  private assets = new Map<string, Asset>();
  private drawings = new Map<string, Drawing>();
  private transfer: Promise<void> = Promise.resolve();
  constructor(private wake: () => void) {}

  begin(): void {
    for (const asset of this.assets.values()) asset.used = false;
    for (const drawing of this.drawings.values()) drawing.used = false;
  }
  /** Shows the images in `rect`. A `hidden` pane's stay with the host, unshown. */
  draw(
    frame: hostImages.Frame,
    placements: ImagePlacement[],
    rect: Rect,
    cell: Cell,
    read: Read,
    hidden = false,
  ): void {
    for (const p of placements) {
      const crop = clip(p, rect, cell);
      if (!crop) continue;
      let asset = this.assets.get(p.image.id);
      if (!asset) {
        asset = { image: p.image, pixels: null, used: true, loading: Promise.resolve() };
        this.assets.set(p.image.id, asset);
        const pending = asset;
        asset.loading = this.transfer.then(() => this.load(pending, read));
        this.transfer = asset.loading;
      }
      asset.used = true;
      if (!asset.pixels) continue;
      const key = JSON.stringify([
        p.image.id,
        p.source_x,
        p.source_y,
        p.source_width,
        p.source_height,
        crop.width,
        crop.height,
        crop.left,
        crop.top,
        crop.full_width,
        crop.full_height,
      ]);
      let drawing = this.drawings.get(key);
      if (!drawing) {
        const image = new hostImages.Image({
          rgba: raster(asset.pixels, p, crop),
          width: crop.width,
          height: crop.height,
        });
        this.drawings.set(key, (drawing = { image, used: true }));
      }
      drawing.used = true;
      if (hidden) frame.keep(drawing.image);
      else {
        const x = rect.x * cell.width + crop.x,
          y = rect.y * cell.height + crop.y;
        frame.show(drawing.image, {
          col: Math.floor(x / cell.width),
          row: Math.floor(y / cell.height),
          x: x % cell.width,
          y: y % cell.height,
          z: p.z,
        });
      }
    }
  }
  /** Forgets what this frame no longer shows. */
  end(): void {
    for (const [key, drawing] of this.drawings) if (!drawing.used) this.drawings.delete(key);
    for (const [key, asset] of this.assets) if (!asset.used) this.assets.delete(key);
  }
  clear(): void {
    this.begin();
    this.end();
  }
  /** Also used by deterministic tests to await the current image transfers. */
  async settled(): Promise<void> {
    await Promise.all([...this.assets.values()].map(asset => asset.loading));
  }
  private async load(asset: Asset, read: Read): Promise<void> {
    const { image } = asset;
    if (this.assets.get(image.id) !== asset) return;
    const channels = image.format === 24 ? 3 : image.format === 32 ? 4 : 0;
    if (!channels || image.bytes !== image.width * image.height * channels || image.bytes > 10_000_000) return;
    const pixels = new Uint8Array(image.bytes);
    try {
      for (let offset = 0; offset < pixels.length;) {
        const chunk = await read(image.id, offset);
        if (this.assets.get(image.id) !== asset || chunk === null) return;
        const data = Buffer.from(chunk, "base64");
        if (!data.length || offset + data.length > pixels.length) return;
        pixels.set(data, offset);
        offset += data.length;
      }
    } catch {
      // The image or pane can disappear while chunks are in flight.
      return;
    }
    asset.pixels = pixels;
    this.wake();
  }
}

function clip(p: ImagePlacement, rect: Rect, cell: Cell): Crop | null {
  const x = Math.round(p.x * cell.width),
    y = Math.round(p.y * cell.height);
  const full_width = Math.round(p.width * cell.width),
    full_height = Math.round(p.height * cell.height);
  const left = Math.max(0, -x),
    top = Math.max(0, -y);
  const width = Math.min(full_width - left, rect.w * cell.width - Math.max(0, x));
  const height = Math.min(full_height - top, rect.h * cell.height - Math.max(0, y));
  if (width <= 0 || height <= 0 || width * height > 16_000_000) return null;
  return { x: Math.max(0, x), y: Math.max(0, y), width, height, left, top, full_width, full_height };
}

/** Resample the visible source rectangle into exact host pixels. Sending it at
 * native size avoids rounding a partial cell up over a divider or overlay. */
function raster(data: Uint8Array, p: ImagePlacement, crop: Crop): Uint8Array {
  const out = new Uint8Array(crop.width * crop.height * 4);
  const channels = p.image.format / 8;
  for (let y = 0; y < crop.height; y++) {
    const sy = Math.max(
      p.source_y,
      Math.min(
        p.source_y + p.source_height - 1,
        p.source_y + ((y + crop.top + 0.5) * p.source_height) / crop.full_height - 0.5,
      ),
    );
    const y0 = Math.floor(sy),
      y1 = Math.min(y0 + 1, p.source_y + p.source_height - 1),
      fy = sy - y0;
    for (let x = 0; x < crop.width; x++) {
      const sx = Math.max(
        p.source_x,
        Math.min(
          p.source_x + p.source_width - 1,
          p.source_x + ((x + crop.left + 0.5) * p.source_width) / crop.full_width - 0.5,
        ),
      );
      const x0 = Math.floor(sx),
        x1 = Math.min(x0 + 1, p.source_x + p.source_width - 1),
        fx = sx - x0;
      const positions = [
        (y0 * p.image.width + x0) * channels,
        (y0 * p.image.width + x1) * channels,
        (y1 * p.image.width + x0) * channels,
        (y1 * p.image.width + x1) * channels,
      ];
      const weights = [(1 - fx) * (1 - fy), fx * (1 - fy), (1 - fx) * fy, fx * fy];
      const dest = (y * crop.width + x) * 4;
      let alpha = 0;
      for (let i = 0; i < 4; i++) alpha += weights[i] * (channels === 4 ? data[positions[i] + 3] : 255);
      for (let c = 0; c < 3; c++) {
        let color = 0;
        for (let i = 0; i < 4; i++)
          color += data[positions[i] + c] * weights[i] * (channels === 4 ? data[positions[i] + 3] : 255);
        out[dest + c] = alpha ? Math.round(color / alpha) : 0;
      }
      out[dest + 3] = Math.round(alpha);
    }
  }
  return out;
}
