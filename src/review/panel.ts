//! The review panel: the focused pane's checkout as a file tree over a
//! folded diff, with notes that paste into that pane. The viewer draws it at
//! the window's right edge, outside the layout, so it follows whichever pane
//! is focused. Browsing follows herdr-reviewr: scopes, hunk walking across
//! files, folds, changed words, find, and a commit picker.
import * as i18n from "../i18n";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as dropdown from "../dropdown";
import { Rect, type Direction } from "../layout";
import * as palette from "../palette";
import { codepointWidth, compactCount, displayWidth, wrap, Writer } from "../text";
import * as diff from "./diff";
import * as folding from "./folding";
import * as funcname from "./funcname";
import * as git from "./git";
import * as notes from "./notes";
import * as syntax from "./syntax";
import * as tree from "./tree";
import * as textArea from "../text_area";

export type Scope = "all" | "uncommitted" | "commits";
/** A key the panel reads: an edit, as every text box reads it, or one of its own. */
export type Named =
  | textArea.Edit
  | "page_up"
  | "page_down"
  | "home"
  | "end"
  | "tab"
  | "shift_tab"
  | "enter"
  | "escape"
  | "ctrl_d"
  | "ctrl_u";
export type Key = { named: Named } | { text: string };
/** What a key does in the note box or find: its edit, with the panel's own
 * names for the line's ends and ctrl+d and ctrl+u as text boxes read them. */
function typed(named: Named): textArea.Edit | null {
  const aliases: Partial<Record<Named, textArea.Edit>> = {
    home: "line_start",
    end: "line_end",
    ctrl_d: "delete",
    ctrl_u: "line_backspace",
  };
  return aliases[named] ?? (textArea.isEdit(named) ? named : null);
}
/** What a key or click asks of the viewer beyond the panel. */
export type Effect =
  | { kind: "none" }
  | { kind: "send"; pane: number; from: number; text: string; notes: notes.Note[] }
  | { kind: "copy"; text: string; notes: notes.Note[] }
  | { kind: "hide" }
  | { kind: "leave" };
/** The pane a review follows. */
export interface Target {
  pane: number;
  cwd: string;
  name: string;
}
/** The reviews ghosts keep, apart from every pane's: the one shown and the one read next. */
const ghost_panes = [-1, -2];
/** A checkout shown dimmed in a scope, as opening it there would show it. */
interface Ghost {
  target: Target;
  scope: Scope;
  pick: string | null;
}
/** How often an open panel rereads git. */
export const refresh_ms = 2000;
/** Rows a long line wraps to at most. */
const wrap_cap = 6;
export const min_width = 40;
/** Rows the diff keeps however far the file list is dragged. */
const min_diff_rows = 5;
/** Diffs "All files" reads at once. */
const parallel_reads = 4;
/** Keys under a heading: what each row does, and its keys. */
type KeyGroup = [string, [string, string][]];
const keyGroups = (): KeyGroup[] => [
  [
    i18n.t`Move`,
    [
      [i18n.t`Up, down`, "j k"],
      [i18n.t`Page`, "space -"],
      [i18n.t`Half page`, "ctrl+d ctrl+u"],
      [i18n.t`Top, bottom`, "home end"],
      [i18n.t`Change navigation`, "] ["],
      [i18n.t`File navigation`, "f F"],
      [i18n.t`Find`, "/"],
      [i18n.t`List, diff`, "tab"],
    ],
  ],
  [
    i18n.t`File list`,
    [
      [i18n.t`Open`, "enter"],
      [i18n.t`Sort, reverse`, "o O"],
      [i18n.t`Hide, resize`, "z < >"],
    ],
  ],
  [
    i18n.t`Leave`,
    [
      [i18n.t`Back to agent`, "esc"],
      [i18n.t`Close`, "q"],
    ],
  ],
  [
    i18n.t`Show`,
    [
      [i18n.t`All`, "a"],
      [i18n.t`Uncommitted`, "u"],
      [i18n.t`Commit`, "g G"],
      [i18n.t`Expand lines`, "enter"],
      [i18n.t`Fold file`, "x"],
      [i18n.t`Wrap`, "w"],
      [i18n.t`Pin review`, "p"],
    ],
  ],
  [
    i18n.t`Notes`,
    [
      [i18n.t`Select`, "v shift+↑↓"],
      [i18n.t`Comment`, "c"],
      [i18n.t`New line`, "shift+enter"],
      [i18n.t`Edit, delete`, "e d"],
      [i18n.t`Navigation`, "n N"],
      [i18n.t`List`, "l"],
      [i18n.t`Send to agent`, "s"],
      [i18n.t`Copy`, "y"],
    ],
  ],
];

type Part = "tree" | "diff";
/** A row of the file list: the "All files" slot above the files. */
type ListRow = tree.Row | { kind: "all"; id: "all"; depth: 0 };
const all_row: ListRow = { kind: "all", id: "all", depth: 0 };
/** A file as the diff area shows it: its change, its diff once read, and the units shown. */
interface Section {
  change: git.Change;
  file: Loaded | null;
  d: diff.FileDiff | null;
  /** Folded to its heading on "All files". */
  collapsed: boolean;
  units: diff.Unit[];
}
/** Where the cursor can stop in a section: each unit, or its one notice or folded heading. */
const stops = (s: Section) => Math.max(1, s.units.length);
interface Compose {
  path: string;
  rev: notes.Rev;
  side: notes.Side;
  start: number;
  end: number;
  snippet: string;
  area: textArea.TextArea;
  edit: number | null;
  range: [number, number];
}
interface Find {
  query: textArea.TextArea;
  hits: { path: string; row: number; start: number; end: number }[];
  /** The hits' ranges by file and row, keyed `path\0row`. */
  by_row: Map<string, diff.Ranges>;
  at: number;
}
/** One pane's review: what it looks at and the notes it will send. */
class Review {
  scope: Scope = "all";
  /** The "All files" slot: every file's diff in one flow, in the list's order. */
  all = true;
  /** How the files are listed: a tree by name, or one list by last edit. */
  sort: "name" | "edited" = "name";
  /** The other way from how each sort starts: Z to A, or oldest edit first. */
  reversed = false;
  pick: string | null = null;
  /** The file shown alone, or on "All files" the one the cursor is in. */
  path: string | null = null;
  part: Part = "tree";
  tree_sel: string | null = "all";
  tree_top = 0;
  /** The wheel scrolled the tree; it follows the selection again when that moves. */
  tree_free = false;
  tree_hidden = false;
  toggled = new Set<string>();
  cur = 0;
  top = 0;
  free = false;
  /** The flow's top file and where its heading was when last drawn, so files
   * changing above it leave the screen where it was. */
  landmark: { path: string; y: number } | null = null;
  /** The next draw puts the cursor's file heading at the top. */
  raise = false;
  shift = 0;
  wrap = true;
  /** Opened folds per file, by anchor. */
  opened = new Map<string, Set<number>>();
  /** Explicit file folding choices on "All files", overriding the defaults. */
  collapsed = new Map<string, boolean>();
  /** Generated files whose diff was asked for. */
  loaded = new Set<string>();
  anchor: number | null = null;
  /** The selection came from v, so moving extends it; one made with shift
   * or a drag ends at the next plain move. */
  visual = false;
  compose: Compose | null = null;
  notes: notes.Note[] = [];
  seq = 1;
  list: { at: number } | null = null;
  keys = false;
  /** The commit menu under the commits chip: the highlighted row and the first one shown. */
  picker: { at: number; top: number } | null = null;
  find: Find | null = null;
  status: { text: string; warm: boolean } | null = null;
}
interface Listing {
  changes: git.Change[];
  auto_collapsed: Set<string>;
  /** When each file in the working tree was last written; none for a commit. */
  edited: Map<string, number> | null;
}
interface Loaded {
  sig: string;
  loaded: git.Loaded;
  old: syntax.Highlighter;
  new: syntax.Highlighter;
}
class Checkout {
  branch: string | null = null;
  head: string | null = null;
  base: git.Base | null = null;
  commits: git.Commit[] = [];
  listings = new Map<string, Listing>();
  files = new Map<string, Loaded>();
  error: string | null = null;
  /** Whether git has answered for it once. */
  read = false;
  constructor(readonly root: string) {}
}
/** The followed pane's review as it stands: its listing, and the selected
 * file or the one the cursor is in. */
interface Now extends Listing {
  co: Checkout;
  r: Review;
  source: git.Source;
  change: git.Change | null;
  file: Loaded | null;
}
const sourceKey = (s: git.Source) => (s.kind === "worktree" ? `w:${s.against}` : `c:${s.hash}`);
const revOf = (s: git.Source): notes.Rev =>
  s.kind === "worktree" ? { kind: "worktree" } : { kind: "commit", hash: s.hash };

// Colors that mix the palette for diffs: row tints, the brighter tint on
// changed words, the cursor row, and find hits.
const tint = {} as Record<"add" | "del" | "add_em" | "del_em" | "cursor" | "selected" | "match" | "fold", palette.Rgb>;
palette.derived(() => {
  const c = palette.colors;
  tint.add = palette.mix(c.bg, c.accent, 10);
  tint.del = palette.mix(c.bg, c.hot, 10);
  tint.add_em = palette.mix(c.bg, c.accent, 27);
  tint.del_em = palette.mix(c.bg, c.hot, 27);
  tint.cursor = palette.mix(c.selected, c.line, 30);
  tint.selected = c.selected;
  tint.match = palette.mix(c.bg, c.warm, 40);
  tint.fold = c.surface;
});

/** A cell of the panel: its text and colors; a null background is the
 * terminal's own. */
interface Cell {
  ch: string;
  fg: palette.Rgb;
  bg: palette.Rgb | null;
  bold: boolean;
}
type Hit = {
  x: number;
  y: number;
  w: number;
  h: number;
  act?: () => void;
  unit?: number;
  /** The file a unit is in. */
  path?: string;
  wheel?: "tree" | "diff";
};
/** Control characters never reach the terminal. */
const safe = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 32;
  return cp < 32 || cp === 127 || (cp >= 0x80 && cp < 0xa0) ? "·" : ch;
};
type SourceSlice = { start: number; end: number; width: number };
const sourceGlyph = (ch: string) => (ch === "\t" ? " " : safe(ch));
/** Slice source by terminal cells while retaining UTF-16 offsets for highlighting. */
function sourceSlice(value: string, start: number, width: number): SourceSlice {
  let end = start,
    used = 0;
  while (end < value.length) {
    const raw = String.fromCodePoint(value.codePointAt(end)!);
    const cells = Math.max(0, codepointWidth(sourceGlyph(raw).codePointAt(0)!));
    if (used + cells > width) break;
    used += cells;
    end += raw.length;
  }
  return { start, end, width: used };
}
function sourceLines(value: string, width: number, limit: number, start = 0): SourceSlice[] {
  const lines: SourceSlice[] = [];
  do {
    const line = sourceSlice(value, start, width);
    lines.push(line);
    if (line.end === start) break;
    start = line.end;
  } while (start < value.length && lines.length < limit);
  return lines;
}
/** Horizontal scrolling never starts inside a wide codepoint. */
function sourceOffset(value: string, columns: number): number {
  let at = 0,
    used = 0;
  while (at < value.length && used < columns) {
    const raw = String.fromCodePoint(value.codePointAt(at)!);
    used += Math.max(0, codepointWidth(sourceGlyph(raw).codePointAt(0)!));
    at += raw.length;
  }
  return at;
}
class Canvas {
  cells: Cell[][];
  hits: Hit[] = [];
  constructor(
    readonly x: number,
    readonly y: number,
    readonly w: number,
    readonly h: number,
  ) {
    this.cells = Array.from({ length: h }, () =>
      Array.from({ length: w }, () => ({ ch: " ", fg: palette.colors.text, bg: null, bold: false })),
    );
  }
  fill(row: number, bg: palette.Rgb | null, from = 0, to = this.w): void {
    if (row < 0 || row >= this.h) return;
    for (let i = Math.max(0, from); i < Math.min(this.w, to); i++)
      Object.assign(this.cells[row][i], { ch: " ", bg, bold: false });
  }
  /** Writes `text` from column `col`, at most `room` columns, ending in
   * "…" when cut. Returns the column after it. */
  text(
    col: number,
    row: number,
    text: string,
    fg: palette.Rgb,
    bg?: palette.Rgb | null,
    bold = false,
    room = this.w - col,
  ): number {
    if (row < 0 || row >= this.h || room <= 0) return col;
    const chars = [...text];
    let used = 0;
    const total = chars.reduce((s, ch) => s + Math.max(0, codepointWidth(ch.codePointAt(0)!)), 0);
    const cut = total > room;
    for (const raw of chars) {
      const ch = raw === "\t" ? " " : safe(raw);
      const width = Math.max(0, codepointWidth(ch.codePointAt(0)!));
      if (width === 0) continue;
      if (used + width > room - (cut ? 1 : 0)) break;
      this.put(col + used, row, ch, fg, bg, bold);
      if (width === 2) this.put(col + used + 1, row, "", fg, bg, bold);
      used += width;
    }
    if (cut) this.put(col + used++, row, "…", fg, bg, bold);
    return col + used;
  }
  put(col: number, row: number, ch: string, fg: palette.Rgb, bg?: palette.Rgb | null, bold = false): void {
    if (row < 0 || row >= this.h || col < 0 || col >= this.w) return;
    const cell = this.cells[row][col];
    cell.ch = ch;
    cell.fg = fg;
    if (bg !== undefined) cell.bg = bg;
    cell.bold = bold;
  }
  /** Every cell halfway to black, or to white on a light background, as panes dim behind a dialog. */
  fade(): void {
    for (const row of this.cells)
      for (const cell of row) [cell.fg, cell.bg] = [fade(cell.fg), fade(cell.bg ?? palette.colors.bg)];
  }
  hit(x: number, y: number, w: number, h: number, extra: Omit<Hit, "x" | "y" | "w" | "h">): void {
    this.hits.push({ x: this.x + x, y: this.y + y, w, h, ...extra });
  }
  flush(w: Writer): void {
    const plain = palette.bg("bg");
    this.cells.forEach((row, r) => {
      w.write(`\x1b[${this.y + r + 1};${this.x + 1}H\x1b[0m`);
      let style = "";
      for (const cell of row) {
        if (cell.ch === "") continue;
        const next = `\x1b[0m${cell.bold ? "\x1b[1m" : ""}${palette.fgRgb(cell.fg)}${cell.bg ? palette.bgRgb(cell.bg) : plain}`;
        if (next !== style) {
          w.write(next);
          style = next;
        }
        w.write(cell.ch);
      }
    });
    w.write("\x1b[0m");
  }
}
function fade(color: palette.Rgb): palette.Rgb {
  const [r, g, b] = palette.colors.bg,
    light = r * 299 + g * 587 + b * 114 > 127_500;
  return palette.mix(color, light ? [255, 255, 255] : [0, 0, 0], 50);
}
/** A change's letter in the file list and on its heading, and its color. */
function mark(ch: git.Change): [string, palette.Rgb] {
  const colors = palette.colors;
  return ch.kind === "added" || ch.kind === "untracked"
    ? ["A", colors.accent]
    : ch.kind === "deleted"
      ? ["D", colors.hot]
      : ch.kind === "renamed"
        ? ["R", colors.muted]
        : ["M", colors.muted];
}
function plural(count: number, word: "note" | "file" | "commit" | "unmodified line" | "hunk" | "row"): string {
  switch (word) {
    case "note":
      return count === 1 ? i18n.t`${count} note` : i18n.t`${count} notes`;
    case "file":
      return count === 1 ? i18n.t`${count} file` : i18n.t`${count} files`;
    case "commit":
      return count === 1 ? i18n.t`${count} commit` : i18n.t`${count} commits`;
    case "unmodified line":
      return count === 1 ? i18n.t`${count} unmodified line` : i18n.t`${count} unmodified lines`;
    case "hunk":
      return count === 1 ? i18n.t`${count} hunk` : i18n.t`${count} hunks`;
    case "row":
      return count === 1 ? i18n.t`${count} row` : i18n.t`${count} rows`;
  }
}

export class Panel {
  open = false;
  /** Kept on its pane's checkout while focus moves on; notes then go to `dest`. */
  pinned = false;
  /** The focused pane, where a pinned panel's notes go. */
  dest: Target | null = null;
  private reviews = new Map<number, Review>();
  private checkouts = new Map<string, Checkout>();
  private roots = new Map<string, string | null>();
  /** The pane whose checkout is shown. */
  get pane(): number | null {
    return this.target?.pane ?? null;
  }
  private target: Target | null = null;
  /** The ghost shown over whatever the panel follows, and the one asked for
   * next, which takes its place once read so hovering on never shows a blank. */
  private ghost: Ghost | null = null;
  private next_ghost: Ghost | null = null;
  private hits: Hit[] = [];
  /** The refresh under way; another asked for meanwhile runs after it. */
  private flight: Promise<void> | null = null;
  private again = false;
  /** The latest read asked for per diff, so an older one never replaces it. */
  private reading = new Map<string, number>();
  /** Diffs read so far, so a refresh can tell it read one. */
  private loads = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selecting: { from: number; path: string | null } | null = null;
  /** Rows the file list takes at most, as last dragged or set with < and >. */
  tree_rows = 9;
  /** Called with `tree_rows` after the user changes it. */
  resized: (rows: number) => void = () => {};
  /** The rule under the file list as last drawn: its row, the list's first
   * row, and the most rows the list may take. */
  private split: { y: number; top: number; room: number } | null = null;
  /** The rule under the file list is being dragged. */
  splitting = false;
  /** The keys overlay is up, dimming everything but itself. */
  get keysOpen(): boolean {
    return this.open && this.target !== null && this.review(this.target.pane).keys;
  }
  /** A note or a find is being typed, so a paste goes to it. */
  get typing(): boolean {
    return this.typingArea() !== null;
  }
  /** The text box being typed in: a note, or a find. */
  typingArea(): textArea.TextArea | null {
    if (!this.open || !this.target) return null;
    const r = this.review(this.target.pane);
    return r.compose?.area ?? r.find?.query ?? null;
  }
  /** The note box's text as last drawn: its first cell, and how many rows and columns it shows. */
  private compose_at: { x: number; y: number; rows: number; w: number } | null = null;
  /** A press in the note box is dragging a selection. */
  private placing = false;
  /** A pasted character's bytes so far, and whether the last was a carriage return. */
  private pasted: number[] = [];
  private pasted_cr = false;
  /** A byte of a paste while typing. Whole characters go in at the caret;
   * a line break, however it's spelled, as one. */
  pasteByte(byte: number): void {
    const t = this.target;
    if (!t) return;
    const r = this.review(t.pane),
      cr = this.pasted_cr;
    this.pasted_cr = byte === 13;
    if (byte === 10 && cr) return;
    let text: string | null = null;
    if (byte < 0x80) {
      this.pasted = [];
      text =
        byte === 10 || byte === 13
          ? "\n"
          : byte === 9
            ? "    "
            : byte >= 32 && byte !== 127
              ? String.fromCharCode(byte)
              : null;
    } else {
      this.pasted.push(byte);
      const lead = this.pasted[0],
        size = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1;
      if (this.pasted.length < size) return;
      text = Buffer.from(this.pasted).toString();
      this.pasted = [];
      if (text.includes("\ufffd")) text = null;
    }
    if (text === null) return;
    if (r.compose) r.compose.area.insert(text);
    else if (r.find) {
      r.find.query.insert(text === "\n" ? " " : text);
      const now = this.current(),
        flow = now ? this.sections(r, now) : [];
      this.findIndex(r, flow);
      this.findStep(r, flow, 1);
    }
  }
  /** The row of the rule under the file list, which drags its height; null without one. */
  get splitRow(): number | null {
    return this.split?.y ?? null;
  }
  /** Where the commits chip was last drawn, and the menu under it. */
  private commits_chip: { x: number; y: number; w: number } | null = null;
  private menu: { rect: Rect; first: number; count: number; heading: boolean } | null = null;
  private pending: Effect = { kind: "none" };
  /** Height of the diff area last drawn, for paging. */
  private page = 20;
  /** Called when something changed without input, such as git answering. */
  changed: () => void = () => {};
  /** Called with `summary` for a checkout whenever the "all" scope rereads it. */
  summarized: (root: string, runs: dropdown.Run[]) => void = () => {};

  review(pane: number): Review {
    let r = this.reviews.get(pane);
    if (!r) {
      r = new Review();
      this.reviews.set(pane, r);
    }
    return r;
  }
  /** Unsent notes for pane `pane`, for its sidebar row. */
  noteCount(pane: number): number {
    return this.reviews.get(pane)?.notes.length ?? 0;
  }
  /** Forgets panes that closed. */
  keep(panes: Set<number>): void {
    for (const id of this.reviews.keys()) if (!ghost_panes.includes(id) && !panes.has(id)) this.reviews.delete(id);
  }
  /** Whether a ghost is shown, open or not. */
  get ghosted(): boolean {
    return this.ghost !== null;
  }
  /** Shows the checkout at `cwd` dimmed in `scope`, on commit `pick` for
   * "commits", until called with null. Keys and clicks still reach what the
   * panel follows. */
  preview(ghost: { cwd: string; name: string; scope: Scope; pick: string | null } | null): void {
    const same = (g: Ghost | null) =>
      g !== null && ghost !== null && g.target.cwd === ghost.cwd && g.scope === ghost.scope && g.pick === ghost.pick;
    if (!ghost) {
      this.ghost = this.next_ghost = null;
      for (const id of ghost_panes) this.reviews.delete(id);
      return;
    }
    if (same(this.next_ghost)) return;
    if (this.next_ghost) this.reviews.delete(this.next_ghost.target.pane);
    this.next_ghost = null;
    if (same(this.ghost)) return;
    const pane = ghost_panes.find(id => id !== this.ghost?.target.pane)!,
      next = { target: { pane, cwd: ghost.cwd, name: ghost.name }, scope: ghost.scope, pick: ghost.pick };
    this.reviews.delete(pane);
    Object.assign(this.review(pane), { scope: ghost.scope, pick: ghost.pick });
    // The first ghost shows at once; there is nothing to keep in its place.
    if (this.ghost) this.next_ghost = next;
    else this.ghost = next;
    void this.refresh();
  }
  /** Whether a ghost has what it shows first: its listing and the diff the cursor starts on. */
  private settled(g: Ghost): boolean {
    const root = this.roots.get(g.target.cwd);
    if (root === undefined) return false;
    const co = root ? this.checkouts.get(root) : null;
    if (co === undefined || (co && !co.read)) return false;
    if (!co || co.error) return true;
    const followed = this.target;
    this.target = g.target;
    try {
      const now = this.current();
      return now !== null && (now.changes.length === 0 || now.file !== null || now.change?.generated === true);
    } finally {
      this.target = followed;
    }
  }
  /** Reviews the followed pane in `scope`, on commit `pick` for "commits". */
  showScope(scope: Scope, pick: string | null): void {
    const t = this.target;
    if (!t) return;
    const r = this.review(t.pane);
    r.picker = null;
    if (pick) r.pick = pick;
    this.setScope(r, scope);
  }
  /** The panel's width, or 0 when it can't sit beside the panes. */
  static fit(preferred: number, room: number): number {
    const width = Math.min(Math.max(preferred, min_width), room - 30);
    return width >= min_width ? width : 0;
  }
  follow(target: Target | null): void {
    const before = this.target;
    this.target = target;
    if (!target) return;
    if (!before || before.pane !== target.pane || before.cwd !== target.cwd) void this.refresh();
  }
  show(): void {
    this.open = true;
    this.schedule();
    void this.refresh();
  }
  hide(): void {
    this.open = false;
    this.pinned = false;
    this.splitting = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
  private schedule(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.open) return;
      void this.refresh().finally(() => this.schedule());
    }, refresh_ms);
    (this.timer as { unref?: () => void }).unref?.();
  }
  private checkout(): Checkout | null {
    const t = this.target;
    if (!t) return null;
    const root = this.roots.get(t.cwd);
    return root ? (this.checkouts.get(root) ?? null) : null;
  }
  private source(co: Checkout, r: Review): git.Source | null {
    if (r.scope === "commits") return r.pick ? { kind: "commit", hash: r.pick } : null;
    if (r.scope === "all" && co.base) return { kind: "worktree", against: co.base.merge_base };
    return { kind: "worktree", against: co.head ?? git.empty_tree };
  }
  private listing(co: Checkout, r: Review): (Listing & { source: git.Source }) | null {
    const source = this.source(co, r);
    if (!source) return null;
    const listed = co.listings.get(sourceKey(source));
    return listed ? { source, ...listed } : null;
  }
  /** Rereads git for the followed pane: its checkout, base, commits, the
   * scope's changed files, then the selected file. A call while one runs
   * waits for it and runs again after. */
  refresh(): Promise<void> {
    if (this.flight) {
      this.again = true;
      return this.flight;
    }
    const before = this.signature();
    this.flight = this.read(this.open ? this.target : null)
      .then(() => this.read((this.next_ghost ?? this.ghost)?.target ?? null))
      .finally(() => {
        this.flight = null;
        // A poll that found nothing new leaves the viewer asleep.
        if (this.signature() !== before) this.changed();
        if (this.again) {
          this.again = false;
          void this.refresh();
        }
      });
    return this.flight;
  }
  /** What a refresh can change on screen, to tell whether one did. */
  private signature(): string {
    return [this.target, this.ghost?.target, this.next_ghost?.target].map(t => this.signatureOf(t ?? null)).join("\n");
  }
  private signatureOf(t: Target | null): string {
    if (!t) return "";
    const root = this.roots.get(t.cwd);
    const co = root ? this.checkouts.get(root) : undefined;
    if (!co) return String(root);
    const r = this.review(t.pane),
      listed = this.listing(co, r);
    return JSON.stringify([
      co.read,
      co.head,
      co.branch,
      co.base,
      co.error,
      co.commits.length,
      r.path,
      listed?.changes,
      listed?.edited && [...listed.edited],
      r.sort,
      r.reversed,
      this.pinned,
      this.dest?.pane,
      this.loads,
    ]);
  }
  private async read(t: Target | null): Promise<void> {
    if (!t) return;
    let root = this.roots.get(t.cwd);
    if (root === undefined) {
      root = await git.toplevel(t.cwd);
      this.roots.set(t.cwd, root);
    }
    if (!root) return;
    let co = this.checkouts.get(root);
    if (!co) {
      co = new Checkout(root);
      this.checkouts.set(root, co);
    }
    const r = this.review(t.pane);
    try {
      [co.head, co.branch, co.base] = await Promise.all([git.head(root), git.branch(root), git.base(root)]);
      co.commits = await git.commits(root, co.base);
      // A pick from elsewhere may name its commit short.
      const picked = r.pick && co.commits.find(cm => cm.hash.startsWith(r.pick!));
      if (picked) r.pick = picked.hash;
      const source = this.source(co, r);
      if (source) {
        const listed = await list(root, source);
        co.listings.set(sourceKey(source), listed);
        if (r.scope === "all") this.summarized(root, summaryRuns(listed.changes, co.base));
      }
      // The branch also reads the working copy alone, to say where each file's change is.
      const working: git.Source = { kind: "worktree", against: co.head ?? git.empty_tree };
      if (source && r.scope === "all" && sourceKey(source) !== sourceKey(working))
        co.listings.set(sourceKey(working), await list(root, working));
      co.error = null;
    } catch (error) {
      co.error = (error as Error).message;
    }
    co.read = true;
    await this.loadFiles(co, r);
  }
  /** Reads the diffs on show that aren't current: the selected file's, or on
   * "All files" every file's, the cursor's first, a few at a time. */
  private async loadFiles(co: Checkout, r: Review): Promise<void> {
    const listed = this.listing(co, r);
    if (!listed) return;
    const paths = listed.changes.map(c => c.path),
      order = this.fileOrder(r, paths, listed.edited);
    if (!r.path || !paths.includes(r.path)) {
      if (r.all) [r.path, r.cur, r.anchor] = [order[0] ?? null, 0, null];
      else this.select(r, order[0] ?? null, paths, false);
    }
    const changes = new Map(listed.changes.map(c => [c.path, c]));
    if (!r.all) {
      const change = r.path ? changes.get(r.path) : undefined;
      if (change) await this.loadFile(co, r, listed.source, change);
      return;
    }
    const from = Math.max(0, order.indexOf(r.path ?? "")),
      queue = [...order.slice(from), ...order.slice(0, from)].map(path => changes.get(path)!);
    const reader = async () => {
      for (let change = queue.shift(); change; change = queue.shift())
        await this.loadFile(co, r, listed.source, change);
    };
    await Promise.all(Array.from({ length: parallel_reads }, reader));
  }
  /** Reads one file's diff unless it is current. */
  private async loadFile(co: Checkout, r: Review, source: git.Source, change: git.Change): Promise<void> {
    if (change.generated && !r.loaded.has(change.path)) return;
    let stamp = "";
    if (source.kind === "worktree" && change.kind !== "deleted")
      try {
        const info = await stat(join(co.root, change.path));
        stamp = `${info.size}:${info.mtimeMs}`;
      } catch {}
    const sig = `${change.kind}|${change.from}|${change.adds}|${change.dels}|${stamp}`;
    const key = `${sourceKey(source)}\0${change.path}`;
    if (co.files.get(key)?.sig === sig) return;
    const ticket = (this.reading.get(key) ?? 0) + 1;
    this.reading.set(key, ticket);
    const loaded = await git.fileDiff(co.root, source, change);
    if (this.reading.get(key) !== ticket && co.files.has(key)) return;
    const lang = syntax.language(change.path);
    co.files.set(key, {
      sig,
      loaded,
      old: new syntax.Highlighter(lang, loaded.kind === "diff" ? loaded.diff.old : []),
      new: new syntax.Highlighter(lang, loaded.kind === "diff" ? loaded.diff.new : []),
    });
    this.loads++;
    if (loaded.kind === "diff" && r.path === change.path && r.cur === 0)
      r.cur = this.firstChange(r, loaded.diff, change.path);
    this.changed();
  }
  private loadSelected(): void {
    const co = this.checkout(),
      t = this.target;
    if (!co || !t) return;
    const r = this.review(t.pane),
      listed = this.listing(co, r),
      change = listed?.changes.find(c => c.path === r.path);
    if (listed && change) void this.loadFile(co, r, listed.source, change);
  }
  private current(): Now | null {
    const co = this.checkout(),
      t = this.target;
    if (!co || !t) return null;
    const r = this.review(t.pane),
      listed = this.listing(co, r);
    if (!listed) return null;
    const change = listed.changes.find(c => c.path === r.path) ?? null;
    const file = change ? (co.files.get(`${sourceKey(listed.source)}\0${change.path}`) ?? null) : null;
    return { co, r, ...listed, change, file };
  }
  /** The list's rows: "All files", then a tree by name or one list newest edit first. */
  private listRows(r: Review, paths: string[], edited: Map<string, number> | null): ListRow[] {
    return [
      all_row,
      ...(r.sort === "edited" && edited
        ? tree.flat(tree.byEdited(paths, edited, r.reversed))
        : tree.rows(paths, r.toggled, false, r.sort === "name" && r.reversed)),
    ];
  }
  /** The files the diff area shows: on "All files" every one in the list's
   * order, else the selected one. */
  private sections(r: Review, now: Now): Section[] {
    const changes = new Map(now.changes.map(ch => [ch.path, ch])),
      paths = r.all ? this.fileOrder(r, [...changes.keys()], now.edited) : now.change ? [now.change.path] : [];
    return paths.map(path => {
      const change = changes.get(path)!,
        file =
          change.generated && !r.loaded.has(path)
            ? null
            : (now.co.files.get(`${sourceKey(now.source)}\0${path}`) ?? null),
        d = file?.loaded.kind === "diff" ? file.loaded.diff : null,
        collapsed = this.isCollapsed(r, now, path);
      return { change, file, d, collapsed, units: d && !collapsed ? this.units(r, d, path) : [] };
    });
  }
  /** The cursor as one index over every section's stops. */
  private position(r: Review, sections: Section[]): number {
    let at = 0;
    for (const s of sections) {
      if (s.change.path === r.path) return at + Math.min(r.cur, stops(s) - 1);
      at += stops(s);
    }
    return 0;
  }
  /** Puts the cursor on stop `at` of the sections; a selection doesn't follow it out of its file. */
  private place(r: Review, sections: Section[], at: number): void {
    for (const s of sections) {
      if (at < stops(s)) {
        if (s.change.path !== r.path) r.anchor = null;
        r.path = s.change.path;
        r.cur = at;
        return;
      }
      at -= stops(s);
    }
  }
  /** In the flow, the cursor to `path`'s first change and its heading to the top. */
  private reach(r: Review, sections: Section[], path: string): void {
    const s = sections.find(x => x.change.path === path);
    if (path !== r.path) r.anchor = null;
    r.path = path;
    r.cur = s?.d && s.units.length ? this.firstChange(r, s.d, path) : 0;
    r.free = false;
    r.raise = true;
  }
  /** Folds file `path` on "All files" to its heading, or opens it again,
   * and puts the cursor on it. */
  private collapse(r: Review, now: Now, path: string): void {
    if (path !== r.path) r.anchor = null;
    r.part = "diff";
    r.path = path;
    r.cur = 0;
    r.free = false;
    const collapsed = !this.isCollapsed(r, now, path);
    r.collapsed.set(path, collapsed);
    if (collapsed) {
      r.anchor = null;
      return;
    }
    const file = now.co.files.get(`${sourceKey(now.source)}\0${path}`);
    if (file?.loaded.kind === "diff") r.cur = this.firstChange(r, file.loaded.diff, path);
  }
  private isCollapsed(r: Review, now: Now, path: string): boolean {
    return r.all && (r.collapsed.get(path) ?? now.auto_collapsed.has(path));
  }
  /** The flow's next or previous hunk, across files. A file not read yet
   * stops the walk until it is. */
  private hunk(r: Review, sections: Section[], step: 1 | -1): void {
    const here = this.position(r, sections),
      starts: number[] = [];
    let at = 0;
    // Folded files are passed over.
    for (const s of sections) {
      if (s.d && !s.collapsed) for (const start of diff.hunkStarts(s.d, s.units)) starts.push(at + start);
      else if (!s.file && !s.collapsed && !(s.change.generated && !r.loaded.has(s.change.path))) starts.push(at);
      at += stops(s);
    }
    const next = step > 0 ? starts.find(s => s > here) : starts.filter(s => s < here).pop();
    if (next === undefined) return;
    this.place(r, sections, next);
    r.free = false;
  }
  /** Shows every file in one flow, the cursor's file at the top. */
  private showAll(r: Review): void {
    r.tree_sel = "all";
    if (r.all) return;
    r.all = true;
    r.anchor = null;
    r.free = false;
    r.raise = true;
    void this.refresh();
  }
  /** Shows file `path` alone. */
  private choose(r: Review, path: string, paths: string[]): void {
    r.all = false;
    r.landmark = null;
    this.select(r, path, paths);
  }
  /** Every file in the order the rows show, as `]` and `f` walk them. */
  private fileOrder(r: Review, paths: string[], edited: Map<string, number> | null): string[] {
    return r.sort === "edited" && edited
      ? tree.byEdited(paths, edited, r.reversed)
      : tree.order(paths, r.sort === "name" && r.reversed);
  }
  /** Lists the files by `by`; asked for the same again, the other way round. */
  private setSort(r: Review, by: "name" | "edited"): void {
    if (r.sort === by) r.reversed = !r.reversed;
    else [r.sort, r.reversed] = [by, false];
  }
  private units(r: Review, d: diff.FileDiff, path: string): diff.Unit[] {
    return diff.shown(d, r.opened.get(path) ?? new Set());
  }
  private firstChange(r: Review, d: diff.FileDiff, path: string): number {
    const units = this.units(r, d, path);
    return Math.max(
      0,
      units.findIndex(u => diff.isChange(d, u)),
    );
  }
  private select(r: Review, path: string | null, paths: string[], load = true): void {
    r.path = path;
    r.anchor = null;
    r.top = 0;
    r.shift = 0;
    r.free = false;
    r.tree_free = false;
    r.cur = 0;
    if (path) {
      r.toggled = tree.reveal(paths, r.toggled, path);
      r.tree_sel = "f:" + path;
      const co = this.checkout(),
        listed = co && this.listing(co, r),
        file = co && listed ? co.files.get(`${sourceKey(listed.source)}\0${path}`) : undefined;
      if (file?.loaded.kind === "diff") r.cur = this.firstChange(r, file.loaded.diff, path);
    }
    if (load) this.loadSelected();
  }
  private setScope(r: Review, scope: Scope): void {
    r.scope = scope;
    r.top = 0;
    r.cur = 0;
    r.landmark = null;
    void this.refresh();
  }
  private pickable(co: Checkout): git.Commit[] {
    return co.commits;
  }
  /** Opens the commit menu on the reviewed commit, or the newest. */
  private openPicker(r: Review, co: Checkout): void {
    r.picker = {
      at: Math.max(
        0,
        this.pickable(co).findIndex(c => c.hash === r.pick),
      ),
      top: 0,
    };
  }

  // ---------- input ----------

  /** A key while the panel has the keyboard. */
  key(k: Key): Effect {
    const t = this.target;
    if (!t) return "named" in k && k.named === "escape" ? { kind: "leave" } : { kind: "none" };
    const r = this.review(t.pane),
      now = this.current(),
      d = now?.file?.loaded.kind === "diff" ? now.file.loaded.diff : null,
      flow = now ? this.sections(r, now) : [],
      units = flow.find(s => s.change.path === r.path)?.units ?? [],
      named = "named" in k ? k.named : null,
      text = "text" in k ? k.text : "";
    if (r.compose) {
      const c = r.compose,
        edit = named && typed(named);
      if (named === "escape") r.compose = null;
      else if (edit) c.area.apply(edit);
      else if (named === "enter") {
        const body = c.area.text.trim();
        if (body) {
          if (c.edit !== null) {
            const n = r.notes.find(x => x.id === c.edit);
            if (n) n.text = body;
          } else
            r.notes.push({
              id: r.seq++,
              path: c.path,
              rev: c.rev,
              side: c.side,
              start: c.start,
              end: c.end,
              snippet: c.snippet,
              text: body,
            });
        }
        r.compose = null;
      } else if (text) c.area.insert(text);
      return { kind: "none" };
    }
    if (r.find) {
      const f = r.find,
        edit = named && typed(named),
        before = f.query.text;
      if (named === "escape") r.find = null;
      else if (named === "enter" || named === "down") this.findStep(r, flow, 1);
      else if (named === "shift_tab" || named === "up") this.findStep(r, flow, -1);
      else if (edit) f.query.apply(edit);
      else if (text) f.query.insert(text);
      if (r.find && f.query.text !== before) {
        this.findIndex(r, flow);
        if (text) this.findStep(r, flow, 1);
      }
      return { kind: "none" };
    }
    if (r.picker && now) {
      const list = this.pickable(now.co);
      if (named === "escape" || text === "q") r.picker = null;
      else if (named === "down" || text === "j") r.picker.at = Math.min(r.picker.at + 1, Math.max(0, list.length - 1));
      else if (named === "up" || text === "k") r.picker.at = Math.max(r.picker.at - 1, 0);
      else if (named === "enter" && list.length) this.pick(r, list[r.picker.at].hash);
      return { kind: "none" };
    }
    if (r.list) {
      const n = r.notes.length;
      if (named === "escape" || text === "l" || text === "q") r.list = null;
      else if (named === "down" || text === "j") r.list.at = Math.min(r.list.at + 1, Math.max(0, n - 1));
      else if (named === "up" || text === "k") r.list.at = Math.max(r.list.at - 1, 0);
      else if (named === "enter" && n) {
        this.jumpToNote(r, r.notes[r.list.at]);
        r.list = null;
      } else if (text === "d" && n) {
        r.notes.splice(r.list.at, 1);
        r.list.at = Math.min(r.list.at, Math.max(0, r.notes.length - 1));
      }
      return { kind: "none" };
    }
    if (r.keys) {
      r.keys = false;
      return { kind: "none" };
    }
    r.status = null;
    if (!now) {
      if (named === "escape") return { kind: "leave" };
      if (text === "q") return { kind: "hide" };
      return { kind: "none" };
    }
    const paths = now.changes.map(c => c.path),
      order = this.fileOrder(r, paths, now.edited),
      at = r.path ? order.indexOf(r.path) : -1;
    const toFile = (i: number) => {
      if (i < 0 || i >= order.length) return;
      if (r.all) this.reach(r, flow, order[i]);
      else this.select(r, order[i], paths);
    };
    const move = (delta: number, extend = r.visual) => {
      if (!extend) r.anchor = null;
      r.free = false;
      if (!r.all) {
        r.cur = Math.min(Math.max(r.cur + delta, 0), Math.max(0, units.length - 1));
        return;
      }
      // In the flow the cursor crosses files, but a selection keeps to its own.
      let start = 0,
        total = 0;
      for (const s of flow) {
        if (s.change.path === r.path) start = total;
        total += stops(s);
      }
      const mine = flow.find(s => s.change.path === r.path),
        [lo, hi] = r.anchor !== null && mine ? [start, start + stops(mine) - 1] : [0, total - 1];
      this.place(r, flow, Math.min(Math.max(this.position(r, flow) + delta, lo), hi));
    };
    if (r.part === "tree" && !r.tree_hidden) {
      r.tree_free = false;
      const rows = this.listRows(r, paths, now.edited),
        i = Math.max(
          0,
          rows.findIndex(row => row.id === r.tree_sel),
        ),
        row = rows[i];
      const goTo = (j: number) => {
        const next = rows[Math.min(Math.max(j, 0), rows.length - 1)];
        if (!next) return;
        r.tree_sel = next.id;
        if (next.kind === "all") this.showAll(r);
        else if (next.kind === "file" && (r.all || next.path !== r.path)) this.choose(r, next.path, paths);
      };
      if (named === "down" || text === "j") return (goTo(i + 1), { kind: "none" });
      if (named === "up" || text === "k") return (goTo(i - 1), { kind: "none" });
      if (named === "enter" || named === "right") {
        if (row?.kind === "dir") {
          if (named === "enter") r.toggled = tree.setOpen(r.toggled, row, !row.open);
          else if (!row.open) r.toggled = tree.setOpen(r.toggled, row, true);
          else goTo(i + 1);
        } else if (row) r.part = "diff";
        return { kind: "none" };
      }
      if (named === "left") {
        if (row?.kind === "dir" && row.open) r.toggled = tree.setOpen(r.toggled, row, false);
        else if (row)
          for (let j = i - 1; j >= 0; j--)
            if (rows[j].kind === "dir" && rows[j].depth < row.depth) {
              r.tree_sel = rows[j].id;
              break;
            }
        return { kind: "none" };
      }
    }
    if (named === "ctrl_d" || named === "ctrl_u") {
      move((named === "ctrl_d" ? 1 : -1) * Math.max(1, Math.floor(this.page / 2)));
      return { kind: "none" };
    }
    switch (named ?? text) {
      case "tab":
      case "shift_tab":
        this.focusPart(r, r.part === "tree" || r.tree_hidden ? "diff" : "tree");
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "up":
      case "k":
        move(-1);
        break;
      // Space and - page as in tig.
      case "page_down":
      case " ":
        move(Math.max(1, this.page - 2));
        break;
      case "page_up":
      case "-":
        move(-Math.max(1, this.page - 2));
        break;
      case "home":
        move(-Infinity);
        break;
      case "end":
        move(Infinity);
        break;
      case "enter":
      case "right": {
        if (r.path && this.isCollapsed(r, now, r.path)) {
          this.collapse(r, now, r.path);
          break;
        }
        if (now.change?.generated && !r.loaded.has(now.change.path)) {
          r.loaded.add(now.change.path);
          this.loadSelected();
          break;
        }
        const unit = units[r.cur];
        if (d && r.path && unit?.kind === "fold") this.openFold(r, r.path, d, unit);
        else if (named === "right" && !r.wrap) r.shift += 8;
        break;
      }
      case "left":
        if (!r.wrap) r.shift = Math.max(0, r.shift - 8);
        break;
      case "]":
      case "[": {
        r.part = "diff";
        if (!r.visual) r.anchor = null;
        if (r.all) {
          this.hunk(r, flow, text === "]" ? 1 : -1);
          break;
        }
        const starts = d ? diff.hunkStarts(d, units) : [];
        const next = named === null && text === "]" ? starts.find(s => s > r.cur) : starts.filter(s => s < r.cur).pop();
        if (next !== undefined) {
          r.cur = next;
          r.free = false;
        } else if (text === "]") toFile(at + 1);
        else if (at > 0) {
          toFile(at - 1);
          r.cur = Number.MAX_SAFE_INTEGER;
        }
        break;
      }
      case "f":
        toFile(at + 1);
        break;
      case "F":
        toFile(at - 1);
        break;
      case "x":
        if (r.all && r.path) this.collapse(r, now, r.path);
        break;
      case "w":
        r.wrap = !r.wrap;
        r.shift = 0;
        break;
      case "v":
        r.part = "diff";
        r.anchor = r.anchor === null ? r.cur : null;
        r.visual = true;
        break;
      // Shift and an arrow select as a drag does: from where the cursor was, back to it clears.
      case "select_up":
      case "select_down":
        r.part = "diff";
        if (r.anchor === null) [r.anchor, r.visual] = [r.cur, false];
        move(named === "select_down" ? 1 : -1, true);
        if (r.anchor === r.cur) r.anchor = null;
        break;
      case "c":
        r.part = "diff";
        if (d && now.change) this.startCompose(r, d, units, now.change.path, revOf(now.source));
        break;
      case "e": {
        const n = d ? this.noteAt(r, d, units, now) : null;
        if (n && d) {
          const range = this.rangeOf(r, d, units, n) ?? [r.cur, r.cur];
          r.compose = {
            path: n.path,
            rev: n.rev,
            side: n.side,
            start: n.start,
            end: n.end,
            snippet: n.snippet,
            area: new textArea.TextArea(n.text),
            edit: n.id,
            range,
          };
        } else r.status = { text: i18n.t`No note on this line. c adds one.`, warm: false };
        break;
      }
      case "d": {
        const n = d ? this.noteAt(r, d, units, now) : null;
        if (n) {
          r.notes = r.notes.filter(x => x !== n);
          const location = notes.location(n);
          r.status = { text: i18n.t`Deleted the note on ${location}.`, warm: false };
        }
        break;
      }
      case "n":
      case "N":
        if (!r.visual) r.anchor = null;
        this.nextNote(r, d, units, text === "n" ? 1 : -1);
        break;
      case "l":
        r.list = { at: 0 };
        break;
      case "/":
        if (d || r.all) {
          r.find = { query: new textArea.TextArea("", false), hits: [], by_row: new Map(), at: -1 };
          r.part = "diff";
        }
        break;
      case "s":
      case "y":
        return this.send(r, text === "y");
      case "u":
        this.setScope(r, "uncommitted");
        break;
      case "a":
        this.setScope(r, "all");
        break;
      case "o":
        this.setSort(r, r.sort === "name" ? "edited" : "name");
        break;
      case "O":
        r.reversed = !r.reversed;
        break;
      case "p":
        this.pinned = !this.pinned;
        break;
      case "g":
        if (r.pick && r.scope !== "commits") this.setScope(r, "commits");
        else this.openPicker(r, now.co);
        break;
      case "G":
        this.openPicker(r, now.co);
        break;
      case "z":
        r.tree_hidden = !r.tree_hidden;
        if (r.tree_hidden) r.part = "diff";
        break;
      case "<":
      case ">":
        this.tree_rows = Math.max(Math.min(this.tree_rows + (text === "<" ? 2 : -2), 30), 3);
        this.resized(this.tree_rows);
        break;
      case "?":
        r.keys = true;
        break;
      case "q":
        return { kind: "hide" };
      case "escape":
        if (r.anchor !== null) r.anchor = null;
        else return { kind: "leave" };
        break;
      default:
        break;
    }
    return { kind: "none" };
  }
  private pick(r: Review, hash: string): void {
    r.pick = hash;
    r.picker = null;
    r.part = "diff";
    this.setScope(r, "commits");
  }
  private openFold(r: Review, path: string, d: diff.FileDiff, unit: diff.Unit): void {
    const opened = new Set(r.opened.get(path) ?? []);
    opened.add(diff.foldAnchor(d, unit));
    r.opened.set(path, opened);
  }
  private startCompose(r: Review, d: diff.FileDiff, units: diff.Unit[], path: string, rev: notes.Rev): void {
    if (units.length === 0) return;
    const a = r.anchor === null ? r.cur : Math.min(r.anchor, r.cur),
      b = r.anchor === null ? r.cur : Math.max(r.anchor, r.cur);
    const rows: diff.Row[] = [];
    for (let i = a; i <= b; i++) {
      const unit = units[i];
      if (unit?.kind === "row") rows.push(d.rows[unit.row]);
    }
    const anchor = notes.anchor(d, rows);
    if (!anchor) {
      r.status = { text: i18n.t`Folded lines take no notes; → opens them.`, warm: false };
      return;
    }
    r.compose = { path, rev, ...anchor, area: new textArea.TextArea(), edit: null, range: [a, b] };
    r.anchor = null;
  }
  private noteAt(r: Review, d: diff.FileDiff, units: diff.Unit[], now: { source: git.Source }): notes.Note | null {
    const unit = units[r.cur];
    if (unit?.kind !== "row" || !r.path) return null;
    const row = d.rows[unit.row],
      rev = revOf(now.source);
    return r.notes.find(n => n.path === r.path && notes.sameRev(n.rev, rev) && notes.covers(n, row)) ?? null;
  }
  private rangeOf(r: Review, d: diff.FileDiff, units: diff.Unit[], n: notes.Note): [number, number] | null {
    let a = -1,
      b = -1;
    units.forEach((u, i) => {
      if (u.kind === "row" && notes.covers(n, d.rows[u.row])) {
        if (a < 0) a = i;
        b = i;
      }
    });
    return a < 0 ? null : [a, b];
  }
  private jumpToNote(r: Review, n: notes.Note): void {
    const wanted: Scope = n.rev.kind === "commit" ? "commits" : r.scope === "commits" ? "all" : r.scope;
    if (n.rev.kind === "commit") r.pick = n.rev.hash;
    if (wanted !== r.scope) r.scope = wanted;
    if (n.path !== r.path) r.anchor = null;
    r.collapsed.set(n.path, false);
    r.path = n.path;
    r.part = "diff";
    r.free = false;
    r.tree_free = false;
    const co = this.checkout();
    const listed = co && this.listing(co, r);
    if (!r.all) {
      if (listed)
        r.toggled = tree.reveal(
          listed.changes.map(c => c.path),
          r.toggled,
          n.path,
        );
      r.tree_sel = "f:" + n.path;
    }
    const file = co && listed ? co.files.get(`${sourceKey(listed.source)}\0${n.path}`) : undefined;
    if (file?.loaded.kind === "diff") {
      const range = this.rangeOf(r, file.loaded.diff, this.units(r, file.loaded.diff, n.path), n);
      if (range) r.cur = range[0];
    }
    void this.refresh();
  }
  private nextNote(r: Review, d: diff.FileDiff | null, units: diff.Unit[], step: 1 | -1): void {
    if (r.notes.length === 0) {
      r.status = { text: i18n.t`No notes yet. v selects lines, c comments.`, warm: false };
      return;
    }
    const sorted = r.notes.slice().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.start - b.start));
    const unit = units[r.cur],
      line = d && unit?.kind === "row" ? diff.FileDiff.number(d.rows[unit.row]) : 0,
      path = r.path ?? "";
    const after = sorted.filter(n => n.path > path || (n.path === path && n.start > line)),
      before = sorted.filter(n => n.path < path || (n.path === path && n.start < line));
    this.jumpToNote(r, step > 0 ? (after[0] ?? sorted[0]) : (before[before.length - 1] ?? sorted[sorted.length - 1]));
  }
  /** Finds the query in every section read, in the flow's order. */
  private findIndex(r: Review, sections: Section[]): void {
    const f = r.find;
    if (!f) return;
    f.hits = [];
    f.by_row = new Map();
    f.at = -1;
    const query = f.query.text.toLowerCase();
    if (!query) return;
    for (const { change, d } of sections)
      d?.rows.forEach((row, i) => {
        const line = d.text(row).toLowerCase();
        for (
          let at = line.indexOf(query), guard = 0;
          at >= 0 && guard < 100;
          at = line.indexOf(query, at + query.length), guard++
        ) {
          f.hits.push({ path: change.path, row: i, start: at, end: at + query.length });
          const key = `${change.path}\0${i}`,
            ranges = f.by_row.get(key) ?? [];
          ranges.push([at, at + query.length]);
          f.by_row.set(key, ranges);
        }
      });
  }
  private findStep(r: Review, sections: Section[], step: 1 | -1): void {
    const f = r.find;
    if (!f || !r.path || f.hits.length === 0) return;
    const files = new Map(sections.map((s, i) => [s.change.path, i])),
      file = files.get(r.path) ?? 0,
      here = sections[file]?.units[r.cur],
      row = here ? (here.kind === "row" ? here.row : here.start) : 0;
    // A hit before (-1), on (0) or after (1) the cursor's row.
    const side = (h: Find["hits"][number]) => {
      const at = files.get(h.path) ?? 0;
      return Math.sign(at === file ? h.row - row : at - file);
    };
    let next = -1;
    if (step > 0) {
      next = f.hits.findIndex((h, i) => side(h) > 0 || (side(h) === 0 && i > f.at));
      if (next < 0) next = 0;
    } else {
      for (let i = f.hits.length - 1; i >= 0; i--)
        if (side(f.hits[i]) < 0 || (side(f.hits[i]) === 0 && f.at >= 0 && i < f.at)) {
          next = i;
          break;
        }
      if (next < 0) next = f.hits.length - 1;
    }
    f.at = next;
    const hit = f.hits[next],
      d = sections[files.get(hit.path) ?? -1]?.d;
    if (!d) return;
    let units = this.units(r, d, hit.path);
    r.collapsed.set(hit.path, false);
    const fold = units.find(u => u.kind === "fold" && hit.row >= u.start && hit.row < u.end);
    if (fold) {
      this.openFold(r, hit.path, d, fold);
      units = this.units(r, d, hit.path);
    }
    const index = units.findIndex(u => u.kind === "row" && u.row === hit.row);
    if (index >= 0) {
      if (hit.path !== r.path) r.anchor = null;
      r.path = hit.path;
      r.cur = index;
      r.free = false;
    }
    if (!r.wrap)
      r.shift = Math.max(0, sourceSlice(d.text(d.rows[hit.row]).slice(0, hit.start), 0, Infinity).width - 10);
  }
  /** Where notes go: the focused pane while pinned, else the reviewed one. */
  private destination(): Target | null {
    return this.pinned && this.dest ? this.dest : this.target;
  }
  private send(r: Review, copy: boolean): Effect {
    const from = this.target,
      to = this.destination();
    if (!from || !to) return { kind: "none" };
    if (r.notes.length === 0) {
      r.status = { text: i18n.t`No notes yet. v selects lines, c comments.`, warm: false };
      return { kind: "none" };
    }
    const sent = r.notes,
      count = sent.length,
      name = to.name,
      text = notes.format(sent);
    r.notes = [];
    r.status = {
      text: copy
        ? count === 1
          ? i18n.t`Copied ${count} note.`
          : i18n.t`Copied ${count} notes.`
        : count === 1
          ? i18n.t`Sent ${count} note to ${name}. Enter there submits them.`
          : i18n.t`Sent ${count} notes to ${name}. Enter there submits them.`,
      warm: false,
    };
    return copy
      ? { kind: "copy", text, notes: sent }
      : { kind: "send", pane: to.pane, from: from.pane, text, notes: sent };
  }
  /** A send or copy that failed puts its notes back, ahead of any written since. */
  restore(pane: number, sent: notes.Note[], why: string): void {
    const r = this.review(pane);
    r.notes = [...sent, ...r.notes];
    r.status = { text: why, warm: true };
  }
  /** One step up to the file list or down to the diff under it, as Tab
   * moves between them; false past either. */
  move(to: Direction): boolean {
    const t = this.target;
    if (!t) return false;
    const r = this.review(t.pane),
      in_tree = r.part === "tree" && !r.tree_hidden;
    if (to === "up" && !in_tree && !r.tree_hidden) this.focusPart(r, "tree");
    else if (to === "down" && in_tree) this.focusPart(r, "diff");
    else return false;
    return true;
  }
  /** Gives keys to the file list, on the file shown, or to the diff. */
  private focusPart(r: Review, part: Part): void {
    r.part = part;
    if (part === "tree" && (r.all || r.path)) r.tree_sel = r.all ? "all" : "f:" + r.path;
    r.tree_free = false;
  }
  /** What the last click asked of the viewer, once. */
  takeEffect(): Effect {
    const effect = this.pending;
    this.pending = { kind: "none" };
    return effect;
  }

  /** A press, drag, move or wheel inside the panel. */
  mouse(kind: "press" | "drag" | "move" | "release" | "wheel_up" | "wheel_down", x: number, y: number): void {
    if (kind === "release") {
      this.selecting = null;
      this.placing = false;
      if (this.splitting) {
        this.splitting = false;
        this.resized(this.tree_rows);
      }
      return;
    }
    if (this.splitting) {
      const split = this.split;
      if (kind === "drag" && split) this.tree_rows = Math.max(2, Math.min(y - split.top, split.room));
      return;
    }
    const under = [...this.hits].reverse().filter(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h),
      hit = under[0];
    const t = this.target;
    if (!t) return;
    const r = this.review(t.pane);
    // A click anywhere closes the keys.
    if (r.keys) {
      if (kind === "press") r.keys = false;
      return;
    }
    // In the note box a press places the caret and a drag selects.
    const box = this.compose_at;
    if (r.compose && box && (this.placing || kind === "press")) {
      const inside = y >= box.y && y < box.y + box.rows && x >= box.x - 1 && x <= box.x + box.w;
      if (kind === "press" && inside) {
        r.compose.area.place(y - box.y, x - box.x);
        this.placing = true;
        return;
      }
      if (kind === "drag" && this.placing) {
        r.compose.area.place(y - box.y, x - box.x, true);
        return;
      }
    }
    const co = this.checkout();
    if (r.picker && co) {
      const menu = this.menu,
        row = menu ? dropdown.hit(menu.rect, menu.count, x, y, menu.heading) : null,
        list = this.pickable(co);
      if (kind === "wheel_up" || kind === "wheel_down")
        r.picker.at = Math.min(
          Math.max(r.picker.at + (kind === "wheel_down" ? 1 : -1), 0),
          Math.max(0, list.length - 1),
        );
      else if (menu && row !== null) {
        r.picker.at = menu.first + row;
        if (kind === "press" && list[r.picker.at]) this.pick(r, list[r.picker.at].hash);
      } else if (kind === "press") {
        // A click outside closes the menu and lands as usual; on its own chip, closing is all it does.
        const chip = this.commits_chip,
          on_chip = chip !== null && y === chip.y && x >= chip.x && x < chip.x + chip.w;
        r.picker = null;
        if (!on_chip) hit?.act?.();
      }
      return;
    }
    if (kind === "move") return;
    if (kind === "press" && y === this.split?.y) {
      this.splitting = true;
      return;
    }
    if (kind === "wheel_up" || kind === "wheel_down") {
      const step = kind === "wheel_down" ? 3 : -3;
      // The area under the pointer scrolls, past the rows that click inside it.
      if (under.find(h => h.wheel)?.wheel === "tree") {
        r.tree_top = Math.max(0, r.tree_top + step);
        r.tree_free = true;
      } else {
        r.top = Math.max(0, r.top + step);
        r.free = true;
      }
      return;
    }
    if (kind === "drag") {
      // A selection keeps to the file it started in.
      if (this.selecting && hit?.unit !== undefined && hit.path === this.selecting.path) {
        r.anchor = hit.unit === this.selecting.from ? null : this.selecting.from;
        r.cur = hit.unit;
      }
      return;
    }
    if (!hit) return;
    if (hit.unit !== undefined) {
      r.part = "diff";
      r.anchor = null;
      if (hit.path !== undefined) r.path = hit.path;
      r.cur = hit.unit;
      r.free = false;
      this.selecting = { from: hit.unit, path: r.path };
      r.visual = false;
    }
    hit.act?.();
  }

  // ---------- drawing ----------

  /** Draws the panel; `focused` while it has the keyboard. */
  draw(w: Writer, x: number, y: number, width: number, height: number, focused: boolean): void {
    const c = new Canvas(x, y, width, height),
      colors = palette.colors,
      keys = this.keysOpen,
      edge = focused ? palette.outline : colors.line;
    // A pinned panel stands apart from the panes it no longer follows.
    for (let row = 0; row < height; row++) c.put(0, row, this.pinned ? "┃" : "│", keys ? fade(edge) : edge, null);
    const inner = new Canvas(x + 1, y, width - 1, height);
    this.drawInside(inner, focused);
    if (keys) this.drawKeys(inner);
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width - 1; col++) c.cells[row][col + 1] = inner.cells[row][col];
    c.flush(w);
    this.hits = inner.hits;
    this.drawCommitMenu(w, x, y, width, height);
  }
  /** The ghost, over the panel or the panes: dimmed past a dashed edge, with
   * nothing to click, and what the followed review last drew kept for it. */
  drawGhost(w: Writer, x: number, y: number, width: number, height: number): void {
    if (this.next_ghost && this.settled(this.next_ghost)) {
      this.reviews.delete(this.ghost!.target.pane);
      [this.ghost, this.next_ghost] = [this.next_ghost, null];
    }
    if (!this.ghost) return;
    const followed = this.target,
      kept = [this.split, this.commits_chip, this.menu, this.page, this.compose_at] as const;
    this.target = this.ghost!.target;
    try {
      const c = new Canvas(x, y, width, height),
        inner = new Canvas(x + 1, y, width - 1, height);
      this.drawInside(inner, false);
      inner.fade();
      for (let row = 0; row < height; row++) {
        c.put(0, row, "┆", palette.colors.faint, null);
        for (let col = 0; col < width - 1; col++) c.cells[row][col + 1] = inner.cells[row][col];
      }
      c.flush(w);
    } finally {
      this.target = followed;
      [this.split, this.commits_chip, this.menu, this.page, this.compose_at] = kept;
    }
  }
  /** The branch's commits in Corgi's dropdown, hanging from the commits chip:
   * the reviewed one ticked, those already on the base dimmed, and what each
   * touched before it's opened. */
  private drawCommitMenu(w: Writer, x: number, y: number, width: number, height: number): void {
    this.menu = null;
    const t = this.target,
      co = this.checkout(),
      chip = this.commits_chip;
    if (!t || !co || !chip) return;
    const r = this.review(t.pane);
    if (!r.picker) return;
    const branch = co.base?.name ?? "";
    const list = this.pickable(co),
      columns = commitColumns(list, Date.now() / 1000),
      heading = list.length ? { text: i18n.t`commit`, note: columns.heading } : undefined;
    const choices: dropdown.Choice[] = list.map((cm, i) => ({
      text: `${cm.hash.slice(0, 7)}  ${cm.subject}`,
      note: columns.notes[i].map(([part]) => part).join(""),
      runs: columns.notes[i],
      current: r.scope === "commits" && r.pick === cm.hash,
      hovered: i === r.picker!.at,
      dim: false,
    }));
    if (choices.length === 0)
      choices.push({
        text: co.base ? i18n.t`No commits since ${branch}` : i18n.t`No commits yet`,
        note: "",
        current: false,
        hovered: false,
        dim: true,
      });
    const top = chip.y + 1,
      rows = Math.max(1, Math.min(choices.length, y + height - top - 3 - (heading ? 1 : 0)));
    const p = r.picker;
    if (p.at < p.top) p.top = p.at;
    if (p.at >= p.top + rows) p.top = p.at - rows + 1;
    p.top = Math.min(Math.max(0, p.top), Math.max(0, choices.length - rows));
    const shown = choices.slice(p.top, p.top + rows),
      menu_w = Math.min(dropdown.width(shown, heading), width - 2),
      // Under the tab from its left edge when it fits, else ending under its right edge.
      left = Math.max(x, chip.x + menu_w <= x + width ? chip.x : chip.x + chip.w - menu_w),
      rect = new Rect(left, top, menu_w, rows + 2 + (heading ? 1 : 0));
    dropdown.draw(w, rect, shown, heading);
    this.menu = { rect, first: p.top, count: shown.length, heading: heading !== undefined };
  }
  private drawInside(c: Canvas, focused: boolean): void {
    const colors = palette.colors,
      t = this.target;
    if (focused) c.put(0, 0, "▌", colors.accent);
    let col = c.text(1, 0, i18n.t`Review`, colors.strong, null, true) + 1;
    if (t) {
      // p's keycap, as in the footer, and "pin", lit while pinned.
      const start = col;
      col = c.text(col, 0, "p", colors.strong, colors.line, true);
      col = c.text(col + 1, 0, i18n.t`pin`, this.pinned ? colors.accent : colors.muted, null, this.pinned) + 1;
      c.hit(start, 0, col - 1 - start, 1, { act: () => (this.pinned = !this.pinned) });
    }
    if (!t) {
      c.text(1, 2, i18n.t`Focus a pane to review its checkout.`, colors.muted);
      return;
    }
    const r = this.review(t.pane);
    const root = this.roots.get(t.cwd),
      found = root ? this.checkouts.get(root) : undefined,
      co = found?.read ? found : null;
    // Scope tabs, a row of buttons with the chosen one lit; at the right of
    // the title when they fit beside it, else on a row of their own.
    const tabs: { label: string; on: boolean; open?: boolean; act: () => void }[] = [];
    if (co) {
      const caret = r.picker ? "▴" : "▾";
      const count = co.commits.length;
      tabs.push(
        { label: i18n.t`all`, on: r.scope === "all", act: () => this.setScope(r, "all") },
        { label: i18n.t`uncommitted`, on: r.scope === "uncommitted", act: () => this.setScope(r, "uncommitted") },
        {
          label:
            r.scope === "commits" && r.pick
              ? `${r.pick.slice(0, 7)} ${caret}`
              : co.base
                ? i18n.t`commits ${caret} ${count}`
                : i18n.t`commits ${caret}`,
          on: r.scope === "commits",
          open: r.picker !== null,
          act: () => (r.picker ? (r.picker = null) : this.openPicker(r, co)),
        },
      );
    }
    const tabs_w = tabs.reduce((s, tab) => s + displayWidth(tab.label) + 2, 0) + Math.max(0, tabs.length - 1),
      beside = col + tabs_w + 1 <= c.w,
      tabs_row = beside ? 0 : 1,
      head = tabs_row + 1;
    let right = beside && tabs.length ? c.w - 1 - tabs_w : c.w;
    let tx = beside ? right : 1;
    this.commits_chip = null;
    for (const tab of tabs) {
      if (tab !== tabs[0]) c.put(tx++, tabs_row, "│", colors.line, colors.surface);
      const s = ` ${tab.label} `;
      c.text(
        tx,
        tabs_row,
        s,
        tab.on || tab.open ? colors.strong : colors.muted,
        tab.on ? colors.selected : colors.surface,
        tab.on,
      );
      c.hit(tx, tabs_row, displayWidth(s), 1, { act: tab.act });
      if (tab === tabs[2]) this.commits_chip = { x: c.x + tx, y: c.y + tabs_row, w: displayWidth(s) };
      tx += displayWidth(s);
    }
    if (r.notes.length) {
      const label = plural(r.notes.length, "note");
      if (right - displayWidth(label) - 2 > col) {
        right -= displayWidth(label) + 2;
        c.text(right, 0, label, colors.warm, null, true);
        c.hit(right, 0, displayWidth(label), 1, { act: () => (r.list = { at: 0 }) });
      }
    }
    // Pinned elsewhere, where the notes go.
    const to = this.destination();
    if (to && to.pane !== t.pane) c.text(col, 0, `→ ${to.name}`, colors.warm, null, false, right - col - 1);
    if (root === undefined) {
      c.text(1, 2, i18n.t`Reading git…`, colors.faint);
      return;
    }
    if (root === null) {
      c.text(1, 2, i18n.t`Not in a git checkout:`, colors.muted);
      c.text(1, 3, t.cwd || i18n.t`(no directory)`, colors.faint);
      return;
    }
    if (!co) {
      c.text(1, 2, i18n.t`Reading git…`, colors.faint);
      return;
    }
    const own = co.commits.length;
    const listed = this.listing(co, r);
    let room = c.w - 2;
    if (listed && listed.changes.length) {
      const adds = listed.changes.reduce((s, ch) => s + (ch.adds ?? 0), 0),
        dels = listed.changes.reduce((s, ch) => s + (ch.dels ?? 0), 0);
      const parts: [string, palette.Rgb][] = [
        [plural(listed.changes.length, "file") + " ", colors.faint],
        ["+" + adds.toLocaleString("en-US"), colors.accent],
        [" −" + dels.toLocaleString("en-US"), colors.hot],
      ];
      const len = parts.reduce((s, p) => s + displayWidth(p[0]), 0);
      if (c.w - 1 - len > 20) {
        let px = c.w - 1 - len;
        room = px - 3;
        for (const [s, fg] of parts) px = c.text(px, head, s, fg);
      }
    }
    const name = co.branch ?? "HEAD";
    // What the scope compares; the part after the names goes first when it's tight.
    let parts: [string, palette.Rgb][],
      extra: [string, palette.Rgb] | null = null;
    if (co.error) parts = [[`git: ${co.error}`, colors.hot]];
    else if (r.scope === "commits") {
      const picked = co.commits.find(cm => cm.hash === r.pick);
      parts = picked
        ? [
            [picked.hash.slice(0, 7) + "  ", colors.faint],
            [picked.subject, colors.text],
          ]
        : [[i18n.t`No commit picked yet. g opens the menu.`, colors.muted]];
    } else if (r.scope === "uncommitted" || !co.base)
      parts = [
        [name, colors.text],
        [i18n.t` vs `, colors.faint],
        ["HEAD", colors.text],
      ];
    else {
      const working = co.listings.get(sourceKey({ kind: "worktree", against: co.head ?? git.empty_tree }));
      parts = [
        [name, colors.text],
        [i18n.t` vs `, colors.faint],
        [co.base.name, colors.text],
      ];
      extra = [
        `  ${own ? plural(own, "commit") : i18n.t`no commits`}${working?.changes.length ? i18n.t` + uncommitted` : ""}`,
        colors.faint,
      ];
    }
    const width = (list: [string, palette.Rgb][]) => list.reduce((s, [part]) => s + displayWidth(part), 0);
    if (extra && width(parts) + width([extra]) <= room) parts.push(extra);
    let dx = 1;
    for (const [part, fg] of parts) dx = c.text(dx, head, part, fg, null, false, room + 1 - dx);
    for (let i = 0; i < c.w; i++) c.put(i, head + 1, "─", colors.line);
    // How the files are listed, on the rule above them.
    if (listed?.edited && listed.changes.length && !r.tree_hidden) {
      const sorts: ["name" | "edited", string][] = [
        ["name", i18n.t`name`],
        ["edited", i18n.t`last edit`],
      ];
      // Up is A to Z or oldest first; each sort starts the way it's most read.
      const arrow = (r.sort === "name") !== r.reversed ? " ↑" : " ↓";
      let sx =
        c.w -
        2 -
        sorts.reduce((s, [, label]) => s + displayWidth(label), 0) -
        arrow.length -
        displayWidth(i18n.t` sort: `) -
        " · ".length -
        1;
      sx = c.text(sx, head + 1, i18n.t` sort: `, colors.faint);
      for (const [sort, label] of sorts) {
        if (sort !== "name") sx = c.text(sx, head + 1, " · ", colors.faint);
        const on = r.sort === sort,
          shown = on ? label + arrow : label;
        c.hit(sx, head + 1, displayWidth(shown), 1, { act: () => this.setSort(r, sort) });
        sx = c.text(sx, head + 1, shown, on ? colors.text : colors.faint, null, on);
      }
      c.put(sx, head + 1, " ", colors.line);
    }
    let ty = head + 2;
    const changes = listed?.changes ?? [];
    const paths = changes.map(ch => ch.path);
    this.split = null;
    if (!listed) {
      c.text(2, ty, r.scope === "commits" ? i18n.t`Pick a commit with g.` : i18n.t`Reading git…`, colors.muted);
      ty += 1;
    } else if (changes.length === 0) {
      c.text(
        2,
        ty,
        r.scope === "all"
          ? i18n.t`Nothing changed on ${name} yet.`
          : r.scope === "uncommitted"
            ? i18n.t`No uncommitted changes.`
            : i18n.t`This commit changed nothing.`,
        colors.muted,
      );
      ty += 1;
    } else if (!r.tree_hidden) {
      // The rule under the list drags its height, keeping some of the diff in view.
      const room = Math.max(2, c.h - ty - 2 - min_diff_rows),
        top = ty;
      ty = this.drawTree(c, r, changes, paths, listed.edited, ty, room, focused);
      this.split = { y: c.y + ty, top: c.y + top, room };
    }
    for (let i = 0; i < c.w; i++) c.put(i, ty, "─", colors.line);
    const now = this.current();
    // On "All files" each file has its own heading.
    if (now?.change && !r.all) {
      const ch = now.change;
      const label = ch.from ? `${ch.from} → ${ch.path}` : ch.path;
      const end = c.text(2, ty, ` ${label} `, colors.strong, null, true, c.w - 16);
      const origin = this.originOf(co, r, now.source, ch);
      if (origin && end + displayWidth(origin) + 3 < c.w)
        c.text(c.w - displayWidth(origin) - 3, ty, ` ${origin} `, colors.faint);
    }
    if (r.tree_hidden && changes.length) {
      const label = i18n.t` z: files `;
      c.text(c.w - displayWidth(label) - 2, ty, label, colors.faint);
    }
    const dy = ty + 1,
      dh = c.h - 1 - dy;
    this.page = dh;
    if (now && dh > 0) this.drawDiff(c, r, now, dy, dh, focused);
    if (r.list) this.drawList(c, r, dy, dh, now?.source ?? null);
    this.drawFooter(c, r, now, focused);
  }
  /** Where a file's change is: the commit reviewed, untracked, or for the
   * branch in its commits, the working copy, or both. */
  private originOf(co: Checkout, r: Review, source: git.Source, ch: git.Change): string {
    return source.kind === "commit"
      ? source.hash.slice(0, 7)
      : ch.kind === "untracked"
        ? i18n.t`untracked`
        : r.scope === "uncommitted"
          ? i18n.t`working copy`
          : this.origin(co, ch.path);
  }
  /** Where a branch file's change is: in its commits, the working copy, or both. */
  private origin(co: Checkout, path: string): string {
    const working = co.listings.get(`w:${co.head ?? git.empty_tree}`);
    if (!working) return "";
    const uncommitted = working.changes.some(ch => ch.path === path),
      committed = co.commits.length > 0 && this.committed(co, path, working.changes);
    return committed && uncommitted
      ? i18n.t`committed + working copy`
      : uncommitted
        ? i18n.t`working copy`
        : i18n.t`committed`;
  }
  /** Whether the branch's commits touched `path`: it differs from the base
   * in a way the working copy alone doesn't explain. */
  private committed(co: Checkout, path: string, working: git.Change[]): boolean {
    const branch = co.base ? co.listings.get(`w:${co.base.merge_base}`) : undefined;
    const ours = branch?.changes.find(ch => ch.path === path),
      wc = working.find(ch => ch.path === path);
    if (!ours) return false;
    if (!wc) return true;
    return ours.adds !== wc.adds || ours.dels !== wc.dels || ours.kind !== wc.kind;
  }
  private drawTree(
    c: Canvas,
    r: Review,
    changes: git.Change[],
    paths: string[],
    edited: Map<string, number> | null,
    ty: number,
    room: number,
    focused: boolean,
  ): number {
    const colors = palette.colors,
      rows = this.listRows(r, paths, edited),
      now = Date.now(),
      height = Math.max(1, Math.min(this.tree_rows, rows.length, room));
    let sel = rows.findIndex(row => row.id === r.tree_sel);
    if (sel < 0) sel = rows.findIndex(row => row.id === (r.all ? "all" : "f:" + r.path));
    if (sel >= 0 && !r.tree_free) {
      if (sel < r.tree_top) r.tree_top = sel;
      if (sel >= r.tree_top + height) r.tree_top = sel - height + 1;
    }
    r.tree_top = Math.min(Math.max(0, r.tree_top), Math.max(0, rows.length - height));
    c.hit(0, ty, c.w, height, { wheel: "tree" });
    const byPath = new Map(changes.map(ch => [ch.path, ch]));
    rows.slice(r.tree_top, r.tree_top + height).forEach((row, i) => {
      const y = ty + i,
        on = i + r.tree_top === sel,
        active = on && focused && r.part === "tree",
        bg = active ? colors.selected : on ? palette.mix(colors.bg, colors.selected, 50) : null;
      c.fill(y, bg);
      if (active) c.put(0, y, "▌", colors.accent, bg);
      const indent = 1 + row.depth * 2;
      const right: [string, palette.Rgb][] = [];
      if (row.kind === "all") {
        c.text(indent, y, "≡", on ? colors.strong : colors.muted, bg, true);
        c.text(indent + 2, y, i18n.t`All files`, on ? colors.strong : colors.text, bg, on);
        c.hit(0, y, c.w, 1, {
          act: () => {
            r.part = "tree";
            this.showAll(r);
          },
        });
      } else if (row.kind === "dir") {
        c.text(indent, y, row.open ? "▾" : "▸", colors.faint, bg);
        if (!row.open) {
          let adds = 0,
            dels = 0;
          for (const p of row.files) {
            adds += byPath.get(p)?.adds ?? 0;
            dels += byPath.get(p)?.dels ?? 0;
          }
          right.push(
            [plural(row.files.length, "file"), colors.faint],
            ["+" + adds.toLocaleString("en-US"), colors.accent],
            ["−" + dels.toLocaleString("en-US"), colors.hot],
          );
        }
        const room = c.w - 1 - right.reduce((s, p) => s + displayWidth(p[0]) + 1, 0) - (indent + 2);
        c.text(indent + 2, y, row.name + "/", on ? colors.strong : colors.muted, bg, on, room);
        c.hit(0, y, c.w, 1, {
          act: () => {
            r.part = "tree";
            r.tree_sel = row.id;
            r.toggled = tree.setOpen(r.toggled, row, !row.open);
          },
        });
      } else {
        const ch = byPath.get(row.path)!,
          [letter, fg] = mark(ch),
          // On "All files", the file the cursor is in.
          here = r.all && row.path === r.path;
        c.text(indent, y, letter, fg, bg, true);
        if (r.notes.some(n => n.path === row.path)) right.push(["•", colors.warm]);
        if (ch.binary) right.push([i18n.t`bin`, colors.faint]);
        else {
          if (ch.generated) right.push([i18n.t`gen`, colors.faint]);
          if (ch.adds) right.push(["+" + ch.adds.toLocaleString("en-US"), colors.accent]);
          if (ch.dels) right.push(["−" + ch.dels.toLocaleString("en-US"), colors.hot]);
        }
        const at = edited?.get(row.path);
        if (edited) {
          const elapsed = at === undefined ? "" : age((now - at) / 1000);
          right.push([" ".repeat(Math.max(0, 5 - displayWidth(elapsed))) + elapsed, colors.faint]);
        }
        const room = c.w - 1 - right.reduce((s, p) => s + displayWidth(p[0]) + 1, 0) - (indent + 2);
        const end = c.text(indent + 2, y, row.name, on || here ? colors.strong : colors.text, bg, on, room);
        if (row.dir) c.text(end + 2, y, row.dir, colors.faint, bg, false, indent + 2 + room - end - 2);
        c.hit(0, y, c.w, 1, {
          act: () => {
            r.part = "tree";
            r.tree_sel = row.id;
            if (r.all || r.path !== row.path) this.choose(r, row.path, paths);
          },
        });
      }
      let px = c.w - right.reduce((s, p) => s + displayWidth(p[0]) + 1, 0);
      for (const [s, fg] of right) px = c.text(px, y, s, fg, bg) + 1;
    });
    // The rule under the list takes its row, so a thumb at the edge says where the list is.
    if (rows.length > height) {
      const thumb = Math.max(1, Math.round((height * height) / rows.length)),
        at = ty + Math.round(((height - thumb) * r.tree_top) / Math.max(1, rows.length - height));
      for (let j = 0; j < thumb; j++) c.put(c.w - 1, at + j, "▐", colors.line);
    }
    return ty + height;
  }
  private notice(c: Canvas, dy: number, lines: [string, palette.Rgb][], act?: () => void): void {
    const colors = palette.colors,
      width = Math.min(c.w - 4, Math.max(...lines.map(l => displayWidth(l[0]))) + 6),
      height = lines.length + 2;
    for (let row = 0; row < height; row++) {
      c.fill(dy + 1 + row, colors.surface, 2, 2 + width);
      c.put(2, dy + 1 + row, row === 0 ? "╭" : row === height - 1 ? "╰" : "│", colors.line, colors.surface);
      c.put(1 + width, dy + 1 + row, row === 0 ? "╮" : row === height - 1 ? "╯" : "│", colors.line, colors.surface);
      if (row === 0 || row === height - 1)
        for (let i = 3; i < 1 + width; i++) c.put(i, dy + 1 + row, "─", colors.line, colors.surface);
    }
    lines.forEach(([s, fg], i) => c.text(5, dy + 2 + i, s, fg, colors.surface, false, width - 6));
    if (act) c.hit(2, dy + 1, width, height, { act });
  }
  private drawDiff(c: Canvas, r: Review, now: Now, dy: number, dh: number, focused: boolean): void {
    const colors = palette.colors;
    c.hit(0, dy, c.w, dh, { wheel: "diff" });
    // A file alone without lines to show says why in a box.
    const ch = now.change;
    if (!r.all) {
      if (!ch) return;
      const adds = (ch.adds ?? 0).toLocaleString(i18n.language()),
        dels = (ch.dels ?? 0).toLocaleString(i18n.language());
      if (ch.generated && !r.loaded.has(ch.path))
        return this.notice(
          c,
          dy,
          [
            [i18n.t`Generated file · +${adds} −${dels}`, colors.text],
            [i18n.t`Its diff starts collapsed. Enter loads it.`, colors.faint],
          ],
          () => {
            r.loaded.add(ch.path);
            this.loadSelected();
          },
        );
      const file = now.file;
      if (!file) return void c.text(2, dy + 1, i18n.t`Reading the diff…`, colors.faint);
      const loaded = file.loaded;
      if (loaded.kind === "binary")
        return this.notice(c, dy, [
          [i18n.t`Binary file`, colors.text],
          [i18n.t`No text diff and no line notes.`, colors.faint],
        ]);
      if (loaded.kind === "too_large") {
        const size = (loaded.bytes / 1e6).toFixed(1);
        return this.notice(c, dy, [
          [i18n.t`Too large to show here · ${size} MB`, colors.text],
          [i18n.t`The limit is 2 MB or 50,000 lines.`, colors.faint],
          [i18n.t`git counts +${adds} −${dels}.`, colors.faint],
        ]);
      }
      if (loaded.kind === "failed")
        return this.notice(c, dy, [
          [i18n.t`git couldn't diff this file`, colors.text],
          [loaded.message, colors.faint],
        ]);
    }
    const sections = this.sections(r, now);
    if (sections.length === 0) return;
    const gutter = Math.max(3, ...sections.map(s => s.d?.gutter() ?? 0)),
      code_x = gutter + 2,
      code_w = Math.max(10, c.w - code_x - 1),
      box_x = code_x,
      box_w = c.w - box_x - 1;
    const rev = revOf(now.source);
    const wrapText = (s: string, width: number) => (s ? wrap(s, width) : [""]);
    // The note being written, in the lines its box shows, and where its caret is.
    if (r.compose) r.compose.area.width = box_w - 4;
    const composed = r.compose ? r.compose.area.lines() : [],
      caret = r.compose && focused ? r.compose.area.position() : null;
    this.compose_at = null;
    type Item =
      | { kind: "head"; s: Section; h: number }
      | { kind: "notice"; s: Section; h: number }
      | { kind: "unit"; s: Section; d: diff.FileDiff; unit: diff.Unit; at: number; h: number }
      | { kind: "note"; s: Section; note: notes.Note; h: number }
      | { kind: "compose"; s: Section; h: number };
    const items: Item[] = [],
      // Each file's heading among the items, and its lines with a note.
      heads = new Map<string, number>(),
      noted = new Map<string, Set<string>>();
    for (const s of sections) {
      const path = s.change.path;
      if (path === r.path && r.cur >= stops(s)) r.cur = stops(s) - 1;
      if (r.all) {
        heads.set(path, items.length);
        items.push({ kind: "head", s, h: items.length ? 2 : 1 });
      }
      if (s.collapsed) continue;
      const d = s.d;
      if (!d || s.units.length === 0) {
        if (r.all) items.push({ kind: "notice", s, h: 1 });
        continue;
      }
      const after = new Map<string, notes.Note[]>(),
        lines = new Set<string>();
      for (const n of r.notes) {
        if (n.path !== path || !notes.sameRev(n.rev, rev) || r.compose?.edit === n.id) continue;
        const k = `${n.side}:${n.end}`;
        after.set(k, [...(after.get(k) ?? []), n]);
        for (let line = n.start; line <= n.end; line++) lines.add(`${n.side}:${line}`);
      }
      noted.set(path, lines);
      s.units.forEach((unit, at) => {
        items.push({
          kind: "unit",
          s,
          d,
          unit,
          at,
          h: unit.kind === "fold" || !r.wrap ? 1 : sourceLines(d.text(d.rows[unit.row]), code_w, wrap_cap).length,
        });
        if (unit.kind !== "row") return;
        const row = d.rows[unit.row];
        for (const side of ["new", "old"] as const) {
          const line = notes.lineOn(row, side);
          if (line === 0) continue;
          for (const n of after.get(`${side}:${line}`) ?? [])
            items.push({ kind: "note", s, note: n, h: 2 + wrapText(n.text, box_w - 4).length });
          if (r.compose && r.compose.path === path && r.compose.side === side && r.compose.end === line)
            items.push({ kind: "compose", s, h: 2 + composed.length });
        }
      });
    }
    const ys: number[] = [];
    let total = 0;
    for (const item of items) {
      ys.push(total);
      total += item.h;
    }
    // On "All files" the top row holds the heading of the file scrolled into.
    const lead = r.all ? 1 : 0;
    // A folded file's cursor stop is its heading.
    const cur_item = items.findIndex(
      it =>
        it.s.change.path === r.path &&
        (it.kind === "notice" || (it.kind === "head" && it.s.collapsed) || (it.kind === "unit" && it.at === r.cur)),
    );
    let top = r.top;
    // Files above the top that changed size since the last draw don't move it.
    const landmark = r.landmark ? heads.get(r.landmark.path) : undefined;
    if (r.landmark && landmark !== undefined) top += ys[landmark] - r.landmark.y;
    const raised = r.raise && r.path !== null ? heads.get(r.path) : undefined;
    r.raise = false;
    if (raised !== undefined) top = ys[raised] + items[raised].h - 1;
    if (r.compose) {
      const ci = items.findIndex(it => it.kind === "compose");
      if (ci >= 0) {
        const bottom = ys[ci] + items[ci].h;
        if (bottom > top + dh) top = bottom - dh;
      }
    } else if (!r.free && cur_item >= 0) {
      const heading = items[cur_item].kind === "head",
        cy = ys[cur_item] + (heading ? items[cur_item].h - 1 : 0),
        h = heading ? 1 : items[cur_item].h;
      if (cy < top + lead) top = Math.max(0, cy - lead - 2);
      if (cy + h > top + dh) top = cy + h - dh + 2;
    }
    top = Math.min(Math.max(0, top), Math.max(0, total - dh));
    r.top = top;
    let first = 0;
    while (first < items.length && ys[first] + items[first].h <= top) first++;
    const shown = items[first]?.s.change.path,
      shown_head = shown === undefined ? undefined : heads.get(shown);
    r.landmark = shown !== undefined && shown_head !== undefined ? { path: shown, y: ys[shown_head] } : null;
    const sel = r.compose
        ? r.compose.range
        : r.anchor !== null
          ? [Math.min(r.anchor, r.cur), Math.max(r.anchor, r.cur)]
          : null,
      sel_path = r.compose ? r.compose.path : r.path;
    for (let i = first; i < items.length && ys[i] < top + dh; i++) {
      const item = items[i],
        s = item.s,
        path = s.change.path,
        y0 = dy + ys[i] - top;
      if (item.kind === "head") {
        this.drawHead(c, r, now, s, y0 + item.h - 1, dy, dy + dh, focused);
        continue;
      }
      if (item.kind === "notice") {
        if (y0 < dy) continue;
        const cursor = path === r.path && focused && r.part === "diff",
          bg = cursor ? tint.cursor : null;
        c.fill(y0, bg, 0, c.w - 1);
        c.text(code_x, y0, this.flowNotice(r, s), cursor ? colors.muted : colors.faint, bg);
        const held = s.change.generated && !r.loaded.has(path);
        c.hit(0, y0, c.w, 1, {
          unit: 0,
          path,
          wheel: "diff",
          act: () => {
            if (!held) return;
            r.loaded.add(path);
            this.loadSelected();
          },
        });
        continue;
      }
      if (item.kind === "unit") {
        const d = item.d,
          cursor = path === r.path && item.at === r.cur && focused && r.part === "diff";
        if (item.unit.kind === "fold") {
          if (y0 < dy) continue;
          const bg = cursor ? tint.cursor : tint.fold;
          c.fill(y0, bg);
          const hint = cursor ? i18n.t`  →  expand` : "",
            holder = funcname.forFold(d, item.unit, syntax.language(path));
          let x = c.text(
            2,
            y0,
            `⋯  ${plural(item.unit.end - item.unit.start, "unmodified line")}`,
            cursor ? colors.muted : colors.faint,
            bg,
          );
          if (holder) x = c.text(x, y0, `  ·  ${holder}`, colors.muted, bg, false, c.w - x - displayWidth(hint) - 1);
          c.text(x, y0, hint, colors.muted, bg);
          const unit = item.unit,
            at = item.at;
          c.hit(0, y0, c.w, 1, {
            act: () => {
              if (r.path === path && r.cur === at) return this.openFold(r, path, d, unit);
              if (r.path !== path) r.anchor = null;
              r.path = path;
              r.cur = at;
            },
          });
          continue;
        }
        const in_sel = sel !== null && path === sel_path && item.at >= sel[0] && item.at <= sel[1];
        this.drawRow(
          c,
          r,
          d,
          path,
          item.unit.row,
          y0,
          dy,
          dy + dh,
          gutter,
          code_x,
          code_w,
          cursor,
          in_sel,
          noted.get(path) ?? new Set(),
          { old: s.file!.old, new: s.file!.new },
        );
        const vy = Math.max(y0, dy),
          vh = Math.min(y0 + item.h, dy + dh) - vy;
        if (vh > 0) c.hit(0, vy, c.w, vh, { unit: item.at, path, wheel: "diff" });
        continue;
      }
      const is_note = item.kind === "note";
      const title = is_note
        ? notes.location(item.note)
        : `${r.compose!.edit !== null ? i18n.t`edit note` : i18n.t`note`} · ${r.compose!.path}:${r.compose!.start}`;
      const border = is_note ? colors.line : palette.outline;
      const body = is_note ? wrapText(item.note.text, box_w - 4) : [];
      if (!is_note) this.compose_at = { x: c.x + box_x + 2, y: c.y + y0 + 1, rows: composed.length, w: box_w - 4 };
      for (let j = 0; j < item.h; j++) {
        const ly = y0 + j;
        if (ly < dy || ly >= dy + dh) continue;
        c.fill(ly, null);
        if (j === 0 || j === item.h - 1) {
          c.put(box_x, ly, j === 0 ? "╭" : "╰", border, colors.surface);
          for (let k = 1; k < box_w - 1; k++) c.put(box_x + k, ly, "─", border, colors.surface);
          c.put(box_x + box_w - 1, ly, j === 0 ? "╮" : "╯", border, colors.surface);
          if (j === 0)
            c.text(
              box_x + 2,
              ly,
              ` ${title} `,
              is_note ? colors.faint : colors.strong,
              colors.surface,
              !is_note,
              box_w - 4,
            );
        } else {
          c.fill(ly, colors.surface, box_x, box_x + box_w);
          c.put(box_x, ly, "│", border, colors.surface);
          c.put(box_x + box_w - 1, ly, "│", border, colors.surface);
          if (is_note) c.text(box_x + 2, ly, body[j - 1] ?? "", colors.text, colors.surface, false, box_w - 4);
          else
            this.drawTyped(c, r.compose!.area, composed[j - 1], box_x + 2, ly, caret?.row === j - 1 ? caret.col : null);
        }
      }
    }
    // The heading of a file scrolled into stays at the top while its lines pass.
    if (shown !== undefined && shown_head !== undefined && ys[shown_head] + items[shown_head].h - 1 < top) {
      this.drawHead(c, r, now, items[shown_head].s, dy, dy, dy + dh, focused);
    }
    if (total > dh) {
      const thumb = Math.max(1, Math.round((dh * dh) / total)),
        at = dy + Math.round(((dh - thumb) * top) / Math.max(1, total - dh));
      for (let j = 0; j < thumb; j++) c.put(c.w - 1, at + j, "▐", colors.line);
    }
  }
  /** A file's heading on "All files": a fold marker, its letter and path,
   * where it changed and its counts; folded, how many hunks it hides. A
   * click folds or unfolds it. */
  private drawHead(
    c: Canvas,
    r: Review,
    now: Now,
    s: Section,
    y: number,
    top: number,
    bottom: number,
    focused: boolean,
  ): void {
    if (y < top || y >= bottom) return;
    const colors = palette.colors,
      ch = s.change,
      cursor = s.collapsed && ch.path === r.path && focused && r.part === "diff",
      bg = cursor ? tint.cursor : colors.surface,
      [letter, fg] = mark(ch);
    c.fill(y, bg, 0, c.w - 1);
    c.text(1, y, s.collapsed ? "▸" : "▾", colors.faint, bg);
    c.text(3, y, letter, fg, bg, true);
    // Said only while there's room, the origin going first; each set apart from the counts.
    const extra: [string, palette.Rgb][] = [];
    if (s.collapsed && s.d) extra.push([plural(diff.hunkStarts(s.d, s.d.units).length, "hunk") + " ", colors.muted]);
    // Every file has the same origin outside the branch's "all", so only there is it said.
    const origin = r.scope === "all" || ch.kind === "untracked" ? this.originOf(now.co, r, now.source, ch) : "";
    if (origin) extra.push([origin + " ", colors.faint]);
    const counts: [string, palette.Rgb][] = [];
    if (r.notes.some(n => n.path === ch.path && notes.sameRev(n.rev, revOf(now.source))))
      counts.push(["•", colors.warm]);
    if (ch.binary) counts.push([i18n.t`bin`, colors.faint]);
    else {
      if (ch.generated) counts.push([i18n.t`gen`, colors.faint]);
      if (ch.adds) counts.push(["+" + ch.adds.toLocaleString("en-US"), colors.accent]);
      if (ch.dels) counts.push(["−" + ch.dels.toLocaleString("en-US"), colors.hot]);
    }
    const width = (parts: [string, palette.Rgb][]) => parts.reduce((sum, [part]) => sum + displayWidth(part) + 1, 0);
    while (extra.length && c.w - 6 - width(extra) - width(counts) < 24) extra.pop();
    const right = [...extra, ...counts];
    let px = c.w - 1 - width(right);
    const label = ch.from ? `${ch.from} → ${ch.path}` : ch.path;
    c.text(5, y, label, colors.strong, bg, true, px - 6);
    for (const [part, color] of right) px = c.text(px, y, part, color, bg) + 1;
    c.hit(0, y, c.w, 1, { act: () => this.collapse(r, now, ch.path) });
  }
  /** What a file without lines to show says in the flow. */
  private flowNotice(r: Review, s: Section): string {
    const loaded = s.file?.loaded;
    if (s.change.generated && !r.loaded.has(s.change.path)) return i18n.t`Generated file · enter loads its diff`;
    if (!loaded) return i18n.t`Reading the diff…`;
    switch (loaded.kind) {
      case "binary":
        return i18n.t`Binary file · no text diff`;
      case "too_large": {
        const size = (loaded.bytes / 1e6).toFixed(1);
        return i18n.t`Too large to show here · ${size} MB`;
      }
      case "failed": {
        const message = loaded.message;
        return i18n.t`git couldn't diff this file: ${message}`;
      }
      case "diff":
        return i18n.t`No lines changed`;
    }
  }
  /** A line of a text box: its text in `fg` on `bg`, its selection as every
   * text box shows one, and the caret, at column `caret`, as an inverted
   * cell. Returns the column after the text. */
  private drawTyped(
    c: Canvas,
    a: textArea.TextArea,
    line: textArea.Line | undefined,
    x: number,
    y: number,
    caret: number | null,
    fg = palette.colors.text,
    bg: palette.Rgb | null = palette.colors.surface,
  ): number {
    if (!line) return x;
    const colors = palette.colors,
      sel = a.selection(),
      chosen = (at: number) => sel !== null && at >= sel[0] && at < sel[1];
    let col = x;
    for (let at = line.start; at < line.end;) {
      const ch = String.fromCodePoint(a.text.codePointAt(at)!);
      col = chosen(at) ? c.text(col, y, ch, colors.strong, palette.selection_bg) : c.text(col, y, ch, fg, bg);
      at += ch.length;
    }
    // A selected line break shows as one selected cell.
    if (a.text[line.end] === "\n" && chosen(line.end)) c.put(col, y, " ", colors.strong, palette.selection_bg);
    const cell = caret === null ? undefined : c.cells[y]?.[x + caret];
    if (cell) [cell.fg, cell.bg] = [bg ?? colors.bg, fg];
    return col;
  }
  private drawRow(
    c: Canvas,
    r: Review,
    d: diff.FileDiff,
    path: string,
    index: number,
    y0: number,
    top: number,
    bottom: number,
    gutter: number,
    code_x: number,
    code_w: number,
    cursor: boolean,
    selected: boolean,
    noted: Set<string>,
    hl: { old: syntax.Highlighter; new: syntax.Highlighter },
  ): void {
    const colors = palette.colors,
      row = d.rows[index],
      text = d.text(row),
      add = row.kind === "insertion",
      del = row.kind === "deletion",
      side = del ? "old" : "new",
      bg = cursor ? tint.cursor : selected ? tint.selected : add ? tint.add : del ? tint.del : null,
      spans = del ? hl.old.spans(row.old_at) : hl.new.spans(row.new_at),
      em = cursor || selected ? null : d.emphasis(index),
      em_bg = add ? tint.add_em : tint.del_em,
      found = r.find?.by_row.get(`${path}\0${index}`) ?? null,
      lines = sourceLines(text, code_w, r.wrap ? wrap_cap : 1, r.wrap ? 0 : sourceOffset(text, r.shift)),
      number = diff.FileDiff.number(row),
      commented = noted.has(`${side}:${number}`);
    const inside = (ranges: diff.Ranges | null, at: number) =>
      ranges !== null && ranges.some(([s, e]) => at >= s && at < e);
    for (let j = 0; j < lines.length; j++) {
      const y = y0 + j;
      if (y < top || y >= bottom) continue;
      c.fill(y, bg, 0, c.w - 1);
      if (j === 0) {
        if (add || del) c.put(0, y, "▌", add ? colors.accent : colors.hot, bg);
        c.text(
          1,
          y,
          String(number).padStart(gutter),
          commented ? colors.warm : cursor ? colors.strong : colors.faint,
          bg,
          commented,
        );
      }
      let line = lines[j];
      let tail: string | null = null;
      const cut = line.end < text.length;
      if (r.wrap && j === lines.length - 1 && cut) {
        // Reserving the label can hide more codepoints, including another digit.
        for (let attempt = 0; attempt < 3; attempt++) {
          const count = [...text.slice(line.end)].length;
          tail = i18n.t` … ${count} more characters`;
          const fitted = sourceSlice(text, line.start, Math.max(0, code_w - displayWidth(tail)));
          if (fitted.end === line.end) break;
          line = fitted;
        }
      } else if (!r.wrap && cut) line = sourceSlice(text, line.start, code_w - 1);
      let si = 0,
        col = code_x,
        previous = -1;
      for (let at = line.start; at < line.end;) {
        const raw = String.fromCodePoint(text.codePointAt(at)!);
        const ch = sourceGlyph(raw),
          width = Math.max(0, codepointWidth(ch.codePointAt(0)!));
        if (width === 0) {
          if (previous >= 0) c.cells[y][previous].ch += ch;
          at += raw.length;
          continue;
        }
        let fg = colors.text;
        while (si < spans.length && spans[si][1] <= at) si++;
        if (si < spans.length && spans[si][0] <= at) fg = palette.syntax[spans[si][2]];
        let cell_bg = bg;
        if (em && inside(em, at)) cell_bg = em_bg;
        if (found && inside(found, at)) {
          cell_bg = tint.match;
          fg = colors.strong;
        }
        c.put(col, y, ch, fg, cell_bg);
        if (width === 2) c.put(col + 1, y, "", fg, cell_bg);
        previous = col;
        col += width;
        at += raw.length;
      }
      if (tail) c.text(col, y, tail, colors.faint, bg, false, code_w - line.width);
      if (!r.wrap) {
        if (r.shift > 0 && text.length) c.put(code_x - 1, y, "‹", colors.faint, bg);
        if (cut) c.put(code_x + code_w - 1, y, "›", colors.faint, bg);
      }
    }
  }
  /** Every key in one box over the dimmed panel: groups under their
   * headings in two columns, or one when narrow, each key at the end of what
   * it does. */
  private drawKeys(c: Canvas): void {
    const colors = palette.colors,
      key_groups = keyGroups(),
      keys_column = Math.max(
        ...key_groups.flatMap(([heading, rows]) => [
          displayWidth(heading),
          ...rows.map(([what, key]) => 2 + displayWidth(what) + 3 + displayWidth(key)),
        ]),
      ),
      columns = c.w >= 2 * keys_column + 10 ? [key_groups.slice(0, 3), key_groups.slice(3)] : [key_groups],
      tall = (groups: KeyGroup[]) => groups.reduce((sum, [, rows]) => sum + 2 + rows.length, -1),
      body = Math.max(...columns.map(tall)),
      w = Math.min(c.w, columns.length * keys_column + (columns.length - 1) * 4 + 6),
      h = body + 4,
      x = Math.floor((c.w - w) / 2),
      y = Math.max(0, Math.floor((c.h - h) / 2));
    c.fade();
    for (let row = 0; row < h; row++) {
      const [l, r] = row === 0 ? ["╭", "╮"] : row === h - 1 ? ["╰", "╯"] : ["│", "│"];
      c.fill(y + row, colors.surface, x, x + w);
      c.put(x, y + row, l, colors.line, colors.surface);
      c.put(x + w - 1, y + row, r, colors.line, colors.surface);
      if (row === 0 || row === h - 1)
        for (let i = x + 1; i < x + w - 1; i++) c.put(i, y + row, "─", colors.line, colors.surface);
    }
    c.text(x + 2, y, i18n.t` Keys `, colors.strong, colors.surface, true);
    const closeHint = i18n.t` any key closes `;
    c.text(
      Math.max(x + 1, x + w - displayWidth(closeHint) - 2),
      y + h - 1,
      closeHint,
      colors.faint,
      colors.surface,
      false,
      w - 2,
    );
    columns.forEach((groups, i) => {
      const left = x + 3 + i * (keys_column + 4);
      let row = y + 2;
      for (const [heading, rows] of groups) {
        c.text(left, row++, heading, colors.strong, colors.surface, true);
        for (const [what, keys] of rows) {
          c.text(left + 2, row, what, colors.muted, colors.surface);
          c.text(left + keys_column - displayWidth(keys), row++, keys, colors.strong, colors.surface);
        }
        row++;
      }
    });
  }
  private box(c: Canvas, x: number, y: number, w: number, h: number, title: string): void {
    const colors = palette.colors;
    for (let row = 0; row < h; row++) {
      c.fill(y + row, null, 0, x);
      c.fill(y + row, colors.surface, x, x + w);
      c.put(x, y + row, row === 0 ? "╭" : row === h - 1 ? "╰" : "│", colors.line, colors.surface);
      c.put(x + w - 1, y + row, row === 0 ? "╮" : row === h - 1 ? "╯" : "│", colors.line, colors.surface);
      if (row === 0 || row === h - 1)
        for (let i = x + 1; i < x + w - 1; i++) c.put(i, y + row, "─", colors.line, colors.surface);
    }
    c.text(x + 2, y, title, colors.strong, colors.surface, true);
  }
  private drawList(c: Canvas, r: Review, dy: number, dh: number, source: git.Source | null): void {
    const colors = palette.colors,
      n = r.notes.length,
      height = Math.min(dh, Math.max(4, n * 2 + 3));
    this.box(c, 1, dy, c.w - 2, height, i18n.t` Notes · ${n} `);
    if (n === 0) return void c.text(3, dy + 1, i18n.t`No notes yet.`, colors.muted, colors.surface);
    const listed = this.checkout() && source ? this.listing(this.checkout()!, r) : null;
    r.notes.forEach((note, i) => {
      const y = dy + 1 + i * 2;
      if (y + 1 >= dy + height - 1) return;
      const on = r.list?.at === i,
        bg = on ? colors.selected : colors.surface;
      c.fill(y, bg, 2, c.w - 2);
      c.fill(y + 1, bg, 2, c.w - 2);
      const end = c.text(3, y, notes.location(note), colors.strong, bg, true, c.w - 24);
      if (listed && !listed.changes.some(ch => ch.path === note.path))
        c.text(end + 2, y, i18n.t`not in this view`, colors.faint, bg);
      c.text(3, y + 1, note.text.replace(/\n/g, " "), colors.muted, bg, false, c.w - 6);
      c.hit(2, y, c.w - 4, 2, {
        act: () => {
          this.jumpToNote(r, note);
          r.list = null;
        },
      });
    });
  }
  private drawFooter(c: Canvas, r: Review, now: Now | null, focused: boolean): void {
    const colors = palette.colors,
      y = c.h - 1;
    c.fill(y, null);
    const keycap = (x: number, k: string) => c.text(x, y, k, colors.strong, colors.line, true);
    // `end` sits at the right edge and stays when the others run out of room.
    const hints = (list: [string, string, (() => void)?][], end?: [string, string]) => {
      let x = 1,
        limit = c.w;
      if (end) {
        limit = c.w - 1 - displayWidth(end[0]) - 1 - displayWidth(end[1]);
        c.text(keycap(limit, end[0]) + 1, y, end[1], colors.muted);
      }
      for (const [k, label, act] of list) {
        const need = displayWidth(k) + 1 + displayWidth(label) + 2;
        if (x + need > limit) break;
        const start = x;
        x = keycap(x, k);
        x = c.text(x + 1, y, label, colors.muted) + 2;
        if (act) c.hit(start, y, x - start - 2, 1, { act });
      }
    };
    if (r.find) {
      const q = r.find.query,
        caret = focused ? q.position().col : null,
        x = this.drawTyped(c, q, q.lines()[0], keycap(1, "/") + 1, y, caret, colors.strong, null) + 1;
      const count = q.text
        ? r.find.hits.length
          ? `${r.find.at + 1}/${r.find.hits.length}`
          : i18n.t`no match`
        : i18n.t`type to find`;
      c.text(x + 1, y, count, q.text && !r.find.hits.length ? colors.hot : colors.faint);
      return;
    }
    if (r.status)
      return void c.text(1, y, r.status.text, r.status.warm ? colors.warm : colors.muted, null, false, c.w - 2);
    if (!focused) return;
    if (r.compose)
      return hints([
        ["enter", i18n.t`save`],
        ["shift+enter", i18n.t`new line`],
        ["esc", i18n.t`cancel`],
      ]);
    if (r.list)
      return hints([
        ["enter", i18n.t`jump`],
        ["d", i18n.t`delete`],
        ["esc", i18n.t`close`],
      ]);
    if (r.picker)
      return hints([
        ["j/k", i18n.t`commit`],
        ["enter", i18n.t`review it alone`],
        ["esc", i18n.t`close`],
      ]);
    if (r.anchor !== null) {
      const count = Math.abs(r.anchor - r.cur) + 1;
      return hints([
        ["c", count === 1 ? i18n.t`comment on ${count} row` : i18n.t`comment on ${count} rows`],
        ["esc", i18n.t`cancel`],
      ]);
    }
    const to = this.destination(),
      name = to?.name ?? "",
      count = r.notes.length,
      elsewhere = to && to.pane !== this.target?.pane;
    const send: [string, string, () => void] = [
      "s",
      elsewhere
        ? count
          ? i18n.t`send ${count} to ${name}`
          : i18n.t`send to ${name}`
        : count
          ? i18n.t`send ${count}`
          : i18n.t`send`,
      () => (this.pending = this.send(r, false)),
    ];
    const close: [string, string] = ["q", i18n.t`close`];
    if (r.part === "tree" && !r.tree_hidden)
      return hints(
        [
          ["j/k", i18n.t`file`],
          ["enter", i18n.t`open`],
          ["tab", i18n.t`diff`],
          ["]", i18n.t`hunk`],
          send,
          ["?", i18n.t`keys`],
        ],
        close,
      );
    const d = now?.file?.loaded.kind === "diff" ? now.file.loaded.diff : null;
    const units = d && r.path ? this.units(r, d, r.path) : [];
    if (now && r.path && this.isCollapsed(r, now, r.path))
      return hints([["enter", i18n.t`unfold`], ["]/[", i18n.t`hunk`], send, ["?", i18n.t`keys`]], close);
    if (now?.change?.generated && !r.loaded.has(now.change.path))
      return hints([["enter", i18n.t`load the diff`], ["f", i18n.t`next file`], send, ["?", i18n.t`keys`]], close);
    if (units[r.cur]?.kind === "fold")
      return hints([["→", i18n.t`expand`], ["]/[", i18n.t`hunk`], send, ["?", i18n.t`keys`]], close);
    if (d && now && this.noteAt(r, d, units, now))
      return hints(
        [["e", i18n.t`edit`], ["d", i18n.t`delete`], ["]/[", i18n.t`hunk`], send, ["?", i18n.t`keys`]],
        close,
      );
    hints(
      [
        ["v", i18n.t`select`],
        ["c", i18n.t`comment`],
        ["]/[", i18n.t`hunk`],
        ["w", r.wrap ? i18n.t`unwrap` : i18n.t`wrap`],
        ["/", i18n.t`find`],
        send,
        ["?", i18n.t`keys`],
      ],
      close,
    );
  }
}
/** The menu's columns past each subject: files touched, lines added and
 * removed, and age, right-aligned under their headings. */
function commitColumns(list: git.Commit[], now: number): { heading: string; notes: dropdown.Run[][] } {
  const cells = list.map(cm => ({
    files: String(cm.files),
    adds: `+${compactCount(cm.adds)}`,
    dels: `−${compactCount(cm.dels)}`,
    age: age(now - cm.time),
  }));
  const filesLabel = i18n.t`files`,
    linesLabel = i18n.t`lines`,
    ageLabel = i18n.t`age`;
  const pad = (value: string, width: number) => " ".repeat(Math.max(0, width - displayWidth(value))) + value;
  const widest = (key: keyof (typeof cells)[number]) => Math.max(0, ...cells.map(cell => displayWidth(cell[key])));
  const adds = widest("adds"),
    dels = widest("dels"),
    files = Math.max(displayWidth(filesLabel), widest("files")),
    lines = Math.max(displayWidth(linesLabel), adds + 1 + dels),
    when = Math.max(displayWidth(ageLabel), widest("age"));
  return {
    heading: `${pad(filesLabel, files)}  ${pad(linesLabel, lines)}  ${pad(ageLabel, when)}`,
    notes: list.map((cm, i) => [
      [cells[i].files.padStart(files), "muted"],
      [cells[i].adds.padStart(lines - dels - 1 + 2), cm.adds ? "accent" : "faint"],
      [cells[i].dels.padStart(dels + 1), cm.dels ? "hot" : "faint"],
      [pad(cells[i].age, when + 2), "faint"],
    ]),
  };
}
/** What reviewing the checkout at `root` would open on, as runs for a menu
 * row: its files and lines changed since it left the base branch, uncommitted
 * ones included. */
export async function summary(root: string): Promise<dropdown.Run[]> {
  try {
    const [base, head] = await Promise.all([git.base(root), git.head(root)]);
    return summaryRuns(
      await git.changes(root, { kind: "worktree", against: base?.merge_base ?? head ?? git.empty_tree }),
      base,
    );
  } catch {
    return [[i18n.t`git didn't answer`, "faint"]];
  }
}
/** `summary` from changes already read, as the panel's "all" scope reads them. */
export function summaryRuns(changes: git.Change[], base: git.Base | null): dropdown.Run[] {
  const branch = base?.name ?? "";
  if (changes.length === 0) return [[base ? i18n.t`No changes since ${branch}` : i18n.t`No changes`, "faint"]];
  const adds = changes.reduce((s, ch) => s + (ch.adds ?? 0), 0),
    dels = changes.reduce((s, ch) => s + (ch.dels ?? 0), 0);
  return [
    [`${plural(changes.length, "file")}  `, "faint"],
    [`+${adds.toLocaleString("en-US")}`, "accent"],
    [` −${dels.toLocaleString("en-US")}`, "hot"],
  ];
}
/** A source's changed files, with when each was last written for the working tree. */
async function list(root: string, source: git.Source): Promise<Listing> {
  const changes = await git.changes(root, source);
  return {
    changes,
    auto_collapsed: folding.tests(changes),
    edited:
      source.kind === "worktree"
        ? await git.edited(
            root,
            changes.map(ch => ch.path),
          )
        : null,
  };
}
/** A commit's age, short enough for a dropdown note. */
function age(seconds: number): string {
  if (seconds < 90) return i18n.t`now`;
  const minutes = Math.round(seconds / 60);
  if (seconds < 3600) return i18n.t`${minutes} min`;
  if (seconds < 86400 * 2) {
    const hours = Math.round(seconds / 3600);
    return i18n.t`${hours} h`;
  }
  const days = Math.round(seconds / 86400);
  return i18n.t`${days} d`;
}
