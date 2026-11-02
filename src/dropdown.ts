//! A dropdown: a bordered box on `surface` with a row per choice, ✓ on the
//! current one and a faint note at the right edge; the hovered row takes
//! `selected`; a dim one steps back while something else has the keyboard.
//! A choice with a key shows it as a keycap where ✓ goes. Faint column
//! headings may sit over the choices, and a note may color its runs.
//! The sidebar's agent scope, Corgi setup's summaries, the launcher's
//! worktrees and the review panel's commits open one.
import { Style, fg, fgRgb, keycap, type Token, type Rgb } from "./palette";
import * as palette from "./palette";
import { Rect } from "./layout";
import { Writer, displayWidth, writeEllipsis, sat } from "./text";

/** Part of a note in its own color. */
export type Run = [string, Token];
export function sameRuns(a: Run[], b: Run[]): boolean {
  return a.length === b.length && a.every(([text, token], i) => text === b[i][0] && token === b[i][1]);
}
export interface Choice {
  preview?: Rgb[];
  color?: Rgb;
  text: string;
  note: string;
  detail?: string;
  /** `note` split into runs of their own colors. */
  runs?: Run[];
  current: boolean;
  hovered: boolean;
  key?: string;
  dim?: boolean;
  /** A non-selectable section heading inside a grouped menu. */
  heading?: boolean;
  /** Tree depth, with four cells per level. */
  depth?: number;
  /** Visual indentation in cells, independent of sticky parent depth. */
  inset?: number;
  branch?: "├" | "╰";
  pin?: boolean;
  heading_tone?: Token;
  /** Explanations follow the label rather than the aligned account column. */
  inline_note?: boolean;
}
/** Headings over the choices' text and over their notes. */
export interface Heading {
  text: string;
  note: string;
  detail?: string;
}
/** A scroll window with its current section headings pinned above the rows. */
export function viewport(
  choices: readonly Pick<Choice, "heading" | "depth" | "pin">[],
  first: number,
  selected: number,
  capacity: number,
): { first: number; indices: number[] } {
  if (!choices.length || capacity <= 0) return { first: 0, indices: [] };
  selected = Math.max(0, Math.min(selected, choices.length - 1));
  const rowsAt = (start: number): number[] => {
    const parents: number[] = [];
    let depth = choices[start].depth ?? 0;
    for (let i = start - 1; i >= 0 && depth > 0; i--) {
      const choice = choices[i],
        level = choice.depth ?? 0;
      if (choice.heading && level < depth) {
        parents.unshift(i);
        depth = level;
      }
    }
    let context = parents;
    const root = parents[0];
    if (root !== undefined && (choices[root].depth ?? 0) === 0) {
      for (let i = root + 1; i < start; i++) {
        if (choices[i].heading && (choices[i].depth ?? 0) === 0) break;
        if (!choices[i].pin) continue;
        let container = i - 1;
        while (container > root && !(choices[container].heading && choices[container].depth === 1)) container--;
        context = [...new Set([root, container, i, ...parents])];
        break;
      }
    }
    const pinned = capacity > 1 ? context.slice(-(capacity - 1)) : [];
    return pinned.concat(
      Array.from({ length: Math.min(capacity - pinned.length, choices.length - start) }, (_, i) => start + i),
    );
  };
  first = Math.max(0, Math.min(first, selected, choices.length - 1));
  let indices = rowsAt(first);
  while (!indices.includes(selected) && first < selected) indices = rowsAt(++first);
  while (indices.length < capacity && first > 0) {
    const previous = rowsAt(first - 1);
    if (!previous.includes(selected)) break;
    first--;
    indices = previous;
  }
  return { first, indices };
}
/** Columns from the left border to the text: past a keycap when any choice has one. */
function indent(choices: Choice[]): number {
  return choices.some(c => c.key) ? 5 : 4;
}
/** The width that fits every choice's text, and its note three cells on. */
export function width(choices: Choice[], heading?: Heading): number {
  let widest = 0;
  for (const c of heading ? [...choices, { ...heading, depth: 0, inset: 0 }] : choices) {
    const note = displayWidth(c.note);
    const detail = c.detail ? displayWidth(c.detail) + 2 : 0;
    widest = Math.max(widest, displayWidth(c.text) + (c.inset ?? (c.depth ?? 0) * 4) + (note ? 1 + note : 0) + detail);
  }
  // Past the text, the room `row` keeps before the note, a space and the border.
  return indent(choices) + widest + 4;
}
/** Draws `choices` in `b`, under `heading` when present. `note_column` aligns
 * notes past that many cells of text and a two-cell gap. */
export function draw(
  w: Writer,
  b: Rect,
  choices: Choice[],
  heading?: Heading,
  note_column?: number,
  detail_column?: number,
): void {
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
    if (heading.detail && detail_column !== undefined) {
      const x = b.x + indent(choices) + detail_column;
      w.write(`\x1b[${line};${x + 1}H` + fg("faint"));
      writeEllipsis(w, heading.detail, Math.max(0, b.x + b.w - 2 - x));
    }
  }
  choices.forEach((choice, i) => row(w, b, i + (heading ? 2 : 1), choice, indent(choices), note_column, detail_column));
  w.write("\x1b[0m");
}
/** The choice under (x, y) inside `b`'s border, or null; a heading row is no choice. */
export function hit(b: Rect, count: number, x: number, y: number, heading = false): number | null {
  if (x <= b.x || x + 1 >= b.x + b.w || y <= b.y || y + 1 >= b.y + b.h) return null;
  const index = y - b.y - (heading ? 2 : 1);
  return index >= 0 && index < count ? index : null;
}
export function row(
  w: Writer,
  b: Rect,
  y: number,
  choice: Choice,
  indent = 4,
  note_column?: number,
  detail_column?: number,
): void {
  const inset = choice.inset ?? (choice.depth ?? 0) * 4;
  if (choice.heading && note_column === undefined) {
    const line = b.y + y + 1,
      room = b.w - indent - inset - 4;
    w.write(`\x1b[${line};${b.x + 1 + indent + inset}H` + fg("faint"));
    writeEllipsis(w, choice.text + (choice.note ? " · " + choice.note : ""), room);
    return;
  }
  const style = choice.heading
    ? new Style({ fg: choice.heading_tone ?? "muted", bg: "surface", bold: true }).sgr()
    : choice.hovered
      ? new Style({ fg: "strong", bg: "selected" }).sgr()
      : new Style({ fg: choice.dim ? "faint" : "text", bg: "surface" }).sgr();
  const line = b.y + y + 1;
  w.write(`\x1b[${line};${b.x + 2}H${style}`);
  w.splat(" ", b.w - 2);
  if (choice.branch)
    w.write(`\x1b[${line};${b.x + indent + 1}H` + fg(choice.hovered ? "muted" : "faint") + choice.branch + style);
  if (choice.current)
    w.write(
      `\x1b[${line};${b.x + 3 + (choice.branch ? 0 : inset)}H` + fg(choice.dim ? "faint" : "strong") + `✓${style}`,
    );
  else if (choice.key) w.write(`\x1b[${line};${b.x + 2}H${keycap} ${choice.key} ${style}`);
  if (note_column !== undefined) {
    const x = b.x + indent + inset,
      right = b.x + b.w - 2,
      note_x = choice.inline_note ? Math.min(right, x + displayWidth(choice.text) + 2) : b.x + indent + note_column + 2,
      detail_x = detail_column === undefined ? right : b.x + indent + detail_column;
    w.write(`\x1b[${line};${x + 1}H` + style);
    writeEllipsis(w, choice.text, Math.max(0, (choice.note ? note_x - 2 : right) - x));
    if (choice.note) {
      w.write(`\x1b[${line};${note_x + 1}H\x1b[22m` + fg(choice.hovered ? "muted" : "faint"));
      writeEllipsis(w, choice.note, Math.max(0, (choice.detail ? detail_x - 2 : right) - note_x));
    }
    if (choice.detail && detail_column !== undefined) {
      w.write(`\x1b[${line};${detail_x + 1}H\x1b[22m` + fg(choice.hovered ? "muted" : "faint"));
      writeEllipsis(w, choice.detail, Math.max(0, right - detail_x));
    }
    return;
  }
  const room = Math.max(0, b.w - indent - inset - 4),
    note_room = Math.max(0, room - Math.min(displayWidth(choice.text), Math.ceil(room / 2)) - 2),
    right = b.x + b.w - 2 - Math.min(displayWidth(choice.note), note_room);
  // Faint is too dim on the hovered row's selected background.
  const faint = choice.hovered ? "muted" : choice.dim ? "line" : "faint";
  w.write(`\x1b[${line};${right + 1}H`);
  if (displayWidth(choice.note) > note_room) {
    w.write(fg(faint));
    writeEllipsis(w, choice.note, note_room);
  } else if (choice.runs)
    for (const [part, token] of choice.runs) w.write(fg(token === "faint" ? faint : token) + part);
  else w.write(fg(faint) + choice.note);
  w.write(style);
  w.write(`\x1b[${line};${b.x + 1 + indent + inset}H`);
  const available = sat(sat(right, b.x + indent + inset), 2);
  if (choice.preview && choice.preview.length > 1) {
    const labelWidth = Math.min(14, available);
    writeEllipsis(w, choice.text, labelWidth);
    w.write(" ".repeat(Math.max(0, labelWidth - displayWidth(choice.text))));
    palette.chips(w, choice.preview, available - labelWidth, palette.colors[choice.hovered ? "selected" : "surface"]);
    return;
  }
  let used = choice.preview
    ? palette.chips(
        w,
        choice.preview,
        Math.max(0, available - Math.min(displayWidth(choice.text), 14) - 1),
        palette.colors[choice.hovered ? "selected" : "surface"],
      )
    : 0;
  if (used) {
    w.write(" ");
    used++;
  }
  if (choice.color) w.write(fgRgb(choice.color));
  writeEllipsis(w, choice.text, Math.max(0, available - used));
}
