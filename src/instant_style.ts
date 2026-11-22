import type { Surface } from "./pane/surface";
import * as palette from "./palette";
import * as text from "./text";

/** Columns `[start, end)` of row `y`. */
export interface Span {
  y: number;
  start: number;
  end: number;
}

/** Shade the text in `spans`; retain the application's backgrounds and borders. */
export function dim(projected: Surface, spans: Span[]): Surface {
  const lines = projected.lines.slice();
  for (const { y, start, end } of spans) {
    if (lines[y] === undefined || end <= start) continue;
    let column = 0,
      style = "",
      shaded = false,
      output = "",
      offset = 0;
    for (const match of lines[y].matchAll(/\x1b\[[0-9;]*m|[^\x1b]/gu)) {
      if (match.index !== offset) break;
      const token = match[0];
      offset += token.length;
      if (token.startsWith("\x1b")) {
        style += token;
        output += token;
        if (shaded) output += palette.fg("muted");
      } else {
        const on = column >= start && column < end && token !== " ";
        if (on !== shaded) output += on ? palette.fg("muted") : "\x1b[0m" + style;
        shaded = on;
        output += token;
        column += text.displayWidth(token);
      }
    }
    if (shaded) output += "\x1b[0m" + style;
    if (offset === lines[y].length) lines[y] = output;
  }
  return { ...projected, lines };
}

/** The part of `next` that differs from `confirmed`, as `[start, end)` offsets
 * into `next`: what's left after their common prefix and suffix. */
export function changed(confirmed: string, next: string): { start: number; end: number } {
  let start = 0;
  while (start < confirmed.length && start < next.length && confirmed[start] === next[start]) start++;
  let suffix = 0;
  while (
    suffix < confirmed.length - start &&
    suffix < next.length - start &&
    confirmed[confirmed.length - 1 - suffix] === next[next.length - 1 - suffix]
  )
    suffix++;
  return { start, end: next.length - suffix };
}
