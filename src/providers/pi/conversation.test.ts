import { test, expect } from "bun:test";
import { Registry } from "../../conversations";
import { adapter } from "./index";

test("Pi subagents link under their parent with their own session, transcript and model", () => {
  const registry = new Registry();
  const parent = registry.get("pi", "pane");
  const send = (value: object, at: number) => {
    const event = adapter.hook({ session: "pane", transcript: "/tmp/pane.jsonl", cwd: "/tmp", ...value });
    expect(event).not.toBeNull();
    registry.observeHook(parent, event!, BigInt(at), false, at);
  };
  send({ event: "UserPromptSubmit", turn: "turn" }, 100);
  const start = {
    event: "SubagentStart",
    subagent: "scout-session",
    subagent_type: "scout",
    subagent_name: "find stale TODOs",
    description: "Find stale TODOs",
    child_transcript: "/tmp/scout.jsonl",
    model: "anthropic/claude-opus-5",
  };
  send(start, 110);
  const child = registry.find("pi", "scout-session")!;
  expect(child.parent).toBe(parent.id);
  expect(child.role.text()).toBe("scout");
  expect(child.state.name.text()).toBe("find stale TODOs");
  expect(child.state.activity.text()).toBe("Find stale TODOs");
  expect(child.state.transcriptPath()).toBe("/tmp/scout.jsonl");
  expect(child.state.state).toBe("working");
  expect(parent.state.transcriptPath()).toBe("/tmp/pane.jsonl");
  expect(parent.state.subagents.running).toBe(1);
  send({ ...start, event: "SubagentStop", outcome: "interrupted" }, 120);
  expect(child.state.state).toBe("idle");
  expect(parent.state.subagents.running).toBe(0);
  expect(parent.state.state).toBe("working");
});
