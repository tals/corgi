import type { View } from "./sidebar";
export class Drag {
  dragging = false;
  cancelled = false;
  drop: { index: number; y: number } | null = null;
  preview: number | null = null;
  cols: number;
  rows: number;
  width: number;
  count: number;
  ids: number[];
  constructor(
    view: View,
    ids: number[],
    public source: number,
    public start_x: number,
    public start_y: number,
  ) {
    this.cols = view.cols;
    this.rows = view.rows;
    this.width = view.width;
    this.count = ids.length;
    this.ids = [...ids];
  }
  static init(view: View, ids: number[], source: number, x: number, y: number) {
    return new Drag(view, ids, source, x, y);
  }
  valid(view: View, ids: number[]) {
    if (
      this.cols !== view.cols ||
      this.rows !== view.rows ||
      this.width !== view.width ||
      this.ids.length !== ids.length ||
      this.ids.some((id, i) => id !== ids[i])
    )
      this.cancelled = true;
    if (this.cancelled) {
      this.drop = null;
      this.preview = null;
    }
    return !this.cancelled;
  }
  update(view: View, ids: number[], x: number, y: number) {
    this.drop = null;
    this.preview = null;
    if (!this.valid(view, ids) || !this.dragging) return;
    const drop = view.workspaceDrop(x, y);
    if (!drop) return;
    this.preview = drop.index - Number(drop.index > this.source);
    if (this.preview === this.source) return;
    this.drop = drop;
  }
  before() {
    return this.drop
      ? this.drop.index === this.count
        ? this.ids[this.source]
        : this.ids[this.drop.index]
      : null;
  }
}
