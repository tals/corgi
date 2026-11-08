import { expect, test } from "bun:test";
import * as net from "node:net";
import * as fs from "node:fs";
import * as json from "./json";
import * as protocol from "./protocol";
import * as rpc_http from "./rpc_http";

async function fixture(mode: "modern" | "http-old" | "raw", drop = false) {
  const directory = fs.mkdtempSync("/tmp/corgi-http-"),
    path = directory + "/s";
  const received: { transport: string; request: Record<string, unknown> }[] = [],
    sockets = new Set<net.Socket>();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = Buffer.alloc(0),
      done = false;
    socket.on("data", (chunk: Buffer) => {
      if (done) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length < 5) return;
      const http = buffer.subarray(0, 5).toString() === "POST ";
      if (http && mode === "raw") {
        done = true;
        socket.end('{"err":"UnexpectedToken"}\n');
        return;
      }
      let body: string;
      if (http) {
        const end = buffer.indexOf("\r\n\r\n");
        if (end < 0) return;
        const size = Number(/content-length: (\d+)/i.exec(buffer.toString("utf8", 0, end))?.[1]);
        if (buffer.length < end + 4 + size) return;
        body = buffer.toString("utf8", end + 4, end + 4 + size);
      } else {
        const end = buffer.indexOf(10);
        if (end < 0) return;
        body = buffer.toString("utf8", 0, end);
      }
      done = true;
      const request = json.object(json.parse(body));
      received.push({ transport: http ? "http" : "stream", request });
      if (drop && request.op !== "hello") return socket.destroy();
      const reply = json.stringify(
        request.op === "hello"
          ? { type: "hello", protocol: 3, ...(mode === "modern" ? { transports: protocol.transports } : {}) }
          : request.op === "reject"
            ? { err: "ReloadBusy", busy: { op: "worktree.add" } }
            : { ok: true, value: request.value },
      );
      socket.end(
        http
          ? `HTTP/1.1 ${request.op === "reject" ? "400 Bad Request" : "200 OK"}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(reply)}\r\nConnection: close\r\n\r\n${reply}`
          : reply + "\n",
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

test.each(["modern", "http-old", "raw"] as const)("discover %s before choosing the upgrade transport", async mode => {
  const server = await fixture(mode);
  try {
    const reply = await rpc_http.call(server.path, "server.reload", { executable: "/new/corgi" });
    expect(reply).toEqual({ ok: true });
    expect(server.received).toEqual([
      { transport: mode === "raw" ? "stream" : "http", request: json.object(protocol.envelope("hello")) },
      {
        transport: mode === "modern" ? "http" : "stream",
        request: json.object(protocol.envelope("server.reload", { executable: "/new/corgi" })),
      },
    ]);
  } finally {
    await server.close();
  }
});

test("older HTTP servers use HTTP for probes, preflight saves and compatibility controls", async () => {
  const server = await fixture("http-old");
  try {
    expect((await rpc_http.discover(server.path)).hello).toMatchObject({ protocol: 3 });
    await rpc_http.rawRequest(server.path, { op: "recovery.save", protocol: 3 });
    await rpc_http.call(server.path, "shutdown");
    expect(server.received.every(entry => entry.transport === "http")).toBe(true);
    expect(server.received.map(entry => entry.request.op)).toEqual([
      "hello",
      "hello",
      "recovery.save",
      "hello",
      "shutdown",
    ]);
  } finally {
    await server.close();
  }
});

test.each(["modern", "http-old", "raw"] as const)("a lost %s mutation reply is never replayed", async mode => {
  const server = await fixture(mode, true);
  try {
    await expect(rpc_http.call(server.path, "server.reload", { executable: "/new/corgi" })).rejects.toThrow();
    expect(server.received.filter(entry => entry.request.op === "server.reload")).toHaveLength(1);
    expect(server.received).toHaveLength(2);
  } finally {
    await server.close();
  }
});

test("HTTP preserves caller ids, Unicode, big integers and structured errors", async () => {
  const server = await fixture("modern");
  try {
    const query = { op: "echo", request_id: 73, value: { text: "犬🐕", counter: 9007199254740993n } };
    expect(await rpc_http.rawRequest(server.path, query)).toEqual({ ok: true, value: query.value });
    expect(server.received.at(-1)?.request).toEqual(query);
    expect(await rpc_http.rawRequest(server.path, { op: "reject" })).toEqual({
      err: "ReloadBusy",
      busy: { op: "worktree.add" },
    });
  } finally {
    await server.close();
  }
});

test("a failed HTTP response never triggers raw discovery", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-error-"),
    path = directory + "/s";
  let connections = 0;
  const server = net.createServer(socket => {
    connections++;
    socket.once("data", () => socket.end("HTTP/1.1 503 Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    await expect(rpc_http.call(path, "server.reload", { executable: "/new/corgi" })).rejects.toThrow(
      "UnexpectedHttpStatus",
    );
    expect(connections).toBe(1);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a silent probe expires without sending the requested mutation", async () => {
  const directory = fs.mkdtempSync("/tmp/corgi-http-timeout-"),
    path = directory + "/s";
  const sockets = new Set<net.Socket>(),
    received: string[] = [];
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", chunk => received.push(chunk.toString()));
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    const started = performance.now();
    await expect(
      rpc_http.rawRequest(path, protocol.envelope("server.reload", { executable: "/new/corgi" }), 80),
    ).rejects.toThrow("RequestTimedOut");
    expect(performance.now() - started).toBeLessThan(2000);
    expect(received.length).toBeGreaterThan(0);
    expect(received.every(bytes => bytes.includes('"op":"hello"') && !bytes.includes("server.reload"))).toBe(true);
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
