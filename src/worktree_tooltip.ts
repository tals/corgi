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

/** Lines per worktree in the table. */
const row_lines = 1;

/** The card for `count` worktrees, `closed` lines shorter while a removed row closes. */
export function geometry(
  cols: number,
  rows: number,
  side: number,
  anchor: number,
  count: number,
  closed = 0,
): Rect | null {
  const w = Math.min(100, cols - side - 3);
  if (w < 52 || rows < 12) return null;
  const h = Math.min(rows - 2, 8 + Math.max(1, count) * row_lines - closed);
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
  /** Each worktree's live agents and how many are working, counted as the
   * sidebar's worktree groups count them. */
  agents: Map<string, { agents: number; working: number }> | null = null;
  removal = new worktreeRemoval.Hold();
  /** The removal effect for this opening of the overview, drawn when first needed. */
  private effect: worktreeRemoval.Effect | null = null;
  private last_effect: worktreeRemoval.Effect | null = null;
  clear() {
    this.workspace = null;
    this.pinned = false;
    this.selected = null;
    this.agents = null;
    this.effect = null;
    // A removal under way finishes, and says so, even with the overview closed.
    if (!this.removal.committed()) this.removal.reset();
  }
  removalEffect(): worktreeRemoval.Effect {
    if (this.effect === null) this.effect = this.last_effect = worktreeRemoval.pick(this.last_effect);
    return this.effect;
  }
  index(entries: worktrees.Checkout[]) {
    const index = entries.findIndex(e => e.path === this.selected);
    return Math.max(0, index);
  }
  capacity(rect: Rect, closed = 0) {
    return Math.max(1, Math.floor((rect.h - 8 + closed) / row_lines));
  }
  offset(entries: worktrees.Checkout[], rect: Rect, closed = 0) {
    const capacity = this.capacity(rect, closed);
    return Math.floor(this.index(entries) / capacity) * capacity;
  }
  move(snapshot: worktrees.Snapshot | null, delta: number) {
    const entries = worktrees.linked(snapshot);
    this.select(entries[Math.max(0, Math.min(entries.length - 1, this.index(entries) + delta))]?.path ?? null);
  }
  select(path: string | null) {
    if (this.selected === path) return;
    this.selected = path;
  }
  hit(snapshot: worktrees.Snapshot | null, rect: Rect, x: number, y: number) {
    const { entries, closed } = listing(snapshot, this),
      row = Math.floor((y - rect.y - 5) / row_lines);
    if (x <= rect.x || x >= rect.x + rect.w - 1 || row < 0 || row >= this.capacity(rect, closed)) return null;
    return entries[this.offset(entries, rect, closed) + row]?.path ?? null;
  }
}
/** The worktrees the overview lists: the linked ones, and one just removed
 * until its row has closed. */
export function listing(snapshot: worktrees.Snapshot | null, state: State, now = milliTimestamp()) {
  return state.removal.shown(worktrees.linked(snapshot), now, row_lines);
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
/** The columns right of the worktree, each with the gap after it; the last
 * ends two cells from the card's edge. */
const columns: { name: Column; header: string; width: number }[] = [
  { name: "agents", header: "AGENTS", width: 8 },
  { name: "main", header: "VS MAIN", width: 10 },
  { name: "age", header: "AGE", width: 6 },
  { name: "edited", header: "EDITED", width: 11 },
  { name: "changes", header: "UNCOMMITTED CHANGES", width: 19 },
];
/** On a narrow card, these go first, until the worktree has room. */
const dropped: Column[] = ["age", "main", "edited"];
const name_room = 24;
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
  const layout = columnsFor(rect.w),
    x = layout.x,
    main = snapshot?.entries.find(e => e.primary)?.path ?? cwd;
  line(4, 2, "WORKTREE", layout.room, "muted");
  for (const column of columns)
    if (x[column.name] !== undefined) line(4, x[column.name]!, column.header, column.width, "muted");
  // Until a removed row has closed, the cursor is its own: it goes with the
  // row, then waits on that line while the rows below move up to it, or
  // climbs to the row above when that is next.
  const removed = entries.findIndex(e => e.path === shown.removing),
    next = entries.findIndex(e => e.path === selected?.path);
  let removing: number | null = null,
    cursor: number | null = null,
    y = 5;
  for (const entry of entries.slice(offset, offset + state.capacity(rect, shown.closed))) {
    const ending = entry.path === shown.removing;
    if (ending && hold.finale(now) >= 1) {
      if (next !== removed) cursor = next > removed ? y : y - shown.closed;
      else if (hold.phase === "removing") cursor = y;
    }
    if (ending && shown.closed > 0) {
      y += row_lines - shown.closed;
      continue;
    }
    if (hold.covers(entry.path)) removing = y;
    const chosen = entry.path === selected?.path && (shown.removing === null || ending);
    const label = (chosen ? "› " : "  ") + worktrees.label(entry);
    line(y, 1, label, layout.room + 1, chosen ? "strong" : "text", chosen);
    // The path, if it fits with its last directory whole; the name says the rest.
    const path = displayPath(entry.path, main),
      short = shortPath(path, layout.room - displayWidth(label) - 1);
    if (short && short.endsWith(path.slice(path.lastIndexOf("/") + 1)))
      line(y, displayWidth(label) + 3, short, displayWidth(short), "faint");
    if (x.agents !== undefined) {
      const associations = snapshot?.agents.filter(a => a.path === entry.path) ?? [],
        counted = state.agents?.get(entry.path) ?? { agents: associations.length, working: 0 },
        total = `${counted.agents}${associations.some(a => a.stale) ? "*" : ""}`;
      if (counted.working)
        runs(y, x.agents, 6, [
          [`${counted.working}▶`, "accent", true],
          [` ${total}`, "text"],
        ]);
      else line(y, x.agents, total, 6, counted.agents ? "text" : "faint");
    }
    if (x.main !== undefined) {
      const vs = entry.comparison;
      line(y, x.main, vs ? `↑${compactCount(vs.ahead)} ↓${compactCount(vs.behind)}` : "—", 8, vs ? "text" : "faint");
    }
    if (x.age !== undefined)
      line(
        y,
        x.age,
        entry.created === null ? "—" : ageLabel((now - entry.created) / 1000),
        4,
        entry.created === null ? "faint" : "muted",
      );
    if (x.edited !== undefined) {
      const since = entry.edited === null ? null : now - entry.edited;
      // Edits in the last hour are brighter.
      line(
        y,
        x.edited,
        since === null ? "—" : `${ageLabel(since / 1000)} ago`,
        8,
        since === null ? "faint" : since < 3600000 ? "text" : "muted",
      );
    }
    if (x.changes !== undefined) {
      const changes = entry.changes,
        star = entry.stale ? "*" : "";
      if (!entry.available) line(y, x.changes, "Missing", 19, "muted");
      else if (!changes) line(y, x.changes, "…", 19, "faint");
      else if (!changes.total) line(y, x.changes, `Clean${star}`, 19, "faint");
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
    y += row_lines;
  }
  if (!selected) line(5, 2, snapshot ? "No linked worktrees" : "Discovering worktrees…", undefined, "muted");
  const status = worktreeRemoval.footer(state.removal);
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
      selected ? `↑↓ browse · Enter ${enter} · hold ⌫ remove · Esc close` : "↑↓ browse · Esc close",
      undefined,
      "faint",
    );
  }
  if (removing !== null) {
    const area = { y: removing, lines: row_lines, left: 1, right: rect.w - 2, top: 1, bottom: rect.h - 3 },
      report = hold.report;
    worktreeRemoval.paint(grid, area, hold.effect, hold.progress, hold.finale(now), now);
    // A big worktree is still being deleted once the ending has played.
    if (hold.phase === "removing" && hold.finale(now) >= 1 && report?.phase === "deleting")
      worktreeRemoval.progress(grid, area, now);
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
