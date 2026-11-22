//! The directory browser: a card under a folder's name in a pane, once the
//! pointer has rested on it as long as a link's card waits. It lists the
//! folder, folders first. A click pins it and gives it the keyboard: typing
//! searches every path below it, fzf-style, ranking what a walk finds as it
//! streams in (see dir_walk.ts and fuzzy.ts), and Enter opens a file or goes
//! into a folder.
import { basename, dirname, join } from "node:path";
import { Canvas } from "./canvas";
import * as dirWalk from "./dir_walk";
import * as errors from "./errors";
import * as fileAccess from "./file_access";
import { size } from "./file_peek";
import * as fuzzy from "./fuzzy";
import * as i18n from "./i18n";
import type * as keys from "./keys";
import { Rect } from "./layout";
import * as palette from "./palette";
import { TextArea, Typed, byte_edits, key_edits } from "./text_area";
import { codepointWidth, directoryLabel, displayWidth, shortPath, type Writer } from "./text";

/** The entries a card shows. */
export const rows = 12;
const max_width = 80;
/** Rows one wheel step moves. */
export const wheel_rows = 3;
/** How long the matcher runs before letting the viewer draw. */
const slice_ms = 4;
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** An entry the card shows: a path from its folder, with no trailing "/". */
export interface Row {
  path: string;
  directory: boolean;
  /** A file's size, where the listing has it. */
  size: number | null;
}
interface Candidate {
  entry: dirWalk.Entry;
  match: fuzzy.Candidate;
}
interface Match {
  index: number;
  score: number;
}

/** Everything under a folder, as its walk finds it, and the query's
 * matches among them, ranked as they're scored. Scoring runs a few
 * milliseconds at a time, so a big tree never holds up the viewer. */
export class Search {
  candidates: Candidate[] = [];
  progress = dirWalk.started();
  results: Match[] = [];
  private pattern: fuzzy.Pattern | null = null;
  private query = "";
  /** Earlier matches to score again first, when the query only grew. */
  private queue: number[] = [];
  /** The first candidate not yet scored. */
  private next = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private abort = new AbortController();
  /** The walk, for tests to wait on. */
  readonly walked: Promise<void>;
  constructor(
    readonly root: string,
    files: fileAccess.Files,
    private wake: () => void,
  ) {
    this.walked = files
      .walk(
        root,
        (batch, progress) => {
          if (this.abort.signal.aborted) return;
          for (const entry of batch) this.candidates.push({ entry, match: new fuzzy.Candidate(entry.path) });
          this.progress = progress;
          this.schedule();
          this.wake();
        },
        this.abort.signal,
      )
      .then(
        progress => {
          if (this.abort.signal.aborted) return;
          this.progress = progress;
          this.wake();
        },
        error => {
          if (this.abort.signal.aborted) return;
          this.progress = { ...this.progress, done: true, error: errors.name(error) ?? "WalkFailed" };
          this.wake();
        },
      );
  }
  /** Matches `query` from now on: among the last matches when it only
   * grew, else among everything again. */
  match(query: string): void {
    if (query === this.query) return;
    const narrows = this.pattern !== null && query.startsWith(this.query);
    this.query = query;
    this.pattern = fuzzy.pattern(query);
    if (narrows) {
      this.queue = [...this.queue, ...this.results.map(r => r.index)];
    } else {
      this.queue = [];
      this.next = 0;
    }
    this.results = [];
    this.schedule();
  }
  /** Candidates are waiting to be scored. */
  get scoring(): boolean {
    return this.pattern !== null && (this.queue.length > 0 || this.next < this.candidates.length);
  }
  /** Still walking or scoring. */
  get busy(): boolean {
    return !this.progress.done || this.scoring;
  }
  private schedule(): void {
    if (this.timer === null && !this.abort.signal.aborted) this.timer = setTimeout(() => this.pump(), 0);
  }
  /** Scores for a slice of time, then merges what matched into the ranking. */
  pump(): void {
    this.timer = null;
    const p = this.pattern;
    if (!p) {
      this.queue = [];
      this.next = this.candidates.length;
      return;
    }
    const until = performance.now() + slice_ms,
      found: Match[] = [];
    let n = 0;
    const take = (index: number) => {
      const score = fuzzy.score(p, this.candidates[index].match);
      if (score !== null) found.push({ index, score });
    };
    while (this.queue.length > 0 && (++n & 255 || performance.now() < until)) take(this.queue.pop()!);
    while (this.queue.length === 0 && this.next < this.candidates.length && (++n & 255 || performance.now() < until))
      take(this.next++);
    if (found.length) this.results = merge(this.results, found.sort(this.order), this.order);
    if (this.queue.length > 0 || this.next < this.candidates.length) this.schedule();
    this.wake();
  }
  /** Best first; then the shorter path, then the one found first. */
  private order = (a: Match, b: Match): number =>
    b.score - a.score ||
    this.candidates[a.index].entry.path.length - this.candidates[b.index].entry.path.length ||
    a.index - b.index;
  /** Where `path` ranks, or -1; it looks where it last was first. */
  indexOf(path: string): number {
    const at = (i: number) => this.candidates[this.results[i].index].entry.path === path;
    if (this.last < this.results.length && at(this.last)) return this.last;
    for (let i = 0; i < this.results.length; i++) if (at(i)) return (this.last = i);
    return -1;
  }
  private last = 0;
  row(i: number): Row | null {
    const m = this.results[i];
    if (!m) return null;
    const { path, directory } = this.candidates[m.index].entry;
    return { path, directory, size: null };
  }
  /** The query's characters in `path`, to highlight. */
  positions(path: string): number[] {
    return this.pattern ? fuzzy.positions(this.pattern, path) : [];
  }
  close(): void {
    this.abort.abort();
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}
/** Two rankings in `order` as one. */
function merge(a: Match[], b: Match[], order: (x: Match, y: Match) => number): Match[] {
  if (a.length === 0) return b;
  const out: Match[] = new Array(a.length + b.length);
  let i = 0,
    j = 0,
    k = 0;
  while (i < a.length && j < b.length) out[k++] = order(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}

/** What a chosen entry does: a file to open, or nothing more, having gone into a folder. */
export type Chosen = { file: string } | null;

export class Browser {
  /** The folder it shows, which Enter on a folder and Backspace change. */
  root: string;
  readonly key: string;
  query = new TextArea("", false);
  private typed = new Typed();
  listing: Row[] | null = null;
  /** The listing left entries out. */
  more = false;
  error: string | null = null;
  search: Search | null = null;
  /** The selected entry's path, kept while the list ranks again, once the
   * keyboard or a click has moved it; else the first row is selected. */
  selected: string | null = null;
  chosen = false;
  /** The row at the top. */
  top = 0;
  /** The listing that fills it, for tests to wait on. */
  listed: Promise<void> = Promise.resolve();
  private closed = false;
  private generation = 0;
  /** Folders gone to and entries chosen, so a slow reply to an older choice is dropped. */
  private moves = 0;
  constructor(
    readonly path: string,
    private wake: () => void,
    readonly files: fileAccess.Files = fileAccess.here,
  ) {
    this.key = path;
    this.root = path;
    this.load();
  }
  private load(): void {
    const generation = ++this.generation,
      root = this.root;
    this.listing = null;
    this.more = false;
    this.error = null;
    this.listed = this.files.list(root).then(
      listing => {
        if (this.closed || generation !== this.generation) return;
        this.listing = listing.entries
          .map(e => ({ path: e.name, directory: e.directory, size: e.directory ? null : e.size }))
          .sort((a, b) => Number(b.directory) - Number(a.directory) || collator.compare(a.path, b.path));
        this.more = listing.more;
        this.wake();
      },
      error => {
        if (this.closed || generation !== this.generation) return;
        this.error = errors.name(error) ?? "ReadFailed";
        this.wake();
      },
    );
  }
  get text(): string {
    return this.query.text;
  }
  /** Searching: the query has something to match. */
  get searching(): boolean {
    return fuzzy.pattern(this.text) !== null;
  }
  count(): number {
    return this.searching ? (this.search?.results.length ?? 0) : (this.listing?.length ?? 0);
  }
  row(i: number): Row | null {
    if (this.searching) return this.search?.row(i) ?? null;
    return this.listing?.[i] ?? null;
  }
  /** The selected row's index. */
  index(): number {
    const selected = this.selected;
    return !this.chosen || selected === null ? 0 : Math.max(0, this.find(selected));
  }
  /** The row of the entry at `path`, or -1. */
  find(path: string): number {
    if (this.searching) return this.search?.indexOf(path) ?? -1;
    return this.listing?.findIndex(row => row.path === path) ?? -1;
  }
  /** Fits the place to `count()`: the top stays in range. */
  sync(): void {
    this.top = Math.max(0, Math.min(this.top, this.count() - rows));
    if (this.chosen && this.selected !== null && this.row(this.index())?.path !== this.selected) this.chosen = false;
  }
  /** The query changed: rank again, from the first row. */
  private edited(): void {
    this.chosen = false;
    this.selected = null;
    this.top = 0;
    if (!this.searching) return;
    this.search ??= new Search(this.root, this.files, this.wake);
    this.search.match(this.text);
  }
  /** Types one byte of a character or an edit; false for a byte it doesn't take. */
  typeByte(byte: number): boolean {
    const before = this.text,
      edit = byte_edits[byte];
    if (edit) this.query.apply(edit);
    else if (byte >= 32 && byte !== 127) {
      const ch = this.typed.take(byte);
      if (ch === null) return true;
      this.query.insert(ch);
    } else return false;
    if (this.text !== before) this.edited();
    return true;
  }
  /** A key the query takes, as every text box does; false for one it doesn't. */
  editKey(key: keys.Key): boolean {
    const before = this.text,
      edit = key_edits[key];
    if (!edit || edit === "up" || edit === "down") return false;
    this.query.apply(edit);
    if (this.text !== before) this.edited();
    return true;
  }
  move(by: number): void {
    const n = this.count();
    if (n === 0) return;
    const i = Math.max(0, Math.min(n - 1, this.index() + by));
    this.select(i);
  }
  /** Selects row `i` and keeps it in view. */
  select(i: number): void {
    const row = this.row(i);
    if (!row) return;
    this.selected = row.path;
    this.chosen = true;
    if (i < this.top) this.top = i;
    else if (i >= this.top + rows) this.top = i - rows + 1;
  }
  wheel(up: boolean): void {
    this.top = Math.max(0, Math.min(this.top + (up ? -wheel_rows : wheel_rows), this.count() - rows));
  }
  /** Shows the folder at `path`, with an empty query. */
  private go(path: string, select: string | null = null): void {
    this.moves++;
    this.search?.close();
    this.search = null;
    this.root = path;
    this.query = new TextArea("", false);
    this.selected = select;
    this.chosen = select !== null;
    this.top = 0;
    this.load();
    if (select !== null)
      void this.listed.then(() => {
        const i = this.listing?.findIndex(row => row.path === select) ?? -1;
        if (i >= 0) this.select(i);
        this.top = Math.max(0, Math.min(this.top, this.count() - rows));
        this.wake();
      });
  }
  /** Goes up a folder, selecting the one it came from. */
  parent(): void {
    const up = dirname(this.root);
    if (up !== this.root) this.go(up, basename(this.root));
  }
  /** Opens the selected row, or row `i`: a folder here, or a file to open in a pane. */
  async choose(i = this.index()): Promise<Chosen> {
    const row = this.row(i);
    if (!row) return null;
    const path = join(this.root, row.path),
      move = ++this.moves;
    // A Git submodule lists as a file, and a link may lead to a folder.
    const directory = row.directory || (await this.files.find(path, "", true).catch(() => null))?.directory === true;
    // Going elsewhere, or choosing again, meanwhile drops this choice.
    if (this.closed || move !== this.moves) return null;
    if (!directory) return { file: path };
    this.go(path);
    return null;
  }
  close(): void {
    this.closed = true;
    this.search?.close();
  }
}

/** The one browser a viewer prepares or shows over a folder's name. */
export class Browsers {
  current: Browser | null = null;
  constructor(private wake: () => void) {}
  /** The browser of `path` among `files`, listed now when it's new. */
  get(path: string, files: fileAccess.Files = fileAccess.here): Browser {
    if (this.current?.key === path && this.current.files === files) return this.current;
    this.current?.close();
    return (this.current = new Browser(path, this.wake, files));
  }
  /** Hands the current browser over, as pinning it does. */
  take(): Browser | null {
    const taken = this.current;
    this.current = null;
    return taken;
  }
  clear(): void {
    this.current?.close();
    this.current = null;
  }
}

/** The card under the name at `anchor`, or over it when there's no room below. */
export function geometry(width: number, height: number, anchor: { x: number; y: number }): Rect | null {
  const w = Math.min(max_width, width - 2),
    h = rows + 4;
  if (w < 32 || height < h + 1) return null;
  const below = anchor.y + 1 + h <= height;
  return new Rect(
    Math.max(0, Math.min(anchor.x - 2, width - w)),
    below ? anchor.y + 1 : Math.max(0, anchor.y - h),
    w,
    h,
  );
}
/** The list row under `x`, `y`, or null off the list. */
export function rowAt(rect: Rect, x: number, y: number): number | null {
  const r = y - rect.y - 3;
  return x > rect.x && x < rect.x + rect.w - 1 && r >= 0 && r < rows ? r : null;
}

export function draw(
  w: Writer,
  rect: Rect,
  b: Browser,
  pinned: boolean,
  pointer: { x: number; y: number } | null,
  now = Date.now(),
): void {
  const colors = palette.colors,
    c = new Canvas(rect.x, rect.y, rect.w, rect.h),
    bg = colors.surface,
    inner = rect.w - 4;
  for (let r = 0; r < rect.h; r++) c.fill(r, bg);
  const edge = (r: number, left: string, right: string) => {
    c.put(0, r, left, colors.line, bg);
    for (let x = 1; x < rect.w - 1; x++) c.put(x, r, r === 0 || r === rect.h - 1 ? "─" : " ", colors.line, bg);
    c.put(rect.w - 1, r, right, colors.line, bg);
  };
  edge(0, "╭", "╮");
  for (let r = 1; r < rect.h - 1; r++) edge(r, "│", "│");
  edge(rect.h - 1, "╰", "╯");
  b.sync();
  const search = b.searching ? b.search : null;
  // The folder, where it is, then what it holds or how the search goes.
  const info = search ? searchInfo(search, now) : listingInfo(b);
  const info_w = info.reduce((n, [text]) => n + displayWidth(text), 0);
  const name = basename(b.root) || "/";
  let x = c.text(2, 1, name === "/" ? name : name + "/", colors.strong, bg, true, inner);
  const room = rect.w - 5 - info_w - x;
  if (name !== "/")
    x = c.text(x + 2, 1, shortPath(directoryLabel(dirname(b.root)), room), colors.muted, bg, false, room);
  let ix = rect.w - 2 - info_w;
  for (const [text, color, bold] of info) ix = c.text(ix, 1, text, color, bg, bold);
  drawQuery(c, b, pinned, inner);
  // The list.
  const hover = pointer ? rowAt(rect, pointer.x, pointer.y) : null,
    selected = pinned ? b.index() : -1,
    count = b.count(),
    bar = count > rows ? 1 : 0;
  if (b.error !== null && !search) c.text(2, 3, i18n.t`Can't read this folder`, colors.hot, bg, false, inner);
  else if (!search && b.listing === null) c.text(2, 3, i18n.t`Reading…`, colors.muted, bg, false, inner);
  else if (count === 0) {
    const empty = !search
      ? i18n.t`Empty folder`
      : search.progress.error !== null
        ? i18n.t`Can't search this folder`
        : search.busy
          ? i18n.t`Searching…`
          : i18n.t`No matches`;
    c.text(2, 3, empty, search?.progress.error ? colors.hot : colors.muted, bg, false, inner);
  }
  for (let r = 0; r < rows; r++) {
    const i = b.top + r,
      row = b.row(i);
    if (!row) break;
    const row_bg = i === selected ? colors.selected : r === hover ? palette.mix(bg, colors.selected, 50) : bg;
    c.fill(3 + r, row_bg, 1, rect.w - 1 - bar);
    if (i === selected) c.put(1, 3 + r, "›", colors.accent, row_bg, true);
    drawRow(c, 3 + r, rect.w - 2 - bar, row, row_bg, i === selected, search);
  }
  if (bar) {
    const thumb = Math.max(1, Math.round((rows * rows) / count)),
      from = Math.round(((rows - thumb) * b.top) / Math.max(1, count - rows));
    for (let r = from; r < from + thumb && r < rows; r++) c.put(rect.w - 2, 3 + r, "┃", colors.line, bg);
  }
  // What the keys do, and where the search stopped short.
  const hint = !pinned
    ? i18n.t` click to browse · scroll `
    : search
      ? i18n.t` ↑↓ select · ⏎ open · esc close `
      : i18n.t` type to search · ⏎ open · ⌫ up · esc close `;
  const note = footerNote(b, search);
  const note_w = note ? displayWidth(note) : 0;
  const hx = c.text(2, rect.h - 1, hint, colors.faint, bg, false, rect.w - 4 - (note ? note_w + 1 : 0));
  if (note && rect.w - 2 - note_w > hx) c.text(rect.w - 2 - note_w, rect.h - 1, note, colors.warm, bg);
  c.flush(w);
}
function drawQuery(c: Canvas, b: Browser, pinned: boolean, inner: number): void {
  const colors = palette.colors,
    bg = colors.surface;
  c.put(2, 2, "❯", pinned ? colors.accent : colors.faint, bg, true);
  const x0 = 4,
    room = inner - 2;
  if (!pinned) {
    if (!b.text) c.text(x0, 2, i18n.t`click to search below`, colors.faint, bg, false, room);
    else c.text(x0, 2, b.text, colors.muted, bg, false, room);
    return;
  }
  // Scrolled so the caret shows.
  const text = b.text,
    caret = b.query.caret,
    chars: { ch: string; at: number; w: number }[] = [];
  for (let at = 0; at < text.length;) {
    const ch = String.fromCodePoint(text.codePointAt(at)!);
    chars.push({ ch, at, w: Math.max(0, codepointWidth(ch.codePointAt(0)!)) });
    at += ch.length;
  }
  let before = 0;
  for (const ch of chars) if (ch.at < caret) before += ch.w;
  let skip = Math.max(0, before - (room - 1));
  let x = x0;
  for (const ch of chars) {
    if (skip > 0) {
      skip -= ch.w;
      continue;
    }
    if (x + ch.w > x0 + room) break;
    const on = ch.at === caret;
    c.put(x, 2, ch.ch, on ? bg : colors.strong, on ? colors.text : bg);
    if (ch.w === 2) c.put(x + 1, 2, "", colors.strong, bg);
    x += ch.w;
  }
  if (caret >= text.length) c.put(x, 2, " ", bg, colors.text);
  if (!text) c.text(x + 2, 2, i18n.t`type to search below`, colors.faint, bg, false, x0 + room - x - 2);
}
/** One entry: a folder's name, marked "/", or a file's with its size; a
 * search's path with the query's characters lit. */
function drawRow(
  c: Canvas,
  y: number,
  end: number,
  row: Row,
  bg: palette.Rgb,
  selected: boolean,
  search: Search | null,
): void {
  const colors = palette.colors,
    x0 = 3;
  const size_text = row.size !== null ? size(row.size) : "";
  const size_w = displayWidth(size_text);
  const room = end - x0 - (size_w ? size_w + 2 : 0) - (row.directory ? 1 : 0);
  const lit = search ? new Set(search.positions(row.path)) : new Set<number>();
  const name_at = row.path.lastIndexOf("/") + 1;
  // A path too long shows its end, where the name is.
  let start = 0,
    width = displayWidth(row.path);
  if (width > room) {
    for (; start < row.path.length && width > room - 1;) {
      const ch = String.fromCodePoint(row.path.codePointAt(start)!);
      width -= Math.max(0, codepointWidth(ch.codePointAt(0)!));
      start += ch.length;
    }
  }
  let x = x0;
  if (start > 0) c.put(x++, y, "…", colors.faint, bg);
  const plain = row.directory ? colors.strong : row.path.startsWith(".") ? colors.muted : colors.text;
  for (let at = start; at < row.path.length;) {
    const ch = String.fromCodePoint(row.path.codePointAt(at)!),
      cw = Math.max(0, codepointWidth(ch.codePointAt(0)!));
    if (x + cw > x0 + room) break;
    const color = lit.has(at) ? colors.accent : at < name_at ? colors.muted : plain;
    c.text(x, y, ch, color, bg, lit.has(at));
    x += cw;
    at += ch.length;
  }
  if (row.directory) c.put(x, y, "/", colors.muted, bg);
  if (size_w) c.text(end - size_w, y, size_text, selected ? colors.muted : colors.faint, bg);
}
function listingInfo(b: Browser): [string, palette.Rgb, boolean][] {
  const rows = b.listing;
  if (!rows) return [];
  const colors = palette.colors,
    folders = rows.filter(r => r.directory).length,
    files = rows.length - folders;
  const parts: string[] = [];
  if (folders) {
    const count = folders;
    parts.push(count === 1 ? i18n.t`${count} folder` : i18n.t`${count} folders`);
  }
  if (files || !folders) {
    const count = files;
    parts.push(count === 1 ? i18n.t`${count} file` : i18n.t`${count} files`);
  }
  return [[parts.join(" · "), colors.faint, false]];
}
function searchInfo(s: Search, now: number): [string, palette.Rgb, boolean][] {
  const colors = palette.colors,
    p = s.progress,
    out: [string, palette.Rgb, boolean][] = [];
  if (p.mode === "git") out.push([i18n.t`git · `, colors.faint, false]);
  if (s.busy) out.push([spinner[Math.floor(now / 80) % spinner.length] + " ", colors.accent, true]);
  const matched = s.results.length,
    scanned = s.candidates.length;
  out.push([`${matched}/${scanned}`, colors.faint, false]);
  if (p.capped) out.push(["+", colors.warm, true]);
  return out;
}
function footerNote(b: Browser, search: Search | null): string | null {
  if (!search) {
    const limit = fileAccess.list_limit;
    return b.more ? i18n.t` first ${limit} shown ` : null;
  }
  const p = search.progress;
  if (p.capped === "entries") {
    const limit = p.scanned;
    return i18n.t` stopped at ${limit} entries `;
  }
  if (p.capped === "time") {
    const seconds = Math.round(dirWalk.limits.ms / 1000);
    return i18n.t` stopped after ${seconds} s `;
  }
  return null;
}
