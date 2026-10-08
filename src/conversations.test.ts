import { View as LiveView, Tokens } from "./usage/live";
import { parseLabel } from "./activity/summary";
import { test, expect } from "bun:test";
import { Registry, Attachment, Actor } from "./conversations";
import { Agent, Text } from "./agents";
import { Snapshot, Child } from "./codex_observer";
import { View } from "./activity/tools";
import { Inventory, Ended } from "./activity/background_tasks";
import { Hooks } from "./providers/common";
test("child links cannot cross providers reparent or form cycles", () => {
  const r = new Registry(),
    root = r.get("codex", "root"),
    child = r.get("codex", "child"),
    nested = r.get("codex", "nested"),
    other = r.get("codex", "other"),
    claude = r.get("claude", "root");
  root.workspace = 7;
  root.tracked_since = 100;
  expect(r.linkChild(root, child)).toBe(true);
  expect(r.linkChild(child, nested)).toBe(true);
  expect(nested.workspace).toBe(7);
  expect(nested.tracked_since).toBe(100);
  expect(r.linkChild(nested, root)).toBe(false);
  expect(r.linkChild(other, child)).toBe(false);
  expect(r.linkChild(claude, child)).toBe(false);
  expect(r.linkChild(root, root)).toBe(false);
});
test("attachments select stable actors and delayed hooks never change selection", () => {
  const r = new Registry(),
    b = new Attachment(),
    h = new Hooks(),
    first = h.decode({ hook_event_name: "SessionStart", session_id: "a" })!,
    second = h.decode({ hook_event_name: "SessionStart", session_id: "b" })!;
  const a = r.routeHook(b, "claude", first)!;
  const generation = b.generation;
  expect(b.matches(generation, a.id)).toBe(true);
  const c = r.routeHook(b, "claude", second)!;
  expect(b.actor).toBe(c);
  expect(r.routeHook(b, "claude", { ...first, kind: "tool_start" })).toBe(a);
  expect(b.actor).toBe(c);
  b.detach();
  expect(b.knows(a.id)).toBe(false);
  expect(b.actor).toBeNull();
});
test("Codex tools survive snapshots but never leak into another turn", () => {
  const actor = new Actor({ id: 1 }),
    request = {
      pane: 0,
      pid: 0,
      prefix: new Text(),
      actor: 0,
      generation: 0n,
      title_revision: 0n,
    },
    snap = new Snapshot(request, "01901234-1234-1234-1234-123456789abc", "working");
  snap.turn = new Text("a");
  snap.observed_at = 1;
  actor.observeSnapshot(snap, true, 0);
  const tools = new View();
  tools.turn = new Text("a");
  tools.running = 1;
  actor.observeTools(tools);
  snap.observed_at++;
  actor.observeSnapshot(snap, true, 0);
  expect(actor.state.tool_active).toBe(true);
  tools.running = 0;
  actor.observeTools(tools);
  expect(actor.state.tool_active).toBe(false);
  snap.background_tasks.append("build", "", "zig build");
  snap.observed_at++;
  actor.observeSnapshot(snap, true, 0);
  expect(actor.state.tool_active).toBe(true);
  snap.state = "idle";
  snap.observed_at++;
  actor.observeSnapshot(snap, true, 0);
  expect(actor.state.tool_active).toBe(false);
  snap.state = "working";
  snap.turn = new Text("b");
  snap.background_tasks = new Inventory();
  snap.observed_at++;
  actor.observeSnapshot(snap, true, 0);
  tools.running = 1;
  actor.observeTools(tools);
  expect(actor.state.tool_active).toBe(false);
});
test("Claude background Agent launch owns a live child until complete stop census", () => {
  const r = new Registry(),
    parent = r.get("claude", "s"),
    h = new Hooks();
  parent.pid = process.pid;
  r.observeHook(
    parent,
    h.decode({
      hook_event_name: "PostToolUse",
      session_id: "s",
      tool_name: "Agent",
      tool_input: { description: "Lane A", subagent_type: "Explore" },
      tool_response: { status: "async_launched", agentId: "a1" },
    }),
    1,
    false,
    1000,
  );
  const child = r.find("claude", "a1")!;
  expect(child.parent).toBe(parent.id);
  expect(parent.state.subagents.running).toBe(1);
  r.observeHook(
    parent,
    h.decode({
      hook_event_name: "Stop",
      session_id: "s",
      background_tasks: [{ id: "a1", type: "subagent", status: "running" }],
    }),
    2,
    false,
    2000,
  );
  expect(parent.state.subagents.waiting).toBe(true);
  expect(parent.state.observation.pending_stop).toBe(false);
  r.observeHook(
    parent,
    h.decode({
      hook_event_name: "Stop",
      session_id: "s",
      background_tasks: [],
    }),
    3,
    false,
    3000,
  );
  expect(child.state.state).toBe("idle");
  expect(parent.state.observation.pending_stop).toBe(true);
});

function hook(kind: string, session: string, extra: any = {}) {
  return {
    kind,
    session,
    turn: "",
    prompt: "",
    transcript: "",
    cwd: "",
    model: "",
    tool: "",
    description: "",
    target: "",
    background_tasks: null,
    session_crons: null,
    subagent: "",
    asking: false,
    permission_notification: false,
    ...extra,
  };
}
function snapshot(state: "idle" | "working" | "blocked", at = 1) {
  const result = new Snapshot(
    {
      pane: 0,
      pid: 0,
      prefix: new Text(),
      actor: 0,
      generation: 0n,
      title_revision: 0n,
    },
    "01901234-1234-1234-1234-123456789abc",
    state,
  );
  result.observed_at = at;
  return result;
}
test("first hook establishes identity without process detection but cannot revive a replaced source", () => {
  const registry = new Registry(),
    binding = new Attachment(),
    event = hook("prompt", "hook-only");
  const actor = registry.routeHook(binding, "claude", event)!;
  actor.observeHook(event, 1, false, 100);
  expect(binding.agent().state).toBe("working");
  binding.detach();
  expect(registry.routeHook(binding, "claude", event)).toBeNull();
  expect(registry.items.length).toBe(1);
});
test("screen fallback keeps following work after a structured observation expires", () => {
  const actor = new Registry().get("codex", "resumed");
  Object.assign(actor.state, {
    last_seq: 100,
    protocol_at: 100,
    state: "idle",
  });
  actor.observed_at = 100;
  actor.state.observation.source = "protocol";
  const status = new Agent();
  status.state = "working";
  status.observation.source = "screen";
  actor.screen(status, false, 200);
  expect(actor.state.state).toBe("idle");
  const stale = 6000100;
  status.state = "idle";
  actor.screen(status, false, stale);
  expect(actor.authoritative(stale + 1)).toBe(false);
  status.state = "working";
  actor.screen(status, false, stale + 1);
  expect(actor.state.state).toBe("working");
  status.state = "idle";
  actor.screen(status, false, stale + 2);
  expect(actor.state.state).toBe("idle");
  expect(actor.state.observation.completed).toBe(0n);
});
test("ignored hooks and attachment metadata cannot refresh protocol lifecycle evidence", () => {
  const actor = new Registry().get("codex", "resumed");
  Object.assign(actor.state, {
    state: "idle",
    last_seq: 100,
    protocol_at: 100,
  });
  actor.observed_at = 100;
  actor.state.observation.source = "protocol";
  const event = hook("session_start", "resumed", {
    transcript: "/tmp/new-path",
  });
  actor.observeHook(event, 99, false, 4000000);
  expect(actor.observed_at).toBe(100);
  expect(actor.state.transcript.len).toBe(0);
  event.session = "wrong-session";
  actor.observeHook(event, 101, false, 4000000);
  expect(actor.observed_at).toBe(100);
  event.session = "resumed";
  actor.observeHook(event, 101, false, 4000000);
  expect(actor.state.transcript.text()).toBe("/tmp/new-path");
  expect(actor.observed_at).toBe(4000000);
  expect(actor.authoritative(6000000)).toBe(false);
});
test("protocol authority ages on the daemon clock, not the observer's stamp", () => {
  const actor = new Actor({ id: 1 }),
    observation = snapshot("working");
  const applied = 50000000;
  actor.observeSnapshot(observation, true, applied);
  expect(actor.authoritative(applied + 5000000)).toBe(true);
  expect(actor.authoritative(applied + 5000001)).toBe(false);
});
test("snapshot baseline and completion receipts are idempotent", () => {
  const actor = new Actor({ id: 1 }),
    observation = snapshot("idle");
  observation.turn = new Text("a");
  observation.outcome = "completed";
  expect(actor.observeSnapshot(observation, false, 0)).toBe(false);
  expect(actor.state.observation.completed).toBe(0n);
  expect(actor.state.observation.unread()).toBe(false);
  observation.turn = new Text("b");
  observation.observed_at = 2;
  expect(actor.observeSnapshot(observation, false, 0)).toBe(true);
  expect(actor.observeSnapshot(observation, false, 0)).toBe(false);
  observation.observed_at++;
  expect(actor.observeSnapshot(observation, false, 0)).toBe(false);
  expect(actor.state.observation.completed).toBe(1n);
});
test("a snapshot completion records history without overriding active or blocked state", () => {
  for (const state of ["working", "blocked"] as const) {
    const actor = new Actor({ id: 1 }),
      observation = snapshot("working");
    observation.turn = new Text("a");
    expect(actor.observeSnapshot(observation, false, 0)).toBe(false);
    observation.state = state;
    observation.outcome = "completed";
    observation.observed_at = 2;
    expect(actor.observeSnapshot(observation, false, 0)).toBe(true);
    expect(actor.state.state).toBe(state);
    expect(actor.state.observation.completed).toBe(1n);
    expect(actor.state.attention).toBe(state === "blocked" ? "needs_input" : "finished");
    actor.acknowledge(1n, null);
    observation.observed_at = 3;
    expect(actor.observeSnapshot(observation, true, 0)).toBe(false);
    expect(actor.state.observation.unread()).toBe(false);
    expect(actor.state.state).toBe(state);
  }
});
test("delayed hook endings and transcript confirmations cannot stop resumed work", () => {
  const actor = new Registry().get("claude", "a");
  actor.observeHook(hook("prompt", "a", { turn: "old" }), 1, false, 10);
  actor.observeHook(hook("stop", "a", { turn: "old" }), 2, false, 20);
  expect(actor.state.observation.pending_stop).toBe(true);
  actor.observeHook(hook("prompt", "a", { turn: "new" }), 3, false, 30);
  expect(actor.confirmStop(2, "completed", 40)).toBe(false);
  for (const kind of ["stop", "interrupt"]) {
    expect(actor.observeHook(hook(kind, "a", { turn: "old" }), 4, false, 50)).toBe(false);
    expect(actor.state.state).toBe("working");
    expect(actor.state.turnId()).toBe("new");
    expect(actor.observed_at).toBe(30);
    expect(actor.state.observation.pending_stop).toBe(false);
    expect(actor.state.observation.completed).toBe(0n);
  }
  actor.observeHook(hook("stop", "a", { turn: "new" }), 5, false, 60);
  expect(actor.confirmStop(5, "completed", 70)).toBe(true);
  expect(actor.state.observation.completed).toBe(1n);
});
test("hook models replace the transcript model and survive events without one", () => {
  const actor = new Registry().get("codex", "a");
  actor.observeHook(hook("prompt", "a", { model: "gpt-6-astra" }), 1, false, 10);
  expect(actor.model.id.text()).toBe("gpt-6-astra");
  expect(actor.model_from_hook).toBe(true);
  actor.observeHook(hook("tool_start", "a", { tool: "Bash" }), 2, false, 20);
  expect(actor.model.id.text()).toBe("gpt-6-astra");
  actor.observeHook(hook("prompt", "a", { model: "gpt-6-luna" }), 3, false, 30);
  expect(actor.model.id.text()).toBe("gpt-6-luna");
  actor.observeHook(hook("prompt", "b", { model: "gpt-6-sol" }), 4, false, 40);
  expect(actor.model.id.text()).toBe("gpt-6-luna");
});
test("Codex hooks cannot establish or switch a pane identity", () => {
  const registry = new Registry(),
    binding = new Attachment(),
    event = hook("session_start", "a");
  expect(registry.routeHook(binding, "codex", event)).toBeNull();
  expect(registry.items.length).toBe(0);
  const a = registry.get("codex", "a"),
    b = registry.get("codex", "b");
  binding.select(a);
  binding.select(b);
  b.state.state = "done";
  expect(registry.routeHook(binding, "codex", event)).toBe(a);
  expect(binding.actor).toBe(b);
  binding.detach();
  expect(registry.routeHook(binding, "codex", event)).toBeNull();
});

function compactHook(kind: "compact_start" | "compact_end" | "session_start" | "tool_start") {
  return {
    kind,
    session: "",
    turn: "",
    prompt: "",
    transcript: "",
    cwd: "",
    model: "",
    tool: "",
    description: "",
    target: "",
  } as any;
}

test("compaction hooks partition usage and preserve the summary through repeated or stale events", () => {
  const actor = new Actor({
    id: 1,
    state: new Agent({ provider: "codex", state: "working" }),
  });
  actor.state.setActivity("Reading source");
  actor.activity_timeline.checkpoint("", parseLabel("Reading source")!, new LiveView(), 1);
  actor.live_usage = new LiveView({
    known: true,
    tokens: new Tokens({ input: 100n }),
  });
  actor.observeHook(compactHook("compact_start"), 1, true, 2000);
  expect(actor.state.activity.text()).toBe("Reading source");
  expect(actor.activity_timeline.points[1].label.text()).toBe("Compacting context");
  expect(actor.activity_timeline.points[0].usage.tokens.input).toBe(100n);
  actor.observeHook(compactHook("compact_start"), 2, true, 3000);
  actor.observeHook(compactHook("compact_end"), 1, true, 4000);
  expect(actor.state.compacting).toBe(true);
  expect(actor.activity_timeline.len).toBe(2);
  expect(actor.activity_timeline.points[1].at).toBe(2);
  actor.live_usage.tokens.input = 160n;
  actor.observeHook(compactHook("compact_end"), 3, true, 5000);
  expect(actor.activity_timeline.points[2].label.text()).toBe("Reading source");
  expect(actor.activity_timeline.points[1].usage.tokens.input).toBe(60n);
  expect(actor.activity_timeline.pending(actor.live_usage).tokens.input).toBe(0n);
});

test("terminal compaction supplements protocol state without clearing hook compaction", () => {
  const actor = new Actor({
    id: 1,
    state: new Agent({ provider: "codex", state: "working", last_seq: 100 }),
  });
  actor.state.observation.source = "protocol";
  actor.observeCompactionScreen(true, 1000);
  expect(actor.state.compacting).toBe(true);
  expect(actor.authoritative(1001)).toBe(true);
  expect(actor.activity_timeline.len).toBe(1);
  actor.observeCompactionScreen(null, 2000);
  expect(actor.state.compacting).toBe(true);
  actor.observeHook(compactHook("session_start"), 101, true, 2100);
  actor.live_usage = new LiveView({
    known: true,
    tokens: new Tokens({ input: 60n }),
  });
  actor.observeCompactionScreen(false, 3000);
  expect(actor.state.compacting).toBe(false);
  actor.live_usage.tokens.input = 100n;
  expect(actor.activity_timeline.pending(actor.live_usage).tokens.input).toBe(60n);
  actor.observeHook(compactHook("compact_start"), 101, true, 4000);
  actor.observeCompactionScreen(false, 5000);
  expect(actor.state.compacting).toBe(true);
  actor.observeHook(compactHook("tool_start"), 102, true, 6000);
  expect(actor.state.compacting).toBe(false);
});

test("selection preserves conversation receipts and shared acknowledgement", () => {
  const registry = new Registry();
  const a = registry.get("codex", "a");
  const b = registry.get("codex", "b");
  const first = new Attachment();
  const second = new Attachment();
  first.select(a);
  second.select(a);
  a.state.observation.finish("completed", "protocol");
  const old = first.generation;
  first.select(b);
  expect(first.matches(old, a.id)).toBe(false);
  expect(first.agent().observation.completed).toBe(0n);
  expect(second.agent().observation.unread()).toBe(true);
  a.acknowledge(1n, null);
  first.select(a);
  expect(first.agent().observation.unread()).toBe(false);
  expect(second.agent().observation.unread()).toBe(false);
  expect(a).not.toBe(registry.get("claude", "a"));
});

test("known background hooks route to their actor and process replacement revokes routing", () => {
  const registry = new Registry();
  const binding = new Attachment();
  const actor = registry.get("claude", "a");
  binding.select(actor);
  binding.select(registry.get("claude", "b"));
  const hook = new Hooks().decode({
    hook_event_name: "UserPromptSubmit",
    session_id: "a",
  })!;
  expect(registry.routeHook(binding, "claude", hook)).toBe(actor);
  actor.observeHook(hook, 1, false, 100);
  expect(actor.state.state).toBe("working");
  expect(binding.agent().sessionId()).toBe("b");
  binding.detach();
  expect(registry.routeHook(binding, "claude", hook)).toBeNull();
});

test("a known conversation's live hook replaces an ended selection", () => {
  const registry = new Registry();
  const binding = new Attachment();
  const hooks = new Hooks();
  const start = hooks.decode({
    hook_event_name: "SessionStart",
    session_id: "child",
  })!;
  const end = hooks.decode({
    hook_event_name: "SessionEnd",
    session_id: "child",
  })!;
  const prompt = hooks.decode({
    hook_event_name: "UserPromptSubmit",
    session_id: "parent",
  })!;
  const other = hooks.decode({
    hook_event_name: "UserPromptSubmit",
    session_id: "other",
  })!;
  const parent = registry.get("claude", "parent");
  binding.select(parent);
  const child = registry.routeHook(binding, "claude", start)!;
  child.observeHook(end, 1, false, 100);
  expect(child.state.state).toBe("done");
  registry.routeHook(binding, "claude", end);
  expect(binding.actor).toBe(child);
  registry.get("claude", "other");
  expect(registry.routeHook(binding, "claude", other)).toBeNull();
  expect(binding.actor).toBe(child);
  expect(registry.routeHook(binding, "claude", prompt)).toBe(parent);
  expect(binding.actor).toBe(parent);
});

test("a second attachment does not erase a stop awaiting transcript confirmation", () => {
  const registry = new Registry();
  const actor = registry.get("claude", "shared");
  const hooks = new Hooks();
  const stop = hooks.decode({ hook_event_name: "Stop", session_id: "shared" })!;
  actor.observeHook(stop, 10, false, 100);
  const start = hooks.decode({
    hook_event_name: "SessionStart",
    session_id: "shared",
  })!;
  const binding = new Attachment();
  expect(registry.routeHook(binding, "claude", start)).toBe(actor);
  actor.observeHook(start, 11, false, 101);
  expect(actor.state.observation.pending_stop).toBe(true);
  expect(actor.confirmStop(10, "completed", 102)).toBe(true);
  expect(actor.state.observation.completed).toBe(1n);
  expect(actor.confirmStop(10, "completed", 103)).toBe(false);
});

test("child metadata is ordered by the observer's stamp and aged on the daemon clock", () => {
  const registry = new Registry();
  const session = "01901234-1234-1234-1234-123456789abc";
  const parent = registry.get("codex", session);
  const snapshot = new Snapshot({ prefix: new Text() } as any, session, "working");
  snapshot.children = [
    Object.assign(new Child(), {
      session: "01901234-1234-1234-1234-123456789abd",
      name: new Text("Child"),
      state: "working" as const,
    }),
  ];
  snapshot.children_complete = true;
  snapshot.observed_at = 10;
  registry.observeChildren(parent, snapshot, 50000000);
  const child = registry.find("codex", snapshot.children[0].session)!;
  expect(child.state.metadata_protocol_at).toBe(10);
  expect(child.state.metadata_at).toBe(50000000);
  snapshot.observed_at = 9;
  registry.observeChildren(parent, snapshot, 50000001);
  expect(child.state.metadata_at).toBe(50000000);
});

test("a Claude subagent counts from its launch until a Stop's list leaves it out", () => {
  const registry = new Registry();
  const parent = registry.get("claude", "parent");
  const hooks = new Hooks();
  const lines = [
    {
      hook_event_name: "UserPromptSubmit",
      session_id: "parent",
      transcript_path: "/p/parent.jsonl",
    },
    {
      hook_event_name: "PostToolUse",
      session_id: "parent",
      tool_name: "Agent",
      tool_input: { description: "Lane A", subagent_type: "general-purpose" },
      tool_response: { status: "async_launched", agentId: "a1" },
    },
    {
      hook_event_name: "PostToolUse",
      session_id: "parent",
      tool_name: "Agent",
      tool_input: { description: "Lane B", subagent_type: "general-purpose" },
      tool_response: { status: "async_launched", agentId: "a2" },
    },
    {
      hook_event_name: "Stop",
      session_id: "parent",
      background_tasks: [
        {
          id: "a2",
          type: "subagent",
          status: "running",
          description: "Lane B",
          agent_type: "general-purpose",
        },
      ],
    },
  ].map(value => hooks.decode(value)!);
  registry.observeHook(parent, lines[0], 1, false, 100);
  registry.observeHook(parent, lines[1], 2, false, 200);
  expect(parent.state.state).toBe("working");
  expect(parent.state.subagents).toEqual({
    running: 1,
    blocked: 0,
    waiting: false,
  });
  expect(parent.children_observed_at).toBe(200);
  const a1 = registry.find("claude", "a1")!;
  expect(a1.parent).toBe(parent.id);
  expect(a1.state.state).toBe("working");
  expect(a1.state.activity.text()).toBe("Lane A");
  expect(a1.state.transcriptPath()).toBe("/p/parent/subagents/agent-a1.jsonl");
  registry.observeHook(parent, lines[1], 3, false, 300);
  expect(parent.state.subagents.running).toBe(1);
  registry.observeHook(parent, lines[2], 4, false, 400);
  expect(parent.state.subagents.running).toBe(2);
  registry.observeHook(parent, lines[3], 5, false, 500);
  expect(parent.state.subagents).toEqual({
    running: 1,
    blocked: 0,
    waiting: true,
  });
  expect(a1.state.state).toBe("idle");
});

test("a Claude session's end ends the subagents its last Stop listed", () => {
  const registry = new Registry();
  const parent = registry.get("claude", "parent");
  const hooks = new Hooks();
  const stop = hooks.decode({
    hook_event_name: "Stop",
    session_id: "parent",
    background_tasks: [{ id: "a1", type: "subagent", status: "running", description: "Lane A" }],
  })!;
  const end = hooks.decode({
    hook_event_name: "SessionEnd",
    session_id: "parent",
  })!;
  registry.observeHook(parent, stop, 1, false, 100);
  expect(registry.find("claude", "a1")!.state.state).toBe("working");
  registry.observeHook(parent, end, 2, false, 200);
  expect(parent.state.state).toBe("done");
  expect(parent.state.subagents).toEqual({
    running: 0,
    blocked: 0,
    waiting: false,
  });
  expect(registry.find("claude", "a1")!.state.state).toBe("idle");
});

test("a pause ends once the Claude process that held it is gone", () => {
  const actor = new Registry().get("claude", "s");
  const buffer = Buffer.alloc(1024 * 1024);
  expect(actor.checkPause(buffer)).toBe(false);
  actor.state.paused = true;
  actor.paused_for_wakeup = true;
  actor.pid = process.pid;
  expect(actor.checkPause(buffer)).toBe(true);
  expect(actor.state.paused).toBe(false);
});

const pauseHookRecords = [
  { hook_event_name: "UserPromptSubmit", session_id: "s" },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [{ id: "b1", type: "shell", status: "running", command: "bun run evals/run.ts" }],
    session_crons: [],
  },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [],
    session_crons: [{ id: "c1", schedule: "*/30 * * * *", recurring: true, prompt: "failsafe" }],
  },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [],
    session_crons: [{ id: "c2", schedule: "17 13 5 10 *", recurring: false, prompt: "check CI" }],
  },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [
      { id: "m1", type: "shell", status: "running" },
      { id: "a1", type: "subagent", status: "running", description: "Lane A" },
    ],
  },
  { hook_event_name: "SessionStart", session_id: "s", source: "resume" },
];

test("a Claude Stop pauses a conversation its shells or a wakeup can wake", () => {
  const registry = new Registry();
  const actor = registry.get("claude", "s");
  const hooks = pauseHookRecords.map(value => new Hooks().decode(value)!);
  const observe = (index: number, seq: number, now: number) =>
    registry.observeHook(actor, hooks[index], seq, false, now);
  // A process that can't be watched never pauses.
  observe(0, 1, 100);
  observe(1, 2, 200);
  expect(actor.state.paused).toBe(false);
  actor.pid = 4242;
  observe(0, 3, 300);
  // Its turn ends while a background command runs: finished, and paused.
  observe(1, 4, 400);
  expect(actor.state.paused).toBe(true);
  expect(actor.paused_for_wakeup).toBe(false);
  expect(actor.confirmStop(4, "completed", 410)).toBe(true);
  expect(actor.state.state).toBe("idle");
  expect(actor.state.attention).toBe("finished");
  expect(actor.state.paused).toBe(true);
  expect(actor.observeTranscriptTurn(0)).toBe(false);
  expect(actor.state.paused).toBe(true);
  expect(actor.observeTranscriptTurn(1)).toBe(true);
  expect(actor.state.paused).toBe(false);
  // A shell wakes it and the turn pauses again; any hook ends a pause.
  observe(0, 5, 500);
  observe(1, 6, 600);
  expect(actor.state.paused).toBe(true);
  observe(0, 7, 700);
  expect(actor.state.paused).toBe(false);
  expect(actor.state.state).toBe("working");
  // A recurring cron is not waited on.
  observe(2, 8, 800);
  expect(actor.state.paused).toBe(false);
  expect(actor.shells.len).toBe(0);
  // A one-shot wakeup is.
  observe(0, 9, 900);
  observe(3, 10, 1000);
  expect(actor.state.paused).toBe(true);
  expect(actor.paused_for_wakeup).toBe(true);
  // A resumed session runs none of the old process's tasks.
  observe(5, 11, 1100);
  expect(actor.state.paused).toBe(false);
  // Running subagents keep it working instead.
  observe(0, 12, 1200);
  observe(4, 13, 1300);
  expect(actor.state.paused).toBe(false);
  expect(actor.state.subagents.waiting).toBe(true);
});

const shellHookRecords = [
  { hook_event_name: "UserPromptSubmit", session_id: "s" },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [
      { id: "m1", type: "shell", status: "running", command: "tail -F ci.log" },
      { id: "b1", type: "shell", status: "running", command: "bun test" },
    ],
  },
  {
    hook_event_name: "Stop",
    session_id: "s",
    background_tasks: [{ id: "m2", type: "shell", status: "running" }],
    session_crons: [{ id: "c1", schedule: "0 9 * * *", recurring: false, prompt: "go" }],
  },
];

test("a pause ends when the transcript reports its last shell ended", () => {
  const registry = new Registry();
  const actor = registry.get("claude", "s");
  actor.pid = 4242;
  const hooks = shellHookRecords.map(value => new Hooks().decode(value)!);
  registry.observeHook(actor, hooks[0], 1, false, 100);
  registry.observeHook(actor, hooks[1], 2, false, 200);
  expect(actor.state.paused).toBe(true);
  // Its command ended: the Monitor can still wake it.
  const ended = new Ended();
  ended.add("b1");
  expect(actor.observeTaskEnds(ended)).toBe(false);
  expect(actor.state.paused).toBe(true);
  // The Monitor was stopped from Claude's task list, which wakes nothing.
  ended.add("m1");
  expect(actor.observeTaskEnds(ended)).toBe(true);
  expect(actor.state.paused).toBe(false);
  // A scheduled wakeup holds the pause whatever its shells do.
  registry.observeHook(actor, hooks[0], 3, false, 300);
  registry.observeHook(actor, hooks[2], 4, false, 400);
  expect(actor.state.paused).toBe(true);
  ended.add("m2");
  expect(actor.observeTaskEnds(ended)).toBe(false);
  expect(actor.state.paused).toBe(true);
  expect(actor.shells.len).toBe(0);
});

const parentHookRecords = [
  {
    hook_event_name: "UserPromptSubmit",
    session_id: "parent",
  },
  {
    hook_event_name: "Stop",
    session_id: "parent",
    background_tasks: [
      {
        id: "a1",
        type: "subagent",
        status: "running",
        description: "Lane A: sidebar",
        agent_type: "general-purpose",
      },
      {
        id: "a2",
        type: "subagent",
        status: "running",
        description: "Lane B: cards",
        agent_type: "Explore",
      },
      {
        id: "b1",
        type: "shell",
        status: "running",
        description: "Run tests",
        command: "bun test",
      },
    ],
  },
  {
    hook_event_name: "PreToolUse",
    session_id: "parent",
    tool_name: "Bash",
  },
  {
    hook_event_name: "Stop",
    session_id: "parent",
    background_tasks: [
      {
        id: "a2",
        type: "subagent",
        status: "running",
        description: "Lane B: cards",
        agent_type: "Explore",
      },
    ],
  },
  {
    hook_event_name: "Stop",
    session_id: "parent",
    background_tasks: [],
  },
];

test("a Claude parent works on while its Stop lists subagents, which become its children", () => {
  const registry = new Registry();
  const parent = registry.get("claude", "parent");
  parent.workspace = 3;
  const hooks = parentHookRecords.map(value => new Hooks().decode(value)!);
  const observe = (index: number, seq: number, now: number) =>
    registry.observeHook(parent, hooks[index], seq, false, now);
  observe(0, 1, 100);
  expect(observe(1, 2, 200)).toBe(false);
  expect(parent.state.state).toBe("working");
  expect(parent.state.subagents).toEqual({
    running: 2,
    blocked: 0,
    waiting: true,
  });
  expect(parent.confirmStop(2, "completed", 210)).toBe(false);
  expect(parent.state.observation.completed).toBe(0n);
  expect(parent.children_observed_at).toBe(200);
  expect(parent.background_tasks.len).toBe(1);
  const a1 = registry.find("claude", "a1")!;
  const a2 = registry.find("claude", "a2")!;
  expect(a1.parent).toBe(parent.id);
  expect(a1.workspace).toBe(parent.workspace);
  expect(a1.state.state).toBe("working");
  expect(a1.state.activity.text()).toBe("Lane A: sidebar");
  expect(a2.role.text()).toBe("Explore");
  expect(a2.observed_at).toBe(200);
  observe(2, 3, 300);
  expect(parent.state.subagents).toEqual({
    running: 2,
    blocked: 0,
    waiting: false,
  });
  expect(observe(3, 4, 400)).toBe(false);
  expect(parent.state.subagents).toEqual({
    running: 1,
    blocked: 0,
    waiting: true,
  });
  expect(a1.state.state).toBe("idle");
  expect(a2.state.state).toBe("working");
  observe(1, 4, 450);
  expect(a1.state.state).toBe("idle");
  observe(4, 5, 500);
  expect(parent.state.subagents).toEqual({
    running: 0,
    blocked: 0,
    waiting: false,
  });
  expect(a2.state.state).toBe("idle");
  expect(parent.state.observation.pending_stop).toBe(true);
  expect(parent.confirmStop(5, "completed", 510)).toBe(true);
  expect(parent.state.state).toBe("idle");
  expect(parent.state.observation.completed).toBe(1n);
});
