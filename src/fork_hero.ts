//! The fork card's hero: a branch drawn in box-drawing text.
import * as palette from "./palette";
export const width = 12;
const junction = 4,
  node_col = 11;
export type Cell = { width: number; height: number };
export function draw(x: number, y: number, glyphs: boolean) {
  const style = (fg: palette.Token) => new palette.Style({ fg, bg: "surface" }).sgr(),
    node = glyphs ? "" : "●";
  let out = "";
  const put = (col: number, row: number, fg: palette.Token, text: string) =>
    (out += `\x1b[${y + row + 1};${x + col + 1}H${style(fg)}${text}`);
  put(0, 1, "faint", (glyphs ? "" : "─") + "─".repeat(junction - 1) + "┤");
  put(junction, 0, "faint", "╭" + "─".repeat(node_col - junction - 1));
  put(junction, 2, "faint", "╰" + "─".repeat(node_col - junction - 1));
  put(node_col, 0, "muted", node);
  put(node_col, 2, "accent", node);
  return out;
}
