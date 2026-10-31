import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "./viewer_connection";
import * as json from "./json";
import * as protocol from "./protocol";

test("a viewer shares two connections across requests, subscriptions, and pane content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-viewer-rpc-")),
    path = join(dir, "rpc.sock"),
    sockets: Socket[] = [],
    received: { socket: Socket; op: string; surfaces?: boolean }[] = [],
    events: protocol.Event[] = [],
    held = Promise.withResolvers<void>();
  let finish!: () => void;
  const server = createServer(socket => {
    sockets.push(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const q = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        received.push({ socket, op: q.op, surfaces: q.surfaces });
        const send = (value: object) => socket.write(json.stringify(value) + "\n"),
          reply = (value: object) => send({ request_id: q.request_id, ...value });
        switch (q.op) {
          case "viewer.sync":
            reply({ type: "view", viewer_protocol: protocol.viewer_version, viewer: 1, surfaces: [] });
            break;
          case "viewer.surfaces":
            // A delayed content response must not hold control replies or events.
            finish = () => reply({ ok: true, surfaces: [{ surface: { pane: 1 } }] });
            send({ type: "viewer.wake" });
            held.resolve();
            break;
          case "agent.subscribe":
            reply({ type: "agent.preview", cwd: q.cwd, preview: {} });
            send({ type: "agent.preview", cwd: q.cwd, preview: {} });
            break;
          case "agent.history":
            reply({ ok: true });
            send({ type: "agent.history", update: { full: true, entries: [], removed: [] } });
            break;
          default:
            reply({ ok: true });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const connection = new Connection(path),
    unsubscribe = connection.onEvent(event => events.push(event));
  let syncing: Promise<protocol.Response<"viewer.sync">> | null = null;
  try {
    await connection.request("viewer.open");
    syncing = connection.request("viewer.sync", { interests: [] });
    await held.promise;
    await connection.request("agent.subscribe", { workspace: 1, cwd: "/a" });
    await connection.request("agent.history", { follow: true });
    await connection.request("git.branches", { workspace: 1 });
    await connection.request("viewer.image", { pane: 1, image: "1", offset: 0 });
    await connection.request("viewer.pick", { pane: 1, offset: 0, unit: "word", x: 0, y: 0 });
    await connection.request("session.command", { command: { "pane.input": { target: 1, data: "text" } } });
    await connection.request("agent.subscribe", { workspace: 2, cwd: "/b" });
    await connection.request("ping");
    finish();
    expect(await syncing).toMatchObject({ surfaces: [{ surface: { pane: 1 } }] });
    expect(sockets).toHaveLength(2);
    const control = received.find(r => r.op === "viewer.open")!.socket,
      data = received.find(r => r.op === "viewer.watch")!.socket;
    expect(control).not.toBe(data);
    for (const op of [
      "viewer.open",
      "viewer.sync",
      "agent.subscribe",
      "agent.history",
      "git.branches",
      "session.command",
      "ping",
    ])
      expect(received.filter(r => r.op === op).every(r => r.socket === control)).toBe(true);
    for (const op of ["viewer.watch", "viewer.surfaces", "viewer.image", "viewer.pick"])
      expect(received.filter(r => r.op === op).every(r => r.socket === data)).toBe(true);
    expect(received.find(r => r.op === "viewer.sync")!.surfaces).toBe(false);
    expect(events.map(e => e.type).sort()).toEqual(["agent.history", "agent.preview", "agent.preview", "viewer.wake"]);
  } finally {
    unsubscribe();
    connection.close();
    await syncing?.catch(() => {});
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a refused watch leaves the viewer syncing and is asked again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-viewer-rpc-")),
    path = join(dir, "rpc.sock"),
    sockets: Socket[] = [];
  let watches = 0;
  const server = createServer(socket => {
    sockets.push(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const q = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const reply = (value: object) => socket.write(json.stringify({ request_id: q.request_id, ...value }) + "\n");
        switch (q.op) {
          case "viewer.sync":
            reply({ type: "view", viewer_protocol: protocol.viewer_version, viewer: 1, surfaces: [] });
            break;
          case "viewer.watch":
            reply(++watches === 1 ? { err: "NoViewer" } : { ok: true });
            break;
          default:
            reply({ ok: true, surfaces: [] });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const connection = new Connection(path);
  try {
    expect(await connection.request("viewer.sync", { interests: [] })).toMatchObject({ viewer: 1 });
    expect(connection.watches()).toBe(false);
    await connection.request("viewer.sync", { interests: [] });
    expect(watches).toBe(2);
    expect(connection.watches()).toBe(true);
    await connection.request("viewer.sync", { interests: [] });
    expect(watches).toBe(2);
  } finally {
    connection.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});
