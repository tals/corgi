//! A dropdown: a bordered box on `surface` with a row per choice, ✓ on the
//! current one and a faint note at the right edge; the hovered row takes
//! `selected`; a dim one steps back while something else has the keyboard.
//! A choice with a key shows it as a keycap where ✓ goes. Faint column
//! headings may sit over the choices, and a note may color its runs.
//! The sidebar's agent scope, Corgi setup's summaries, the launcher's
//! worktrees and the review panel's commits open one.
import { Style, fg, keycap, type Token } from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

/** Part of a note in its own color. */
export type Run = [string, Token];
export function sameRuns(a: Run[], b: Run[]): boolean {
  return a.length === b.length && a.every(([text, token], i) => text === b[i][0] && token === b[i][1]);
}
export interface Choice {
  text: string;
  note: string;
  /** `note` split into runs of their own colors. */
  runs?: Run[];
  current: boolean;
  hovered: boolean;
  key?: string;
  dim?: boolean;
}
/** Headings over the choices' text and over their notes. */
export interface Heading {
  text: string;
  note: string;
}
/** Columns from the left border to the text: past a keycap when any choice has one. */
function indent(choices: Choice[]): number {
  return choices.some(c => c.key) ? 5 : 4;
}
/** The width that fits every choice's text, and its note three cells on. */
export function width(choices: Choice[], heading?: Heading): number {
  let widest = 0;
  for (const c of heading ? [...choices, heading] : choices) {
    const note = displayWidth(c.note);
    widest = Math.max(widest, displayWidth(c.text) + (note ? 1 + note : 0));
  }
  // Past the text, the room `row` keeps before the note, a space and the border.
  return indent(choices) + widest + 4;
}
/** Draws `choices` in `b`, a row each inside its border, under `heading`'s row when there is one. */
export function draw(w: Writer, b: Rect, choices: Choice[], heading?: Heading): void {
  const border = new Style({ fg: "line", bg: "surface" }).sgr();
  for (let y = 0; y < b.h; y++) {
    w.write(`\x1b[${b.y + y + 1};${b.x + 1}H${border}`);
    w.write(y === 0 ? "╭" : y === b.h - 1 ? "╰" : "│");
    if (y === 0 || y === b.h - 1) w.write("─".repeat(b.w - 2));
    else w.splat(" ", b.w - 2);
    w.write(y === 0 ? "╮" : y === b.h - 1 ? "╯" : "│");
  }
  if (heading) {
    const line = b.y + 2,
      right = b.x + b.w - 2 - displayWidth(heading.note);
    w.write(`\x1b[${line};${b.x + 1 + indent(choices)}H${fg("faint")}`);
    writeEllipsis(w, heading.text, sat(sat(right, b.x + indent(choices)), 2));
    w.write(`\x1b[${line};${right + 1}H${heading.note}`);
  }
  choices.forEach((choice, i) => row(w, b, i + (heading ? 2 : 1), choice, indent(choices)));
  w.write("\x1b[0m");
}
/** The choice under (x, y) inside `b`'s border, or null; a heading row is no choice. */
export function hit(b: Rect, count: number, x: number, y: number, heading = false): number | null {
  if (x <= b.x || x + 1 >= b.x + b.w || y <= b.y || y + 1 >= b.y + b.h) return null;
  const index = y - b.y - (heading ? 2 : 1);
  return index >= 0 && index < count ? index : null;
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
  const faint = choice.hovered ? "muted" : choice.dim ? "line" : "faint";
  w.write(`\x1b[${line};${right + 1}H`);
  if (choice.runs) for (const [part, token] of choice.runs) w.write(fg(token === "faint" ? faint : token) + part);
  else w.write(fg(faint) + choice.note);
  w.write(style);
  w.write(`\x1b[${line};${b.x + 1 + indent}H`);
  writeEllipsis(w, choice.text, sat(sat(right, b.x + indent), 2));
}
