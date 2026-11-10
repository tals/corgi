import { sshEndpoint } from "./ssh_path";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "./fixtures/websocket_server";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import * as protocol from "./protocol";
import * as machine_path from "./machine_path";

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
async function flakyDaemon(remote = false) {
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
  const endpoint = remote
    ? new Endpoint("work", true, ["work"], machine_path.local(path), new Probe(), new Host())
    : localEndpoint(path, new Probe(), new Host());
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

test("a retry after a pause opens a fresh link, so the numbers it dropped leave no gap", async () => {
  const daemon = await flakyDaemon();
  const command = { command: { "pane.close": { target: 1 } } } as const;
  try {
    await daemon.connect();
    const dropped = daemon.endpoint.machine.connection.request("session.command", command).then(
      () => "answered",
      (error: Error) => error.message,
    );
    // Its number is taken, it's never answered, and pausing drops it.
    while (!daemon.seen.some(r => r.op === "session.command")) await Bun.sleep(1);
    daemon.endpoint.pause();
    expect(await dropped).toBe("StaleConnection");
    daemon.endpoint.retry();
    await daemon.connect();
    expect(await daemon.endpoint.machine.connection.request("session.command", command)).toMatchObject({ ok: true });
    const after = daemon.seen.slice(daemon.seen.findIndex(r => r.op === "session.command") + 1);
    expect(after.map(r => r.op)).not.toContain("link.resume");
    expect(after.filter(r => r.op === "session.command").map(r => r.seq)).toEqual([1]);
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

/** The error a socket nothing listens on gives. */
const refused = () => Object.assign(Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" });

test("this computer's daemon shutting down ends the viewer at once; one gone or hung is tried until it answers", async () => {
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  const fail = async (endpoint: Endpoint, at: number) => {
    clock.mockReturnValue(at);
    Reflect.set(endpoint, "next", 0);
    endpoint.pump(true);
    await Reflect.get(endpoint, "task");
  };
  const stopping = localEndpoint("/tmp/corgi-gone-test/control.sock", new Probe(), new Host());
  const gone = localEndpoint("/tmp/corgi-gone-test/control.sock", new Probe(), new Host());
  const hung = localEndpoint("/tmp/corgi-gone-test/control.sock", new Probe(), new Host());
  const steps = [stopping, gone, hung].map(endpoint => {
    Reflect.set(endpoint, "connected", true);
    return spyOn(endpoint as any, "step").mockRejectedValue(refused());
  });
  steps[0].mockRejectedValueOnce(Error("ServerShutdown"));
  steps[2].mockRejectedValue(Error("RequestTimedOut"));
  try {
    await fail(stopping, 1000);
    expect(stopping.detached).toBe(true);
    expect(stopping.fatal).toBeNull();
    for (const endpoint of [gone, hung]) {
      for (const at of [1000, 6500, 60_000, 600_000]) await fail(endpoint, at);
      expect(endpoint.status).toBe("offline");
      expect(endpoint.fatal).toBeNull();
      expect(endpoint.detached).toBe(false);
    }
  } finally {
    for (const step of steps) step.mockRestore();
    clock.mockRestore();
    for (const endpoint of [stopping, gone, hung]) await endpoint.close();
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
    expect(endpoint.headerStatus(5000)).toEqual({ label: "connecting", seconds: 0, color: "warm" });
    Reflect.set(endpoint, "retries", 1);
    expect(endpoint.description()).toBe("Connecting…");
    Reflect.set(endpoint, "task", Promise.resolve());
    Reflect.set(endpoint, "task_started", 1000);
    expect(endpoint.description(5000)).toBe("Connecting… 4s");
    expect(endpoint.headerStatus(5000)).toEqual({ label: "connecting", seconds: 4, color: "warm" });
    expect(endpoint.headerStatus(6000)?.seconds).toBe(5);
    Reflect.set(endpoint, "connected", true);
    expect(endpoint.description(5000)).toBe("Reconnecting… 4s");
    expect(endpoint.headerStatus(5000)?.label).toBe("reconnecting");
    endpoint.status = "stalled";
    expect(endpoint.headerStatus(5000)).toEqual({ label: "stalled", seconds: 4, color: "warm" });
    endpoint.status = "offline";
    Reflect.set(endpoint, "next", 8000);
    expect(endpoint.headerStatus(5000)).toEqual({ label: "retry in", seconds: 3, color: "hot" });
    expect(endpoint.headerStatus(6000)?.seconds).toBe(2);
    expect(endpoint.headerStatus(9000)?.seconds).toBe(0);
    endpoint.status = "paused";
    expect(endpoint.headerStatus(5000)).toEqual({ label: "paused", seconds: null, color: "muted" });
    endpoint.status = "online";
    expect(endpoint.headerStatus(5000)).toBeNull();
  } finally {
    await endpoint.close();
  }
});

const recoveryProfile = {
  name: "test-recovery",
  target: "unused",
  executable: "/unused",
  socket: "/unused",
  home: "/tmp",
  bridge: "/unused",
};

test("a primary timeout preserves the spare handshake, while pause cancels it", async () => {
  const endpoint = sshEndpoint(recoveryProfile, new Probe(), new Host());
  const close = { calls: 0 };
  const probe = { close: () => close.calls++ };
  const step = spyOn(endpoint as any, "step").mockRejectedValue(Error("RequestTimedOut"));
  Reflect.set(endpoint, "probe_path", probe);
  Reflect.set(endpoint, "racing", true);
  try {
    endpoint.pump(false);
    await Reflect.get(endpoint, "task");
    expect(endpoint.status).toBe("offline");
    expect(close.calls).toBe(0);
    expect(Reflect.get(endpoint, "probe_path")).toBe(probe);
    expect(Reflect.get(endpoint, "racing")).toBe(true);
    endpoint.pause();
    expect(close.calls).toBe(1);
    expect(Reflect.get(endpoint, "racing")).toBe(false);
  } finally {
    await endpoint.close();
    step.mockRestore();
  }
});

test("a hung reconnect gets a spare dial without racing a first connection", async () => {
  const endpoint = sshEndpoint(recoveryProfile, new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  let finish!: (value: boolean) => void;
  const step = spyOn(endpoint as any, "step").mockImplementation(
    () => new Promise<boolean>(resolve => (finish = resolve)),
  );
  const race = spyOn(endpoint as any, "race").mockResolvedValue(undefined);
  Reflect.set(endpoint, "link", "saved-link");
  try {
    endpoint.pump(false);
    clock.mockReturnValue(10000);
    endpoint.pump(false);
    expect(race).not.toHaveBeenCalled();
    Reflect.set(endpoint, "connected", true);
    endpoint.stats.traffic("received", 1, 1000);
    // A newly failed dial must not restart the silence clock for recovery.
    Reflect.set(endpoint, "task_started", 9999);
    endpoint.pump(false);
    expect(race).toHaveBeenCalledTimes(1);
    Reflect.set(endpoint, "raced_at", 10000);
    clock.mockReturnValue(13999);
    endpoint.pump(false);
    expect(race).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(14000);
    endpoint.pump(false);
    expect(race).toHaveBeenCalledTimes(2);
    // Control replies cannot hide a hung data-lane handshake.
    Reflect.set(endpoint, "raced_at", 14000);
    clock.mockReturnValue(18000);
    endpoint.stats.traffic("received", 1, 18000);
    Reflect.set(endpoint, "data", { age: () => 9000, close() {} });
    endpoint.pump(false);
    expect(race).toHaveBeenCalledTimes(3);
    Reflect.set(endpoint, "data", null);
  } finally {
    finish(false);
    await Reflect.get(endpoint, "task");
    await endpoint.close();
    clock.mockRestore();
    step.mockRestore();
    race.mockRestore();
  }
});

test("a long outage gets fresh dials at the retries' pace, not every few seconds", async () => {
  const endpoint = sshEndpoint(recoveryProfile, new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  let finish!: (value: boolean) => void;
  const step = spyOn(endpoint as any, "step").mockImplementation(
    () => new Promise<boolean>(resolve => (finish = resolve)),
  );
  const race = spyOn(endpoint as any, "race").mockResolvedValue(undefined);
  Reflect.set(endpoint, "link", "saved-link");
  try {
    endpoint.pump(false);
    Reflect.set(endpoint, "connected", true);
    endpoint.stats.traffic("received", 1, 1000);
    // Two minutes in, the last dial was 10 s ago: too soon.
    Reflect.set(endpoint, "raced_at", 190_000);
    clock.mockReturnValue(200_000);
    endpoint.pump(false);
    expect(race).not.toHaveBeenCalled();
    clock.mockReturnValue(205_000);
    endpoint.pump(false);
    expect(race).toHaveBeenCalledTimes(1);
  } finally {
    finish(false);
    await Reflect.get(endpoint, "task");
    await endpoint.close();
    clock.mockRestore();
    step.mockRestore();
    race.mockRestore();
  }
});

test("a spare that answers during reconnect takes over and resumes the same link", async () => {
  const daemon = await flakyDaemon();
  const endpoint = daemon.endpoint;
  try {
    await daemon.connect();
    endpoint.status = "connecting";
    const generation = endpoint.generation;
    await Reflect.get(endpoint, "race").call(endpoint, performance.now());
    expect(endpoint.generation).toBeGreaterThan(generation);
    expect(Reflect.get(endpoint, "dialed")).not.toBeNull();
    await daemon.connect();
    expect(daemon.seen.filter(request => request.op === "link.resume")).toHaveLength(1);
    expect(endpoint.instance).toBe("first");
  } finally {
    await daemon.close();
  }
});

test("a spare that takes over brings its own data connection, already dialed", async () => {
  const daemon = await flakyDaemon(true);
  const endpoint = daemon.endpoint;
  try {
    await daemon.connect();
    endpoint.status = "connecting";
    await Reflect.get(endpoint, "race").call(endpoint, performance.now());
    const dialed = Reflect.get(endpoint, "dialed");
    expect(dialed?.data).toBeTruthy();
    await daemon.connect();
    expect(Reflect.get(endpoint, "data")).toBe(dialed.data);
  } finally {
    await daemon.close();
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

test("typing into an idle viewer goes at once, not at the idle step's pace", async () => {
  const endpoint = localEndpoint("/tmp/corgi-idle-input/control.sock", new Probe(), new Host());
  try {
    const view = Reflect.get(endpoint, "view").call(endpoint);
    view.input_state.attached = true;
    Reflect.set(endpoint, "settled", true);
    endpoint.enqueue(Uint8Array.of(120));
    // An idle step ran meanwhile and put the next one half a second off.
    Reflect.set(endpoint, "next", performance.now() + 500);
    Reflect.get(endpoint, "pumpUi").call(endpoint);
    await Reflect.get(endpoint, "ui_task");
    expect(Reflect.get(endpoint, "next")).toBe(0);
  } finally {
    await endpoint.close();
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
