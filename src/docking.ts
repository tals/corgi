import * as layout from "./layout";
import type { DockSource, DockDrop } from "./protocol";

export type Plan = { model: layout.Model; moved: number[]; shell: number | null; focus: number };
export type Edge = { direction: layout.Direction; x: number; y: number };
export const minimum = { w: 18, h: 5 };
export function clone(model: layout.Model) {
  const copy = layout.Model.fromData(model.toJSON());
  copy.next_id = model.next_id;
  return copy;
}
export function panes(model: layout.Model, root: number): number[] {
  const node = model.nodes[root]!;
  return "pane" in node ? [node.pane] : [...panes(model, node.split.first), ...panes(model, node.split.second)];
}
export function sourcePanes(model: layout.Model, source: DockSource): number[] {
  if ("pane" in source) return model.findNode(source.pane) === null ? [] : [source.pane];
  const index = model.tabIndex(source.tab);
  return index === null ? [] : panes(model, model.tabs[index].root);
}
export function shape(model: layout.Model): string {
  const tree = (root: number): unknown => {
    const node = model.nodes[root]!;
    return "pane" in node
      ? node.pane
      : [node.split.axis, node.split.ratio, tree(node.split.first), tree(node.split.second)];
  };
  return JSON.stringify(model.tabs.map(tab => [tab.id, tab.title, tree(tab.root)]));
}
/** The viewer and daemon build the same candidate; neither touches the source. */
export function arrange(original: layout.Model, source: DockSource, drop: DockDrop, focus: number, next: number): Plan {
  const model = clone(original),
    moved = sourcePanes(model, source);
  if (!moved.length || !moved.includes(focus)) throw Error("InvalidDestination");
  model.next_id = next;
  const tabIndex = model.tabForPane(moved[0])!,
    tab = model.tabs[tabIndex];
  let shell: number | null = null;
  if (drop.kind === "tab" && ("tab" in source || model.paneCount(tab.root) === 1)) {
    if (drop.index > model.count) throw Error("InvalidDestination");
    model.moveTab(tab.id, drop.index);
  } else if (drop.kind === "swap") {
    if (!("pane" in source) || model.findNode(drop.pane) === null) throw Error("InvalidDestination");
    model.swap(source.pane, drop.pane);
  } else {
    if (drop.kind === "beside" && model.findNode(drop.pane) === null) throw Error("InvalidDestination");
    let copied: number;
    if (drop.kind === "beside" && moved.includes(drop.pane)) {
      if (!("tab" in source)) throw Error("InvalidDestination");
      shell = model.next_id++;
      copied = model.alloc({ pane: shell });
      moved.splice(0, moved.length, shell);
      focus = shell;
    } else {
      const root = "tab" in source ? tab.root : model.findNode(source.pane)!;
      if ("tab" in source) model.removeTab(tabIndex);
      else model.close(source.pane);
      copied = model.copyTree(original, root);
    }
    if (drop.kind === "tab") {
      if (drop.index > original.count) throw Error("InvalidDestination");
      const made = new layout.Tab(model.next_id++, copied);
      model.tabs.push(made);
      model.count++;
      model.moveTab(made.id, Math.min(drop.index, model.count));
    } else {
      const target = model.tabs[model.tabForPane(drop.pane)!];
      if (model.paneCount(target.root) + moved.length > layout.max_panes) throw Error("TooManyPanes");
      if (drop.whole) {
        const before = drop.direction === "left" || drop.direction === "up";
        target.root = model.alloc({
          split: {
            axis: drop.direction === "left" || drop.direction === "right" ? "horizontal" : "vertical",
            first: before ? copied : target.root,
            second: before ? target.root : copied,
            ratio: 500,
          },
        });
      } else model.insertTree(copied, drop.pane, drop.direction);
    }
  }
  clone(model);
  if (shape(original) === shape(model)) throw Error("AlreadyHere");
  return { model, moved, shell, focus };
}
export function view(plan: Plan): layout.View {
  const selection = new layout.Selection();
  selection.reconcile(plan.model);
  selection.focus(plan.model, plan.focus);
  return new layout.View(plan.model, selection);
}
export function fits(plan: Plan, area: layout.Rect) {
  return view(plan)
    .placements(area)
    .every(p => p.rect.w >= minimum.w && p.rect.h >= minimum.h);
}
export function nextId(model: layout.Model): number {
  return Math.max(0, ...model.tabs.map(t => t.id), ...model.nodes.flatMap(n => (n && "pane" in n ? [n.pane] : []))) + 1;
}
/** Outside the broad middle band, outer frame cells belong to their leaf. */
export function target(
  view: layout.View,
  area: layout.Rect,
  x: number,
  y: number,
  previous: { pane: number; whole: boolean; point: Edge } | null,
  swap: boolean,
): DockDrop | null {
  if (!area.contains(x, y)) return null;
  // Pane drags keep a center swap target; tab drags hold their split axis.
  if (swap) previous = null;
  const whole = wholeEdge(view, area, x, y, previous?.whole ? previous.point : null);
  const placements = view.placements(area);
  if (whole) return { kind: "beside", pane: placements[0].id, direction: whole, whole: true };
  const pane =
    placements.find(p => p.rect.contains(x, y)) ??
    placements.find(p => new layout.Rect(p.rect.x - 1, p.rect.y - 1, p.rect.w + 2, p.rect.h + 2).contains(x, y));
  if (!pane) return null;
  const px = Math.max(pane.rect.x, Math.min(pane.rect.x + pane.rect.w - 1, x));
  const py = Math.max(pane.rect.y, Math.min(pane.rect.y + pane.rect.h - 1, y));
  const direction = edge(pane.rect, px, py, previous?.pane === pane.id && !previous.whole ? previous.point : null);
  return direction
    ? { kind: "beside", pane: pane.id, direction, whole: false }
    : swap
      ? { kind: "swap", pane: pane.id }
      : null;
}

/** The middle band follows the root divider; either side belongs to a leaf. */
export function wholeEdge(
  view: layout.View,
  area: layout.Rect,
  x: number,
  y: number,
  previous: Edge | null,
): layout.Direction | null {
  if (!view.hasFrame(area)) return null;
  const node = view.model.nodes[view.model.tabs[view.selection.active].root]!;
  if (!("split" in node)) return null;
  const direction = edge(area, x, y, previous);
  if (!direction) return null;
  const vertical = direction === "up" || direction === "down";
  if (vertical !== (node.split.axis === "horizontal")) return null;
  const [first, divider, second] = layout.splitRects(node.split, view.contentArea(area));
  const middle = vertical ? divider.x : divider.y;
  const radius = Math.max(1, Math.floor(Math.min(vertical ? first.w : first.h, vertical ? second.w : second.h) / 3));
  return Math.abs((vertical ? x : y) - middle) <= radius ? direction : null;
}

export function edge(rect: layout.Rect, x: number, y: number, previous: Edge | null = null): layout.Direction | null {
  if (!rect.contains(x, y)) return null;
  const distances: [layout.Direction, number][] = [
    ["left", (x - rect.x) / rect.w],
    ["right", (rect.x + rect.w - 1 - x) / rect.w],
    ["up", (y - rect.y) / rect.h],
    ["down", (rect.y + rect.h - 1 - y) / rect.h],
  ];
  const nearest = distances.sort((a, b) => a[1] - b[1])[0];
  const entered = nearest[1] < 0.25 ? nearest[0] : null;
  if (!previous) return entered;
  const horizontal = previous.direction === "left" || previous.direction === "right";
  // A perpendicular edge takes over only when moving toward it. A sweep
  // across a pane keeps its axis, even near the top or bottom corners.
  if (horizontal) {
    if (entered === "up" && y < previous.y) return "up";
    if (entered === "down" && y > previous.y) return "down";
  } else {
    if (entered === "left" && x < previous.x) return "left";
    if (entered === "right" && x > previous.x) return "right";
  }
  const side = horizontal ? 2 * (x - rect.x) + 1 - rect.w : 2 * (y - rect.y) + 1 - rect.h;
  if (side === 0) return previous.direction;
  return horizontal ? (side < 0 ? "left" : "right") : side < 0 ? "up" : "down";
}

export type Grip = { pane: number; rect: layout.Rect; near: layout.Rect; far: layout.Rect };
export function grips(view: layout.View, area: layout.Rect): Grip[] {
  if (!view.hasFrame(area)) return [];
  return view
    .placements(area)
    .filter(p => p.rect.w > 3)
    .map(p => ({
      pane: p.id,
      rect: new layout.Rect(p.rect.x + 2, p.rect.y - 1, Math.min(4, p.rect.w - 3), 1),
      near: new layout.Rect(p.rect.x - 1, p.rect.y - 1, p.rect.w + 2, 1),
      far: new layout.Rect(p.rect.x - 1, p.rect.y - 2, p.rect.w + 2, 3),
    }));
}
/** A grip appears with the pointer on its pane's top border and stays until
 * the pointer is more than a row away, so a shaky hand doesn't flicker it. */
export function hovered(grips: Grip[], x: number, y: number, shown: readonly number[]): Grip[] {
  return grips.filter(g => g.near.contains(x, y) || (shown.includes(g.pane) && g.far.contains(x, y)));
}
