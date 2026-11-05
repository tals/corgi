import * as i18n from "./i18n";
import * as layout from "./layout";
import * as docking from "./docking";
import * as render from "./render";
import * as errors from "./errors";
import * as text from "./text";
import type { DockSource, DockDrop } from "./protocol";

export class Drag {
  dragging = false;
  cancelled = false;
  drop: DockDrop | null = null;
  plan: docking.Plan | null = null;
  drop_x: number | null = null;
  reason: "edge" | "small" | "invalid" | null = null;
  edge: { pane: number; whole: boolean; point: docking.Edge; tab: number } | null = null;
  hover: { tab: number; since: number } | null = null;
  scroll: { forward: boolean; due: number } | null = null;
  before: layout.Selection;
  revision: bigint;
  constructor(
    readonly workspace_id: number,
    readonly source: DockSource,
    readonly focus: number,
    model: layout.Model,
    selection: layout.Selection,
    readonly area: layout.Rect,
    readonly tabs_x: number,
    readonly width: number,
    readonly height: number,
    readonly start_x: number,
    readonly start_y: number,
  ) {
    this.revision = model.revision;
    this.before = Object.assign(new layout.Selection(), structuredClone(selection));
  }
  valid(workspace: number, model: layout.Model, area: layout.Rect, width: number, height: number, tabs_x: number) {
    if (
      workspace !== this.workspace_id ||
      model.revision !== this.revision ||
      width !== this.width ||
      height !== this.height ||
      tabs_x !== this.tabs_x ||
      area.x !== this.area.x ||
      area.y !== this.area.y ||
      area.w !== this.area.w ||
      area.h !== this.area.h
    )
      this.cancelled = true;
    return !this.cancelled;
  }
  update(view: layout.View, x: number, y: number, tabSpace: number, now: number) {
    this.drop = null;
    this.plan = null;
    this.drop_x = null;
    this.reason = null;
    const previous = this.edge;
    this.edge = null;
    if (this.cancelled || !this.dragging) return;
    if (y === 0 && x >= this.tabs_x && x < this.tabs_x + tabSpace + 3) {
      const tab = render.tabAt(view, tabSpace + 3, x - this.tabs_x);
      const id = tab === null ? null : view.model.tabs[tab].id;
      if (id !== null && tab !== view.selection.active && !("tab" in this.source && this.source.tab === id)) {
        if (this.hover?.tab !== id) this.hover = { tab: id, since: now };
      } else this.hover = null;
      const forward = x >= this.tabs_x + tabSpace + 1 ? true : x < this.tabs_x + 2 ? false : null;
      if (forward === null) this.scroll = null;
      else if (this.scroll?.forward !== forward) this.scroll = { forward, due: now + 600 };
      const at = render.tabDrop(view, tabSpace + 3, x - this.tabs_x);
      if (at) {
        this.drop = { kind: "tab", index: at.index };
        this.drop_x = at.x;
      }
    } else {
      this.hover = null;
      this.scroll = null;
      const tab = view.model.tabs[view.selection.active].id;
      this.drop = docking.target(view, this.area, x, y, previous?.tab === tab ? previous : null, "pane" in this.source);
      if (this.drop?.kind === "beside" && this.drop.whole && "pane" in this.source) {
        const remaining = docking
          .panes(view.model, view.model.tabs[view.selection.active].root)
          .find(id => id !== this.focus);
        if (remaining !== undefined) this.drop.pane = remaining;
      }
      if (!this.drop && this.area.contains(x, y)) this.reason = "edge";
    }
    if (!this.drop) return;
    try {
      const plan = docking.arrange(view.model, this.source, this.drop, this.focus, docking.nextId(view.model));
      if (this.drop.kind === "beside" && !docking.fits(plan, this.area)) {
        this.reason = "small";
        return;
      }
      this.plan = plan;
      if (this.drop.kind === "beside")
        this.edge = {
          pane: this.drop.pane,
          whole: this.drop.whole,
          point: { direction: this.drop.direction, x, y },
          tab: view.model.tabs[view.selection.active].id,
        };
    } catch (error) {
      if (!errors.is(error, "AlreadyHere")) this.reason = "invalid";
    }
  }
}

export function controls(area: layout.Rect) {
  const entries = [
    { name: "undo-layout", label: `[ ${i18n.t`Undo`} ]` },
    { name: "redo-layout", label: `[ ${i18n.t`Redo`} ]` },
    { name: "cancel-dock", label: `[ ${i18n.t`Cancel`} ]` },
  ];
  const width = entries.reduce((n, entry) => n + text.displayWidth(entry.label) + 1, 0);
  if (area.w < width + 24) return [];
  let x = area.x + area.w - width;
  return entries.map(entry => {
    const rect = new layout.Rect(x, 0, text.displayWidth(entry.label), 1);
    x += rect.w + 1;
    return { ...entry, rect };
  });
}
