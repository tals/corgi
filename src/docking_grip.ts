import { deflateSync } from "node:zlib";
import * as palette from "./palette";
import type { Rect } from "./layout";
import type { Cell } from "./fork_hero";

const image_id = 730410;
export const hide = `\x1b7\x1b[1;1H\x1b_Ga=d,d=i,i=${image_id},q=2\x1b\\\x1b8`;
export const clear = `\x1b_Ga=d,d=I,i=${image_id},q=2\x1b\\`;
let cached: { key: string; data: string } | null = null;

/** A transparent outline with joins at the divider's centerline. */
export function pixels(cell: Cell): Uint8Array {
  const width = 4 * cell.width,
    height = cell.height,
    left = Math.max(2, Math.round(cell.width / 2)),
    top = Math.max(2, Math.round(height * 0.16)),
    radius = Math.max(1, Math.min(3, cell.width / 3)),
    half_w = width / 2 - left,
    half_h = height / 2 - top,
    mid = Math.floor(height / 2),
    stroke = Math.max(2, 2 * Math.round(height / 36)),
    out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const dx = Math.abs(x + 0.5 - width / 2) - half_w + radius,
        dy = Math.abs(y + 0.5 - height / 2) - half_h + radius,
        distance = Math.hypot(Math.max(0, dx), Math.max(0, dy)) + Math.min(0, Math.max(dx, dy)) - radius;
      let coverage = 0.5 + stroke / 2 - Math.abs(distance);
      if (x + 0.5 < left || x + 0.5 > width - left)
        coverage = Math.max(coverage, 0.5 + stroke / 2 - Math.abs(y + 0.5 - mid));
      const at = (y * width + x) * 4;
      out.set(palette.outline, at);
      out[at + 3] = Math.round(255 * Math.min(1, Math.max(0, coverage)));
    }
  return out;
}

/** One upload, then a placement for each unobscured grip. Text stays native. */
export function draw(rects: readonly Rect[], cell: Cell): string {
  if (!rects.length) return "";
  const key = `${cell.width}x${cell.height}:${palette.outline}`;
  if (cached?.key !== key) cached = { key, data: deflateSync(pixels(cell)).toString("base64") };
  const width = 4 * cell.width,
    height = cell.height;
  let out = "\x1b7";
  for (let start = 0; start < cached.data.length; start += 4096) {
    const end = Math.min(start + 4096, cached.data.length),
      more = Number(end < cached.data.length);
    out +=
      (start === 0 ? `\x1b_Ga=t,f=32,o=z,s=${width},v=${height},i=${image_id},q=2,m=${more};` : `\x1b_Gm=${more};`) +
      cached.data.slice(start, end) +
      "\x1b\\";
  }
  for (const [i, rect] of rects.entries())
    out += `\x1b[${rect.y + 1};${rect.x + 1}H\x1b_Ga=p,i=${image_id},p=${i + 1},z=1,C=1,q=2\x1b\\`;
  return out + "\x1b8";
}
