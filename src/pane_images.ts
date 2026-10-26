import type { Image, ImagePlacement } from "./pane/surface";
import type { Cell } from "./fork_hero";
import { Rect } from "./layout";

type Read = (id: string, offset: number) => Promise<string | null>;
interface Asset {
  image: Image;
  pixels: Uint8Array | null;
  used: boolean;
  loading: Promise<void>;
}
interface Drawing {
  id: number;
  used: boolean;
  sent: boolean;
  upload: string;
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
const remove = (id: number, pixels: boolean) => `\x1b_Ga=d,d=${pixels ? "I" : "i"},i=${id},q=2\x1b\\`;

/** Images belong to the viewer, with ids isolated from both child programs and
 * Corgi's own graphics. Only visible crops are uploaded to the host. */
export class Images {
  private assets = new Map<string, Asset>();
  private drawings = new Map<string, Drawing>();
  private next_id = 0x10000000;
  private placement = 0;
  private transfer: Promise<void> = Promise.resolve();
  constructor(private wake: () => void) {}

  begin(): string {
    this.placement = 0;
    let hide = "";
    for (const asset of this.assets.values()) asset.used = false;
    for (const drawing of this.drawings.values()) {
      drawing.used = false;
      if (drawing.sent) hide += remove(drawing.id, false);
    }
    return hide;
  }
  /** Places the images in `rect`, cut around the `covered` cells Corgi draws over them. */
  draw(placements: ImagePlacement[], rect: Rect, cell: Cell, read: Read, covered: readonly Rect[] = []): string {
    let out = "";
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
        const id = this.next_id++;
        const pixels = raster(asset.pixels, p, crop);
        drawing = { id, used: true, sent: false, upload: transmit(id, crop.width, crop.height, pixels) };
        this.drawings.set(key, drawing);
      }
      drawing.used = true;
      if (!drawing.sent) continue;
      const whole = new Rect(rect.x * cell.width + crop.x, rect.y * cell.height + crop.y, crop.width, crop.height);
      let pieces = [whole];
      for (const box of covered) {
        const hole = new Rect(box.x * cell.width, box.y * cell.height, box.w * cell.width, box.h * cell.height);
        pieces = pieces.flatMap(piece => cut(piece, hole));
      }
      for (const piece of pieces) {
        const col = Math.floor(piece.x / cell.width),
          row = Math.floor(piece.y / cell.height);
        // A piece shows its part of the upload at its own size.
        const source =
          piece === whole ? "" : `x=${piece.x - whole.x},y=${piece.y - whole.y},w=${piece.w},h=${piece.h},`;
        out += `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${drawing.id},p=${++this.placement},${source}X=${piece.x % cell.width},Y=${piece.y % cell.height},z=${p.z},C=1,q=2\x1b\\\x1b8`;
      }
    }
    return out;
  }
  end(): string {
    let writes = "";
    for (const [key, drawing] of this.drawings) {
      if (!drawing.used) {
        if (drawing.sent) writes += remove(drawing.id, true);
        this.drawings.delete(key);
      } else if (!drawing.sent) {
        writes += drawing.upload;
        drawing.upload = "";
        drawing.sent = true;
      }
    }
    for (const [key, asset] of this.assets) if (!asset.used) this.assets.delete(key);
    return writes;
  }
  clear(): string {
    this.begin();
    return this.end();
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

/** `r` without `hole`: the strips above and below it, then those beside it. */
function cut(r: Rect, hole: Rect): Rect[] {
  const top = Math.max(r.y, hole.y),
    bottom = Math.min(r.y + r.h, hole.y + hole.h);
  const left = Math.max(r.x, hole.x),
    right = Math.min(r.x + r.w, hole.x + hole.w);
  if (top >= bottom || left >= right) return [r];
  return [
    new Rect(r.x, r.y, r.w, top - r.y),
    new Rect(r.x, bottom, r.w, r.y + r.h - bottom),
    new Rect(r.x, top, left - r.x, bottom - top),
    new Rect(right, top, r.x + r.w - right, bottom - top),
  ].filter(piece => piece.w > 0 && piece.h > 0);
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

function transmit(id: number, width: number, height: number, pixels: Uint8Array): string {
  const data = Buffer.from(pixels).toString("base64");
  let out = "";
  for (let start = 0; start < data.length; start += 4096) {
    const end = Math.min(start + 4096, data.length),
      more = Number(end < data.length);
    out +=
      (start === 0 ? `\x1b_Ga=t,t=d,f=32,s=${width},v=${height},i=${id},q=2,m=${more};` : `\x1b_Gm=${more};`) +
      data.slice(start, end) +
      "\x1b\\";
  }
  return out;
}
