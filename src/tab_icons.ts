//! The brand marks untitled tabs wear: each drawn at the host's cell size,
//! sent to the host as a Kitty image the first time a tab shows it, and kept
//! there after, so a mark pops in at most once and is sent only again when
//! the font or the theme redraws it.
import { deflateSync } from "node:zlib";
import * as palette from "./palette";
import { contrast } from "./terminal_palette";
import { art } from "./assets/brand_icons";
import { brands, type Brand } from "./process_name";
import { rasterize, type Layer } from "./path_raster";
import type { Cell } from "./fork_hero";

/** The columns a mark takes in its tab, after the number. */
export const cols = 2;
const first_id = 730300;
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
const id = (brand: Brand) => first_id + brands.indexOf(brand);

/** The marks the host holds for one viewer. */
export class Icons {
  /** The size and colors each mark the host holds was drawn at. */
  private held = new Map<Brand, string>();
  private wanted = new Map<Brand, Cell>();
  private placement = 0;
  /** Takes the last frame's marks off the screen, keeping their pixels; the
   * frame places those it shows again. */
  begin(): string {
    this.placement = 0;
    let out = "";
    for (const brand of this.held.keys()) out += `\x1b_Ga=d,d=i,i=${id(brand)},q=2\x1b\\`;
    return out;
  }
  /** Places `brand`'s mark at column `col` of row `row`. Empty until the host
   * holds it drawn for `cell` in the theme's colors, which asks for it. */
  place(brand: Brand, col: number, row: number, cell: Cell): string {
    if (this.held.get(brand) !== key(brand, cell)) {
      this.wanted.set(brand, cell);
      return "";
    }
    return `\x1b7\x1b[${row + 1};${col + 1}H\x1b_Ga=p,i=${id(brand)},p=${++this.placement},Y=${size(cell).top},z=1,C=1,q=2\x1b\\\x1b8`;
  }
  /** Sends the marks the frame asked for. */
  end(): string {
    let out = "";
    for (const [brand, cell] of this.wanted) {
      const { side } = size(cell),
        pixels = rasterize(fill(brand).layers, art[brand].view, side, side),
        data = deflateSync(pixels).toString("base64");
      for (let start = 0; start < data.length; start += 4096) {
        const end = Math.min(start + 4096, data.length),
          more = Number(end < data.length);
        out +=
          (start === 0
            ? `\x1b_Ga=t,t=d,f=32,o=z,s=${side},v=${side},i=${id(brand)},q=2,m=${more};`
            : `\x1b_Gm=${more};`) +
          data.slice(start, end) +
          "\x1b\\";
      }
      this.held.set(brand, key(brand, cell));
    }
    this.wanted.clear();
    return out;
  }
  /** Frees every mark on the host. */
  clear(): string {
    let out = "";
    for (const brand of this.held.keys()) out += `\x1b_Ga=d,d=I,i=${id(brand)},q=2\x1b\\`;
    this.held.clear();
    this.wanted.clear();
    return out;
  }
}
function key(brand: Brand, cell: Cell) {
  return `${cell.width}x${cell.height} ${fill(brand).colors}`;
}
