import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { retry, transient } from "./retry";
const overloaded = (id: string) => ({
  id,
  status: "failed",
  completedAt: 1793663093,
  error: { message: "Selected model is at capacity.", codexErrorInfo: "serverOverloaded" },
});
test("only a failure on a passing condition reads as transient", () => {
  expect(transient(overloaded("t"))).toBe(1793663093);
  expect(transient({ ...overloaded("t"), status: "completed" })).toBe(0);
  expect(transient({ ...overloaded("t"), error: { codexErrorInfo: "cyberPolicy" } })).toBe(0);
  expect(transient({ ...overloaded("t"), error: { codexErrorInfo: { httpConnectionFailed: {} } } })).toBe(0);
  expect(transient({ ...overloaded("t"), completedAt: null })).toBe(0);
  expect(transient(null)).toBe(0);
});
test("a failed turn starts again, with no new input, only while it is the thread's latest and nothing runs", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-retry-"),
    path = dir + "/control.sock",
    started: unknown[] = [],
    calls: string[] = [],
    clear = () => true;
  let status = "idle",
    latest: unknown = overloaded("one");
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (!value.id) return;
        calls.push(value.method);
        if (value.method === "turn/start") started.push(value.params);
        const result =
          value.method === "thread/read"
            ? { thread: { id: "s", status: { type: status } } }
            : value.method === "thread/turns/list"
              ? { data: [latest], nextCursor: null }
              : {};
        ws.send(JSON.stringify({ id: value.id, result }));
      },
    },
  });
  try {
    expect(await retry(path, "s", "one", clear)).toBe("started");
    expect(started).toEqual([{ threadId: "s", input: [] }]);
    // A newer turn, one that ended otherwise, or one running, is left alone.
    expect(await retry(path, "s", "older", clear)).toBe("declined");
    latest = { ...overloaded("one"), error: { codexErrorInfo: "cyberPolicy" } };
    expect(await retry(path, "s", "one", clear)).toBe("declined");
    latest = overloaded("one");
    status = "active";
    expect(await retry(path, "s", "one", clear)).toBe("declined");
    status = "notLoaded";
    expect(await retry(path, "s", "one", clear)).toBe("declined");
    expect(started).toHaveLength(1);
    expect(await retry(dir + "/missing.sock", "s", "one", clear)).toBe("declined");
    // Codex would steer a turn a prompt typed meanwhile started, so the pane
    // has the last word, once the thread has had its say.
    status = "idle";
    calls.length = 0;
    const asked: string[][] = [];
    expect(await retry(path, "s", "one", () => (asked.push([...calls]), false))).toBe("held");
    expect(asked).toEqual([["initialize", "thread/read", "thread/turns/list"]]);
    expect(started).toHaveLength(1);
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
