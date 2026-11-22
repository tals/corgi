//! What the file peek and the file pane share: a `Source`'s rows with their
//! line numbers, colored as code or as a log, drawn into a canvas. Its place
//! holds while a log grows, reads earlier lines or drops old ones, and
//! following keeps the newest line in view. Code folds by indentation, and
//! the lines that open the blocks above the top row can stay pinned there.
import { basename } from "node:path";
import { sourceGlyph, type Canvas } from "./canvas";
import type { Source } from "./file_source";
import * as i18n from "./i18n";
import * as logSyntax from "./log_syntax";
import * as palette from "./palette";
import * as syntax from "./review/syntax";
import { codepointWidth } from "./text";

export const tab_width = 4;
/** How far up the opening of a block is looked for. */
const context_reach = 4000;

type Span = [number, number, logSyntax.Kind];
export interface Look {
  /** The background, or null for the terminal's own. */
  bg: palette.Rgb | null;
  /** The drawn row the pointer is over, from 0 at the top. */
  hover?: number | null;
  /** Pin the lines that open the blocks the top row is in. */
  context?: boolean;
  /** Show fold markers before the line numbers. */
  folds?: boolean;
  scrollbar?: boolean;
  /** Columns scrolled right. */
  shift?: number;
}
/** A shown row: a line, or a closed fold from `row` through `to`. */
export interface Shown {
  row: number;
  to?: number;
}
const indentOf = (line: string) => {
  let width = 0;
  for (const ch of line) {
    if (ch === " ") width++;
    else if (ch === "\t") width += tab_width - (width % tab_width);
    else return width;
  }
  return -1;
};
const closer = /^\s*[}\])]+[;,)]*\s*$/;

export class Reader {
  /** The shown row at the top. */
  top = 0;
  private follows = true;
  /** Keeps the newest line in view as a log grows; when off, the source
   * keeps this place rather than the newest lines. */
  get following(): boolean {
    return this.follows;
  }
  set following(on: boolean) {
    this.follows = on;
    this.holdPlace();
  }
  /** Rows a log grew by while not following. */
  fresh = 0;
  /** The row of the line the text named. */
  target: number | null = null;
  /** That line's number, to find its row again after the window moves. */
  private target_line: number | null = null;
  /** The end of the file last asked to go to, until the window is there:
   * a jump that lands after a later one doesn't undo it. */
  private jump: "start" | "end" | null = null;
  readonly column: number | null;
  /** Closed folds, by their first row. */
  folded = new Set<number>();
  readonly lang: string | null;
  readonly log: boolean;
  private highlighter: syntax.Highlighter | null = null;
  private seen = { version: -1, added: 0, prepended: 0, dropped: 0, restarts: 0, rewinds: 0, seeks: 0 };
  private ends: { version: number; map: Map<number, number> } | null = null;
  private shown: { key: string; rows: Shown[] } | null = null;
  private center: number | null;
  constructor(
    readonly source: Source,
    line: number | null = null,
    column: number | null = null,
  ) {
    const name = basename(source.path).toLowerCase();
    this.lang = /\.(?:jsonl|ndjson)$/.test(name) ? "json" : syntax.language(source.path);
    this.log = this.lang === null || (source.mode === "tail" && /\.(?:log|out|err|txt)\b/.test(name));
    this.column = column;
    this.center = line;
    this.following = source.mode === "tail" && line === null;
  }
  /** Catches up with the source and fits `h` rows: keeps the place, follows
   * the end, or centers the line the text named once it's read. */
  sync(h: number): void {
    const s = this.source,
      seen = this.seen;
    if (s.version !== seen.version) {
      const restarted = s.restarts !== seen.restarts,
        sought = s.seeks !== seen.seeks;
      if ((restarted || s.rewinds !== seen.rewinds || sought) && seen.version >= 0) {
        // A new window: its rows are other lines.
        this.target = this.target_line === null ? null : s.rowOf(this.target_line);
        this.fresh = 0;
        if (restarted || sought) this.folded.clear();
        if (sought) {
          // The line asked for was found: it shows in the middle.
          this.center = s.sought;
          this.jump = null;
          this.following = false;
        } else {
          // Where the last jump asked for, else where the window went.
          const to = this.jump ?? (restarted ? "end" : "start");
          if (to === "end") this.following = s.mode === "tail";
          else {
            this.top = 0;
            this.following = false;
          }
          if (to === "end" ? s.atEnd : s.start === 0) this.jump = null;
        }
      } else if (seen.version >= 0) {
        const shift = s.prepended - seen.prepended - (s.dropped - seen.dropped);
        this.top = Math.max(0, this.top + shift);
        if (this.target !== null) this.target = this.target + shift >= 0 ? this.target + shift : null;
        if (!this.following) this.fresh += s.added - seen.added;
      }
      if (s.mode === "code") this.highlighter = this.lang ? new syntax.Highlighter(this.lang, s.lines) : null;
      this.seen = {
        version: s.version,
        added: s.added,
        prepended: s.prepended,
        dropped: s.dropped,
        restarts: s.restarts,
        rewinds: s.rewinds,
        seeks: s.seeks,
      };
    }
    if (this.center !== null) {
      this.target = s.rowOf(this.center);
      this.target_line = this.target === null ? null : this.center;
      this.center = null;
      if (this.target !== null) this.top = this.shownIndex(this.target) - Math.floor((h - 1) / 2);
      // A log whose line wasn't found shows its end.
      else this.following = s.mode === "tail";
    }
    const last = Math.max(0, this.shownRows().length - h);
    if (this.following) {
      this.top = last;
      this.fresh = 0;
    }
    this.top = Math.max(0, Math.min(this.top, last));
    this.holdPlace();
  }
  /** Tells the source the row at the top while not following, which its
   * window keeps as the log grows. */
  private holdPlace(): void {
    this.source.hold = this.follows ? null : (this.shownRows()[this.top]?.row ?? 0);
  }
  /** Moves `by` rows; reaching the end follows it again, and nearing the
   * start of a log's window reads the block before it. */
  scroll(by: number, h: number): void {
    const last = Math.max(0, this.shownRows().length - h);
    this.top = Math.max(0, Math.min(last, this.top + by));
    this.holdPlace();
    if (this.source.mode !== "tail") return;
    if (by < 0) this.following = false;
    else if (this.top >= last && this.source.atEnd) this.follow(true);
    if (this.top < h && this.source.start > 0) void this.source.earlier();
    else if (this.top >= last - h && !this.source.atEnd) void this.source.later();
  }
  /** Follows a log's end, reading it first when the window stops short of it. */
  follow(on: boolean): void {
    this.following = on && this.source.mode === "tail";
    if (!this.following) {
      if (this.jump === "end") this.jump = null;
      return;
    }
    this.fresh = 0;
    // A jump to the start still on its way would leave the window there.
    if (this.source.atEnd && this.jump !== "start") return;
    this.jump = "end";
    void this.source.toEnd();
  }
  /** Goes to the file's first line, reading it first when the window starts after it. */
  home(): void {
    this.top = 0;
    this.following = false;
    if (this.source.mode !== "tail" || (this.source.start === 0 && this.jump !== "end")) return;
    this.jump = "start";
    void this.source.toStart();
  }
  /** The rows to show: every line, less closed folds. */
  shownRows(): Shown[] {
    const s = this.source,
      ends = this.folded.size > 0 ? this.foldEnds() : null,
      key = `${s.version}:${s.count}:${[...this.folded].join(",")}`;
    if (this.shown?.key === key) return this.shown.rows;
    const rows: Shown[] = [];
    for (let row = 0; row < s.count; row++) {
      const to = this.folded.has(row) ? ends?.get(row) : undefined;
      if (to !== undefined) {
        rows.push({ row, to });
        row = to;
      } else rows.push({ row });
    }
    this.shown = { key, rows };
    return rows;
  }
  shownIndex(row: number): number {
    const rows = this.shownRows();
    let lo = 0,
      hi = rows.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (rows[mid].row <= row) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  }
  /** Where each fold that starts at a row ends: the lines indented past
   * it, and a bracket that closes it at its own indent. */
  foldEnds(): Map<number, number> {
    const s = this.source;
    if (s.mode !== "code") return new Map();
    if (this.ends?.version === s.version) return this.ends.map;
    const map = new Map<number, number>(),
      stack: { row: number; indent: number }[] = [];
    let last = -1;
    const close = (until: number, row: number, indent: number) => {
      while (stack.length && stack[stack.length - 1].indent >= indent) {
        const open = stack.pop()!;
        if (last <= open.row) continue;
        const absorbs = row < s.lines.length && indentOf(s.lines[row]) === open.indent && closer.test(s.lines[row]);
        map.set(open.row, absorbs ? row : until);
      }
    };
    for (let row = 0; row < s.lines.length; row++) {
      const indent = indentOf(s.lines[row]);
      if (indent < 0) continue;
      close(last, row, indent);
      stack.push({ row, indent });
      last = row;
    }
    close(last, s.lines.length, -1);
    this.ends = { version: s.version, map };
    return map;
  }
  /** Opens or closes the fold at `row`, or the one around it. */
  toggleFold(row: number): boolean {
    if (this.folded.delete(row)) return true;
    const ends = this.foldEnds();
    let start = -1;
    for (const [from, to] of ends) if (from <= row && row <= to && from > start) start = from;
    if (start < 0) return false;
    if (!this.folded.delete(start)) this.folded.add(start);
    return true;
  }
  /** Closes every outermost fold, or opens them all. */
  toggleAll(): void {
    if (this.folded.size > 0) {
      this.folded.clear();
      return;
    }
    let until = -1;
    for (const [from, to] of [...this.foldEnds()].sort((a, b) => a[0] - b[0]))
      if (from > until) {
        this.folded.add(from);
        until = to;
      }
  }
  /** The lines that open the blocks `row` is in, outermost first, at most `max`. */
  context(row: number, max: number): number[] {
    const lines = this.source.lines;
    if (this.source.mode !== "code" || this.log || max <= 0) return [];
    let at = row;
    while (at < lines.length && indentOf(lines[at]) < 0) at++;
    if (at >= lines.length) return [];
    let indent = indentOf(lines[at]);
    const out: number[] = [];
    for (let i = row - 1; i >= 0 && i >= row - context_reach && indent > 0; i--) {
      const d = indentOf(lines[i]);
      if (d < 0 || d >= indent || closer.test(lines[i])) continue;
      out.unshift(i);
      indent = d;
    }
    return out.slice(-max);
  }
  /** The lines pinned over the top of `h` rows, when `context` pins them. */
  pinned(h: number, context: boolean): number[] {
    return context && h >= 6 ? this.pins(this.shownRows(), h >= 10 ? 2 : 1) : [];
  }
  /** What row `r` of `h` drawn with `context` shows: a pinned line, with no
   * index, or the shown row at `index`. */
  at(r: number, h: number, context: boolean): { row: number; index: number | null } | null {
    const rows = this.shownRows(),
      pinned = this.pinned(h, context);
    if (this.covers(pinned, rows, r)) return { row: pinned[r], index: null };
    const index = this.top + r,
      shown = rows[index];
    return shown ? { row: shown.row, index } : null;
  }
  /** Whether the line pinned at row `r` covers another; one that is the
   * row drawn there anyway shows as itself. */
  private covers(pinned: number[], rows: Shown[], r: number): boolean {
    return r < pinned.length && pinned[r] !== rows[this.top + r]?.row;
  }
  /** The lines to pin over the top rows: the openings of the blocks the
   * first row left showing below them is in, so they speak for what shows. */
  private pins(rows: Shown[], max: number): number[] {
    for (let n = max; n > 0; n--) {
      const below = rows[this.top + n];
      const found = below ? this.context(below.row, n) : [];
      if (found.length === n) return found;
    }
    return [];
  }
  /** `text`'s colors as far as `limit` characters, past which nothing shows. */
  private spans(row: number, text: string, limit: number): Span[] {
    if (this.highlighter && this.source.mode === "code") return this.highlighter.spans(row);
    const shown = text.length > limit ? text.slice(0, limit) : text;
    if (this.log) return logSyntax.spans(shown);
    return this.lang ? syntax.lineSpans(this.lang, shown) : [];
  }
  /** Draws `h` rows from the top into `c` at `x`, `y`, `w` wide. */
  draw(c: Canvas, x: number, y: number, w: number, h: number, look: Look): void {
    const colors = palette.colors,
      s = this.source,
      rows = this.shownRows(),
      bg = look.bg;
    for (let r = 0; r < h; r++) c.fill(y + r, bg, x, x + w);
    if (s.binary || s.count === 0) {
      c.text(x + 2, y, s.binary ? i18n.t`Binary file` : i18n.t`Empty file`, colors.muted, bg, false, w - 2);
      return;
    }
    const last = s.number(s.count - 1),
      digits = last === null ? 0 : Math.max(3, String(last).length),
      marks = look.folds ? 2 : 0,
      text_x = x + marks + digits + 1,
      bar = look.scrollbar && rows.length > h ? 1 : 0,
      text_w = Math.max(0, x + w - bar - text_x);
    const pinned = this.pinned(h, look.context ?? false);
    const ends = look.folds ? this.foldEnds() : null;
    const pin_bg = palette.mix(bg ?? colors.bg, colors.selected, 45);
    for (let r = 0; r < h; r++) {
      const at = this.covers(pinned, rows, r) ? null : this.top + r;
      const shown: Shown | undefined = at === null ? { row: pinned[r] } : rows[at];
      if (!shown) break;
      const row = shown.row,
        target = at !== null && row === this.target,
        hover = r === look.hover,
        row_bg =
          at === null
            ? hover
              ? palette.mix(bg ?? colors.bg, colors.selected, 70)
              : pin_bg
            : target
              ? colors.selected
              : hover
                ? palette.mix(bg ?? colors.bg, colors.selected, 50)
                : bg;
      c.fill(y + r, row_bg, x, x + w - bar);
      if (look.folds && at !== null && ends?.has(row))
        c.put(
          x,
          y + r,
          shown.to !== undefined ? "▸" : "▾",
          shown.to !== undefined || hover ? colors.muted : colors.line,
          row_bg,
        );
      const number = s.number(row);
      if (number !== null)
        c.text(
          x + marks,
          y + r,
          String(number).padStart(digits),
          target ? colors.accent : hover ? colors.muted : colors.faint,
          row_bg,
          target,
        );
      const end = this.drawLine(c, text_x, y + r, text_w, row, row_bg, target ? this.column : null, look.shift ?? 0);
      if (shown.to !== undefined) {
        const hidden = shown.to - row,
          pill = i18n.t` ⋯ ${hidden} lines `,
          after = c.text(end + 1, y + r, pill, colors.muted, colors.selected, false, text_x + text_w - end - 1);
        if (closer.test(s.line(shown.to)))
          c.text(
            after + 1,
            y + r,
            s.line(shown.to).trim(),
            palette.syntax.punctuation,
            row_bg,
            false,
            text_x + text_w - after - 1,
          );
      }
    }
    if (bar) {
      const thumb = Math.max(1, Math.round((h * h) / rows.length)),
        from = Math.round(((h - thumb) * this.top) / Math.max(1, rows.length - h));
      for (let r = from; r < from + thumb && r < h; r++) c.put(x + w - 1, y + r, "┃", colors.line, bg);
    }
  }
  /** One row's text from `shift` columns in, cut with "›" past `w`.
   * Returns the column after it. */
  private drawLine(
    c: Canvas,
    x: number,
    y: number,
    w: number,
    row: number,
    bg: palette.Rgb | null,
    column: number | null,
    shift: number,
  ): number {
    // A character takes a column or more, but combining marks take none,
    // and UTF-8 takes up to 4 bytes for one.
    const limit = 2 * (shift + w) + 64,
      text = this.source.line(row, 4 * limit),
      spans = this.spans(row, text, limit),
      colors = palette.colors,
      mark = palette.mix(colors.selected, colors.accent, 35);
    let used = 0,
      col = 0,
      si = 0,
      previous = -1;
    for (let at = 0; at < text.length;) {
      const raw = String.fromCodePoint(text.codePointAt(at)!);
      if (raw === "\r" && at === text.length - 1) break;
      const width =
        raw === "\t" ? tab_width - (col % tab_width) : Math.max(0, codepointWidth(sourceGlyph(raw).codePointAt(0)!));
      if (width === 0) {
        if (previous >= 0 && c.cells[y]?.[previous]) c.cells[y][previous].ch += sourceGlyph(raw);
        at += raw.length;
        continue;
      }
      while (si < spans.length && spans[si][1] <= at) si++;
      const kind = si < spans.length && spans[si][0] <= at ? spans[si][2] : null;
      const fg = kind ? color(kind) : colors.text,
        cell_bg = column !== null && at === column - 1 ? mark : bg;
      for (let k = 0; k < width; k++, col++) {
        if (col < shift) continue;
        if (used >= w) {
          // The marker takes the last column; a wide character ending there gives way whole.
          if (c.cells[y]?.[x + w - 1]?.ch === "") c.put(x + w - 2, y, " ", fg, bg);
          c.put(x + w - 1, y, "›", colors.faint, bg);
          return x + w;
        }
        // A wide character cut by the scroll shows its right half blank.
        const ch = raw === "\t" || col - k < shift ? " " : k === 0 ? sourceGlyph(raw) : "";
        c.put(x + used, y, ch, fg, cell_bg);
        if (k === 0) previous = x + used;
        used++;
      }
      at += raw.length;
    }
    return x + used;
  }
}
function color(kind: logSyntax.Kind): palette.Rgb {
  const colors = palette.colors;
  switch (kind) {
    case "error":
      return colors.hot;
    case "warn":
      return colors.warm;
    case "info":
      return colors.text;
    case "debug":
      return colors.faint;
    default:
      return palette.syntax[kind];
  }
}
