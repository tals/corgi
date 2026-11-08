import { expect, test } from "bun:test";
import { Channel } from "./wire_compression";
import { Connection } from "./rpc";
import { Stream } from "./machine_stream";
import { Client } from "./peer";
import { Server } from "./server";
import * as protocol from "./protocol";
import { ReadyLoop, n, ptr, READ } from "./native_bridge";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, createConnection } from "node:net";

async function until(check: () => boolean): Promise<void> {
  const end = performance.now() + 3000;
  while (!check() && performance.now() < end) await Bun.sleep(1);
  expect(check()).toBe(true);
}
test("live history survives byte fragmentation and flushes each message with exact costs", async () => {
  const wire: Buffer[] = [],
    decoded: Buffer[] = [],
    costs: number[] = [],
    errors: Error[] = [];
  const receiver = new Channel(
    () => {},
    bytes => decoded.push(bytes),
    error => errors.push(error),
  );
  const sender = new Channel(
    bytes => {
      wire.push(bytes);
      for (const byte of bytes) receiver.decode(Buffer.from([byte]));
    },
    () => {},
    error => errors.push(error),
  );
  const data = Buffer.from(Array.from({ length: 500 }, (_, i) => `unique-${i} 界 é ${i * 7919}\n`).join(""));
  try {
    sender.encode(data, bytes => costs.push(bytes));
    await until(() => Buffer.concat(decoded).length === data.length);
    sender.encode(data, bytes => costs.push(bytes));
    await until(() => Buffer.concat(decoded).length === data.length * 2 && costs.length === 2);
    expect(Buffer.concat(decoded)).toEqual(Buffer.concat([data, data]));
    expect(costs[1]).toBeLessThan(costs[0] / 4);
    expect(costs.reduce((a, b) => a + b, 0)).toBe(Buffer.concat(wire).length);
    expect(sender.pending).toBe(0);
    expect(errors).toEqual([]);
  } finally {
    sender.close();
    receiver.close();
  }
});
test("corrupt streams and oversized encoder queues fail closed", async () => {
  const errors: Error[] = [];
  const decoder = new Channel(
    () => {},
    () => {},
    error => errors.push(error),
  );
  const encoder = new Channel(
    () => {},
    () => {},
    error => errors.push(error),
  );
  try {
    decoder.decode(Buffer.from("not a zstd stream"));
    encoder.encode(Buffer.alloc(4 * 1024 * 1024 + 1));
    await until(() => errors.length === 2);
    expect(encoder.pending).toBe(0);
  } finally {
    encoder.close();
    decoder.close();
  }
});
test("EOF waits for the last compressed message to be decoded", async () => {
  const decoded: Buffer[] = [],
    wire: Buffer[] = [],
    errors: Error[] = [];
  const sender = new Channel(
    bytes => wire.push(bytes),
    () => {},
    error => errors.push(error),
  );
  const receiver = new Channel(
    () => {},
    bytes => decoded.push(bytes),
    error => errors.push(error),
  );
  try {
    await new Promise<void>(resolve => sender.encode(Buffer.from('{"type":"viewer.reconnect"}\n'), () => resolve()));
    receiver.decode(Buffer.concat(wire));
    await receiver.drainInput();
    expect(Buffer.concat(decoded).toString()).toBe('{"type":"viewer.reconnect"}\n');
    expect(errors).toEqual([]);
  } finally {
    sender.close();
    receiver.close();
  }
});
test("a TCP reset preserves a complete compressed reply and the final reconnect notice", async () => {
  let encoder: Channel | null = null;
  const server = createServer(socket => {
    let input = "",
      compressed = false,
      answered = false;
    const read = (bytes: Buffer) => {
      input += bytes.toString();
      for (;;) {
        const end = input.indexOf("\n");
        if (end < 0) return;
        const request = JSON.parse(input.slice(0, end));
        input = input.slice(end + 1);
        if (request.op === "hello") {
          socket.write(
            JSON.stringify({ type: "hello", content_encoding: "zstd", request_id: request.request_id }) + "\n",
          );
          encoder = new Channel(
            bytes => socket.write(bytes),
            read,
            () => socket.destroy(),
          );
          compressed = true;
        } else if (!answered) {
          answered = true;
          const reply =
            JSON.stringify({ ok: true, padding: "x".repeat(1024 * 1024), request_id: request.request_id }) + "\n";
          encoder!.encode(Buffer.from(reply + '{"type":"viewer.reconnect"}\n'), () => socket.resetAndDestroy());
        }
      }
    };
    socket.on("data", bytes => (compressed ? encoder!.decode(Buffer.from(bytes)) : read(Buffer.from(bytes))));
    socket.on("error", () => {});
  });

  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  const conn = new Connection(createConnection(address.port, "127.0.0.1"), {
    compression: true,
    timeout_ms: 1000,
  });
  const events: string[] = [];
  conn.onEvent(event => events.push(event.type));
  const stream = new Stream(conn, () => {
    events.push("closed");
    try {
      stream.check();
    } catch {
      conn.close();
    }
  });
  try {
    await conn.call("hello");
    const first: Promise<unknown> = conn.call("ping"),
      pending = conn.call("ping").catch(error => error);
    expect(await first).toEqual({ ok: true, padding: "x".repeat(1024 * 1024) });
    expect((await pending).code).toBe("ECONNRESET");
    expect(events).toEqual(["viewer.reconnect", "closed"]);
    await expect(conn.call("ping")).rejects.toThrow("ECONNRESET");
  } finally {
    conn.close();
    (encoder as Channel | null)?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
for (const supported of [false, true])
  test(`RPC negotiates compression=${supported} in hello without another round trip`, async () => {
    const loop = new ReadyLoop(),
      directory = mkdtempSync("/tmp/corgi-codec-test-"),
      path = directory + "/s";
    const listener = n.probe_listen(ptr(Buffer.from(path + "\0")));
    const peers = new Set<Client>();
    const seen: string[] = [];
    const registration = loop.watch(listener, () => {
      const fd = n.probe_accept(listener);
      if (fd < 0) return;
      const peer = new Client(
        fd,
        loop,
        cl => {
          const value = cl.take();
          seen.push(value.op);
          if (value.op === "hello") {
            expect(value.accept_encoding).toEqual(["zstd"]);
            expect(cl.canCompress).toBe(true);
            cl.queue({
              type: "hello",
              request_id: value.request_id,
              ...(supported ? { content_encoding: "zstd" } : {}),
            });
            if (supported) cl.compress();
          } else cl.queue({ ok: true, pid: 123, request_id: value.request_id });
          cl.done();
        },
        () => {},
      );
      peers.add(peer);
    });
    registration.arm(READ);
    const conn = new Connection(path, { compression: true, timeout_ms: 2000 });
    try {
      await conn.call("hello");
      expect(await conn.call("ping")).toEqual({ ok: true, pid: 123 });
      expect(await Promise.all([conn.call("ping"), conn.call("ping")])).toHaveLength(2);
      expect(seen).toEqual(["hello", "ping", "ping", "ping"]);
    } finally {
      conn.close();
      for (const peer of peers) peer.close();
      registration.close();
      n.probe_close(listener);
      loop.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

function daemon() {
  const loop = new ReadyLoop(),
    directory = mkdtempSync("/tmp/corgi-encoding-test-"),
    path = directory + "/s",
    server = new Server(path, process.execPath, "0".repeat(64));
  const listener = n.probe_listen(ptr(Buffer.from(path + "\0")));
  const registration = loop.watch(listener, () => {
    const fd = n.probe_accept(listener);
    if (fd >= 0) server.addClient(fd);
  });
  registration.arm(READ);
  return {
    path,
    server,
    close() {
      for (const client of [...server.clients]) client.close();
      server.runtime.destroy();
      Reflect.get(server, "loop").close();
      registration.close();
      n.probe_close(listener);
      loop.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}
for (const offer of [undefined, [], ["future"], ["future", "zstd"]])
  test(`daemon selects only a supported offered encoding: ${JSON.stringify(offer)}`, async () => {
    const fixture = daemon(),
      conn = new Connection(fixture.path, { timeout_ms: 2000 });
    try {
      const hello = await conn.call("hello", offer === undefined ? {} : { accept_encoding: offer });
      const selected = offer?.includes("zstd") ? "zstd" : undefined;
      expect(hello.content_encoding).toBe(selected);
      expect(fixture.server.clients[0].compressed).toBe(selected !== undefined);
      expect((await conn.call("ping")).ok).toBe(true);
    } finally {
      conn.close();
      fixture.close();
    }
  });
test("the RPC client forbids requests during negotiation and encoding offers after its first request", async () => {
  const fixture = daemon(),
    conn = new Connection(fixture.path, { compression: true, timeout_ms: 2000 });
  try {
    const hello = conn.call("hello");
    await expect(conn.call("ping")).rejects.toThrow("CompressionNegotiating");
    expect((await hello).content_encoding).toBe("zstd");
    await expect(conn.call("hello", { accept_encoding: ["zstd"] })).rejects.toThrow("InvalidEncodingNegotiation");
    expect((await conn.call("ping")).ok).toBe(true);
  } finally {
    conn.close();
    fixture.close();
  }
  const plainFixture = daemon(),
    plain = new Connection(plainFixture.path, { timeout_ms: 2000 });
  try {
    await plain.call("ping");
    await expect(plain.call("hello", { accept_encoding: ["zstd"] })).rejects.toThrow("InvalidEncodingNegotiation");
    expect((await plain.call("ping")).ok).toBe(true);
  } finally {
    plain.close();
    plainFixture.close();
  }
});
for (const offer of [undefined, ["future"], ["zstd"]])
  for (const selected of ["zstd", "future", null]) {
    if (selected === "zstd" && offer?.includes(selected)) continue;
    test(`RPC rejects an unsupported or unoffered selection ${JSON.stringify(offer)} → ${selected}`, async () => {
      const server = createServer(socket => {
        socket.once("data", bytes => {
          const request = JSON.parse(bytes.toString());
          socket.write(
            JSON.stringify({ type: "hello", content_encoding: selected, request_id: request.request_id }) + "\n",
          );
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
      const address = server.address();
      if (!address || typeof address === "string") throw Error("NoAddress");
      const conn = new Connection(createConnection(address.port, "127.0.0.1"), { timeout_ms: 2000 });
      try {
        await expect(conn.call("hello", offer === undefined ? {} : { accept_encoding: offer })).rejects.toThrow(
          "InvalidEncodingNegotiation",
        );
        expect(conn.disconnected).toBe(true);
      } finally {
        conn.close();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    });
  }
for (const fragmented of [false, true])
  test(`hello ends at its plaintext newline when compressed bytes are ${fragmented ? "fragmented" : "coalesced"}`, async () => {
    let encoder: Channel | null = null;
    const requests: unknown[] = [];
    const server = createServer(socket => {
      socket.once("data", bytes => {
        const request = JSON.parse(bytes.toString());
        requests.push(request);
        const plain = Buffer.from(
          JSON.stringify({ type: "hello", content_encoding: "zstd", request_id: request.request_id }) + "\n",
        );
        const wire: Buffer[] = [];
        encoder = new Channel(
          bytes => wire.push(bytes),
          () => {},
          () => socket.destroy(),
        );
        encoder.encode(Buffer.from('{"type":"viewer.reconnect"}\n'), () => {
          const compressed = Buffer.concat(wire);
          const parts = fragmented
            ? [
                plain.subarray(0, 7),
                plain.subarray(7, -1),
                Buffer.concat([plain.subarray(-1), compressed.subarray(0, 3)]),
                compressed.subarray(3),
              ]
            : [Buffer.concat([plain, compressed])];
          void (async () => {
            for (const part of parts) {
              socket.write(part);
              await Bun.sleep(5);
            }
          })();
        });
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw Error("NoAddress");
    const conn = new Connection(createConnection(address.port, "127.0.0.1"), { compression: true, timeout_ms: 2000 });
    const events: string[] = [];
    conn.onEvent(event => events.push(event.type));
    try {
      expect((await conn.call("hello")).content_encoding).toBe("zstd");
      await until(() => events.length > 0);
      expect(events).toEqual(["viewer.reconnect"]);
      expect(requests).toHaveLength(1);
    } finally {
      conn.close();
      (encoder as Channel | null)?.close();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
for (const mode of ["pipelined", "partial", "late"] as const)
  test(`daemon refuses a ${mode} encoding switch`, async () => {
    const fixture = daemon(),
      socket = createConnection(fixture.path),
      replies: Record<string, unknown>[] = [];
    let input = "";
    socket.on("data", bytes => {
      input += bytes.toString();
      for (;;) {
        const end = input.indexOf("\n");
        if (end < 0) return;
        replies.push(JSON.parse(input.slice(0, end)));
        input = input.slice(end + 1);
      }
    });
    const hello = JSON.stringify(protocol.envelope("hello", { accept_encoding: ["zstd"] })) + "\n";
    try {
      if (mode === "late") {
        socket.write('{"op":"ping"}\n');
        await until(() => replies.length === 1);
        socket.write(hello);
      } else socket.write(hello + (mode === "pipelined" ? '{"op":"ping"}\n' : '{"op":'));
      await until(() => replies.length === (mode === "partial" ? 1 : 2));
      expect(replies[mode === "late" ? 1 : 0]).toEqual({ err: "InvalidEncodingNegotiation" });
      expect(fixture.server.clients[0].compressed).toBe(false);
    } finally {
      socket.destroy();
      fixture.close();
    }
  });
