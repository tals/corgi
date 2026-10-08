import { test, expect } from "bun:test";
import { Client } from "./peer";
import { ReadyLoop } from "./native_bridge";
test("replies queue as lines and an oversized one drops the client without a partial line", () => {
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
    expect(cl.dead).toBe(true);
    expect(cl.output.toString()).toBe(before);
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
  const body = JSON.stringify({ op: "hook", protocol: 1, provider: "claude", pane: 3 });
  const { received, reply, closed } = await exchange(
    `POST /rpc HTTP/1.1\r\nHost: corgi\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    cl => cl.queue({ ok: true }),
  );
  expect(received).toEqual([{ op: "hook", protocol: 1, provider: "claude", pane: 3 }]);
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
