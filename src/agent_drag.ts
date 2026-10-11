import { isHeading, type View, type Target } from "./sidebar";
import { sameTarget } from "./agent_navigation";
export class Drag {
  dragging = false;
  cancelled = false;
  drop: { index: number; y: number } | null = null;
  preview: number | null = null;
  cols: number;
  rows: number;
  width: number;
  count: number;
  ids: Target[];
  target: Target;
  first: number;
  end: number;
  constructor(
    view: View,
    public source: number,
    public start_x: number,
    public start_y: number,
    public workspace: number,
    public current: number,
  ) {
    this.cols = view.cols;
    this.rows = view.rows;
    this.width = view.width;
    this.count = view.entries.length;
    this.ids = view.entries.map(e => ({ ...e.target }));
    this.target = this.ids[source];
    this.first = source;
    while (this.first > 0 && !isHeading(view.entries[this.first - 1].target)) this.first--;
    this.end = source + 1;
    while (this.end < view.entries.length && !isHeading(view.entries[this.end].target)) this.end++;
  }
  static init(view: View, source: number, x: number, y: number, workspace: number, current: number) {
    return new Drag(view, source, x, y, workspace, current);
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
    const drop = view.agentDrop(x, y);
    if (!drop || drop.index < this.first || drop.index > this.end) return;
    this.preview = drop.index - Number(drop.index > this.source);
    if (this.preview === this.source) return;
    this.drop = drop;
  }
}
