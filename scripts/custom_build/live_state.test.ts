import { expect, test } from "bun:test";
import type { Config, RunState } from "./config";
import type { LiveEvent, Stage } from "./live_events";
import { apply, fromRun, initial, item, type LiveState } from "./live_state";
import type { Estimate } from "./timings";

const noEstimate: Estimate = { totalMs: null, leftMs: null, aheadMs: null, last: null };
function begin(
  items: Partial<Record<Stage, string[]>>,
  o: Partial<Extract<LiveEvent, { t: "begin" }>> = {},
): LiveEvent {
  return {
    t: "begin",
    command: "rebuild",
    branch: "integration",
    upstream: { name: "upstream/main", tip: "170454d", newCommits: 7 },
    stages: ["fetch", "merge", "verify"],
    items,
    estimate: noEstimate,
    links: {},
    harness: "claude",
    harnessMedianMs: null,
    elapsedMs: 0,
    ...o,
  };
}
const play = (events: [LiveEvent, number][], s: LiveState = initial()) =>
  events.reduce((state, [e, at]) => apply(state, e, at), s);
const harness = (state: "start" | "end", id: string, o: Partial<Extract<LiveEvent, { t: "harness" }>> = {}) =>
  ({ t: "harness", state, stage: "merge", id, attempt: 1, limit: 3, ...o }) as LiveEvent;

test("items move from pending to running to done with their clock", () => {
  const s = play([
    [begin({ merge: ["a", "b"] }), 0],
    [{ t: "stage", stage: "merge", state: "start" }, 500],
    [{ t: "item", stage: "merge", id: "a", state: "start" }, 1000],
    [{ t: "item", stage: "merge", id: "a", state: "done", outcome: "merged" }, 4000],
  ]);
  expect(item(s, "merge", "a")).toMatchObject({ state: "done", outcome: "merged", ms: 3000 });
  expect(item(s, "merge", "b")).toMatchObject({ state: "pending", outcome: null, ms: null });
  expect(s.stages.find(st => st.name === "merge")?.state).toBe("running");
  expect(s.stages.find(st => st.name === "verify")?.state).toBe("pending");
});

test("the reducer leaves the state it was given alone", () => {
  const before = play([[begin({ merge: ["a"] }), 0]]),
    copy = structuredClone(before);
  apply(before, { t: "item", stage: "merge", id: "a", state: "start" }, 10);
  apply(before, { t: "log", text: "x\n" }, 10);
  expect(before).toEqual(copy);
});

test("harness tokens add up per item and in total", () => {
  const s = play([
    [begin({ merge: ["a", "b"] }), 0],
    [harness("start", "b"), 10],
    [harness("end", "b", { ok: false, reason: "markers", usage: { input: 100, output: 10 } }), 20],
    [harness("start", "b", { attempt: 2 }), 30],
    [harness("end", "b", { attempt: 2, ok: true, usage: { input: 50, output: 5 } }), 40],
  ]);
  expect(item(s, "merge", "b")?.tokens).toEqual({ input: 150, output: 15 });
  expect(item(s, "merge", "b")?.tries.map(t => [t.attempt, t.ok, t.reason])).toEqual([
    [1, false, "markers"],
    [2, true, null],
  ]);
  expect(s.harness).toMatchObject({ calls: 2, running: 0, input: 150, output: 15, unknown: 0 });
  expect(s.harnessKind).toBe("claude");
});

test("a running harness call shows on its item and calls without usage count as unknown", () => {
  let s = play([
    [begin({ merge: ["a"] }), 0],
    [harness("start", "a", { files: ["src/x.ts"] }), 100],
  ]);
  expect(s.harness).toMatchObject({ calls: 1, running: 1 });
  expect(item(s, "merge", "a")?.harness).toMatchObject({ attempt: 1, limit: 3, files: ["src/x.ts"], startedMs: 100 });
  s = apply(s, harness("end", "a", { ok: true, usage: null }), 900);
  expect(s.harness).toMatchObject({ calls: 1, running: 0, unknown: 1 });
  expect(item(s, "merge", "a")?.harness).toBeNull();
  expect(item(s, "merge", "a")?.tokens).toBeNull();
});

test("rejected tries count as retries", () => {
  const s = play([
    [begin({ merge: ["a"], verify: ["test"] }), 0],
    [{ t: "retry", stage: "merge", id: "a", why: "harness", detail: "conflict markers remain in x" }, 10],
    [{ t: "retry", stage: "verify", id: "test", why: "flaky", detail: "test failed; running it once more" }, 20],
  ]);
  expect(s.retries).toBe(2);
  expect(s.retriesBy).toEqual({ flaky: 1, harness: 1, upstream: 0 });
  expect(item(s, "merge", "a")?.retries).toEqual([{ why: "harness", detail: "conflict markers remain in x" }]);
});

test("activity keeps the latest line", () => {
  let s = play([
    [begin({}), 0],
    [{ ...harness("start", "a"), state: "activity", text: "Edit src/x.ts" } as LiveEvent, 10],
  ]);
  expect(s.activity).toBe("Edit src/x.ts");
  for (let i = 0; i < 600; i++) s = apply(s, { t: "log", text: `line ${i}\n` }, 20);
  expect(s.log.length).toBe(500);
  expect(s.log[0]).toBe("line 100");
  expect(s.log.at(-1)).toBe("line 599");
  expect(s.activity).toBe("line 599");
});

test("log text split across events joins into lines", () => {
  const s = play([
    [begin({}), 0],
    [{ t: "log", text: "one\ntw" }, 1],
    [{ t: "log", text: "o\nthree" }, 2],
    [{ t: "log", text: "\n\n" }, 3],
  ]);
  expect(s.log).toEqual(["one", "two", "three", ""]);
  expect(s.activity).toBe("three");
});

test("items and stages not announced at the start are added when they appear", () => {
  const s = play([
    [begin({}, { stages: ["fetch"] }), 0],
    [{ t: "stage", stage: "rebase", state: "start" }, 10],
    [{ t: "item", stage: "rebase", id: "mine", state: "skipped", outcome: "left-alone", detail: "checked out" }, 20],
  ]);
  expect(s.stages.map(st => st.name)).toEqual(["fetch", "rebase"]);
  expect(item(s, "rebase", "mine")).toMatchObject({ state: "skipped", outcome: "left-alone", detail: "checked out" });
});

test("stages take their running time, or the time a replay gives them", () => {
  const s = play([
    [begin({}, { elapsedMs: 5000 }), 1000],
    [{ t: "stage", stage: "fetch", state: "start" }, 1000],
    [{ t: "stage", stage: "fetch", state: "done", summary: "7 upstream commits, 2 patches" }, 3500],
    [{ t: "stage", stage: "merge", state: "start" }, 3500],
    [{ t: "stage", stage: "merge", state: "done", ms: 42 }, 9000],
  ]);
  expect(s.stages.find(st => st.name === "fetch")).toMatchObject({
    state: "done",
    ms: 2500,
    summary: "7 upstream commits, 2 patches",
  });
  expect(s.stages.find(st => st.name === "merge")).toMatchObject({ state: "done", ms: 42 });
  expect(s.clock).toEqual({ activeMs: 5000, sinceMs: 1000 });
});

test("the fetch can name the upstream tip it fetched", () => {
  const s = play([
    [begin({}), 0],
    [
      {
        t: "stage",
        stage: "fetch",
        state: "done",
        upstream: { name: "upstream/main", tip: "abcdef1", newCommits: 3 },
      },
      10,
    ],
  ]);
  expect(s.upstream).toEqual({ name: "upstream/main", tip: "abcdef1", newCommits: 3 });
});

test("a harness call grows the estimate by the median call until the next estimate", () => {
  const estimate: Estimate = { totalMs: 60_000, leftMs: 50_000, aheadMs: 0, last: null };
  let s = play([
    [begin({ merge: ["a"] }, { estimate, harnessMedianMs: 30_000 }), 0],
    [harness("start", "a"), 10],
  ]);
  expect(s.estimate).toMatchObject({ totalMs: 90_000, leftMs: 80_000 });
  // A new estimate from the run still counts the call that is running.
  s = apply(s, { t: "estimate", estimate: { ...estimate, totalMs: 70_000, leftMs: 40_000 } }, 20);
  expect(s.estimate).toMatchObject({ totalMs: 100_000, leftMs: 70_000 });
  s = apply(s, harness("end", "a", { ok: true }), 30);
  expect(s.estimate).toMatchObject({ totalMs: 70_000, leftMs: 40_000 });
  // Rebase items are timed with their harness calls in them: no extra.
  s = apply(s, harness("start", "mine", { stage: "rebase" }), 40);
  expect(s.estimate).toMatchObject({ totalMs: 70_000, leftMs: 40_000 });
});

test("without history a harness call adds nothing to the estimate", () => {
  const s = play([
    [begin({ merge: ["a"] }, { harnessMedianMs: 30_000 }), 0],
    [harness("start", "a"), 10],
  ]);
  expect(s.estimate).toEqual(noEstimate);
});

test("the end keeps the outcome", () => {
  const s = play([
    [begin({}), 0],
    [{ t: "end", ok: false, code: 2, headline: "stopped: merge conflict in b", lines: ["  x"], report: "/r.md" }, 10],
  ]);
  expect(s.ended).toEqual({
    ok: false,
    code: 2,
    headline: "stopped: merge conflict in b",
    lines: ["  x"],
    report: "/r.md",
  });
});

const config: Config = {
  version: 1,
  upstream: { repo: "tals/corgi", branch: "main" },
  branch: "integration",
  patches: [],
  retired: [],
  harness: { command: ["h"], attempts: 2, kind: "codex" },
};
function stopped(o: Partial<RunState> = {}): RunState {
  return {
    startedAt: "2026-11-11T10:00:00.000Z",
    startTip: null,
    startBinary: null,
    startHead: "h",
    startBranch: "main",
    upstream: "170454d0000",
    reportDir: "/reports/1",
    phase: "merge",
    cursor: 2,
    step: null,
    attempts: 2,
    calls: 2,
    plan: ["a", "b", "c", "d"].map(display => ({
      display,
      description: "",
      commit: "c",
      ref: "r",
      prLink: null,
      skip: display === "b" ? ("skipped-merged" as const) : null,
    })),
    merged: [],
    events: [
      { kind: "merged", patch: "a" },
      { kind: "skipped-merged", patch: "b" },
    ],
    conflicts: [],
    fixes: [],
    stopped: { code: 5, snapshot: {} },
    push: false,
    harnessUsage: [
      { call: 1, kind: "conflict", patch: "c", attempt: 1, ok: false, reason: "markers", seconds: 3, usage: null },
      {
        call: 2,
        kind: "conflict",
        patch: "c",
        attempt: 2,
        ok: false,
        reason: "timed out",
        seconds: 4,
        usage: { input: 10, output: 1 },
      },
    ],
    timing: { activeMs: 9000, items: { fetch: 1000, "rebase:mine": 2000, "merge:a": 500 }, harnessMs: [3000, 4000] },
    rebased: [
      { patch: "mine", branch: "mine", from: "f", to: "t", lease: "", outcome: "rebased", how: "clean" },
      { patch: "x", branch: "x", from: "", to: null, lease: "", outcome: "skipped", reason: "checked out in /w" },
    ],
    ...o,
  };
}

test("a stopped run replays as the state it stopped in", () => {
  const events = fromRun(stopped(), config),
    s = play(events.map(e => [e, 50_000] as [LiveEvent, number]));
  expect(events[0]).toMatchObject({ t: "begin", command: "continue", branch: "integration", elapsedMs: 9000 });
  expect(s.upstream.tip).toBe("170454d0000");
  expect(s.stages.map(st => [st.name, st.state, st.ms])).toEqual([
    ["fetch", "done", 1000],
    ["rebase", "done", 2000],
    ["merge", "running", 0],
    ["verify", "pending", 0],
  ]);
  expect(item(s, "rebase", "mine")).toMatchObject({ state: "done", outcome: "rebased", ms: 2000 });
  expect(item(s, "rebase", "x")).toMatchObject({
    state: "skipped",
    outcome: "left-alone",
    detail: "checked out in /w",
  });
  expect(item(s, "merge", "a")).toMatchObject({ state: "done", outcome: "merged", ms: 500 });
  expect(item(s, "merge", "b")).toMatchObject({ state: "skipped", outcome: "skipped-merged" });
  expect(item(s, "merge", "c")).toMatchObject({ state: "running", tokens: { input: 10, output: 1 } });
  expect(item(s, "merge", "c")?.tries.map(t => t.reason)).toEqual(["markers", "timed out"]);
  expect(item(s, "merge", "d")?.state).toBe("pending");
  expect(s.harness).toMatchObject({ calls: 2, running: 0, input: 10, output: 1, unknown: 1 });
  expect(s.harnessKind).toBe("codex");
  expect(s.retries).toBe(2);
  expect(s.clock.activeMs).toBe(9000);
});

test("a run stopped in verify shows merges and passed steps done", () => {
  const s = play(
    fromRun(
      stopped({
        phase: "verify",
        cursor: 4,
        step: "test",
        rebased: undefined,
        harnessUsage: [],
        events: [
          { kind: "merged", patch: "a" },
          { kind: "skipped-merged", patch: "b" },
          { kind: "agent-resolved", patch: "c" },
          { kind: "already-contained", patch: "d" },
          { kind: "flaky", step: "typecheck", detail: "/k.log" },
          { kind: "passed", step: "typecheck" },
        ],
      }),
      config,
    ).map(e => [e, 0] as [LiveEvent, number]),
  );
  expect(s.stages.map(st => [st.name, st.state])).toEqual([
    ["fetch", "done"],
    ["merge", "done"],
    ["verify", "running"],
  ]);
  expect(item(s, "merge", "c")?.outcome).toBe("agent-resolved");
  expect(item(s, "merge", "d")).toMatchObject({ state: "skipped", outcome: "already-contained" });
  expect(item(s, "verify", "typecheck")).toMatchObject({ state: "done", outcome: "flaky" });
  expect(item(s, "verify", "test")?.state).toBe("running");
  expect(s.retriesBy.flaky).toBe(1);
});

test("the end keeps the run's active time", () => {
  const s = play([
    [begin({}), 0],
    [{ t: "end", ok: true, code: 0, headline: "built", lines: [], report: null, activeMs: 548000 }, 10],
  ]);
  expect(s.ended?.activeMs).toBe(548000);
});

test("an item keeps the files its harness calls named after they end", () => {
  const s = play([
    [begin({ merge: ["a"] }), 0],
    [harness("start", "a", { files: ["src/x.ts", "src/y.ts"] }), 10],
    [harness("end", "a", { ok: false, reason: "markers" }), 20],
    [harness("start", "a", { attempt: 2, files: ["src/y.ts", "src/z.ts"] }), 30],
    [harness("end", "a", { attempt: 2, ok: true }), 40],
  ]);
  expect(item(s, "merge", "a")?.harness).toBeNull();
  expect(item(s, "merge", "a")?.files).toEqual(["src/x.ts", "src/y.ts", "src/z.ts"]);
  expect(item(play([[begin({ merge: ["b"] }), 0]]), "merge", "b")?.files).toEqual([]);
});

test("a stage's links join the ones its begin named", () => {
  const s = play([
    [begin({ merge: ["a"] }, { links: { a: "https://example.com/a" } }), 0],
    [{ t: "stage", stage: "verify", state: "start", links: { test: "file:///r/steps/test.log" } }, 1],
  ]);
  expect(s.links).toEqual({ a: "https://example.com/a", test: "file:///r/steps/test.log" });
});
