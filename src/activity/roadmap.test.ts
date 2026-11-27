import { test, expect } from "bun:test";
import * as plan from "./plan";
import * as owner from "./plan_owner";
import { Tracker, type Observation } from "./tools";
import * as claude from "../providers/claude/usage";
import * as plan_view from "../plan_view";
import * as roadmap from "./roadmap";
import { List } from "./checklist";
import { View, Tokens } from "../usage/live";
import { Actor } from "../conversations";
import { Request, Result, Worker } from "./worker";
import { Text } from "../agents";

const event = (id: number): plan.Event => ({ id, line: id, at: "", turn: 1, kind: "result", text: "Test result" });
const nodes = (): plan.Node[] => [
  {
    id: "e",
    parent: null,
    kind: "episode",
    title: "Fix retry offsets",
    subtitle: "Retain partial file positions",
    state: "active",
    evidence: [1],
  },
  {
    id: "s",
    parent: "e",
    kind: "step",
    title: "Verify retry offsets",
    subtitle: "Run the existing retry tests",
    state: "active",
    evidence: [1],
  },
];
const patch = (items = nodes(), from = 1, to = from) =>
  JSON.stringify({ nodes: items, spans: [{ from, to, node: "s" }] });
const usage = (input: bigint, cached = 0n) =>
  new View({ known: true, tokens: new Tokens({ input, cached_input: cached, output: 0n }) });

test("live intervals exclude the opening baseline, conserve tokens and retain late usage", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Running tests", new List(), usage(1000n, 500n), 1000);
  road.observe("t", "working", "Tests complete", new List(), usage(1200n, 600n), 2000);
  const request = road.request()!;
  expect(road.apply(request, patch(nodes(), 1, 2))).toBe(true);
  expect(road.counts.e).toEqual({ input: "200", cached: "100", output: "0", tools: "0" });
  road.observe("t", "working", "Tests complete", new List(), usage(1250n, 610n), 3000);
  expect(road.counts.e.input).toBe("250");
  expect(roadmap.total(road.view().unassigned)).toBe(0n);
  expect(road.view().partial).toBe(true);
});

test("tool calls roll up once without token receipts, survive handoff and leave old counts unknown", () => {
  const road = new roadmap.Roadmap(),
    observe = (tools: bigint) => road.observe("t", "working", "Run tests", new List(), new View({ tools }), 1000);
  observe(10n);
  observe(12n);
  road.apply(road.request()!, patch());
  expect(road.view().known).toBe(false);
  expect(road.counts.e.tools).toBe("2");
  expect(road.counts.s.tools).toBe("2");
  observe(12n);
  expect(road.counts.s.tools).toBe("2");
  observe(13n);
  expect(road.counts.s.tools).toBe("3");
  const saved = JSON.parse(JSON.stringify(road)),
    restored = roadmap.Roadmap.restore(saved, true);
  restored.observe("t", "working", "Run tests", new List(), new View({ tools: 14n }), 1001);
  expect(restored.counts.e.tools).toBe("4");
  delete saved.tools_baseline;
  for (const count of Object.values(saved.view.counts)) delete (count as roadmap.Counts).tools;
  const old = roadmap.Roadmap.restore(saved, true);
  expect(old.counts.e.tools).toBeUndefined();
  expect(old.tools_baseline).toBeNull();
});

test("a validated prefix can finish after more evidence or a new turn arrives, but cannot apply twice", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Running tests", new List(), usage(100n), 1000);
  const request = road.request()!;
  road.observe("next", "working", "Review changes", new List(), usage(150n), 2000);
  expect(road.apply(request, patch())).toBe(true);
  expect(road.pending.map(e => e.id)).toEqual([2]);
  expect(road.apply(request, patch())).toBe(false);
  expect(roadmap.total(road.view().unassigned)).toBe(50n);
});

test.each([true, false])("pending work, costs and hierarchy survive restoration, live=%s", live => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Run tests", new List(), usage(100n), 1000);
  road.apply(road.request()!, patch());
  road.observe("t", "working", "Tests failed", new List(), usage(200n), 2000);
  const saved = JSON.parse(JSON.stringify(road)),
    restored = roadmap.Roadmap.restore(saved, live);
  expect(restored.view()).toEqual(road.view());
  expect(restored.request()).toEqual(road.request());
  restored.apply(restored.request()!, patch([], 2));
  expect(restored.counts.e.input).toBe("100");
  expect(restored.baseline !== null).toBe(live);
  saved.pending[0].id++;
  expect(() => roadmap.Roadmap.restore(saved, live)).toThrow("InvalidRoadmap");
});

test("overrun keeps dropped interval tokens explicitly unassigned and never applies a stale patch", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Starting", new List(), usage(0n), 1);
  const old = road.request()!;
  for (let i = 1; i <= 40; i++) road.observe("t", "working", "Step " + i, new List(), usage(BigInt(i * 10)), i + 1);
  expect(road.pending).toHaveLength(32);
  expect(roadmap.total(road.view().unassigned)).toBe(400n);
  expect(road.apply(old, patch())).toBe(false);
});

test("done parents reopen around unfinished work and open failures, without rewriting failed attempts", () => {
  const initial = nodes();
  initial[0].state = "done";
  const applied = plan.apply(plan.empty(), patch(initial), [event(1)]).state;
  expect(applied.nodes.map(n => n.state)).toEqual(["active", "active"]);
  const failed = {
    ...applied.nodes[1],
    state: "failed" as const,
    bump: { kind: "verification" as const, state: "open" as const, detail: "Existing tests fail", evidence: [2] },
  };
  const next = plan.apply(applied, patch([failed], 2), [event(2)]).state;
  expect(() => plan.apply(next, patch([{ ...failed, state: "done" }], 3), [event(3)])).toThrow("RewrittenFailure");
  expect(plan.apply(next, patch([{ ...failed, bump: null }], 3), [event(3)]).state.nodes[1].bump).toEqual(failed.bump);
  expect(() =>
    plan.apply(next, patch([{ ...failed, bump: { ...failed.bump, state: "resolved" } }], 3), [event(3)]),
  ).toThrow("MissingRecoveryEvidence");
  const resolved = { ...failed, bump: { ...failed.bump, state: "resolved" as const, evidence: [2, 3] } };
  expect(plan.apply(next, patch([resolved], 3), [event(3)]).state.nodes[1].bump?.state).toBe("resolved");
});

test("late plan results preserve native labels, and never change the new turn's activity", () => {
  const actor = new Actor({ id: 1 });
  actor.state.provider = "omp";
  actor.state.setTurn("t");
  actor.state.state = "working";
  actor.state.activity = new Text("Native tool intent");
  actor.activity_plan.observe("t", "working", "Test downloads", new List(), usage(0n), 1);
  const request = Object.assign(new Request(), {
    actor: 1,
    road: actor.activity_plan.request(),
    turn_epoch: actor.state.turn_epoch,
  });
  const result = new Result(request, new Text("Verify retry offsets"));
  result.patch = patch();
  expect(result.apply(actor)).toBe(true);
  expect(actor.state.activity.text()).toBe("Native tool intent");
  const worker = new Worker();
  worker.reconcile([actor]);
  expect(worker.slots.find(Boolean)?.request.road?.events.at(-1)?.text).toContain("Native tool intent");
  actor.state.state = "idle";
  worker.reconcile([actor]);
  expect(worker.slots.find(Boolean)?.request.road?.events.at(-1)?.text).toContain("lifecycle: idle");
  worker.stop();
});

test("checklists are retained as timed intent, not silently converted to completion", () => {
  const road = new roadmap.Roadmap(),
    list = List.of([{ text: "Ship fix", status: "done" }], false, 1000);
  road.observe("t", "working", "Tests still fail", list, usage(10n), 1);
  expect(road.request()!.events[0].text).toContain('"status":"done"');
  expect(road.state.nodes).toHaveLength(0);
  road.observe("t", "working", "Tests still fail", List.of([], false, 2000), usage(10n), 2);
  expect(road.pending[1].text).toContain('"items":[]');
});

test("wire plans reject unsafe IDs, controls, fabricated parents, future bumps and malformed counts", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Test", new List(), usage(0n), 1);
  road.apply(road.request()!, patch());
  for (const mutate of [
    (v: roadmap.Snapshot) => {
      v.nodes[0].id = "__proto__";
    },
    (v: roadmap.Snapshot) => {
      v.nodes[0].title = "Terminal \x1b command";
    },
    (v: roadmap.Snapshot) => {
      v.nodes[1].parent = "missing";
    },
    (v: roadmap.Snapshot) => {
      v.counts.e.input = "-1";
    },
    (v: roadmap.Snapshot) => {
      v.focus = "s";
    },
    (v: roadmap.Snapshot) => {
      v.focus_step = "e";
    },
    (v: roadmap.Snapshot) => {
      v.focus = null;
    },
  ]) {
    const v = structuredClone(road.view());
    mutate(v);
    expect(() => roadmap.decode(v)).toThrow();
  }
  expect(roadmap.decode(undefined).nodes).toEqual([]);
});

test("focus follows attributed work and survives status changes, unassigned events and recovery", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Running tests", new List(), usage(0n), 1);
  road.apply(road.request()!, patch());
  expect(road.view().focus).toBe("e");
  expect(road.view().focus_step).toBe("s");
  road.observe("t", "idle", "Finished", new List(), usage(10n), 2);
  road.apply(
    road.request()!,
    JSON.stringify({ nodes: nodes().map(n => ({ ...n, state: "done" })), spans: [{ from: 2, to: 2, node: null }] }),
  );
  expect(road.view().focus).toBe("e");
  expect(road.view().focus_step).toBe("s");
  road.observe("next", "working", "Again", new List(), usage(10n), 3);
  road.apply(road.request()!, patch(nodes(), 3));
  expect(road.view().focus).toBe("e");
  const second = [
    { ...nodes()[0], id: "e2", title: "Check integration behavior" },
    { ...nodes()[1], id: "s2", parent: "e2" },
  ];
  road.observe("next", "working", "Run integration suite", new List(), usage(20n), 4);
  road.apply(road.request()!, JSON.stringify({ nodes: second, spans: [{ from: 4, to: 4, node: "s2" }] }));
  expect(road.view().focus).toBe("e2");
  expect(road.view().focus_step).toBe("s2");
  const saved = JSON.parse(JSON.stringify(road));
  for (const live of [true, false]) {
    const restored = roadmap.Roadmap.restore(saved, live).view();
    expect(restored.focus).toBe("e2");
    expect(restored.focus_step).toBe("s2");
  }
  delete saved.view.focus_step;
  expect(roadmap.Roadmap.restore(saved, true).view().focus_step).toBeNull();
  delete saved.view.focus;
  expect(roadmap.Roadmap.restore(saved, true).view().focus).toBeNull();
});

test("returning work appends a visit, keeps its own usage, and survives live and cold recovery", () => {
  let road = new roadmap.Roadmap();
  const items = [...nodes(), { ...nodes()[1], id: "other", title: "Inspect response logs" }];
  const apply = (id: number, step: string, input: bigint, additions: plan.Node[] = []) => {
    road.observe("t", "working", "Work " + id, new List(), usage(input, input / 2n), id);
    road.apply(road.request()!, JSON.stringify({ nodes: additions, spans: [{ from: id, to: id, node: step }] }));
  };
  apply(1, "s", 100n, items);
  apply(2, "s", 200n);
  apply(3, "other", 500n);
  const before = structuredClone(road.visits);
  apply(4, "s", 700n);
  expect(road.visits.slice(0, 2)).toEqual(before);
  expect(road.visits.map(v => [v.step, v.from, v.to, v.counts.input])).toEqual([
    ["s", 1, 2, "100"],
    ["other", 3, 3, "300"],
    ["s", 4, 4, "200"],
  ]);
  expect(road.visits.reduce((sum, v) => roadmap.add(sum, v.counts), roadmap.zero())).toEqual(road.counts.e);
  const saved = JSON.parse(JSON.stringify(road));
  for (const live of [true, false]) expect(roadmap.Roadmap.restore(saved, live).visits).toEqual(road.visits);
  road = roadmap.Roadmap.restore(saved, true);
  road.observe("t", "working", "Work 4", new List(), usage(750n, 375n), 5);
  expect(road.visits[0].counts.input).toBe("100");
  expect(road.visits[2].counts.input).toBe("250");
  expect(roadmap.decode(road.view()).visits).toEqual(road.visits);
  for (const mutate of [
    (v: roadmap.Visit[]) => {
      v[1].from = 2;
    },
    (v: roadmap.Visit[]) => {
      v[0].step = "e";
    },
    (v: roadmap.Visit[]) => {
      v[0].to = Number.MAX_SAFE_INTEGER + 1;
    },
    (v: roadmap.Visit[]) => {
      v[0].counts.cached = "10000";
    },
  ]) {
    const view = structuredClone(road.view());
    mutate(view.visits);
    expect(() => roadmap.decode(view)).toThrow("Invalid");
  }
  delete saved.view.visits;
  delete saved.tool_context;
  road = roadmap.Roadmap.restore(saved, true);
  expect(road.visits.every(v => v.from === 0 && v.to === 0)).toBe(true);
  const legacy = structuredClone(road.visits);
  apply(5, "s", 800n);
  expect(road.visits.slice(0, -1)).toEqual(legacy);
  expect(road.visits.at(-1)?.counts.input).toBe("100");
});

test("neutral events and unchanged observations do not create extra visits", () => {
  const visits = roadmap.appendVisits(
    [],
    [
      { from: 1, to: 1, node: null },
      { from: 2, to: 3, node: "s" },
      { from: 4, to: 4, node: null },
      { from: 5, to: 5, node: "s" },
    ],
  );
  expect(visits.map(v => [v.from, v.to])).toEqual([[2, 5]]);
  expect(roadmap.appendVisits(visits, [{ from: 6, to: 6, node: null }])).toEqual(visits);
  const next = roadmap.appendVisits(visits, [{ from: 6, to: 7, node: "s" }]);
  expect(next[0].to).toBe(7);
  expect(visits[0].to).toBe(5);
});

test("background polls and late results update the original visit without stealing focus", () => {
  const road = new roadmap.Roadmap();
  const items = [...nodes(), { ...nodes()[1], id: "other", title: "Edit retry handling" }];
  for (const [index, step, focus] of [
    [1, "s", true],
    [2, "other", true],
    [3, "s", false],
  ] as const) {
    road.observe("t", "working", "Observation " + index, new List(), usage(BigInt(index * 100)), index);
    road.apply(
      road.request()!,
      JSON.stringify({
        nodes: index === 1 ? items : [],
        spans: [{ from: index, to: index, node: step, focus }],
      }),
    );
  }
  expect(road.focus_step).toBe("other");
  expect(road.visits.map(v => [v.step, v.from, v.to, v.counts.input])).toEqual([
    ["s", 1, 1, "100"],
    ["other", 2, 2, "100"],
  ]);
  // More usage for the same late observation still belongs to the original step.
  road.observe("t", "working", "Observation 3", new List(), usage(350n), 4);
  expect(road.visits[0].counts.input).toBe("150");
  const restored = roadmap.Roadmap.restore(JSON.parse(JSON.stringify(road)), true);
  expect(restored.focus_step).toBe("other");
  expect(restored.visits).toEqual(road.visits);
  restored.observe("t", "working", "New foreground observation", new List(), usage(400n), 5);
  expect(restored.request()!.focus).toBe("other");
  expect(road.visits.reduce((sum, v) => roadmap.add(sum, v.counts), roadmap.zero())).toEqual(road.counts.e);
});

test("plans saved with a goal level restore as top-level episodes and keep episode and step counts", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Running tests", new List(), usage(100n), 1000);
  road.observe("t", "working", "Tests complete", new List(), usage(300n, 50n), 2000);
  road.apply(road.request()!, patch(nodes(), 1, 2));
  const saved = JSON.parse(JSON.stringify(road)),
    goal = { ...nodes()[0], id: "g", kind: "goal", title: "Repair downloads" };
  saved.view.nodes = [goal, ...saved.view.nodes.map((n: plan.Node) => (n.id === "e" ? { ...n, parent: "g" } : n))];
  saved.view.counts.g = saved.view.counts.e;
  const view = roadmap.decode(saved.view);
  expect(view.nodes.map(n => [n.id, n.kind, n.parent])).toEqual([
    ["e", "episode", null],
    ["s", "step", "e"],
  ]);
  expect(view.counts).toEqual(road.view().counts);
  expect(view.visits).toEqual(road.visits);
  for (const live of [true, false]) {
    const restored = roadmap.Roadmap.restore(saved, live);
    expect(restored.view()).toEqual(road.view());
    expect(Object.keys(restored.counts)).toEqual(["e", "s"]);
    // Later usage still rolls up from the step to its episode.
    restored.observe("t", "working", "Tests complete again", new List(), usage(400n, 50n), 3000);
    restored.apply(restored.request()!, patch([], 3));
    expect(restored.counts.e).toEqual(restored.counts.s);
  }
});

test.each([false, true])("parallel tools keep their own lifetimes and step, grouped=%s", grouped => {
  const road = new roadmap.Roadmap(),
    tracker = new Tracker();
  tracker.bind("turn");
  const observe = () =>
    road.observe("turn", "working", "Inspect parser", new List(), usage(100n), 10, tracker.view().calls);
  const start = (id: string, name: string, input: object) =>
    claude.progress(
      tracker,
      { type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } },
      true,
    );
  const finish = (id: string) =>
    claude.progress(
      tracker,
      { type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] } },
      true,
    );
  start("a", "Bash", { description: "Check parser tests", command: "bun test src/parser" });
  start("b", "Read", { file_path: "src/parser.ts" });
  observe();
  const req = road.request()!;
  expect(req.tools?.map(c => c.description)).toEqual(["Check parser tests", ""]);
  expect(road.view().tool_rows?.map(r => r.running)).toEqual([true, true]);
  const program = [
    "BEGIN_PLAN",
    "mkdir /e active Fix parser",
    "set /e subtitle Repair parsing",
    "mkdir /e/s active Check parser",
    "set /s subtitle Read the parser and its tests",
    "set_owner 1 /s",
    "set_focus 1 /s",
  ].join("\n");
  const classify = (line: string) => owner.apply(req, program + "\n" + line);
  expect(() => classify("")).toThrow("MissingToolLabel");
  expect(() => classify("tool 2,3 Read parser sources")).toThrow("InvalidToolGroup");
  const result = classify(grouped ? "tool 1,2 Check parser behavior" : "tool 2 Read parser source");
  finish("a");
  observe();
  expect(road.apply(req, JSON.stringify(result.patch))).toBe(true);
  const rows = () =>
    plan_view.tail(road.view(), 10, true).rows.flatMap(r => (r.kind === "tool" ? [[r.title, r.active]] : []));
  expect(rows()).toEqual([
    [grouped ? "Read: src/parser.ts" : "Read parser source", true],
    ["Check parser tests", false],
  ]);
  const saved = JSON.parse(JSON.stringify(road));
  expect(roadmap.Roadmap.restore(saved, true).view()).toEqual(road.view());
  expect(
    roadmap.Roadmap.restore(saved, false)
      .view()
      .tool_rows?.every(r => !r.running),
  ).toBe(true);
  finish("b");
  observe();
  expect(rows().every(r => r[1] === false)).toBe(true);
  expect(road.view().tool_rows?.every(r => r.visit === 1)).toBe(true);
  expect(road.request()).toBeNull();
  expect(road.counts.e.tools).toBe("0"); // The provider usage meter alone supplies counts.
});

test("a call starts under the active step and a neutral update leaves it there", () => {
  const road = new roadmap.Roadmap();
  road.observe("t", "working", "Run tests", new List(), usage(100n), 1);
  road.apply(road.request()!, patch());
  const call = {
    key: "a",
    detail: "Read: src/auth.ts",
    description: "Read auth",
    running: false,
    outcome: "success" as const,
  };
  road.observe("t", "working", "Check auth", new List(), usage(100n), 2, [call]);
  const parent = () => plan_view.tail(road.view(), 10, true).rows.find(row => row.kind === "tool")?.parent;
  expect(parent()?.id).toBe("s");
  road.apply(road.request()!, JSON.stringify({ nodes: [], spans: [{ from: 2, to: 2, node: null }] }));
  road.observe("t", "working", "Resume tests", new List(), usage(120n), 3);
  road.apply(road.request()!, patch([], 3));
  expect(road.view().tool_rows?.[0].visit).toBe(1);
  expect(parent()?.id).toBe("s");
});

test("completed calls fold by result, keep individual labels, and ignore stale recaps", () => {
  const road = new roadmap.Roadmap();
  road.state = { nodes: nodes(), through: 4, spans: [] };
  road.counts = Object.fromEntries(road.state.nodes.map(n => [n.id, roadmap.zero()]));
  road.visits = [{ step: "s", from: 1, to: 4, counts: roadmap.zero() }];
  const example = (key: string, title: string, outcome: "success" | "failure" | null, running = false) => ({
    key,
    description: title,
    detail: "exec: " + title,
    outcome,
    running,
  });
  const calls = [
    example("a", "Read parser source", "success"),
    example("b", "Read parser tests", "success"),
    example("c", "Run parser tests", "failure"),
    example("d", "Run parser tests", null, true),
  ];
  road.tools.observe(calls, 1, 1, true);
  road.tools.assign(1, 1, [], () => 1);
  const req = road.tools.recaps(road.toolScopes())[0];
  expect(req.labels).toEqual(["Read parser source", "Read parser tests"]);
  road.tools.remember(req, "Inspected parser source and tests");
  const view = road.view();
  expect(view.tool_rows?.map(r => [r.running, r.outcome, r.members?.length])).toEqual([
    [true, undefined, undefined],
    [false, "success", 2],
    [false, "failure", 1],
  ]);
  expect(view.tool_rows?.[1].title).toBe("Inspected parser source and tests");
  expect(roadmap.Roadmap.restore(JSON.parse(JSON.stringify(road)), true).view()).toEqual(view);
  const expanded = plan_view.tail(view, 14, true, { id: view.tool_rows![1].first!, offset: 0 });
  expect(expanded.rows.filter(r => r.kind === "detail").map(r => r.title)).toEqual(req.labels);
  calls[3] = example("d", "Run parser tests", "success");
  road.tools.observe(calls, 1, 2, true);
  road.tools.remember(req, "Inspected parser source and tests");
  expect(road.view().tool_rows?.[0].title).not.toBe("Inspected parser source and tests");
  expect(road.view().tool_rows?.[0].members).toHaveLength(3);
  expect(road.view().tool_rows?.[1].outcome).toBe("failure");
});

test("a shell wrapper with no observable command shows just the live tool marker", () => {
  const road = new roadmap.Roadmap();
  road.tools.observe([{ key: "1", detail: "exec: exec_command", description: "", running: true }], 1, 1, true);
  expect(road.tools.input(1, 1)).toEqual([]);
  const lines: string[] = [];
  const draw = () =>
    plan_view.drawRows(road.view(), plan_view.tail(road.view(), 4, true).rows, 70, {
      line: (_, s) => lines.push(s.trim()),
      mark: () => {},
    });
  draw();
  expect(lines).toEqual(["Request 1", "▶ ›_"]);
  road.tools.observe([], 1, 2, false);
  draw();
  expect(lines.at(-1)).toContain("Outcome unknown (1)");
  expect(lines.at(-1)).not.toContain("Succeeded");
});

test("tools appear with the request or its active step on arrival, and corrections use their start event", () => {
  const road = new roadmap.Roadmap();
  const first = { id: 1, title: "Find broker photo data" },
    next = { id: 2, title: "Check photo dimensions" };
  const calls: Observation[] = [];
  const observe = (turn: string, request: typeof first, text: string) =>
    road.observe(turn, "working", text, new List(), usage(100n), 1, calls, request);
  const start = (key: string, request: typeof first) =>
    calls.push({ key, request, description: key, detail: "Read: " + key, running: true });
  const rows = () => road.view().tool_rows!;
  const headings = () =>
    plan_view
      .tail(road.view(), 25, true)
      .rows.filter(r => r.kind === "request")
      .map(r => r.title);
  start("Read photo schema", first);
  observe("turn-1", first, "Read schema");
  expect(headings()).toEqual([first.title]);
  const firstBatch = road.request()!;
  start("Read image metadata", first);
  observe("turn-1", first, "Read metadata");
  road.apply(firstBatch, patch());
  expect(rows().map(r => r.visit)).toEqual([1, 1]);
  start("Write photo field", first);
  observe("turn-1", first, "Write field");
  expect(rows().every(r => r.visit === 1)).toBe(true);
  const other = { ...nodes()[1], id: "photo", title: "Carry broker photo offline", evidence: [3] };
  road.apply(
    road.request()!,
    JSON.stringify({
      nodes: [other],
      spans: [
        { from: 2, to: 2, node: "s", focus: false },
        { from: 3, to: 3, node: "photo", focus: true },
      ],
    }),
  );
  expect(rows().map(r => r.visit)).toEqual([1, 1, 3]);
  start("Preview offline photo", first);
  observe("turn-1", first, "Preview");
  const prior = road.request()!;
  start("Read dimensions", next);
  calls[0] = { ...calls[0], running: false, outcome: "success" };
  observe("turn-1", next, "Check dimensions");
  expect(headings()).toEqual([next.title]);
  expect(rows().find(r => r.members?.includes("Read photo schema"))?.visit).toBe(1);
  road.apply(prior, JSON.stringify({ nodes: [], spans: [{ from: 4, to: 4, node: "photo" }] }));
  expect(rows().find(r => r.title === "Read dimensions")?.request?.title).toBe(next.title);
  const saved = JSON.parse(JSON.stringify(road));
  expect(roadmap.Roadmap.restore(saved, true).view()).toEqual(road.view());
  const third = { id: 1, title: "Measure the badge" };
  calls.length = 0;
  start("Measure badge", third);
  observe("turn-2", third, "Measure");
  expect(rows().find(r => r.title === "Measure badge")?.request).toMatchObject({ turn: 2, title: third.title });
  expect(roadmap.decode(road.view())).toEqual(road.view());
});

test("one poll can deliver an older request's tool result alongside a new request's calls", () => {
  const road = new roadmap.Roadmap(),
    first = { id: 1, title: "Inspect the badge" },
    next = { id: 2, title: "Check the broker photo" };
  road.observe("turn", "working", first.title, new List(), usage(0n), 1, [], first);
  road.apply(road.request()!, patch());
  road.observe(
    "turn",
    "working",
    next.title,
    new List(),
    usage(0n),
    2,
    [
      {
        key: "badge",
        request: first,
        description: "Read badge",
        detail: "Read: badge",
        running: false,
        outcome: "success",
      },
      { key: "photo", request: next, description: "Read photo", detail: "Read: photo", running: true },
    ],
    next,
  );
  expect(road.tools.calls.map(c => c.visit)).toEqual([1, null]);
  const step = { ...nodes()[1], id: "photo", title: next.title, evidence: [2] };
  road.apply(road.request()!, JSON.stringify({ nodes: [step], spans: [{ from: 2, to: 2, node: "photo" }] }));
  expect(road.tools.calls.map(c => c.visit)).toEqual([1, 2]);
});

test("a late start record corrects the request of an already observed tool", () => {
  const road = new roadmap.Roadmap(),
    first = { id: 1, title: "Inspect the badge" },
    next = { id: 2, title: "Check the broker photo" };
  const old = { key: "read", description: "Inspect fields", detail: "Read: fields", running: true };
  const badge = { ...old, key: "badge", request: first };
  const observe = (request: typeof first, calls: Observation[]) =>
    road.observe("turn", "working", request.title, new List(), usage(0n), 1, calls, request);
  observe(first, [badge]);
  road.apply(road.request()!, patch());
  observe(next, [badge, old]);
  expect(road.tools.calls[1].request).toEqual(next);
  observe(next, [badge, { ...old, request: first, running: false, outcome: "success" }]);
  const step = { ...nodes()[1], id: "photo", title: next.title, evidence: [2] };
  road.apply(road.request()!, JSON.stringify({ nodes: [step], spans: [{ from: 2, to: 2, node: "photo" }] }));
  expect(road.tools.calls[1]).toMatchObject({ request: first, visit: 1, outcome: "success" });
});

test("recovering request metadata preserves the step already inferred for an unidentified call", () => {
  const road = new roadmap.Roadmap(),
    first = { id: 1, title: "Inspect the badge" },
    next = { id: 2, title: "Check the photo" };
  const call = { key: "read", description: "Read badge fields", detail: "Read: fields", running: true };
  road.observe("turn", "working", "Read badge", new List(), usage(0n), 1, [call]);
  road.apply(road.request()!, patch());
  road.observe(
    "turn",
    "working",
    next.title,
    new List(),
    usage(0n),
    2,
    [
      { ...call, request: first },
      { ...call, key: "photo", request: next },
    ],
    next,
  );
  expect(road.tools.calls[0]).toMatchObject({ request: first, visit: 1 });
  expect(road.tools.calls[1]).toMatchObject({ request: next, visit: null });
});

test("old unassigned tool groups stay beside their original work in the visible chronology", () => {
  const road = new roadmap.Roadmap();
  road.observe("old", "working", "Read badge files", new List(), usage(0n), 1, [
    { key: "a", detail: "Read: badge.ts", description: "Read badge files", running: false, outcome: "success" },
  ]);
  road.apply(road.request()!, JSON.stringify({ nodes: [], spans: [{ from: 1, to: 1, node: null }] }));
  road.observe("new", "working", "Fix retry offsets", new List(), usage(0n), 2);
  road.apply(road.request()!, patch(nodes(), 2));
  const saved = JSON.parse(JSON.stringify(road));
  delete saved.tool_context;
  delete saved.tool_calls[0].request;
  const old = roadmap.Roadmap.restore(saved, true);
  expect(plan_view.tail(old.view(), 10, true).rows.map(r => r.kind)).toEqual(["request", "tool", "node", "node"]);
});
