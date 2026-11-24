import { test, expect } from "bun:test";
import { createConnection, createServer, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Connection, type ConnectionInit } from "./rpc";
import { lines } from "./fixtures/lines";
import { listen } from "./fixtures/tcp";
import { until } from "./fixtures/until";
import * as rpc_http from "./rpc_http";
import * as json from "./json";
import * as protocol from "./protocol";

/** A daemon on a local TCP port that hands `receive` each request it reads,
 * and a connection to it. */
async function peer(
  receive: (message: any, socket: Socket, line: string) => void,
  options: ConnectionInit | number = {},
) {
  const sockets = new Set<Socket>();
  const server = createServer(socket => {
    sockets.add(socket);
    lines(socket, line => receive(json.parse(line), socket, line));
  });
  const port = await listen(server);
  const connect = (init = options) => new Connection(createConnection(port, "127.0.0.1"), init);
  const conn = connect();
  return {
    conn,
    connect,
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

test("a timed out request closes its generation and never accepts a late reply", async () => {
  const received: unknown[] = [];
  const remote = await peer(message => received.push(message), 25),
    conn = remote.conn;
  try {
    const first = conn.call("ping"),
      second = conn.call("hello");
    const results = await Promise.allSettled([first, second]);
    expect(results.every(r => r.status === "rejected" && r.reason.message === "RequestTimedOut")).toBe(true);
    await expect(conn.call("ping")).rejects.toThrow("RequestTimedOut");
    expect(received).toHaveLength(2);
    expect(conn.socket.destroyed).toBe(true);
  } finally {
    await remote.close();
  }
});

test("a slow request waits while its daemon is heard from, and the connection fails once it falls silent", async () => {
  // Pings are answered; `hello` never is. Pings 10 ms apart keep it waiting
  // through twice its timeout, with room for a slow machine to miss a few.
  const remote = await peer((request, socket) => {
      if (request.op === "ping") send(socket, { ok: true, request_id: request.request_id });
    }, 200),
    conn = remote.conn;
  try {
    let slow = "waiting";
    conn.call("hello").then(
      () => (slow = "answered"),
      (error: Error) => (slow = error.message),
    );
    const started = performance.now();
    while (performance.now() - started < 400) {
      await conn.call("ping");
      await Bun.sleep(10);
    }
    expect(slow).toBe("waiting");
    await until(() => slow !== "waiting", 2000);
    expect(slow).toBe("RequestTimedOut");
    expect(conn.socket.destroyed).toBe(true);
  } finally {
    await remote.close();
  }
});

test("lost mutation acknowledgments are not replayed and cancellation rejects every pending call", async () => {
  let applied = 0;
  let mutation: (() => void) | null = null;
  const received = new Promise<void>(resolve => (mutation = resolve));
  const remote = await peer((request, socket) => {
      if (request.op === "session.command") {
        applied++;
        mutation!();
        // The daemon applied the command, but its acknowledgment never reaches the client.
      } else if (request.op === "ping") send(socket, { ok: true, pid: 7, request_id: request.request_id });
    }, 10_000),
    conn = remote.conn;
  let replacement: Connection | null = null;
  try {
    const results = Promise.allSettled([
      conn.call("session.command", { command: { "pane.input": { target: 1, data: "run once\r" } } }),
      conn.call("hello"),
    ]);
    await received;
    conn.close();
    expect((await results).every(r => r.status === "rejected" && r.reason.message === "ConnectionClosed")).toBe(true);
    replacement = remote.connect(1000);
    expect(await replacement.call("ping")).toEqual({ ok: true, pid: 7 });
    expect(applied).toBe(1);
  } finally {
    replacement?.close();
    await remote.close();
  }
});

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
  const remote = await peer(
    (message, socket) => {
      expect(message).not.toHaveProperty("request_id");
      expect(message.protocol).toBe(1);
      send(socket, { ok: true });
    },
    { requestIds: false },
  );
  try {
    const [first, second] = await Promise.allSettled([remote.conn.call(op), remote.conn.call(op)]);
    expect(first as unknown).toEqual({ status: "fulfilled", value: { ok: true } });
    expect(second).toMatchObject({ status: "rejected", reason: Error("RequestInFlight") });
  } finally {
    await remote.close();
  }
});

test.each([false, true])("raw RPC preserves caller-supplied ids without correlation (error=%s)", async error => {
  const query = { op: "ping", request_id: 41 };
  const reply = { request_id: 41, ...(error ? { err: "TestFailure" } : { ok: true, pid: 7 }) };
  const remote = await peer(
    (message, socket) => {
      expect(message).toEqual(query);
      send(socket, reply);
    },
    { requestIds: false },
  );
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

/** A daemon that answers each HTTP request with `answer`'s reply. */
function httpDaemon(path: string, answer: (message: any) => object) {
  return Bun.serve({
    unix: path,
    async fetch(request) {
      const reply = answer(json.parse(await request.text()));
      return new Response(json.stringify(reply) + "\n", { status: "err" in reply ? 400 : 200 });
    },
  });
}
test("one-shot unversioned requests go over HTTP and keep the daemon's errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-rpc-")),
    path = join(dir, "corgi.sock"),
    replies = [{ ok: true, pid: 7 }, { ok: true }, { err: "ImportInProgress" }],
    received: unknown[] = [];
  const server = httpDaemon(path, message => {
    received.push(message);
    return replies[received.length - 1];
  });
  const daemon = new rpc_http.Client(path);
  try {
    expect(await daemon.call("ping")).toEqual({ ok: true, pid: 7 });
    expect(await daemon.call("shutdown")).toEqual({ ok: true });
    await expect(daemon.call("shutdown")).rejects.toThrow("ImportInProgress");
    expect(received).toEqual([{ op: "ping" }, { op: "shutdown" }, { op: "shutdown" }]);
  } finally {
    await server.stop(true);
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
          expect(result.reason.message).toBe(
            kind === "disconnect" ? "ConnectionClosed" : kind === "untagged" ? "InvalidJson" : "UnexpectedReply",
          );
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
  const remote = await peer((value, socket) => {
      received.push(value);
      send(socket, {
        request_id: value.request_id,
        ...(received.length === 2 ? { err: "NoPane" } : { ok: true, pid: 7 }),
      });
    }),
    conn = remote.conn;
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
    await remote.close();
  }
});

test("RPC retains raw integer tokens until the receiving model normalizes them", async () => {
  const packets: string[] = [];
  const replies = [
    '{"ok":true,"offset":2}',
    '{"ok":true,"offset":18446744073709551615}',
    '{"ok":true,"events":[],"pending_requests":[],"next_seq":2,"first_seq":18446744073709551615}',
  ];
  const remote = await peer((_, socket, line) => {
      packets.push(line);
      socket.write(replies[packets.length - 1].replace("{", `{"request_id":${packets.length},`) + "\n");
    }),
    conn = remote.conn;
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
    await remote.close();
  }
});

test.each([false, true])("reload waits out a busy daemon until its deadline (expired=%s)", async expired => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-reload-")),
    socket = join(dir, "corgi.sock");
  let asked = 0;
  const server = httpDaemon(socket, () =>
    asked++ < 2 ? { err: "ReloadBusy" } : { ok: true, server_pid: 9, panes: 0 },
  );
  try {
    const reloaded = new rpc_http.Client(socket).reload("/bin/corgi", expired ? 0 : 5000).then(
      value => value,
      (failure: Error) => failure.message,
    );
    expect(await reloaded).toEqual(expired ? "ReloadBusy" : { ok: true, server_pid: 9, panes: 0 });
    expect(asked).toBe(expired ? 1 : 3);
  } finally {
    await server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a streamed reply's parts reach their callback before the reply, and stray parts fail the connection", async () => {
  const remote = await peer((message, socket) => {
    if (message.op !== "conversation.grep") return;
    send(socket, { more: true, matches: [1], request_id: message.request_id });
    send(socket, { more: true, matches: [2], request_id: message.request_id });
    send(socket, { ok: true, matches: [], request_id: message.request_id });
  });
  try {
    const parts: unknown[] = [];
    const reply = await remote.conn.streamed("conversation.grep", { patterns: ["x"], workspace: "*" }, part =>
      parts.push(part),
    );
    expect(parts).toEqual([{ matches: [1] }, { matches: [2] }]);
    expect(reply).toEqual({ ok: true, matches: [] } as any);
    // A plain request has nowhere to put parts.
    await expect(remote.conn.request("conversation.grep", { patterns: ["x"], workspace: "*" })).rejects.toThrow(
      "UnexpectedReply",
    );
  } finally {
    await remote.close();
  }
});
