import { test, expect } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  advance,
  cancel,
  delays_ms,
  fresh_s,
  hold,
  hold_ms,
  observe,
  quiet_ms,
  released,
  retryAt,
  settling,
} from "./agent_retry";
import { Snapshot, Turn } from "./providers/snapshot";
import { Text } from "./providers";
import type { Runtime } from "./runtime";
const session = "01a19ea6-a077-75d3-b8dc-54b7dc1279b2",
  wall = 1793663100;
function world(account = "") {
  const pane = {
      id: 1,
      terminal: { exited: false },
      agent: () => ({ provider: "codex", sessionId: () => shown }),
    },
    runtime = {
      auto_retry: true,
      retries: [],
      held_stops: [],
      panes: [pane],
      pane: (id: number) => (id === 1 ? pane : null),
    } as unknown as Runtime;
  let shown = session;
  return { runtime, pane, account, show: (s: string) => (shown = s) };
}
/** What the observer reads of `session`'s latest turn. */
function snapshot(turn: string, outcome: Snapshot["outcome"], overloaded = outcome === "failed") {
  const out = new Snapshot(
    { pane: 1, pid: 7, prefix: new Text(session), actor: 0, generation: 1n, title_revision: 1n },
    session,
    outcome ? "idle" : "working",
  );
  out.turn = new Turn(turn);
  out.outcome = outcome;
  out.transient_failure_at = overloaded ? wall - 1 : 0;
  return out;
}
test("overloaded turns in a row wait longer each time, until it gives up", () => {
  const { runtime } = world();
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 1000, wall)).toBe(1000 + delays_ms[0]);
  expect(runtime.retries).toMatchObject([{ session, turn: "one", failures: 1, at: 1000 + delays_ms[0] }]);
  // Seeing the same failure again changes nothing.
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 5000, wall)).toBe(1000 + delays_ms[0]);
  // The retry runs, then fails the same way.
  expect(observe(runtime, "codex", "", snapshot("two", null), 20000, wall)).toBe(0);
  expect(observe(runtime, "codex", "", snapshot("two", "failed"), 21000, wall)).toBe(21000 + delays_ms[1]);
  expect(runtime.retries).toMatchObject([{ turn: "two", failures: 2 }]);
  for (let i = 3; i <= delays_ms.length; i++) observe(runtime, "codex", "", snapshot("t" + i, "failed"), 0, wall);
  expect(observe(runtime, "codex", "", snapshot("last", "failed"), 0, wall)).toBe(0);
  expect(runtime.retries[0]).toMatchObject({ failures: delays_ms.length + 1, at: Infinity });
});
test("a retry stays pending until the turn it started shows, or long enough that it won't", () => {
  const { runtime } = world();
  observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall);
  runtime.retries[0].started = true;
  for (let i = 0; i < settling; i++)
    expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall)).toBe(delays_ms[0]);
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall)).toBe(0);
  // The viewer hears of it while the agent still shows that turn.
  const agent = (turn: string) => ({ provider: "codex", sessionId: () => session, turnId: () => turn }) as any;
  runtime.retries[0].at = 5000;
  expect(retryAt(runtime, agent("one"))).toBe(5000);
  expect(retryAt(runtime, agent("two"))).toBe(0);
});
test("a turn that ends any other way, or a failure that won't pass, leaves nothing to retry", () => {
  const { runtime } = world();
  for (const ending of [
    snapshot("two", "completed"),
    snapshot("two", "interrupted"),
    snapshot("two", "failed", false),
  ]) {
    observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall);
    expect(runtime.retries).toHaveLength(1);
    observe(runtime, "codex", "", ending, 0, wall);
    expect(runtime.retries).toEqual([]);
  }
  // Nor does one long past, as a reload finds it, or one no pane shows.
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall + fresh_s + 1)).toBe(0);
  expect(runtime.retries[0].at).toBe(Infinity);
  runtime.retries = [];
  const unshown = snapshot("one", "failed");
  unshown.request.pane = 0;
  observe(runtime, "codex", "", unshown, 0, wall);
  expect(runtime.retries).toEqual([]);
});
test("a due retry starts the failed turn once, through the account's shared server", async () => {
  const account = mkdtempSync(tmpdir() + "/corgi-ts-retry-"),
    starts: unknown[] = [];
  mkdirSync(account + "/app-server-control");
  const server = Bun.serve({
    unix: account + "/app-server-control/app-server-control.sock",
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (!value.id) return;
        if (value.method === "turn/start") starts.push(value.params);
        const result =
          value.method === "thread/read"
            ? { thread: { status: { type: "idle" } } }
            : value.method === "thread/turns/list"
              ? {
                  data: [
                    {
                      id: "one",
                      status: "failed",
                      completedAt: wall - 1,
                      error: { codexErrorInfo: "serverOverloaded" },
                    },
                  ],
                }
              : {};
        ws.send(JSON.stringify({ id: value.id, result }));
      },
    },
  });
  const { runtime, show } = world(account),
    settled = async () => {
      while (runtime.retries.some(r => r.busy)) await Bun.sleep(2);
    };
  try {
    observe(runtime, "codex", account, snapshot("one", "failed"), 0, wall);
    advance(runtime, delays_ms[0] - 1, () => 0);
    await settled();
    expect(starts).toEqual([]);
    advance(runtime, delays_ms[0], () => 0);
    await settled();
    advance(runtime, delays_ms[0] + 1, () => 0);
    await settled();
    expect(starts).toEqual([{ threadId: session, input: [] }]);
    expect(runtime.retries[0]).toMatchObject({ started: true, at: delays_ms[0] });
    // Once its pane shows another conversation, it is forgotten.
    show("01a19ea6-0000-7000-8000-000000000000");
    advance(runtime, 2 * delays_ms[0], () => 0);
    expect(runtime.retries).toEqual([]);
  } finally {
    server.stop(true);
    rmSync(account, { recursive: true, force: true });
  }
});
test("a transcript's failed turn waits a moment for the observer, where Corgi can retry", () => {
  const { runtime } = world(),
    agent = (provider: string) => ({ id: 3, state: { provider } }) as any;
  expect(hold(runtime, agent("claude"), 7n, 1000)).toBe(false);
  expect(hold(runtime, agent("codex"), 7n, 1000)).toBe(true);
  expect(released(runtime, 1000 + hold_ms - 1)).toEqual([]);
  expect(released(runtime, 1000 + hold_ms)).toEqual([{ actor: 3, seq: 7n, until: 1000 + hold_ms }]);
  expect(runtime.held_stops).toEqual([]);
});
test("with auto-retry off, or after Esc calls it off, a failed turn stays failed", () => {
  const { runtime } = world();
  runtime.auto_retry = false;
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall)).toBe(0);
  expect(runtime.retries).toEqual([]);
  runtime.auto_retry = true;
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall)).toBe(delays_ms[0]);
  cancel(runtime, 1);
  expect(observe(runtime, "codex", "", snapshot("one", "failed"), 0, wall)).toBe(0);
  // A later failure is retried again.
  expect(observe(runtime, "codex", "", snapshot("two", "failed"), 0, wall)).toBe(delays_ms[1]);
});
test("a due retry waits while someone works in its focused pane", () => {
  const { runtime } = world("/nonexistent");
  observe(runtime, "codex", "/nonexistent", snapshot("one", "failed"), 0, wall);
  const due = delays_ms[0];
  advance(runtime, due, pane => (pane === 1 ? Date.now() - 3000 : 0));
  expect(runtime.retries[0]).toMatchObject({ busy: false, started: false });
  expect(runtime.retries[0].at).toBeGreaterThanOrEqual(due + quiet_ms - 3000);
  expect(runtime.retries[0].at).toBeLessThan(due + quiet_ms - 2000);
});
