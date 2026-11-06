import { test, expect } from "bun:test";
import { Client } from "./peer";
import { ReadyLoop } from "./native_bridge";
test("replies queue as lines and an oversized one returns an error without a partial line", () => {
  const loop = new ReadyLoop(),
    cl = new Client(
      -1,
      loop,
      () => {},
      () => {},
      false,
    );
  try {
    cl.queue({ ok: true });
    cl.queue({ n: 1 });
    const before = '{"ok":true}\n{"n":1}\n';
    expect(cl.output.toString()).toBe(before);
    cl.queue({ text: "x".repeat(4 * 1024 * 1024) });
    expect(cl.dead).toBe(false);
    expect(cl.output.toString()).toBe(before + '{"err":"MessageTooLarge"}\n');
  } finally {
    cl.close();
    loop.close();
  }
});
import { n, ptr } from "./native_bridge";
import { pair } from "./native_ffi";
/** Writes `text` to `fd` and reads everything the other side sends until it closes. */
async function exchange(text: string, respond: (cl: Client, value: any) => void) {
  const loop = new ReadyLoop(),
    [server, peer] = pair(),
    received: any[] = [];
  const cl = new Client(
    server,
    loop,
    (client, value) => {
      received.push(client.take());
      respond(client, value);
      client.done();
    },
    () => {},
  );
  try {
    const bytes = Buffer.from(text);
    n.probe_write(peer, ptr(bytes), bytes.length);
    let reply = "";
    const scratch = Buffer.alloc(4096);
    for (let i = 0; i < 200; i++) {
      await Bun.sleep(5);
      for (;;) {
        const count = n.probe_read(peer, ptr(scratch), scratch.length);
        if (count > 0) reply += scratch.subarray(0, count).toString();
        else break;
      }
      if (cl.dead && reply) break;
    }
    return { received, reply, closed: cl.dead };
  } finally {
    cl.close();
    n.probe_close(peer);
    loop.close();
  }
}
test("an HTTP POST is one request: its body is the envelope and the reply is the response", async () => {
  const body = JSON.stringify({ op: "hook", protocol: 2, provider: "claude", pane: 3 });
  const { received, reply, closed } = await exchange(
    `POST /rpc HTTP/1.1\r\nHost: corgi\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    cl => cl.queue({ ok: true }),
  );
  expect(received).toEqual([{ op: "hook", protocol: 2, provider: "claude", pane: 3 }]);
  expect(reply).toBe(
    'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 12\r\nConnection: close\r\n\r\n{"ok":true}\n',
  );
  expect(closed).toBe(true);
});
test("an HTTP request without a length or with a bad body is refused", async () => {
  const missing = await exchange("POST /rpc HTTP/1.1\r\nHost: corgi\r\n\r\n{}", () => {});
  expect(missing.received).toEqual([]);
  expect(missing.reply.startsWith("HTTP/1.1 400 Bad Request\r\n")).toBe(true);
  expect(missing.reply).toContain('"LengthRequired"');
  const invalid = await exchange("POST /rpc HTTP/1.1\r\nContent-Length: 3\r\n\r\n{x}", () => {});
  expect(invalid.reply).toContain('"InvalidJson"');
});
test("JSON lines keep working, and a later line starting with POST is not HTTP", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair(),
    received: any[] = [];
  const cl = new Client(
    server,
    loop,
    client => {
      received.push(client.take());
      client.queue({ ok: true });
      client.done();
    },
    () => {},
  );
  try {
    const bytes = Buffer.from('{"op":"ping"}\nPOST {}\n');
    n.probe_write(peer, ptr(bytes), bytes.length);
    await Bun.sleep(50);
    expect(received).toEqual([{ op: "ping" }]);
    expect(cl.http).toBe("no");
    expect(cl.dead).toBe(false);
  } finally {
    cl.close();
    n.probe_close(peer);
    loop.close();
  }
});

async function until(check: () => boolean) {
  const end = Date.now() + 2000;
  while (!check()) {
    if (Date.now() > end) throw Error("Timeout");
    await Bun.sleep(1);
  }
}

test("a stalled request bounds admission, then resumes buffered input in order", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair(),
    received: number[] = [];
  let held = true;
  const client = new Client(
    server,
    loop,
    cl => {
      received.push(cl.take().id);
      if (!held) cl.done();
    },
    () => {},
  );
  n.probe_nonblock(peer);
  try {
    const bytes = Buffer.from(
      Array.from({ length: 1000 }, (_, id) => JSON.stringify({ id, text: "x".repeat(100) }) + "\n").join(""),
    );
    let offset = 0;
    const send = () => {
      if (offset === bytes.length) return;
      const part = bytes.subarray(offset),
        written = n.probe_write(peer, ptr(part), part.length);
      if (written > 0) offset += written;
    };
    await until(() => {
      send();
      return received.length === 1;
    });
    // Give readiness callbacks a chance to attempt further admission.
    await Bun.sleep(10);
    expect(client.pending.length).toBeLessThanOrEqual(64);
    expect(client.retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    expect(client.dead).toBe(false);
    held = false;
    client.done();
    await until(() => {
      send();
      return received.length === 1000;
    });
    expect(received).toEqual(Array.from({ length: 1000 }, (_, i) => i));
    expect(client.retainedBytes).toBe(0);
  } finally {
    client.close();
    n.probe_close(peer);
    loop.close();
  }
});

test("tagged deferred work keeps admission until completion", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair(),
    releases: (() => void)[] = [];
  const client = new Client(
    server,
    loop,
    cl => {
      cl.take();
      releases.push(cl.retain());
      cl.done();
    },
    () => {},
  );
  try {
    const bytes = Buffer.from('{"op":"slow"}\n'.repeat(128));
    n.probe_write(peer, ptr(bytes), bytes.length);
    await until(() => releases.length === 64);
    await Bun.sleep(10);
    expect(releases).toHaveLength(64);
    releases[0]();
    await until(() => releases.length === 65);
    releases[0]();
    expect(releases).toHaveLength(65);
  } finally {
    client.close();
    n.probe_close(peer);
    loop.close();
  }
});

test("handoff retains admitted and undecoded requests without exceeding admission on restore", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair();
  const client = new Client(
    server,
    loop,
    () => {},
    () => {},
  );
  try {
    const bytes = Buffer.from(Array.from({ length: 128 }, (_, id) => JSON.stringify({ id }) + "\n").join(""));
    n.probe_write(peer, ptr(bytes), bytes.length);
    await until(() => client.pending.length > 0);
    client.pause();
    const saved = client.savedInput();
    expect(saved.toString()).toBe(bytes.toString());
    const restored = new Client(
      -1,
      loop,
      () => {},
      () => {},
      false,
    );
    try {
      restored.restoreInput(saved);
      expect(restored.pending).toHaveLength(0);
      expect(restored.savedInput()).toEqual(saved);
    } finally {
      restored.close();
    }
  } finally {
    client.close();
    n.probe_close(peer);
    loop.close();
  }
});

test("HTTP rejects an oversized body from its header before retaining the body", async () => {
  const response = await exchange("POST /rpc HTTP/1.1\r\nContent-Length: 99999999\r\n\r\n", () => {});
  expect(response.received).toEqual([]);
  expect(response.reply).toContain("MessageTooLarge");
  expect(response.closed).toBe(true);
});

test("slow reply consumers pause request execution and resume without dropping replies", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair();
  let received = 0;
  const client = new Client(
    server,
    loop,
    cl => {
      const request = cl.take();
      received++;
      cl.queue({ id: request.id, text: "x".repeat(64 * 1024) });
      cl.done();
    },
    () => {},
  );
  n.probe_nonblock(peer);
  try {
    const bytes = Buffer.from(Array.from({ length: 100 }, (_, id) => JSON.stringify({ id }) + "\n").join(""));
    n.probe_write(peer, ptr(bytes), bytes.length);
    await until(() => client.output.length - client.sent >= 1024 * 1024);
    expect(received).toBeLessThan(100);
    expect(client.dead).toBe(false);
    const chunks: Buffer[] = [],
      scratch = Buffer.alloc(65536);
    await until(() => {
      for (;;) {
        const count = n.probe_read(peer, ptr(scratch), scratch.length);
        if (count <= 0) break;
        chunks.push(Buffer.from(scratch.subarray(0, count)));
      }
      return (
        received === 100 &&
        client.output.length === 0 &&
        chunks.reduce((n, b) => n + b.filter(c => c === 10).length, 0) === 100
      );
    });
    const replies = Buffer.concat(chunks)
      .toString()
      .trim()
      .split("\n")
      .map(line => JSON.parse(line).id);
    expect(replies).toEqual(Array.from({ length: 100 }, (_, i) => i));
    expect(client.dead).toBe(false);
  } finally {
    client.close();
    n.probe_close(peer);
    loop.close();
  }
});

test("raw and decoded bytes share one admission budget while an operation is stalled", async () => {
  const loop = new ReadyLoop(),
    [server, peer] = pair();
  let count = 0,
    held = true;
  const client = new Client(
    server,
    loop,
    cl => {
      expect(cl.take().id).toBe(count++);
      if (!held) cl.done();
    },
    () => {},
  );
  n.probe_nonblock(peer);
  try {
    const input = Buffer.from(
      Array.from({ length: 48 }, (_, id) => JSON.stringify({ id, text: "界".repeat(48 * 1024) }) + "\n").join(""),
    );
    let offset = 0;
    const send = () => {
      if (offset < input.length) {
        const part = input.subarray(offset),
          written = n.probe_write(peer, ptr(part), part.length);
        if (written > 0) offset += written;
      }
      expect(client.retainedBytes).toBeLessThanOrEqual(4 * 1024 * 1024);
    };
    await until(() => {
      send();
      return client.retainedBytes === 4 * 1024 * 1024;
    });
    expect(count).toBe(1);
    expect(client.pending.length).toBeLessThan(64);
    expect(client.dead).toBe(false);
    held = false;
    client.done();
    await until(() => {
      send();
      return count === 48;
    });
    expect(client.retainedBytes).toBe(0);
  } finally {
    client.close();
    n.probe_close(peer);
    loop.close();
  }
});
