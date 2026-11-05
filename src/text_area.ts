//! A text box's text, caret and selection, edited the way text boxes are, by
//! character, word and line, with the same keys in every box Corgi has.
//! Offsets count UTF-16 units and never split a character. A multi-line box
//! wraps between words at `width` columns, and up, down, home and end follow
//! the lines as shown.
import type * as keys from "./keys";
import { codepointWidth } from "./text";

export type Move = "left" | "right" | "up" | "down" | "word_left" | "word_right" | "line_start" | "line_end";
export type Erase = "back" | "forward" | "word_back" | "word_forward" | "line_back" | "line_forward";
/** What a key does to a text box. */
export type Edit =
  | Move
  | `select_${Move}`
  | "select_all"
  | "backspace"
  | "delete"
  | "word_backspace"
  | "word_delete"
  | "line_backspace"
  | "line_delete"
  | "cut"
  | "newline";
const erases: Partial<Record<Edit, Erase>> = {
  backspace: "back",
  delete: "forward",
  word_backspace: "word_back",
  word_delete: "word_forward",
  line_backspace: "line_back",
  line_delete: "line_forward",
};
const moves = new Set<string>(["left", "right", "up", "down", "word_left", "word_right", "line_start", "line_end"]);
/** Control bytes every text box reads as edits. Ghostty sends ctrl+a, ctrl+e
 * and ctrl+u for cmd+←, cmd+→ and cmd+backspace. */
export const byte_edits: Partial<Record<number, Edit>> = {
  1: "line_start",
  5: "line_end",
  8: "backspace",
  11: "line_delete",
  21: "line_backspace",
  23: "word_backspace",
  127: "backspace",
};
/** A character typed a byte at a time, whole once its UTF-8 bytes are. */
export class Typed {
  private bytes: number[] = [];
  /** The character `byte` completes: null while one is partial, and for a stray byte. */
  take(byte: number): string | null {
    if (byte < 0x80) {
      this.bytes = [];
      return String.fromCharCode(byte);
    }
    if (byte >= 0xc0) this.bytes = [];
    else if (!this.bytes.length) return null;
    this.bytes.push(byte);
    const lead = this.bytes[0],
      size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : 2;
    if (this.bytes.length < size) return null;
    const text = new TextDecoder().decode(new Uint8Array(this.bytes.splice(0)));
    return text.includes("\ufffd") ? null : text;
  }
}
/** Keys every text box reads as edits. */
export const key_edits: Partial<Record<keys.Key, Edit>> = {
  left: "left",
  right: "right",
  up: "up",
  down: "down",
  home: "line_start",
  end: "line_end",
  delete: "delete",
  shift_up: "select_up",
  shift_down: "select_down",
  shift_left: "select_left",
  shift_right: "select_right",
  shift_home: "select_line_start",
  shift_end: "select_line_end",
  shift_alt_left: "select_word_left",
  shift_alt_right: "select_word_right",
  shift_ctrl_left: "select_word_left",
  shift_ctrl_right: "select_word_right",
  shift_super_left: "select_line_start",
  shift_super_right: "select_line_end",
  alt_left: "word_left",
  alt_right: "word_right",
  alt_b: "word_left",
  alt_f: "word_right",
  ctrl_left: "word_left",
  ctrl_right: "word_right",
  super_left: "line_start",
  super_right: "line_end",
  alt_backspace: "word_backspace",
  alt_delete: "word_delete",
  alt_d: "word_delete",
  ctrl_delete: "word_delete",
  alt_enter: "newline",
  super_a: "select_all",
  super_x: "cut",
};
/** Whether `name` is an edit. */
export function isEdit(name: string): name is Edit {
  return moves.has(name.replace(/^select_/, "")) || name in erases || ["select_all", "cut", "newline"].includes(name);
}
/** A line as shown: `[start, end)` of the text, without the break that ends it. */
export interface Line {
  start: number;
  end: number;
}

const word = /[\p{L}\p{N}_]/u;
const columns = (ch: string) => Math.max(0, codepointWidth(ch.codePointAt(0)!));

export class TextArea {
  text: string;
  /** Whether Enter-like edits break the line; a single-line box is one line however wide. */
  readonly multiline: boolean;
  caret: number;
  /** Where a selection started; the caret is its other end. */
  anchor: number | null = null;
  /** Columns the lines wrap at, as last drawn. */
  width = 40;
  /** Columns the first line leaves to what's drawn before it, such as
   * attachments; the lines after it start at the left. */
  lead = 0;
  /** The column up and down keep to across short lines. */
  private goal: number | null = null;

  constructor(text = "", multiline = true) {
    this.text = text;
    this.multiline = multiline;
    this.caret = text.length;
  }
  apply(edit: Edit): void {
    const erase = erases[edit];
    if (erase) return this.erase(erase);
    switch (edit) {
      case "select_all":
        [this.anchor, this.caret, this.goal] = [0, this.text.length, null];
        return;
      case "cut":
        if (this.selection()) this.insert("");
        return;
      case "newline":
        if (this.multiline) this.insert("\n");
        return;
      default:
        if (edit.startsWith("select_")) this.move(edit.slice("select_".length) as Move, true);
        else this.move(edit as Move);
    }
  }
  /** The selected text, or "" when nothing is. */
  selectedText(): string {
    const sel = this.selection();
    return sel ? this.text.slice(...sel) : "";
  }
  /** The selected `[start, end)`, or null when nothing is. */
  selection(): [number, number] | null {
    if (this.anchor === null || this.anchor === this.caret) return null;
    return [Math.min(this.anchor, this.caret), Math.max(this.anchor, this.caret)];
  }
  /** Types `s` over the selection, or at the caret. */
  insert(s: string): void {
    const [start, end] = this.selection() ?? [this.caret, this.caret];
    this.text = this.text.slice(0, start) + s + this.text.slice(end);
    this.caret = start + s.length;
    this.anchor = null;
    this.goal = null;
  }
  /** Moves the caret; with `select`, the selection follows it. */
  move(to: Move, select = false): void {
    const sel = this.selection();
    if (select) this.anchor ??= this.caret;
    else {
      this.anchor = null;
      // A plain left or right lands on the selection's edge.
      if (sel && (to === "left" || to === "right")) {
        this.caret = to === "left" ? sel[0] : sel[1];
        this.goal = null;
        return;
      }
    }
    if (to === "up" || to === "down") return this.vertical(to === "up" ? -1 : 1);
    this.goal = null;
    this.caret = this.target(to);
  }
  /** Deletes the selection, or as far as `what` reaches from the caret. */
  erase(what: Erase): void {
    const sel = this.selection();
    if (sel) return this.insert("");
    const from = this.caret;
    const to =
      what === "back"
        ? this.previous(from)
        : what === "forward"
          ? this.next(from)
          : what === "word_back"
            ? this.target("word_left")
            : what === "word_forward"
              ? this.target("word_right")
              : what === "line_back"
                ? this.target("line_start")
                : this.target("line_end");
    // At a line's edge, the line ones take the break with them.
    const reach =
      to !== from ? to : what === "line_back" ? this.previous(from) : what === "line_forward" ? this.next(from) : to;
    this.anchor = Math.min(from, reach);
    this.caret = Math.max(from, reach);
    this.insert("");
  }
  /** Puts the caret at column `col` of the box on shown line `row`, the
   * first line starting `lead` in; with `select`, the selection follows it. */
  place(row: number, col: number, select = false): void {
    const lines = this.lines(),
      index = Math.min(Math.max(row, 0), lines.length - 1);
    if (select) this.anchor ??= this.caret;
    else this.anchor = null;
    this.goal = null;
    this.caret =
      row < 0 ? 0 : row >= lines.length ? this.text.length : this.offsetAt(lines[index], col - this.leadOf(index));
  }
  /** The caret's shown line and column. */
  position(): { row: number; col: number } {
    const lines = this.lines(),
      row = this.rowOf(lines, this.caret);
    return { row, col: this.span(lines[row].start, this.caret) };
  }
  /** The lines as shown at `width` columns, broken after the last space that fits. */
  lines(width = this.width): Line[] {
    if (!this.multiline) return [{ start: 0, end: this.text.length }];
    const out: Line[] = [];
    let start = 0;
    for (const para of this.text.split("\n")) {
      const end = start + para.length;
      let s = start;
      do {
        const room = Math.max(1, width - this.leadOf(out.length));
        let at = s,
          used = 0,
          space = -1;
        while (at < end) {
          const ch = String.fromCodePoint(this.text.codePointAt(at)!);
          if (used + columns(ch) > room) break;
          if (ch === " ") space = at;
          used += columns(ch);
          at += ch.length;
        }
        if (at >= end) {
          out.push({ start: s, end });
          break;
        }
        if (space > s) {
          out.push({ start: s, end: space });
          s = space + 1;
        } else {
          // A word longer than the line breaks where it must, a character at least.
          const cut = at > s ? at : this.next(s);
          out.push({ start: s, end: cut });
          s = cut;
        }
      } while (s < end);
      start = end + 1;
    }
    return out;
  }
  private vertical(step: -1 | 1): void {
    const lines = this.lines(),
      row = this.rowOf(lines, this.caret);
    // The goal is a column of the box, so the first line's lead counts.
    this.goal ??= this.leadOf(row) + this.span(lines[row].start, this.caret);
    const next = row + step;
    if (next < 0) this.caret = 0;
    else if (next >= lines.length) this.caret = this.text.length;
    else this.caret = this.offsetAt(lines[next], this.goal - this.leadOf(next));
  }
  /** Where shown line `row` starts in the box. */
  leadOf(row: number): number {
    return row === 0 ? this.lead : 0;
  }
  private target(to: Exclude<Move, "up" | "down">): number {
    const t = this.text;
    let at = this.caret;
    switch (to) {
      case "left":
        return this.previous(at);
      case "right":
        return this.next(at);
      case "word_left":
        while (at > 0 && !word.test(this.charBefore(at))) at = this.previous(at);
        while (at > 0 && word.test(this.charBefore(at))) at = this.previous(at);
        return at;
      case "word_right":
        while (at < t.length && !word.test(this.charAt(at))) at = this.next(at);
        while (at < t.length && word.test(this.charAt(at))) at = this.next(at);
        return at;
      case "line_start":
      case "line_end": {
        const lines = this.lines(),
          line = lines[this.rowOf(lines, at)];
        return to === "line_start" ? line.start : line.end;
      }
    }
  }
  /** The last shown line starting at or before `at`: a caret at a wrap
   * without a space starts the next line. */
  private rowOf(lines: Line[], at: number): number {
    let row = 0;
    while (row + 1 < lines.length && lines[row + 1].start <= at) row++;
    return row;
  }
  private offsetAt(line: Line, col: number): number {
    let at = line.start,
      used = 0;
    while (at < line.end) {
      const ch = this.charAt(at);
      if (used + columns(ch) > col) break;
      used += columns(ch);
      at += ch.length;
    }
    return at;
  }
  private span(from: number, to: number): number {
    let used = 0;
    for (const ch of this.text.slice(from, to)) used += columns(ch);
    return used;
  }
  private charAt(at: number): string {
    return String.fromCodePoint(this.text.codePointAt(at)!);
  }
  private charBefore(at: number): string {
    return this.text.slice(this.previous(at), at);
  }
  private previous(at: number): number {
    if (at <= 0) return 0;
    const low = this.text.charCodeAt(at - 1);
    return low >= 0xdc00 && low < 0xe000 && at >= 2 ? at - 2 : at - 1;
  }
  private next(at: number): number {
    if (at >= this.text.length) return this.text.length;
    return at + this.charAt(at).length;
  }
}
