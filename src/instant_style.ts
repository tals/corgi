import type { Surface } from "./pane/surface";
import * as palette from "./palette";
import * as text from "./text";

/** Shade changed input cells only; retain the application's backgrounds and borders. */
export function dim(projected: Surface, base: Surface, rows: { y: number; start: number; end: number }[]): Surface {
  const lines = projected.lines.slice();
  for (const { y, start, end } of rows) {
    const actual = cells(Bun.stripANSI(base.lines[y] ?? ""));
    let column = 0,
      style = "",
      shaded = false,
      output = "",
      offset = 0;
    for (const match of lines[y].matchAll(/\x1b\[[0-9;]*m|[^\x1b]/gu)) {
      if (match.index !== offset) {
        output = lines[y];
        shaded = false;
        break;
      }
      const token = match[0];
      offset += token.length;
      if (token.startsWith("\x1b")) {
        style += token;
        output += token;
        if (shaded) output += palette.fg("muted");
      } else {
        const on = column >= start && column < end && token !== " " && token !== actual.get(column);
        if (on !== shaded) output += on ? palette.fg("muted") : "\x1b[0m" + style;
        shaded = on;
        output += token;
        column += text.displayWidth(token);
      }
    }
    if (shaded) output += "\x1b[0m" + style;
    lines[y] = offset === lines[y].length ? output : lines[y];
  }
  return { ...projected, lines };
}
function cells(line: string): Map<number, string> {
  const result = new Map<number, string>();
  let column = 0;
  for (const character of line) {
    result.set(column, character);
    column += text.displayWidth(character);
  }
  return result;
}
