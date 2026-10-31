import { expect, test } from "bun:test";
import { Runner, type Trick, type On } from "./trick_runner";
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
function harness(register: Trick["register"]) {
  const sent: Record<string, unknown>[] = [],
    failures: string[] = [];
  const runner = new Runner(
    { register },
    value => sent.push(tricks.object(value)),
    error => failures.push(error.message),
  );
  const receive = (value: object) => runner.receive(JSON.stringify(value));
  receive({ event: "ready", version: 1 });
  return { sent, failures, runner, receive };
}

test("async registration and handlers serialize while storage replies bypass the queue", async () => {
  const seen: number[] = [];
  const h = harness(async (on, corgi) => {
    let count = await corgi.get("count", 0);
    on("agent.changed", async () => {
      await corgi.set("count", ++count);
      seen.push(count);
    });
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

test("on defaults to metadata and dispatches only matching handlers in registration order", async () => {
  const seen: string[] = [];
  const h = harness(on => {
    on(event => {
      seen.push("metadata:" + event.event);
    });
    on(["hook", "transcript"], event => {
      seen.push("extra:" + event.event);
    });
    on("hook", event => {
      seen.push(event.kind);
    });
  });
  const once = harness(() => {});
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "subscribe", events: [...tricks.events] });
  expect(once.sent.at(-1)).toEqual({ op: "subscribe", events: [] });
  h.receive({ event: "hook", provider: "claude", agent, kind: "prompt", tool: "" });
  h.receive({ event: "transcript", agent, record: {}, truncated: false });
  await flush();
  expect(seen).toEqual(["metadata:hook", "extra:hook", "prompt", "extra:transcript"]);
  const metadata = harness(on => {
    on(() => {});
  });
  await flush();
  expect(metadata.sent.at(-1)).toEqual({ op: "subscribe", events: [...tricks.metadata_events] });
});

test("paint is cleaned up on removal without invoking unregistered callbacks", async () => {
  let calls = 0;
  const h = harness((on, corgi) => {
    on("agent.changed", ({ agent }) => {
      calls++;
      const brand = corgi.brand.of(agent.provider);
      corgi.paint(agent, { marker: corgi.palette.accent, suffix: [brand.icon] });
    });
  });
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "ui.set", view: { suffix: [{ icon: "claude", text: "*" }] } });
  h.receive({ event: "agent.removed", agent });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "agent-pane-1" });
  expect(calls).toBe(1);
  expect(h.failures).toEqual([]);
});

test("failed saves stop remaining handlers and a stalled consumer has a bounded queue", async () => {
  let calls = 0;
  const h = harness((on, corgi) => {
    on(async () => {
      calls++;
      await corgi.set("count", calls);
    });
    on(() => {
      calls++;
    });
  });
  await flush();
  h.receive({ event: "snapshot", agents: [], workspaces: [] });
  h.receive({ event: "snapshot", agents: [], workspaces: [] });
  await flush();
  h.receive({ id: "1", error: "StoreTooLarge" });
  await flush();
  expect(h.failures).toEqual(["StoreTooLarge"]);
  expect(calls).toBe(1);
  const stalled = harness(async (_on, corgi) => {
    await corgi.get("waiting", null);
  });
  await flush();
  for (let i = 0; i < 300; i++) stalled.receive({ event: "snapshot", agents: [], workspaces: [] });
  await flush();
  expect(stalled.failures).toEqual(["SlowConsumer"]);
});

test("registration rejects wildcards, bad callbacks, and late or unbounded handlers", async () => {
  // Simulate untyped JavaScript at the module boundary.
  const bad = harness(on => {
    (on as Function)("*", () => {});
  });
  const missing = harness(on => {
    (on as Function)("hook", null);
  });
  const excess = harness(on => {
    for (let i = 0; i < 257; i++) on(() => {});
  });
  let later: On | undefined;
  const late = harness(on => {
    later = on;
  });
  await flush();
  expect(bad.failures).toEqual(["InvalidEvents"]);
  expect(missing.failures).toEqual(["ExpectedHandler"]);
  expect(excess.failures).toEqual(["TooManyHandlers"]);
  expect(() => later!("transcript", () => {})).toThrow("RegistrationClosed");
  expect(late.failures).toEqual([]);
});
