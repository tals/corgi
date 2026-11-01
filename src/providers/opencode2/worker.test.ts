import { expect, test } from "bun:test";
import { API } from "./api";
import { Engine } from "./worker";
test("a headless conversation polls on its own and its subagents' events", () => {
  const engine = new Engine(new API("unused"), () => {});
  engine.session = "ses_main";
  engine.turns.set("ses_child", "");
  engine.live = true;
  engine.due = false;
  engine.polled = 1000;
  expect(engine.wanted(2000)).toBe(false);
  engine.observe({ type: "session.text.delta", data: { sessionID: "ses_main" } });
  engine.observe({ type: "session.tool.called", data: { sessionID: "ses_unrelated" } });
  expect(engine.due).toBe(false);
  engine.observe({ type: "permission.asked", data: { id: "per_1", sessionID: "ses_child" } });
  expect(engine.wanted(2000)).toBe(true);
  engine.due = false;
  engine.observe({ type: "session.created", data: { sessionID: "ses_new", parentID: "ses_main" } });
  expect(engine.due).toBe(true);
  engine.due = false;
  engine.retry = 3000;
  expect([engine.wanted(2999), engine.wanted(3000)]).toEqual([false, true]);
  engine.live = false;
  engine.retry = Infinity;
  expect(engine.wanted(1300)).toBe(true);
});
test("a session starts on the model it asks for, its instructions leading the first prompt", async () => {
  const calls: unknown[][] = [],
    events: unknown[] = [];
  const api = {
    cwd: "/repo",
    call: async (...args: unknown[]) => {
      calls.push(args);
      return { data: { id: "ses_main" } };
    },
  } as unknown as API;
  const engine = new Engine(api, e => events.push(e), null, {
    model: "anthropic/claude-opus#high",
    instructions: "Be brief.",
  });
  await engine.start();
  expect(calls[0]).toEqual([
    "POST",
    "/api/session",
    { location: { directory: "/repo" }, model: { providerID: "anthropic", id: "claude-opus", variant: "high" } },
  ]);
  await engine.send({ kind: "prompt", text: "hi" });
  await engine.send({ kind: "prompt", text: "again" });
  expect(calls.slice(1)).toEqual([
    ["POST", "/api/session/ses_main/prompt", { text: "Be brief.\n\nhi", delivery: "steer" }],
    ["POST", "/api/session/ses_main/prompt", { text: "again", delivery: "steer" }],
  ]);
});
test("a headless conversation streams its own answer's text", () => {
  const events: unknown[] = [];
  const engine = new Engine(new API("unused"), e => events.push(e));
  engine.session = "ses_main";
  const delta = (sessionID: string, assistantMessageID: string, ordinal: number, delta: string) => ({
    type: "session.text.delta",
    data: { sessionID, assistantMessageID, ordinal, delta },
  });
  engine.observe(delta("ses_main", "msg_1", 0, "Hel"));
  engine.observe(delta("ses_main", "msg_1", 0, "lo"));
  engine.observe(delta("ses_child", "msg_2", 0, "sub"));
  engine.observe(delta("ses_main", "msg_1", 2, "Again"));
  engine.observe(delta("ses_main", "msg_3", 0, "Next"));
  expect(events).toEqual([
    { kind: "partial", session: "ses_main", text: "Hel" },
    { kind: "partial", session: "ses_main", text: "Hello" },
    { kind: "partial", session: "ses_main", text: "Hello\nAgain" },
    { kind: "partial", session: "ses_main", text: "Next" },
  ]);
});
