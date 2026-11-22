import * as hostImages from "./host_images";
import * as palette from "./palette";
import type { Quality } from "./connection_stats";
import type { Cell } from "./fork_hero";

const key = (cell: Cell) =>
  `${cell.width}x${cell.height}:${[palette.colors.surface, palette.colors.line, palette.colors.accent, palette.colors.warm].join(";")}`;

/** The cells the four bars share. */
export const cells = 2;

/** Whether bars can be drawn in cells this size. */
export function fits(cell: Cell): boolean {
  return cell.width >= 4 && cell.height >= 4 && cell.width * cell.height <= 16384;
}

/** Four bars across `cells` cells, each about twice as wide as the gaps
 * between them, clear of the cell's top and bottom edges. */
export function pixels(quality: Quality, cell: Cell): Uint8Array {
  const width = cell.width * cells,
    gap = Math.max(1, Math.round(width / 12)),
    bar = Math.floor((width - 3 * gap) / 4),
    left = Math.floor((width - 4 * bar - 3 * gap) / 2),
    pad = Math.max(1, Math.round(cell.height / 8)),
    bottom = cell.height - pad,
    out = new Uint8Array(width * cell.height * 4);
  for (let y = 0; y < cell.height; y++)
    for (let x = 0; x < width; x++) {
      const at = x - left,
        index = Math.floor(at / (bar + gap));
      const filled =
        at >= 0 &&
        index < 4 &&
        at % (bar + gap) < bar &&
        y < bottom &&
        y >= bottom - Math.round(((index + 1) * (bottom - pad)) / 4);
      const color = filled
        ? index < quality
          ? palette.colors[quality >= 3 ? "accent" : "warm"]
          : palette.colors.line
        : palette.colors.surface;
      out.set([...color, filled ? 255 : 0], (y * width + x) * 4);
    }
  return out;
}

/** Each quality's bars as last drawn, and the cell size and colors they
 * were drawn for. */
const drawn = new Map<Quality, { key: string; image: hostImages.Image }>();

/** Shows `quality`'s bars from column `col` of row `row`. */
export function place(frame: hostImages.FrameImages, quality: Quality, col: number, row: number, cell: Cell): void {
  let bars = drawn.get(quality);
  if (bars?.key !== key(cell)) {
    const image = new hostImages.Image({ rgba: pixels(quality, cell), width: cells * cell.width, height: cell.height });
    drawn.set(quality, (bars = { key: key(cell), image }));
  }
  frame.show(bars.image, { col, row });
}
