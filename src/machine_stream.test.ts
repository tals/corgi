import { expect, test } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { Connection } from "./rpc";
import { Stream } from "./machine_stream";
import * as protocol from "./protocol";
import * as json from "./json";
import { Terminal } from "./pane/terminal";
import * as surface from "./pane/surface";
import { Channel } from "./wire_compression";

function frame(hash = 1): protocol.Reply<"viewer.sync"> {
  return {
    type: "view",
    viewer_protocol: protocol.viewer_version,
    session: null,
    session_hash: hash,
    resources: null,
    resources_hash: hash,
    surfaces: [],
    bell_seq: 0,
    bell_kind: "none",
    controls: [],
    viewer: 1,
    detach: false,
  };
}
async function fixture(changed: () => void = () => {}, incremental = false) {
  let socket: Socket;
  const requests: Record<string, any>[] = [];
  const server = createServer(peer => {
    socket = peer;
    let buffer = "";
    peer.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const end = buffer.indexOf("\n");
        if (end < 0) break;
        requests.push(json.parse(buffer.slice(0, end)));
        buffer = buffer.slice(end + 1);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as import("node:net").AddressInfo;
  const connection = new Connection(createConnection(address.port, "127.0.0.1"), 1000);
  const stream = new Stream(connection, changed, incremental);
  const until = async (done: () => boolean) => {
    const end = performance.now() + 1000;
    while (!done()) {
      if (performance.now() > end) throw Error("TestTimedOut");
      await Bun.sleep(1);
    }
  };
  const pending = new Set<number>();
  return {
    stream,
    connection,
    requests,
    until,
    send: (...values: unknown[]) =>
      socket!.write(
        values
          .map(value => {
            const v = value as Record<string, unknown>;
            if (v.type !== "viewer.frame" && v.request_id === undefined) {
              const q = requests.find(q => !pending.has(q.request_id));
              if (q) {
                pending.add(q.request_id);
                value = { ...v, request_id: q.request_id };
              }
            }
            return json.stringify(value) + "\n";
          })
          .join(""),
      ),
    close: () => {
      connection.close();
      socket?.destroy();
      server.close();
    },
  };
}
test("incremental frames decode before UI coalescing and rebuild after a daemon handoff", async () => {
  const f = await fixture(() => {}, true),
    terminal = Terminal.create(40, 5);
  try {
    f.stream.configure({ interests: [{ pane: 1, cols: 40, rows: 5 }] }, 1);
    await f.until(() => f.requests.length === 1);
    const sequence = f.requests[0].sequence;
    terminal.feed("one");
    const first = surface.captureView(1, terminal);
    f.send({
      type: "viewer.stream",
      viewer_protocol: protocol.viewer_version,
      sequence,
      frame: 1n,
      view: { ...frame(), surfaces: [first] },
    });
    await f.until(() => f.requests.length === 2);
    expect(f.requests[1]).toMatchObject({ op: "viewer.receipt", sequence, frame: 1 });
    f.send({ ok: true, stream: true });
    terminal.feed("\rtwo");
    const second = surface.captureView(1, terminal);
    terminal.feed("\rthree");
    const third = surface.captureView(1, terminal);
    f.send(
      ...[
        [2n, surface.difference(first, second)],
        [3n, surface.difference(second, third)],
      ].map(([serial, patch]) => ({
        type: "viewer.frame",
        sequence,
        frame: serial,
        view: { ...frame(), patches: [patch] },
      })),
    );
    await f.until(() => f.requests.length === 4);
    expect(f.stream.take()?.frame.surfaces).toEqual([third]);
    f.send({ ok: true, stream: true });
    f.send({ ok: true, stream: false });
    await f.until(() => !f.stream.fresh);
    f.stream.configure({ interests: [{ pane: 1, cols: 40, rows: 5, known: third.stamp }] }, 1);
    await f.until(() => f.requests.length === 5);
    expect(f.requests[4].op).toBe("viewer.stream");
    expect(f.requests[4].sequence).toBeGreaterThan(sequence);
    expect(f.requests[4].interests[0].known).toBeNull();
    // An old generation cannot replace the new base or produce a receipt.
    f.send({ type: "viewer.frame", sequence, frame: 4n, view: { ...frame(), patches: [] } });
    f.send({
      type: "viewer.stream",
      viewer_protocol: protocol.viewer_version,
      sequence: f.requests[4].sequence,
      frame: 1n,
      view: { ...frame(), surfaces: [third] },
    });
    await f.until(() => f.stream.fresh);
    expect(f.stream.take()?.frame.surfaces).toEqual([third]);
  } finally {
    terminal.destroy();
    f.close();
  }
});
test("only frames that change something wake the viewer", async () => {
  let woken = 0;
  const f = await fixture(() => woken++);
  try {
    f.stream.configure({ interests: [] }, 1);
    await f.until(() => f.requests.length === 1);
    const sequence = f.requests[0].sequence;
    f.send({ type: "viewer.stream", viewer_protocol: protocol.viewer_version, sequence, view: frame() });
    await f.until(() => f.stream.fresh);
    expect(woken).toBe(1);
    expect(f.stream.take()?.news).toBe(true);
    // An answer that changes nothing waits for the next step.
    f.send({ type: "viewer.frame", sequence, view: frame() });
    await f.until(() => f.stream.age() < 5 && f.stream.take() !== null);
    expect(woken).toBe(1);
    f.send({ type: "viewer.frame", sequence, view: { ...frame(), bell_seq: 1 } });
    await f.until(() => woken === 2);
    expect(f.stream.take()?.news).toBe(true);
  } finally {
    f.close();
  }
});
test("input and pushed output proceed while older input acknowledgements are withheld", async () => {
  const f = await fixture();
  try {
    f.stream.configure({ interests: [] }, 1);
    await f.until(() => f.requests.length === 1);
    const sequence = f.requests[0].sequence;
    f.send({ type: "viewer.stream", viewer_protocol: protocol.viewer_version, sequence, view: frame() });
    await f.until(() => f.stream.fresh);
    f.stream.take();
    let acknowledged = 0;
    for (const data of ["a", "b"])
      f.stream.send(async () => {
        await f.connection.call("session.command", { command: { "pane.input": { target: 1, data } } });
        acknowledged++;
      }, 1);
    await f.until(() => f.requests.length === 3);
    f.send({ type: "viewer.frame", sequence, view: frame(2) });
    let output: ReturnType<Stream["take"]> = null;
    await f.until(() => {
      output = f.stream.take();
      return output !== null;
    });
    expect(output!.frame.session_hash).toBe(2);
    expect(acknowledged).toBe(0);
    f.send({ ok: true, result: {} });
    f.send({ ok: true, result: {} });
    await f.until(() => acknowledged === 2);
    expect(f.requests.slice(1).map(r => r.command["pane.input"].data)).toEqual(["a", "b"]);
  } finally {
    f.close();
  }
});

test("frames and failures wake the viewer, but successful acknowledgements do not spin it", async () => {
  let wakes = 0;
  const f = await fixture(() => wakes++);
  try {
    f.stream.configure({ interests: [] }, 1);
    await f.until(() => f.requests.length === 1);
    const sequence = f.requests[0].sequence;
    f.send({ type: "viewer.stream", viewer_protocol: protocol.viewer_version, sequence, view: frame() });
    await f.until(() => f.stream.fresh);
    expect(wakes).toBe(1);
    let acknowledged = false;
    f.stream.send(async () => {
      await f.connection.call("ping");
      acknowledged = true;
    });
    await f.until(() => f.requests.length === 2);
    f.send({ ok: true, pid: 1 });
    await f.until(() => acknowledged);
    expect(wakes).toBe(1);
    f.send({ type: "viewer.frame", sequence, view: frame(2) });
    await f.until(() => wakes === 2);
    expect(f.stream.take()?.frame.session_hash).toBe(2);
    f.connection.close();
    await f.until(() => wakes === 3);
    expect(() => f.stream.check()).toThrow("ConnectionClosed");
  } finally {
    f.close();
  }
});
test("a reset rejects an old in-flight frame and requests a full replacement", async () => {
  const f = await fixture();
  try {
    f.stream.configure({ interests: [], session_hash: 5, resources_hash: 6 }, 1);
    await f.until(() => f.requests.length === 1);
    const old = f.requests[0].sequence;
    f.stream.reset();
    f.send({ type: "viewer.stream", viewer_protocol: protocol.viewer_version, sequence: old, view: frame() });
    await Bun.sleep(10);
    expect(f.stream.take()).toBeNull();
    expect(f.stream.fresh).toBe(false);
    f.stream.configure({ interests: [], session_hash: 5, resources_hash: 6 }, 2);
    await f.until(() => f.requests.length === 2);
    expect(f.requests[1].sequence).toBeGreaterThan(old);
    expect(protocol.decode("viewer.stream", f.requests[1]).session_hash).toBeNull();
    expect(protocol.decode("viewer.stream", f.requests[1]).resources_hash).toBeNull();
    f.send({
      type: "viewer.stream",
      viewer_protocol: protocol.viewer_version,
      sequence: f.requests[1].sequence,
      view: frame(3),
    });
    await f.until(() => f.stream.fresh);
    expect(f.stream.take()?.frame.session_hash).toBe(3);
  } finally {
    f.close();
  }
});
test("outstanding input is bounded without acknowledging or replaying unsent bytes", async () => {
  const f = await fixture();
  try {
    let sends = 0;
    const send = () => {
      sends++;
      return new Promise<void>(() => {});
    };
    f.stream.send(send, 1024 * 1024);
    expect(() => f.stream.send(send, 1)).toThrow("InputBackpressure");
    expect(sends).toBe(1);
    expect(f.stream.age(performance.now() + 1100)).toBeGreaterThanOrEqual(1100);
  } finally {
    f.close();
  }
});

test("a coalesced RPC reply and subsequent push are applied in wire order", async () => {
  const f = await fixture();
  try {
    f.stream.configure({ interests: [] }, 1);
    await f.until(() => f.requests.length === 1);
    const sequence = f.requests[0].sequence;
    f.send(
      { type: "viewer.stream", viewer_protocol: protocol.viewer_version, sequence, view: frame(1) },
      { type: "viewer.frame", sequence, view: frame(2) },
    );
    await f.until(() => f.stream.fresh);
    await Bun.sleep(5);
    expect(f.stream.take()?.frame.session_hash).toBe(2);
    expect(f.stream.take()).toBeNull();
  } finally {
    f.close();
  }
});

test("writes triggered by the last frames cannot interrupt decoding after a TCP reset", async () => {
  let encoder: Channel | null = null;
  const server = createServer(socket => {
    let input = "",
      compressed = false;
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
        } else if (request.op === "viewer.stream") {
          // The decoder emits the first frame before it finishes the larger second frame.
          const messages = [
            {
              type: "viewer.stream",
              viewer_protocol: protocol.viewer_version,
              sequence: request.sequence,
              frame: 1,
              view: frame(1),
              request_id: request.request_id,
            },
            {
              type: "viewer.frame",
              sequence: request.sequence,
              frame: 2,
              view: frame(2),
              padding: "x".repeat(1024 * 1024),
            },
            { type: "viewer.wake" },
          ];
          encoder!.encode(Buffer.from(messages.map(value => JSON.stringify(value) + "\n").join("")), () =>
            socket.resetAndDestroy(),
          );
        }
      }
    };
    socket.on("data", bytes => (compressed ? encoder!.decode(Buffer.from(bytes)) : read(Buffer.from(bytes))));
    socket.on("error", () => {});
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  const connection = new Connection(createConnection(address.port, "127.0.0.1"), {
    compression: true,
    timeout_ms: 1000,
  });
  const events: string[] = [];
  let offered = false,
    started = 0;
  connection.onEvent(event => events.push(event.type));
  const stream = new Stream(
    connection,
    () => {
      try {
        stream.check();
        if (connection.draining && stream.fresh && !offered) {
          offered = true;
          stream.send(async () => {
            started++;
            await connection.call("ping");
          });
        }
      } catch {
        events.push("closed");
        connection.close();
      }
    },
    true,
  );
  try {
    await connection.call("hello");
    const closed = new Promise<void>(resolve => connection.onClose(resolve));
    stream.configure({ interests: [] }, 1);
    await closed;
    expect(offered).toBe(true);
    expect(events).toEqual(["viewer.stream", "viewer.frame", "viewer.wake", "closed"]);
    expect(stream.take()?.frame.session_hash).toBe(2);
    expect(started).toBe(0);
  } finally {
    connection.close();
    (encoder as Channel | null)?.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
