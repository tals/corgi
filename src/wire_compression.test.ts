import { expect, test } from "bun:test";
import { Channel } from "./wire_compression";
import { Connection } from "./rpc";
import { Client } from "./peer";
import { ReadyLoop, n, ptr, READ } from "./native_bridge";
import { mkdtempSync, rmSync } from "node:fs";

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
            expect(value.compression).toBe("zstd");
            expect(cl.canCompress).toBe(true);
            cl.queue({ type: "hello", request_id: value.request_id, ...(supported ? { compression: "zstd" } : {}) });
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
