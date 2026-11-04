import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { send } from "./message";
test("a prompt starts a turn, and a failure says whether the server may have taken it", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-message-"),
    path = dir + "/control.sock",
    started: unknown[] = [];
  let answer: "ok" | "error" | "hang up" = "ok";
  await expect(send(path, "s", "hi")).rejects.toThrow("MessageUnavailable");
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      return server.upgrade(req) ? undefined : new Response("bad", { status: 400 });
    },
    websocket: {
      message(ws, message) {
        const value = JSON.parse(String(message));
        if (!value.id) return;
        if (value.method !== "turn/start") return void ws.send(JSON.stringify({ id: value.id, result: {} }));
        started.push(value.params);
        if (answer === "hang up") return ws.close();
        ws.send(
          JSON.stringify(
            answer === "ok" ? { id: value.id, result: {} } : { id: value.id, error: { code: -32600, message: "no" } },
          ),
        );
      },
    },
  });
  try {
    await send(path, "s", "review this");
    expect(started).toEqual([{ threadId: "s", input: [{ type: "text", text: "review this" }] }]);
    answer = "error";
    await expect(send(path, "s", "x")).rejects.toThrow("MessageUnavailable");
    answer = "hang up";
    await expect(send(path, "s", "x")).rejects.toThrow("DeliveryUnknown");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
