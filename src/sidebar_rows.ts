import type { Entry } from "./sidebar";
import { sameTarget } from "./agent_navigation";
const capacity = 2048;
const sameEntry = (a: Entry, b: Entry) => sameTarget(a.target, b.target) && a.worktree?.path === b.worktree?.path;
interface Stored {
  entry: Entry;
  at_ms: number;
  opening_ms: number | null;
  closing_ms: number | null;
  unbound_ms: number | null;
  ended: boolean;
  occupied: boolean;
  seen: boolean;
}
export class State {
  static duration_ms = 240;
  workspace: number | null = null;
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
    slot.ended = false;
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
    else entry.enter = null;
    return entry;
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
    const next: number[] = [];
    for (const entry of live) {
      let index = this.slots.findIndex(s => s.occupied && sameEntry(s.entry, entry));
      if (index < 0) index = this.slots.findIndex(s => !s.occupied);
      if (index < 0) {
        index = this.slots.length;
        this.slots.push({
          entry: { ...entry },
          at_ms: now,
          opening_ms: null,
          closing_ms: null,
          unbound_ms: null,
          ended: false,
          occupied: false,
          seen: false,
        });
      }
      const slot = this.slots[index],
        arrived = !slot.occupied,
        lost =
          slot.occupied &&
          "pane" in entry.target &&
          slot.entry.provider === entry.provider &&
          (slot.entry.conversation ?? 0) !== 0 &&
          (entry.conversation ?? 0) === 0 &&
          ["initializing", "unknown"].includes(entry.state);
      if (lost && slot.unbound_ms === null) slot.unbound_ms = now;
      const hold = lost && now - slot.unbound_ms! < 650;
      if (!hold) {
        const same =
          slot.occupied && slot.entry.conversation === entry.conversation && slot.entry.provider === entry.provider;
        if (
          same &&
          "pane" in entry.target &&
          entry.state === "done" &&
          slot.entry.state !== "done" &&
          slot.closing_ms === null
        ) {
          slot.closing_ms = now;
          slot.ended = true;
        }
        if (!same || slot.closing_ms === null || !slot.ended) this.capture(slot, entry, now);
      }
      if (arrived) slot.opening_ms = entry.reopened ? now : null;
      slot.seen = true;
      if (slot.closing_ms === null && next.length < capacity) next.push(index);
    }
    for (let position = 0; position < this.order.length; position++) {
      const index = this.order[position],
        slot = this.slots[index];
      if (!slot.seen && slot.closing_ms === null) slot.closing_ms = now;
      if (slot.closing_ms !== null && now - slot.closing_ms < State.duration_ms && next.length < capacity)
        next.splice(Math.min(position, next.length), 0, index);
    }
    for (const slot of this.slots)
      if (slot.occupied && !slot.seen && (slot.closing_ms === null || now - slot.closing_ms >= State.duration_ms))
        slot.occupied = false;
    this.order = next;
    this.count = next.length;
    out.splice(0, out.length, ...next.map(i => this.view(this.slots[i], now)));
    return out;
  }
}
