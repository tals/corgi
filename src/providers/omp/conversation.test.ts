import { test, expect } from "bun:test";
import { Registry } from "../../conversations";
import { adapter, decode } from "./index";
import { Ended } from "../../activity/background_tasks";
import { adapter as pi } from "../pi";
import type { Item } from "../../activity/checklist";
import { visible } from "../../checklist_view";

function setup() {
  const registry = new Registry();
  const parent = registry.get("omp", "parent");
  const send = (value: object, at: number) => {
    const event = adapter.hook!({ session: "parent", ...value });
    expect(event).not.toBeNull();
    registry.observeHook(parent, event!, BigInt(at), false, at);
  };
  return { registry, parent, send };
}
test("OMP streaming activity preserves lifecycle and rejects stale turns", () => {
  const { parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  send({ event: "Activity", turn: "turn", intent: "Creating live protocol", amend: false }, 110);
  expect(parent.state.activity.text()).toBe("Creating live protocol");
  expect(parent.state.tool_active).toBe(false);
  send({ event: "Activity", turn: "turn", intent: "Creating live protocol transition smoke", amend: true }, 120);
  expect(parent.activity_timeline.points.map(p => p.label.text())).toEqual(["Creating live protocol transition smoke"]);
  send({ event: "PermissionRequest", turn: "turn", tool: "write" }, 130);
  send({ event: "Activity", turn: "turn", intent: "Writing protocol fixture", amend: false }, 140);
  expect(parent.state.state).toBe("blocked");
  expect(parent.state.attention).toBe("needs_input");
  expect(parent.state.tool_active).toBe(true);
  expect(parent.state.activity.text()).toBe("Writing protocol fixture");
  send({ event: "PreCompact", turn: "turn" }, 150);
  const history = parent.activity_timeline.points.map(p => p.label.text());
  send({ event: "Activity", turn: "turn", intent: "Checking protocol fixture", amend: false }, 160);
  expect(parent.state.compacting).toBe(true);
  expect(parent.activity_timeline.points.map(p => p.label.text())).toEqual(history);
  send({ event: "Stop", turn: "turn", outcome: "completed" }, 170);
  const completed = parent.state.observation.completed;
  send({ event: "Activity", turn: "turn", intent: "Late result", amend: false }, 180);
  expect(parent.state.state).toBe("idle");
  expect(parent.state.activity.text()).not.toBe("Late result");
  send({ event: "UserPromptSubmit", turn: "next" }, 190);
  send({ event: "Activity", turn: "turn", intent: "Old turn", amend: false }, 200);
  expect(parent.state.turnId()).toBe("next");
  expect(parent.state.activity.text()).toBe("");
  expect(parent.state.observation.completed).toBe(completed);
});

test("OMP child lifecycle links real session identities without changing parent activity", () => {
  const { registry, parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  const event = {
    event: "SubagentStart",
    subagent: "child-session",
    subagent_type: "scout",
    description: "Inspect provider lifecycle",
    child_transcript: "/tmp/omp-child.jsonl",
    model: "openai/gpt-5",
  };
  send(event, 110);
  send(event, 111);
  const child = registry.find("omp", "child-session")!;
  expect(child.parent).toBe(parent.id);
  expect(child.role.text()).toBe("scout");
  expect(child.state.activity.text()).toBe("Inspect provider lifecycle");
  expect(child.state.transcriptPath()).toBe("/tmp/omp-child.jsonl");
  expect(child.state.model.text()).toBe("openai/gpt-5");
  expect(child.state.state).toBe("working");
  expect(parent.state.sessionId()).toBe("parent");
  expect(parent.state.state).toBe("working");
  expect(parent.state.subagents.running).toBe(1);
  child.state.state = "blocked";
  send({ ...event, subagent: "second" }, 112);
  expect(parent.state.subagents.running).toBe(2);
  expect(parent.state.subagents.blocked).toBe(1);
  send({ ...event, event: "SubagentStop", outcome: "completed" }, 120);
  send({ ...event, event: "SubagentStop", outcome: "completed" }, 120);
  send(event, 119);
  send(event, 120);
  expect(registry.find("omp", "child-session")?.state.state).toBe("idle");
  expect(parent.state.state).toBe("working");
  expect(parent.state.subagents.running).toBe(1);
  expect(parent.state.subagents.blocked).toBe(0);
});

test("OMP completed async stop pauses idle parent even before child discovery", () => {
  const { registry, parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  send({ event: "Stop", turn: "turn", outcome: "completed", awaiting_async_work: true }, 200);
  expect(parent.state.state).toBe("idle");
  expect(parent.state.paused).toBe(true);
  expect(parent.paused_at).toBe(200n);
  expect(parent.observeTranscriptTurn(0)).toBe(false);
  expect(parent.observeTaskEnds(new Ended())).toBe(false);
  send({ event: "SubagentStart", subagent: "child", subagent_type: "task" }, 210);
  send({ event: "SubagentStop", subagent: "child", outcome: "completed" }, 220);
  expect(parent.state.paused).toBe(true);
  expect(parent.state.state).toBe("idle");
  expect(registry.find("omp", "child")?.state.state).toBe("idle");
  send({ event: "UserPromptSubmit", turn: "next" }, 300);
  expect(parent.state.paused).toBe(false);
  expect(parent.state.state).toBe("working");
});

test("OMP interrupted and failed stops do not acquire the async pause", () => {
  for (const outcome of ["interrupted", "failed", "completed"]) {
    const { parent, send } = setup();
    send({ event: "UserPromptSubmit", turn: "turn" }, 100);
    send({ event: "Stop", turn: "turn", outcome, awaiting_async_work: outcome !== "completed" }, 200);
    expect(parent.state.paused).toBe(false);
    expect(parent.state.state).toBe("idle");
  }
});

test("OMP rejects missing child identity and keeps child paths out of parent binding", () => {
  expect(decode({ event: "SubagentStart", session: "parent" })).toBeNull();
  const { parent, send } = setup();
  send({ event: "SubagentStop", subagent: "child", child_transcript: "/tmp/child.jsonl", outcome: "failed" }, 100);
  expect(parent.state.transcriptPath()).toBe("");
  expect(parent.state.subagents.running).toBe(0);
});

test("OMP missing terminal intent preserves semantic activity and history without advancing its timestamp", () => {
  const { parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  send({ event: "Activity", turn: "turn", intent: "Reading code intelligence interface" }, 110);
  const history = parent.activity_timeline.points.map(p => p.label.text());
  const activityAt = parent.state.activity_at;
  send(
    {
      event: "PreToolUse",
      turn: "turn",
      tool: "read",
      input: { path: "xd://lsp", description: "read xd://lsp" },
    },
    120,
  );
  expect(parent.state.activity.text()).toBe("Reading code intelligence interface");
  expect(parent.state.activity_at).toBe(activityAt);
  expect(parent.activity_timeline.points.map(p => p.label.text())).toEqual(history);
  expect(parent.state.tool_active).toBe(true);
  expect(parent.state.state).toBe("working");
  expect(parent.state.last_seq).toBe(120n);
  parent.state.activity_inferred = true;
  send(
    {
      event: "PreToolUse",
      turn: "turn",
      tool: "read",
      input: { path: "/repo/file" },
      intent: "Reading native execution metadata",
    },
    130,
  );
  expect(parent.state.activity.text()).toBe("Reading native execution metadata");
  expect(parent.state.activity_at).toBe(130);
  expect(parent.activity_timeline.points.map(p => p.label.text())).toEqual([
    ...history,
    "Reading native execution metadata",
  ]);
});

test("OMP standalone terminal tool without intent leaves activity and history empty", () => {
  const { parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  send(
    {
      event: "PreToolUse",
      turn: "turn",
      tool: "read",
      input: { path: "xd://lsp", description: "raw tool description" },
    },
    110,
  );
  expect(parent.state.activity.text()).toBe("");
  expect(parent.activity_timeline.points).toHaveLength(0);
  expect(parent.state.tool_active).toBe(true);
});

test("Pi terminal tools retain non-native description activity", () => {
  const registry = new Registry();
  const actor = registry.get("pi", "pi-session");
  const send = (value: object, at: number) => {
    const hook = pi.hook!({ session: "pi-session", turn: "turn", ...value });
    expect(hook).not.toBeNull();
    registry.observeHook(actor, hook!, BigInt(at), false, at);
  };
  send({ event: "UserPromptSubmit" }, 100);
  send(
    {
      event: "PreToolUse",
      tool: "read",
      input: { path: "/repo/file", description: "Pi tool description" },
    },
    110,
  );
  expect(actor.state.activity.text()).toBe("Pi tool description");
  expect(actor.state.tool_active).toBe(true);
  expect(actor.state.state).toBe("working");
});

test("OMP checklist hooks only update the named actor's checklist and accept empty clears", () => {
  const { registry, parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  send({ event: "PreCompact", turn: "turn" }, 110);
  parent.screen_compacting = true;
  const before = { ...parent.state },
    observed = parent.observed_at,
    hooked = parent.hooked_at,
    history = parent.activity_timeline.points.slice();
  const phases = [{ name: "Work", tasks: [{ content: "Implement", status: "blocked" }] }];
  const implement: Item[] = [{ text: "Implement", status: "blocked", group: "Work" }];
  send({ event: "Todos", todos: { phases } }, 120);
  expect(parent.checklist.items).toEqual(implement);
  expect(parent.checklist.at).toBe(120);
  expect({ ...parent.state, last_seq: before.last_seq }).toEqual(before);
  expect(parent.screen_compacting).toBe(true);
  expect(parent.observed_at).toBe(observed);
  expect(parent.hooked_at).toBe(hooked);
  expect(parent.activity_timeline.points).toEqual(history);
  const sibling = registry.get("omp", "sibling");
  expect(sibling.checklist.items).toEqual([]);
  send({ event: "Todos", todos: { phases: [] } }, 130);
  expect(parent.checklist.items).toEqual([]);
  send({ event: "Todos", todos: { phases } }, 125);
  expect(parent.checklist.items).toEqual([]);
  expect(parent.checklist.at).toBe(130);
  expect(pi.hook!({ event: "Todos", session: "parent", todos: { phases } })).toBeNull();
  expect(decode({ event: "Todos", session: "parent", todos: {} })).toBeNull();
});

test("OMP checklists retire from their last edit; reading one back from the session isn't an edit", () => {
  const { parent, send } = setup();
  send({ event: "UserPromptSubmit", turn: "turn" }, 1_000_000);
  const phases = [{ name: "Work", tasks: [{ content: "Ship", status: "completed" }] }];
  send({ event: "Todos", todos: { phases } }, 2_000_000);
  send({ event: "Todos", at: 2_000, todos: { phases } }, 30_000_000);
  send({ event: "Activity", turn: "turn", intent: "Reviewing the delivery" }, 40_000_000);
  expect(parent.checklist.at).toBe(2_000_000);
  expect(visible(parent.checklist, 61_999_999)).toBe(true);
  expect(visible(parent.checklist, 62_000_000)).toBe(false);
  send({ event: "Todos", at: 1_000, todos: { phases: [] } }, 70_000_000);
  expect(parent.checklist.items).toHaveLength(1);
  send({ event: "Todos", todos: { phases } }, 80_000_000);
  expect(visible(parent.checklist, 139_999_999)).toBe(true);
  expect(visible(parent.checklist, 140_000_000)).toBe(false);
  send(
    { event: "Todos", todos: { phases: [{ name: "Work", tasks: [{ content: "Ship", status: "pending" }] }] } },
    150_000_000,
  );
  expect(visible(parent.checklist, 300_000_000)).toBe(true);
});
