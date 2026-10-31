import { test, expect } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, reload, request } from "./rpc";
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
  conn.call("viewer.pick", { pane: 1, offset: 0, unit: "word", x: 2, y: 3 });
  conn.call("viewer.pick", { pane: 1, offset: 0n, unit: "line", x: 2, y: 3, to_x: 4, to_y: null });
  // @ts-expect-error Pick units are a closed set.
  conn.call("viewer.pick", { pane: 1, offset: 0, unit: "char", x: 2, y: 3 });
  // @ts-expect-error The viewer's offset is required.
  conn.call("viewer.pick", { pane: 1, unit: "word", x: 2, y: 3 });
  // @ts-expect-error Cells are numbers.
  conn.call("viewer.pick", { pane: 1, offset: 0, unit: "word", x: 2n, y: 3 });
  conn.call("viewer.pick", { pane: 1, offset: 0, unit: "word", x: 2, y: 3 }).then(response => {
    const shown: string = response.shown;
    const end: number | undefined = response.match?.end_x;
    // @ts-expect-error A pick may find nothing.
    const x: number = response.match.x;
    return { shown, end, x };
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

async function peer(receive: (message: any, socket: Socket) => void, requestIds = true) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const message = json.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        receive(message, socket);
      }
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("NoAddress");
  const conn = new Connection(createConnection(address.port, "127.0.0.1"), { requestIds });
  return {
    conn,
    async close() {
      conn.close();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
    },
  };
}
function send(socket: Socket, message: object) {
  socket.write(json.stringify(message) + "\n");
}

test.each([false, true])(
  "RPC correlates deferred replies and errors without consuming events (error=%s)",
  async error => {
    let finish!: () => void;
    const remote = await peer((message, socket) => {
      if (message.op === "git.branches") {
        finish = () =>
          send(socket, {
            request_id: message.request_id,
            ...(error ? { err: "BranchesUnavailable" } : { ok: true, branches: [] }),
          });
        send(socket, { type: "session", panes: [] });
        send(socket, { type: "agent.preview", preview: {} });
        send(socket, { type: "viewer.wake" });
      } else send(socket, { request_id: message.request_id, ok: true, pid: 7 });
    });
    const events: protocol.Event[] = [];
    const unsubscribe = remote.conn.onEvent(event => events.push(event));
    try {
      const branches = remote.conn.call("git.branches", { workspace: 1 }).then(
        value => value,
        failure => ({ error: failure.message }),
      );
      expect(await remote.conn.call("ping")).toEqual({ ok: true, pid: 7 });
      finish();
      expect(await branches).toEqual(error ? { error: "BranchesUnavailable" } : { ok: true, branches: [] });
      expect(events.map(event => event.type)).toEqual(["session", "agent.preview", "viewer.wake"]);
    } finally {
      unsubscribe();
      await remote.close();
    }
  },
);

test.each(["hello", "server.reload"] as const)("management can %s an older daemon without correlation", async op => {
  const remote = await peer((message, socket) => {
    expect(message).not.toHaveProperty("request_id");
    expect(message.protocol).toBe(1);
    send(socket, { ok: true });
  }, false);
  try {
    const [first, second] = await Promise.allSettled([remote.conn.call(op), remote.conn.call(op)]);
    expect(first).toEqual({ status: "fulfilled", value: { ok: true } });
    expect(second).toMatchObject({ status: "rejected", reason: Error("RequestInFlight") });
  } finally {
    await remote.close();
  }
});

test.each([false, true])("raw RPC preserves caller-supplied ids without correlation (error=%s)", async error => {
  const query = { op: "ping", request_id: 41 };
  const reply = { request_id: 41, ...(error ? { err: "TestFailure" } : { ok: true, pid: 7 }) };
  const remote = await peer((message, socket) => {
    expect(message).toEqual(query);
    send(socket, reply);
  }, false);
  try {
    expect(await remote.conn.rawRequest(query)).toEqual(reply);
  } finally {
    await remote.close();
  }
});

test.each([null, "UnsupportedProtocol"])("RPC rejects the first untagged reply (%s)", async error => {
  const remote = await peer((_message, socket) => send(socket, error ? { err: error } : { ok: true }));
  try {
    const results = await Promise.allSettled([
      remote.conn.call("viewer.open"),
      remote.conn.call("git.branches", { workspace: 1 }),
    ]);
    for (const result of results) {
      expect(result.status).toBe("rejected");
      if (result.status === "rejected") expect(result.reason.message).toBe(error ?? "UnexpectedReply");
    }
  } finally {
    await remote.close();
  }
});

test("one-shot unversioned requests accept an older daemon's replies and errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-rpc-")),
    path = join(dir, "corgi.sock"),
    replies = [{ ok: true, pid: 7 }, { ok: true }, { err: "ImportInProgress" }],
    received: unknown[] = [];
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      if (!buffer.includes("\n")) return;
      received.push(json.parse(buffer.trim()));
      send(socket, replies[received.length - 1]);
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  try {
    expect(await request(path, "ping")).toEqual({ ok: true, pid: 7 });
    expect(await request(path, "shutdown")).toEqual({ ok: true });
    await expect(request(path, "shutdown")).rejects.toThrow("ImportInProgress");
    expect(received).toEqual([{ op: "ping" }, { op: "shutdown" }, { op: "shutdown" }]);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test.each(["unknown", "duplicate", "untagged", "view", "disconnect"])(
  "RPC fails all requests safely on %s replies",
  async kind => {
    let first = 0;
    const remote = await peer((message, socket) => {
      if (!first) {
        first = message.request_id;
        send(socket, { request_id: first, ok: true });
      } else if (message.op === "ping") {
        if (kind === "disconnect") socket.destroy();
        else
          send(
            socket,
            kind === "untagged"
              ? { err: "InvalidJson" }
              : kind === "view"
                ? { type: "view" }
                : { request_id: kind === "duplicate" ? first : 999, ok: true },
          );
      }
    });
    try {
      await remote.conn.call("ping");
      const requests = Promise.allSettled([
        remote.conn.call("git.branches", { workspace: 1 }),
        remote.conn.call("ping"),
      ]);
      const results = await requests;
      expect(results.map(result => result.status)).toEqual(["rejected", "rejected"]);
      for (const result of results)
        if (result.status === "rejected")
          expect(result.reason.message).toBe(kind === "disconnect" ? "ConnectionClosed" : "UnexpectedReply");
    } finally {
      await remote.close();
    }
  },
);

test("raw requests must be objects so they can carry correlation ids", async () => {
  const seen: unknown[] = [];
  const remote = await peer((message, socket) => {
    seen.push(message);
    send(socket, { request_id: message.request_id, ok: true, pid: 7 });
  });
  try {
    for (const value of [null, [], "ping", 1])
      await expect(remote.conn.rawRequest(value)).rejects.toThrow("UnexpectedToken");
    expect(await remote.conn.call("ping")).toEqual({ ok: true, pid: 7 });
    expect(seen).toEqual([{ op: "ping", request_id: 1 }]);
  } finally {
    await remote.close();
  }
});

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
        send(socket, {
          request_id: value.request_id,
          ...(received.length === 2 ? { err: "NoPane" } : { ok: true, pid: 7 }),
        });
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
      { op: "ping", request_id: 1 },
      { op: "viewer.search", protocol: protocol.version, pane: 1, needle: "x", skip: 3, request_id: 2 },
      { op: "invalid", arbitrary: true, request_id: 3 },
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
        socket.write(replies[packets.length - 1].replace("{", `{"request_id":${packets.length},`) + "\n");
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
    const events = await conn.call("headless.events", { provider: "codex", session: "t", after: 0n });
    expect(events.next_seq).toBe(2);
    expect(events.first_seq).toBe(0xffffffffffffffffn);
    expect(packets).toEqual([
      `{"op":"viewer.search","protocol":${protocol.version},"pane":1,"needle":"x","skip":2,"request_id":1}`,
      `{"op":"viewer.search","protocol":${protocol.version},"pane":1,"needle":"x","skip":18446744073709551615,"request_id":2}`,
      `{"op":"headless.events","protocol":${protocol.version},"provider":"codex","session":"t","after":0,"request_id":3}`,
    ]);
  } finally {
    conn.close();
    await new Promise<void>((resolve, reject) => server.close(error => (error ? reject(error) : resolve())));
  }
});

test.each([false, true])("reload waits out a busy daemon until its deadline (expired=%s)", async expired => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-reload-")),
    socket = join(dir, "corgi.sock");
  let asked = 0;
  const server = createServer(peer =>
    peer.on("data", () => send(peer, asked++ < 2 ? { err: "ReloadBusy" } : { ok: true, server_pid: 9, panes: 0 })),
  );
  await new Promise<void>(resolve => server.listen(socket, resolve));
  try {
    const reloaded = reload(socket, "/bin/corgi", expired ? 0 : 5000).then(
      value => value,
      failure => failure.message,
    );
    expect(await reloaded).toEqual(expired ? "ReloadBusy" : { ok: true, server_pid: 9, panes: 0 });
    expect(asked).toBe(expired ? 1 : 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    rmSync(dir, { recursive: true, force: true });
  }
});
