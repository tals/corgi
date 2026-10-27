//! Which checklist rows the agent card shows: open work first, finished
//! context in spare rows, and when a finished checklist leaves the card.
import type { Item, List, Status } from "./activity/checklist";

/** How long a finished checklist stays on the card after it last changed, in µs. */
export const retire_after = 60_000_000;
const rank: Record<Status, number> = { done: 0, dropped: 0, active: 1, blocked: 1, pending: 2 };
/** `run` numbers the item's run of one group in the provider's order. */
export type Row = Item & { run: number };
export interface Group {
  name: string;
  items: Row[];
  more_done: number;
}
export interface Window {
  items: Row[];
  groups: Group[];
  total: number;
  done: number;
  more_pending: number;
  rows: number;
}

/** Shown while any work is open, and for a while after a finished list last changed. */
export function visible(list: List, now: number): boolean {
  if (list.items.length === 0) return false;
  if (list.items.some(item => rank[item.status] !== 0)) return true;
  // A partial inventory cannot prove that every item has closed.
  return list.partial || list.at === 0 || now - list.at < retire_after;
}

export function window(list: List, limit = 5, rows = Infinity): Window {
  let run = -1;
  const items: Row[] = list.items.map((item, i) => {
    if (i === 0 || item.group !== list.items[i - 1].group) run++;
    return { ...item, run };
  });
  const headings = run > 0;
  // Stable sorting keeps the provider's order within done, active and upcoming.
  items.sort((a, b) => rank[a.status] - rank[b.status]);
  const total = items.length,
    done = items.filter(item => item.status === "done").length;
  let size = Math.max(0, Math.min(5, limit, total));
  const active = items.findIndex(item => rank[item.status] === 1),
    upcoming = items.findIndex(item => item.status === "pending");
  const focus = active >= 0 ? active : upcoming >= 0 ? upcoming : total;
  // Active and upcoming work win; only spare rows show finished context.
  for (;;) {
    const start = Math.max(0, Math.min(focus, total - size));
    const selected = items.slice(start, start + size);
    let more_pending = upcoming < 0 ? 0 : Math.max(0, total - Math.max(upcoming, start + size));
    if (size > 0 && more_pending === 1) {
      selected.push(items[total - 1]);
      more_pending = 0;
    }
    const active_runs = new Set(selected.filter(item => rank[item.status] === 1).map(item => item.run));
    const omitted_done = new Map<number, { count: number; item: Row }>();
    for (let i = 0; i < start; i++) {
      const item = items[i];
      if (item.status !== "done" || !active_runs.has(item.run)) continue;
      const omitted = omitted_done.get(item.run);
      if (omitted) omitted.count++;
      else omitted_done.set(item.run, { count: 1, item });
    }
    const context = [...omitted_done.values()].filter(omitted => omitted.count === 1).map(omitted => omitted.item);
    selected.unshift(...context);
    const by_run = new Map<number, Group>();
    for (const item of selected) {
      let group = by_run.get(item.run);
      if (!group) {
        const omitted = omitted_done.get(item.run)?.count ?? 0;
        group = { name: headings ? item.group : "", items: [], more_done: omitted > 1 ? omitted : 0 };
        by_run.set(item.run, group);
      }
      group.items.push(item);
    }
    const groups = [...by_run.values()];
    const height =
      selected.length +
      groups.filter(group => group.name.length > 0).length +
      groups.filter(group => group.more_done > 1).length +
      Number(more_pending > 1);
    if (height <= rows || size === 0) return { items: selected, groups, total, done, more_pending, rows: height };
    size--;
  }
}
