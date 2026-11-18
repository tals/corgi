import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { send } from "./message";
import * as codexServer from "../../fixtures/codex_server";
test("a prompt starts a turn, and a failure says whether the server may have taken it", async () => {
  const dir = mkdtempSync(tmpdir() + "/corgi-ts-message-"),
    path = dir + "/control.sock",
    started: unknown[] = [];
  let answer: "ok" | "error" | "hang up" = "ok";
  await expect(send(path, "s", "hi")).rejects.toThrow("MessageUnavailable");
  const server = codexServer.serve(path, ({ method, params }) => {
    if (method !== "turn/start") return { result: {} };
    started.push(params);
    if (answer === "hang up") return null;
    return answer === "ok" ? { result: {} } : { error: { code: -32600, message: "no" } };
  });
  try {
    await send(path, "s", "review this");
    expect(started).toEqual([{ threadId: "s", input: [{ type: "text", text: "review this" }] }]);
    answer = "error";
    await expect(send(path, "s", "x")).rejects.toThrow("MessageUnavailable");
    answer = "hang up";
    await expect(send(path, "s", "x")).rejects.toThrow("DeliveryUnknown");
    // Too large to send at all, so typing can still take it.
    await expect(send(path, "s", "x".repeat(3 << 20))).rejects.toThrow("MessageUnavailable");
  } finally {
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});
