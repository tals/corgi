//! The review panel: the focused pane's checkout as a file tree over a
//! folded diff, with notes that paste into that pane. The viewer draws it at
//! the window's right edge, outside the layout, so it follows whichever pane
//! is focused. Browsing follows herdr-reviewr: scopes, hunk walking across
//! files, folds, changed words, find, and a commit picker.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import * as dropdown from "../dropdown";
import { Rect } from "../layout";
import * as palette from "../palette";
import { codepointWidth, compactCount, Writer } from "../text";
import * as diff from "./diff";
import * as git from "./git";
import * as notes from "./notes";
import * as syntax from "./syntax";
import * as tree from "./tree";

export type Scope = "all" | "uncommitted" | "commits";
export type Named =
  | "up"
  | "down"
  | "left"
  | "right"
  | "page_up"
  | "page_down"
  | "home"
  | "end"
  | "tab"
  | "shift_tab"
  | "enter"
  | "escape"
  | "backspace"
  | "half_down"
  | "half_up"
  | "newline";
export type Key = { named: Named } | { text: string };
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
/** How often an open panel rereads git. */
export const refresh_ms = 2000;
/** Rows a long line wraps to at most. */
const wrap_cap = 6;
const min_width = 40;

type Part = "tree" | "diff";
interface Compose {
  path: string;
  rev: notes.Rev;
  side: notes.Side;
  start: number;
  end: number;
  snippet: string;
  text: string;
  edit: number | null;
  range: [number, number];
}
interface Find {
  query: string;
  hits: [number, number, number][];
  by_row: Map<number, diff.Ranges>;
  at: number;
}
/** One pane's review: what it looks at and the notes it will send. */
class Review {
  scope: Scope = "all";
  /** How the files are listed: a tree by name, or one list by last edit. */
  sort: "name" | "edited" = "name";
  /** The other way from how each sort starts: Z to A, or oldest edit first. */
  reversed = false;
  pick: string | null = null;
  path: string | null = null;
  part: Part = "tree";
  tree_sel: string | null = null;
  tree_top = 0;
  tree_rows = 9;
  tree_hidden = false;
  toggled = new Set<string>();
  cur = 0;
  top = 0;
  free = false;
  shift = 0;
  wrap = true;
  /** Opened folds per file, by anchor. */
  opened = new Map<string, Set<number>>();
  /** Generated files whose diff was asked for. */
  loaded = new Set<string>();
  anchor: number | null = null;
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
type Hit = { x: number; y: number; w: number; h: number; act?: () => void; unit?: number; wheel?: "tree" | "diff" };
/** Control characters never reach the terminal. */
const safe = (ch: string) => {
  const cp = ch.codePointAt(0) ?? 32;
  return cp < 32 || cp === 127 || (cp >= 0x80 && cp < 0xa0) ? "·" : ch;
};
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
function plural(n: number, word: string): string {
  return `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
}

export class Panel {
  open = false;
  focused = false;
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
  private hits: Hit[] = [];
  /** The refresh under way; another asked for meanwhile runs after it. */
  private flight: Promise<void> | null = null;
  private again = false;
  private loading_file = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private selecting: { from: number } | null = null;
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
    for (const id of this.reviews.keys()) if (!panes.has(id)) this.reviews.delete(id);
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
    this.focused = false;
    this.pinned = false;
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
    this.flight = this.read().finally(() => {
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
    const t = this.target;
    if (!t) return "";
    const root = this.roots.get(t.cwd);
    const co = root ? this.checkouts.get(root) : undefined;
    if (!co) return String(root);
    const r = this.review(t.pane),
      listed = this.listing(co, r),
      file = listed && r.path ? co.files.get(`${sourceKey(listed.source)}\0${r.path}`) : undefined;
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
      file?.sig,
      co.files.size,
    ]);
  }
  private async read(): Promise<void> {
    const t = this.target;
    if (!t || !this.open) return;
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
    await this.loadFile(co, r);
  }
  /** Loads the selected file's diff unless it is current. */
  private async loadFile(co: Checkout, r: Review): Promise<void> {
    const listed = this.listing(co, r);
    if (!listed) return;
    const paths = listed.changes.map(c => c.path);
    if (!r.path || !paths.includes(r.path))
      this.select(r, this.fileOrder(r, paths, listed.edited)[0] ?? null, paths, false);
    const change = listed.changes.find(c => c.path === r.path);
    if (!change || (change.generated && !r.loaded.has(change.path))) return;
    let stamp = "";
    if (listed.source.kind === "worktree" && change.kind !== "deleted")
      try {
        const info = await stat(join(co.root, change.path));
        stamp = `${info.size}:${info.mtimeMs}`;
      } catch {}
    const sig = `${change.kind}|${change.from}|${change.adds}|${change.dels}|${stamp}`;
    const key = `${sourceKey(listed.source)}\0${change.path}`;
    if (co.files.get(key)?.sig === sig) return;
    const ticket = ++this.loading_file;
    const loaded = await git.fileDiff(co.root, listed.source, change);
    if (ticket !== this.loading_file && co.files.has(key)) return;
    const lang = syntax.language(change.path);
    co.files.set(key, {
      sig,
      loaded,
      old: new syntax.Highlighter(lang, loaded.kind === "diff" ? loaded.diff.old : []),
      new: new syntax.Highlighter(lang, loaded.kind === "diff" ? loaded.diff.new : []),
    });
    const fresh = co.files.get(key);
    if (fresh?.loaded.kind === "diff" && r.path === change.path && r.cur === 0)
      r.cur = this.firstChange(r, fresh.loaded.diff, change.path);
  }
  private loadSelected(): void {
    const co = this.checkout(),
      t = this.target;
    if (!co || !t) return;
    void this.loadFile(co, this.review(t.pane)).then(() => this.changed());
  }
  private current(): {
    co: Checkout;
    r: Review;
    source: git.Source;
    changes: git.Change[];
    edited: Map<string, number> | null;
    change: git.Change | null;
    file: Loaded | null;
  } | null {
    const co = this.checkout(),
      t = this.target;
    if (!co || !t) return null;
    const r = this.review(t.pane),
      listed = this.listing(co, r);
    if (!listed) return null;
    const change = listed.changes.find(c => c.path === r.path) ?? null;
    const file = change ? (co.files.get(`${sourceKey(listed.source)}\0${change.path}`) ?? null) : null;
    return { co, r, source: listed.source, changes: listed.changes, edited: listed.edited, change, file };
  }
  /** The file rows: a tree by name, or one list newest edit first. */
  private fileRows(r: Review, paths: string[], edited: Map<string, number> | null): tree.Row[] {
    return r.sort === "edited" && edited
      ? tree.flat(tree.byEdited(paths, edited, r.reversed))
      : tree.rows(paths, r.toggled, false, r.sort === "name" && r.reversed);
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
      units = d && r.path ? this.units(r, d, r.path) : [],
      named = "named" in k ? k.named : null,
      text = "text" in k ? k.text : "";
    if (r.compose) {
      const c = r.compose;
      if (named === "escape") r.compose = null;
      else if (named === "newline") c.text += "\n";
      else if (named === "enter") {
        const body = c.text.trim();
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
      } else if (named === "backspace") c.text = [...c.text].slice(0, -1).join("");
      else if (text) c.text += text;
      return { kind: "none" };
    }
    if (r.find) {
      const f = r.find;
      if (named === "escape") r.find = null;
      else if (named === "enter") this.findStep(r, d, 1);
      else if (named === "shift_tab" || named === "up") this.findStep(r, d, -1);
      else if (named === "down") this.findStep(r, d, 1);
      else if (named === "backspace") {
        f.query = [...f.query].slice(0, -1).join("");
        this.findIndex(r, d);
      } else if (text) {
        f.query += text;
        this.findIndex(r, d);
        this.findStep(r, d, 1);
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
      if (i >= 0 && i < order.length) this.select(r, order[i], paths);
    };
    const move = (delta: number) => {
      r.cur = Math.min(Math.max(r.cur + delta, 0), Math.max(0, units.length - 1));
      r.free = false;
    };
    if (r.part === "tree" && !r.tree_hidden) {
      const rows = this.fileRows(r, paths, now.edited),
        i = Math.max(
          0,
          rows.findIndex(row => row.id === r.tree_sel),
        ),
        row = rows[i];
      const goTo = (j: number) => {
        const next = rows[Math.min(Math.max(j, 0), rows.length - 1)];
        if (!next) return;
        r.tree_sel = next.id;
        if (next.kind === "file" && next.path !== r.path) this.select(r, next.path, paths);
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
    if (named === "half_down" || named === "half_up") {
      move((named === "half_down" ? 1 : -1) * Math.max(1, Math.floor(this.page / 2)));
      return { kind: "none" };
    }
    switch (named ?? text) {
      case "tab":
      case "shift_tab":
        r.part = r.part === "tree" || r.tree_hidden ? "diff" : "tree";
        if (r.part === "tree" && r.path) r.tree_sel = "f:" + r.path;
        break;
      case "down":
      case "j":
        move(1);
        break;
      case "up":
      case "k":
        move(-1);
        break;
      case "page_down":
        move(Math.max(1, this.page - 2));
        break;
      case "page_up":
        move(-Math.max(1, this.page - 2));
        break;
      case "home":
        r.cur = 0;
        r.free = false;
        break;
      case "end":
        r.cur = Math.max(0, units.length - 1);
        r.free = false;
        break;
      case "enter":
      case "right": {
        if (now.change?.generated && !r.loaded.has(now.change.path)) {
          r.loaded.add(now.change.path);
          this.loadSelected();
          break;
        }
        const unit = units[r.cur];
        if (d && unit?.kind === "fold") this.openFold(r, d, unit);
        else if (named === "right" && !r.wrap) r.shift += 8;
        break;
      }
      case "left":
        if (!r.wrap) r.shift = Math.max(0, r.shift - 8);
        break;
      case "]":
      case "[": {
        r.part = "diff";
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
      case "w":
        r.wrap = !r.wrap;
        r.shift = 0;
        break;
      case "v":
        r.part = "diff";
        r.anchor = r.anchor === null ? r.cur : null;
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
            text: n.text,
            edit: n.id,
            range,
          };
        } else r.status = { text: "No note on this line. c adds one.", warm: false };
        break;
      }
      case "d": {
        const n = d ? this.noteAt(r, d, units, now) : null;
        if (n) {
          r.notes = r.notes.filter(x => x !== n);
          r.status = { text: `Deleted the note on ${notes.location(n)}.`, warm: false };
        }
        break;
      }
      case "n":
      case "N":
        this.nextNote(r, d, units, text === "n" ? 1 : -1);
        break;
      case "l":
        r.list = { at: 0 };
        break;
      case "/":
        if (d) {
          r.find = { query: "", hits: [], by_row: new Map(), at: -1 };
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
        r.tree_rows = Math.min(r.tree_rows + 2, 30);
        break;
      case ">":
        r.tree_rows = Math.max(r.tree_rows - 2, 3);
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
  private openFold(r: Review, d: diff.FileDiff, unit: diff.Unit): void {
    if (!r.path) return;
    const opened = new Set(r.opened.get(r.path) ?? []);
    opened.add(diff.foldAnchor(d, unit));
    r.opened.set(r.path, opened);
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
      r.status = { text: "Folded lines take no notes; → opens them.", warm: false };
      return;
    }
    r.compose = { path, rev, ...anchor, text: "", edit: null, range: [a, b] };
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
    r.path = n.path;
    r.part = "diff";
    r.free = false;
    const co = this.checkout();
    const listed = co && this.listing(co, r);
    if (listed)
      r.toggled = tree.reveal(
        listed.changes.map(c => c.path),
        r.toggled,
        n.path,
      );
    r.tree_sel = "f:" + n.path;
    const file = co && listed ? co.files.get(`${sourceKey(listed.source)}\0${n.path}`) : undefined;
    if (file?.loaded.kind === "diff") {
      const range = this.rangeOf(r, file.loaded.diff, this.units(r, file.loaded.diff, n.path), n);
      if (range) r.cur = range[0];
    }
    void this.refresh();
  }
  private nextNote(r: Review, d: diff.FileDiff | null, units: diff.Unit[], step: 1 | -1): void {
    if (r.notes.length === 0) {
      r.status = { text: "No notes yet. v selects lines, c comments.", warm: false };
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
  private findIndex(r: Review, d: diff.FileDiff | null): void {
    const f = r.find;
    if (!f) return;
    f.hits = [];
    f.by_row = new Map();
    f.at = -1;
    const query = f.query.toLowerCase();
    if (!query || !d) return;
    d.rows.forEach((row, i) => {
      const line = d.text(row).toLowerCase();
      for (
        let at = line.indexOf(query), guard = 0;
        at >= 0 && guard < 100;
        at = line.indexOf(query, at + query.length), guard++
      ) {
        f.hits.push([i, at, at + query.length]);
        const ranges = f.by_row.get(i) ?? [];
        ranges.push([at, at + query.length]);
        f.by_row.set(i, ranges);
      }
    });
  }
  private findStep(r: Review, d: diff.FileDiff | null, step: 1 | -1): void {
    const f = r.find;
    if (!f || !d || !r.path || f.hits.length === 0) return;
    let units = this.units(r, d, r.path);
    const here = units[r.cur],
      row = here ? (here.kind === "row" ? here.row : here.start) : 0;
    let next = -1;
    if (step > 0) {
      next = f.hits.findIndex((h, i) => h[0] > row || (h[0] === row && i > f.at));
      if (next < 0) next = 0;
    } else {
      for (let i = f.hits.length - 1; i >= 0; i--)
        if (f.hits[i][0] < row || (f.hits[i][0] === row && f.at >= 0 && i < f.at)) {
          next = i;
          break;
        }
      if (next < 0) next = f.hits.length - 1;
    }
    f.at = next;
    const target = f.hits[next][0];
    const fold = units.find(u => u.kind === "fold" && target >= u.start && target < u.end);
    if (fold) {
      this.openFold(r, d, fold);
      units = this.units(r, d, r.path);
    }
    const index = units.findIndex(u => u.kind === "row" && u.row === target);
    if (index >= 0) {
      r.cur = index;
      r.free = false;
    }
    if (!r.wrap) r.shift = Math.max(0, f.hits[next][1] - 10);
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
      r.status = { text: "No notes yet. v selects lines, c comments.", warm: false };
      return { kind: "none" };
    }
    const sent = r.notes,
      text = notes.format(sent);
    r.notes = [];
    r.status = {
      text: copy
        ? `Copied ${plural(sent.length, "note")}.`
        : `Sent ${plural(sent.length, "note")} to ${to.name}. Enter there submits them.`,
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
      return;
    }
    const hit = [...this.hits].reverse().find(h => x >= h.x && x < h.x + h.w && y >= h.y && y < h.y + h.h);
    const t = this.target;
    if (!t) return;
    const r = this.review(t.pane);
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
      if (kind === "press") this.focused = true;
      return;
    }
    if (kind === "move") return;
    if (kind === "wheel_up" || kind === "wheel_down") {
      const step = kind === "wheel_down" ? 3 : -3;
      if (hit?.wheel === "tree") r.tree_top = Math.max(0, r.tree_top + step);
      else {
        r.top = Math.max(0, r.top + step);
        r.free = true;
      }
      return;
    }
    if (kind === "drag") {
      if (this.selecting && hit?.unit !== undefined) {
        r.anchor = hit.unit === this.selecting.from ? null : this.selecting.from;
        r.cur = hit.unit;
      }
      return;
    }
    this.focused = true;
    if (!hit) return;
    if (hit.unit !== undefined) {
      r.part = "diff";
      r.anchor = null;
      r.cur = hit.unit;
      r.free = false;
      this.selecting = { from: hit.unit };
    }
    hit.act?.();
  }

  // ---------- drawing ----------

  draw(w: Writer, x: number, y: number, width: number, height: number): void {
    const c = new Canvas(x, y, width, height),
      colors = palette.colors;
    const focused = this.focused;
    // A pinned panel stands apart from the panes it no longer follows.
    for (let row = 0; row < height; row++)
      c.put(0, row, this.pinned ? "┃" : "│", focused ? palette.outline : colors.line, null);
    const inner = new Canvas(x + 1, y, width - 1, height);
    this.drawInside(inner, focused);
    for (let row = 0; row < height; row++)
      for (let col = 0; col < width - 1; col++) c.cells[row][col + 1] = inner.cells[row][col];
    c.flush(w);
    this.hits = inner.hits;
    this.drawCommitMenu(w, x, y, width, height);
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
    const list = this.pickable(co),
      columns = commitColumns(list, Date.now() / 1000),
      heading = list.length ? { text: "commit", note: columns.heading } : undefined;
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
        text: co.base ? `No commits since ${co.base.name}` : "No commits yet",
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
    let col = c.text(1, 0, "Review", colors.strong, null, true) + 1;
    if (t) {
      // A pushpin: lit while pinned, faint as the button that pins.
      c.text(col, 0, "⚲", this.pinned ? colors.accent : colors.faint, null, this.pinned);
      c.hit(col - 1, 0, 3, 1, { act: () => (this.pinned = !this.pinned) });
      col += 2;
    }
    if (!t) {
      c.text(1, 2, "Focus a pane to review its checkout.", colors.muted);
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
      tabs.push(
        { label: "all", on: r.scope === "all", act: () => this.setScope(r, "all") },
        { label: "uncommitted", on: r.scope === "uncommitted", act: () => this.setScope(r, "uncommitted") },
        {
          label:
            r.scope === "commits" && r.pick
              ? `${r.pick.slice(0, 7)} ${caret}`
              : co.base
                ? `commits ${caret} ${co.commits.length}`
                : `commits ${caret}`,
          on: r.scope === "commits",
          open: r.picker !== null,
          act: () => (r.picker ? (r.picker = null) : this.openPicker(r, co)),
        },
      );
    }
    const tabs_w = tabs.reduce((s, tab) => s + [...tab.label].length + 2, 0) + Math.max(0, tabs.length - 1),
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
      c.hit(tx, tabs_row, s.length, 1, { act: tab.act });
      if (tab === tabs[2]) this.commits_chip = { x: c.x + tx, y: c.y + tabs_row, w: [...s].length };
      tx += [...s].length;
    }
    if (r.notes.length) {
      const label = plural(r.notes.length, "note");
      if (right - label.length - 2 > col) {
        right -= label.length + 2;
        c.text(right, 0, label, colors.warm, null, true);
        c.hit(right, 0, label.length, 1, { act: () => (r.list = { at: 0 }) });
      }
    }
    // Pinned elsewhere, where the notes go.
    const to = this.destination();
    if (to && to.pane !== t.pane) c.text(col, 0, `→ ${to.name}`, colors.warm, null, false, right - col - 1);
    if (root === undefined) {
      c.text(1, 2, "Reading git…", colors.faint);
      return;
    }
    if (root === null) {
      c.text(1, 2, "Not in a git checkout:", colors.muted);
      c.text(1, 3, t.cwd || "(no directory)", colors.faint);
      return;
    }
    if (!co) {
      c.text(1, 2, "Reading git…", colors.faint);
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
      const len = parts.reduce((s, p) => s + [...p[0]].length, 0);
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
        : [["No commit picked yet. g opens the menu.", colors.muted]];
    } else if (r.scope === "uncommitted" || !co.base)
      parts = [
        [name, colors.text],
        [" vs ", colors.faint],
        ["HEAD", colors.text],
      ];
    else {
      const working = co.listings.get(sourceKey({ kind: "worktree", against: co.head ?? git.empty_tree }));
      parts = [
        [name, colors.text],
        [" vs ", colors.faint],
        [co.base.name, colors.text],
      ];
      extra = [
        `  ${own ? plural(own, "commit") : "no commits"}${working?.changes.length ? " + uncommitted" : ""}`,
        colors.faint,
      ];
    }
    const width = (list: [string, palette.Rgb][]) => list.reduce((s, [part]) => s + [...part].length, 0);
    if (extra && width(parts) + width([extra]) <= room) parts.push(extra);
    let dx = 1;
    for (const [part, fg] of parts) dx = c.text(dx, head, part, fg, null, false, room + 1 - dx);
    for (let i = 0; i < c.w; i++) c.put(i, head + 1, "─", colors.line);
    // How the files are listed, on the rule above them.
    if (listed?.edited && listed.changes.length && !r.tree_hidden) {
      const sorts: ["name" | "edited", string][] = [
        ["name", "name"],
        ["edited", "last edit"],
      ];
      // Up is A to Z or oldest first; each sort starts the way it's most read.
      const arrow = (r.sort === "name") !== r.reversed ? " ↑" : " ↓";
      let sx =
        c.w -
        2 -
        sorts.reduce((s, [, label]) => s + label.length, 0) -
        arrow.length -
        " sort: ".length -
        " · ".length -
        1;
      sx = c.text(sx, head + 1, " sort: ", colors.faint);
      for (const [sort, label] of sorts) {
        if (sort !== "name") sx = c.text(sx, head + 1, " · ", colors.faint);
        const on = r.sort === sort,
          shown = on ? label + arrow : label;
        c.hit(sx, head + 1, shown.length, 1, { act: () => this.setSort(r, sort) });
        sx = c.text(sx, head + 1, shown, on ? colors.text : colors.faint, null, on);
      }
      c.put(sx, head + 1, " ", colors.line);
    }
    let ty = head + 2;
    const changes = listed?.changes ?? [];
    const paths = changes.map(ch => ch.path);
    if (!listed) {
      c.text(2, ty, r.scope === "commits" ? "Pick a commit with g." : "Reading git…", colors.muted);
      ty += 1;
    } else if (changes.length === 0) {
      c.text(
        2,
        ty,
        r.scope === "all"
          ? `Nothing changed on ${name} yet.`
          : r.scope === "uncommitted"
            ? "No uncommitted changes."
            : "This commit changed nothing.",
        colors.muted,
      );
      ty += 1;
    } else if (!r.tree_hidden) ty = this.drawTree(c, r, changes, paths, listed.edited, ty, focused);
    for (let i = 0; i < c.w; i++) c.put(i, ty, "─", colors.line);
    const now = this.current();
    if (now?.change) {
      const ch = now.change;
      const label = ch.from ? `${ch.from} → ${ch.path}` : ch.path;
      const end = c.text(2, ty, ` ${label} `, colors.strong, null, true, c.w - 16);
      const origin =
        now.source.kind === "commit"
          ? now.source.hash.slice(0, 7)
          : ch.kind === "untracked"
            ? "untracked"
            : r.scope === "uncommitted"
              ? "working copy"
              : this.origin(co, ch.path);
      if (origin && end + origin.length + 3 < c.w) c.text(c.w - origin.length - 3, ty, ` ${origin} `, colors.faint);
    }
    if (r.tree_hidden && changes.length) c.text(c.w - 12, ty, " z: files ", colors.faint);
    const dy = ty + 1,
      dh = c.h - 1 - dy;
    this.page = dh;
    if (now && dh > 0) this.drawDiff(c, r, now, dy, dh, focused);
    if (r.keys) this.drawKeys(c, dy, dh);
    if (r.list) this.drawList(c, r, dy, dh, now?.source ?? null);
    this.drawFooter(c, r, now, focused);
  }
  /** Where a branch file's change is: in its commits, the working copy, or both. */
  private origin(co: Checkout, path: string): string {
    const working = co.listings.get(`w:${co.head ?? git.empty_tree}`);
    if (!working) return "";
    const uncommitted = working.changes.some(ch => ch.path === path),
      committed = co.commits.length > 0 && this.committed(co, path, working.changes);
    return committed && uncommitted ? "committed + working copy" : uncommitted ? "working copy" : "committed";
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
    focused: boolean,
  ): number {
    const colors = palette.colors,
      rows = this.fileRows(r, paths, edited),
      now = Date.now(),
      height = Math.max(1, Math.min(r.tree_rows, rows.length, Math.max(3, Math.floor((c.h - 8) / 2))));
    let sel = rows.findIndex(row => row.id === r.tree_sel);
    if (sel < 0 && r.path) sel = rows.findIndex(row => row.id === "f:" + r.path);
    if (sel >= 0) {
      if (sel < r.tree_top) r.tree_top = sel;
      if (sel >= r.tree_top + height) r.tree_top = sel - height + 1;
    }
    r.tree_top = Math.min(Math.max(0, r.tree_top), Math.max(0, rows.length - height));
    c.hit(0, ty, c.w, height, { wheel: "tree" });
    const byPath = new Map(changes.map(ch => [ch.path, ch]));
    rows.slice(r.tree_top, r.tree_top + height).forEach((row, i) => {
      const y = ty + i,
        on = row.id === r.tree_sel || (sel < 0 && row.kind === "file" && row.path === r.path),
        active = on && focused && r.part === "tree",
        bg = active ? colors.selected : on ? palette.mix(colors.bg, colors.selected, 50) : null;
      c.fill(y, bg);
      if (active) c.put(0, y, "▌", colors.accent, bg);
      const indent = 1 + row.depth * 2;
      const right: [string, palette.Rgb][] = [];
      if (row.kind === "dir") {
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
        const room = c.w - 1 - right.reduce((s, p) => s + [...p[0]].length + 1, 0) - (indent + 2);
        c.text(indent + 2, y, row.name + "/", on ? colors.strong : colors.muted, bg, on, room);
        c.hit(0, y, c.w, 1, {
          act: () => {
            r.part = "tree";
            r.tree_sel = row.id;
            r.toggled = tree.setOpen(r.toggled, row, !row.open);
          },
        });
      } else {
        const ch = byPath.get(row.path)!;
        const mark =
          ch.kind === "added" || ch.kind === "untracked"
            ? ["A", colors.accent]
            : ch.kind === "deleted"
              ? ["D", colors.hot]
              : ch.kind === "renamed"
                ? ["R", colors.muted]
                : ["M", colors.muted];
        c.text(indent, y, mark[0] as string, mark[1] as palette.Rgb, bg, true);
        if (r.notes.some(n => n.path === row.path)) right.push(["•", colors.warm]);
        if (ch.binary) right.push(["bin", colors.faint]);
        else {
          if (ch.generated) right.push(["gen", colors.faint]);
          if (ch.adds) right.push(["+" + ch.adds.toLocaleString("en-US"), colors.accent]);
          if (ch.dels) right.push(["−" + ch.dels.toLocaleString("en-US"), colors.hot]);
        }
        const at = edited?.get(row.path);
        if (edited) right.push([(at === undefined ? "" : age((now - at) / 1000)).padStart(5), colors.faint]);
        const room = c.w - 1 - right.reduce((s, p) => s + [...p[0]].length + 1, 0) - (indent + 2);
        const end = c.text(indent + 2, y, row.name, on ? colors.strong : colors.text, bg, on, room);
        if (row.dir) c.text(end + 2, y, row.dir, colors.faint, bg, false, indent + 2 + room - end - 2);
        c.hit(0, y, c.w, 1, {
          act: () => {
            r.part = "tree";
            r.tree_sel = row.id;
            if (r.path !== row.path) this.select(r, row.path, paths);
          },
        });
      }
      let px = c.w - right.reduce((s, p) => s + [...p[0]].length + 1, 0);
      for (const [s, fg] of right) px = c.text(px, y, s, fg, bg) + 1;
    });
    if (rows.length > height) {
      const shown = `${Math.min(rows.length, r.tree_top + height)}/${rows.length}`;
      c.text(c.w - shown.length - 2, ty + height, ` ${shown} `, colors.faint);
    }
    return ty + height;
  }
  private notice(c: Canvas, dy: number, lines: [string, palette.Rgb][], act?: () => void): void {
    const colors = palette.colors,
      width = Math.min(c.w - 4, Math.max(...lines.map(l => [...l[0]].length)) + 6),
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
  private drawDiff(
    c: Canvas,
    r: Review,
    now: NonNullable<ReturnType<Panel["current"]>>,
    dy: number,
    dh: number,
    focused: boolean,
  ): void {
    const colors = palette.colors,
      ch = now.change;
    if (!ch) return;
    c.hit(0, dy, c.w, dh, { wheel: "diff" });
    if (ch.generated && !r.loaded.has(ch.path))
      return this.notice(
        c,
        dy,
        [
          [
            `Generated file · +${(ch.adds ?? 0).toLocaleString("en-US")} −${(ch.dels ?? 0).toLocaleString("en-US")}`,
            colors.text,
          ],
          ["Its diff starts collapsed. Enter loads it.", colors.faint],
        ],
        () => {
          r.loaded.add(ch.path);
          this.loadSelected();
        },
      );
    const file = now.file;
    if (!file) return void c.text(2, dy + 1, "Reading the diff…", colors.faint);
    const loaded = file.loaded;
    if (loaded.kind === "binary")
      return this.notice(c, dy, [
        ["Binary file", colors.text],
        ["No text diff and no line notes.", colors.faint],
      ]);
    if (loaded.kind === "too_large")
      return this.notice(c, dy, [
        [`Too large to show here · ${(loaded.bytes / 1e6).toFixed(1)} MB`, colors.text],
        ["The limit is 2 MB or 50,000 lines.", colors.faint],
        [
          `git counts +${(ch.adds ?? 0).toLocaleString("en-US")} −${(ch.dels ?? 0).toLocaleString("en-US")}.`,
          colors.faint,
        ],
      ]);
    if (loaded.kind === "failed")
      return this.notice(c, dy, [
        ["git couldn't diff this file", colors.text],
        [loaded.message, colors.faint],
      ]);
    const d = loaded.diff,
      path = ch.path,
      units = this.units(r, d, path);
    if (r.cur >= units.length) r.cur = Math.max(0, units.length - 1);
    const gutter = d.gutter(),
      code_x = gutter + 2,
      code_w = Math.max(10, c.w - code_x - 1),
      box_x = code_x,
      box_w = c.w - box_x - 1;
    const rev = revOf(now.source);
    const mine = r.notes.filter(n => n.path === path && notes.sameRev(n.rev, rev));
    const after = new Map<string, notes.Note[]>();
    const noted = new Set<string>();
    for (const n of mine) {
      if (r.compose?.edit === n.id) continue;
      const k = `${n.side}:${n.end}`;
      after.set(k, [...(after.get(k) ?? []), n]);
      for (let line = n.start; line <= n.end; line++) noted.add(`${n.side}:${line}`);
    }
    const wrapText = (s: string, width: number) => {
      const out: string[] = [];
      for (const para of s.split("\n")) {
        let line = "";
        for (const word of para.split(" ")) {
          if (!line) line = word;
          else if ((line + " " + word).length <= width) line += " " + word;
          else {
            out.push(line);
            line = word;
          }
          while (line.length > width) {
            out.push(line.slice(0, width));
            line = line.slice(width);
          }
        }
        out.push(line);
      }
      return out;
    };
    const heightOf = (unit: diff.Unit) =>
      unit.kind === "fold" || !r.wrap
        ? 1
        : Math.min(wrap_cap, Math.max(1, Math.ceil(d.text(d.rows[unit.row]).length / code_w)));
    type Item =
      | { kind: "unit"; unit: diff.Unit; at: number; h: number }
      | { kind: "note"; note: notes.Note; h: number }
      | { kind: "compose"; h: number };
    const items: Item[] = [];
    units.forEach((unit, at) => {
      items.push({ kind: "unit", unit, at, h: heightOf(unit) });
      if (unit.kind !== "row") return;
      const row = d.rows[unit.row];
      for (const side of ["new", "old"] as const) {
        const line = notes.lineOn(row, side);
        if (line === 0) continue;
        for (const n of after.get(`${side}:${line}`) ?? [])
          items.push({ kind: "note", note: n, h: 2 + wrapText(n.text, box_w - 4).length });
        if (r.compose && r.compose.path === path && r.compose.side === side && r.compose.end === line)
          items.push({ kind: "compose", h: 2 + Math.max(1, wrapText(r.compose.text, box_w - 4).length) });
      }
    });
    const ys: number[] = [];
    let total = 0;
    for (const item of items) {
      ys.push(total);
      total += item.h;
    }
    const cur_item = items.findIndex(it => it.kind === "unit" && it.at === r.cur);
    let top = r.top;
    if (r.compose) {
      const ci = items.findIndex(it => it.kind === "compose");
      if (ci >= 0) {
        const bottom = ys[ci] + items[ci].h;
        if (bottom > top + dh) top = bottom - dh;
      }
    } else if (!r.free && cur_item >= 0) {
      const cy = ys[cur_item],
        h = items[cur_item].h;
      if (cy < top) top = Math.max(0, cy - 2);
      if (cy + h > top + dh) top = cy + h - dh + 2;
    }
    top = Math.min(Math.max(0, top), Math.max(0, total - dh));
    r.top = top;
    const sel = r.compose
      ? r.compose.range
      : r.anchor !== null
        ? [Math.min(r.anchor, r.cur), Math.max(r.anchor, r.cur)]
        : null;
    let first = 0;
    while (first < items.length && ys[first] + items[first].h <= top) first++;
    const hl = { old: now.file!.old, new: now.file!.new };
    for (let i = first; i < items.length && ys[i] < top + dh; i++) {
      const item = items[i],
        y0 = dy + ys[i] - top;
      if (item.kind === "unit") {
        const cursor = item.at === r.cur && focused && r.part === "diff";
        if (item.unit.kind === "fold") {
          if (y0 < dy) continue;
          const bg = cursor ? tint.cursor : tint.fold;
          c.fill(y0, bg);
          c.text(
            2,
            y0,
            `⋯  ${plural(item.unit.end - item.unit.start, "unmodified line")}${cursor ? "  →  expand" : ""}`,
            cursor ? colors.muted : colors.faint,
            bg,
          );
          const unit = item.unit,
            at = item.at;
          c.hit(0, y0, c.w, 1, { act: () => (r.cur === at ? this.openFold(r, d, unit) : (r.cur = at)) });
          continue;
        }
        const in_sel = sel !== null && item.at >= sel[0] && item.at <= sel[1];
        this.drawRow(c, r, d, item.unit.row, y0, dy, dy + dh, gutter, code_x, code_w, cursor, in_sel, noted, hl);
        const vy = Math.max(y0, dy),
          vh = Math.min(y0 + item.h, dy + dh) - vy;
        if (vh > 0) c.hit(0, vy, c.w, vh, { unit: item.at, wheel: "diff" });
        continue;
      }
      const is_note = item.kind === "note";
      const title = is_note
        ? notes.location(item.note)
        : `${r.compose!.edit !== null ? "edit note" : "note"} · ${r.compose!.path}:${r.compose!.start}`;
      const border = is_note ? colors.line : palette.outline;
      const body = wrapText(is_note ? item.note.text : r.compose!.text, box_w - 4);
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
          const end = c.text(box_x + 2, ly, body[j - 1] ?? "", colors.text, colors.surface, false, box_w - 4);
          if (!is_note && j === item.h - 2 && focused) c.put(end, ly, " ", colors.surface, colors.text);
        }
      }
    }
    if (total > dh) {
      const thumb = Math.max(1, Math.round((dh * dh) / total)),
        at = dy + Math.round(((dh - thumb) * top) / Math.max(1, total - dh));
      for (let j = 0; j < thumb; j++) c.put(c.w - 1, at + j, "▐", colors.line);
    }
  }
  private drawRow(
    c: Canvas,
    r: Review,
    d: diff.FileDiff,
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
      found = r.find?.by_row.get(index) ?? null,
      chars = [...text],
      lines = r.wrap ? Math.min(wrap_cap, Math.max(1, Math.ceil(chars.length / code_w))) : 1,
      number = diff.FileDiff.number(row),
      commented = noted.has(`${side}:${number}`);
    const inside = (ranges: diff.Ranges | null, at: number) =>
      ranges !== null && ranges.some(([s, e]) => at >= s && at < e);
    // Spans and ranges count UTF-16 units; walk both together.
    let unit = 0;
    const offsets = chars.map(ch => {
      const at = unit;
      unit += ch.length;
      return at;
    });
    for (let j = 0; j < lines; j++) {
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
      let from = r.wrap ? j * code_w : r.shift,
        to = from + code_w;
      let tail: string | null = null;
      if (r.wrap && j === lines - 1 && chars.length > to) {
        tail = ` … ${(chars.length - to + 24).toLocaleString("en-US")} more characters`;
        to -= tail.length;
      }
      let si = 0;
      for (let k = from; k < Math.min(to, chars.length); k++) {
        const at = offsets[k];
        let fg = colors.text;
        while (si < spans.length && spans[si][1] <= at) si++;
        if (si < spans.length && spans[si][0] <= at) fg = palette.syntax[spans[si][2]];
        let cell_bg = bg;
        if (em && inside(em, at)) cell_bg = em_bg;
        if (found && inside(found, at)) {
          cell_bg = tint.match;
          fg = colors.strong;
        }
        c.put(code_x + k - from, y, chars[k] === "\t" ? " " : safe(chars[k]), fg, cell_bg);
      }
      if (tail) c.text(code_x + to - from, y, tail, colors.faint, bg);
      if (!r.wrap) {
        if (r.shift > 0 && chars.length) c.put(code_x - 1, y, "‹", colors.faint, bg);
        if (chars.length > r.shift + code_w) c.put(code_x + code_w - 1, y, "›", colors.faint, bg);
      }
    }
  }
  private drawKeys(c: Canvas, dy: number, dh: number): void {
    const colors = palette.colors;
    const groups: [string, string[]][] = [
      [
        "Move",
        [
          "j k  file in the tree, line in the diff",
          "tab  tree ⇄ diff",
          "] [  hunk, across files",
          "f F  next, previous file",
          "→ enter  open a fold, folder or generated diff",
          "← →  scroll sideways when unwrapped",
          "pgdn ctrl+d  page, half page",
        ],
      ],
      [
        "View",
        [
          "a u  all (default), uncommitted",
          "g G  commits: switch, pick another",
          "w  wrap   /  find in file",
          "o O  sort files by name or last edit, reverse",
          "p  pin to this checkout; notes go to the focused pane",
          "z < >  hide, grow, shrink the tree",
        ],
      ],
      [
        "Notes",
        [
          "v c  select, comment   ctrl+j  newline",
          "e d  edit, delete   n N  next, previous",
          "l  list   s  paste into the pane   y  copy",
        ],
      ],
      ["Leave", ["esc  back to the pane   q  hide the panel"]],
    ];
    const lines: [string, boolean][] = [];
    for (const [head, rows] of groups) {
      lines.push([head, true]);
      for (const row of rows) lines.push([row, false]);
    }
    const height = Math.min(dh, lines.length + 2),
      width = Math.min(c.w - 2, 52);
    this.box(c, 1, dy, width, height, " Keys ");
    lines
      .slice(0, height - 2)
      .forEach(([s, head], i) =>
        c.text(3, dy + 1 + i, s, head ? colors.faint : colors.text, colors.surface, head, width - 4),
      );
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
    this.box(c, 1, dy, c.w - 2, height, ` Notes · ${n} `);
    if (n === 0) return void c.text(3, dy + 1, "No notes yet.", colors.muted, colors.surface);
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
        c.text(end + 2, y, "not in this view", colors.faint, bg);
      c.text(3, y + 1, note.text.replace(/\n/g, " "), colors.muted, bg, false, c.w - 6);
      c.hit(2, y, c.w - 4, 2, {
        act: () => {
          this.jumpToNote(r, note);
          r.list = null;
        },
      });
    });
  }
  private drawFooter(c: Canvas, r: Review, now: ReturnType<Panel["current"]>, focused: boolean): void {
    const colors = palette.colors,
      y = c.h - 1;
    c.fill(y, null);
    const keycap = (x: number, k: string) => c.text(x, y, k, colors.strong, colors.line, true);
    // `end` sits at the right edge and stays when the others run out of room.
    const hints = (list: [string, string, (() => void)?][], end?: [string, string]) => {
      let x = 1,
        limit = c.w;
      if (end) {
        limit = c.w - 1 - [...end[0]].length - 1 - end[1].length;
        c.text(keycap(limit, end[0]) + 1, y, end[1], colors.muted);
      }
      for (const [k, label, act] of list) {
        const need = [...k].length + 1 + label.length + 2;
        if (x + need > limit) break;
        const start = x;
        x = keycap(x, k);
        x = c.text(x + 1, y, label, colors.muted) + 2;
        if (act) c.hit(start, y, x - start - 2, 1, { act });
      }
    };
    if (r.find) {
      let x = keycap(1, "/");
      x = c.text(x + 1, y, r.find.query, colors.strong, null, true);
      if (focused) c.put(x, y, " ", colors.bg, colors.text);
      const count = r.find.query
        ? r.find.hits.length
          ? `${r.find.at + 1}/${r.find.hits.length}`
          : "no match"
        : "type to find";
      c.text(x + 2, y, count, r.find.query && !r.find.hits.length ? colors.hot : colors.faint);
      return;
    }
    if (r.status)
      return void c.text(1, y, r.status.text, r.status.warm ? colors.warm : colors.muted, null, false, c.w - 2);
    if (!focused) return;
    if (r.compose)
      return hints([
        ["enter", "save"],
        ["esc", "cancel"],
        ["ctrl+j", "newline"],
      ]);
    if (r.list)
      return hints([
        ["enter", "jump"],
        ["d", "delete"],
        ["esc", "close"],
      ]);
    if (r.picker)
      return hints([
        ["j/k", "commit"],
        ["enter", "review it alone"],
        ["esc", "close"],
      ]);
    if (r.anchor !== null)
      return hints([
        ["c", `comment on ${plural(Math.abs(r.anchor - r.cur) + 1, "row")}`],
        ["esc", "cancel"],
      ]);
    const to = this.destination(),
      elsewhere = to && to.pane !== this.target?.pane ? ` to ${to.name}` : "";
    const send: [string, string, () => void] = [
      "s",
      (r.notes.length ? `send ${r.notes.length}` : "send") + elsewhere,
      () => (this.pending = this.send(r, false)),
    ];
    const close: [string, string] = ["q", "close"];
    if (r.part === "tree" && !r.tree_hidden)
      return hints([["j/k", "file"], ["enter", "open"], ["tab", "diff"], ["]", "hunk"], send, ["?", "keys"]], close);
    const d = now?.file?.loaded.kind === "diff" ? now.file.loaded.diff : null;
    const units = d && r.path ? this.units(r, d, r.path) : [];
    if (now?.change?.generated && !r.loaded.has(now.change.path))
      return hints([["enter", "load the diff"], ["f", "next file"], send, ["?", "keys"]], close);
    if (units[r.cur]?.kind === "fold") return hints([["→", "expand"], ["]/[", "hunk"], send, ["?", "keys"]], close);
    if (d && now && this.noteAt(r, d, units, now))
      return hints([["e", "edit"], ["d", "delete"], ["]/[", "hunk"], send, ["?", "keys"]], close);
    hints(
      [
        ["v", "select"],
        ["c", "comment"],
        ["]/[", "hunk"],
        ["w", r.wrap ? "unwrap" : "wrap"],
        ["/", "find"],
        send,
        ["?", "keys"],
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
  const widest = (key: keyof (typeof cells)[number]) => Math.max(0, ...cells.map(cell => cell[key].length));
  const adds = widest("adds"),
    dels = widest("dels"),
    files = Math.max("files".length, widest("files")),
    lines = Math.max("lines".length, adds + 1 + dels),
    when = Math.max("age".length, widest("age"));
  return {
    heading: `${"files".padStart(files)}  ${"lines".padStart(lines)}  ${"age".padStart(when)}`,
    notes: list.map((cm, i) => [
      [cells[i].files.padStart(files), "muted"],
      [cells[i].adds.padStart(lines - dels - 1 + 2), cm.adds ? "accent" : "faint"],
      [cells[i].dels.padStart(dels + 1), cm.dels ? "hot" : "faint"],
      [cells[i].age.padStart(when + 2), "faint"],
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
    return [["git didn't answer", "faint"]];
  }
}
/** `summary` from changes already read, as the panel's "all" scope reads them. */
export function summaryRuns(changes: git.Change[], base: git.Base | null): dropdown.Run[] {
  if (changes.length === 0) return [[base ? `No changes since ${base.name}` : "No changes", "faint"]];
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
  if (seconds < 90) return "now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h`;
  return `${Math.round(seconds / 86400)} d`;
}
function ago(seconds: number): string {
  if (seconds < 90) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86400 * 2) return `${Math.round(seconds / 3600)} h ago`;
  return `${Math.round(seconds / 86400)} days ago`;
}
