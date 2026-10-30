import { isAgent, isGroup, isSection, isSubhead, type Sort, type View, type Target } from "./sidebar";
import { sameTarget } from "./agent_navigation";

const scroll_delay_ms = 400;
const scroll_step_ms = 180;
/** Reorder the manual list, starred agents, or an activity section. */
export type Action = "move" | "starred" | "place";
/** An agent row dragged in the list. Hand-sorted, it moves within its workspace.
 * By activity, it stays in its section. Dragging never changes its star. */
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
  starred: boolean;
  /** Each row's workspace, by the subhead over it; null where none says. */
  owners: (number | null)[];
  private pointer: { x: number; y: number } | null = null;
  private scroll_direction: -1 | 0 | 1 = 0;
  private scroll_at = 0;
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
    this.starred = view.entries[source].section === "starred";
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
      this.scroll_direction = 0;
    }
    return !this.cancelled;
  }
  update(view: View, current: number, x: number, y: number, now = 0) {
    this.pointer = { x, y };
    this.drop = null;
    this.preview = null;
    if (!this.valid(view, current) || !this.dragging) return;
    const edge = view.agentDragEdge(x, y);
    if (edge !== this.scroll_direction) {
      this.scroll_direction = edge;
      this.scroll_at = now + scroll_delay_ms;
    }
    if (edge !== 0) y = Math.max(view.middle() + 2, Math.min(y, view.listEnd() - 1));
    let drop = view.agentDrop(x, y);
    if (!drop) return;
    if (this.sort === "manual") {
      if (drop.index < this.first || drop.index > this.end) return;
      this.reorder(drop, "move");
      return;
    }
    if (drop.index === this.first - 1 && isSection(this.ids[drop.index])) drop = { index: this.first, y: drop.y + 1 };
    if (drop.index >= this.first && drop.index <= this.end && this.own(drop.index))
      this.reorder(drop, this.starred ? "starred" : "place");
  }
  /** Whether the pointer rests at an edge of the list mid-drag. */
  scrolling(): boolean {
    return this.dragging && this.scroll_direction !== 0;
  }
  /** One entry per tick, even after a stalled frame. A stationary pointer
   * keeps scrolling; re-entering an edge starts the pause again. */
  scroll(view: View, current: number, now: number): number | null {
    if (!this.pointer) return null;
    this.update(view, current, this.pointer.x, this.pointer.y, now);
    if (this.scroll_direction === 0 || now < this.scroll_at) return null;
    this.scroll_at = now + scroll_step_ms;
    const offset = Math.max(0, Math.min(view.offset + this.scroll_direction, view.maxOffset()));
    return offset === view.offset ? null : offset;
  }
  /** Recompute the drop after the viewport moves beneath the pointer. */
  scrolled(view: View, current: number, now: number): void {
    if (this.pointer) this.update(view, current, this.pointer.x, this.pointer.y, now);
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
    if (this.preview === this.source) return;
    this.action = action;
    this.drop = drop;
  }
  /** The agent the dragged one lands above, past any subhead there; null
   * when it goes last. */
  before(): number | null {
    if (!this.drop) return null;
    const end = this.end;
    let at = this.drop.index;
    while (at < end && !isAgent(this.ids[at])) at += 1;
    return at < end ? at : null;
  }
}
