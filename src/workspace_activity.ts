//! The workspace auto-order: a pause-adjusted activity clock, the active and
//! stale groups, fade steps, the move rule and the auto-archive decision.
import type { Attention, State } from "./agents";

/** The auto-order settings, in minutes; `archive_after` null means Off. */
export type Settings = { enabled: boolean; pause_after: number; stale_after: number; archive_after: number | null };
export const defaults: Settings = { enabled: false, pause_after: 5, stale_after: 10, archive_after: 480 };
export const minute_ms = 60_000;
/** Each tick adds at most this much, so a sleep or a stalled loop counts as paused. */
export const tick_cap_ms = 2000;
/** With archive Off, the fade spans this long past "stale after". */
const off_fade = 480;
const keys = {
  enabled: "workspace_auto_order",
  pause_after: "workspace_pause_after",
  stale_after: "workspace_stale_after",
  archive_after: "workspace_archive_after",
} as const;
const minutes = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 1 ? (value as number) : null);
/** The settings in `settings.json`: each malformed key takes its default,
 * then thresholds out of order all take theirs. */
export function parse(raw: Record<string, unknown>): Settings {
  const archive = raw[keys.archive_after];
  const s: Settings = {
    enabled: raw[keys.enabled] === true,
    pause_after: minutes(raw[keys.pause_after]) ?? defaults.pause_after,
    stale_after: minutes(raw[keys.stale_after]) ?? defaults.stale_after,
    archive_after: archive === "off" ? null : (minutes(archive) ?? defaults.archive_after),
  };
  if (valid(s)) return s;
  return { ...defaults, enabled: s.enabled };
}
/** Whether the thresholds are in order: pause, then stale, then archive (unless Off). */
export function valid(s: Settings): boolean {
  return (
    minutes(s.pause_after) !== null &&
    minutes(s.stale_after) !== null &&
    (s.archive_after === null || minutes(s.archive_after) !== null) &&
    s.pause_after < s.stale_after &&
    (s.archive_after === null || s.stale_after < s.archive_after)
  );
}
export function toFile(s: Settings): Record<string, unknown> {
  return {
    [keys.enabled]: s.enabled,
    [keys.pause_after]: s.pause_after,
    [keys.stale_after]: s.stale_after,
    [keys.archive_after]: s.archive_after ?? "off",
  };
}
/** A clock that only runs while someone works: it stops "pause after" past
 * the last activity anywhere, and a long gap between ticks adds at most the
 * tick cap. Readings are milliseconds. */
export class Clock {
  clock = 0;
  /** No auto-archive before this reading. */
  guard = 0;
  /** Real time of the last activity anywhere; null after a start, so downtime counts as paused. */
  last_activity: number | null = null;
  constructor(public last_tick: number) {}
  activity(now: number) {
    this.last_activity = now;
  }
  advance(now: number, pause_after_ms: number) {
    const elapsed = Math.min(Math.max(0, now - this.last_tick), tick_cap_ms),
      open = this.last_activity === null ? 0 : Math.max(0, this.last_activity + pause_after_ms - this.last_tick);
    this.clock += Math.min(elapsed, open);
    this.last_tick = now;
  }
  paused(now: number, pause_after_ms: number) {
    return this.last_activity === null || now >= this.last_activity + pause_after_ms;
  }
}
export type Group = "active" | "stale";
export type Step = 0 | 1 | 2 | 3 | 4 | 5;
export const steps = 5;
/** The idle times, in ms, each fade step starts at: geometric from "stale
 * after" to the fade's end, so early steps come closer together. */
export function boundaries(s: Settings): number[] {
  const start = s.stale_after,
    end = s.archive_after ?? s.stale_after + off_fade,
    ratio = end / start;
  return [0, 1, 2, 3].map(k => start * ratio ** (k / 4) * minute_ms).concat(end * minute_ms);
}
/** The fade step for a stale workspace idle `idle_ms`; 0 while not stale. */
export function step(idle_ms: number, s: Settings): Step {
  if (idle_ms <= s.stale_after * minute_ms) return 0;
  const from = boundaries(s);
  let n = 1;
  while (n < steps && idle_ms >= from[n]) n++;
  return n as Step;
}
export type Item = { id: number; archived: boolean; active_at: number; group: Group };
/** The fade step viewers draw a workspace with: 0 unless auto-order is on and it's stale. */
export function staleStep(w: Item, clock: number, s: Settings): Step {
  return s.enabled && !w.archived && w.group === "stale" ? step(clock - w.active_at, s) : 0;
}
/** Mouse and focus reports a terminal sends on its own. */
const reports = /\x1b\[(?:<\d+;\d+;\d+[Mm]|M[\s\S]{3}|\d+;\d+;\d+M|I|O)/g;
/** Whether pane input is typing: anything but mouse and focus reports. */
export function typing(data: string): boolean {
  return data.replace(reports, "") !== "";
}
/** Sets the group each workspace's idle time gives it and orders `items`:
 * active ones as they were, a stale one waking at the end of them; stale
 * ones by idle time; archived ones last. Whether the order or a group changed. */
export function regroup(items: Item[], clock: number, s: Settings): boolean {
  const stale_ms = s.stale_after * minute_ms,
    woke = new Set<Item>();
  let changed = false;
  for (const w of items) {
    if (w.active_at === 0) w.active_at = clock;
    if (w.archived) continue;
    const group: Group = clock - w.active_at > stale_ms ? "stale" : "active";
    if (group === w.group) continue;
    if (group === "active") woke.add(w);
    w.group = group;
    changed = true;
  }
  const live = items.filter(w => !w.archived);
  const next = [
    ...live.filter(w => w.group === "active" && !woke.has(w)),
    ...live.filter(w => woke.has(w)),
    ...live.filter(w => w.group === "stale").sort((a, b) => b.active_at - a.active_at),
    ...items.filter(w => w.archived),
  ];
  for (const [i, w] of next.entries())
    if (items[i] !== w) {
      items[i] = w;
      changed = true;
    }
  return changed;
}
/** Sets each unarchived workspace's group from its idle time without moving
 * any, for while auto-order is off and the moment it's switched on. */
export function resync(items: Item[], clock: number, s: Settings): void {
  const stale_ms = s.stale_after * minute_ms;
  for (const w of items) {
    if (w.active_at === 0) w.active_at = clock;
    if (!w.archived) w.group = clock - w.active_at > stale_ms ? "stale" : "active";
  }
}
const stale = (w: Item) => !w.archived && w.group === "stale";
/** A workspace as a viewer knows it: stale while it shows a fade step. */
export const shown = (w: { id: number; archived: boolean; stale_step: number }): Item => ({
  id: w.id,
  archived: w.archived,
  active_at: 0,
  group: w.stale_step > 0 ? "stale" : "active",
});
/** Whether moving `target` above `before` (last when it's `target`) keeps the
 * groups: a stale workspace stays put, and none lands past the first stale
 * one. The slot right after the last active one is in the active group. */
export function moveAllowed(items: Item[], target: number, before: number, enabled: boolean): boolean {
  if (!enabled) return true;
  const moved = items.find(w => w.id === target);
  if (!moved) return true;
  if (stale(moved)) return false;
  const rest = items.filter(w => w !== moved),
    at = before === target ? rest.length : rest.findIndex(w => w.id === before),
    first = rest.findIndex(stale);
  return at < 0 || first < 0 || at <= first;
}
/** Whether an agent is processing a turn: not waiting on an answer, blocked,
 * paused for background work or not yet prompted. */
export function working(agent: { state: State; paused: boolean; attention: Attention }): boolean {
  return agent.state === "working" && !agent.paused && agent.attention !== "needs_input";
}
/** Whether an agent waits on the user: blocked or asking. */
export function waiting(agent: { state: State; attention: Attention }): boolean {
  return agent.state === "blocked" || agent.attention === "needs_input";
}
export type Blocker =
  | "last-workspace"
  | "on-screen"
  | "waiting-agent"
  | "process-list-unavailable"
  | "process-list-partial"
  | "running-process"
  | "served-link";
/** Whether a workspace is due for auto-archive, before its blockers. */
export function due(w: Item, clock: number, guard: number, s: Settings): boolean {
  return (
    s.enabled &&
    s.archive_after !== null &&
    !w.archived &&
    w.group === "stale" &&
    clock - w.active_at >= s.archive_after * minute_ms &&
    clock >= guard
  );
}
export type Inventory = { processes: number; available: boolean; partial: boolean };
/** What holds a due workspace back. The costly facts are read only when the
 * cheaper ones don't already block. */
export type Facts = {
  others: boolean;
  on_screen: boolean;
  waiting: boolean;
  inventory: () => Inventory;
  served: () => boolean;
};
/** The first reason a due workspace can't be archived, or null. */
export function blocker(facts: Facts): Blocker | null {
  if (!facts.others) return "last-workspace";
  if (facts.on_screen) return "on-screen";
  if (facts.waiting) return "waiting-agent";
  const inventory = facts.inventory();
  if (!inventory.available) return "process-list-unavailable";
  if (inventory.partial) return "process-list-partial";
  if (inventory.processes > 0) return "running-process";
  if (facts.served()) return "served-link";
  return null;
}
/** Remembers what was logged for each workspace, so a blocker or error is
 * logged once rather than on every check. */
export class Reported {
  private last = new Map<number, string>();
  /** Whether `reason` is new for workspace `id`. */
  report(id: number, reason: string): boolean {
    if (this.last.get(id) === reason) return false;
    this.last.set(id, reason);
    return true;
  }
  clear(id: number) {
    this.last.delete(id);
  }
}
/** The settings last applied to the archive guard. */
export type Applied = { enabled: boolean; archive_after: number | null };
/** The clock as saved; `applied.archive_after` 0 means Off. */
export type Saved = { clock: number; guard: number; applied: { enabled: boolean; archive_after: number } | null };
const reading = (value: unknown) => (Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : 0);
export function save(r: { activity: Clock; applied: Applied | null }): Saved {
  const applied = r.applied && { enabled: r.applied.enabled, archive_after: r.applied.archive_after ?? 0 };
  return { clock: r.activity.clock, guard: r.activity.guard, applied };
}
/** Takes up a saved clock; anything missing or malformed starts over at 0. */
export function restore(r: { activity: Clock; applied: Applied | null }, saved: unknown): void {
  const s = saved && typeof saved === "object" ? (saved as Record<string, unknown>) : {},
    applied = s.applied && typeof s.applied === "object" ? (s.applied as Record<string, unknown>) : null;
  r.activity.clock = reading(s.clock);
  r.activity.guard = reading(s.guard);
  r.applied =
    applied && typeof applied.enabled === "boolean"
      ? { enabled: applied.enabled, archive_after: minutes(applied.archive_after) }
      : null;
}
/** A saved `active_at`; 0, first seen, when missing or malformed. */
export const activeAt = reading;
/** A saved group; active when missing or unknown. */
export const group = (value: unknown): Group => (value === "stale" ? "stale" : "active");
/** The new archive guard when `next` switches auto-order on, lowers "archive
 * after" or turns it on from Off; otherwise null, keeping the guard. */
export function armGuard(applied: Applied | null, next: Settings, clock: number): number | null {
  if (!next.enabled || next.archive_after === null) return null;
  const arm =
    applied === null ||
    !applied.enabled ||
    applied.archive_after === null ||
    next.archive_after < applied.archive_after;
  return arm ? clock + next.archive_after * minute_ms : null;
}
