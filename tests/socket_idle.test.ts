import { test, expect } from "bun:test";
import { connect } from "node:net";
import { join } from "node:path";
import { Server } from "../src/server";
import { Connection } from "../src/rpc";
import * as protocol from "../src/protocol";
import * as socketServer from "../src/socket_server";
import * as websocket from "../src/wire_websocket";
import { Workspace } from "../src/workspace";
import { deadline, tempDir, waitUntil } from "./support";

test("idle pongs keep a client connected; a silent client closes and releases its worktree interest", async () => {
  const temp = tempDir("corgi-idle-"),
    path = join(temp.name, "s"),
    server = new Server(path, "", "0".repeat(64));
  server.runtime.workspaces.items.push(new Workspace(1, temp.name), new Workspace(2, temp.name));
  const listener = socketServer.listen(path, {
      connection: transport => server.addClient(transport),
      request: () => null,
    }),
    healthy = new Connection(path),
    silent = connect(path),
    opened = Promise.withResolvers<void>(),
    closed = Promise.withResolvers<void>();
  let headers = "";
  silent.on("error", error => opened.reject(error));
  silent.on("close", () => closed.resolve());
  silent.on("connect", () => {
    silent.write(
      "GET /rpc HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n" +
        `Sec-WebSocket-Protocol: ${websocket.protocol}\r\n\r\n`,
    );
  });
  // Read the upgrade reply, then consume frames without answering any pings.
  silent.on("data", chunk => {
    if (headers.includes("\r\n\r\n")) return;
    headers += chunk.toString();
    if (headers.includes("\r\n\r\n")) {
      if (headers.startsWith("HTTP/1.1 101")) opened.resolve();
      else opened.reject(Error("WebSocket upgrade failed"));
    }
  });
  try {
    await healthy.call("session.snapshot", { worktree_detail: 1 });
    await deadline(opened.promise, 3000);
    const payload = Buffer.from(
      JSON.stringify({ op: "session.snapshot", protocol: protocol.version, worktree_detail: 2 }) + "\n",
    );
    expect(payload.length).toBeLessThan(126);
    // A binary client frame, masked with four zero bytes.
    silent.write(Buffer.concat([Buffer.from([0x82, 0x80 | payload.length, 0, 0, 0, 0]), payload]));
    await waitUntil(() => server.clients.some(client => client.worktree_detail === 2), 3);
    const live = server.clients.find(client => client.worktree_detail === 1)!,
      dead = server.clients.find(client => client.worktree_detail === 2)!,
      started = performance.now();
    await deadline(closed.promise, 45_000, "Unanswered WebSocket pings did not close the client");
    expect(dead.dead).toBe(true);
    expect(server.clients).not.toContain(dead);
    // Cross the configured 32-second boundary without application traffic.
    await Bun.sleep(Math.max(0, 34_000 - (performance.now() - started)));
    expect(healthy.disconnected).toBe(false);
    expect(server.clients).toEqual([live]);
    expect(live.worktree_detail).toBe(1);
    expect((await healthy.call("ping")).ok).toBe(true);
  } finally {
    healthy.close();
    silent.destroy();
    await listener.stop(true);
    for (const client of [...server.clients]) client.close();
    await Reflect.get(server, "jobs");
    server.runtime.destroy();
    Reflect.get(server, "loop").close();
    temp.cleanup();
  }
}, 55_000);
