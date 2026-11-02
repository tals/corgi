import { expect, test } from "bun:test";
import { Runner, type Trick, type On, type Ui } from "./trick_runner";
import * as tricks from "./tricks";

const agent: tricks.Agent = {
  id: "pane:1",
  provider: "claude",
  account: {
    id: "claude-default",
    name: "Default",
    directory: "/profiles/default",
    loginId: null,
    email: null,
    type: null,
    plan: null,
    usage: null,
  },
  env: {},
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
  receive({ event: "ready", version: tricks.version });
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

test("drawing hooks subscribe to metadata and clean up on removal", async () => {
  let calls = 0;
  const h = harness((on, corgi) => {
    on("ui:agent.sidebar", ({ agent, ui }) => {
      calls++;
      const brand = corgi.brand.of(agent.provider);
      ui.marker(corgi.palette.accent);
      ui.append(`!(${brand.icon})`);
    });
  });
  await flush();
  expect(h.sent).toEqual([{ op: "subscribe", events: ["agent.changed", "agent.removed"] }]);
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "ui.set", view: { suffix: [{ icon: "claude", text: "*" }] } });
  h.receive({ event: "agent.removed", agent });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "ui-sidebar-pane-1" });
  expect(calls).toBe(1);
  expect(h.failures).toEqual([]);
});

test("UI hooks compose per surface, cache identical patches and clear conditions that stop matching", async () => {
  let calls = 0;
  let later: Ui | undefined;
  const h = harness(on => {
    on("ui:agent.sidebar", ({ agent, ui }) => {
      calls++;
      later = ui;
      if (agent.state !== "working") return;
      ui.color("warm");
      ui.append("**Work**");
    });
    on("ui:agent.sidebar", ({ agent, ui }) => {
      if (agent.state !== "working") return;
      ui.marker("accent");
      ui.append("!(brand:claude)");
    });
    on("ui:agent.popover", ({ ui }) => ui.append("Popover"));
    on("ui:agent.pane", ({ ui }) => ui.append("Pane"));
  });
  await flush();
  expect(h.sent).toHaveLength(1);
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  expect(h.sent).toHaveLength(4);
  expect(h.sent[1]).toMatchObject({
    key: "ui-sidebar-pane-1",
    view: {
      surface: "sidebar",
      color: "warm",
      marker: "accent",
      suffix: [{ text: "Work", bold: true }, { text: " " }, { icon: "claude" }],
    },
  });
  expect(h.sent[2]).toMatchObject({ view: { surface: "popover", suffix: [{ text: "Popover" }] } });
  expect(h.sent[3]).toMatchObject({ view: { surface: "pane", suffix: [{ text: "Pane" }] } });
  expect(() => later!.append("late")).toThrow("DrawingClosed");
  h.receive({ event: "agent.changed", agent: { ...agent, name: "Renamed" }, previous: agent });
  await flush();
  expect(calls).toBe(2);
  expect(h.sent).toHaveLength(4);
  h.receive({ event: "snapshot", agents: [agent], workspaces: [] });
  await flush();
  expect(calls).toBe(2);
  h.receive({ event: "agent.changed", agent: { ...agent, state: "idle" }, previous: agent });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "ui-sidebar-pane-1" });
  h.receive({ event: "agent.removed", agent });
  await flush();
  expect(h.sent.slice(-2)).toEqual([
    { op: "ui.remove", key: "ui-popover-pane-1" },
    { op: "ui.remove", key: "ui-pane-pane-1" },
  ]);
  expect(calls).toBe(3);
  expect(h.failures).toEqual([]);
});

test("metadata handlers finish before drawing and failing drawing hooks commit no partial patch", async () => {
  let name = "";
  const h = harness(on => {
    on("ui:agent.sidebar", async ({ agent, ui }) => {
      ui.append(name);
      await flush();
      if (agent.state === "blocked") throw Error("BadDrawing");
    });
    on("agent.changed", ({ agent }) => {
      name = agent.name;
    });
  });
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ view: { suffix: [{ text: "Agent" }] } });
  h.receive({ event: "agent.changed", agent: { ...agent, name: "Uncommitted", state: "blocked" }, previous: agent });
  await flush();
  await flush();
  expect(h.sent).toHaveLength(2);
  expect(h.failures).toEqual(["BadDrawing"]);
});

test("drawing patches and overlays enforce their bounds before sending", async () => {
  const h = harness(on =>
    on("ui:agent.sidebar", ({ ui }) => {
      for (let i = 0; i < 20; i++) ui.append("x");
    }),
  );
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  expect(h.failures).toEqual(["InvalidSpans"]);
  expect(h.sent).toHaveLength(1);
  const overlay = harness((_on, corgi) => {
    corgi.draw("hello", { kind: "overlay", text: "**Hello**\n!(brand:claude)", color: "warm" });
    expect(() => corgi.clear("ui-sidebar-pane-1")).toThrow("ReservedKey");
    expect(() => corgi.draw("bad", { kind: "overlay", text: "x\n".repeat(13) })).toThrow("InvalidLines");
  });
  await flush();
  expect(overlay.sent[0]).toMatchObject({
    view: { lines: [[{ text: "Hello", bold: true, color: "warm" }], [{ icon: "claude" }]] },
  });
  expect(overlay.failures).toEqual([]);
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

test("buttons retain current closures, refresh agent drawings and discard stale callbacks", async () => {
  const pressed: string[] = [];
  let count = 0,
    draws = 0;
  const h = harness(on => {
    on("ui:agent.sidebar", ({ agent, ui }) => {
      draws++;
      ui.append(
        ui.row(
          ui.icon("brand:claude"),
          ui.button(`Count ${count}`, () => {
            pressed.push(agent.name);
            count++;
          }),
        ),
      );
    });
  });
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  const old = tricks.view(h.sent.at(-1)!.view),
    action = tricks.actions(old.content)[0];
  expect(action).toBeDefined();
  const writes = h.sent.length;
  h.receive({ event: "agent.changed", agent: { ...agent, name: "Latest" }, previous: agent });
  await flush();
  expect(h.sent.length).toBe(writes);
  h.receive({ event: "ui.press", action, viewer: 2 });
  await flush();
  expect(pressed).toEqual(["Latest"]);
  expect(draws).toBe(3);
  const next = tricks.actions(tricks.view(h.sent.at(-1)!.view).content)[0];
  expect(next).not.toBe(action);
  h.receive({ event: "ui.press", action, viewer: 2 });
  h.receive({ event: "agent.removed", agent });
  h.receive({ event: "ui.press", action: next, viewer: 2 });
  await flush();
  expect(pressed).toEqual(["Latest"]);
  expect(h.failures).toEqual([]);
});

test("a button can await storage and focus only the viewer that pressed it", async () => {
  const h = harness((_on, corgi) => {
    corgi.draw("panel", {
      kind: "overlay",
      content: corgi.ui.button("Open", async () => {
        await corgi.set("choice", agent.id);
        await corgi.focus(agent);
        corgi.clear("panel");
      }),
    });
  });
  await flush();
  await expect(h.runner.corgi.focus(agent)).rejects.toThrow("NoInteraction");
  const action = tricks.actions(tricks.view(h.sent[0].view).content)[0];
  h.receive({ event: "ui.press", action, viewer: 7 });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "kv.set", value: agent.id });
  h.receive({ id: h.sent.at(-1)!.id, result: null });
  await flush();
  expect(h.sent.at(-1)).toMatchObject({ op: "ui.focus", viewer: 7, agent: "pane:1" });
  h.receive({ id: h.sent.at(-1)!.id, result: null });
  await flush();
  expect(h.sent.at(-1)).toEqual({ op: "ui.remove", key: "panel" });
  const before = h.sent.length;
  h.receive({ event: "ui.press", action, viewer: 7 });
  await flush();
  expect(h.sent).toHaveLength(before);
  expect(h.failures).toEqual([]);
});

test("explicit refresh coalesces and never subscribes to transcripts or runs on a terminal frame", async () => {
  let label = "Before",
    draws = 0;
  const h = harness(on =>
    on("ui:agent.popover", ({ ui }) => {
      draws++;
      ui.append(label);
    }),
  );
  await flush();
  h.receive({ event: "agent.changed", agent, previous: null });
  await flush();
  label = "After";
  h.runner.corgi.refresh();
  h.runner.corgi.refresh();
  await flush();
  expect(draws).toBe(2);
  expect(h.sent.at(-1)).toMatchObject({ view: { suffix: [{ text: "After" }] } });
  expect(h.sent[0]).toEqual({ op: "subscribe", events: ["agent.changed", "agent.removed"] });
});

test("unawaited button work cannot borrow the next viewer's interaction", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const rejected: string[] = [];
  let presses = 0;
  const h = harness((_on, corgi) => {
    corgi.draw("button", {
      kind: "overlay",
      content: corgi.ui.button("Open", async () => {
        if (++presses === 1) {
          void (async () => {
            await gate;
            try {
              await corgi.focus(agent);
            } catch (error) {
              rejected.push((error as Error).message);
            }
          })();
        } else await corgi.get("hold", null);
      }),
    });
  });
  await flush();
  const action = tricks.actions(tricks.view(h.sent[0].view).content)[0];
  h.receive({ event: "ui.press", action, viewer: 1 });
  await flush();
  h.receive({ event: "ui.press", action, viewer: 2 });
  await flush();
  release();
  await flush();
  expect(rejected).toEqual(["NoInteraction"]);
  expect(h.sent.at(-1)).toMatchObject({ op: "kv.get" });
  h.receive({ id: h.sent.at(-1)!.id, result: null });
  await flush();
  expect(h.failures).toEqual([]);
});
