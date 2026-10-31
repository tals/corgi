import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname } from "node:path";
import { Rect } from "./layout";
import * as palette from "./palette";
import { Writer, ellipsis, directoryLabel, displayWidth, shortPath, compactCount } from "./text";
import { Grid } from "./cell_grid";
import * as worktrees from "./worktrees";
import * as worktreeRemoval from "./worktree_removal";
import { clean } from "./trackers/git_status";
import { milliTimestamp } from "./clock";
import { ageLabel } from "./launcher_resume";
import { pulse, histogram, type Tally } from "./sidebar";

/** The card for `count` worktrees of `lines` each, `closed` lines shorter
 * while a removed row closes. */
export function geometry(
  cols: number,
  rows: number,
  side: number,
  anchor: number,
  count: number,
  closed = 0,
  lines = 1,
): Rect | null {
  const w = Math.min(100, cols - side - 3);
  if (w < 52 || rows < 12) return null;
  const h = Math.min(rows - 2, 8 + Math.max(1, count) * lines - closed);
  return new Rect(side + 2, Math.max(1, Math.min(anchor - 1, rows - h - 1)), w, h);
}
/** The triangle from the badge to the card's left edge, which the pointer
 * crosses between them; it includes the badge's own cells. */
export function between(rect: Rect, badge: Rect, x: number, y: number): boolean {
  const ax = badge.x,
    ay = badge.y,
    edge = rect.x;
  if (x < ax || x >= edge) return false;
  const top = (rect.y - ay) * (x - ax),
    bottom = (rect.y + rect.h - 1 - ay) * (x - ax),
    slope = (y - ay) * (edge - ax);
  return slope >= top && slope <= bottom;
}
export class State {
  workspace: number | null = null;
  pinned = false;
  anchor = 2;
  selected: string | null = null;
  /** How many conversations Enter would bring back for the browsed worktree. */
  asleep: { path: string; count: number } | null = null;
  /** Each worktree's live agents by state, counted as the sidebar's
   * worktree groups count them. */
  agents: Map<string, Tally> | null = null;
  /** The worktrees' briefs by path, or null while worktree briefs are off. */
  briefs: Map<string, worktrees.Brief> | null = null;
  /** When this viewer first saw each brief being written, for its glimmer. */
  private writing = new Map<string, number>();
  /** The overview's order, kept from one opening to the next: the latest edit first. */
  sort: Sort = "edited";
  ascending = false;
  removal = new worktreeRemoval.Hold();
  /** The removal effect for this opening of the overview, drawn when first needed. */
  private effect: worktreeRemoval.Effect | null = null;
  private last_effect: worktreeRemoval.Effect | null = null;
  clear() {
    this.workspace = null;
    this.pinned = false;
    this.selected = null;
    this.agents = null;
    this.briefs = null;
    this.writing.clear();
    this.effect = null;
    // A removal under way finishes, and says so, even with the overview closed.
    if (!this.removal.committed()) this.removal.reset();
  }
  /** Lines per worktree: a second for its brief while briefs are on. */
  lines() {
    return this.briefs ? 2 : 1;
  }
  /** How long `path`'s brief has been written, as far as this viewer knows. */
  writingFor(path: string, now: number): number {
    if (this.briefs?.get(path)?.phase !== "writing") {
      this.writing.delete(path);
      return 0;
    }
    if (!this.writing.has(path)) this.writing.set(path, now);
    return now - this.writing.get(path)!;
  }
  removalEffect(): worktreeRemoval.Effect {
    if (this.effect === null) this.effect = this.last_effect = worktreeRemoval.pick(this.last_effect);
    return this.effect;
  }
  /** The linked worktrees in the overview's order. */
  entries(snapshot: worktrees.Snapshot | null): worktrees.Checkout[] {
    const sort = this.sort,
      ascending = this.ascending;
    return worktrees.linked(snapshot).sort((a, b) => {
      if (sort !== "worktree") {
        const left = figures(sort, a, snapshot, this),
          right = figures(sort, b, snapshot, this);
        // Worktrees without the figure go last either way.
        if (left === null || right === null) {
          if (left !== right) return left === null ? 1 : -1;
        } else
          for (let i = 0; i < left.length; i++)
            if (left[i] !== right[i]) return left[i] < right[i] === ascending ? -1 : 1;
      }
      const names = collator.compare(worktrees.label(a), worktrees.label(b)) || collator.compare(a.path, b.path);
      return sort === "worktree" && !ascending ? -names : names;
    });
  }
  /** Sorts by the heading under a cell, the way its column runs first; the
   * sorted heading turns it around. */
  click(rect: Rect, x: number, y: number): boolean {
    const sort = sortAt(rect, x, y);
    if (sort === null) return false;
    this.ascending = sort === this.sort ? !this.ascending : ascends[sort];
    this.sort = sort;
    return true;
  }
  index(entries: worktrees.Checkout[]) {
    const index = entries.findIndex(e => e.path === this.selected);
    return Math.max(0, index);
  }
  capacity(rect: Rect, closed = 0) {
    return Math.max(1, Math.floor((rect.h - 8 + closed) / this.lines()));
  }
  offset(entries: worktrees.Checkout[], rect: Rect, closed = 0) {
    const capacity = this.capacity(rect, closed);
    return Math.floor(this.index(entries) / capacity) * capacity;
  }
  move(snapshot: worktrees.Snapshot | null, delta: number) {
    const entries = this.entries(snapshot);
    this.select(entries[Math.max(0, Math.min(entries.length - 1, this.index(entries) + delta))]?.path ?? null);
  }
  select(path: string | null) {
    if (this.selected === path) return;
    this.selected = path;
    // Moving off a locked worktree's note keeps it.
    this.removal.cancel(milliTimestamp());
  }
  hit(snapshot: worktrees.Snapshot | null, rect: Rect, x: number, y: number) {
    const { entries, closed } = listing(snapshot, this),
      row = Math.floor((y - rect.y - 5) / this.lines());
    if (x <= rect.x || x >= rect.x + rect.w - 1 || row < 0 || row >= this.capacity(rect, closed)) return null;
    return entries[this.offset(entries, rect, closed) + row]?.path ?? null;
  }
}
/** The worktrees the overview lists: the linked ones, and one just removed
 * until its row has closed. */
export function listing(snapshot: worktrees.Snapshot | null, state: State, now = milliTimestamp()) {
  return state.removal.shown(state.entries(snapshot), now, state.lines());
}
/** A worktree's agents as the sidebar counts them, else those associated with it. */
function agentsAt(snapshot: worktrees.Snapshot | null, state: State, path: string): Tally {
  return (
    state.agents?.get(path) ?? {
      agents: snapshot?.agents.filter(a => a.path === path).length ?? 0,
      working: 0,
      attention: 0,
    }
  );
}
/** Temporary directories by how they read, real paths included since Git
 * lists worktrees by theirs: on macOS `/tmp` is `/private/tmp`. */
const temporary: [string, string][] = (() => {
  const real = (path: string) => {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  };
  const tmp = tmpdir().replace(/\/+$/, "");
  const named = tmp === "/tmp" ? "/tmp" : "$TMPDIR";
  return [
    [tmp, named],
    [real(tmp), named],
    ["/tmp", "/tmp"],
    [real("/tmp"), "/tmp"],
  ];
})();
/** A checkout's path the short way: from the main checkout (`./`) or beside
 * it (`../`), then a temporary directory, then home. */
export function displayPath(path: string, main: string): string {
  const under = (dir: string) => dir.length > 1 && (path === dir || path.startsWith(dir + "/"));
  const root = main.replace(/\/+$/, ""),
    parent = dirname(root);
  if (root && under(root)) return "." + path.slice(root.length);
  if (root && under(parent)) return ".." + path.slice(parent.length);
  for (const [dir, name] of temporary) if (under(dir)) return name + path.slice(dir.length);
  return directoryLabel(path, homedir());
}
type Column = "agents" | "main" | "age" | "edited" | "changes";
/** What the overview orders worktrees by: their names, or a column. */
export type Sort = "worktree" | Column;
/** Whether each sort first runs up: names from A; figures run down, the
 * most or the newest first. */
const ascends: Record<Sort, boolean> = {
  worktree: true,
  agents: false,
  main: false,
  age: false,
  edited: false,
  changes: false,
};
const collator = new Intl.Collator(undefined, { numeric: true });
/** A worktree's figures in a column, the least or oldest first, or null
 * where it shows none. */
function figures(
  sort: Column,
  entry: worktrees.Checkout,
  snapshot: worktrees.Snapshot | null,
  state: State,
): (number | bigint)[] | null {
  switch (sort) {
    case "agents":
      return [agentsAt(snapshot, state, entry.path).agents];
    case "main":
      return entry.comparison && [entry.comparison.ahead, entry.comparison.behind];
    case "age":
      return entry.created === null ? null : [entry.created];
    case "edited":
      return entry.edited === null ? null : [entry.edited];
    case "changes":
      return entry.available && entry.changes
        ? [entry.changes.total, entry.changes.added + entry.changes.removed]
        : null;
  }
}
/** The columns right of the worktree, each with the gap after it; the last
 * ends two cells from the card's edge. */
const columns: { name: Column; header: string; width: number }[] = [
  { name: "agents", header: "AGENTS", width: 9 },
  { name: "main", header: "VS MAIN", width: 10 },
  { name: "age", header: "AGE", width: 6 },
  { name: "edited", header: "EDITED", width: 11 },
  { name: "changes", header: "UNCOMMITTED CHANGES", width: 19 },
];
/** On a narrow card, these go first, until the worktree has room. */
const dropped: Column[] = ["age", "main", "edited"];
const name_room = 24;
/** Where a brief starts: two cells in from its worktree's name, under a hook. */
const brief_x = 5;
/** Where each shown column starts, and the room left for the worktree. */
export function columnsFor(width: number): { x: Partial<Record<Column, number>>; room: number } {
  let shown = columns;
  for (const name of [null, ...dropped]) {
    if (name) shown = shown.filter(c => c.name !== name);
    if (width - 6 - shown.reduce((n, c) => n + c.width, 0) >= name_room) break;
  }
  const x: Partial<Record<Column, number>> = {};
  let at = width - 2;
  for (const c of [...shown].reverse()) {
    at -= c.width;
    x[c.name] = at;
  }
  return { x, room: at - 4 };
}
/** The heading under a cell: WORKTREE up to the first column, then each
 * column from its mark, just left of its heading. */
export function sortAt(rect: Rect, x: number, y: number): Sort | null {
  const col = x - rect.x,
    at = columnsFor(rect.w).x;
  if (y !== rect.y + 4 || col < 1 || col >= rect.w - 2) return null;
  let sort: Sort = "worktree";
  for (const c of columns) if (at[c.name] !== undefined && col >= at[c.name]! - 1) sort = c.name;
  return sort;
}
export function draw(
  w: Writer,
  rect: Rect,
  name: string,
  cwd: string,
  snapshot: worktrees.Snapshot | null,
  state: State,
  badge: Rect | null = null,
  now = milliTimestamp(),
) {
  const c = palette.colors,
    grid = new Grid(rect.w, rect.h, c.text);
  const line = (
    row: number,
    col: number,
    value: string,
    width = rect.w - col - 2,
    color: palette.Token = "text",
    bold = false,
  ) => grid.text(col, row, ellipsis(clean(value), Math.max(0, width)), c[color], bold);
  for (let row = 0; row < rect.h; row++) {
    grid.put(0, row, "│", c.line);
    grid.put(rect.w - 1, row, "│", c.line);
  }
  const hold = state.removal,
    shown = listing(snapshot, state, now),
    entries = shown.entries,
    selected = entries[state.index(entries)],
    offset = state.offset(entries, rect, shown.closed),
    count = worktrees.linked(snapshot).length;
  line(0, 0, "╭" + "─".repeat(rect.w - 2) + "╮", rect.w, "line");
  line(1, 2, `${name} · ${count} worktree${count === 1 ? "" : "s"}`, rect.w - 4, "strong", true);
  line(
    2,
    2,
    snapshot?.base
      ? `Compared with local ${snapshot.base.name}${snapshot.stale ? " · last known data" : ""}`
      : "Comparison branch unavailable",
    undefined,
    "muted",
  );
  /** Segments side by side from `col`, cut to `width` together. */
  const runs = (row: number, col: number, width: number, segments: [string, palette.Token, boolean?][]) => {
    for (const [value, color, bold] of segments) {
      const text = ellipsis(clean(value), Math.max(0, width));
      if (!text) return;
      grid.text(col, row, text, c[color], bold ?? false);
      col += displayWidth(text);
      width -= displayWidth(text);
    }
  };
  /** A worktree's brief, hung under its name: a few words, a glimmer while
   * written, faded when the last try failed. */
  const brief = (
    row: number,
    entry: worktrees.Checkout,
    tone: (token: palette.Token) => palette.Token,
    width = rect.w - brief_x - 3,
  ) => {
    const b = state.briefs?.get(entry.path),
      hook = () => grid.put(3, row, "╰", c.line);
    if (entry.comparison?.ahead === 0n && entry.changes?.total === 0) {
      hook();
      return line(row, brief_x, "Nothing beyond main", width, tone("faint"));
    }
    if (!b) return;
    if (b.phase === "writing") {
      const since = state.writingFor(entry.path, now),
        text = b.label ?? "...";
      hook();
      // Over the old words while amended; dots while the first is written.
      [...ellipsis(clean(text), width)].forEach((ch, i) =>
        grid.put(brief_x + i, row, ch, pulse(b.label ? i / 4 : i, since)),
      );
      return;
    }
    state.writingFor(entry.path, now);
    if (b.label === null && b.phase !== "failed") return;
    hook();
    line(row, brief_x, b.label ?? "Brief failed", width, tone("faint"));
  };
  const layout = columnsFor(rect.w),
    x = layout.x,
    main = snapshot?.entries.find(e => e.primary)?.path ?? cwd;
  // The sorted heading is bright, marked with the way its column runs.
  const heading = (col: number, sort: Sort, label: string, width: number) => {
    const sorted = state.sort === sort;
    if (sorted) grid.text(col - 1, 4, state.ascending ? "↑" : "↓", c.strong, true);
    line(4, col, label, width, sorted ? "strong" : "faint", sorted);
  };
  heading(2, "worktree", "WORKTREE", layout.room);
  for (const column of columns)
    if (x[column.name] !== undefined) heading(x[column.name]!, column.name, column.header, column.width);
  // Until a removed row has closed, the cursor is its own: it goes with the
  // row, then waits on that line while the rows below move up to it, or
  // climbs to the row above when that is next.
  const removed = entries.findIndex(e => e.path === shown.removing),
    next = entries.findIndex(e => e.path === selected?.path);
  let removing: number | null = null,
    cursor: number | null = null,
    y = 5;
  const others: number[] = [];
  for (const entry of entries.slice(offset, offset + state.capacity(rect, shown.closed))) {
    const ending = entry.path === shown.removing;
    if (ending && hold.finale(now) >= 1) {
      if (next !== removed) cursor = next > removed ? y : y - shown.closed;
      else if (hold.phase === "removing") cursor = y;
    }
    if (ending && shown.closed > 0) {
      y += state.lines() - shown.closed;
      continue;
    }
    if (hold.covers(entry.path)) removing = y;
    else others.push(y);
    const chosen = entry.path === selected?.path && (shown.removing === null || ending);
    // The chosen worktree's lines are filled, and faint text on the fill steps up to muted.
    const tone = (token: palette.Token): palette.Token => (chosen && token === "faint" ? "muted" : token);
    if (chosen) for (let row = y; row < y + state.lines(); row++) grid.fill(1, row, rect.w - 2, c.selected);
    // A locked worktree's name gives up room for "locked".
    const label = ellipsis(
      clean((chosen ? "› " : "  ") + worktrees.label(entry)),
      layout.room + 1 - (entry.locked !== null ? 8 : 0),
    );
    line(y, 1, label, layout.room + 1, chosen ? "strong" : "text", true);
    // A lock, then the path, if it fits with its last directory whole; the name says the rest.
    const end = layout.room + 2;
    let after = displayWidth(label) + 3;
    if (entry.locked !== null && after + 6 <= end) {
      line(y, after, "locked", 6, tone("muted"));
      after += 8;
    }
    const path = displayPath(entry.path, main),
      short = shortPath(path, end - after);
    if (short && short.endsWith(path.slice(path.lastIndexOf("/") + 1)))
      line(y, after, short, displayWidth(short), tone("faint"));
    if (x.agents !== undefined) {
      const associations = snapshot?.agents.filter(a => a.path === entry.path) ?? [],
        counted = agentsAt(snapshot, state, entry.path),
        segments: [string, palette.Token, boolean?][] = histogram(counted);
      if (!counted.agents) segments.push(["0", tone("faint")]);
      if (associations.some(a => a.stale)) segments.push(["*", "text"]);
      runs(y, x.agents, 8, segments);
    }
    if (x.main !== undefined) {
      const vs = entry.comparison;
      // Commits main doesn't have yet want attention.
      if (vs)
        runs(y, x.main, 8, [
          [`↑${compactCount(vs.ahead)}`, vs.ahead > 0n ? "warm" : "text"],
          [` ↓${compactCount(vs.behind)}`, "text"],
        ]);
      else line(y, x.main, "—", 8, tone("faint"));
    }
    if (x.age !== undefined)
      line(
        y,
        x.age,
        entry.created === null ? "—" : ageLabel((now - entry.created) / 1000),
        4,
        entry.created === null ? tone("faint") : "muted",
      );
    if (x.edited !== undefined) {
      const since = entry.edited === null ? null : now - entry.edited;
      // Edits in the last hour are brighter.
      line(
        y,
        x.edited,
        since === null ? "—" : `${ageLabel(since / 1000)} ago`,
        8,
        since === null ? tone("faint") : since < 3600000 ? "text" : "muted",
      );
    }
    if (x.changes !== undefined) {
      const changes = entry.changes,
        star = entry.stale ? "*" : "";
      if (!entry.available) line(y, x.changes, "Missing", 19, "muted");
      else if (!changes) line(y, x.changes, "…", 19, tone("faint"));
      else if (!changes.total) line(y, x.changes, `Clean${star}`, 19, tone("faint"));
      else
        runs(y, x.changes, 19, [
          [`${changes.total} file${changes.total === 1 ? "" : "s"}${star}`, "text"],
          ...(changes.added || changes.removed
            ? ([
                ["  ", "text"],
                [`+${compactCount(changes.added)}`, "accent"],
                [" ", "text"],
                [`−${compactCount(changes.removed)}`, "hot"],
              ] as [string, palette.Token][])
            : []),
        ]);
    }
    // A locked worktree's brief ends before its band.
    const banded = hold.covers(entry.path) && hold.target?.locked != null;
    if (state.briefs) brief(y + 1, entry, tone, banded ? layout.room + 2 - brief_x : undefined);
    y += state.lines();
  }
  if (!selected) line(5, 2, snapshot ? "No linked worktrees" : "Discovering worktrees…", undefined, "muted");
  const status = worktreeRemoval.footer(state.removal),
    failed = [...(state.briefs?.values() ?? [])].some(b => b.phase === "failed");
  if (status) {
    let x = 2;
    for (const segment of status) {
      const room = rect.w - 2 - x,
        text = ellipsis(clean(segment.text), room);
      grid.text(x, rect.h - 2, text, c[segment.color], segment.bold);
      x += displayWidth(text);
      if (x >= rect.w - 2) break;
    }
  } else {
    const enter = snapshot?.agents.some(a => a.path === selected?.path)
      ? "focus agents"
      : state.asleep?.path === selected?.path && state.asleep?.count
        ? "resume agents"
        : "new agent";
    line(
      rect.h - 2,
      2,
      selected
        ? `↑↓ browse · Enter ${enter} · e review · hold ⌫ remove${failed ? " · r refresh" : ""} · Esc close`
        : "↑↓ browse · Esc close",
      undefined,
      "faint",
    );
  }
  if (removing !== null) {
    const t = hold.target,
      locked = t !== null && t.locked !== null,
      // A locked worktree keeps its name while its columns come apart onto its band.
      band = { y: removing, lines: state.lines(), left: layout.room + 3, right: rect.w - 3 },
      area = {
        y: removing,
        lines: state.lines(),
        left: locked && !hold.committed() ? band.left : 1,
        right: rect.w - 2,
        top: 1,
        bottom: rect.h - 3,
      },
      report = hold.report,
      under = locked ? worktreeRemoval.underlay(rect.w, rect.h, band, t) : null;
    worktreeRemoval.paint(grid, area, hold.effect, hold.progress, hold.finale(now), now, under, hold.settling(now));
    // A big worktree is still being deleted once the ending has played.
    if (hold.phase === "removing" && hold.finale(now) >= 1 && report?.phase === "deleting")
      worktreeRemoval.progress(grid, area, now);
  }
  // The other worktrees fade while a locked one's band is up.
  const dim = Math.round(hold.dimming(now) * 58);
  if (dim > 0)
    for (const top of others)
      for (let row = top; row < top + state.lines(); row++)
        for (let x = 1; x < rect.w - 1; x++) {
          const cell = grid.at(x, row);
          if (cell) cell.fg = palette.mix(cell.fg, c.surface, dim);
        }
  if (cursor !== null) grid.put(1, cursor, "›", c.strong, true);
  line(rect.h - 1, 0, "╰" + "─".repeat(rect.w - 2) + "╯", rect.w, "line");
  const port = badge ? Math.max(rect.y + 1, Math.min(badge.y, rect.y + rect.h - 2)) : 0;
  if (badge) grid.put(0, port - rect.y, "├", c.muted);
  w.write("\x1b7\x1b[?25l");
  grid.write(w, rect.x, rect.y, new palette.Style({ fg: "text", bg: "surface" }).sgr());
  if (badge) {
    const bend = rect.x - 2;
    const cell = (x: number, y: number, text: string) =>
      w.write(`\x1b[${y + 1};${x + 1}H${new palette.Style({ fg: "muted", bg: "bg" }).sgr()}${text}`);
    cell(badge.x + badge.w, badge.y, "╶" + "─".repeat(Math.max(0, bend - badge.x - badge.w - 1)));
    if (port !== badge.y) {
      cell(bend, badge.y, port > badge.y ? "╮" : "╯");
      for (let y = Math.min(port, badge.y) + 1; y < Math.max(port, badge.y); y++) cell(bend, y, "│");
    }
    cell(bend, port, (port === badge.y ? "─" : port > badge.y ? "╰" : "╭") + "─");
  }
  w.write("\x1b[0m\x1b8");
}
