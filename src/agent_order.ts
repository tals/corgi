import { max_panes } from "./layout";
export const capacity = max_panes + 16;
export type Target = { pane: number } | { native: number };
const equal = (a: Target, b: Target) =>
  "pane" in a && "pane" in b
    ? a.pane === b.pane
    : "native" in a && "native" in b && a.native === b.native;
export function index(targets: Target[], target: Target) {
  const i = targets.findIndex((t) => equal(t, target));
  return i < 0 ? null : i;
}
export function rank(t: Target[], x: Target) {
  return index(t, x) ?? t.length;
}
export class Order {
  items: Target[] = [];
  get len() {
    return this.items.length;
  }
  slice() {
    return this.items.slice();
  }
  static restore(t: Target[]) {
    if (
      t.length > capacity ||
      t.some(
        (x, i) =>
          !("pane" in x ? x.pane : x.native) ||
          index(t.slice(0, i), x) !== null,
      )
    )
      throw Error("InvalidAgentOrder");
    const o = new Order();
    o.items = structuredClone(t);
    return o;
  }
  without(live: Target[], target: Target) {
    const o = new Order();
    for (const x of [...this.items, ...live])
      if (
        index(live, x) !== null &&
        !equal(x, target) &&
        index(o.items, x) === null
      )
        o.items.push(x);
    return o;
  }
  move(live: Target[], target: Target, before: Target | null) {
    if (live.length > capacity) throw Error("TooManyAgents");
    if (index(live, target) === null) throw Error("NoAgent");
    if (before) {
      if (index(live, before) === null) throw Error("InvalidDestination");
      if (equal(target, before)) return;
    }
    const next = this.without(live, target);
    next.items.splice(
      before ? index(next.items, before)! : next.len,
      0,
      target,
    );
    this.items = next.items;
  }
  moveAfter(live: Target[], target: Target, other: Target) {
    if (live.length > capacity) throw Error("TooManyAgents");
    const n = this.without(live, target),
      i = index(n.items, other);
    if (i === null) throw Error("InvalidDestination");
    this.move(live, target, n.items[i + 1] ?? null);
  }
}
