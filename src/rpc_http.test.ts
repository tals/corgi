import { expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as json from "./json";
import * as protocol from "./protocol";
import * as rpc_http from "./rpc_http";
import * as start_lock from "./start_lock";
import * as text from "./text";

/** A daemon that answers each POST, or drops the connection instead of answering;
 * its first `incomplete` hellos hear an update an older build started isn't done. */
async function fixture(drop = false, incomplete = 0) {
  const directory = fs.mkdtempSync("/tmp/corgi-http-"),
    path = directory + "/s";
  const received: Record<string, unknown>[] = [],
    sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const size = Number(/content-length: (\d+)/i.exec(buffer.toString("utf8", 0, end))?.[1]);
      if (buffer.length < end + 4 + size) return;
      const request = json.object(json.parse(buffer.toString("utf8", end + 4, end + 4 + size)));
      received.push(request);
      if (drop && request.op !== "hello") return socket.destroy();
      const reply = json.stringify(
        request.op === "hello"
          ? incomplete-- > 0
            ? { err: "UpdateIncomplete" }
            : { type: "hello", protocol: protocol.version, transports: protocol.transports }
          : request.op === "reject"
            ? { err: "ReloadBusy", busy: { op: "worktree.add" } }
            : { ok: true, value: request.value },
      );
      const status = reply.includes('"err"') ? "400 Bad Request" : "200 OK";
      socket.end(
        `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${text.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`,
      );
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  return {
    path,
    received,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("each call is one POST, and hello alone discovers the daemon", async () => {
  const server = await fixture();
  try {
    expect(await new rpc_http.Client(server.path).discover()).toMatchObject({
      type: "hello",
      protocol: protocol.version,
    });
    const reloaded: unknown = await new rpc_http.Client(server.path).call("server.reload", {
      executable: "/new/corgi",
    });
    expect(reloaded).toEqual({ ok: true });
    expect(server.received).toEqual([
      json.object(protocol.envelope("hello")),
      json.object(protocol.envelope("server.reload", { executable: "/new/corgi" })),
    ]);
  } finally {
    await server.close();
  }
});

test("discovery waits out an update an older build is finishing", async () => {
  const server = await fixture(false, 3);
  try {
    expect(await new rpc_http.Client(server.path).discover()).toMatchObject({ type: "hello" });
    expect(server.received.length).toBe(4);
  } finally {
    await server.close();
  }
});

test("discovery that can't wait hears the update isn't done", async () => {
  const server = await fixture(false, 1000);
  try {
    expect(await new rpc_http.Client(server.path).discover(10_000, 0)).toEqual({ err: "UpdateIncomplete" });
    expect(server.received.length).toBe(1);
    expect(await new rpc_http.Client(server.path).discover(10_000, 200)).toEqual({ err: "UpdateIncomplete" });
  } finally {
    await server.close();
  }
});

test("a lost mutation reply is never replayed", async () => {
  const server = await fixture(true);
  try {
    await expect(
      new rpc_http.Client(server.path).call("server.reload", { executable: "/new/corgi" }),
    ).rejects.toThrow();
    expect(server.received).toHaveLength(1);
  } finally {
    await server.close();
  }
});

test("HTTP preserves caller ids, Unicode, big integers and structured errors", async () => {
  const server = await fixture();
  try {
    const query = { op: "echo", request_id: 73, value: { text: "犬🐕", counter: 9007199254740993n } };
    expect(await new rpc_http.Client(server.path).post(query)).toEqual({ ok: true, value: query.value });
    expect(server.received.at(-1)).toEqual(query);
    expect(await new rpc_http.Client(server.path).post({ op: "reject" })).toEqual({
      err: "ReloadBusy",
      busy: { op: "worktree.add" },
    });
    await expect(new rpc_http.Client(server.path).call("shutdown")).resolves.toMatchObject({ ok: true });
  } finally {
    await server.close();
  }
});

test("an unexpected HTTP status fails without asking again", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-error-"),
    path = directory + "/s";
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    socket.once("data", () => socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await expect(new rpc_http.Client(path).call("server.reload", { executable: "/new/corgi" })).rejects.toThrow(
      "UnexpectedHttpStatus",
    );
    expect(connections).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a silent daemon times out", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-timeout-"),
    path = directory + "/s";
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const started = performance.now();
    await expect(new rpc_http.Client(path).post(protocol.envelope("hello"), 80)).rejects.toThrow("RequestTimedOut");
    expect(performance.now() - started).toBeLessThan(2000);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("while a daemon reloads, a request it hung up on goes again only if it's discovery", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-hangup-"),
    path = directory + "/s",
    lock = (await start_lock.take(path))!;
  const received: string[] = [];
  // Reads each request, then hangs up on the first one of each op.
  const server = net.createServer(socket => {
    socket.on("error", () => {});
    socket.on("data", chunk => {
      const op = /"op":"([^"]+)"/.exec(String(chunk))?.[1] ?? "";
      received.push(op);
      if (received.filter(seen => seen === op).length === 1) return socket.destroy();
      const reply = json.stringify({ type: "hello", protocol: protocol.version });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${text.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const daemon = new rpc_http.Client(path);
    await expect(daemon.post(protocol.envelope("pane.create", { workspace: 1 }))).rejects.toMatchObject({
      code: "ECONNRESET",
    });
    expect(received).toEqual(["pane.create"]);
    expect(await daemon.discover()).toMatchObject({ type: "hello" });
    expect(received).toEqual(["pane.create", "hello", "hello"]);
  } finally {
    start_lock.release(lock);
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
test("while a daemon starts, a request that found none goes once it answers", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-starting-"),
    path = directory + "/s",
    lock = (await start_lock.take(path))!;
  const received: string[] = [];
  const server = net.createServer(socket => {
    socket.on("data", chunk => {
      received.push(/"op":"([^"]+)"/.exec(String(chunk))?.[1] ?? "");
      const reply = json.stringify({ ok: true });
      socket.end(`HTTP/1.1 200 OK\r\nContent-Length: ${text.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`);
    });
  });
  const listening = Bun.sleep(200).then(() => new Promise<void>(resolve => server.listen(path, resolve)));
  try {
    expect(await new rpc_http.Client(path).post(protocol.envelope("pane.create", { workspace: 1 }))).toEqual({
      ok: true,
    });
    expect(received).toEqual(["pane.create"]);
  } finally {
    start_lock.release(lock);
    await listening;
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
