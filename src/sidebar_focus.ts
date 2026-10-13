//! Keyboard focus in the sidebar: a cursor in the workspace list or the agent
//! list. Plain arrows move it within its list, wrapping; prefixed ones move it
//! between the lists, as they move focus between panes. Opening a row is the
//! controller's.
import { sameTarget, type Entry, type Section, type Target } from "./sidebar";

/** A workspace row by id, or an agent list row by target. */
export type Cursor = { workspace: number } | { entry: Target };

export function same(a: Cursor, b: Cursor): boolean {
  if ("workspace" in a) return "workspace" in b && a.workspace === b.workspace;
  return "entry" in b && sameTarget(a.entry, b.entry);
}
/** List rows the cursor stops on: not a closing row. */
export function stops(e: Entry): boolean {
  return e.exit === null;
}
/** The focused agent's row, or the folded header standing in for it, else the list's first. */
function agentRow(entries: Entry[]): Cursor | null {
  const row = entries.find(e => e.focused && stops(e)) ?? entries.find(stops);
  return row ? { entry: row.target } : null;
}
/** Where focus enters: the agent list, else the current workspace's row. */
export function initial(current: number, entries: Entry[]): Cursor {
  return agentRow(entries) ?? { workspace: current };
}

export class State {
  /** The cursor's place in its list, kept for when its row goes away. */
  private index = 0;
  /** The agent row the cursor left for the workspaces, to come back to. */
  private left: Target | null = null;
  constructor(
    public cursor: Cursor,
    /** The sidebar is folded and shows only this list, over the panes; the cursor stays in it. */
    public drawer: Section | null = null,
  ) {}
  /** The list the cursor moves in. */
  section(): Section {
    return this.drawer ?? ("workspace" in this.cursor ? "workspaces" : "agents");
  }
  private list(workspaces: number[], entries: Entry[]): Cursor[] {
    if (this.section() === "workspaces") return workspaces.map(id => ({ workspace: id }));
    return entries.filter(stops).map(e => ({ entry: e.target }));
  }
  /** Keeps the cursor on its row, or the row now in its place when it closed. */
  reconcile(workspaces: number[], entries: Entry[]): void {
    const list = this.list(workspaces, entries);
    const i = list.findIndex(row => same(row, this.cursor));
    if (i >= 0) this.index = i;
    else if (list.length > 0) {
      this.index = Math.min(this.index, list.length - 1);
      this.cursor = list[this.index];
    }
  }
  /** One row down or up in the cursor's list, wrapping at either end. */
  move(workspaces: number[], entries: Entry[], down: boolean): void {
    this.reconcile(workspaces, entries);
    const list = this.list(workspaces, entries);
    if (list.length === 0) return;
    this.index = (this.index + (down ? 1 : list.length - 1)) % list.length;
    this.cursor = list[this.index];
  }
  /** Up from the agents to the current workspace, or down back to the agent
   * row it left; false when there is no list that way. */
  cross(current: number, entries: Entry[], up: boolean): boolean {
    if (this.drawer) return false;
    const cursor = this.cursor;
    if (up && "entry" in cursor) {
      this.left = cursor.entry;
      this.cursor = { workspace: current };
      return true;
    }
    if (up || !("workspace" in cursor)) return false;
    const left = this.left;
    const back = left && entries.some(e => stops(e) && sameTarget(e.target, left)) ? { entry: left } : null;
    this.cursor = back ?? agentRow(entries) ?? cursor;
    return this.cursor !== cursor;
  }
  /** Workspace rows as drawn: on a workspace, the cursor's row takes the current one's tint. */
  markWorkspaces<T extends { id: number; active: boolean }>(workspaces: T[]): T[] {
    const cursor = this.cursor;
    if (!("workspace" in cursor)) return workspaces;
    return workspaces.map(ws => ({ ...ws, active: ws.id === cursor.workspace }));
  }
  /** The list as drawn: the cursor's row is its one focused row. */
  mark(entries: Entry[]): Entry[] {
    const cursor = this.cursor;
    return entries.map(e => ({ ...e, focused: "entry" in cursor && sameTarget(cursor.entry, e.target) }));
  }
}
