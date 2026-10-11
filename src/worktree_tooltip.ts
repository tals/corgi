import { homedir } from "node:os";
import { Rect } from "./layout";
import { Style, fg } from "./palette";
import { Writer, writeEllipsis, directoryLabel } from "./text";
import * as worktrees from "./worktrees";
import { clean } from "./trackers/git_status";

export function geometry(cols: number, rows: number, side: number, anchor: number, count: number): Rect | null {
  const w = Math.min(88, cols - side - 3);
  if (w < 52 || rows < 12) return null;
  const h = Math.min(rows - 2, 8 + Math.max(1, count) * 2);
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
  clear() {
    this.workspace = null;
    this.pinned = false;
    this.selected = null;
  }
  index(entries: worktrees.Checkout[]) {
    const index = entries.findIndex(e => e.path === this.selected);
    return Math.max(0, index);
  }
  capacity(rect: Rect) {
    return Math.max(1, Math.floor((rect.h - 8) / 2));
  }
  offset(entries: worktrees.Checkout[], rect: Rect) {
    return Math.floor(this.index(entries) / this.capacity(rect)) * this.capacity(rect);
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
    const entries = worktrees.linked(snapshot),
      row = Math.floor((y - rect.y - 5) / 2);
    if (x <= rect.x || x >= rect.x + rect.w - 1 || row < 0 || row >= this.capacity(rect)) return null;
    return entries[this.offset(entries, rect) + row]?.path ?? null;
  }
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
) {
  const base = new Style({ fg: "text", bg: "surface" }).sgr();
  const line = (row: number, col: number, value: string, width = rect.w - col - 2, color = "") => {
    w.write(`\x1b[${rect.y + row + 1};${rect.x + col + 1}H${base}${color}`);
    writeEllipsis(w, clean(value), Math.max(0, width));
  };
  w.write("\x1b7\x1b[?25l");
  for (let row = 0; row < rect.h; row++) {
    w.write(`\x1b[${rect.y + row + 1};${rect.x + 1}H${base}`);
    w.splat(" ", rect.w);
    line(row, 0, "│", 1, fg("line"));
    line(row, rect.w - 1, "│", 1, fg("line"));
  }
  const entries = worktrees.linked(snapshot),
    selected = entries[state.index(entries)],
    offset = state.offset(entries, rect);
  line(0, 0, "╭" + "─".repeat(rect.w - 2) + "╮", rect.w, fg("line"));
  line(
    1,
    2,
    `${name} · ${entries.length} worktree${entries.length === 1 ? "" : "s"}`,
    rect.w - 4,
    "\x1b[1m" + fg("strong"),
  );
  line(
    2,
    2,
    snapshot?.base
      ? `Compared with local ${snapshot.base.name}${snapshot.stale ? " · last known data" : ""}`
      : "Comparison branch unavailable",
    undefined,
    fg("muted"),
  );
  const branch_width = rect.w - 39,
    agents_x = rect.w - 35,
    ahead_x = rect.w - 27,
    behind_x = rect.w - 19,
    files_x = rect.w - 11;
  line(4, 2, "WORKTREE", branch_width, fg("muted"));
  line(4, agents_x, "AGENTS", 7, fg("muted"));
  line(4, ahead_x, "AHEAD", 7, fg("muted"));
  line(4, behind_x, "BEHIND", 7, fg("muted"));
  line(4, files_x, "FILES", 9, fg("muted"));
  entries.slice(offset, offset + state.capacity(rect)).forEach((entry, i) => {
    const y = 5 + i * 2;
    const agents = snapshot?.agents.filter(a => a.path === entry.path) ?? [];
    const count = agents.length;
    const indicator = entry.path === selected?.path ? "› " : "  ";
    line(
      y,
      1,
      indicator + worktrees.label(entry),
      branch_width + 1,
      entry.path === selected?.path ? "\x1b[1m" + fg("strong") : "",
    );
    line(y + 1, 3, displayPath(entry.path, cwd), branch_width - 1, fg("faint"));
    line(y, agents_x, String(count) + (agents.some(a => a.stale) ? "*" : ""), 7, count ? fg("text") : fg("faint"));
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
      fg("muted"),
    );
  });
  if (!selected) line(5, 2, snapshot ? "No linked worktrees" : "Discovering worktrees…", undefined, fg("muted"));
  line(rect.h - 2, 2, `↑↓ browse · Enter focus agents · Esc close`, undefined, fg("faint"));
  line(rect.h - 1, 0, "╰" + "─".repeat(rect.w - 2) + "╯", rect.w, fg("line"));
  if (badge) {
    const port = Math.max(rect.y + 1, Math.min(badge.y, rect.y + rect.h - 2)),
      bend = rect.x - 2;
    const cell = (x: number, y: number, text: string) =>
      w.write(`\x1b[${y + 1};${x + 1}H${new Style({ fg: "muted", bg: "bg" }).sgr()}${text}`);
    cell(badge.x + badge.w, badge.y, "╶" + "─".repeat(Math.max(0, bend - badge.x - badge.w - 1)));
    if (port !== badge.y) {
      cell(bend, badge.y, port > badge.y ? "╮" : "╯");
      for (let y = Math.min(port, badge.y) + 1; y < Math.max(port, badge.y); y++) cell(bend, y, "│");
    }
    cell(bend, port, (port === badge.y ? "─" : port > badge.y ? "╰" : "╭") + "─");
    line(port - rect.y, 0, "├", 1, fg("muted"));
  }
  w.write("\x1b[0m\x1b8");
}
