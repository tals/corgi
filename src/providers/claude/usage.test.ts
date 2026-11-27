import { expect, test } from "bun:test";
import { Agent, Text } from "../../agents";
import { Tail, type Request } from "../../usage/worker";
import * as usage from "./usage";

function transcript() {
  const tail = new Tail(),
    agent = new Agent({ provider: "claude", session: new Text("session") }),
    reader = usage.open();
  agent.setTurn("turn");
  const request: Request = { actor: 1, workspace: 1, since: 0, agent, child: false, tracked_since: 0 };
  return {
    tail,
    record(value: object) {
      tail.ingest(
        request,
        reader,
        JSON.stringify({ sessionId: "session", timestamp: "2026-10-22T17:05:14.856Z", ...value }) + "\n",
        0,
      );
    },
  };
}

test("displayed Claude thinking updates supply commentary and immediate activity", () => {
  const { tail, record } = transcript(),
    update = "Building an interactive prototype of Corgi's launcher on a character grid.";
  record({
    type: "assistant",
    thinkingDisplay: "updates",
    message: { content: [{ type: "thinking", thinking: update + "\n\n" }] },
  });
  expect(tail.progress.view().commentary.text()).toBe("Latest agent update: " + update);
  expect(tail.progress.dirty).toBe(true);
  expect(tail.update.text()).toBe(update);
  expect(tail.update_at).toBe(Date.parse("2026-10-22T17:05:14.856Z") * 1000);

  tail.progress.dirty = false;
  record({
    type: "assistant",
    thinkingDisplay: "updates",
    message: { content: [{ type: "thinking", thinking: "\n\n" }] },
  });
  expect(tail.progress.dirty).toBe(false);
  expect(tail.update.text()).toBe(update);

  record({ type: "assistant", message: { content: [{ type: "text", text: "Testing keyboard navigation" }] } });
  expect(tail.progress.commentary.text()).toBe("Latest agent update: Testing keyboard navigation");
  expect(tail.update.text()).toBe("Testing keyboard navigation");
});

test("Claude thinking without the updates marker and other conversations do not become activity", () => {
  const { tail, record } = transcript();
  for (const fields of [
    {},
    { thinkingDisplay: "thinking" },
    { thinkingDisplay: "unknown" },
    { thinkingDisplay: null },
    { thinkingDisplay: "updates", isSidechain: true },
    { thinkingDisplay: "updates", sessionId: "other" },
    { thinkingDisplay: "updates", type: "user" },
  ]) {
    tail.progress.dirty = false;
    record({
      type: "assistant",
      ...fields,
      message: { content: [{ type: "thinking", thinking: "This should not become activity" }] },
    });
    expect(tail.progress.commentary.text()).toBe("");
    expect(tail.update.text()).toBe("");
  }
});

test.each([
  [{ action: "quickstart", intent: "other", design_systems: false }, "Artifact: quickstart other"],
  [
    { action: "publish", title: "Agent picker", files: [{ content: "large source body" }] },
    "Artifact: publish Agent picker",
  ],
])("Artifact activity retains its operation and purpose: %j", (input, evidence) => {
  const { tail, record } = transcript();
  record({
    type: "assistant",
    message: { content: [{ type: "tool_use", id: "artifact", name: "Artifact", input }] },
  });
  expect(tail.progress.view().evidence.text()).toBe("Currently running tools (not yet completed):\n" + evidence + "\n");
  record({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: "artifact", content: "large result body" }] },
  });
  expect(tail.progress.view().evidence.text()).toBe("Recent completed tools (oldest to newest):\n" + evidence + "\n");
});

test("messages typed while Claude works join the turn's requests", () => {
  const { tail, record } = transcript();
  record({ type: "user", message: { content: "Relax the key repeat timing" } });
  expect(tail.progress.view().road_evidence.text()).toBe("User request: Relax the key repeat timing\n");

  record({
    type: "attachment",
    attachment: { type: "queued_command", prompt: "make a PR when you're done", origin: { kind: "human" } },
  });
  record({
    type: "attachment",
    attachment: { type: "queued_command", prompt: "task finished", origin: { kind: "task" } },
  });
  expect(tail.progress.view().road_evidence.text()).toBe(
    "User requests this turn (oldest to newest):\n" +
      "1. Relax the key repeat timing\n" +
      "2. make a PR when you're done [sent while the agent was working]\n",
  );
});
