import * as palette from "./palette";
import { Writer, codepointWidth } from "./text";

/** One terminal cell. A wide glyph's second cell holds "". */
export interface Cell {
  ch: string;
  fg: palette.Rgb;
  bold: boolean;
}
const wide = (ch: string) => ch !== "" && codepointWidth(ch.codePointAt(0)!) === 2;
/** A box of cells drawn in one pass, for drawings that read back what is
 * already there, such as an effect that moves only through empty cells. */
export class Grid {
  rows: Cell[][];
  constructor(
    readonly w: number,
    readonly h: number,
    fg: palette.Rgb,
  ) {
    this.rows = Array.from({ length: h }, () => Array.from({ length: w }, () => ({ ch: " ", fg, bold: false })));
  }
  at(x: number, y: number): Cell | null {
    return this.rows[y]?.[x] ?? null;
  }
  put(x: number, y: number, ch: string, fg: palette.Rgb, bold = false): void {
    const cell = this.at(x, y);
    if (!cell) return;
    cell.ch = ch;
    cell.fg = fg;
    cell.bold = bold;
  }
  /** Writes `text` from `x`, wide glyphs taking two cells, stopping at the edge. */
  text(x: number, y: number, text: string, fg: palette.Rgb, bold = false): void {
    for (const ch of text) {
      const width = codepointWidth(ch.codePointAt(0)!);
      if (width === 0) continue;
      if (x + width > this.w) return;
      this.put(x++, y, ch, fg, bold);
      if (width === 2) this.put(x++, y, "", fg, bold);
    }
  }
  /** Whether nothing is drawn at `x`, `y`. */
  blank(x: number, y: number): boolean {
    return this.at(x, y)?.ch === " ";
  }
  /** Writes the cells at `x`, `y` on the screen over `background`. Half of
   * a wide glyph, its other half drawn over, shows as a space. */
  write(w: Writer, x: number, y: number, background: string): void {
    for (const cells of this.rows) {
      w.write(`\x1b[${y + 1};${x + 1}H${background}`);
      y++;
      let fg: palette.Rgb | null = null,
        bold = false,
        covered = false;
      for (let col = 0; col < this.w; col++) {
        const cell = cells[col];
        if (covered) {
          covered = false;
          continue;
        }
        if (bold !== cell.bold) {
          bold = cell.bold;
          w.write(bold ? "\x1b[1m" : "\x1b[22m");
        }
        if (fg === null || fg.some((v, i) => v !== cell.fg[i])) {
          fg = cell.fg;
          w.write(palette.fgRgb(fg));
        }
        covered = wide(cell.ch) && cells[col + 1]?.ch === "";
        w.write(covered || (cell.ch !== "" && !wide(cell.ch)) ? cell.ch : " ");
      }
    }
  }
}
