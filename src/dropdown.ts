//! A dropdown: a bordered box on `surface` with a row per choice, ✓ on the
//! current one and a faint note at the right edge; the hovered row takes
//! `selected`; a dim one steps back while something else has the keyboard.
//! A choice with a key shows it as a keycap where ✓ goes. The
//! sidebar's agent scope, Corgi setup's summaries and the launcher's
//! worktrees open one.
import { Style, fg, keycap } from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

export interface Choice {
  text: string;
  note: string;
  current: boolean;
  hovered: boolean;
  key?: string;
  dim?: boolean;
}
/** Columns from the left border to the text: past a keycap when any choice has one. */
function indent(choices: Choice[]): number {
  return choices.some(c => c.key) ? 5 : 4;
}
/** The width that fits every choice's text, and its note three cells on. */
export function width(choices: Choice[]): number {
  let widest = 0;
  for (const c of choices) widest = Math.max(widest, displayWidth(c.text) + (c.note ? 1 + displayWidth(c.note) : 0));
  // Past the text, the room `row` keeps before the note, a space and the border.
  return indent(choices) + widest + 4;
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
  choices.forEach((choice, i) => row(w, b, i + 1, choice, indent(choices)));
  w.write("\x1b[0m");
}
/** The choice under (x, y) inside `b`'s border, or null. */
export function hit(b: Rect, count: number, x: number, y: number): number | null {
  if (x <= b.x || x + 1 >= b.x + b.w || y <= b.y || y + 1 >= b.y + b.h) return null;
  const index = y - b.y - 1;
  return index < count ? index : null;
}
function row(w: Writer, b: Rect, y: number, choice: Choice, indent: number): void {
  const style = choice.hovered
    ? new Style({ fg: "strong", bg: "selected" }).sgr()
    : new Style({ fg: choice.dim ? "faint" : "text", bg: "surface" }).sgr();
  const line = b.y + y + 1;
  w.write(`\x1b[${line};${b.x + 2}H${style}`);
  w.splat(" ", b.w - 2);
  if (choice.current) w.write(`\x1b[${line};${b.x + 3}H` + fg(choice.dim ? "faint" : "strong") + `✓${style}`);
  else if (choice.key) w.write(`\x1b[${line};${b.x + 2}H${keycap} ${choice.key} ${style}`);
  const right = b.x + b.w - 2 - displayWidth(choice.note);
  // Faint is too dim on the hovered row's selected background.
  w.write(
    `\x1b[${line};${right + 1}H${fg(choice.hovered ? "muted" : choice.dim ? "line" : "faint")}${choice.note}${style}`,
  );
  w.write(`\x1b[${line};${b.x + 1 + indent}H`);
  writeEllipsis(w, choice.text, sat(sat(right, b.x + indent), 2));
}
