import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "./fixtures/websocket_server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import * as protocol from "./protocol";

test("endpoint completion wakes presentation without pumping continuously", async () => {
  const endpoint = localEndpoint("/tmp/corgi-scheduling-test/control.sock", new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(100);
  const step = spyOn(endpoint as any, "step").mockResolvedValue(true);
  let wakes = 0;
  endpoint.onChange = () => {
    wakes++;
    endpoint.pump(true);
  };
  try {
    endpoint.pump(true);
    await Reflect.get(endpoint, "task");
    expect(wakes).toBe(1);
    expect(step).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(116);
    endpoint.pump(true);
    await Reflect.get(endpoint, "task");
    expect(step).toHaveBeenCalledTimes(2);
    expect(wakes).toBe(2);
    // A step that changed nothing leaves presentation asleep.
    step.mockResolvedValue(false);
    clock.mockReturnValue(132);
    endpoint.pump(true);
    await Reflect.get(endpoint, "task");
    expect(step).toHaveBeenCalledTimes(3);
    expect(wakes).toBe(2);
  } finally {
    endpoint.onChange = () => {};
    await endpoint.close();
    clock.mockRestore();
    step.mockRestore();
  }
});

test("input arriving during an endpoint task runs immediately after completion", async () => {
  const endpoint = localEndpoint("/tmp/corgi-scheduling-test/control.sock", new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(100);
  let finish!: () => void;
  const step = spyOn(endpoint as any, "step").mockImplementation(
    () => new Promise<void>(resolve => (finish = resolve)),
  );
  let wakes = 0;
  endpoint.onChange = () => wakes++;
  try {
    endpoint.status = "online";
    endpoint.ready = endpoint.fresh = true;
    endpoint.pump(true);
    endpoint.status = "online";
    endpoint.enqueue(Uint8Array.of(120));
    endpoint.pump(true);
    expect(step).toHaveBeenCalledTimes(1);
    finish();
    await Reflect.get(endpoint, "task");
    // No clock advancement: the input notification survives the running task.
    endpoint.pump(true);
    expect(step).toHaveBeenCalledTimes(2);
    expect(wakes).toBe(2);
    finish();
    await Reflect.get(endpoint, "task");
  } finally {
    finish?.();
    await endpoint.close();
    clock.mockRestore();
    step.mockRestore();
  }
});

test("a machine keeps its data across reconnects to its daemon but not the daemon's replacement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-endpoint-"));
  const path = join(dir, "control.sock");
  let instance = "first";
  const snapshot = {
    workspaces: [
      {
        id: 1,
        name: "one",
        cwd: "/tmp",
        model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 },
      },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 80,
        rows: 24,
        agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
      },
    ],
    conversations: [],
    native_sessions: [],
  };
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, end)),
          op = request.op;
        buffer = buffer.slice(end + 1);
        const hello = {
          type: "hello",
          protocol: protocol.version,
          viewer_protocol: protocol.viewer_version,
          capabilities: protocol.capabilities,
          instance,
        };
        socket.write(JSON.stringify({ ...(op === "hello" ? hello : snapshot), request_id: request.request_id }) + "\n");
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const endpoint = localEndpoint(path, new Probe(), new Host());
  const connect = () => Reflect.get(endpoint, "connect").call(endpoint) as Promise<void>;
  const disconnect = () => Reflect.get(endpoint, "disconnect").call(endpoint);
  try {
    await connect();
    const runtime = endpoint.machine.runtime;
    endpoint.machine.last_control = 5n;
    disconnect();
    await connect();
    expect(endpoint.machine.runtime).toBe(runtime);
    // Each connection numbers its controls from the start.
    expect(endpoint.machine.last_control).toBe(0n);
    instance = "second";
    disconnect();
    await connect();
    expect(endpoint.machine.runtime).not.toBe(runtime);
  } finally {
    await endpoint.close();
    server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

/** A daemon that keeps links, and drops the connection the first time it gets
 * a command, after running it, the way a network fails between the two. */
async function flakyDaemon() {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-"));
  const path = join(dir, "control.sock");
  const seen: { op: string; seq?: number }[] = [];
  let instance = "first",
    dropped = false;
  const snapshot = {
    workspaces: [
      {
        id: 1,
        name: "one",
        cwd: "/tmp",
        model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0, title: "" }], revision: 0 },
      },
    ],
    panes: [
      {
        id: 1,
        workspace: 1,
        tab: 1,
        cols: 80,
        rows: 24,
        agent: { provider: null, attention: "none", observation: { completed: 0, read: 0 } },
      },
    ],
    conversations: [],
    native_sessions: [],
  };
  const server = createServer(socket => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("error", () => {});
    socket.on("data", chunk => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const request = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        seen.push({ op: request.op, seq: request.seq });
        const reply = (value: unknown) =>
          socket.write(JSON.stringify({ ...(value as object), request_id: request.request_id }) + "\n");
        switch (request.op) {
          case "hello":
            reply({
              type: "hello",
              protocol: protocol.version,
              viewer_protocol: protocol.viewer_version,
              capabilities: protocol.capabilities,
              instance,
            });
            break;
          case "link.open":
            reply({ ok: true, link: `link-${instance}` });
            break;
          case "link.resume":
            reply(
              request.link === `link-${instance}` ? { ok: true, link: request.link, viewer: false } : { err: "NoLink" },
            );
            break;
          case "session.command":
            if (!dropped) {
              dropped = true;
              socket.destroy();
              return;
            }
            reply({ ok: true, result: { pane: 1, tab: 1, workspace: 1, text: null, closed_panes: [] } });
            break;
          default:
            reply(snapshot);
        }
      }
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const endpoint = localEndpoint(path, new Probe(), new Host());
  return {
    endpoint,
    seen,
    replace: () => (instance = "second"),
    connect: () => Reflect.get(endpoint, "connect").call(endpoint) as Promise<void>,
    disconnect: () => Reflect.get(endpoint, "disconnect").call(endpoint),
    close: async () => {
      await endpoint.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("a command whose reply a dropped connection lost is sent again with its number and answered once", async () => {
  const daemon = await flakyDaemon();
  try {
    await daemon.connect();
    const command = { command: { "pane.close": { target: 1 } } } as const;
    const reply = daemon.endpoint.machine.connection.request("session.command", command);
    while (!daemon.seen.some(r => r.op === "session.command")) await Bun.sleep(1);
    daemon.disconnect();
    await daemon.connect();
    expect(await reply).toMatchObject({ ok: true, result: { pane: 1 } });
    const commands = daemon.seen.filter(r => r.op === "session.command");
    expect(commands.map(r => r.seq)).toEqual([1, 1]);
    expect(daemon.seen.map(r => r.op)).toContain("link.resume");
  } finally {
    await daemon.close();
  }
});

test("a command in flight when its daemon is replaced fails, since it may have run", async () => {
  const daemon = await flakyDaemon();
  try {
    await daemon.connect();
    const reply = daemon.endpoint.machine.connection.request("session.command", {
      command: { "pane.close": { target: 1 } },
    });
    const outcome = reply.then(
      () => "answered",
      (error: Error) => error.message,
    );
    while (!daemon.seen.some(r => r.op === "session.command")) await Bun.sleep(1);
    daemon.disconnect();
    daemon.replace();
    await daemon.connect();
    expect(await outcome).toBe("StaleConnection");
  } finally {
    await daemon.close();
  }
});

test("a lost connection is retried at once, then after 1, 2, 4, 8 and at most 15 seconds", async () => {
  const endpoint = localEndpoint("/tmp/corgi-retry-test/control.sock", new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  const step = spyOn(endpoint as any, "step").mockRejectedValue(Error("ConnectionClosed"));
  const delays: number[] = [];
  try {
    for (let i = 0; i < 7; i++) {
      Reflect.set(endpoint, "next", 0);
      endpoint.pump(true);
      await Reflect.get(endpoint, "task");
      delays.push(Reflect.get(endpoint, "next") - 1000);
    }
    expect(delays).toEqual([0, 1000, 2000, 4000, 8000, 15_000, 15_000]);
    expect(endpoint.status).toBe("offline");
  } finally {
    await endpoint.close();
    clock.mockRestore();
    step.mockRestore();
  }
});

test("retry replaces a hung step and its late completion cannot clear the replacement", async () => {
  const endpoint = localEndpoint("/tmp/corgi-retry-test/control.sock", new Probe(), new Host());
  const completions: ((value: boolean) => void)[] = [];
  const step = spyOn(endpoint as any, "step").mockImplementation(
    () => new Promise<boolean>(resolve => completions.push(resolve)),
  );
  try {
    endpoint.pump(true);
    const abandoned = Reflect.get(endpoint, "task");
    endpoint.retry();
    endpoint.pump(true);
    const replacement = Reflect.get(endpoint, "task");
    expect(step).toHaveBeenCalledTimes(2);
    expect(replacement).not.toBe(abandoned);
    completions[0](true);
    await abandoned;
    expect(Reflect.get(endpoint, "task")).toBe(replacement);
    endpoint.pause();
    completions[1](true);
    await replacement;
    expect(endpoint.status).toBe("paused");
    endpoint.pump(true);
    expect(step).toHaveBeenCalledTimes(2);
  } finally {
    for (const done of completions) done(false);
    await endpoint.close();
    step.mockRestore();
  }
});

test("out-of-order numbered replies only acknowledge a contiguous prefix", async () => {
  const endpoint = localEndpoint("/tmp/corgi-ack-test/control.sock", new Probe(), new Host());
  const sent: any[] = [],
    finish: ((value: object) => void)[] = [];
  const conn = {
    rawRequest: (body: unknown) => {
      sent.push(body);
      return new Promise<object>(resolve => finish.push(resolve));
    },
  };
  const pending = [1, 2, 3].map(() => ({ body: { op: "session.command" }, seq: null, resolve() {}, reject() {} }));
  Reflect.set(endpoint, "numbered", [...pending]);
  const send = (index: number) => Reflect.get(endpoint, "send").call(endpoint, pending[index], conn);
  try {
    send(0);
    send(1);
    finish[1]({ ok: true });
    await Promise.resolve();
    expect(Reflect.get(endpoint, "answered")).toBe(0n);
    // The endpoint removes answered entries from its own queue, not this list.
    send(2);
    expect(sent[2].answered).toBe(0n);
    finish[0]({ ok: true });
    await Promise.resolve();
    expect(Reflect.get(endpoint, "answered")).toBe(2n);
    finish[2]({ ok: true });
    await Promise.resolve();
    expect(Reflect.get(endpoint, "answered")).toBe(3n);
  } finally {
    await endpoint.close();
  }
});

test("cached identity does not describe the first connection as a reconnect", async () => {
  const endpoint = localEndpoint("/tmp/corgi-status-test/control.sock", new Probe(), new Host());
  try {
    endpoint.instance = "cached-daemon";
    expect(endpoint.description()).toBe("Connecting…");
    Reflect.set(endpoint, "retries", 1);
    expect(endpoint.description()).toBe("Connecting…");
    Reflect.set(endpoint, "task", Promise.resolve());
    Reflect.set(endpoint, "task_started", 1000);
    expect(endpoint.description(5000)).toBe("Connecting… 4s");
    Reflect.set(endpoint, "connected", true);
    expect(endpoint.description(5000)).toBe("Reconnecting… 4s");
    endpoint.status = "stalled";
    endpoint.status = "offline";
    Reflect.set(endpoint, "next", 8000);
    endpoint.status = "paused";
    endpoint.status = "online";
  } finally {
    await endpoint.close();
  }
});

test("planned reconnect bounds input already queued and releases a full hold without spreading arguments", async () => {
  for (const bytes of [64 * 1024, 256 * 1024]) {
    const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
    try {
      endpoint.enqueue(new Uint8Array(bytes).fill(120));
      Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      const held = Reflect.get(endpoint, "handoff");
      expect(held.input.length).toBe(bytes === 64 * 1024 ? bytes : 0);
      expect(Reflect.get(endpoint, "input")).toEqual([]);
      if (bytes > 64 * 1024) {
        expect(endpoint.error).toBe("Input queue full; unsent input discarded");
        endpoint.enqueue(Uint8Array.of(121));
      }
      endpoint.generation++;
      endpoint.ready = true;
      Reflect.set(endpoint, "resumed", true);
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(Reflect.get(endpoint, "handoff")).toBeNull();
      expect(Reflect.get(endpoint, "input")).toEqual(bytes === 64 * 1024 ? Array(bytes).fill(120) : [121]);
    } finally {
      await endpoint.close();
    }
  }
});

test("planned reconnect input is discarded when selection changes or the hold expires", async () => {
  for (const change of ["selection", "deadline"] as const) {
    const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
    try {
      endpoint.enqueue(Uint8Array.of(120));
      Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      if (change === "selection") endpoint.deactivate();
      else Reflect.get(endpoint, "handoff").until = 0;
      endpoint.generation++;
      endpoint.ready = true;
      Reflect.set(endpoint, "resumed", true);
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(Reflect.get(endpoint, "handoff")).toBeNull();
      expect(Reflect.get(endpoint, "input")).toEqual([]);
    } finally {
      await endpoint.close();
    }
  }
});
