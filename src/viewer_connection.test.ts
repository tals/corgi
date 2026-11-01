import { test, expect } from "bun:test";
import { createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection } from "./viewer_connection";
import * as json from "./json";
import * as protocol from "./protocol";

/** Syncs until the daemon has accepted the watch and a sync has caught up. */
async function watched(connection: Connection, sent = () => true) {
  const until = Date.now() + 1000;
  while (!connection.watches() || !sent()) {
    if (Date.now() >= until) throw Error("Timeout");
    await connection.request("viewer.sync", { interests: [] });
    await Bun.sleep(1);
  }
}

test("a viewer shares two connections across requests, subscriptions, and pane content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-viewer-rpc-")),
    path = join(dir, "rpc.sock"),
    sockets: Socket[] = [],
    received: { socket: Socket; op: string; surfaces?: boolean }[] = [],
    events: protocol.Event[] = [],
    held = Promise.withResolvers<void>();
  let finish!: () => void,
    hold = false;
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
            if (!hold) {
              reply({ ok: true, surfaces: [] });
              break;
            }
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
    await watched(connection);
    hold = true;
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
    const syncs = received.filter(r => r.op === "viewer.sync");
    expect(syncs[0].surfaces).toBe(true);
    expect(syncs.at(-1)!.surfaces).toBe(false);
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

test("a refused watch uses control for surfaces and images until a later sync attaches data", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-viewer-rpc-")),
    path = join(dir, "rpc.sock"),
    sockets: Socket[] = [],
    surfaces: Socket[] = [],
    images: Socket[] = [],
    frames = [{ surface: { pane: 1 } }];
  let watches = 0;
  let control!: Socket, data!: Socket;
  const server = createServer(socket => {
    sockets.push(socket);
    let buffer = "";
    let attached = false,
      watching = false;
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const q = json.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        const reply = (value: object) => socket.write(json.stringify({ request_id: q.request_id, ...value }) + "\n");
        switch (q.op) {
          case "viewer.open":
            control = socket;
            attached = true;
            reply({ ok: true, viewer_protocol: protocol.viewer_version });
            break;
          case "viewer.sync":
            reply({
              type: "view",
              viewer_protocol: protocol.viewer_version,
              viewer: 1,
              surfaces: q.surfaces === false ? [] : frames,
            });
            break;
          case "viewer.watch":
            data = socket;
            watching = ++watches > 1;
            reply(watching ? { ok: true } : { err: "NoViewer" });
            break;
          case "viewer.surfaces":
            surfaces.push(socket);
            reply(attached || watching ? { ok: true, surfaces: frames } : { err: "NotAttached" });
            break;
          case "viewer.image":
            images.push(socket);
            reply(attached || watching ? { ok: true, data: "pixels" } : { err: "NotAttached" });
            break;
          default:
            reply({ ok: true });
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const connection = new Connection(path);
  try {
    await connection.request("viewer.open");
    expect(await connection.request("viewer.sync", { interests: [] })).toMatchObject({ viewer: 1, surfaces: frames });
    expect(connection.watches()).toBe(false);
    expect(await connection.request("viewer.image", { pane: 1, image: "1", offset: 0 })).toEqual({
      ok: true,
      data: "pixels",
    });
    expect(surfaces).toEqual([]);
    expect(images).toEqual([control]);
    await watched(connection, () => watches === 2);
    expect(watches).toBe(2);
    expect(await connection.request("viewer.image", { pane: 1, image: "1", offset: 0 })).toEqual({
      ok: true,
      data: "pixels",
    });
    expect(await connection.request("viewer.sync", { interests: [] })).toMatchObject({ viewer: 1, surfaces: frames });
    expect(watches).toBe(2);
    expect(surfaces.length).toBeGreaterThan(0);
    expect(surfaces.every(s => s === data)).toBe(true);
    expect(images).toEqual([control, data]);
    expect(control).not.toBe(data);
  } finally {
    connection.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["watch", "idle", "surfaces", "image"] as const)(
  "a data socket lost during %s falls back to control and reconnects on sync",
  async failure => {
    const dir = mkdtempSync(join(tmpdir(), "corgi-viewer-rpc-")),
      path = join(dir, "rpc.sock"),
      sockets: Socket[] = [],
      watches: Socket[] = [],
      reads: Socket[] = [],
      events: protocol.Event[] = [],
      frames = [{ surface: { pane: 1 } }];
    let control!: Socket;
    let fail: string | null = failure === "watch" ? "viewer.watch" : null;
    const server = createServer(socket => {
      sockets.push(socket);
      let buffer = "";
      let attached = false,
        watching = false;
      socket.setEncoding("utf8");
      socket.on("data", chunk => {
        buffer += chunk;
        for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
          const q = json.parse(buffer.slice(0, end));
          buffer = buffer.slice(end + 1);
          const send = (value: object) => socket.write(json.stringify(value) + "\n"),
            reply = (value: object) => send({ request_id: q.request_id, ...value });
          if (q.op === "viewer.watch") watches.push(socket);
          if (q.op === fail && !attached) {
            fail = null;
            socket.destroy();
            return;
          }
          switch (q.op) {
            case "viewer.open":
              control = socket;
              attached = true;
              reply({ ok: true, viewer_protocol: protocol.viewer_version });
              break;
            case "viewer.sync":
              reply({
                type: "view",
                viewer_protocol: protocol.viewer_version,
                viewer: 1,
                surfaces: q.surfaces === false ? [] : frames,
              });
              break;
            case "viewer.watch":
              watching = true;
              reply({ ok: true });
              send({ type: "viewer.wake" });
              break;
            case "viewer.surfaces":
            case "viewer.image":
              reads.push(socket);
              reply(
                attached || watching
                  ? q.op === "viewer.surfaces"
                    ? { ok: true, surfaces: frames }
                    : { ok: true, data: "pixels" }
                  : { err: "NotAttached" },
              );
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
    try {
      await connection.request("viewer.open");
      expect(await connection.request("viewer.sync", { interests: [] })).toMatchObject({ surfaces: frames });
      if (failure !== "watch") await watched(connection);
      expect(connection.watches()).toBe(failure !== "watch");
      if (failure === "idle") {
        watches[0].destroy();
        const until = Date.now() + 1000;
        while (connection.watches() && Date.now() < until) await Bun.sleep(1);
        expect(connection.watches()).toBe(false);
      } else if (failure !== "watch") fail = `viewer.${failure}`;
      if (failure === "image")
        expect(await connection.request("viewer.image", { pane: 1, image: "1", offset: 0 })).toEqual({
          ok: true,
          data: "pixels",
        });
      else expect(await connection.request("viewer.surfaces")).toMatchObject({ ok: true, surfaces: frames });
      expect(reads.at(-1)).toBe(control);
      expect(connection.watches()).toBe(false);
      expect(await connection.request("ping")).toMatchObject({ ok: true });
      const before = events.length;
      await watched(connection);
      expect(await connection.request("viewer.sync", { interests: [] })).toMatchObject({ surfaces: frames });
      expect(sockets).toHaveLength(3);
      expect(watches).toHaveLength(2);
      expect(watches[1]).not.toBe(watches[0]);
      expect(reads.at(-1)).toBe(watches[1]);
      expect(events.slice(before)).toEqual([{ type: "viewer.wake" }]);
      unsubscribe();
      watches[1].write('{"type":"viewer.wake"}\n');
      await connection.request("viewer.image", { pane: 1, image: "1", offset: 0 });
      expect(events).toHaveLength(before + 1);
    } finally {
      unsubscribe();
      connection.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
