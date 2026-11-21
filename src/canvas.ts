//! A grid of cells drawn whole: the review panel, the file peek and the file
//! pane each fill one, then write it at its place on the screen. Text from
//! outside goes through `safe`, so its controls never reach the terminal.
import * as palette from "./palette";
import { codepointWidth, Writer } from "./text";

/** A cell: its text and colors; a null background is the terminal's own. */
export interface Cell {
  ch: string;
  fg: palette.Rgb;
  bg: palette.Rgb | null;
  bold: boolean;
}
/** Screen cells a hit covers. */
export type Box = { x: number; y: number; w: number; h: number };
/** Control characters never reach the terminal. */
export const safe = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 32;
  return cp < 32 || cp === 127 || (cp >= 0x80 && cp < 0xa0) ? "·" : ch;
};
export type SourceSlice = { start: number; end: number; width: number };
export const sourceGlyph = (ch: string) => (ch === "\t" ? " " : safe(ch));
/** Slice source by terminal cells while retaining UTF-16 offsets for highlighting. */
export function sourceSlice(value: string, start: number, width: number): SourceSlice {
  let end = start,
    used = 0;
  while (end < value.length) {
    const raw = String.fromCodePoint(value.codePointAt(end)!);
    const cells = Math.max(0, codepointWidth(sourceGlyph(raw).codePointAt(0)!));
    if (used + cells > width) break;
    used += cells;
    end += raw.length;
  }
  return { start, end, width: used };
}
export function sourceLines(value: string, width: number, limit: number, start = 0): SourceSlice[] {
  const lines: SourceSlice[] = [];
  do {
    const line = sourceSlice(value, start, width);
    lines.push(line);
    if (line.end === start) break;
    start = line.end;
  } while (start < value.length && lines.length < limit);
  return lines;
}
/** Horizontal scrolling never starts inside a wide codepoint. */
export function sourceOffset(value: string, columns: number): number {
  let at = 0,
    used = 0;
  while (at < value.length && used < columns) {
    const raw = String.fromCodePoint(value.codePointAt(at)!);
    used += Math.max(0, codepointWidth(sourceGlyph(raw).codePointAt(0)!));
    at += raw.length;
  }
  return at;
}
export class Canvas<H extends object = object> {
  cells: Cell[][];
  hits: (Box & H)[] = [];
  constructor(
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () =>
      Array.from({ length: w }, () => ({ ch: " ", fg: palette.colors.text, bg: null, bold: false })),
    );
  }
  fill(row: number, bg: palette.Rgb | null, from = 0, to = this.w): void {
    if (row < 0 || row >= this.h) return;
    for (let i = Math.max(0, from); i < Math.min(this.w, to); i++)
      Object.assign(this.cells[row][i], { ch: " ", bg, bold: false });
  }
  /** Writes `text` from column `col`, at most `room` columns, ending in
   * "…" when cut. Returns the column after it. */
  text(
    col: number,
    row: number,
    text: string,
    fg: palette.Rgb,
    bg?: palette.Rgb | null,
    bold = false,
    room = this.w - col,
  ): number {
    if (row < 0 || row >= this.h || room <= 0) return col;
    const chars = [...text];
    let used = 0;
    const total = chars.reduce((s, ch) => s + Math.max(0, codepointWidth(ch.codePointAt(0)!)), 0);
    const cut = total > room;
    for (const raw of chars) {
      const ch = raw === "\t" ? " " : safe(raw);
      const width = Math.max(0, codepointWidth(ch.codePointAt(0)!));
      if (width === 0) continue;
      if (used + width > room - (cut ? 1 : 0)) break;
      this.put(col + used, row, ch, fg, bg, bold);
      if (width === 2) this.put(col + used + 1, row, "", fg, bg, bold);
      used += width;
    }
    if (cut) this.put(col + used++, row, "…", fg, bg, bold);
    return col + used;
  }
  put(col: number, row: number, ch: string, fg: palette.Rgb, bg?: palette.Rgb | null, bold = false): void {
    if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
    const cell = this.cells[row][col];
    cell.ch = ch;
    cell.fg = fg;
    if (bg !== undefined) cell.bg = bg;
    cell.bold = bold;
  }
  /** Every cell halfway to black, or to white on a light background, as panes dim behind a dialog. */
  fade(): void {
    for (const row of this.cells)
      for (const cell of row) [cell.fg, cell.bg] = [palette.fade(cell.fg), palette.fade(cell.bg ?? palette.colors.bg)];
  }
  hit(x: number, y: number, w: number, h: number, extra: H): void {
    this.hits.push({ x: this.x + x, y: this.y + y, w, h, ...extra });
  }
  flush(w: Writer): void {
    const plain = palette.bg("bg");
    this.cells.forEach((row, r) => {
      w.write(`\x1b[${this.y + r + 1};${this.x + 1}H\x1b[0m`);
      let style = "";
      for (const cell of row) {
        if (cell.ch === "") continue;
        const next = `\x1b[0m${cell.bold ? "\x1b[1m" : ""}${palette.fgRgb(cell.fg)}${cell.bg ? palette.bgRgb(cell.bg) : plain}`;
        if (next !== style) {
          w.write(next);
          style = next;
        }
        w.write(cell.ch);
      }
    });
    w.write("\x1b[0m");
  }
}
