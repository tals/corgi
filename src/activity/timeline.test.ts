import { test, expect } from "bun:test";
import { Timeline } from "./timeline";
import { parseLabel } from "./summary";
import { Tokens, View } from "../usage/live";

function view(input = 0n, cached_input = 0n, output = 0n) {
  return new View({
    known: true,
    tokens: new Tokens({ input, cached_input, output }),
  });
}
const reading = parseLabel("Reading source")!;
const testing = parseLabel("Running tests")!;

test("checkpoints partition own usage, coalesce repeated labels, and remain bounded", () => {
  const timeline = new Timeline();
  const current = view(100n, 60n, 20n);
  timeline.checkpoint("a", reading, current, 1000);
  current.tokens.add(new Tokens({ input: 30n, cached_input: 10n, output: 5n }));
  timeline.checkpoint("a", reading, current, 2000);
  expect(timeline.len).toBe(1);
  expect(timeline.points[0].usage.tokens.total()).toBe(155n);
  expect(timeline.points[0].at).toBe(1000);
  current.tokens.add(new Tokens({ input: 40n, output: 10n }));
  timeline.checkpoint("a", testing, current, 3000);
  expect(timeline.points[0].usage.tokens.total()).toBe(205n);
  expect(timeline.points[1].usage.tokens.total()).toBe(0n);
  current.tokens.add(new Tokens({ input: 7n, output: 3n }));
  expect(timeline.pending(current).tokens.total()).toBe(10n);
  expect(timeline.pending(current).tokens.total()).toBe(10n);
  timeline.checkpoint("b", testing, current, 4000);
  expect(timeline.len).toBe(3);
  for (let i = 0; i < 16; i++) timeline.checkpoint("b", i % 2 === 0 ? reading : testing, current, 5000 + i);
  expect(timeline.len).toBe(16);
  expect(timeline.pending(current).tokens.total()).toBe(0n);
});

test("only intervals containing a loss or regression are partial", () => {
  const timeline = new Timeline();
  timeline.checkpoint("a", reading, new View(), 1);
  timeline.checkpoint("a", reading, view(100n), 2);
  expect(timeline.points[0].usage.partial).toBe(false);
  expect(timeline.points[0].usage.tokens.total()).toBe(100n);
  timeline.checkpoint("b", testing, view(50n), 3);
  expect(timeline.points[1].usage.tokens.total()).toBe(0n);
  expect(timeline.points[0].usage.partial).toBe(true);
  expect(timeline.points[1].usage.partial).toBe(false);
  const clean = timeline.pending(view(110n));
  expect(clean.tokens.total()).toBe(10n);
  expect(clean.partial).toBe(false);
  const lost = view(130n);
  lost.partial = true;
  lost.losses = 1;
  expect(timeline.pending(lost).partial).toBe(true);
  timeline.checkpoint("b", reading, lost, 4);
  expect(timeline.points[1].usage.partial).toBe(true);
  expect(timeline.points[2].usage.partial).toBe(false);
  lost.tokens.input = 150n;
  expect(timeline.pending(lost).partial).toBe(false);
  timeline.checkpoint("b", testing, lost, 5);
  expect(timeline.points[3].usage.partial).toBe(false);
});

test("activity transitions charge the previous phase and pending retains repeated summaries", () => {
  const timeline = new Timeline();
  const reviewing = parseLabel("Reviewing pending changes")!;
  const inspecting = parseLabel("Inspecting repository changes")!;
  timeline.checkpoint("turn", reviewing, new View(), 1000);
  const current = view(21500n, 12800n);
  timeline.checkpoint("turn", inspecting, current, 2000);
  const previous = timeline.points[0].usage.tokens;
  expect(previous.input - previous.cached_input).toBe(8700n);
  expect(previous.cached_input).toBe(12800n);
  current.tokens.add(new Tokens({ input: 99600n, cached_input: 78700n }));
  timeline.checkpoint("turn", inspecting, current, 3000);
  const live = timeline.pending(current).tokens;
  expect(timeline.len).toBe(2);
  expect(live.input - live.cached_input).toBe(20900n);
  expect(live.cached_input).toBe(78700n);
  expect(timeline.points[1].at).toBe(2000);
  timeline.checkpoint("turn", reviewing, current, 4000);
  expect(timeline.points[1].usage.tokens).toEqual(live);
  expect(timeline.pending(current).tokens.total()).toBe(0n);
});

test("usage after a finished compaction belongs to the next named phase", () => {
  const timeline = new Timeline();
  timeline.checkpoint("turn", parseLabel("Compacting context")!, new View(), 1000);
  const current = view(10n);
  timeline.finish(current);
  current.tokens.input = 20n;
  expect(timeline.pending(current).tokens.input).toBe(10n);
  timeline.checkpoint("turn", testing, current, 2000);
  expect(timeline.points[0].usage.tokens.input).toBe(10n);
  expect(timeline.pending(current).tokens.input).toBe(10n);
  current.tokens.input = 30n;
  expect(timeline.pending(current).tokens.input).toBe(20n);
});

test("amend renames the turn's open phase and keeps its interval", () => {
  const timeline = new Timeline();
  const unit = parseLabel("Running unit tests")!;
  timeline.checkpoint("a", reading, view(100n), 1000);
  timeline.checkpoint("a", testing, view(150n), 2000);
  timeline.amend("a", unit, view(170n), 3000);
  expect(timeline.points.map(p => p.label.text())).toEqual(["Reading source", "Running unit tests"]);
  expect(timeline.points[1].at).toBe(2000);
  expect(timeline.points[1].usage.tokens.total()).toBe(20n);
  timeline.amend("b", reading, view(170n), 4000);
  expect(timeline.len).toBe(3);
  timeline.finish(view(180n));
  timeline.amend("b", testing, view(180n), 5000);
  expect(timeline.points.map(p => p.label.text())).toEqual([
    "Reading source",
    "Running unit tests",
    "Reading source",
    "Running tests",
  ]);
});

test("response and tool counts partition and coalesce without requiring token readings", () => {
  const timeline = new Timeline();
  const current = new View({ turns: 1n, tools: 3n, counts_known: true });
  timeline.checkpoint("a", reading, current, 1000);
  current.turns = 3n;
  current.tools = 8n;
  timeline.checkpoint("a", reading, current, 2000);
  expect(timeline.len).toBe(1);
  expect(timeline.points[0].usage).toMatchObject({ turns: 3n, tools: 8n, counts_known: true, known: false });
  current.turns = 4n;
  current.tools = 10n;
  timeline.checkpoint("a", testing, current, 3000);
  expect(timeline.points[0].usage).toMatchObject({ turns: 4n, tools: 10n, counts_known: true });
  expect(timeline.points[1].usage).toMatchObject({ turns: 0n, tools: 0n, counts_known: true });
  current.turns = 5n;
  current.tools = 13n;
  for (let i = 0; i < 3; i++)
    expect(timeline.pending(current)).toMatchObject({ turns: 1n, tools: 3n, counts_known: true });
  expect(timeline.points[1].usage).toMatchObject({ turns: 0n, tools: 0n });
  timeline.amend("a", parseLabel("Running unit tests")!, current, 4000);
  expect(timeline.len).toBe(2);
  expect(timeline.points[1].usage).toMatchObject({ turns: 1n, tools: 3n, counts_known: true });
  timeline.checkpoint("b", testing, current, 5000);
  expect(timeline.len).toBe(3);
  expect(timeline.pending(current)).toMatchObject({ turns: 0n, tools: 0n, counts_known: true });
});

test("finished phases keep counts fixed and charge later observations to the next phase", () => {
  const timeline = new Timeline();
  const current = new View({ counts_known: true });
  timeline.checkpoint("a", reading, current, 1000);
  current.turns = 2n;
  current.tools = 5n;
  timeline.finish(current);
  current.turns = 3n;
  current.tools = 7n;
  expect(timeline.pending(current)).toMatchObject({ turns: 2n, tools: 5n, counts_known: true });
  timeline.checkpoint("a", testing, current, 2000);
  expect(timeline.points[0].usage).toMatchObject({ turns: 2n, tools: 5n, counts_known: true });
  expect(timeline.pending(current)).toMatchObject({ turns: 1n, tools: 2n, counts_known: true });
  current.turns = 4n;
  current.tools = 9n;
  expect(timeline.pending(current)).toMatchObject({ turns: 2n, tools: 4n, counts_known: true });
});

test("unknown count boundaries stay unknown until a new fully observed interval", () => {
  const timeline = new Timeline();
  timeline.checkpoint("a", reading, view(100n), 1000);
  const current = new View({ turns: 3n, tools: 8n, counts_known: true });
  expect(timeline.pending(current).counts_known).toBe(false);
  timeline.checkpoint("a", reading, current, 2000);
  current.turns = 4n;
  current.tools = 10n;
  expect(timeline.pending(current).counts_known).toBe(false);
  timeline.checkpoint("a", testing, current, 3000);
  current.turns = 5n;
  current.tools = 13n;
  expect(timeline.pending(current)).toMatchObject({ turns: 1n, tools: 3n, counts_known: true });
  current.counts_known = false;
  expect(timeline.pending(current).counts_known).toBe(false);
  timeline.finish(current);
  current.counts_known = true;
  timeline.checkpoint("b", reading, current, 4000);
  expect(timeline.pending(current).counts_known).toBe(false);
  timeline.checkpoint("b", testing, current, 5000);
  expect(timeline.pending(current)).toMatchObject({ turns: 0n, tools: 0n, counts_known: true });
});

test("losses invalidate only their count interval and count regressions leave token semantics unchanged", () => {
  const timeline = new Timeline();
  const current = new View({ known: true, turns: 3n, tools: 8n, counts_known: true });
  timeline.checkpoint("a", reading, current, 1000);
  current.losses = 1;
  current.partial = true;
  current.turns = 4n;
  current.tools = 10n;
  expect(timeline.pending(current)).toMatchObject({ turns: 4n, tools: 10n, counts_known: false, partial: true });
  timeline.checkpoint("a", testing, current, 2000);
  expect(timeline.pending(current)).toMatchObject({ turns: 0n, tools: 0n, counts_known: true, partial: false });
  current.turns = 2n;
  current.tools = 9n;
  expect(timeline.pending(current)).toMatchObject({ turns: 0n, tools: 0n, counts_known: false, partial: false });
  timeline.checkpoint("a", reading, current, 3000);
  current.turns = 5n;
  current.tools = 12n;
  expect(timeline.pending(current)).toMatchObject({ turns: 1n, tools: 2n, counts_known: true, partial: false });
});

test("goal ownership is immutable across amendments and same-label transitions", () => {
  const timeline = new Timeline();
  const current = new View({ known: true, counts_known: true });
  const first = timeline.selectTask({ id: null, label: "Implement storage" }, []);
  timeline.checkpoint("turn", reading, current, 1);
  current.tokens.input = 10n;
  current.tools = 2n;
  const second = timeline.selectTask({ id: null, label: "Verify storage" }, []);
  timeline.amend("turn", reading, current, 2);
  current.tokens.input = 17n;
  current.tools = 3n;
  expect(timeline.points.map(point => point.task_id)).toEqual([first, second]);
  expect(timeline.taskViews(current).map(task => [task.id, task.usage.tokens.input, task.usage.tools])).toEqual([
    [first!, 10n, 2n],
    [second!, 7n, 1n],
  ]);
  timeline.finish(current);
  expect(timeline.taskViews(current).map(task => task.status)).toEqual(["in_progress", "in_progress"]);
  timeline.selectTask({ id: second, label: null }, [first!]);
  expect(timeline.taskContext().tasks.map(task => task.status)).toEqual(["completed", "in_progress"]);
});

test("supplied goals preserve exact unique identity across reorder, status changes, and replay", () => {
  const timeline = new Timeline();
  const current = view();
  const plan = [
    {
      name: "Build",
      tasks: [
        { content: "Storage", status: "pending" as const },
        { content: "Verification", status: "pending" as const },
      ],
    },
  ];
  timeline.syncPlan(plan, current, 1);
  const before = timeline.taskContext();
  timeline.syncPlan(plan, current, 2);
  expect(timeline.taskContext()).toEqual(before);
  const storage = before.tasks[0].id;
  timeline.selectTask({ id: storage, label: null }, []);
  timeline.checkpoint("turn", reading, current, 3);
  const reordered = [
    {
      name: "Build",
      tasks: [
        { content: "Verification", status: "in_progress" as const },
        { content: "Storage", status: "completed" as const },
      ],
    },
  ];
  timeline.syncPlan(reordered, current, 4);
  expect(timeline.tasks.map(task => task.id)).toEqual(before.tasks.map(task => task.id).reverse());
  timeline.syncPlan([], current, 5);
  expect(timeline.current_task).toBeNull();
  expect(timeline.tasks).toMatchObject([{ id: storage, present: false }]);
  timeline.syncPlan(plan, current, 6);
  expect(timeline.tasks.find(task => task.label === "Storage")?.id).toBe(storage);
  expect(timeline.points[0].task_id).toBe(storage);
});

test("plan replacement closes ownership at observation and never claims unassigned history", () => {
  const timeline = new Timeline();
  const current = view(10n);
  timeline.checkpoint("turn", reading, current, 1);
  timeline.syncPlan([{ name: "", tasks: [{ content: "Storage", status: "in_progress" }] }], current, 2);
  const first = timeline.tasks[0].id;
  timeline.selectTask({ id: first, label: null }, []);
  timeline.checkpoint("turn", reading, current, 3);
  current.tokens.input = 20n;
  timeline.syncPlan([{ name: "", tasks: [{ content: "New design", status: "in_progress" }] }], current, 4);
  current.tokens.input = 30n;
  expect(timeline.current_task).toBeNull();
  expect(timeline.points.map(point => point.task_id)).toEqual([null, first, null]);
  expect(timeline.taskViews(current).find(task => task.id === first)?.usage.tokens.input).toBe(10n);
  expect(timeline.pending(current).tokens.input).toBe(10n);
  expect(timeline.taskViews(current).find(task => task.present)?.usage.known).toBe(false);
});

test("only one exactly matching inferred goal adopts supplied identity and history", () => {
  const timeline = new Timeline();
  const current = view();
  const inferred = timeline.selectTask({ id: null, label: "Fix storage" }, []);
  timeline.checkpoint("turn", reading, current, 1);
  current.tokens.input = 8n;
  timeline.syncPlan(
    [{ name: "Build", tasks: [{ content: "Fix storage", status: "blocked", blocker: "Access" }] }],
    current,
    2,
  );
  expect(timeline.tasks).toMatchObject([{ id: inferred, source: "agent", blocker: "Access" }]);
  expect(timeline.current_task).toBe(inferred);
  expect(timeline.taskViews(current)[0].usage.tokens.input).toBe(8n);
  expect(() => timeline.selectTask({ id: inferred, label: "Something else" }, [])).toThrow("InvalidTaskSelection");
  expect(() => timeline.selectTask({ id: null, label: "Invent a goal" }, [])).toThrow("InvalidTaskSelection");
  expect(() => timeline.selectTask({ id: inferred, label: null }, [inferred!])).toThrow("InvalidTaskSelection");
  timeline.syncPlan([{ name: "Build", tasks: [{ content: "Repair storage", status: "pending" }] }], current, 3);
  expect(timeline.tasks.find(task => task.present)?.id).not.toBe(inferred);
  expect(timeline.points[0].task_id).toBe(inferred);
});

test("ambiguous duplicate task labels never inherit a formerly unique identity", () => {
  const timeline = new Timeline();
  const current = view();
  timeline.syncPlan([{ name: "", tasks: [{ content: "Check", status: "pending" }] }], current, 1);
  const original = timeline.tasks[0].id;
  timeline.selectTask({ id: original, label: null }, []);
  timeline.checkpoint("turn", reading, current, 2);
  const duplicate = [
    {
      name: "",
      tasks: [
        { content: "Check", status: "pending" as const },
        { content: "Check", status: "pending" as const },
      ],
    },
  ];
  timeline.syncPlan(duplicate, current, 3);
  expect(timeline.tasks.filter(task => task.present).every(task => task.id !== original)).toBe(true);
  const stable = timeline.taskContext();
  timeline.syncPlan(duplicate, current, 4);
  expect(timeline.taskContext()).toEqual(stable);
});

test("evicted activity detail retains exact goal token and count rollups", () => {
  const timeline = new Timeline();
  const current = new View({ known: true, counts_known: true });
  const id = timeline.selectTask({ id: null, label: "Implement storage" }, []);
  for (let i = 0; i < 40; i++) {
    timeline.checkpoint(String(i), reading, current, i);
    current.tokens.input += 3n;
    current.turns++;
    current.tools += 2n;
  }
  expect(timeline.len).toBe(16);
  expect(timeline.retired[id!].tokens.input).toBe(72n);
  expect(timeline.taskViews(current)[0].usage).toMatchObject({
    tokens: { input: 120n },
    turns: 40n,
    tools: 80n,
    counts_known: true,
    partial: false,
  });
  expect(timeline.taskViews(current)[0].usage.tokens.input).toBe(120n);
});

test("task contexts are isolated and invalid completion updates are atomic", () => {
  const timeline = new Timeline();
  const id = timeline.selectTask({ id: null, label: "A goal" }, []);
  const context = timeline.taskContext();
  context.tasks[0].label = "External mutation";
  expect(timeline.tasks[0].label).toBe("A goal");
  expect(() => timeline.selectTask({ id, label: "Renamed" }, ["missing"])).toThrow("InvalidTaskSelection");
  expect(timeline.tasks[0]).toMatchObject({ label: "A goal", status: null });
  timeline.selectTask({ id, label: null }, [id!]);
  timeline.selectTask({ id, label: null }, []);
  expect(timeline.tasks[0].status).toBe("completed");
});

test("registry bounds omit old headers honestly and repeated large plans do not inflate omissions", () => {
  const timeline = new Timeline();
  const current = view();
  for (let i = 0; i < 140; i++) {
    timeline.selectTask({ id: null, label: `Goal ${i}` }, []);
    timeline.checkpoint(String(i), reading, current, i);
  }
  expect(timeline.tasks.length).toBe(128);
  expect(timeline.omitted_tasks).toBe(12);
  expect(timeline.points.every(point => timeline.tasks.some(task => task.id === point.task_id))).toBe(true);
  const plan = [
    { name: "", tasks: Array.from({ length: 70 }, (_, i) => ({ content: `Plan ${i}`, status: "pending" as const })) },
  ];
  timeline.syncPlan(plan, current, 150);
  const context = timeline.taskContext(),
    omitted = timeline.omitted_tasks;
  expect(timeline.tasks.filter(task => task.present).length).toBe(64);
  expect(timeline.plan_omitted).toBe(6);
  timeline.syncPlan(plan, current, 151);
  expect(timeline.omitted_tasks).toBe(omitted);
  expect(timeline.taskContext()).toEqual(context);
});

test("strict live restore preserves methods, retired ownership, and monotonic identity", () => {
  const timeline = new Timeline();
  const current = new View({ known: true, counts_known: true });
  const id = timeline.selectTask({ id: null, label: "Keep history" }, []);
  for (let i = 0; i < 20; i++) {
    timeline.checkpoint(String(i), reading, current, i);
    current.tokens.input++;
  }
  const serialized = JSON.parse(
    JSON.stringify(timeline, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
  );
  const restored = Timeline.restore(serialized);
  expect(restored.taskContext()).toEqual(timeline.taskContext());
  expect(restored.taskViews(current)[0].usage.tokens.total()).toBe(20n);
  expect(restored.points[0].label.text()).toBe("Reading source");
  expect(restored.selectTask({ id: null, label: "Next goal" }, [])).not.toBe(id);
  expect(Timeline.restore(undefined).taskContext().tasks).toEqual([]);
  for (const invalid of [
    { ...serialized, next_id: 1 },
    { ...serialized, revision: -1 },
    { ...serialized, current_task: "task-999" },
    { ...serialized, tasks: [...serialized.tasks, ...serialized.tasks] },
    { ...serialized, points: [{ ...serialized.points[0], task_id: "task-999" }] },
    { ...serialized, baseline: { ...serialized.baseline, tools: "-1" } },
    { ...serialized, retired: { "task-999": serialized.baseline } },
  ])
    expect(() => Timeline.restore(invalid)).toThrow("InvalidCheckpoint");
});

test("empty provider snapshots leave inferred work active and completion remains evidence-only", () => {
  const timeline = new Timeline();
  const current = view();
  const id = timeline.selectTask({ id: null, label: "Investigate storage" }, []);
  timeline.checkpoint("turn", reading, current, 1);
  timeline.syncPlan([], current, 2);
  expect(timeline.current_task).toBe(id);
  expect(timeline.points.map(point => point.task_id)).toEqual([id]);
  expect(timeline.tasks[0].status).toBe("in_progress");
  timeline.finish(current);
  expect(timeline.tasks[0].status).toBe("in_progress");
});

test("a plan arriving before first activity leaves prior usage unassigned", () => {
  const timeline = new Timeline();
  const current = view(25n);
  timeline.syncPlan([{ name: "", tasks: [{ content: "Storage", status: "in_progress" }] }], current, 1);
  const id = timeline.tasks[0].id;
  timeline.selectTask({ id, label: null }, []);
  timeline.checkpoint("turn", reading, current, 2);
  current.tokens.input = 30n;
  expect(timeline.points[0]).toMatchObject({ task_id: null, usage: { tokens: { input: 25n } } });
  expect(timeline.taskViews(current)[0].usage.tokens.input).toBe(5n);
});

test("changes in omitted plan goals invalidate snapshots without multiplying omissions", () => {
  const timeline = new Timeline();
  const plan = [
    {
      name: "",
      tasks: Array.from({ length: 65 }, (_, i) => ({
        content: `Goal ${i}`,
        status: "pending" as const,
      })),
    },
  ];
  timeline.syncPlan(plan, view(), 1);
  const revision = timeline.revision;
  plan[0].tasks[64].content = "Different goal";
  timeline.syncPlan(plan, view(), 2);
  expect(timeline.revision).toBeGreaterThan(revision);
  expect(timeline.omitted_tasks).toBe(1);
  const serialized = JSON.parse(
    JSON.stringify(timeline, (_, value) => (typeof value === "bigint" ? value.toString() : value)),
  );
  const restored = Timeline.restore(serialized);
  restored.syncPlan(plan, view(), 3);
  expect(restored.taskContext()).toEqual(timeline.taskContext());
});

test("plan removal closes an interval even after an unmatched selection", () => {
  const timeline = new Timeline();
  const current = view();
  timeline.syncPlan([{ name: "", tasks: [{ content: "Storage", status: "pending" }] }], current, 1);
  const id = timeline.tasks[0].id;
  timeline.selectTask({ id, label: null }, []);
  timeline.checkpoint("turn", reading, current, 2);
  timeline.selectTask({ id: null, label: null }, []);
  current.tokens.input = 10n;
  timeline.syncPlan([], current, 3);
  current.tokens.input = 20n;
  expect(timeline.points.map(point => point.task_id)).toEqual([id, null]);
  expect(timeline.taskViews(current)[0].usage.tokens.input).toBe(10n);
});

test("legacy activity-only restoration defaults ownership without inventing goals", () => {
  const timeline = new Timeline();
  timeline.checkpoint("turn", reading, view(5n), 1);
  const restored = Timeline.restore({
    points: timeline.points.map(({ task_id, ...point }) => ({ ...point, label: point.label.toJSON() })),
    baseline: timeline.baseline,
    turn: timeline.turn.toJSON(),
    open: timeline.open,
  });
  expect(restored.points[0].task_id).toBeNull();
  expect(restored.taskViews(view(8n))).toEqual([]);
  expect(restored.pending(view(8n)).tokens.total()).toBe(8n);
});

test("inferred activity starts on a checkpoint, never from selection alone or over explicit completion", () => {
  const timeline = new Timeline();
  const current = view();
  const id = timeline.selectTask({ id: null, label: "Investigate storage" }, []);
  expect(timeline.tasks[0].status).toBeNull();
  timeline.selectTask({ id, label: null }, []);
  expect(timeline.tasks[0].status).toBeNull();
  timeline.checkpoint("turn", reading, current, 1);
  expect(timeline.tasks[0].status).toBe("in_progress");
  timeline.selectTask({ id, label: null }, [id!]);
  timeline.amend("turn", testing, current, 2);
  expect(timeline.tasks[0].status).toBe("completed");
});
