import type { Entry, Target } from "./sidebar";
import { Dialog } from "./name_dialog";
export function sameTarget(a: Target | null, b: Target | null) {
  if (a === null || b === null) return a === b;
  return Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => (a as any)[k] === (b as any)[k]);
}
export function indexOf(entries: Entry[], target: Target | null) {
  if (!target) return null;
  const i = entries.findIndex(e => sameTarget(e.target, target));
  return i < 0 ? null : i;
}
export function relative(entries: Entry[], current: Target | null, next: boolean): Target | null {
  if (!entries.length) return null;
  const found = indexOf(entries, current);
  let i = found !== null ? (found + (next ? 1 : entries.length - 1)) % entries.length : next ? 0 : entries.length - 1;
  for (let step = 0; step < entries.length; step++) {
    if (!("group" in entries[i].target)) return entries[i].target;
    i = (i + (next ? 1 : entries.length - 1)) % entries.length;
  }
  return null;
}
export class History {
  current: Target | null = null;
  previous: Target | null = null;
  observe(target: Target | null) {
    if (!target || sameTarget(this.current, target)) return;
    this.previous = this.current;
    this.current = target;
  }
  destination(entries: Entry[], focused: Target | null) {
    const target = focused === null ? this.current : this.previous;
    return indexOf(entries, target) !== null ? target : null;
  }
}
export class Picker {
  query = Dialog.init({ pane: 0 }, "");
  selected: Target | null = null;
  offset = 0;
  constructor(public workspace: number) {}
  matches(entry: Entry) {
    const lower = (text: string) => text.replace(/[A-Z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 32));
    const q = lower(this.query.name());
    return [entry.name, entry.provider ?? "", entry.state, entry.cwd ?? "", entry.activity ?? ""].some(s =>
      lower(s).includes(q),
    );
  }
  list(entries: Entry[]) {
    return entries.filter(e => !("group" in e.target) && this.matches(e));
  }
  reconcile(entries: Entry[], capacity: number) {
    const i = indexOf(entries, this.selected) ?? 0;
    this.selected = entries[i]?.target ?? null;
    this.offset = Math.min(this.offset, Math.max(0, entries.length - capacity));
    if (i < this.offset) this.offset = i;
    else if (i >= this.offset + capacity) this.offset = i + 1 - capacity;
  }
  move(entries: Entry[], next: boolean, capacity: number) {
    this.reconcile(entries, capacity);
    this.selected = relative(entries, this.selected, next);
    this.reconcile(entries, capacity);
  }
}
