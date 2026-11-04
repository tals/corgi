//! The Corgi prompt's memory, browsed and edited in its card: each file
//! under a heading (MEMORY.md, today's log, the workspace notes, then older
//! logs), a search across them all, and a line edited, added or deleted in
//! place. An edit applies only while the line still reads as shown, since the
//! model writes to the same files; the list reads them again every second.
import * as keys from "./keys";
import { Style, fg, keycap, type Token } from "./palette";
import type { Rect } from "./layout";
import type { Group, Memory } from "./prompt_memory";
import { matches } from "./search";
import { TextArea, Typed, byte_edits, key_edits } from "./text_area";
import { Writer, clamp, displayWidth, ellipsis } from "./text";

/** A list row: a file's heading, one of its lines, or the place for a first
 * line in a file that has none. */
type Row =
  | { kind: "heading"; group: Group }
  | { kind: "line"; group: Group; at: number; text: string }
  | { kind: "empty"; group: Group };
/** What the card does next: close the view, or open a file in the editor. */
export type Result = { kind: "close" } | { kind: "open"; file: string } | null;

const reload_ms = 1000;
const at = (x: number, y: number) => `\x1b[${y + 1};${x + 1}H`;

export class View {
  readonly query = new TextArea("", false);
  /** A character typed into the search or a line, its bytes so far. */
  private typed = new Typed();
  private groups: Group[] = [];
  private rows: Row[] = [];
  /** The highlighted row: a line, or an empty file's place. */
  private index = 0;
  private first = 0;
  /** The line being written: a line's new text, or one more for a file;
   * `back` is the row highlighted before, for a cancel. */
  private editing: { row: Row; area: TextArea; back: Row | undefined } | null = null;
  /** Delete pressed once on the highlighted line; again deletes it. */
  private deleting = false;
  /** A search is open: `/` or typing opened it, and keys go to it. */
  private searching = false;
  /** What the last edit said, shown in place of the hints. */
  private said = "";
  private read_at = 0;
  /** Rows the list showed last, for the pointer and paging. */
  private shown = { y: 0, rows: 0 };
  constructor(
    private memory: Memory,
    private workspace: string | null,
    private clock: () => number,
  ) {
    this.reload();
  }
  /** Lines in every file, for the heading. */
  count(): number {
    return this.groups.reduce((n, g) => n + g.lines.length, 0);
  }
  /** Reads the files again, keeping the highlight on the same line. */
  reload(): void {
    const was = this.rows[this.index];
    this.groups = this.memory.groups(new Date(this.clock()), this.workspace);
    this.read_at = this.clock();
    this.layout(was);
  }
  key(byte: number): Result {
    this.said = "";
    if (this.editing) return this.edit(byte);
    // Any key but a delete itself takes back an asked delete; Esc does only that.
    const deleting = this.deleting;
    this.deleting = false;
    // Out of a search, Backspace deletes the highlighted line, pressed twice;
    // in one, Backspace on nothing typed leaves it, as the model picker's does.
    if (byte === 127 || byte === 8) {
      if (!this.searching) {
        this.deleting = deleting;
        this.remove();
      } else if (!this.query.text) this.leave();
      else {
        this.query.apply("backspace");
        this.layout(this.rows[this.index]);
      }
      return null;
    }
    switch (byte) {
      case 27:
        if (deleting) return null;
        if (!this.searching) return { kind: "close" };
        this.leave();
        return null;
      case 13: {
        const row = this.rows[this.index];
        if (row?.kind === "line") this.editing = { row, area: new TextArea(row.text, false), back: row };
        else if (row?.kind === "empty") this.add();
        return null;
      }
      case 9:
        this.add();
        return null;
      case 5: {
        const row = this.rows[this.index];
        return row ? { kind: "open", file: row.group.file } : null;
      }
      case 14:
      case 16:
        this.move(byte === 14 ? 1 : -1);
        return null;
    }
    // `/` starts a search, and so does typing.
    if (!this.searching) {
      if (byte <= 32 || byte === 127) return null;
      this.searching = true;
      if (byte === 47) return null;
    }
    const edit = byte_edits[byte],
      text = !edit && byte >= 32 ? this.typed.take(byte) : null;
    if (edit) this.query.apply(edit);
    else if (text) this.query.insert(text);
    else return null;
    this.layout(this.rows[this.index]);
    return null;
  }
  /** Ends the search, every line back. */
  private leave(): void {
    this.searching = false;
    this.query.text = "";
    this.query.caret = 0;
    this.layout(this.rows[this.index]);
  }
  sequence(text: string): Result {
    this.said = "";
    const key = keys.parse(text);
    if (this.editing) {
      const edit = key && key_edits[key];
      if (edit) this.editing.area.apply(edit);
      return null;
    }
    if (key !== "delete") this.deleting = false;
    switch (key) {
      case "up":
      case "down":
        this.move(key === "down" ? 1 : -1);
        return null;
      case "page_up":
      case "page_down":
        this.move((key === "page_down" ? 1 : -1) * Math.max(1, this.shown.rows - 1));
        return null;
      case "delete":
        if (!this.searching) {
          this.remove();
          return null;
        }
    }
    const edit = this.searching && key && key_edits[key];
    if (edit) {
      this.query.apply(edit);
      this.layout(this.rows[this.index]);
    }
    return null;
  }
  paste(text: string): void {
    const flat = text.replace(/\s+/g, " ");
    if (this.editing) this.editing.area.insert(flat);
    else {
      this.searching = true;
      this.query.insert(flat);
      this.layout(this.rows[this.index]);
    }
  }
  scroll(down: boolean): void {
    this.first = clamp(this.first + (down ? 3 : -3), 0, Math.max(0, this.rows.length - this.shown.rows));
  }
  /** A press at (`x`, `y`) highlights the row under it. */
  click(_x: number, y: number): void {
    const index = this.first + y - this.shown.y;
    if (y < this.shown.y || index >= this.rows.length || this.rows[index].kind === "heading") return;
    this.editing = null;
    this.index = index;
  }
  draw(w: Writer, b: Rect): void {
    if (!this.editing && this.clock() - this.read_at >= reload_ms) this.reload();
    const text = new Style({ fg: "text", bg: "bg" }).sgr(),
      field = new Style({ fg: "text", bg: "selected" }).sgr();
    // The search field, as the model picker's: a `/` keycap, then the query
    // and its caret while searching, and how many lines there are or match.
    w.write(at(b.x, b.y) + field);
    w.splat(" ", b.w);
    w.write(at(b.x, b.y) + keycap + " / " + field + " ");
    const total = this.count(),
      count = this.searching
        ? `${this.rows.filter(r => r.kind === "line").length} of ${total}`
        : `${total} line${total === 1 ? "" : "s"}`,
      room = b.w - 5 - displayWidth(count) - 2;
    if (this.searching) w.write(ellipsis(this.query.text, room - 1) + "\x1b[7m \x1b[27m");
    if (!this.query.text) w.write(fg("muted") + ellipsis("Search memory", room - 1));
    w.write(at(b.x + b.w - 1 - displayWidth(count), b.y) + fg("muted") + count);
    const list_y = b.y + 2,
      list_h = Math.max(1, b.h - 4);
    this.shown = { y: list_y, rows: list_h };
    this.first = clamp(this.first, this.index - list_h + 1, this.index);
    this.first = clamp(this.first, 0, Math.max(0, this.rows.length - list_h));
    for (let i = 0; i < list_h; i++) {
      const row = this.rows[this.first + i],
        y = list_y + i;
      w.write(at(b.x, y) + text);
      w.splat(" ", b.w);
      if (row) this.drawRow(w, b, y, row, this.first + i === this.index);
    }
    if (!this.rows.length)
      w.write(at(b.x + 2, list_y) + fg("muted") + (this.query.text ? "No line holds those words." : "Nothing yet."));
    // What the last edit said, else what the keys do.
    const hints: [string, string][] = this.editing
      ? [
          ["⏎", "save"],
          ["esc", "cancel"],
        ]
      : this.deleting
        ? [
            ["⌫", "again deletes"],
            ["esc", "keeps it"],
          ]
        : this.searching
          ? [
              ["⏎", "edit"],
              ["⇥", "add"],
              ["esc", "end search"],
            ]
          : [
              ["⏎", "edit"],
              ["⇥", "add"],
              ["⌫", "delete"],
              ["/", "search"],
              ["ctrl+e", "editor"],
              ["esc", "back"],
            ];
    w.write(at(b.x, b.y + b.h - 1) + text);
    w.splat(" ", b.w);
    if (this.said) w.write(at(b.x, b.y + b.h - 1) + fg("warm") + ellipsis(this.said, b.w));
    else {
      let line = "";
      for (const [k, label] of hints) {
        const next = `${line ? "   " : ""}\x1b[1m${fg("text")}${k}\x1b[22m ${fg("faint")}${label}`;
        if (displayWidth((line + next).replace(/\x1b\[[0-9;:]*m/g, "")) > b.w) break;
        line += next;
      }
      w.write(at(b.x, b.y + b.h - 1) + line);
    }
  }
  private drawRow(w: Writer, b: Rect, y: number, row: Row, on: boolean): void {
    const bg = on ? "selected" : "bg",
      style = (token: Token, bold = false) => new Style({ fg: token, bg, bold }).sgr();
    switch (row.kind) {
      case "heading": {
        const note = `${row.group.loaded ? "loaded" : "not loaded"} · ${row.group.lines.length}`;
        w.write(at(b.x, y) + style("strong", true) + ellipsis(row.group.title, b.w - displayWidth(note) - 2));
        w.write(at(b.x + b.w - displayWidth(note), y) + style("faint") + note);
        return;
      }
      case "empty":
        w.write(at(b.x, y) + style("text"));
        w.splat(" ", b.w);
        if (this.editing?.row === row) return this.drawEditor(w, b, y);
        w.write(at(b.x + 2, y) + style("faint") + "nothing here yet · ⇥ adds a line");
        return;
      case "line":
        w.write(at(b.x, y) + style("text"));
        w.splat(" ", b.w);
        if (this.editing?.row === row) return this.drawEditor(w, b, y);
        w.write(at(b.x, y) + style("faint") + "  · " + style(on ? "strong" : "text") + ellipsis(row.text, b.w - 4));
    }
  }
  /** The line being written, its end in view, with its caret. */
  private drawEditor(w: Writer, b: Rect, y: number): void {
    const area = this.editing!.area,
      room = b.w - 5;
    // Whole characters only: an emoji is two UTF-16 units.
    let start = 0;
    while (displayWidth(area.text.slice(start, area.caret)) >= room)
      start += String.fromCodePoint(area.text.codePointAt(start)!).length;
    const shown = area.text.slice(start);
    w.write(at(b.x, y) + new Style({ fg: "accent", bg: "selected", bold: true }).sgr() + "  › ");
    w.write(new Style({ fg: "strong", bg: "selected" }).sgr());
    const caret = area.caret - start,
      point = shown.codePointAt(caret),
      under = point === undefined ? "" : String.fromCodePoint(point);
    w.write(ellipsis(shown.slice(0, caret), room) + "\x1b[7m" + (under || " ") + "\x1b[27m");
    w.write(ellipsis(shown.slice(caret + under.length), Math.max(0, room - displayWidth(shown.slice(0, caret)) - 1)));
  }
  private edit(byte: number): Result {
    const e = this.editing!;
    if (byte === 27) {
      this.editing = null;
      this.layout(e.back);
      return null;
    }
    if (byte !== 13) {
      const edit = byte_edits[byte];
      const text = !edit && byte >= 32 ? this.typed.take(byte) : null;
      if (edit) e.area.apply(edit);
      else if (text) e.area.insert(text);
      return null;
    }
    this.editing = null;
    const text = e.area.text.trim();
    if (e.row.kind === "line") {
      // Emptied, it goes; changed meanwhile, it stays as the file has it.
      if (!this.memory.edit(e.row.group.file, e.row.at, e.row.text, text || null))
        this.said = "That line changed meanwhile; it reads as the file has it now.";
    } else if (text) this.memory.append(e.row.group.file, text);
    this.reload();
    if (e.row.kind !== "line" && text) this.select(e.row.group.file, -1);
    return null;
  }
  /** Starts a new line in the highlighted row's file. */
  private add(): void {
    const row = this.rows[this.index];
    if (!row) return;
    const group = row.group;
    // It's written where the file's last line, or its empty place, shows.
    const last = this.rows.findLastIndex(r => r.group === group && r.kind !== "heading");
    const place: Row = { kind: "empty", group };
    this.rows.splice(last + 1, 0, place);
    this.index = last + 1;
    this.editing = { row: place, area: new TextArea("", false), back: row };
  }
  /** Backspace or Delete once asks; again deletes the highlighted line. */
  private remove(): void {
    const row = this.rows[this.index];
    if (row?.kind !== "line") return;
    if (!this.deleting) {
      this.deleting = true;
      return;
    }
    this.deleting = false;
    if (!this.memory.edit(row.group.file, row.at, row.text, null)) {
      this.said = "That line changed meanwhile; nothing was deleted.";
      return this.reload();
    }
    const at = this.index;
    this.reload();
    // The highlight stays where the line was: on the next one, or at a
    // file's end, on the one before.
    this.index = clamp(at, 0, Math.max(0, this.rows.length - 1));
    if (this.rows[this.index]?.kind === "heading")
      this.index = this.index > 0 && this.rows[this.index - 1].kind !== "heading" ? this.index - 1 : this.index + 1;
  }
  private move(step: number): void {
    const n = this.rows.length;
    if (!n) return;
    let i = clamp(this.index + step, 0, n - 1);
    // Headings are passed over in the direction of travel, else the other way.
    while (this.rows[i]?.kind === "heading" && i > 0 && i < n - 1) i += Math.sign(step) || 1;
    if (this.rows[i]?.kind === "heading") i = this.rows.findIndex(r => r.kind !== "heading");
    if (i >= 0) this.index = i;
  }
  /** Highlights line `at` of `file`, or its last line for -1. */
  private select(file: string, line: number): void {
    const found =
      line < 0
        ? this.rows.findLastIndex(r => r.group.file === file && r.kind === "line")
        : this.rows.findIndex(r => r.kind === "line" && r.group.file === file && r.at === line);
    if (found >= 0) this.index = found;
  }
  /** The rows the search leaves, with the highlight on `was`'s line if it's still there. */
  private layout(was: Row | undefined): void {
    const q = this.query.text.trim(),
      rows: Row[] = [];
    for (const group of this.groups) {
      const lines = group.lines.filter(l => !q || matches(q, l.text));
      if (q && !lines.length) continue;
      rows.push({ kind: "heading", group });
      for (const l of lines) rows.push({ kind: "line", group, at: l.at, text: l.text });
      if (!lines.length) rows.push({ kind: "empty", group });
    }
    this.rows = rows;
    const same =
      was &&
      rows.findIndex(
        r =>
          r.kind === was.kind &&
          r.group.file === was.group.file &&
          (r.kind !== "line" || (was.kind === "line" && r.at === was.at && r.text === was.text)),
      );
    this.index = same !== undefined && same >= 0 ? same : rows.findIndex(r => r.kind !== "heading");
    if (this.index < 0) this.index = 0;
  }
}
