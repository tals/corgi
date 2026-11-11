import type * as viewerRef from "./viewer_ref";
//! The push card: a workspace's unpushed commits beside its push label.
//! Hovering a row shows its review dimmed; a click or Enter opens it.
import { Rect } from "./layout";
import type * as panel from "./review/panel";
import type { WorkspaceEntry } from "./sidebar";
import { sat } from "./text";

export { aim_ms, aimed } from "./menu_aim";
/** Where the pointer left the push label on its way to the card, and when it
 * last moved inside the aim triangle. */
export interface Aim {
  x: number;
  y: number;
  at: number;
}
/** What a row reviews: the whole push, or one of its commits. */
export interface Review {
  scope: panel.Scope;
  pick: string | null;
}
/** The commits the card lists on a screen `rows` tall. */
export function shown(ws: WorkspaceEntry, rows: number): number {
  return Math.min(ws.git_commits.length, Math.floor((rows - 6) / 2));
}
/** The card beside the cell (`px`, `py`), or null when the screen is too small. */
export function geometry(ws: WorkspaceEntry, cols: number, rows: number, px: number, py: number): Rect | null {
  if (cols < 24 || rows < 8) return null;
  const width = Math.min(76, cols);
  const count = shown(ws, rows);
  const remaining = sat(ws.git_ahead ?? 0, count);
  const has_footer = remaining > 0 || ws.git_commits.length === 0;
  const height = 3 + count * 2 + (has_footer ? 1 : 0);
  return new Rect(Math.min(px + 2, cols - width), Math.min(py + 1, rows - 1 - height), width, height);
}
/** The row under a cell: 0 for the heading, which stands for the whole push,
 * then one per commit, two lines each. */
export function rowAt(rect: Rect, ws: WorkspaceEntry, rows: number, x: number, y: number): number | null {
  if (x <= rect.x || x >= rect.x + rect.w - 1) return null;
  if (y === rect.y + 1) return 0;
  const i = Math.floor((y - rect.y - 2) / 2);
  return y >= rect.y + 2 && i < shown(ws, rows) ? i + 1 : null;
}
/** What row `row` reviews: the push as the "all" scope, a commit by itself. */
export function review(ws: WorkspaceEntry, row: number): Review | null {
  if (row === 0) return { scope: "all", pick: null };
  const commit = ws.git_commits[row - 1];
  return commit ? { scope: "commits", pick: commit.hash } : null;
}
export class State {
  workspace: viewerRef.Workspace | null = null;
  /** The cell the card opened beside, on the push label. */
  anchor = { x: 0, y: 0 };
  /** Held open for the keyboard. */
  pinned = false;
  /** The row whose review shows dimmed. */
  selected: number | null = null;
  pin(): void {
    this.pinned = true;
    this.selected ??= 0;
  }
  release(): void {
    this.pinned = false;
    this.selected = null;
  }
  /** Moves the selection `by` rows among `count`, from the heading when none is. */
  move(by: number, count: number): void {
    this.selected = this.selected === null ? 0 : Math.max(0, Math.min(count - 1, this.selected + by));
  }
}
