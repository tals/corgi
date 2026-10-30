export type Target = { pane: number } | { headless: number };
/** The agent list's activity sections, in the order it shows them. */
export type Section = "pinned" | "working" | "ready" | "idle" | "done";
/** The section an agent's state puts it in. One waiting on the user, or
 * paused until its background work wakes it, is still at work; its row says so. */
export function section(state: string, attention: string, paused = false): Exclude<Section, "pinned"> {
  if (state === "done") return "done";
  // One just starting waits among the idle rather than passing through work.
  if (state === "working" || state === "blocked" || attention === "needs_input" || paused) return "working";
  if (attention === "finished") return "ready";
  return "idle";
}
const equal = (a: Target, b: Target) =>
  "pane" in a && "pane" in b ? a.pane === b.pane : "headless" in a && "headless" in b && a.headless === b.headless;
export function index(targets: Target[], target: Target) {
  const i = targets.findIndex(t => equal(t, target));
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
    if (t.some((x, i) => !("pane" in x ? x.pane : x.headless) || index(t.slice(0, i), x) !== null))
      throw Error("InvalidAgentOrder");
    const o = new Order();
    o.items = structuredClone(t);
    return o;
  }
  without(live: Target[], target: Target) {
    const o = new Order();
    for (const x of [...this.items, ...live])
      if (index(live, x) !== null && !equal(x, target) && index(o.items, x) === null) o.items.push(x);
    return o;
  }
  move(live: Target[], target: Target, before: Target | null) {
    if (index(live, target) === null) throw Error("NoAgent");
    if (before) {
      if (index(live, before) === null) throw Error("InvalidDestination");
      if (equal(target, before)) return;
    }
    const next = this.without(live, target);
    next.items.splice(before ? index(next.items, before)! : next.len, 0, target);
    this.items = next.items;
  }
  /** Puts `target` first. */
  raise(live: Target[], target: Target) {
    if (index(live, target) === null) throw Error("NoAgent");
    this.items = [target, ...this.without(live, target).items];
  }
  has(target: Target) {
    return index(this.items, target) !== null;
  }
  moveAfter(live: Target[], target: Target, other: Target) {
    const n = this.without(live, target),
      i = index(n.items, other);
    if (i === null) throw Error("InvalidDestination");
    this.move(live, target, n.items[i + 1] ?? null);
  }
}
/** The agents a workspace pins above its activity sections, in the order
 * they were put there. Pins of agents that are gone drop out on the next change. */
export class Pins {
  items: Target[] = [];
  slice() {
    return this.items.slice();
  }
  has(target: Target) {
    return index(this.items, target) !== null;
  }
  static restore(t: Target[]) {
    const p = new Pins();
    p.items = Order.restore(t).items;
    return p;
  }
  /** The live pins other than `target`. */
  private without(live: Target[], target: Target) {
    return this.items.filter(x => index(live, x) !== null && !equal(x, target));
  }
  /** Pins `target` just above the pinned `before`, or last. */
  pin(live: Target[], target: Target, before: Target | null) {
    if (index(live, target) === null) throw Error("NoAgent");
    // Above itself: a pinned agent stays put; one not pinned yet goes last.
    if (before && equal(target, before)) {
      if (this.has(target)) return;
      before = null;
    }
    const next = this.without(live, target);
    const at = before ? index(next, before) : next.length;
    if (at === null) throw Error("InvalidDestination");
    next.splice(at, 0, target);
    this.items = next;
  }
  unpin(live: Target[], target: Target) {
    this.items = this.without(live, target);
  }
  /** Pins `target` right below `other`, when `other` is pinned. */
  pinAfter(live: Target[], target: Target, other: Target) {
    const next = this.without(live, target),
      i = index(next, other);
    if (i === null) return;
    this.pin(live, target, next[i + 1] ?? null);
  }
}
