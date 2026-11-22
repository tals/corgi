//! The brand marks untitled tabs wear: each drawn at the host's cell size as
//! a Kitty image, and drawn again when the font or the theme changes.
import * as hostImages from "./host_images";
import * as palette from "./palette";
import { contrast } from "./terminal_palette";
import { art } from "./assets/brand_icons";
import { brands, type Brand } from "./process_name";
import { rasterize, type Layer } from "./path_raster";
import type { Cell } from "./fork_hero";

/** The columns a mark takes in its tab, after the number. */
export const cols = 2;
/** A one-color mark that would barely show on the tabs takes their ink. */
const min_contrast = 1.5;
let fills = new Map<Brand, { layers: Layer[]; colors: string }>();
palette.derived(() => {
  fills = new Map();
});
/** A mark's paths in the colors its tabs draw them. */
export function fill(brand: Brand) {
  let out = fills.get(brand);
  if (!out) {
    const rgb = (hex: string) => [0, 2, 4].map(i => parseInt(hex.slice(i, i + 2), 16)) as palette.Rgb;
    const layers = art[brand].layers.map(([color, d]) => ({
      d,
      rgb: color === "ink" ? palette.colors.text : rgb(color),
    }));
    if (
      layers.length === 1 &&
      [palette.colors.surface, palette.colors.selected].some(g => contrast(layers[0].rgb, g) < min_contrast)
    )
      layers[0] = { d: layers[0].d, rgb: palette.colors.text };
    out = { layers, colors: layers.map(l => l.rgb.join(",")).join(" ") };
    fills.set(brand, out);
  }
  return out;
}
/** A mark's side in pixels, a tenth of its two cells' box in from each edge,
 * and how far down its cell it starts. The half cell the number's badge
 * leaves on its right gives as much room before the mark as after it. */
export function size(cell: Cell): { side: number; top: number } {
  const box = Math.min(cell.height, cols * cell.width),
    side = Math.max(1, box - 2 * Math.round(box / 10));
  return { side, top: Math.floor((cell.height - side) / 2) };
}
/** Each mark as last drawn, and the size and colors it was drawn at. */
const drawn = new Map<Brand, { key: string; image: hostImages.Image }>();

/** Shows `brand`'s mark at column `col` of row `row`; `top` when it sits in
 * a card drawn over the rest. */
export function place(
  frame: hostImages.FrameImages,
  brand: Brand,
  col: number,
  row: number,
  cell: Cell,
  top = false,
): boolean {
  const { side } = size(cell);
  let mark = drawn.get(brand);
  if (mark?.key !== key(brand, cell)) {
    const rgba = rasterize(fill(brand).layers, art[brand].view, side, side);
    drawn.set(
      brand,
      (mark = { key: key(brand, cell), image: new hostImages.Image({ rgba, width: side, height: side }) }),
    );
  }
  return frame.show(mark.image, { col, row, y: size(cell).top, top });
}
function key(brand: Brand, cell: Cell) {
  return `${cell.width}x${cell.height} ${fill(brand).colors}`;
}
