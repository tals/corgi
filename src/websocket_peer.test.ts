import { expect, test } from "bun:test";
import * as fs from "node:fs";
import * as rpc from "./rpc";
import * as peer from "./peer";
import { n, ptr, ReadyLoop, READ } from "./native_bridge";

function fixture(receive: (client: peer.Client, request: any) => void, drained = (_client: peer.Client) => {}) {
  const directory = fs.mkdtempSync("/tmp/corgi-ws-peer-"),
    path = directory + "/s",
    loop = new ReadyLoop(),
    listener = n.probe_listen(ptr(Buffer.from(path + "\0"))),
    peers = new Set<peer.Client>();
  const registration = loop.watch(listener, () => {
    for (;;) {
      const fd = n.probe_accept(listener);
      if (fd < 0) break;
      const client = new peer.Client(
        fd,
        loop,
        cl => {
          receive(cl, cl.take());
          cl.done();
        },
        () => {},
        true,
        drained,
      );
      peers.add(client);
    }
    registration.arm(READ);
  });
  registration.arm(READ);
  return {
    path,
    peers,
    close() {
      for (const client of peers) client.close();
      registration.close();
      n.probe_close(listener);
      loop.close();
      fs.rmSync(directory, { recursive: true, force: true });
    },
  };
}
async function until(done: () => boolean): Promise<void> {
  const deadline = performance.now() + 3000;
  while (!done()) {
    if (performance.now() > deadline) throw Error("Timeout");
    await Bun.sleep(2);
  }
}
test("a paused WS reader resumes an 8 MiB stream exactly with bounded daemon output", async () => {
  let target: peer.Client | undefined,
    sent = 0,
    received = 0,
    peak = 0,
    scheduled = false;
  const padding = "x".repeat(65536),
    count = 128;
  const pump = () => {
    scheduled = false;
    if (!target || target.dead) return;
    while (sent < count && target.queued < 512 * 1024) {
      target.queue({ type: "viewer.wake", index: sent++, padding });
      peak = Math.max(peak, target.queued);
    }
  };
  const server = fixture(
    (cl, q) => {
      target = cl;
      cl.queue({ request_id: q.request_id, ok: true, pid: 7 });
    },
    () => {
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(pump);
      }
    },
  );
  const connection = new rpc.Connection(server.path, { timeout_ms: 3000 });
  connection.onEvent(event => {
    expect(event).toMatchObject({ type: "viewer.wake", index: received++, padding });
  });
  try {
    // Arm the producer only after the reply, so the freeze precedes all events.
    sent = count;
    await connection.call("ping");
    connection.socket.pause();
    sent = 0;
    pump();
    await Bun.sleep(50);
    expect(peak).toBeGreaterThan(0);
    expect(target!.dead).toBe(false);
    expect(received).toBe(0);
    connection.socket.resume();
    await until(() => received === count);
    expect(peak).toBeLessThan(600 * 1024);
    expect((await connection.call("ping")).pid).toBe(7);
  } finally {
    connection.close();
    server.close();
  }
});
test("a paused daemon resumes queued WS requests in order without dropping their replies", async () => {
  let target: peer.Client | undefined;
  const seen: number[] = [];
  const server = fixture((cl, q) => {
    target = cl;
    if (q.index !== undefined) {
      seen.push(q.index);
      expect(q.padding).toBe("x".repeat(65536));
    }
    cl.queue({ request_id: q.request_id, ok: true, pid: 7 });
  });
  const connection = new rpc.Connection(server.path, { timeout_ms: 3000 });
  try {
    await connection.call("ping");
    target!.pause();
    const replies = Array.from({ length: 32 }, (_, index) =>
      connection.rawRequest({ op: "ping", index, padding: "x".repeat(65536) }),
    );
    await Bun.sleep(50);
    expect(seen).toHaveLength(0);
    expect(connection.socket.writableLength).toBeLessThan(4 * 1024 * 1024);
    target!.resume();
    expect(await Promise.all(replies)).toHaveLength(32);
    expect(seen).toEqual(Array.from({ length: 32 }, (_, i) => i));
  } finally {
    connection.close();
    server.close();
  }
});
