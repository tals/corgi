import { groupEnd, isAgent, isGroup, isSection, isSubhead, type Sort, type View, type Target } from "./sidebar";
import { sameTarget } from "./agent_navigation";
/** What a drop does: reorder the hand-sorted list, pin or unpin an agent,
 * or reorder its activity section. */
export type Action = "move" | "pin" | "unpin" | "place";
/** An agent row dragged in the list. Hand-sorted, it moves within its workspace.
 * By activity, dropped among the pinned agents, or above the first section
 * while none are, it pins the agent there; anywhere else in its own run of
 * rows it reorders its section; a pinned agent dropped elsewhere comes unpinned. */
export class Drag {
  dragging = false;
  cancelled = false;
  drop: { index: number; y: number } | null = null;
  preview: number | null = null;
  action: Action = "move";
  cols: number;
  rows: number;
  width: number;
  count: number;
  ids: Target[];
  target: Target;
  /** The rows the agent can move among: its workspace's when sorted by hand,
   * its section's by activity, past the worktree labels in either. */
  first: number;
  end: number;
  /** Where a drop pins: from the first pinned row to just past the last. */
  pins: { first: number; end: number };
  /** The pinned section's header, which takes drops as its first row. */
  header: number | null;
  /** Whether the agent was pinned when picked up. */
  pinned: boolean;
  /** Each row's workspace, by the subhead over it; null where none says. */
  owners: (number | null)[];
  constructor(
    view: View,
    public source: number,
    public start_x: number,
    public start_y: number,
    public workspace: number,
    public current: number,
    public sort: Sort = "manual",
  ) {
    this.cols = view.cols;
    this.rows = view.rows;
    this.width = view.width;
    this.count = view.entries.length;
    this.ids = view.entries.map(e => ({ ...e.target }));
    this.target = this.ids[source];
    // Hand-sorted, an agent stays with its workspace; worktree labels never stop it.
    const bound = sort === "manual" ? isGroup : isSection;
    this.first = source;
    while (this.first > 0 && !bound(view.entries[this.first - 1].target)) this.first--;
    this.end = source + 1;
    while (this.end < view.entries.length && !bound(view.entries[this.end].target)) this.end++;
    const header = view.entries.findIndex(e => isSection(e.target) && e.target.section === "pinned");
    this.header = header < 0 ? null : header;
    this.pins = header < 0 ? { first: 0, end: 0 } : { first: header + 1, end: groupEnd(view.entries, header) };
    this.pinned = view.entries[source].section === "pinned";
    let owner: number | null = null;
    this.owners = view.entries.map(e => {
      if (isSection(e.target) || isGroup(e.target)) owner = null;
      else if (isSubhead(e.target)) owner = e.target.workspace;
      return owner;
    });
  }
  static init(view: View, source: number, x: number, y: number, workspace: number, current: number, sort?: Sort) {
    return new Drag(view, source, x, y, workspace, current, sort);
  }
  valid(view: View, current: number) {
    if (
      this.cols !== view.cols ||
      this.rows !== view.rows ||
      this.width !== view.width ||
      this.current !== current ||
      this.count !== view.entries.length
    )
      this.cancelled = true;
    if (!this.cancelled)
      for (let i = 0; i < view.entries.length; i++)
        if (!sameTarget(this.ids[i], view.entries[i].target) || view.entries[i].exit != null) this.cancelled = true;
    if (this.cancelled) {
      this.drop = null;
      this.preview = null;
    }
    return !this.cancelled;
  }
  update(view: View, current: number, x: number, y: number) {
    this.drop = null;
    this.preview = null;
    if (!this.valid(view, current) || !this.dragging) return;
    let drop = view.agentDrop(x, y);
    if (!drop) return;
    if (this.sort === "manual") {
      if (drop.index < this.first || drop.index > this.end) return;
      this.reorder(drop, "move");
      return;
    }
    if (drop.index === this.header) drop = { index: drop.index + 1, y: drop.y + 1 };
    if (drop.index >= this.pins.first && drop.index <= this.pins.end) {
      if (this.own(drop.index)) this.reorder(drop, "pin");
    } else if (this.pinned) {
      this.action = "unpin";
      this.drop = drop;
    } else if (drop.index >= this.first && drop.index <= this.end && this.own(drop.index)) this.reorder(drop, "place");
  }
  /** Whether a drop above row `index` lands among the agent's own workspace's
   * rows: the order it changes is that workspace's, so it can go nowhere else. */
  private own(index: number): boolean {
    const mine = this.owners[this.source];
    if (mine === null) return true;
    const above = index > 0 && !isSection(this.ids[index - 1]) ? this.owners[index - 1] : (this.owners[index] ?? null);
    return above === null || above === mine;
  }
  /** Previews the row at `drop`, unless that leaves it where it is. */
  private reorder(drop: { index: number; y: number }, action: Action) {
    this.preview = drop.index - Number(drop.index > this.source);
    if (this.preview === this.source && (action !== "pin" || this.pinned)) return;
    this.action = action;
    this.drop = drop;
  }
  /** The agent the dragged one lands above, past any subhead there; null
   * when it goes last. */
  before(): number | null {
    if (!this.drop || this.action === "unpin") return null;
    const end = this.action === "pin" ? this.pins.end : this.end;
    let at = this.drop.index;
    while (at < end && !isAgent(this.ids[at])) at += 1;
    return at < end ? at : null;
  }
}
