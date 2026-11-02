//! The conversations a prompt reply lists, drawn as the launcher's Resume
//! rows: brand, title, where, what you last said and when. The model names
//! them in a ```conversations block, `PROVIDER SESSION` a line, and a click
//! opens one. A long list keeps its height, scrolls inside it and searches.
import * as launcherResume from "./launcher_resume";
import type { Context, Entry, Line } from "./launcher_resume";
import * as palette from "./palette";
import { Provider } from "./providers";
import type { Marks } from "./provider_mark";
import { Writer, clamp, sat, writeEllipsis } from "./text";

/** The fence a reply lists conversations in. */
export const fence = "conversations";
/** Whether `line` opens a list. */
export function opens(line: string): boolean {
  return /^\s*```\s*conversations\s*$/.test(line);
}
/** Rows a list shows before it scrolls. */
export const shown_rows = 6;
/** Columns before a row's title: the gutter, the brand mark and its name. */
const title_x = 14;

export type Ref = { provider: Provider; session: string };
/** The conversations a block names, once each: `PROVIDER SESSION` a line,
 * after a bullet or a number, with anything after the session ignored. */
export function refs(lines: string[]): Ref[] {
  const out: Ref[] = [];
  for (const line of lines) {
    const [name, session] = line
      .replace(/^\s*(?:[-*]|\d+[.)])\s+/, "")
      .trim()
      .split(/\s+/);
    const provider = Provider.parse(name);
    if (!provider || !session || out.some(r => r.provider === provider && r.session === session)) continue;
    out.push({ provider, session });
  }
  return out;
}
/** Where each conversation is in a history, by `provider:session`. */
const places = new WeakMap<Entry[], Map<string, number>>();
function place(c: Context, r: Ref): number {
  let index = places.get(c.history.entries);
  if (!index) {
    index = new Map(c.history.entries.map((e, i) => [`${e.provider}:${e.session}`, i]));
    places.set(c.history.entries, index);
  }
  return index.get(`${r.provider}:${r.session}`) ?? -1;
}
/** What a press on one of its rows does. */
export type Press = { open: Entry } | "search" | null;

/** One list in a reply, and what the user did to it, kept from draw to draw. */
export class List {
  readonly view = new launcherResume.View({ expanded: true, scope: "everywhere", ground: "bg" });
  /** The conversation under the pointer, by its place in `lines`. */
  hovered: number | null = null;
  constructor(public refs: Ref[]) {}
  /** It scrolls and searches. */
  long(): boolean {
    return this.refs.length > shown_rows;
  }
  /** Thread rows it takes, the same however the search goes: the search
   * line when long, the headings, and its rows. */
  height(): number {
    return (this.long() ? 2 : 1) + clamp(this.refs.length, 1, shown_rows);
  }
  /** The rows its conversations take before the list's own. */
  private top(): number {
    return this.long() ? 2 : 1;
  }
  /** Its conversations as the launcher's rows, in the reply's order: the
   * ones Corgi knows that the search leaves, an open one as open. */
  lines(c: Context): Line[] {
    const out: Line[] = [];
    for (const r of this.refs) {
      const i = place(c, r);
      if (i < 0 || !this.view.matches(c.history.entries[i])) continue;
      out.push(c.opened(c.history.entries[i]) ? { open: i } : { entry: i });
    }
    return out;
  }
  /** The first of `lines` shown: the selection's while the list has the
   * keyboard, else where the wheel left it. */
  private first(c: Context, lines: Line[]): number {
    const h = this.height() - this.top();
    if (this.view.focused) this.view.scroll = this.view.firstRow(lines, this.view.index(c, lines), h);
    return clamp(this.view.scroll, 0, Math.max(0, lines.length - h));
  }
  scroll(c: Context, down: boolean): void {
    const lines = this.lines(c),
      h = this.height() - this.top();
    this.view.scroll = clamp(this.first(c, lines) + (down ? 1 : -1), 0, Math.max(0, lines.length - h));
  }
  /** Moves the selection; false when it can't go that way. */
  move(c: Context, delta: number): boolean {
    const lines = this.lines(c),
      at = this.view.index(c, lines);
    if (at === null || (delta < 0 && at === 0) || (delta > 0 && at === lines.length - 1)) return false;
    this.view.move(c, lines, delta);
    return true;
  }
  /** Selects the last conversation it shows. */
  end(c: Context): void {
    this.view.move(c, this.lines(c), Number.MAX_SAFE_INTEGER);
  }
  selected(c: Context): Entry | null {
    return this.view.entry(c, this.lines(c));
  }
  /** The thread row of the selection, counted from the list's first. */
  selectedRow(c: Context): number {
    const lines = this.lines(c),
      at = this.view.index(c, lines);
    return at === null ? 0 : this.top() + at - this.first(c, lines);
  }
  /** What row `k` holds, and so what a press there does. */
  press(c: Context, k: number): Press {
    if (this.long() && k === 0) return "search";
    const lines = this.lines(c),
      at = this.first(c, lines) + k - this.top();
    if (k < this.top() || at >= lines.length) return null;
    this.view.pick(c, lines, at);
    return { open: this.view.entry(c, lines)! };
  }
  /** The pointer is over row `k`, or off the list at -1; true when that changed. */
  hover(c: Context, k: number): boolean {
    const lines = this.lines(c),
      at = this.first(c, lines) + k - this.top(),
      hovered = k >= this.top() && at < lines.length ? at : null;
    if (hovered === this.hovered) return false;
    this.hovered = hovered;
    return true;
  }
  /** Draws row `k` at terminal row `y`, both 1-based, across a card whose
   * left border is at column `x` and is `width` wide, as the launcher's are;
   * its search shows `cap`, the key that reaches it. */
  draw(w: Writer, c: Context, k: number, x: number, y: number, width: number, marks: Marks | null, cap: string): void {
    const view = this.view,
      lines = this.lines(c),
      cols = view.columns(sat(width, 4)),
      shown = this.height() - this.top();
    if (this.long() && k === 0) {
      const total = this.refs.filter(r => place(c, r) >= 0).length;
      view.drawSearch(w, x, y, width, view.search() ? `${lines.length} of ${total}` : "", null, cap);
      return;
    }
    if (k === this.top() - 1) return view.drawHeadings(w, x, y, width, cols);
    const first = this.first(c, lines),
      row = k - this.top(),
      at = first + row;
    if (at < lines.length) {
      const selected = view.focused ? view.index(c, lines) === at : this.hovered === at;
      view.drawLine(w, c, lines, at, selected, launcherResume.startsRun(c, lines, at, first), x, y, width, cols, marks);
    } else if (row === 0) {
      w.write(`\x1b[${y};${x + title_x}H` + palette.fg("faint"));
      const note = view.search()
        ? "No matches."
        : c.history.pending
          ? "Reading conversations…"
          : "Corgi doesn't know these conversations.";
      writeEllipsis(w, note, sat(width, title_x + 3));
    }
    const cell = view.track(row, shown, lines.length, first);
    if (cell) w.write(`\x1b[${y};${x + width - 2}H${cell}`);
  }
}
