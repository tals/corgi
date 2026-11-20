import { Parser, type Input } from "./terminal_input";
import { sshEndpoint } from "./ssh_path";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "./fixtures/websocket_server";
import { lines } from "./fixtures/lines";
import { until } from "./fixtures/until";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Probe } from "./terminal_info";
import { Host } from "./host";
import * as protocol from "./protocol";
import * as machine_path from "./machine_path";
import { Controller } from "./controller";
import * as worktrees from "./fixtures/worktrees";
import { transport } from "./fixtures/transport";

/** A daemon that keeps links, and drops the connection the first time it gets
 * a command, after running it, the way a network fails between the two. */
async function flakyDaemon(
  remote = false,
  resumed = false,
  bound = Promise.resolve(),
  update?: ConstructorParameters<typeof Endpoint>[6],
) {
  const dir = mkdtempSync(join(tmpdir(), "corgi-link-"));
  const path = join(dir, "control.sock");
  const seen: { op: string; seq?: number; worktree_detail?: number | null }[] = [];
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
    socket.on("error", () => {});
    lines(socket, line => {
      const request = JSON.parse(line);
      seen.push(request);
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
            request.link === `link-${instance}` ? { ok: true, link: request.link, viewer: resumed } : { err: "NoLink" },
          );
          break;
        case "viewer.open":
          reply({ viewer_protocol: protocol.viewer_version, workspace: 1, focus: 1, bell_seq: 0 });
          break;
        case "viewer.data":
          void bound.then(() => reply({ viewer: 1 }));
          break;
        case "agent.history":
          socket.write(
            JSON.stringify({ type: "agent.history", update: { full: true, entries: [], removed: [] } }) + "\n",
          );
          reply({ ok: true });
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
    });
  });
  await new Promise<void>(resolve => server.listen(path, resolve));
  const endpoint = remote
    ? new Endpoint("work", true, ["work"], machine_path.local(path), new Probe(), new Host(), update)
    : localEndpoint(path, new Probe(), new Host());
  return {
    endpoint,
    path,
    seen,
    replace: (next = "second") => (instance = next),
    connect: () => Reflect.get(endpoint, "connect").call(endpoint) as Promise<void>,
    disconnect: () => Reflect.get(endpoint, "disconnect").call(endpoint),
    close: async () => {
      await endpoint.close();
      server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

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
    enqueue(endpoint, Uint8Array.of(120));
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

test("binding a viewer without switching machines does not fetch history twice", async () => {
  const bound = Promise.withResolvers<void>(),
    daemon = await flakyDaemon(true, false, bound.promise),
    endpoint = daemon.endpoint,
    view = new Controller(endpoint.machine);
  endpoint.controller = view;
  endpoint.activate();
  const step = Reflect.get(endpoint, "step").call(endpoint, true, Reflect.get(endpoint, "selection"));
  try {
    await until(
      () =>
        daemon.seen.some(r => r.op === "viewer.data") &&
        !view.launch_previews.history.pending &&
        !Reflect.get(view.launch_previews, "subscribing"),
    );
    bound.resolve();
    await step;
    view.updateLaunchPreview();
    await until(() => !Reflect.get(view.launch_previews, "subscribing"));
    expect(daemon.seen.filter(r => r.op === "agent.history")).toHaveLength(1);
  } finally {
    bound.resolve();
    await step;
    view.launch_previews.disconnect();
    await daemon.close();
  }
});

test("switching away and back during viewer binding keeps history connected", async () => {
  const bound = Promise.withResolvers<void>(),
    daemon = await flakyDaemon(true, false, bound.promise),
    endpoint = daemon.endpoint,
    view = new Controller(transport(async () => ({}))),
    local = view.machine;
  endpoint.controller = view;
  view.switchMachine(endpoint.machine);
  endpoint.activate();
  let step: Promise<boolean> | null = null;
  try {
    step = Reflect.get(endpoint, "step").call(endpoint, true, Reflect.get(endpoint, "selection"));
    await until(() => daemon.seen.some(r => r.op === "viewer.data"));
    expect(endpoint.machine.viewer_id).toBe(0);
    view.switchMachine(local);
    endpoint.deactivate();
    view.switchMachine(endpoint.machine);
    endpoint.activate();
    bound.resolve();
    await step;
    endpoint.status = "online";
    expect(endpoint.machine.viewer_id).toBe(1);
    view.current().worktrees = worktrees.app();
    await view.perform({ name: "worktrees", value: view.workspaceRef(1) });
    await view.perform({ name: "worktree-enter" });
    expect(view.worktree_card.pending_enter).not.toBeNull();
    await until(() => {
      view.updateLaunchPreview();
      return view.agent_launcher?.cwd === "/src/app-topic";
    });
    expect(view.worktree_card.pending_enter).toBeNull();
  } finally {
    bound.resolve();
    await step;
    view.launch_previews.disconnect();
    await daemon.close();
    local.runtime.destroy();
  }
});

test("failed and retried builds leave a compatible connection online", async () => {
  const first = Promise.withResolvers<machine_path.Factory>();
  const second = Promise.withResolvers<machine_path.Factory>();
  const signals: AbortSignal[] = [];
  const daemon = await flakyDaemon(true, false, undefined, (signal, progress) => {
    signals.push(signal);
    progress("Build linux-arm64");
    return signals.length === 1 ? first.promise : second.promise;
  });
  const { endpoint } = daemon;
  try {
    endpoint.pump(false);
    await until(() => endpoint.status === "online");
    const generation = endpoint.generation;
    expect(endpoint.machine.presence().connection_status?.label).toBe("Build linux-arm64");
    first.reject(Error("Compiler failed"));
    await until(() => endpoint.updateError === "Compiler failed");
    expect(endpoint.error).toBe("");
    expect(endpoint.headerStatus()).toMatchObject({ label: "Update failed", diagnostic: true });
    endpoint.retry();
    expect(endpoint.status).toBe("online");
    second.resolve(machine_path.local(daemon.path));
    await until(() => !endpoint.updateMessage);
    expect(endpoint.generation).toBe(generation);
    daemon.disconnect();
    await daemon.connect();
    expect(signals).toHaveLength(2);
  } finally {
    await daemon.close();
  }
});

test("a paused update cannot replace the path and a completed update retries an incompatible daemon", async () => {
  const daemon = await flakyDaemon();
  const obsolete = (): machine_path.Path => ({
    ...machine_path.local(daemon.path)(false, false),
    async open() {
      throw Error("IncompatibleRemoteCorgi");
    },
    diagnose: () => ({ issue: "error", detail: "" }),
  });
  const jobs: {
    signal: AbortSignal;
    finish: (factory: machine_path.Factory) => void;
    progress: (message: string) => void;
  }[] = [];
  const endpoint = new Endpoint(
    "work",
    true,
    ["work"],
    obsolete,
    new Probe(),
    new Host(),
    (signal, progress) => new Promise(finish => jobs.push({ signal, finish, progress })),
  );
  try {
    endpoint.pump(false);
    await until(() => endpoint.status === "incompatible");
    endpoint.pause();
    expect(jobs[0].signal.aborted).toBe(true);
    endpoint.retry();
    endpoint.pump(false);
    await until(() => endpoint.status === "incompatible");
    jobs[1].progress("Uploading delta");
    jobs[0].progress("Stale progress");
    jobs[0].finish(obsolete);
    await Bun.sleep(0);
    expect(endpoint.status).toBe("incompatible");
    expect(endpoint.updateMessage).toBe("Uploading delta");
    jobs[1].finish(machine_path.local(daemon.path));
    await until(() => endpoint.status === "connecting");
    endpoint.pump(false);
    await until(() => endpoint.status === "online");
    expect(jobs).toHaveLength(2);
  } finally {
    await endpoint.close();
    await daemon.close();
  }
});

test("a machine keeps its data across reconnects to its daemon but not the daemon's replacement", async () => {
  const daemon = await flakyDaemon(),
    endpoint = daemon.endpoint,
    view = new Controller(transport(async () => ({})));
  endpoint.controller = view;
  view.adopt(endpoint.machine);
  try {
    await daemon.connect();
    const runtime = endpoint.machine.runtime,
      expire = spyOn(view.model_cache, "expire");
    view.worktree_card.workspace = view.workspaceRef(1, endpoint.machine);
    view.worktree_card.pinned = true;
    await Reflect.get(endpoint, "step").call(endpoint, false, 0);
    expect(daemon.seen.at(-1)).toMatchObject({ op: "session.snapshot", worktree_detail: 1 });
    expect(daemon.seen.some(r => r.op === "viewer.open")).toBe(false);
    expect(view.machine).not.toBe(endpoint.machine);
    endpoint.machine.last_control = 5n;
    daemon.disconnect();
    await daemon.connect();
    expect(endpoint.machine.runtime).toBe(runtime);
    expect(expire).not.toHaveBeenCalled();
    expect(view.worktreeDetail()).toEqual(view.workspaceRef(1, endpoint.machine));
    // Each connection numbers its controls from the start.
    expect(endpoint.machine.last_control).toBe(0n);
    daemon.replace();
    daemon.disconnect();
    await daemon.connect();
    expect(endpoint.machine.runtime).not.toBe(runtime);
    expect(view.worktreeDetail()).toBeNull();
    expect(expire).not.toHaveBeenCalled();
    // Replacing the shown daemon also refreshes its model lists.
    view.switchMachine(endpoint.machine);
    const remoteExpire = spyOn(view.model_cache, "expire");
    daemon.replace("third");
    daemon.disconnect();
    await daemon.connect();
    expect(remoteExpire).toHaveBeenCalledTimes(1);
    expect(expire).not.toHaveBeenCalled();
  } finally {
    await daemon.close();
    view.runtime.destroy();
  }
});

test("resetting a viewer cancels a suspended paste and its later queued Enter", async () => {
  for (const [connected, resumed] of [
    [false, false],
    [true, false],
    [true, true],
  ]) {
    const daemon = await flakyDaemon(false, resumed),
      endpoint = daemon.endpoint;
    if (connected) await daemon.connect();
    const view = Reflect.get(endpoint, "view").call(endpoint) as NonNullable<Endpoint["controller"]>,
      seen: string[] = [];
    let finish!: () => void;
    const event = spyOn(view as any, "inputEvent").mockImplementation(async (input: Input) => {
      seen.push(input.kind);
      if (seen.length === 1) await new Promise<void>(resolve => (finish = resolve));
    });
    try {
      endpoint.machine.viewer_id = connected ? 1 : 0;
      view.input_state.attached = true;
      Reflect.set(endpoint, "settled", true);
      enqueue(endpoint, Buffer.from("\x02\x1b[200~hello\x1b[201~"));
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(seen).toEqual(["text"]);
      enqueue(endpoint, Buffer.from("\r"));
      const epoch = endpoint.input_epoch;
      if (connected) daemon.disconnect();
      await daemon.connect();
      expect(Buffer.from(queued(endpoint)).toString()).toBe(resumed ? "\r" : "");
      expect(endpoint.input_epoch === epoch).toBe(resumed);
      finish();
      await Reflect.get(endpoint, "ui_task");
      expect(seen).toEqual(resumed ? ["text", "paste_start", "paste", "paste_end"] : ["text"]);
    } finally {
      finish?.();
      await daemon.close();
      event.mockRestore();
    }
  }
});

test.each(["", "first", "older"])(
  "initial connection retains a paste before the first frame with cached instance '%s'",
  async instance => {
    const daemon = await flakyDaemon(),
      paste = "\x1b[200~hello\x1b[201~\r";
    try {
      daemon.endpoint.instance = instance;
      enqueue(daemon.endpoint, Buffer.from(paste));
      await daemon.connect();
      expect(Buffer.from(queued(daemon.endpoint)).toString()).toBe(paste);
    } finally {
      await daemon.close();
    }
  },
);

test("a command whose reply a dropped connection lost is sent again with its number and answered once", async () => {
  const daemon = await flakyDaemon();
  try {
    await daemon.connect();
    const command = { command: { "pane.close": { target: 1 } } } as const;
    const reply = daemon.endpoint.machine.connection.request("session.command", command);
    await until(() => daemon.seen.some(r => r.op === "session.command"));
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
    await until(() => daemon.seen.some(r => r.op === "session.command"));
    daemon.endpoint.pause();
    expect(await dropped).toBe("ReplyLost");
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
    await until(() => daemon.seen.some(r => r.op === "session.command"));
    daemon.disconnect();
    daemon.replace();
    await daemon.connect();
    expect(await outcome).toBe("ReplyLost");
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

test("after a sleep, a fresh connection takes over unless the old one is heard from first", async () => {
  for (const heard of [false, true]) {
    const hello = { protocol: protocol.version, viewer_protocol: protocol.viewer_version, instance: "daemon" };
    const answering: machine_path.Factory = () => ({
      races: true,
      socket: null,
      home: "/",
      upload: null,
      open: async () => ({ connection: { close() {} } as any, hello: hello as any }),
      stallMs: () => 4000,
      diagnose: () => ({ issue: "error", detail: "" }),
      progress: () => "",
      close() {},
    });
    const endpoint = new Endpoint("work", true, ["work"], answering, new Probe(), new Host());
    const stream = { heard: 1000 };
    try {
      endpoint.instance = "daemon";
      endpoint.status = "online";
      Reflect.set(endpoint, "stream", stream);
      endpoint.woke();
      const race = Reflect.get(endpoint, "race").call(endpoint, performance.now());
      // The old connection still reads online, as a suspended clock leaves it.
      if (heard) stream.heard = 2000;
      await race;
      expect(Reflect.get(endpoint, "dialed") !== null).toBe(!heard);
    } finally {
      await endpoint.close();
    }
  }
  // A machine not shown has no stream to hear from: its connection stays.
  const endpoint = new Endpoint(
    "work",
    true,
    ["work"],
    machine_path.local("/tmp/corgi-race-hidden.sock"),
    new Probe(),
    new Host(),
  );
  try {
    endpoint.status = "online";
    endpoint.woke();
    await Reflect.get(endpoint, "race").call(endpoint, performance.now());
    expect(Reflect.get(endpoint, "dialed")).toBeNull();
  } finally {
    await endpoint.close();
  }
});

test("an SSH machine shut down on purpose isn't started again until the user retries", async () => {
  const starts: (boolean | undefined)[] = [];
  const hung: machine_path.Factory = (_fresh, _race, start) => {
    starts.push(start);
    return {
      races: true,
      socket: null,
      home: "/",
      upload: null,
      open: () => new Promise(() => {}),
      stallMs: () => 4000,
      diagnose: () => ({ issue: "error", detail: "" }),
      progress: () => "",
      close() {},
    };
  };
  const endpoint = new Endpoint("work", true, ["work"], hung, new Probe(), new Host());
  const step = spyOn(endpoint as any, "step").mockRejectedValue(Error("ServerShutdown"));
  try {
    endpoint.pump(true);
    await Reflect.get(endpoint, "task");
    expect(endpoint.status).toBe("offline");
    step.mockRestore();
    starts.length = 0;
    void Reflect.get(endpoint, "race").call(endpoint, performance.now());
    endpoint.retry();
    void Reflect.get(endpoint, "race").call(endpoint, performance.now());
    expect(starts).toEqual([false, true]);
  } finally {
    step.mockRestore();
    Reflect.set(endpoint, "task", null);
    await endpoint.close();
  }
});

test("typing into an SSH machine that's backing off waits for its next dial", async () => {
  const endpoint = new Endpoint(
    "work",
    true,
    ["work"],
    machine_path.local("/tmp/corgi-retry-typing/control.sock"),
    new Probe(),
    new Host(),
  );
  try {
    endpoint.status = "offline";
    const next = performance.now() + 8000;
    Reflect.set(endpoint, "next", next);
    enqueue(endpoint, Uint8Array.of(120));
    expect(Reflect.get(endpoint, "next")).toBe(next);
  } finally {
    await endpoint.close();
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

test("a connect from online or at startup shows nothing for its first second", async () => {
  const endpoint = localEndpoint("/tmp/corgi-status-test/control.sock", new Probe(), new Host());
  const presence = () => {
    const { online, connecting, stopped, connection_status } = endpoint.machine.presence();
    // Rows stay in keyboard navigation throughout.
    expect(stopped).toBe(false);
    return { online, connecting, label: connection_status?.label ?? null };
  };
  const age = (ms: number) => {
    const spell = Reflect.get(endpoint, "connecting");
    Reflect.set(endpoint, "connecting", { ...spell, since: spell.since - ms });
  };
  try {
    expect(presence()).toEqual({ online: false, connecting: false, label: null });
    age(1000);
    expect(presence()).toEqual({ online: false, connecting: true, label: "connecting" });
    endpoint.status = "online";
    Reflect.set(endpoint, "connected", true);
    // A reconnect looks online until it's taken a second.
    endpoint.status = "connecting";
    expect(presence()).toEqual({ online: true, connecting: false, label: null });
    age(1000);
    expect(presence()).toEqual({ online: false, connecting: true, label: "reconnecting" });
    // After an outage that showed, it says so at once.
    endpoint.status = "offline";
    endpoint.status = "connecting";
    expect(presence()).toEqual({ online: false, connecting: true, label: "reconnecting" });
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

test("an SSH machine that failed counts down to its retry, its details a click away", async () => {
  const endpoint = new Endpoint(
    "work",
    true,
    ["work"],
    machine_path.local("/tmp/corgi-status-remote/control.sock"),
    new Probe(),
    new Host(),
  );
  try {
    endpoint.status = "offline";
    endpoint.error = "ConnectionClosed";
    Reflect.set(endpoint, "next", 8000);
    expect(endpoint.headerStatus(5000)).toEqual({ label: "retry in", seconds: 3, color: "hot", diagnostic: true });
    endpoint.status = "connecting";
    expect(endpoint.headerStatus(5000)).toMatchObject({ label: "connecting", diagnostic: true });
    // Access it can't fix by retrying says so.
    endpoint.status = "attention";
    Reflect.set(endpoint, "issue", "auth");
    expect(endpoint.headerStatus(5000)).toEqual({ label: "! auth", seconds: null, color: "hot", diagnostic: true });
    endpoint.status = "online";
    endpoint.error = "";
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
/** An SSH machine with a saved link, whose connecting step hangs until the
 * test closes it and whose spare dials are counted instead of made. */
function hungReconnect() {
  const endpoint = sshEndpoint(recoveryProfile, new Probe(), new Host());
  const clock = spyOn(performance, "now").mockReturnValue(1000);
  let finish!: (value: boolean) => void;
  const step = spyOn(endpoint as any, "step").mockImplementation(
    () => new Promise<boolean>(resolve => (finish = resolve)),
  );
  const race = spyOn(endpoint as any, "race").mockResolvedValue(undefined);
  Reflect.set(endpoint, "link", "saved-link");
  return {
    endpoint,
    clock,
    race,
    async close() {
      finish(false);
      await Reflect.get(endpoint, "task");
      await endpoint.close();
      clock.mockRestore();
      step.mockRestore();
      race.mockRestore();
    },
  };
}

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
  const { endpoint, clock, race, close } = hungReconnect();
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
    await close();
  }
});

test("a long outage gets fresh dials at the retries' pace, not every few seconds", async () => {
  const { endpoint, clock, race, close } = hungReconnect();
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
    await close();
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
      enqueue(endpoint, new Uint8Array(bytes).fill(120));
      Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      const held = Reflect.get(endpoint, "handoff");
      expect(held.input.bytes).toBe(bytes === 64 * 1024 ? bytes : 0);
      expect(queued(endpoint)).toEqual([]);
      if (bytes > 64 * 1024) {
        expect(endpoint.error).toBe("Input queue full; unsent input discarded");
        enqueue(endpoint, Uint8Array.of(121));
      }
      endpoint.generation++;
      endpoint.ready = true;
      Reflect.set(endpoint, "resumed", true);
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(Reflect.get(endpoint, "handoff")).toBeNull();
      expect(queued(endpoint)).toEqual(bytes === 64 * 1024 ? Array(bytes).fill(120) : [121]);
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
    enqueue(endpoint, Uint8Array.of(120));
    // An idle step ran meanwhile and put the next one half a second off.
    Reflect.set(endpoint, "next", performance.now() + 500);
    Reflect.get(endpoint, "pumpUi").call(endpoint);
    await Reflect.get(endpoint, "ui_task");
    expect(Reflect.get(endpoint, "next")).toBe(0);
  } finally {
    await endpoint.close();
  }
});

test("keys keep whether they came while dropping, through a reload, and the view routes them so", async () => {
  const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
  try {
    const view = Reflect.get(endpoint, "view").call(endpoint);
    view.input_state.attached = true;
    Reflect.set(endpoint, "settled", true);
    const routed: [string, boolean][] = [],
      expired: boolean[] = [];
    view.input = async (data: readonly Input[], _current: () => boolean, dropped: boolean) =>
      void routed.push([Buffer.concat(data.map(input => input.bytes)).toString(), dropped]);
    view.expireInput = async (_current: () => boolean, dropped: boolean) => void expired.push(dropped);
    enqueue(endpoint, Buffer.from("a"));
    Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
    enqueue(endpoint, Buffer.from("b"), true);
    enqueue(endpoint, Buffer.from("c"), true);
    endpoint.generation++;
    endpoint.ready = true;
    Reflect.set(endpoint, "resumed", true);
    Reflect.get(endpoint, "pumpUi").call(endpoint);
    await Reflect.get(endpoint, "ui_task");
    expect(routed).toEqual([
      ["a", false],
      ["bc", true],
    ]);
    // What the view holds back of the last keys came while dropping too.
    expect(expired).toEqual([true]);
  } finally {
    await endpoint.close();
  }
});

test("switching machines while routing reload input discards later batches", async () => {
  const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
  try {
    const view = Reflect.get(endpoint, "view").call(endpoint);
    view.input_state.attached = true;
    Reflect.set(endpoint, "settled", true);
    const routed: [string, boolean][] = [],
      expired: boolean[] = [];
    view.input = async (data: readonly Input[], _current: () => boolean, dropped: boolean) => {
      routed.push([Buffer.concat(data.map(input => input.bytes)).toString(), dropped]);
      endpoint.deactivate();
    };
    view.expireInput = async (_current: () => boolean, dropped: boolean) => void expired.push(dropped);
    enqueue(endpoint, Buffer.from("switch"));
    Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
    enqueue(endpoint, Buffer.from("dropped"), true);
    enqueue(endpoint, Buffer.from("later"));
    endpoint.generation++;
    endpoint.ready = true;
    Reflect.set(endpoint, "resumed", true);
    Reflect.get(endpoint, "pumpUi").call(endpoint);
    await Reflect.get(endpoint, "ui_task");
    expect(routed).toEqual([["switch", false]]);
    expect(expired).toEqual([]);
    expect(queued(endpoint)).toEqual([]);
  } finally {
    await endpoint.close();
  }
});

test("leaving an endpoint drops a cancelled paste and the queued keys following it", async () => {
  for (const change of ["switch", "deactivate"]) {
    for (const active_paste of [false, true]) {
      const endpoint = localEndpoint("/tmp/corgi-paste-owner/control.sock", new Probe(), new Host());
      try {
        const view = Reflect.get(endpoint, "view").call(endpoint),
          parser = new Parser();
        if (active_paste) view.input_state.paste = "discard";
        for (const input of parser.feed(Buffer.from(active_paste ? "\r" : "echo \x1b[200~hello\x1b[201~\r")))
          endpoint.enqueue(input);
        let retained: number[];
        if (change === "switch") retained = Array.from(Buffer.concat(endpoint.takeInput().map(input => input.bytes)));
        else {
          endpoint.deactivate();
          retained = queued(endpoint);
        }
        expect(Buffer.from(retained).toString()).toBe(active_paste ? "" : "echo ");
      } finally {
        await endpoint.close();
      }
    }
  }
});

test("cancelling a suspended batch drops typing queued after its unprocessed paste", async () => {
  for (const change of ["switch", "deactivate"]) {
    const endpoint = localEndpoint("/tmp/corgi-paste-batch/control.sock", new Probe(), new Host()),
      view = Reflect.get(endpoint, "view").call(endpoint);
    let finish!: () => void;
    const event = spyOn(view, "inputEvent").mockImplementationOnce(
      () => new Promise<void>(resolve => (finish = resolve)),
    );
    try {
      view.input_state.attached = true;
      Reflect.set(endpoint, "settled", true);
      enqueue(endpoint, Buffer.from("\x02\x1b[200~hello\x1b[201~"));
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(event).toHaveBeenCalledTimes(1);
      expect(view.input_state.paste).toBeNull();
      enqueue(endpoint, Buffer.from("\r"));
      if (change === "switch") expect(endpoint.takeInput()).toEqual([]);
      endpoint.deactivate();
      expect(queued(endpoint)).toEqual([]);
      finish();
      await Reflect.get(endpoint, "ui_task");
      expect(event).toHaveBeenCalledTimes(1);
      enqueue(endpoint, Buffer.from("later"));
      expect(Buffer.concat(endpoint.takeInput().map(input => input.bytes)).toString()).toBe("later");
    } finally {
      finish?.();
      await endpoint.close();
      event.mockRestore();
    }
  }
});

test("a completed paste does not discard typing while unrelated UI work waits", async () => {
  for (const change of ["switch", "deactivate"]) {
    const endpoint = localEndpoint("/tmp/corgi-paste-complete/control.sock", new Probe(), new Host()),
      view = Reflect.get(endpoint, "view").call(endpoint);
    let ready!: () => void, finish!: () => void;
    const waiting = new Promise<void>(resolve => (ready = resolve)),
      expire = spyOn(view, "expireInput").mockImplementation(() => {
        ready();
        return new Promise<void>(resolve => (finish = resolve));
      });
    try {
      view.input_state.attached = true;
      Reflect.set(endpoint, "settled", true);
      enqueue(endpoint, Buffer.from("\x1b[200~hello\x1b[201~"));
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      await waiting;
      expect(view.input_state.paste).toBeNull();
      enqueue(endpoint, Buffer.from("later\r"));
      if (change === "switch")
        expect(Buffer.concat(endpoint.takeInput().map(input => input.bytes)).toString()).toBe("later\r");
      else {
        endpoint.deactivate();
        expect(Buffer.from(queued(endpoint)).toString()).toBe("later\r");
      }
    } finally {
      finish?.();
      await endpoint.close();
      expire.mockRestore();
    }
  }
});

test("queue overflow closes a paste whose start already reached the child", async () => {
  for (const overflow of ["normal", "held", "holding"] as const) {
    const endpoint = localEndpoint("/tmp/corgi-paste-overflow/control.sock", new Probe(), new Host());
    try {
      const view = Reflect.get(endpoint, "view").call(endpoint);
      endpoint.machine.runtime.receive(
        transport(async () => ({ ok: true })),
        {
          panes: [{ id: 1, cols: 80, rows: 24 }],
        },
      );
      const terminal = endpoint.machine.runtime.pane(1)!.terminal;
      terminal.inner.feed("\x1b[?2004h");
      view.input_state.paste = { pane: 1 };
      expect(terminal.pasteStart()).toBe(true);
      terminal.send("\x1b[200~first");
      await terminal.flush();
      terminal.send("unsent");
      if (overflow === "held") Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      endpoint.enqueue({ kind: "text", bytes: new Uint8Array(overflow === "normal" ? 1024 * 1024 + 1 : 128 * 1024) });
      if (overflow === "holding") Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      expect(endpoint.error).toBe("Input queue full; unsent input discarded");
      expect(Buffer.from(terminal.pending).toString()).toBe("\x1b[201~");
      expect(view.input_state.paste).toBeNull();
    } finally {
      await endpoint.close();
    }
  }
});

test("keys held through a reload still go after a retry or a pause", async () => {
  for (const action of ["retry", "pause"] as const) {
    const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
    try {
      enqueue(endpoint, Uint8Array.of(97));
      Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      enqueue(endpoint, Uint8Array.of(98));
      endpoint[action]();
      expect(Reflect.get(endpoint, "handoff")).toBeNull();
      expect(queued(endpoint)).toEqual([97, 98]);
    } finally {
      await endpoint.close();
    }
  }
});

test("planned reconnect input is discarded when selection changes or the hold expires", async () => {
  for (const change of ["selection", "deadline"] as const) {
    const endpoint = localEndpoint("/tmp/corgi-handoff-input/control.sock", new Probe(), new Host());
    try {
      enqueue(endpoint, Uint8Array.of(120));
      Reflect.get(endpoint, "holdHandoffInput").call(endpoint);
      if (change === "selection") endpoint.deactivate();
      else Reflect.get(endpoint, "handoff").until = 0;
      endpoint.generation++;
      endpoint.ready = true;
      Reflect.set(endpoint, "resumed", true);
      Reflect.get(endpoint, "pumpUi").call(endpoint);
      expect(Reflect.get(endpoint, "handoff")).toBeNull();
      expect(queued(endpoint)).toEqual([]);
    } finally {
      await endpoint.close();
    }
  }
});

function enqueue(endpoint: Endpoint, bytes: Uint8Array, dropped = false): void {
  for (const input of new Parser().feed(bytes)) endpoint.enqueue(input, dropped);
}
function queued(endpoint: Endpoint): number[] {
  const events: Input[] = Reflect.get(Reflect.get(endpoint, "input"), "events");
  return Array.from(Buffer.concat(events.map(input => input.bytes)));
}
