import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as rpc from "./rpc";
import * as start_lock from "./start_lock";
import * as websocket from "./wire_websocket";
import { Stream } from "./machine_stream";

test.each(["plain", "with space", "with#hash", "with%percent", "with?query", "with:colon", "日本語"])(
  "native WS preserves filesystem path %s and its final reply before EOF",
  async name => {
    const dir = fs.mkdtempSync("/tmp/corgi-ws-client-"),
      path = dir + "/" + name;
    const server = Bun.serve({
      unix: path,
      fetch(req, server) {
        if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        perMessageDeflate: false,
        message(ws, bytes) {
          const value = JSON.parse(bytes.toString());
          ws.send(Buffer.from(JSON.stringify({ request_id: value.request_id, ok: true, pid: 7 }) + "\n"));
          ws.close(1000);
        },
      },
    });
    const conn = new rpc.Connection(path, { timeout_ms: 1000 });
    try {
      expect(await conn.call("ping")).toEqual({ ok: true, pid: 7 });
      expect(Reflect.get(conn.socket, "alias")).toBeNull();
    } finally {
      conn.close();
      await server.stop(true);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  },
);
test("closing before WebSocket opens settles pending RPC and releases its socket", async () => {
  const conn = new rpc.Connection("/tmp/corgi-does-not-exist-ws", { timeout_ms: 1000 });
  const pending = conn.call("ping");
  conn.close();
  await expect(pending).rejects.toThrow("ConnectionClosed");
  await Bun.sleep(10);
  expect(conn.socket.destroyed).toBe(true);
});
test("rollback close preserves the final reply and reaches an idle machine stream", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-rollback-"),
    path = directory + "/s";
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      if (server.upgrade(req, { headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      message(ws, bytes) {
        const value = JSON.parse(bytes.toString());
        ws.send(Buffer.from(JSON.stringify({ request_id: value.request_id, ok: true, pid: 7 }) + "\n"));
        ws.close(websocket.rolled_back);
      },
    },
  });
  const connection = new rpc.Connection(path, { timeout_ms: 1000 }),
    stream = new Stream(connection);
  try {
    const closed = new Promise<void>(resolve => connection.onClose(resolve));
    expect(await connection.call("ping")).toEqual({ ok: true, pid: 7 });
    await closed;
    expect(connection.failure?.message).toBe("ServerRolledBack");
    expect(() => stream.check()).toThrow("ServerRolledBack");
  } finally {
    connection.close();
    await server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("a request written while the socket is closing for a reload fails as the reload", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-closing-"),
    path = directory + "/s";
  let daemon: Bun.ServerWebSocket<undefined> | null = null;
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      if (server.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        daemon = ws;
      },
      message(ws, bytes) {
        const value = JSON.parse(bytes.toString());
        ws.send(Buffer.from(JSON.stringify({ request_id: value.request_id, ok: true, pid: 7 }) + "\n"));
      },
    },
  });
  const connection = new rpc.Connection(path, { timeout_ms: 1000 });
  try {
    expect(await connection.call("ping")).toEqual({ ok: true, pid: 7 });
    // Bun says it's closing before `onclose` brings the code.
    const ws = Reflect.get(connection.socket, "ws");
    Object.defineProperty(ws, "readyState", { configurable: true, value: WebSocket.CLOSING });
    const pending = connection.call("ping").catch(error => error);
    await Bun.sleep(10);
    daemon!.close(websocket.reloading);
    expect((await pending).message).toBe("ServerReloading");
    expect(connection.failure?.message).toBe("ServerReloading");
  } finally {
    connection.close();
    await server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a daemon shutting down closes with going away, which says so", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-closing-"),
    path = directory + "/s";
  let daemon: Bun.ServerWebSocket<undefined> | null = null;
  const server = Bun.serve({
    unix: path,
    fetch(req, server) {
      if (server.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
      return new Response(null, { status: 400 });
    },
    websocket: {
      open(ws) {
        daemon = ws;
      },
      message(ws, bytes) {
        const value = JSON.parse(bytes.toString());
        ws.send(Buffer.from(JSON.stringify({ request_id: value.request_id, ok: true, pid: 7 }) + "\n"));
      },
    },
  });
  const connection = new rpc.Connection(path, { timeout_ms: 1000 });
  try {
    expect(await connection.call("ping")).toEqual({ ok: true, pid: 7 });
    // Bun says it's closing before `onclose` brings the code.
    const ws = Reflect.get(connection.socket, "ws");
    Object.defineProperty(ws, "readyState", { configurable: true, value: WebSocket.CLOSING });
    const pending = connection.call("ping").catch(error => error);
    await Bun.sleep(10);
    daemon!.close(websocket.going_away);
    expect((await pending).message).toBe("ServerShutdown");
    expect(connection.failure?.message).toBe("ServerShutdown");
  } finally {
    connection.close();
    await server.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("failed WebSocket connect preserves errno and removes its path alias", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-absent-");
  const connection = new rpc.Connection(directory + "/absent socket");
  try {
    await expect(connection.call("ping")).rejects.toMatchObject({ code: "ENOENT" });
    await Bun.sleep(10);
    expect(connection.socket.destroyed).toBe(true);
    expect(Reflect.get(connection.socket, "alias")).toBeNull();
  } finally {
    connection.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test.each(["s", "with space"])(
  "cancellation closes an accepted socket whose HTTP upgrade never answers (%s)",
  async name => {
    const directory = fs.mkdtempSync("/tmp/corgi-ws-hung-"),
      path = directory + "/" + name;
    const accepted = Promise.withResolvers<net.Socket>(),
      closed = Promise.withResolvers<void>();
    const server = net.createServer(socket => {
      socket.on("data", () => {});
      socket.on("error", () => {});
      socket.on("close", () => closed.resolve());
      accepted.resolve(socket);
    });
    await new Promise<void>(resolve => server.listen(path, resolve));
    const connection = new rpc.Connection(path);
    const pending = connection.call("ping"),
      result = pending.catch(error => error);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const socket = await accepted.promise;
    try {
      connection.close();
      expect((await result).message).toBe("ConnectionClosed");
      await Promise.race([
        closed.promise,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(Error("SocketLeaked")), 1000);
        }),
      ]);
      await Bun.sleep(10);
      expect(Reflect.get(connection.socket, "alias")).toBeNull();
    } finally {
      clearTimeout(timer);
      connection.close();
      socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    }
  },
);
test("while a daemon is starting, a refused WebSocket opens once it answers", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-starting-"),
    path = directory + "/s",
    lock = (await start_lock.take(path))!;
  // Something that answers, but not with WebSockets, as an older build does.
  const older = Bun.serve({ unix: path, fetch: () => new Response(null, { status: 400 }) });
  let server: ReturnType<typeof Bun.serve> | null = null;
  setTimeout(() => {
    void older.stop(true);
    server = Bun.serve({
      unix: path,
      fetch(req, server) {
        if (server.upgrade(req, { data: undefined, headers: { "Sec-WebSocket-Protocol": websocket.protocol } })) return;
        return new Response(null, { status: 400 });
      },
      websocket: {
        perMessageDeflate: false,
        message(ws, bytes) {
          const value = JSON.parse(bytes.toString());
          ws.send(Buffer.from(JSON.stringify({ request_id: value.request_id, ok: true, pid: 8 }) + "\n"));
        },
      },
    });
    start_lock.release(lock);
  }, 150);
  const conn = new rpc.Connection(path, { timeout_ms: 3000 });
  try {
    expect(await conn.call("ping")).toEqual({ ok: true, pid: 8 });
  } finally {
    conn.close();
    await (server as ReturnType<typeof Bun.serve> | null)?.stop(true);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("a refused WebSocket fails at once when no daemon is starting", async () => {
  const conn = new rpc.Connection("/tmp/corgi-does-not-exist-ws", { timeout_ms: 3000 });
  const started = performance.now();
  await expect(conn.call("ping")).rejects.toThrow();
  expect(performance.now() - started).toBeLessThan(1000);
  conn.close();
});
