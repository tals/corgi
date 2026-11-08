import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { randomFillSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { listenRaw, listenWebSocket, listenWebSocketClient } from "./adapter";

async function fixture(mode: "raw" | "plain" | "deflate", accepted: (socket: Socket) => void) {
  const websocket = mode !== "raw";
  const directory = mkdtempSync("/tmp/corgi-ws-adapter-"),
    targets = new Set<Socket>();
  const server = createServer(socket => {
    targets.add(socket);
    socket.on("error", () => {});
    socket.on("close", () => targets.delete(socket));
    accepted(socket);
  });
  await new Promise<void>(resolve => server.listen(directory + "/daemon", resolve));
  const remote = await (websocket ? listenWebSocket : listenRaw)({
    path: directory + "/remote",
    target: directory + "/daemon",
    deflate: mode === "deflate",
  });
  const local = await (websocket ? listenWebSocketClient : listenRaw)({
    path: directory + "/local",
    target: directory + "/remote",
    deflate: mode === "deflate",
  });
  const client = createConnection(directory + "/local");
  client.on("error", () => {});
  const chunks: Buffer[] = [];
  client.on("data", bytes => chunks.push(Buffer.from(bytes)));
  const ended = new Promise<void>(resolve => client.once("end", resolve));
  const connected = new Promise<void>(resolve => client.once("connect", resolve));
  return {
    client,
    connected,
    ended,
    chunks,
    remote,
    local,
    async close() {
      client.destroy();
      await local.close();
      await remote.close();
      for (const target of targets) target.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

for (const mode of ["raw", "plain", "deflate"] as const) {
  const websocket = mode !== "raw";
  test(`${mode} preserves final bytes before EOF`, async () => {
    const payload = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = i % 251;
    const f = await fixture(mode, socket => socket.once("data", () => socket.end(payload)));
    try {
      await f.connected;
      f.client.write("send");
      await f.ended;
      expect(Buffer.concat(f.chunks).length).toBe(payload.length);
      expect(Buffer.concat(f.chunks).equals(payload)).toBe(true);
      expect(f.remote.metrics.toClient).toBe(payload.length);
      expect(f.local.metrics.toClient).toBe(payload.length);
      expect(f.remote.metrics.drops + f.local.metrics.drops).toBe(0);
    } finally {
      await f.close();
    }
  });

  test(`${mode} bounds queues while a reader pauses and resumes`, async () => {
    const payload = randomFillSync(Buffer.alloc(8 * 1024 * 1024));
    const f = await fixture(mode, socket => socket.once("data", () => socket.end(payload)));
    try {
      await f.connected;
      f.client.pause();
      f.client.write("send");
      await Bun.sleep(50);
      f.client.resume();
      await f.ended;
      expect(Buffer.concat(f.chunks).length).toBe(payload.length);
      expect(Buffer.concat(f.chunks).equals(payload)).toBe(true);
      for (const adapter of [f.local, f.remote]) {
        expect(adapter.metrics.clientPeak).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(adapter.metrics.targetPeak).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(adapter.metrics.drops).toBe(0);
      }
      if (mode === "plain") expect(f.local.metrics.pauses + f.remote.metrics.pauses).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });

  test(`${mode} propagates an abrupt upstream close`, async () => {
    const f = await fixture(mode, socket =>
      socket.once("data", () => {
        socket.write("ready\n");
        socket.once("data", () => socket.destroy());
      }),
    );
    try {
      await f.connected;
      const ready = new Promise<void>(resolve => f.client.once("data", () => resolve()));
      f.client.write("open");
      await ready;
      f.client.write("reset");
      await f.ended;
      expect(Buffer.concat(f.chunks).toString()).toBe("ready\n");
    } finally {
      await f.close();
    }
  });

  test(`${mode} bounds uploads while the upstream reader pauses`, async () => {
    const payload = randomFillSync(Buffer.alloc(8 * 1024 * 1024)),
      uploaded: Buffer[] = [];
    let received = 0;
    const f = await fixture(mode, socket => {
      socket.pause();
      setTimeout(() => socket.resume(), 50);
      socket.on("data", bytes => {
        uploaded.push(Buffer.from(bytes));
        received += bytes.length;
        if (received === payload.length) socket.end("complete\n");
      });
    });
    try {
      await f.connected;
      f.client.write(payload);
      await f.ended;
      expect(Buffer.concat(uploaded).length).toBe(payload.length);
      expect(Buffer.concat(uploaded).equals(payload)).toBe(true);
      expect(Buffer.concat(f.chunks).toString()).toBe("complete\n");
      for (const adapter of [f.local, f.remote]) {
        expect(adapter.metrics.targetPeak).toBeLessThanOrEqual(4 * 1024 * 1024);
        expect(adapter.metrics.drops).toBe(0);
      }
      if (mode === "plain") expect(f.local.metrics.pauses + f.remote.metrics.pauses).toBeGreaterThan(0);
    } finally {
      await f.close();
    }
  });
}

test("native deflate preserves a compressible burst up to the controller raw-flight cap", async () => {
  const payload = Buffer.alloc(2 * 1024 * 1024, 121);
  const f = await fixture("deflate", socket => socket.once("data", () => socket.end(payload)));
  try {
    await f.connected;
    f.client.pause();
    f.client.write("send");
    await Bun.sleep(50);
    f.client.resume();
    await f.ended;
    expect(Buffer.concat(f.chunks).length).toBe(payload.length);
    expect(Buffer.concat(f.chunks).equals(payload)).toBe(true);
    expect(f.local.metrics.drops + f.remote.metrics.drops).toBe(0);
  } finally {
    await f.close();
  }
});

test("native deflate closes on receive expansion beyond the bounded queue", async () => {
  const payload = Buffer.alloc(8 * 1024 * 1024, 121);
  const f = await fixture("deflate", socket => socket.once("data", () => socket.end(payload)));
  const closed = new Promise<void>(resolve => f.client.once("close", () => resolve()));
  try {
    await f.connected;
    f.client.pause();
    f.client.write("send");
    await Bun.sleep(200);
    f.client.resume();
    await closed;
    const received = Buffer.concat(f.chunks);
    expect(f.local.metrics.drops + f.remote.metrics.drops).toBeGreaterThan(0);
    expect(received.length).toBeLessThan(payload.length);
    expect(received.equals(payload.subarray(0, received.length))).toBe(true);
  } finally {
    await f.close();
  }
});
