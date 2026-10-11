import { test, expect } from "bun:test";
import { Worker, Request, Result, Slot } from "./worker";
import { Text, parseLabel, hash } from "./summary";
import { Registry, Attachment, Actor } from "../conversations";
import { View as ToolView } from "./tools";
import { clone } from "../json";
test("worker live checkpoint preserves queued link evidence and unconsumed results", () => {
  const worker = new Worker("off");
  worker.paused = true;
  const request = new Request();
  request.actor = 6;
  request.evidence = new Text("Tracing focus");
  request.conversation.remember("turn", "Tracing focus", parseLabel("Tracing focus")!);
  const slot = new Slot(request);
  slot.result = new Result(request, parseLabel("Tracing pane focus"), "amend");
  worker.slots[2] = slot;
  const key = {
    workspace: 1,
    pane: 3,
    pid: 7,
    port: 3000,
    scheme: "http",
    address: 9,
  };
  worker.link_requests[4] = {
    slot: 4,
    generation: 8n,
    key,
    evidence: '{"terminal":"Finance dashboard ready"}',
  } as any;
  worker.link_results[5] = {
    slot: 5,
    generation: 9n,
    key,
    name: parseLabel("Finance dashboard"),
  } as any;
  const restored = Worker.restore(clone(worker.capture()));
  try {
    expect(restored.link_requests[4]?.evidence).toBe('{"terminal":"Finance dashboard ready"}');
    const link = restored.takeLinks()[5]!;
    expect(link.name?.text()).toBe("Finance dashboard");
    expect(link.generation).toBe(9n);
    expect(typeof link.key.address).toBe("bigint");
    expect(restored.takeLinks()[5]).toBeNull();
    expect(restored.link_requests[4]).not.toBeNull();
    expect(restored.slots[2]?.request.conversation.phase("turn")).toBe("Tracing focus");
    const result = restored.take()[0];
    expect(result.label?.text()).toBe("Tracing pane focus");
    expect(result.action).toBe("amend");
    expect(restored.take().length).toBe(0);
    expect(restored.slots[2]?.request.evidence.text()).toBe("Tracing focus");
  } finally {
    worker.stop();
    restored.stop();
  }
});

test("commentary refreshes after the cooldown and tool bursts wait until quiet", () => {
  const slot = new Slot(new Request());
  expect(slot.ready(0, false)).toBe(false);
  slot.commentary = new Text("Planning the fix");
  slot.combine();
  expect(slot.ready(0, false)).toBe(true);
  slot.attempt(0);
  expect(slot.ready(9000, false)).toBe(false);
  slot.commentary = new Text("Adding the tests");
  slot.combine();
  expect(slot.ready(7999, false)).toBe(false);
  expect(slot.ready(8000, false)).toBe(true);
  slot.attempt(10000);
  slot.updateTools(new Text("exec: rg focus src\n"), 11000);
  slot.updateTools(new Text("exec: rg focus src\nexec: zig build test\n"), 17000);
  expect(slot.ready(21999, false)).toBe(false);
  expect(slot.ready(22000, false)).toBe(true);
  slot.attempt(22000);
  let at = 23000;
  let flip = false;
  for (; at < 53000; at += 2000) {
    flip = !flip;
    slot.updateTools(new Text(flip ? "exec: a\n" : "exec: b\n"), at);
    expect(slot.ready(at, false)).toBe(false);
  }
  expect(slot.ready(at, false)).toBe(true);
  slot.attempt(at);
  slot.updateTools(slot.tool_evidence, at + 1000);
  expect(slot.ready(at + 30000, false)).toBe(false);
  slot.retry = true;
  slot.next = at + 60000;
  expect(slot.ready(at + 59999, false)).toBe(false);
  expect(slot.ready(at + 60000, false)).toBe(true);
  slot.active = false;
  expect(slot.ready(at + 60000, false)).toBe(false);
});

test("without a viewer each agent is summarized at most once a minute", () => {
  const slot = new Slot(new Request());
  slot.commentary = new Text("Planning the fix");
  slot.combine();
  expect(slot.ready(0, true)).toBe(true);
  slot.attempt(0);
  slot.commentary = new Text("Adding the tests");
  slot.combine();
  expect(slot.ready(8000, false)).toBe(true);
  expect(slot.ready(59999, true)).toBe(false);
  expect(slot.ready(60000, true)).toBe(true);
});

test("summary slots belong to conversations shared by multiple or detached attachments", () => {
  const registry = new Registry();
  const actor = registry.get("codex", "shared");
  actor.state.state = "working";
  actor.state.setTurn("turn-1");
  const first = new Attachment();
  const second = new Attachment();
  first.select(actor);
  second.select(actor);
  const worker = new Worker();
  try {
    worker.submit(first.actor!, new Text(), null, []);
    worker.submit(second.actor!, new Text(), null, []);
    expect(worker.slots.filter(Boolean).length).toBe(1);
    first.detach();
    second.detach();
    worker.reconcile(registry.items);
    expect(worker.slots[0]?.request.actor).toBe(actor.id);
    actor.state.state = "idle";
    worker.reconcile(registry.items);
    expect(worker.slots[0]).toBeNull();
  } finally {
    worker.stop();
  }
});

test("summary slots exist only while their conversation is working", () => {
  const registry = new Registry();
  const stays = registry.get("codex", "stays");
  const stops = registry.get("codex", "stops");
  for (const actor of [stays, stops]) {
    actor.state.state = "working";
    actor.state.setTurn("turn-1");
  }
  const worker = new Worker();
  try {
    expect(worker.slots.filter(Boolean).length).toBe(0);
    worker.submit(stays, new Text(), null, []);
    worker.submit(stops, new Text(), null, []);
    expect(worker.slots.filter(Boolean).length).toBe(2);
    stops.state.state = "idle";
    worker.reconcile(registry.items);
    expect(worker.slots.filter(Boolean).length).toBe(1);
    expect(worker.slots[0]?.request.actor).toBe(stays.id);
  } finally {
    worker.stop();
  }
});

test("late results cannot overwrite another turn or changed evidence", () => {
  const actor = new Registry().get("codex", "s");
  const agent = actor.state;
  agent.state = "working";
  agent.setTurn("t");
  const evidence = new Text("Checking input");
  agent.activity_generation = hash(evidence);
  const request = Object.assign(new Request(), {
    actor: actor.id,
    provider: "codex",
    session: agent.session,
    turn: agent.turn,
    turn_epoch: agent.turn_epoch,
    evidence,
    generation: hash(evidence),
  });
  const result = new Result(request, parseLabel("Checking input"));
  expect(result.apply(actor)).toBe(true);
  agent.activity_generation++;
  expect(result.apply(actor)).toBe(false);
  agent.activity_generation = hash(evidence);
  agent.state = "idle";
  expect(result.apply(actor)).toBe(false);
  agent.state = "working";
  expect(result.apply(actor)).toBe(true);
  agent.beginTurn("u");
  expect(result.apply(actor)).toBe(false);
  agent.setTurn("t");
  expect(result.apply(actor)).toBe(false);
});

test("the first summary of a turn sees the tools read with its commentary", () => {
  const actor = new Registry().get("codex", "s");
  actor.state.state = "working";
  actor.state.setTurn("turn-1");
  const progress = new ToolView();
  progress.turn = new Text("turn-1");
  progress.completed = 3n;
  progress.commentary = new Text("Latest agent update: Tracing focus from the transcript.");
  progress.evidence = new Text("Recent completed tools (oldest to newest):\nexec_command: rg focus src\n");
  const worker = new Worker();
  try {
    worker.submit(actor, progress.commentary, progress, []);
    const slot = worker.slots[0]!;
    expect(slot.ready(Date.now(), false)).toBe(true);
    expect(slot.request.evidence.text()).toContain("exec_command: rg focus src");
    expect(slot.request.evidence.text().endsWith("Tracing focus from the transcript.")).toBe(true);
    expect(slot.request.completed_tools).toBe(3n);
  } finally {
    worker.stop();
  }
});

test("actor inference context survives turns and detachment but rejects stale results", () => {
  const registry = new Registry();
  const actor = registry.get("codex", "shared");
  actor.state.state = "working";
  actor.state.setTurn("turn-1");
  const evidence = new Text("Tracing focus changes");
  actor.state.activity_generation = hash(evidence);
  const worker = new Worker();
  try {
    worker.submit(actor, evidence, null, []);
    const first = worker.slots[0]!.request;
    const result = new Result(first, parseLabel("Tracing pane focus"));
    expect(result.apply(actor)).toBe(true);
    expect(actor.activity_timeline.len).toBe(1);
    actor.state.state = "idle";
    worker.reconcile(registry.items);
    expect(worker.slots[0]).toBeNull();
    actor.state.state = "working";
    actor.state.setTurn("turn-2");
    worker.submit(actor, evidence, null, []);
    const second = worker.slots[0]!.request;
    expect(first.conversation.key(actor.id)).toBe(second.conversation.key(actor.id));
    expect(second.conversation.len).toBe(1);
    expect(second.conversation.previous.text()).toBe("Tracing pane focus");
    expect(result.apply(actor)).toBe(false);
    expect(actor.activity_timeline.len).toBe(1);
    expect(actor.status_inference.len).toBe(1);
    const other = registry.get("codex", "different");
    expect(second.conversation.key(actor.id)).not.toBe(other.status_inference.key(other.id));
    for (let i = 0; i < 10; i++) actor.status_inference.remember("turn-2", "New evidence", result.label!);
    expect(actor.status_inference.len).toBe(4);
  } finally {
    worker.stop();
  }
});

test("inference completing during compaction waits to resume its timeline phase", () => {
  const actor = new Actor({ id: 1 });
  actor.state.provider = "codex";
  actor.state.state = "working";
  actor.observeHook(
    {
      kind: "compact_start",
      session: "",
      transcript: "",
      cwd: "",
      model: "",
      turn: "",
      prompt: "",
      tool: "",
      description: "",
      target: "",
    } as any,
    1,
    true,
    1000,
  );
  const request = Object.assign(new Request(), {
    actor: actor.id,
    provider: "codex",
    turn_epoch: actor.state.turn_epoch,
  });
  const result = new Result(request, parseLabel("Running tests"));
  expect(result.apply(actor)).toBe(true);
  expect(actor.activity_timeline.len).toBe(1);
  expect(actor.activity_timeline.points[0].label.text()).toBe("Compacting context");
  actor.observeHook(
    {
      kind: "compact_end",
      session: "",
      transcript: "",
      cwd: "",
      model: "",
      turn: "",
      prompt: "",
      tool: "",
      description: "",
      target: "",
    } as any,
    2,
    true,
    2000,
  );
  expect(actor.activity_timeline.points[1].label.text()).toBe("Running tests");
});

test("results keep, amend or start the turn's phase", () => {
  const actor = new Registry().get("codex", "s");
  const agent = actor.state;
  agent.state = "working";
  agent.setTurn("t");
  const evidence = new Text("Running tests");
  agent.activity_generation = hash(evidence);
  const request = Object.assign(new Request(), {
    actor: actor.id,
    provider: "codex",
    session: agent.session,
    turn: agent.turn,
    turn_epoch: agent.turn_epoch,
    evidence,
    generation: hash(evidence),
  });
  const apply = (label: string | null, action: "new" | "keep" | "amend" | "none") =>
    expect(new Result(request, label === null ? null : parseLabel(label), action).apply(actor)).toBe(true);
  const rows = () => actor.activity_timeline.points.map(p => p.label.text());
  apply("Running tests", "new");
  apply("Running tests", "keep");
  expect(rows()).toEqual(["Running tests"]);
  apply("Running unit tests", "amend");
  expect(rows()).toEqual(["Running unit tests"]);
  expect(actor.status_inference.phase("t")).toBe("Running unit tests");
  apply(null, "none");
  expect(agent.activity.text()).toBe("");
  expect(rows()).toEqual(["Running unit tests"]);
  apply("Running unit tests", "keep");
  expect(agent.activity.text()).toBe("Running unit tests");
  apply("Fixing failures", "new");
  expect(rows()).toEqual(["Running unit tests", "Fixing failures"]);
  expect(actor.status_inference.earlier("t")).toEqual(["Running unit tests"]);
});
