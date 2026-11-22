import * as hostImages from "./host_images";
import * as palette from "./palette";
import type { Rect } from "./layout";
import type { Cell } from "./fork_hero";

/** The grip as last drawn, and the cell size and color it was drawn for. */
let drawn: { key: string; image: hostImages.Image } | null = null;

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

/** Shows each unobscured grip. Text stays native. */
export function draw(frame: hostImages.FrameImages, rects: readonly Rect[], cell: Cell): void {
  const key = `${cell.width}x${cell.height}:${palette.outline}`;
  if (drawn?.key !== key) {
    drawn = { key, image: new hostImages.Image({ rgba: pixels(cell), width: 4 * cell.width, height: cell.height }) };
  }
  const image = drawn.image;
  for (const rect of rects) frame.show(image, { col: rect.x, row: rect.y });
}
