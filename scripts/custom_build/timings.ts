import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunState } from "./config";

/** A run's timings so far, kept in its run state so a `continue` goes on counting.
 * `activeMs` counts only the time the tool was running: not the time the run sat
 * stopped, nor the time a question waited for its answer. */
export type Timing = {
  activeMs: number;
  /** Finished items: `fetch`, `rebase:<branch>`, `merge:<patch>` (without its harness
   * calls), `step:<name>`, `after-build`, `push`. An item run again adds to its time. */
  items: Record<string, number>;
  /** Each harness call's duration, in order. */
  harnessMs: number[];
  /** Items started and not ended yet: `activeMs` at their start, so an item a stop
   * interrupted takes the active time on both sides of it. */
  open?: Record<string, number>;
};
export type Command = "rebuild" | "rebase";
export type HistoryRun = {
  command: Command;
  finishedAt: string;
  /** A rolled-back run: its finished items feed the estimates, but it is never the last run. */
  partial: boolean;
  activeMs: number;
  items: Record<string, number>;
  harnessMs: number[];
};
export type History = { version: 1; runs: HistoryRun[] };
export type Estimate = {
  /** Done durations plus the estimates of what is left; null without history. */
  totalMs: number | null;
  leftMs: number | null;
  /** How much faster than the last finished run at the same point; negative is behind. */
  aheadMs: number | null;
  last: HistoryRun | null;
};

export const historyPath = (dir: string) => join(dir, "timings.json");
const keep = 20;
/** How many recorded durations an estimate takes the median of. */
const window = 5;

/** The clock reading the run's active time was last brought up to; null while paused.
 * Per process: a run loaded by `continue` starts counting at its first tick. */
const ticks = new WeakMap<RunState, number | null>();
const timing = (run: RunState): Timing => (run.timing ??= { activeMs: 0, items: {}, harnessMs: [] });

/** Adds the time since the last tick to the run's active time. */
export function tick(run: RunState, nowMs: number): void {
  const t = timing(run),
    last = ticks.get(run);
  if (last === null) return;
  if (last !== undefined) t.activeMs += Math.max(0, nowMs - last);
  ticks.set(run, nowMs);
}
/** Stops counting, for a wait on the user, until `resume`. */
export function pause(run: RunState, nowMs: number): void {
  tick(run, nowMs);
  ticks.set(run, null);
}
export function resume(run: RunState, nowMs: number): void {
  timing(run);
  ticks.set(run, nowMs);
}
export function startItem(run: RunState, key: string, nowMs: number): void {
  tick(run, nowMs);
  const t = timing(run);
  (t.open ??= {})[key] = t.activeMs;
}
/** Ends an item and adds its active time, less `exceptMs` (harness calls inside it),
 * to it; returns that time (0 for an item never started). */
export function endItem(run: RunState, key: string, nowMs: number, exceptMs = 0): number {
  tick(run, nowMs);
  const t = timing(run),
    start = t.open?.[key];
  if (start === undefined) return 0;
  delete t.open![key];
  if (!Object.keys(t.open!).length) delete t.open;
  const ms = Math.max(0, t.activeMs - start - exceptMs);
  t.items[key] = (t.items[key] ?? 0) + ms;
  return ms;
}

/** Keeps a finished harness call's duration. */
export function harnessCall(run: RunState, ms: number): void {
  timing(run).harnessMs.push(ms);
}

const durations = (v: unknown): v is number[] =>
  Array.isArray(v) && v.every(n => typeof n === "number" && Number.isFinite(n));
/** Whether a recorded run has the fields an estimate reads. */
function wellFormed(r: unknown): r is HistoryRun {
  const run = r as Record<string, unknown> | null;
  return (
    typeof run === "object" &&
    run !== null &&
    (run.command === "rebuild" || run.command === "rebase") &&
    typeof run.finishedAt === "string" &&
    typeof run.partial === "boolean" &&
    typeof run.activeMs === "number" &&
    typeof run.items === "object" &&
    run.items !== null &&
    !Array.isArray(run.items) &&
    durations(Object.values(run.items)) &&
    durations(run.harnessMs)
  );
}
/** The recorded runs, oldest first; a missing or unreadable file is no history,
 * and a run entry an estimate can't read is left out. */
export function loadHistory(dir: string): History {
  const empty: History = { version: 1, runs: [] },
    path = historyPath(dir);
  if (!existsSync(path)) return empty;
  try {
    const h = JSON.parse(readFileSync(path, "utf8"));
    return h?.version === 1 && Array.isArray(h.runs) ? { version: 1, runs: h.runs.filter(wellFormed) } : empty;
  } catch {
    return empty;
  }
}
/** Appends a run, keeping the last 20. */
export function record(dir: string, run: HistoryRun): void {
  const h = loadHistory(dir);
  h.runs = [...h.runs, run].slice(-keep);
  mkdirSync(dir, { recursive: true });
  const path = historyPath(dir),
    temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(h, null, 2) + "\n");
  renameSync(temporary, path);
}
/** The history entry for a run as it is now. */
export function historyRun(run: RunState, command: Command, partial: boolean, finishedAt: Date): HistoryRun {
  const t = timing(run);
  return {
    command,
    finishedAt: finishedAt.toISOString(),
    partial,
    activeMs: t.activeMs,
    items: { ...t.items },
    harnessMs: [...t.harnessMs],
  };
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b),
    mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}
/** `merge:a` belongs to `merge`; an item without a colon is its own stage. */
const stage = (key: string) => key.split(":")[0];
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** How long a run of `command` takes, from earlier runs of it: each planned item
 * not done yet is the median of its last 5 recorded durations, an item never seen
 * the median of its stage's items in the last 5 runs, a stage never seen nothing.
 * Rolled-back runs count for the items they finished. */
export function estimate(
  h: History,
  command: Command,
  planned: string[],
  done: Record<string, number>,
  activeMs: number,
): Estimate {
  const runs = h.runs.filter(r => r.command === command);
  if (!runs.length) return { totalMs: null, leftMs: null, aheadMs: null, last: null };
  const recent = runs.slice(-window),
    left = planned
      .filter(key => !(key in done))
      .map(key => {
        const own = runs.filter(r => key in r.items).map(r => r.items[key]);
        if (own.length) return median(own.slice(-window))!;
        const s = stage(key);
        return (
          median(
            recent.flatMap(r =>
              Object.entries(r.items)
                .filter(([k]) => stage(k) === s)
                .map(([, v]) => v),
            ),
          ) ?? 0
        );
      }),
    totalMs = sum(Object.values(done)) + sum(left),
    last = runs.findLast(r => !r.partial) ?? null,
    shared = last ? Object.keys(done).filter(key => key in last.items) : [];
  return {
    totalMs,
    leftMs: Math.max(0, totalMs - activeMs),
    aheadMs: last ? sum(shared.map(key => last.items[key])) - sum(shared.map(key => done[key])) : null,
    last,
  };
}

/** The median of the last 5 harness calls in runs of `command`; null without any.
 * A call isn't predicted: the live view adds this when one starts. */
export function harnessMedian(h: History, command: Command): number | null {
  return median(
    h.runs
      .filter(r => r.command === command)
      .flatMap(r => r.harnessMs)
      .slice(-window),
  );
}
