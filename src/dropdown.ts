//! A dropdown: a bordered box on `surface` with a row per choice, ✓ on the
//! current one and a faint note at the right edge; the hovered row takes
//! `selected`. The sidebar's agent scope and Corgi setup's summaries open one.
import { Style, fg } from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

export interface Choice {
  text: string;
  note: string;
  current: boolean;
  hovered: boolean;
}
/** Draws `choices` in `b`, a row each inside its border. */
export function draw(w: Writer, b: Rect, choices: Choice[]): void {
  const border = new Style({ fg: "line", bg: "surface" }).sgr();
  for (let y = 0; y < b.h; y++) {
    w.write(`\x1b[${b.y + y + 1};${b.x + 1}H${border}`);
    w.write(y === 0 ? "╭" : y === b.h - 1 ? "╰" : "│");
    if (y === 0 || y === b.h - 1) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(y === 0 ? "╮" : y === b.h - 1 ? "╯" : "│");
  }
  choices.forEach((choice, i) => row(w, b, i + 1, choice));
  w.write("\x1b[0m");
}
/** The choice under (x, y) inside `b`'s border, or null. */
export function hit(b: Rect, count: number, x: number, y: number): number | null {
  if (x <= b.x || x + 1 >= b.x + b.w || y <= b.y || y + 1 >= b.y + b.h) return null;
  const index = y - b.y - 1;
  return index < count ? index : null;
}
function row(w: Writer, b: Rect, y: number, choice: Choice): void {
  const style = choice.hovered
    ? new Style({ fg: "strong", bg: "selected" }).sgr()
    : new Style({ fg: "text", bg: "surface" }).sgr();
  const line = b.y + y + 1;
  w.write(`\x1b[${line};${b.x + 2}H${style}`);
  w.splat(" ", b.w - 2);
  if (choice.current) w.write(`\x1b[${line};${b.x + 3}H` + fg("strong") + `✓${style}`);
  const right = b.x + b.w - 2 - displayWidth(choice.note);
  // Faint is too dim on the hovered row's selected background.
  w.write(`\x1b[${line};${right + 1}H${choice.hovered ? fg("muted") : fg("faint")}${choice.note}${style}`);
  w.write(`\x1b[${line};${b.x + 5}H`);
  writeEllipsis(w, choice.text, sat(sat(right, b.x + 4), 2));
}
