import { homedir } from "node:os";
import { Rect } from "./layout";
import * as palette from "./palette";
import { Writer, ellipsis, directoryLabel, displayWidth } from "./text";
import { Grid } from "./cell_grid";
import * as worktrees from "./worktrees";
import * as worktreeRemoval from "./worktree_removal";
import { clean } from "./trackers/git_status";
import { milliTimestamp } from "./clock";

/** The card for `count` worktrees, `closed` lines shorter while a removed row closes. */
export function geometry(
  cols: number,
  rows: number,
  side: number,
  anchor: number,
  count: number,
  closed = 0,
): Rect | null {
  const w = Math.min(88, cols - side - 3);
  if (w < 52 || rows < 12) return null;
  const h = Math.min(rows - 2, 8 + Math.max(1, count) * 2 - closed);
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
  removal = new worktreeRemoval.Hold();
  /** The removal effect for this opening of the overview, drawn when first needed. */
  private effect: worktreeRemoval.Effect | null = null;
  private last_effect: worktreeRemoval.Effect | null = null;
  clear() {
    this.workspace = null;
    this.pinned = false;
    this.selected = null;
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
    return Math.max(1, Math.floor((rect.h - 8 + closed) / 2));
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
      row = Math.floor((y - rect.y - 5) / 2);
    if (x <= rect.x || x >= rect.x + rect.w - 1 || row < 0 || row >= this.capacity(rect, closed)) return null;
    return entries[this.offset(entries, rect, closed) + row]?.path ?? null;
  }
}
/** The worktrees the overview lists: the linked ones, and one just removed
 * until its row has closed. */
export function listing(snapshot: worktrees.Snapshot | null, state: State, now = milliTimestamp()) {
  return state.removal.shown(worktrees.linked(snapshot), now);
}
function displayPath(path: string, cwd: string): string {
  const root = cwd.replace(/\/+$/, "");
  if (cwd && (path === root || path.startsWith(root + "/"))) return "." + path.slice(root.length);
  return directoryLabel(path, homedir());
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
  const branch_width = rect.w - 39,
    agents_x = rect.w - 35,
    ahead_x = rect.w - 27,
    behind_x = rect.w - 19,
    files_x = rect.w - 11;
  line(4, 2, "WORKTREE", branch_width, "muted");
  line(4, agents_x, "AGENTS", 7, "muted");
  line(4, ahead_x, "AHEAD", 7, "muted");
  line(4, behind_x, "BEHIND", 7, "muted");
  line(4, files_x, "FILES", 9, "muted");
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
      y += 2 - shown.closed;
      continue;
    }
    if (hold.covers(entry.path)) removing = y;
    const agents = snapshot?.agents.filter(a => a.path === entry.path) ?? [];
    const count = agents.length;
    const chosen = entry.path === selected?.path && (shown.removing === null || ending);
    line(y, 1, (chosen ? "› " : "  ") + worktrees.label(entry), branch_width + 1, chosen ? "strong" : "text", chosen);
    line(y + 1, 3, displayPath(entry.path, cwd), branch_width - 1, "faint");
    line(y, agents_x, String(count) + (agents.some(a => a.stale) ? "*" : ""), 7, count ? "text" : "faint");
    line(y, ahead_x, entry.comparison?.ahead.toString() ?? "—", 7);
    line(y, behind_x, entry.comparison?.behind.toString() ?? "—", 7);
    line(
      y,
      files_x,
      !entry.available
        ? "Missing"
        : entry.changes
          ? entry.changes.total
            ? `${entry.changes.total}${entry.stale ? "*" : ""}`
            : entry.stale
              ? "Clean*"
              : "Clean"
          : "…",
      9,
      "muted",
    );
    y += 2;
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
  if (removing !== null)
    worktreeRemoval.paint(
      grid,
      { y: removing, left: 1, right: rect.w - 2, top: 1, bottom: rect.h - 3 },
      hold.effect,
      hold.progress,
      hold.finale(now),
      now,
    );
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
