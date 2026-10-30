import { View, isHeading, type Entry } from "./sidebar";
import { sameTarget } from "./agent_navigation";
import * as rowGlide from "./row_glide";
const capacity = 2048;
// A ghost worktree can list an agent the sections also list.
const sameEntry = (a: Entry, b: Entry) => sameTarget(a.target, b.target) && a.worktree?.path === b.worktree?.path;
/** Positions in `seq` outside one longest increasing run of it: the rows
 * that moved when the rest kept their order. */
export function outOfOrder(seq: number[]): number[] {
  const tails: number[] = [],
    previous: number[] = [];
  seq.forEach((value, i) => {
    let lo = 0,
      hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (seq[tails[mid]] < value) lo = mid + 1;
      else hi = mid;
    }
    previous[i] = lo > 0 ? tails[lo - 1] : -1;
    tails[lo] = i;
  });
  const run = new Set<number>();
  for (let i = tails.at(-1) ?? -1; i >= 0; i = previous[i]) run.add(i);
  return seq.flatMap((_, i) => (run.has(i) ? [] : [i]));
}
/** Rows in the same group: the same checkout, and the same activity section. */
const sameGroup = (a: Entry, b: Entry) => a.worktree?.path === b.worktree?.path && a.section === b.section;
interface Stored {
  entry: Entry;
  at_ms: number;
  opening_ms: number | null;
  closing_ms: number | null;
  unbound_ms: number | null;
  occupied: boolean;
  seen: boolean;
  /** Rows above it in the list as last shown. */
  top: number;
  /** When it last changed groups, and its `top` before that. */
  moved: { at_ms: number; from: number } | null;
  /** When another row's move pushed it up or down. */
  shifted_ms: number | null;
}
export class State {
  static duration_ms = 240;
  /** Rows a move pushes aside come back from about 60%. */
  static shift_ms = 200;
  static shift_enter = 0.57;
  workspace: number | null = null;
  /** The next update's new rows fade in, as a group unfolds. */
  reveal = false;
  slots: Stored[] = [];
  order: number[] = [];
  count = 0;
  discard() {
    this.workspace = null;
  }
  capture(slot: Stored, entry: Entry, now: number) {
    slot.entry = { ...entry };
    slot.at_ms = now;
    slot.closing_ms = null;
    slot.unbound_ms = null;
    slot.occupied = true;
  }
  view(slot: Stored, now: number): Entry {
    const entry = { ...slot.entry };
    if (slot.closing_ms !== null)
      entry.exit = {
        frame_ms: slot.at_ms,
        progress: Math.min(State.duration_ms, Math.max(0, now - slot.closing_ms)) / State.duration_ms,
      };
    if (slot.opening_ms !== null && now - slot.opening_ms < State.duration_ms)
      entry.enter = Math.max(now - slot.opening_ms, 0) / State.duration_ms;
    else if (slot.shifted_ms !== null && now - slot.shifted_ms < State.shift_ms)
      entry.enter = State.shift_enter + ((1 - State.shift_enter) * Math.max(now - slot.shifted_ms, 0)) / State.shift_ms;
    else entry.enter = null;
    const moved = slot.moved;
    entry.moved =
      moved !== null && now - moved.at_ms < rowGlide.total_ms
        ? { from: moved.from, ms: Math.max(now - moved.at_ms, 0) }
        : null;
    return entry;
  }
  /** Whether a row is still moving to another group. */
  moving(now: number): boolean {
    return this.order.some(i => {
      const moved = this.slots[i].moved;
      return moved !== null && now - moved.at_ms < rowGlide.total_ms;
    });
  }
  update(workspace: number, live: Entry[], out: Entry[] = [], now = 0): Entry[] {
    if (this.workspace !== workspace) {
      this.slots = [];
      this.order = [];
      this.count = 0;
      this.workspace = workspace;
    }
    for (let i = 0; i < this.slots.length; i++) {
      const slot = this.slots[i];
      slot.seen = false;
      if (!slot.occupied || this.order.includes(i)) continue;
      if (!live.some(e => sameEntry(e, slot.entry))) slot.occupied = false;
    }
    const next: number[] = [],
      headers: Stored[] = [],
      arrivals = new Set<number>();
    let moved = false;
    for (const entry of live) {
      let index = this.slots.findIndex(s => s.occupied && sameEntry(s.entry, entry));
      // Listed under another checkout than before, an agent keeps its row.
      if (index < 0)
        index = this.slots.findIndex(
          s =>
            s.occupied && !s.seen && sameTarget(s.entry.target, entry.target) && !live.some(e => sameEntry(e, s.entry)),
        );
      if (index < 0) index = this.slots.findIndex(s => !s.occupied);
      if (index < 0) {
        index = this.slots.length;
        this.slots.push({
          entry: { ...entry },
          at_ms: now,
          opening_ms: null,
          closing_ms: null,
          unbound_ms: null,
          occupied: false,
          seen: false,
          top: 0,
          moved: null,
          shifted_ms: null,
        });
      }
      const slot = this.slots[index],
        arrived = !slot.occupied,
        regrouped = !arrived && !sameGroup(slot.entry, entry),
        lost =
          slot.occupied &&
          "pane" in entry.target &&
          slot.entry.provider === entry.provider &&
          (slot.entry.conversation ?? 0) !== 0 &&
          (entry.conversation ?? 0) === 0 &&
          ["initializing", "unknown"].includes(entry.state);
      if (lost && slot.unbound_ms === null) slot.unbound_ms = now;
      const hold = lost && now - slot.unbound_ms! < 650;
      if (!hold) this.capture(slot, entry, now);
      if (arrived) {
        arrivals.add(index);
        slot.opening_ms = entry.reopened || this.reveal ? now : null;
        slot.moved = null;
        slot.shifted_ms = null;
        if (isHeading(entry.target)) headers.push(slot);
      }
      if (regrouped && slot.closing_ms === null && sameGroup(slot.entry, entry)) {
        slot.moved = { at_ms: now, from: slot.top };
        moved = true;
      }
      slot.seen = true;
      if (slot.closing_ms === null && next.length < capacity) next.push(index);
    }
    // Rows that changed places within their group glide as well: those
    // outside the longest run that kept its order.
    const was = new Map(this.order.map((index, position) => [index, position])),
      kept = next.filter(
        i =>
          was.has(i) &&
          !arrivals.has(i) &&
          this.slots[i].moved?.at_ms !== now &&
          !isHeading(this.slots[i].entry.target),
      );
    for (const k of outOfOrder(kept.map(i => was.get(i)!))) {
      const slot = this.slots[kept[k]];
      slot.moved = { at_ms: now, from: slot.top };
      moved = true;
    }
    this.reveal = false;
    // A group the move opens fades in; one it empties goes at once.
    if (moved) for (const slot of headers) slot.opening_ms = now;
    for (let position = 0; position < this.order.length; position++) {
      const index = this.order[position],
        slot = this.slots[index];
      if (!slot.seen && slot.closing_ms === null) {
        if (moved && isHeading(slot.entry.target)) continue;
        slot.closing_ms = now;
      }
      if (slot.closing_ms !== null && now - slot.closing_ms < State.duration_ms && next.length < capacity)
        next.splice(Math.min(position, next.length), 0, index);
    }
    for (const slot of this.slots)
      if (slot.occupied && !slot.seen && (slot.closing_ms === null || now - slot.closing_ms >= State.duration_ms))
        slot.occupied = false;
    const shown = moved ? new Set(this.order) : null;
    let rows = 0;
    for (const index of next) {
      const slot = this.slots[index];
      if (shown?.has(index) && slot.moved?.at_ms !== now && slot.top !== rows) slot.shifted_ms = now;
      // A row that changed groups but lands about where it was has nowhere to glide.
      if (slot.moved?.at_ms === now && Math.abs(rows - slot.moved.from) <= 1) slot.moved = null;
      slot.top = rows;
      rows += View.height(slot.entry);
    }
    this.order = next;
    this.count = next.length;
    out.splice(0, out.length, ...next.map(i => this.view(this.slots[i], now)));
    return out;
  }
}
