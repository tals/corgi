//! The launcher's conversations to resume: the newest few under the agent
//! rows, and every one, grouped by day and searchable, once expanded.
//! Mirrors launcher_resume.zig.
import { basename } from "node:path";
import * as palette from "./palette";
import { Style, keycap } from "./palette";
import { Dialog } from "./name_dialog";
import { Writer, writeEllipsis, truncatedText, sat } from "./text";
import * as scrollThumb from "./scroll_thumb";

export type Provider = "codex" | "claude";
export type Scope = "folder" | "workspace" | "everywhere";
const scopes: Scope[] = ["folder", "workspace", "everywhere"];
export function scopeLabel(s: Scope): string {
  return s === "folder" ? "this folder" : s === "workspace" ? "this workspace" : "everywhere";
}
/** A launcher history entry, as launch/history.zig's `Entry`. */
export interface Entry {
  provider: Provider;
  session: string;
  title: string;
  first: string;
  last: string;
  cwd: string;
  branch: string;
  updated_at: number;
  interrupted: boolean;
}
export function historyEntry(value: any): Entry {
  return {
    provider: value.provider,
    session: value.session ?? "",
    title: value.title ?? "",
    first: value.first ?? "",
    last: value.last ?? "",
    cwd: value.cwd ?? "",
    branch: value.branch ?? "",
    updated_at: Number(value.updated_at ?? 0),
    interrupted: value.interrupted === true,
  };
}
export interface History {
  pending: boolean;
  entries: Entry[];
}
/** A conversation a pane runs. Search jumps to its pane instead of starting
 * a second copy of the session. */
export interface Open {
  provider: Provider;
  session: string;
  pane: number;
}
export const max_open = 64;
const session_capacity = 160;

/** Where the launcher is, and what is already open. */
export class Context {
  constructor(
    public history: History,
    public folder: string,
    public workspace_folder: string,
    public open: Open[],
    /** Seconds. */
    public now: number,
  ) {}
  opened(e: Entry): Open | null {
    for (const o of this.open) if (o.provider === e.provider && o.session === e.session) return o;
    return null;
  }
  static within(folder: string, path: string): boolean {
    return (
      folder.length > 0 &&
      path.startsWith(folder) &&
      (path.length === folder.length || path[folder.length] === "/" || folder[folder.length - 1] === "/")
    );
  }
  inScope(e: Entry, scope: Scope): boolean {
    switch (scope) {
      case "folder":
        return e.cwd === this.folder;
      case "workspace":
        return Context.within(this.workspace_folder, e.cwd) || Context.within(this.folder, e.cwd);
      case "everywhere":
        return true;
    }
  }
  /** Listed without a search: closed and in `scope`. */
  listed(e: Entry, scope: Scope): boolean {
    return this.opened(e) === null && this.inScope(e, scope);
  }
}

/** What this Corgi knows about a conversation it ran: the name its sidebar
 * showed, and when it last saw or closed it, in seconds. */
export interface Known {
  provider: Provider;
  session: string;
  name: string;
  at: number;
}
/** `entries` as this Corgi knows them, newest first: its names, and its times
 * when later than the transcript's. */
export function merge(entries: Entry[], known: Known[]): Entry[] {
  const by_session = new Map<string, Known>();
  for (const k of known) {
    const id = `${k.provider}:${k.session}`;
    const slot = by_session.get(id);
    if (!slot) {
      by_session.set(id, { ...k });
      continue;
    }
    if (slot.name.length === 0) slot.name = k.name;
    slot.at = Math.max(slot.at, k.at);
  }
  const out = entries.map(e => {
    const merged = { ...e };
    const k = by_session.get(`${e.provider}:${e.session}`);
    if (!k) return merged;
    if (k.name.length > 0) merged.title = k.name;
    merged.updated_at = Math.max(merged.updated_at, k.at);
    return merged;
  });
  return stableSort(out, (x, y) => x.updated_at > y.updated_at);
}
/** std.mem.sort: stable, ordered by `less`. */
export function stableSort<T>(items: T[], less: (x: T, y: T) => boolean): T[] {
  return items.sort((x, y) => (less(x, y) ? -1 : less(y, x) ? 1 : 0));
}

/** How many conversations show before the list is expanded. */
export const collapsed_rows = 5;
/** One row of the list. */
export type Line =
  /** A local day's heading; the value is any second in that day. */
  | { day: number }
  | { heading: "open" | "results" }
  | { entry: number }
  /** An open conversation, by entry index. */
  | { open: number }
  /** Matches left out of the current scope. */
  | { elsewhere: number }
  /** Expands the list; the value counts the conversations it starts on. */
  | { more: number };
type Key = { conversation: { provider: Provider; session: string } } | "more";
function keyOf(c: Context, line: Line): Key | null {
  if ("entry" in line || "open" in line) {
    const e = c.history.entries["entry" in line ? line.entry : line.open];
    return { conversation: { provider: e.provider, session: truncatedText(e.session, session_capacity) } };
  }
  if ("more" in line) return "more";
  return null;
}
function keyEql(k: Key, other: Key): boolean {
  if (k === "more") return other === "more";
  return (
    other !== "more" &&
    k.conversation.provider === other.conversation.provider &&
    k.conversation.session === other.conversation.session
  );
}
export type Hit = { row: number } | "scope";

/** Terminal coordinates for the expanded list inside the launcher's border:
 * `x` is the left border's column, `y` the search line's row, `height` the
 * rows from there to the footer. */
export class Area {
  constructor(
    public x: number,
    public y: number,
    public width: number,
    public height: number,
  ) {}
  listTop(): number {
    return this.y + 2;
  }
  listHeight(): number {
    return sat(this.height, 2);
  }
}
interface Columns {
  title: number;
  folder: number;
  last: number;
}
let panel: string, rule: string, row_style: string, selected_style: string, dim: string;
palette.derived(() => {
  panel = new Style({ fg: "faint", bg: "surface" }).sgr();
  rule = new Style({ fg: "line", bg: "surface" }).sgr();
  row_style = new Style({ fg: "text", bg: "surface" }).sgr();
  selected_style = new Style({ fg: "strong", bg: "selected" }).sgr();
  dim = palette.fg("faint");
});
/** The run's rail; faint is too dim on a selected row. */
function rail(selected: boolean): string {
  return selected ? palette.fg("muted") : dim;
}

export class View {
  expanded = false;
  /** The keyboard is in this list rather than on the agent rows. */
  focused = false;
  searching = false;
  query = Dialog.init({ pane: 0 }, "");
  scope: Scope = "workspace";
  /** Kept by identity, so a refreshed list keeps the selection. */
  selected: Key | null = null;
  scroll = 0;

  constructor(fields: Partial<View> = {}) {
    Object.assign(this, fields);
  }
  search(): string {
    return this.searching ? this.query.name() : "";
  }
  matches(e: Entry): boolean {
    for (const word of this.search().split(" ")) {
      if (word.length === 0) continue;
      if (!contains(e.title, word) && !contains(e.first, word) && !contains(e.last, word)) return false;
    }
    return true;
  }
  /** The rows to show, in order. */
  lines(c: Context): Line[] {
    const out: Line[] = [];
    const entries = c.history.entries;
    if (this.search().length > 0) return this.found(c);
    if (!this.expanded) {
      // The newest in this folder; "more" counts the expanded list's
      // starting scope.
      let total = 0;
      entries.forEach((e, i) => {
        total += c.listed(e, "workspace") ? 1 : 0;
        if (out.length === collapsed_rows || !c.listed(e, "folder")) return;
        out.push({ entry: i });
      });
      out.push({ more: total });
      return out;
    }
    let day: number | null = null;
    entries.forEach((e, i) => {
      if (!c.listed(e, this.scope)) return;
      const start = dayStart(e.updated_at);
      if (day !== start) {
        out.push({ day: e.updated_at });
        day = start;
      }
      out.push({ entry: i });
    });
    return out;
  }
  /** Search results: open matches first, then closed ones in scope. */
  private found(c: Context): Line[] {
    const out: Line[] = [];
    const entries = c.history.entries;
    let open = 0;
    entries.forEach((e, i) => {
      if (open < 3 && c.opened(e) !== null && this.matches(e)) {
        if (open === 0) out.push({ heading: "open" });
        out.push({ open: i });
        open += 1;
      }
    });
    out.push({ heading: "results" });
    let elsewhere = 0;
    entries.forEach((e, i) => {
      if (c.opened(e) !== null || !this.matches(e)) return;
      if (!c.inScope(e, this.scope)) {
        elsewhere += 1;
        return;
      }
      out.push({ entry: i });
    });
    if (elsewhere > 0) out.push({ elsewhere });
    return out;
  }
  /** Closed conversations listed in `rows`. */
  static count(rows: Line[]): number {
    return rows.filter(line => "entry" in line).length;
  }
  /** The selected row's index in `rows`: the kept selection when still
   * listed, else the first row that can be selected. */
  index(c: Context, rows: Line[]): number | null {
    let first: number | null = null;
    for (let i = 0; i < rows.length; i++) {
      const k = keyOf(c, rows[i]);
      if (k === null) continue;
      if (first === null) first = i;
      if (this.selected !== null && keyEql(this.selected, k)) return i;
    }
    return first;
  }
  /** The selected conversation; null on the "more" row. */
  entry(c: Context, rows: Line[]): Entry | null {
    const i = this.index(c, rows);
    if (i === null) return null;
    const line = rows[i];
    if ("entry" in line) return c.history.entries[line.entry];
    if ("open" in line) return c.history.entries[line.open];
    return null;
  }
  /** Move by `delta` rows that can be selected, stopping at the end. False
   * when already at the top and moving up, so the caller can leave the list. */
  move(c: Context, rows: Line[], delta: number): boolean {
    let at = this.index(c, rows);
    if (at === null) return false;
    let left = Math.abs(delta);
    let moved = false;
    let i = at;
    while (left > 0) {
      if (delta > 0) {
        if (i + 1 >= rows.length) break;
        i += 1;
      } else {
        if (i === 0) break;
        i -= 1;
      }
      if (keyOf(c, rows[i]) !== null) {
        at = i;
        left -= 1;
        moved = true;
      }
    }
    if (delta < 0 && !moved) return false;
    this.selected = keyOf(c, rows[at]);
    return true;
  }
  /** Select row `row`; false when it cannot be selected. */
  select(c: Context, row: number): boolean {
    const rows = this.lines(c);
    if (row >= rows.length) return false;
    const k = keyOf(c, rows[row]);
    if (k === null) return false;
    this.selected = k;
    this.focused = true;
    return true;
  }
  home(): void {
    this.selected = null;
    this.scroll = 0;
  }
  expand(): void {
    this.expanded = true;
    this.focused = true;
    this.home();
  }
  collapse(): void {
    this.expanded = false;
    this.stopSearch();
    this.scope = "workspace";
  }
  startSearch(): void {
    this.expand();
    this.searching = true;
  }
  stopSearch(): void {
    this.searching = false;
    this.query.clear();
    this.home();
  }
  nextScope(forward: boolean): void {
    const n = scopes.length;
    this.scope = scopes[(scopes.indexOf(this.scope) + (forward ? 1 : n - 1)) % n];
    this.home();
  }
  /** The first row shown in `height` rows: `scroll`, moved just enough
   * to show the selected row and the heading above it. */
  firstRow(rows: Line[], at: number | null, height: number): number {
    let first = Math.min(this.scroll, sat(rows.length, height));
    if (at === null) return first;
    const top = at > 0 && "day" in rows[at - 1] ? at - 1 : at;
    if (top < first) first = top;
    if (at >= first + height) first = at + 1 - height;
    return first;
  }
  /** Keep the selection in view after it moves. */
  reveal(c: Context, area: Area): void {
    const rows = this.lines(c);
    this.scroll = this.firstRow(rows, this.index(c, rows), area.listHeight());
  }
  /** Title, folder and last-message widths for an inner width; the last
   * message goes first when space runs out. */
  columns(inner: number): Columns {
    // Marker, provider and their gaps, the gap after the title, and the age.
    const room = sat(inner, 16);
    const folder = this.expanded && this.scope !== "folder" && room >= 60 ? 15 : 0;
    const title =
      sat(room, folder) >= 70
        ? Math.max(30, Math.floor(((room - folder) * 2) / 5))
        : Math.min(sat(room, folder), Math.max(24, Math.floor((sat(room, folder) * 3) / 5)));
    return { title, folder, last: sat(sat(sat(room, folder), title), 2) };
  }
  /** Rows the collapsed list takes, its heading and the gap above the
   * "more" row included. */
  collapsedHeight(c: Context): number {
    return 2 + this.lines(c).length;
  }
  /** The collapsed list from terminal row `y`, inside a border at column
   * `x` that is `width` wide. */
  drawCollapsed(w: Writer, c: Context, x: number, y: number, width: number): void {
    const rows = this.lines(c);
    const cols = this.columns(sat(width, 4));
    let total = 0;
    for (const e of c.history.entries) total += c.listed(e, "folder") ? 1 : 0;
    w.write(`\x1b[${y};${x + 3}H${panel}\x1b[1m` + palette.fg("strong") + `Resume${panel}`);
    // The launcher's title names the folder.
    writeEllipsis(w, total > 0 ? ` · ${total} here` : " · none here", cols.title + 3);
    if (cols.last > 12) {
      w.write(`\x1b[${y};${x + 3 + 9 + cols.title + 2}H`);
      writeEllipsis(w, "You last said", cols.last);
    }
    w.write(`\x1b[${y};${x + width - 3 - 6}HActive`);
    const at = this.index(c, rows);
    rows.forEach((line, k) => {
      const row = y + 1 + k + ("more" in line ? 1 : 0);
      this.drawLine(w, c, line, rows, this.focused && at === k, startsRun(c, rows, k, 0), x, row, width, cols);
    });
  }
  /** The expanded list in `area`, terminal coordinates inside the border. */
  draw(w: Writer, c: Context, area: Area): void {
    const rows = this.lines(c);
    const at = this.index(c, rows);
    const x = area.x;
    const y = area.y;
    const width = area.width;
    const list_top = area.listTop();
    const list_height = area.listHeight();
    const first = this.firstRow(rows, at, list_height);
    const cols = this.columns(sat(width, 4));
    // Search line and scope.
    w.write(`\x1b[${y};${x + 3}H${panel}`);
    writeKey(w, "/", panel);
    w.write(" ");
    const scope = scopeLabel(this.scope);
    const field = sat(width, scope.length + 19);
    if (this.searching) {
      w.write(palette.fg("strong"));
      writeEllipsis(w, this.query.name(), sat(field, 1));
      w.write("\x1b[7m \x1b[27m");
    } else {
      w.write(dim);
      writeEllipsis(w, "search titles and what was said", field);
    }
    w.write(`\x1b[${y};${x + width - 2 - (scope.length + 2 + 6)}H`);
    writeKey(w, "tab", panel);
    w.write(" ");
    writeKey(w, scope, panel);
    // Column headings.
    w.write(`\x1b[${y + 1};${x + 3 + 9}H${panel}`);
    writeEllipsis(w, "Title", cols.title);
    if (cols.folder > 0) {
      w.write(`\x1b[${y + 1};${x + 3 + 9 + cols.title + 2}H`);
      w.write("Folder");
    }
    if (cols.last > 12) {
      w.write(`\x1b[${y + 1};${x + 3 + 9 + cols.title + 2 + cols.folder}H`);
      writeEllipsis(w, "You last said", cols.last);
    }
    w.write(`\x1b[${y + 1};${x + width - 3 - 6}HActive`);
    if (rows.length === 0 || (rows.length === 1 && "heading" in rows[0])) {
      w.write(`\x1b[${list_top + (rows.length === 1 ? 1 : 0)};${x + 3 + 9}H${panel}`);
      w.write(this.search().length > 0 ? "No matches." : "Nothing closed here. Tab widens the scope.");
    }
    rows.slice(first, Math.min(rows.length, first + list_height)).forEach((line, k) => {
      const row = list_top + k;
      this.drawLine(
        w,
        c,
        line,
        rows,
        this.focused && at === first + k,
        startsRun(c, rows, first + k, first),
        x,
        row,
        width,
        cols,
      );
    });
    const bar = scrollThumb.thumb(list_height, rows.length, first);
    if (bar)
      for (let k = 0; k < list_height; k++)
        w.write(
          `\x1b[${list_top + k};${x + width - 2}H${k >= bar.start && k < bar.start + bar.len ? panel + "┃" : rule + "│"}`,
        );
  }
  /** `named` rows show their agent's name; the rows below continue its run as a rail. */
  private drawLine(
    w: Writer,
    c: Context,
    line: Line,
    rows: Line[],
    selected: boolean,
    named: boolean,
    x: number,
    row: number,
    width: number,
    cols: Columns,
  ): void {
    const style = selected ? selected_style : row_style;
    if ("day" in line) {
      w.write(`\x1b[${row};${x + 3}H${panel}`);
      const text = dayLabel(line.day, c.now);
      w.write(text);
      w.write(" " + palette.fg("line"));
      w.write("─".repeat(sat(width, 6 + Buffer.byteLength(text))));
      return;
    }
    if ("heading" in line) {
      const text =
        line.heading === "open" ? "Open · jumps to its tab" : `${View.count(rows)} in ${scopeLabel(this.scope)}`;
      w.write(`\x1b[${row};${x + 3}H${panel}\x1b[1m${text}\x1b[22m`);
      return;
    }
    if ("elsewhere" in line) {
      w.write(`\x1b[${row};${x + 3 + 9}H${panel}`);
      w.write(`${line.elsewhere} more outside ${scopeLabel(this.scope)} · tab widens`);
      return;
    }
    if ("more" in line) {
      const n = line.more;
      w.write(`\x1b[${row};${x + 1}H${style}`);
      w.splat(" ", sat(width, 3));
      w.write(`\x1b[${row};${x + 1}H${selected ? "›" : " "}`);
      // The rail above runs on, dashed, into the conversations left out.
      if (n > View.count(rows)) w.write(`\x1b[${row - 1};${x + 3}H${panel}┊${style}`);
      // In the agents' keycap column.
      w.write(`\x1b[${row};${x + 3}H`);
      writeKey(w, "/", style);
      w.write(selected ? palette.fg("muted") : dim);
      if (n > 0) w.write(` Search ${n} agent${n === 1 ? "" : "s"}`);
      else w.write(" Search every folder");
      return;
    }
    const e = c.history.entries["entry" in line ? line.entry : line.open];
    w.write(`\x1b[${row};${x + 1}H${style}`);
    w.splat(" ", sat(width, 3));
    w.write(`\x1b[${row};${x + 1}H${selected ? "›" : " "}`);
    if (named) w.write(`\x1b[${row};${x + 3}H${providerLabel(e.provider)}`);
    else w.write(`\x1b[${row};${x + 3}H${rail(selected)}│${style}`);
    let col = x + 3 + 9;
    w.write(`\x1b[${row};${col}H`);
    const branch = "entry" in line ? otherBranch(c, e) : "";
    const title = e.title.length > 0 ? e.title : e.first;
    if (branch.length > 0 && cols.title > 16) {
      const room = sat(cols.title, Math.min(Buffer.byteLength(branch), Math.floor(cols.title / 2)) + 1);
      writeEllipsis(w, title, room);
      w.write(`\x1b[${row};${col + room + 1}H` + palette.fg("muted"));
      writeEllipsis(w, branch, cols.title - room - 1);
      w.write(style);
    } else writeEllipsis(w, title, cols.title);
    col += cols.title + 2;
    if (cols.folder > 0) {
      w.write(`\x1b[${row};${col}H` + palette.fg("muted"));
      writeEllipsis(w, basename(e.cwd), cols.folder - 1);
      w.write(style);
      col += cols.folder;
    }
    if ("open" in line) {
      w.write(`\x1b[${row};${col}H` + palette.fg("muted"));
      writeEllipsis(w, "↗ open in a tab", cols.last);
    } else if (cols.last > 12) {
      w.write(`\x1b[${row};${col}H`);
      let room = cols.last;
      if (e.interrupted) {
        w.write(palette.fg("hot") + "✕ ");
        room = sat(room, 2);
      }
      w.write(selected ? palette.fg("text") : dim);
      writeEllipsis(w, e.last, room);
    }
    const text = ageLabel(c.now - e.updated_at);
    w.write(`\x1b[${row};${x + width - 3 - text.length}H${selected ? "" : dim}${text}`);
  }
  /** What terminal cell `x`, `y` holds in the expanded list drawn in `area`. */
  hit(c: Context, area: Area, x: number, y: number): Hit | null {
    if (x <= area.x || x >= area.x + area.width - 1) return null;
    if (y === area.y && x >= area.x + area.width - 2 - (scopeLabel(this.scope).length + 8)) return "scope";
    const top = area.listTop();
    if (y < top || y >= top + area.listHeight()) return null;
    const rows = this.lines(c);
    const row = this.firstRow(rows, this.index(c, rows), area.listHeight()) + (y - top);
    return row < rows.length && keyOf(c, rows[row]) !== null ? { row } : null;
  }
  /** The collapsed list's row at `line`, counted from its first row. */
  collapsedHit(c: Context, line: number): number | null {
    const rows = this.lines(c);
    // The "more" row, last, sits below a gap.
    if (line + 1 === rows.length) return null;
    const i = line === rows.length ? line - 1 : line;
    return i < rows.length && keyOf(c, rows[i]) !== null ? i : null;
  }
}

/** The branch `e` ran on when the folder's newest conversation used another. */
function otherBranch(c: Context, e: Entry): string {
  if (e.branch.length === 0) return "";
  for (const newest of c.history.entries)
    if (newest.cwd === e.cwd && newest.branch.length > 0) return newest.branch === e.branch ? "" : e.branch;
  return "";
}
/** The agent of a conversation row; null for any other row. */
function agentOf(c: Context, line: Line): Provider | null {
  if ("entry" in line) return c.history.entries[line.entry].provider;
  if ("open" in line) return c.history.entries[line.open].provider;
  return null;
}
/** Whether conversation row `i` names its agent: the first row shown from
 * `first`, and wherever the agent differs from the row above. */
export function startsRun(c: Context, rows: Line[], i: number, first: number): boolean {
  const agent = agentOf(c, rows[i]);
  if (agent === null) return false;
  if (i === first) return true;
  const above = agentOf(c, rows[i - 1]);
  if (above === null) return true;
  return above !== agent;
}
function providerLabel(p: Provider): string {
  return p === "claude" ? "Claude" : "Codex";
}
/** Draw a keycap, then restore the surrounding style. */
export function writeKey(w: Writer, key: string, after: string): void {
  w.write(keycap + ` ${key} ${after}`);
}
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
}
function contains(text: string, query: string): boolean {
  return lowerAscii(text).includes(lowerAscii(query));
}
/** Seconds at local midnight starting the day of `seconds`. */
export function dayStart(seconds: number): number {
  const date = new Date(seconds * 1000);
  return seconds - date.getHours() * 3600 - date.getMinutes() * 60 - date.getSeconds();
}
export function dayLabel(seconds: number, now: number): string {
  const days = Math.floor((dayStart(now) - dayStart(seconds) + 43200) / 86400);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  const date = new Date(seconds * 1000);
  const weekdays = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  const months = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
  ];
  if (days < 7) return weekdays[date.getDay()];
  const month = months[date.getMonth()];
  const this_year = new Date(now * 1000).getFullYear() === date.getFullYear();
  if (this_year) return `${month} ${date.getDate()}`;
  return `${month} ${date.getDate()}, ${date.getFullYear()}`;
}
export function ageLabel(seconds: number): string {
  const s = Math.max(0, seconds);
  const units = [
    { below: 3600, size: 60, name: "m" },
    { below: 86400, size: 3600, name: "h" },
    { below: 14 * 86400, size: 86400, name: "d" },
    { below: 60 * 86400, size: 7 * 86400, name: "w" },
    { below: Infinity, size: 30 * 86400, name: "mo" },
  ];
  for (const unit of units) if (s < unit.below) return `${Math.max(1, Math.trunc(s / unit.size))}${unit.name}`;
  return "";
}
