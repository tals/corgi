import { test, expect } from "bun:test";
import { Registry } from "../../conversations";
import { adapter, decode } from "./index";
import { Ended } from "../../activity/background_tasks";

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
