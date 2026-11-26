//! Workspace cards that a daemon's auto-order moves fade out where they
//! were, then in where they land; an auto-archived card fades out before
//! the list closes its gap. Changes the user makes, and a new list, show at
//! once.
import type { WorkspaceEntry } from "./sidebar";
import type { Workspace } from "./viewer_ref";
import * as sidebarRows from "./sidebar_rows";

/** A card's fade, as `writeExit` takes it: `from` at `at_ms`, then toward
 * gone when `out`, else toward shown. */
interface Fade {
  out: boolean;
  at_ms: number;
  from: number;
}
export interface Sources {
  /** The run of cards whose moves animate, as one machine's daemon orders
   * them; null for a card whose moves never do. */
  group(key: Workspace): number | null;
  /** Whether a card gone from the list was auto-archived. */
  archived(key: Workspace): boolean;
}
const same = (a: Workspace[], b: Workspace[]) => a.length === b.length && a.every((key, i) => key === b[i]);
export class State {
  static duration_ms = sidebarRows.State.duration_ms;
  /** Card ids in the order drawn, which clicks hit; null until the list is built. */
  shown: Workspace[] | null = null;
  /** The order the cards take once the moving ones have faded out. */
  target: Workspace[] = [];
  private cards = new Map<Workspace, WorkspaceEntry>();
  private fades = new Map<Workspace, Fade>();
  private placed = false;
  discard() {
    this.shown = null;
    this.target = [];
    this.cards.clear();
    this.fades.clear();
  }
  /** The next update's order is where the user put the cards. */
  place() {
    this.placed = true;
  }
  /** How faded card `key` is at `now`, null when it is not. */
  level(key: Workspace, now: number): number | null {
    const fade = this.fades.get(key);
    if (fade === undefined) return null;
    const t = Math.max(0, now - fade.at_ms) / State.duration_ms;
    if (fade.out) return Math.min(1, fade.from + t);
    const level = fade.from - t;
    return level > 0 ? level : null;
  }
  /** Whether a card is fading, or the order waits to switch. */
  fading(now: number): boolean {
    if (this.shown === null) return false;
    if (!same(this.shown, this.target)) return true;
    for (const key of this.fades.keys()) if (this.level(key, now) !== null) return true;
    return false;
  }
  /** `live`'s cards in the order drawn, each with its fade at `now`. The
   * order changes here only when the cards come or go; a move waits for
   * `step`. */
  update(live: WorkspaceEntry[], now: number, sources: Sources): WorkspaceEntry[] {
    const keys = live.map(row => row.id);
    for (const row of live) this.cards.set(row.id, row);
    const placed = this.placed;
    this.placed = false;
    if (this.shown === null || placed) this.snap(keys);
    else if (!same(keys, this.target)) this.plan(keys, now, sources);
    return this.shown!.map(key => ({ ...this.cards.get(key)!, fade: this.level(key, now) }));
  }
  /** Switches to the latest order once the moving cards have faded out;
   * they fade in from there. Called once a frame, before drawing. */
  step(now: number): void {
    const shown = this.shown;
    if (shown === null || same(shown, this.target)) {
      for (const key of [...this.fades.keys()]) if (this.level(key, now) === null) this.fades.delete(key);
      return;
    }
    let done = -Infinity;
    for (const fade of this.fades.values())
      if (fade.out) done = Math.max(done, fade.at_ms + (1 - fade.from) * State.duration_ms);
    if (now < done) return;
    const kept = new Set(this.target);
    for (const key of shown)
      if (!kept.has(key)) {
        this.cards.delete(key);
        this.fades.delete(key);
      }
    for (const [key, fade] of this.fades) if (fade.out) this.fades.set(key, { out: false, at_ms: done, from: 1 });
    this.shown = this.target;
  }
  private snap(keys: Workspace[]) {
    this.shown = this.target = keys;
    this.fades.clear();
    const kept = new Set(keys);
    for (const key of [...this.cards.keys()]) if (!kept.has(key)) this.cards.delete(key);
  }
  private plan(keys: Workspace[], now: number, sources: Sources) {
    const shown = this.shown!,
      live = new Set(keys),
      was = new Map(shown.map((key, position) => [key, position]));
    // Cards that came, or went other than by auto-archive, are the user's doing.
    if (keys.some(key => !was.has(key)) || shown.some(key => !live.has(key) && !sources.archived(key)))
      return this.snap(keys);
    const moving = new Set(shown.filter(key => !live.has(key))),
      groups = new Map<number, Workspace[]>();
    for (const key of keys) {
      const group = sources.group(key);
      if (group === null) continue;
      const run = groups.get(group);
      if (run) run.push(key);
      else groups.set(group, [key]);
    }
    // Within a machine's order, the cards outside the longest run that kept
    // its order are the ones that moved.
    for (const run of groups.values())
      for (const i of sidebarRows.outOfOrder(run.map(key => was.get(key)!))) moving.add(run[i]);
    // Rearranged across machines, or where nothing animates: no motion.
    if (moving.size === 0 && !same(keys, shown)) return this.snap(keys);
    for (const key of shown) {
      const fade = this.fades.get(key),
        level = this.level(key, now) ?? 0;
      // Each fade goes on from how faded the card is now.
      if (moving.has(key)) {
        if (!fade?.out) this.fades.set(key, { out: true, at_ms: now, from: level });
      } else if (fade?.out) this.fades.set(key, { out: false, at_ms: now, from: level });
    }
    this.target = keys;
  }
}
