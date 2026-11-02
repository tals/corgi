/** Display columns shared by recorded frames, live panels and pointer targets. */
import * as text from "../src/text";

export type Cell = [string, number];
export type Runs = [string, number][];

export function decode(runs: Runs): Cell[] {
  const cells: Cell[] = [];
  for (const [value, style] of runs) {
    for (const ch of value) {
      const width = text.displayWidth(ch);
      if (!width) {
        const previous = cells.at(-1)?.[0] === "" ? cells.at(-2) : cells.at(-1);
        if (previous) previous[0] += ch;
      } else {
        cells.push([ch, style]);
        if (width === 2) cells.push(["", style]);
      }
    }
  }
  return cells;
}

export function put(row: Cell[] | undefined, column: number, value: string, style?: number): number {
  const clear = (at: number) => {
    if (!row?.[at]) return;
    if (row[at][0] === "" && row[at - 1]) row[at - 1] = [" ", row[at - 1][1]];
    if (text.displayWidth(row[at][0]) === 2 && row[at + 1]) row[at + 1] = [" ", row[at + 1][1]];
    row[at] = [" ", row[at][1]];
  };
  for (const [ch] of decode([[value, 0]])) {
    if (!ch) continue;
    const width = text.displayWidth(ch);
    if (row && column >= 0 && column + width <= row.length) {
      clear(column);
      if (width === 2) clear(column + 1);
      const ink = style ?? row[column][1];
      row[column] = [ch, ink];
      if (width === 2) row[column + 1] = ["", ink];
    } else {
      for (let i = 0; i < width; i++) clear(column + i);
    }
    column += width;
  }
  return column;
}

/** Cropped half-glyphs remain blank columns, just as in the terminal. */
export function visible(row: Cell[], column: number, end = row.length): Cell {
  const cell = row[column];
  if (
    (cell[0] === "" && (column === 0 || text.displayWidth(row[column - 1][0]) !== 2)) ||
    (text.displayWidth(cell[0]) === 2 && (column + 1 >= end || row[column + 1]?.[0] !== ""))
  )
    return [" ", cell[1]];
  return cell;
}

export function find(row: Cell[], value: string, from = 0): number {
  const needle = decode([[value, 0]]);
  if (!needle.length) return -1;
  for (let column = from; column + needle.length <= row.length; column++) {
    if (needle.every(([ch], offset) => row[column + offset][0] === ch)) return column;
  }
  return -1;
}
