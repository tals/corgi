import * as palette from "./palette";
import { Rect } from "./layout";
import type { Quality } from "./connection_stats";
import type { Cell } from "./fork_hero";

const first_id = 730400;
const key = (cell: Cell) =>
  `${cell.width}x${cell.height}:${[palette.colors.surface, palette.colors.line, palette.colors.accent, palette.colors.warm].join(";")}`;

/** Four terminal cells, with one pixel of background at each cell's right edge. */
export function pixels(quality: Quality, cell: Cell): Uint8Array {
  const width = cell.width * 4,
    out = new Uint8Array(width * cell.height * 4);
  for (let y = 0; y < cell.height; y++)
    for (let x = 0; x < width; x++) {
      const bar = Math.floor(x / cell.width);
      const filled = x % cell.width < cell.width - 1 && y >= cell.height - Math.round(((bar + 1) * cell.height) / 4);
      const color = filled
        ? bar < quality
          ? palette.colors[quality >= 3 ? "accent" : "warm"]
          : palette.colors.line
        : palette.colors.surface;
      out.set([...color, filled ? 255 : 0], (y * width + x) * 4);
    }
  return out;
}

export class Images {
  private held = new Map<Quality, string>();
  private wanted = new Map<Quality, Cell>();
  private placement = 0;
  begin(): string {
    this.placement = 0;
    return [...this.held.keys()].map(q => `\x1b_Ga=d,d=i,i=${first_id + q},q=2\x1b\\`).join("");
  }
  ready(quality: Quality, cell: Cell): boolean {
    if (cell.width < 2 || cell.height < 4 || cell.width * cell.height > 16384) return false;
    if (this.held.get(quality) === key(cell)) return true;
    this.wanted.set(quality, cell);
    return false;
  }
  place(quality: Quality, col: number, row: number, cell: Cell, covered: readonly Rect[] = []): string {
    if (!this.ready(quality, cell)) return "";
    const whole = new Rect(col, row, 4, 1);
    let pieces = [whole];
    for (const box of covered) pieces = pieces.flatMap(piece => piece.cut(box));
    return pieces
      .map(piece => {
        const source =
          piece === whole ? "" : `x=${(piece.x - col) * cell.width},y=0,w=${piece.w * cell.width},h=${cell.height},`;
        return `\x1b7\x1b[${piece.y + 1};${piece.x + 1}H\x1b_Ga=p,i=${first_id + quality},p=${++this.placement},${source}z=1,C=1,q=2\x1b\\\x1b8`;
      })
      .join("");
  }
  end(): string {
    let out = "";
    for (const [quality, cell] of this.wanted) {
      const data = Buffer.from(pixels(quality, cell)).toString("base64");
      for (let start = 0; start < data.length; start += 4096) {
        const end = Math.min(start + 4096, data.length),
          more = Number(end < data.length);
        out +=
          (start === 0
            ? `\x1b_Ga=t,t=d,f=32,s=${cell.width * 4},v=${cell.height},i=${first_id + quality},q=2,m=${more};`
            : `\x1b_Gm=${more};`) +
          data.slice(start, end) +
          "\x1b\\";
      }
      this.held.set(quality, key(cell));
    }
    this.wanted.clear();
    return out;
  }
  clear(): string {
    const out = [...this.held.keys()].map(q => `\x1b_Ga=d,d=I,i=${first_id + q},q=2\x1b\\`).join("");
    this.held.clear();
    this.wanted.clear();
    return out;
  }
}
