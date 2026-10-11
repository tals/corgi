import { test, expect } from "bun:test";
import { createConnection, createServer } from "node:net";
import { Connection } from "./rpc";
import * as json from "./json";
import * as protocol from "./protocol";

// These assertions run during typechecking without sending invalid requests.
function requestTypes(conn: Connection) {
  conn.call("viewer.search", { pane: 1, needle: "text", skip: 2n });
  conn.call("ping");
  // @ts-expect-error Required request parameters cannot be omitted.
  conn.call("viewer.search");
  // @ts-expect-error Unknown operations require the raw boundary.
  conn.call("viewer.missing", {});
  // @ts-expect-error The pane is required.
  conn.call("viewer.search", { needle: "text" });
  // @ts-expect-error Pane IDs are numbers.
  conn.call("viewer.search", { pane: "1", needle: "text" });
  // @ts-expect-error Typed operations reject misspelled fields.
  conn.call("viewer.search", { pane: 1, needle: "text", skips: 2 });
  // @ts-expect-error Typed requests do not accept arbitrary wire objects.
  conn.request({ op: "ping" });
  const reply: Promise<protocol.Reply<"hello">> = conn.call("hello");
  conn.call("viewer.search", { pane: 1, needle: "text", skip: 2 }).then(response => {
    const offset: number | bigint | null = response.offset;
    // @ts-expect-error Socket JSON has not normalized small integer tokens.
    const normalized: bigint | null = response.offset;
    return { offset, normalized };
  });
  conn.call("agent.command.preview", { workspace: 1, request: 1 }).then(response => {
    const command: string = response.resolution.command.command;
    // @ts-expect-error Serialized entries have no class methods.
    response.resolution.command.text();
    // @ts-expect-error Serialized semantics have no class methods.
    response.resolution.semantics.modelLabel();
    return command;
  });
  conn.call("viewer.sync", { interests: [] }).then(response => {
    // @ts-expect-error Resource snapshots have no class methods over JSON.
    response.resources?.forViewer(null);
  });
  return reply;
}
void requestTypes;

test("RPC keeps envelopes, errors, and raw requests at the socket boundary", async () => {
  const received: unknown[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const value = json.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        received.push(value);
        socket.write(json.stringify(received.length === 2 ? { err: "NoPane" } : { ok: true, pid: 7 }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  const conn = new Connection(createConnection(address.port, "127.0.0.1"));
  try {
    expect(await conn.call("ping")).toEqual({ ok: true, pid: 7 });
    await expect(conn.call("viewer.search", { pane: 1, needle: "x", skip: 3n })).rejects.toThrow("NoPane");
    expect(await conn.rawRequest({ op: "invalid", arbitrary: true })).toEqual({ ok: true, pid: 7 });
    expect(received).toEqual([
      { op: "ping" },
      { op: "viewer.search", protocol: protocol.version, pane: 1, needle: "x", skip: 3 },
      { op: "invalid", arbitrary: true },
    ]);
  } finally {
    conn.close();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test("RPC retains raw integer tokens until the receiving model normalizes them", async () => {
  const packets: string[] = [];
  const replies = [
    '{"ok":true,"offset":2}',
    '{"ok":true,"offset":18446744073709551615}',
    '{"ok":true,"events":[],"pending_requests":[],"next_seq":2,"first_seq":18446744073709551615}',
  ];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        packets.push(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        socket.write(replies[packets.length - 1] + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  const conn = new Connection(createConnection(address.port, "127.0.0.1"));
  try {
    expect((await conn.call("viewer.search", { pane: 1, needle: "x", skip: 2n })).offset).toBe(2);
    expect((await conn.call("viewer.search", { pane: 1, needle: "x", skip: 0xffffffffffffffffn })).offset).toBe(
      0xffffffffffffffffn,
    );
    const events = await conn.call("native.events", { session: 1, after: 0n });
    expect(events.next_seq).toBe(2);
    expect(events.first_seq).toBe(0xffffffffffffffffn);
    expect(packets).toEqual([
      '{"op":"viewer.search","protocol":1,"pane":1,"needle":"x","skip":2}',
      '{"op":"viewer.search","protocol":1,"pane":1,"needle":"x","skip":18446744073709551615}',
      '{"op":"native.events","session":1,"after":0}',
    ]);
  } finally {
    conn.close();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});
