import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RunState } from "./config";
import {
  endItem,
  estimate,
  harnessMedian,
  historyPath,
  loadHistory,
  pause,
  record,
  resume,
  startItem,
  tick,
  typical,
  type History,
  type HistoryRun,
} from "./timings";

const s = 1000;
let at = Date.parse("2026-11-01T10:00:00Z");
function past(items: Record<string, number>, o: Partial<HistoryRun> = {}): HistoryRun {
  return {
    command: "rebuild",
    finishedAt: new Date((at += 60 * s)).toISOString(),
    partial: false,
    activeMs: Object.values(items).reduce((a, b) => a + b, 0),
    items,
    harnessMs: [],
    ...o,
  };
}
const history = (runs: HistoryRun[]): History => ({ version: 1, runs });
const merges = [10, 20, 30, 40, 50, 60].map(n => past({ fetch: 5 * s, "merge:a": n * s }));

test("estimate uses the median of the last 5 runs per item", () => {
  const e = estimate(history(merges), "rebuild", ["fetch", "merge:a"], {}, 0);
  expect(e.totalMs).toBe(5000 + 40000);
  expect(e.leftMs).toBe(45000);
});

test("an unseen item takes its stage's median", () => {
  const runs = [past({ "merge:a": 10 * s, "merge:b": 30 * s }), past({ "merge:a": 20 * s, "merge:c": 90 * s })],
    e = estimate(history(runs), "rebuild", ["merge:a", "merge:new", "step:test"], {}, 0);
  // merge:a: median(10, 20) = 15; merge:new: median(10, 30, 20, 90) = 25; step: never seen, nothing.
  expect(e.totalMs).toBe(15 * s + 25 * s);
});

test("done items count as they took, and left is what remains of the total", () => {
  const e = estimate(history(merges), "rebuild", ["fetch", "merge:a"], { fetch: 7 * s }, 9 * s);
  expect(e.totalMs).toBe(7 * s + 40 * s);
  expect(e.leftMs).toBe(38 * s);
  expect(estimate(history(merges), "rebuild", ["fetch"], { fetch: 7 * s }, 99 * s).leftMs).toBe(0);
});

test("no history means no estimate", () => {
  expect(estimate(history([]), "rebuild", ["fetch", "merge:a"], { fetch: 1000 }, 1000)).toEqual({
    totalMs: null,
    leftMs: null,
    aheadMs: null,
    last: null,
  });
  // Another command's runs are no history for this one.
  expect(estimate(history(merges), "rebase", ["fetch"], {}, 0).totalMs).toBeNull();
});

test("ahead compares with the last finished run of the same command", () => {
  const last = past({ fetch: 6000, "merge:a": 20000, "merge:b": 9000 }),
    runs = [
      past({ fetch: 1000, "merge:a": 1000 }),
      last,
      past({ fetch: 1, "merge:a": 1 }, { partial: true }),
      past({ fetch: 2, "merge:a": 2 }, { command: "rebase" }),
    ],
    e = estimate(history(runs), "rebuild", ["fetch", "merge:a", "merge:b"], { fetch: 4000, "merge:a": 18000 }, 22000);
  expect(e.last).toEqual(last);
  expect(e.aheadMs).toBe(4000);
  // A done item the last run lacked doesn't count either way.
  expect(estimate(history(runs), "rebuild", [], { fetch: 4000, "merge:new": 50000 }, 0).aheadMs).toBe(2000);
});

test("rolled-back runs an older tool recorded are no history", () => {
  const e = estimate(history([past({ fetch: 3 * s }, { partial: true })]), "rebuild", ["fetch"], {}, 0);
  expect(e).toEqual({ totalMs: null, leftMs: null, aheadMs: null, last: null });
  expect(harnessMedian(history([past({}, { partial: true, harnessMs: [3 * s] })]), "rebuild")).toBeNull();
});

const min = 60 * s;
test("a duration far above its peers is an outlier; small or close ones aren't", () => {
  expect(typical([])).toEqual([]);
  expect(typical([90 * min])).toEqual([true]);
  // A step a laptop slept through.
  expect(typical([2 * min, 3 * min, 95 * min, 2 * min])).toEqual([true, true, false, true]);
  // With two, the long one is the odd one out.
  expect(typical([95 * min, 3 * min])).toEqual([false, true]);
  // Three times as long but only seconds more: noise, not sleep.
  expect(typical([10 * s, 40 * s, 12 * s])).toEqual([true, true, true]);
});

test("estimates leave out outliers, and the last run is the latest without one", () => {
  const usual = past({ fetch: 1 * min, "step:test": 4 * min }),
    slept = past({ fetch: 1 * min, "step:test": 120 * min }),
    e = estimate(
      history([usual, past({ fetch: 1 * min, "step:test": 5 * min }), slept]),
      "rebuild",
      ["step:test"],
      {},
      0,
    );
  expect(e.totalMs).toBe(4.5 * min);
  expect(e.last?.items["step:test"]).toBe(5 * min);
  // The stage median for an unseen item, and the harness median, likewise.
  expect(estimate(history([usual, slept]), "rebuild", ["step:new"], {}, 0).totalMs).toBe(4 * min);
  expect(harnessMedian(history([past({}, { harnessMs: [2 * min, 3 * min, 200 * min] })]), "rebuild")).toBe(2.5 * min);
});

test("history keeps the last 20 runs and survives a corrupt file", () => {
  const dir = mkdtempSync(join(tmpdir(), "timings-"));
  expect(loadHistory(dir)).toEqual({ version: 1, runs: [] });
  for (let i = 0; i < 25; i++) record(dir, past({ fetch: i }));
  const kept = loadHistory(dir).runs;
  expect(kept.length).toBe(20);
  expect(kept.map(r => r.items.fetch)).toEqual([...Array(20).keys()].map(i => i + 5));
  writeFileSync(historyPath(dir), "{");
  expect(loadHistory(dir)).toEqual({ version: 1, runs: [] });
  writeFileSync(historyPath(dir), JSON.stringify({ version: 2, runs: [past({ fetch: 1 })] }));
  expect(loadHistory(dir)).toEqual({ version: 1, runs: [] });
});

test("malformed history entries are left out, the rest kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "timings-"));
  const good = past({ fetch: 7 });
  writeFileSync(
    historyPath(dir),
    JSON.stringify({
      version: 1,
      runs: [
        { command: "rebuild", finishedAt: "x", partial: false, activeMs: 1, harnessMs: [] },
        good,
        { ...good, items: { fetch: "slow" } },
        { ...good, command: "deploy" },
        { ...good, harnessMs: null },
        null,
      ],
    }),
  );
  expect(loadHistory(dir).runs).toEqual([good]);
  expect(estimate(loadHistory(dir), "rebuild", ["fetch"], {}, 0).totalMs).toBe(7);
});

test("the median harness call takes the last 5 calls of the command", () => {
  expect(harnessMedian(history([]), "rebuild")).toBeNull();
  const h = history([
    past({}, { harnessMs: [100 * s, 1 * s] }),
    past({}, { command: "rebase", harnessMs: [500 * s] }),
    past({}, { harnessMs: [2 * s, 3 * s, 4 * s] }),
    past({}, { harnessMs: [5 * s] }),
  ]);
  expect(harnessMedian(h, "rebuild")).toBe(3 * s);
  expect(harnessMedian(h, "rebase")).toBe(500 * s);
});

test("pause excludes the waiting time", () => {
  const run = {} as RunState;
  tick(run, 0);
  pause(run, 1000);
  resume(run, 61000);
  tick(run, 62000);
  expect(run.timing?.activeMs).toBe(2000);
  // Ticks while paused add nothing.
  pause(run, 63000);
  tick(run, 90000);
  resume(run, 100000);
  tick(run, 100500);
  expect(run.timing?.activeMs).toBe(3500);
});

test("a run loaded in a new process counts from its first tick", () => {
  const run = { timing: { activeMs: 5000, items: {}, harnessMs: [] } } as unknown as RunState;
  tick(run, 1_000_000);
  tick(run, 1_002_000);
  expect(run.timing?.activeMs).toBe(7000);
});

test("an item takes the active time between its start and end, across a stop", () => {
  const run = {} as RunState;
  tick(run, 0);
  startItem(run, "merge:a", 1000);
  pause(run, 3000);
  resume(run, 50000);
  expect(endItem(run, "merge:a", 52000)).toBe(4000);
  expect(run.timing?.items["merge:a"]).toBe(4000);
  // The run state is saved and stopped; `continue` loads it in a new process.
  startItem(run, "merge:b", 53000);
  const loaded = JSON.parse(JSON.stringify(run)) as RunState;
  tick(loaded, 900000);
  expect(endItem(loaded, "merge:b", 902000)).toBe(2000);
  // An item run again adds to its time.
  startItem(loaded, "merge:b", 903000);
  expect(endItem(loaded, "merge:b", 904000)).toBe(1000);
  expect(loaded.timing?.items["merge:b"]).toBe(3000);
  // An item never started takes nothing.
  expect(endItem(loaded, "push", 905000)).toBe(0);
  expect(loaded.timing?.items.push).toBeUndefined();
});

test("an item leaves out the harness time inside it", () => {
  const run = {} as RunState;
  tick(run, 0);
  startItem(run, "merge:a", 0);
  expect(endItem(run, "merge:a", 50000, 45000)).toBe(5000);
  startItem(run, "merge:b", 50000);
  expect(endItem(run, "merge:b", 51000, 9000)).toBe(0);
});
