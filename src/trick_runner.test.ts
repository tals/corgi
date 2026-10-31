import { expect, test } from "bun:test";
import { Runner, type Sketch } from "./trick_runner";
import * as tricks from "./tricks";

const agent: tricks.Agent = {
  id: "pane:1",
  provider: "claude",
  account: "",
  workspace: 1,
  session: "one",
  name: "Agent",
  state: "working",
  attention: "none",
  activity: "",
  completed: "0",
};
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
function harness(sketch: Sketch) {
  const sent: Record<string, unknown>[] = [],
    failures: string[] = [];
  const runner = new Runner(
    sketch,
    value => sent.push(tricks.object(value)),
    error => failures.push(error.message),
  );
  const receive = (value: object) => runner.receive(JSON.stringify(value));
  receive({ event: "ready", version: 1 });
  return { sent, failures, runner, receive };
}

test("async setup and handlers serialize while storage replies bypass the queue", async () => {
  let count = 0;
  const seen: number[] = [];
  const h = harness({
    async setup(corgi) {
      count = await corgi.get("count", 0);
      corgi.subscribe("agent.changed");
    },
    async loop(corgi) {
      await corgi.set("count", ++count);
      seen.push(count);
    },
  });
  await flush();
  expect(h.sent).toEqual([{ op: "kv.get", key: "count", id: "1" }]);
  h.receive({ id: "1", result: 7 });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "subscribe", events: ["agent.changed", "agent.removed"] });
  for (let i = 0; i < 2; i++) h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "kv.set", value: 8, id: "2" });
  expect(seen).toEqual([]);
  h.receive({ id: "2", result: null });
  await flush();
  expect(seen).toEqual([8]);
  expect(h.sent.at(-1)).toMatchObject({ op: "kv.set", value: 9, id: "3" });
  h.receive({ id: "3", result: null });
  await flush();
  expect(seen).toEqual([8, 9]);
  expect(h.failures).toEqual([]);
});

test("default events exclude transcripts and setup-only sketches subscribe to nothing", async () => {
  const h = harness({ loop() {} });
  const once = harness({ setup() {} });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "subscribe", events: [...tricks.metadata_events], where: {} });
  expect(once.sent.at(-1)).toEqual({ op: "subscribe", events: [], where: {} });
});

test("paint is removed when an agent leaves the filter or exits", async () => {
  let calls = 0;
  const h = harness({
    setup(corgi) {
      corgi.subscribe("agent.changed", { state: "working" });
    },
    loop(corgi, event) {
      if (event.event !== "agent.changed") throw Error("UnexpectedEvent");
      calls++;
      corgi.paint(event.agent, { marker: "accent" });
    },
  });
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  h.receive({ event: "agent.changed", agent: { ...agent, state: "done" }, previous: agent });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "agent-pane-1" });
  h.receive({ event: "agent.changed", agent, previous: null });
  h.receive({ event: "agent.removed", agent });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "agent-pane-1" });
  expect(calls).toBe(3);
  expect(h.failures).toEqual([]);
  const transcript = harness({
    setup(corgi) {
      corgi.subscribe("transcript", { state: "working" });
    },
    loop(corgi, event) {
      if (event.event !== "transcript") throw Error("UnexpectedEvent");
      corgi.paint(event.agent, { marker: "warm" });
    },
  });
  await flush();
  transcript.receive({ event: "transcript", agent, record: {}, truncated: false });
  transcript.receive({ event: "agent.changed", agent: { ...agent, state: "done" }, previous: agent });
  await flush();
  expect(transcript.sent.at(-1)).toEqual({ op: "ui.remove", key: "agent-pane-1" });
  expect(transcript.failures).toEqual([]);
});

test("failed saves stop later handlers and a stalled consumer has a bounded queue", async () => {
  let calls = 0;
  const h = harness({
    async loop(corgi) {
      calls++;
      await corgi.set("count", calls);
    },
  });
  await flush();
  h.receive({ event: "snapshot", agents: [], workspaces: [] });
  h.receive({ event: "snapshot", agents: [], workspaces: [] });
  await flush();
  h.receive({ id: "1", error: "StoreTooLarge" });
  await flush();
  expect(h.failures).toEqual(["StoreTooLarge"]);
  expect(calls).toBe(1);
  const stalled = harness({
    async setup(corgi) {
      await corgi.get("waiting", null);
    },
  });
  await flush();
  for (let i = 0; i < 300; i++) stalled.receive({ event: "snapshot", agents: [], workspaces: [] });
  await flush();
  expect(stalled.failures).toEqual(["SlowConsumer"]);
});
