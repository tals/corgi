import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "./codex_socket";
import { unique, threadState, isActiveWait } from "./codex_observer";
import { Text } from "./agents";
test("Unix WebSocket client initializes and reads responses without selecting sessions", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-ws-"),
    socket = dir + "/control.sock",
    methods: string[] = [];
  const server = Bun.serve({
    unix: socket,
    fetch(req, server) {
      return server.upgrade(req)
        ? undefined
        : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        methods.push(value.method);
        if (value.id)
          ws.send(
            JSON.stringify({
              id: value.id,
              result: value.method === "thread/list" ? { data: [] } : {},
            }),
          );
      },
    },
  });
  let c: Client | null = null;
  try {
    c = await Client.open(socket);
    expect(await c.call("thread/list", {})).toMatchObject({
      result: { data: [] },
    });
    expect(methods).toContain("initialize");
    expect(methods).toContain("initialized");
    expect(methods).not.toContain("thread/resume");
  } finally {
    c?.close();
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
test("title prefixes refuse collisions and unloaded children read idle", () => {
  const ids = [
    "01901234-1234-1234-1234-123456789abc",
    "01901234-1234-1234-1234-123456789def",
  ];
  expect(unique(ids, new Text(ids[0].slice(0, 29)))).toBeNull();
  expect(unique(ids, new Text(ids[0]))).toBe(ids[0]);
  expect(threadState({ type: "notLoaded" })).toBe("idle");
  expect(threadState({ type: "systemError" })).toBe("idle");
  expect(
    threadState({ type: "active", activeFlags: ["waitingOnApproval"] }),
  ).toBe("blocked");
  expect(
    isActiveWait(
      {
        turnId: "a",
        item: {
          type: "collabAgentToolCall",
          tool: "wait",
          status: "inProgress",
          senderThreadId: "s",
        },
      },
      "a",
      "s",
    ),
  ).toBe(true);
});
