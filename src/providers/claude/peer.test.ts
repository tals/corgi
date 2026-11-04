import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import { message, peerIn } from "./peer";
test("a session's peer is its live record's socket and key", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-peer-")),
    socket = "/tmp/cc-socks/1.sock";
  try {
    for (const [file, sessionId, peerProtocol, pid, messagingSocketPath] of [
      ["1.json", "live", 1, process.pid, socket],
      ["2.json", "future", 2, process.pid, socket],
      ["3.json", "gone", 1, 2147483647, socket],
      ["4.json", "keyless", 1, process.pid, "/tmp/cc-socks/4.sock"],
    ])
      writeFileSync(join(root, String(file)), JSON.stringify({ sessionId, peerProtocol, pid, messagingSocketPath }));
    const digest = createHash("sha256").update(socket).digest("hex");
    writeFileSync(join(root, `${process.pid}.${digest}.key`), '{"peerToken":"secret"}');
    expect(await peerIn(root, "LIVE")).toEqual({ socket, token: "secret" });
    for (const session of ["future", "gone", "keyless", "missing"]) expect(await peerIn(root, session)).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("a message is a queued user prompt for the session, after the peer's auth line", async () => {
  const root = mkdtempSync(join(tmpdir(), "corgi-peer-")),
    socket = join(root, "inbox.sock"),
    received = Promise.withResolvers<string>();
  const server = createServer(connection => {
    let text = "";
    connection.on("data", chunk => (text += chunk));
    connection.on("end", () => received.resolve(text));
  });
  try {
    await new Promise<void>(resolve => server.listen(socket, resolve));
    await message({ socket, token: "secret" }, "live", "review the diff");
    const [auth, frame, rest] = (await received.promise).split("\n").map(line => (line ? JSON.parse(line) : line));
    expect(auth).toEqual({ type: "auth", token: "secret" });
    expect(frame).toMatchObject({
      type: "user",
      message: { role: "user", content: "review the diff" },
      priority: "next",
      session_id: "live",
    });
    expect(rest).toBe("");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
