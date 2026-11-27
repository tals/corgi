import { expect, test } from "bun:test";
import { transcript } from "./transcript";
import { adapter } from "./index";
import { Agent, Text } from "../../agents";
import { Actor } from "../../conversations";
import { View } from "../../activity/tools";
import { Result as ActivityResult, Worker } from "../../activity/worker";
import { Result, Tail, type Request } from "../../usage/worker";
import { Result as NameResult } from "../../conversation_name";

function evidence() {
  const agent = new Agent({ provider: "pi", state: "working", session: new Text("s"), activity_at: 3000000 }),
    result = new Result(),
    progress = new View();
  agent.setTurn("turn-1");
  agent.setActivity("read src/agents.ts");
  progress.turn = new Text("turn-1");
  progress.evidence = new Text("Currently running tools (not yet completed):\nread: src/agents.ts\n");
  result.progress = progress;
  result.update = new Text("I'll inspect the parser.");
  result.update_at = 2000000;
  return { agent, result, progress };
}

test("Pi /name flows back to Corgi and defeats an in-flight automatic title", () => {
  const actor = new Actor({ id: 1, state: new Agent({ provider: "pi", session: new Text("s") }) });
  const suggestion = new NameResult({ actor: actor.id, agent: actor.state.snapshot() }, new Text("Automatic title"));
  const tail = new Tail(),
    reader = transcript.reader(() => []);
  const req: Request = { actor: actor.id, workspace: 1, since: 0, agent: actor.state, child: false, tracked_since: 0 };
  tail.ingest(req, reader, '{"type":"session_info","name":"My own name"}\n', 0);
  const result = new Result();
  result.name = tail.name;
  result.fallback(actor.state, 0);
  expect(actor.state.name.text()).toBe("My own name");
  expect(suggestion.apply(actor)).toBe(false);
});

test("Pi transcript evidence schedules summaries independently of the fallback label", () => {
  const { agent, result, progress } = evidence();
  expect(result.fallback(agent, 4000000)).toBe(true);
  expect(agent.activity.text()).toBe("read src/agents.ts");
  expect(agent.activity_at).toBe(3000000);
  const generation = agent.activity_generation;
  agent.activity_inferred = true;
  agent.setActivity("Investigating parser behavior");
  result.update = new Text("I'll inspect another component.");
  result.update_at = 5000000;
  progress.commentary = new Text("Latest agent update: I'll inspect another component.");
  expect(result.fallback(agent, 6000000)).toBe(true);
  expect(agent.activity.text()).toBe("Investigating parser behavior");
  expect(agent.activity_generation).toBe(generation);
});

test("Pi can summarize tool evidence without assistant commentary", () => {
  const { agent, result } = evidence();
  result.update = new Text();
  result.update_at = 0;
  expect(result.fallback(agent, 4000000)).toBe(true);
  expect(agent.activity.text()).toBe("read src/agents.ts");
});

test.each(["idle", "ended", "old turn", "no turn", "no evidence", "no progress"])(
  "Pi does not schedule transcript summaries with %s",
  condition => {
    const { agent, result, progress } = evidence();
    switch (condition) {
      case "idle":
        agent.state = condition;
        break;
      case "ended":
        progress.ended = true;
        break;
      case "old turn":
        progress.turn = new Text("previous");
        break;
      case "no turn":
        progress.turn = new Text();
        break;
      case "no evidence":
        progress.evidence = new Text();
        break;
      case "no progress":
        result.progress = null;
        break;
    }
    expect(result.fallback(agent, 4000000)).toBe(false);
  },
);

test("Pi's fallback text still yields to hooks, inferred labels and idle state", () => {
  const { agent, result } = evidence();
  agent.activity_at = 1000000;
  expect(result.fallback(agent, 4000000)).toBe(true);
  expect(agent.activity.text()).toBe("I'll inspect the parser.");
  expect(agent.activity_at).toBe(2000000);
  agent.state = "idle";
  result.update = new Text("Older completed work");
  result.update_at = 5000000;
  expect(result.fallback(agent, 6000000)).toBe(false);
  expect(agent.activity.text()).toBe("I'll inspect the parser.");
});

test("Pi tools start a summary slot on every turn despite newer hook activity", () => {
  const actor = new Actor({ id: 1, state: new Agent({ provider: "pi", session: new Text("s") }) }),
    worker = new Worker(),
    tail = new Tail(),
    reader = transcript.reader(() => []),
    req: Request = { actor: actor.id, workspace: 1, since: 0, agent: actor.state, child: false, tracked_since: 0 };
  let seq = 0;
  const hook = (event: string, turn: string, extra = {}) =>
    actor.observeHook(adapter.hook({ event, session: "s", turn, ...extra })!, BigInt(++seq), true, 3000000 + seq);
  try {
    for (const turn of ["turn-1", "turn-2"]) {
      hook("UserPromptSubmit", turn);
      worker.reconcile([actor]);
      expect(worker.slots.filter(Boolean)).toHaveLength(turn === "turn-1" ? 0 : 1);
      if (turn === "turn-2") expect(worker.slots[0]?.request.road?.events.length).toBeGreaterThan(0);
      tail.ingest(
        req,
        reader,
        JSON.stringify({
          type: "message",
          id: turn,
          timestamp: "1970-01-01T00:00:02.000Z",
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: turn, name: "read", arguments: { path: "src/agents.ts" } }],
          },
        }) + "\n",
        0,
      );
      hook("PreToolUse", turn, { tool: "read", input: { path: "src/agents.ts" } });
      const result = new Result();
      result.progress = tail.progress.view();
      expect(result.progress.commentary.len).toBe(0);
      expect(result.fallback(actor.state, 4000000)).toBe(true);
      worker.submit(actor, result.progress.commentary, result.progress, []);
      const slot = worker.slots.find(s => s?.request.actor === actor.id)!;
      expect(slot.ready(4000, false)).toBe(true);
      expect(slot.request.turn.text()).toBe(turn);
      expect(slot.request.evidence.text()).toContain("read: src/agents.ts");
      const summary = new ActivityResult(slot.request, new Text("Investigating parser behavior"));
      expect(summary.apply(actor)).toBe(true);
      hook("PreToolUse", turn, { tool: "read", input: { path: "src/other.ts" } });
      expect(actor.state.activity.text()).toBe("Investigating parser behavior");
      hook("Stop", turn, { outcome: "completed" });
      expect(actor.state.state).toBe("idle");
    }
    expect(actor.activity_timeline.len).toBe(2);
  } finally {
    worker.stop();
  }
});
