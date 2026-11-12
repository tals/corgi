import { existsSync, mkdtempSync, rmSync } from "node:fs";
import * as wire_websocket from "./wire_websocket";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, expect, setSystemTime, spyOn } from "bun:test";
import { Server } from "./server";
import * as agentModels from "./agent_models";
import { Preview } from "./launch/preview";
import { Launch, Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import * as handoff from "./persist/handoff";
import * as handoffRollback from "./persist/handoff_rollback";
import * as json from "./json";
import * as protocol from "./protocol";
import * as session from "./session";
import * as worktreeAdd from "./worktree_add";
import * as link from "./link";
import * as client_socket from "./fixtures/client_socket";
function fixture() {
  const server = new Server("", "", "0".repeat(64));
  return {
    server,
    dispose: () => {
      server.runtime.destroy();
      (server as any).loop.close();
    },
  };
}
test("session snapshots are shared by subscribers and skipped without them", () => {
  const { server, dispose } = fixture(),
    snapshot = spyOn(session, "snapshot"),
    first: unknown[] = [],
    second: unknown[] = [];
  try {
    const publish = () => Reflect.get(server, "publish").call(server);
    publish();
    expect(snapshot).not.toHaveBeenCalled();
    server.clients.push(
      { subscribed: true, subscribed_output: true, queue: (value: unknown) => first.push(value) } as any,
      { subscribed: true, subscribed_output: true, queue: (value: unknown) => second.push(value) } as any,
    );
    server.runtime.wrote();
    publish();
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(first[0]).toBe(second[0]);
    publish();
    expect(snapshot).toHaveBeenCalledTimes(1);
    server.clients = [];
    server.runtime.wrote();
    publish();
    expect(snapshot).toHaveBeenCalledTimes(1);
  } finally {
    snapshot.mockRestore();
    dispose();
  }
});
test("a subscriber that leaves out output hears only what viewers would show changing", () => {
  const { server, dispose } = fixture(),
    snapshot = spyOn(session, "snapshot"),
    heard: unknown[] = [];
  try {
    const publish = () => Reflect.get(server, "publish").call(server);
    server.clients.push({ subscribed: true, subscribed_output: false, queue: (v: unknown) => heard.push(v) } as any);
    server.runtime.refreshed();
    publish();
    expect(heard).toHaveLength(1);
    server.runtime.wrote();
    publish();
    expect(heard).toHaveLength(1);
    server.runtime.changed();
    publish();
    expect(heard).toHaveLength(2);
  } finally {
    snapshot.mockRestore();
    dispose();
  }
});
test("publishing agent entries preserves request order without snapshot subscribers", () => {
  const { server, dispose } = fixture(),
    snapshot = spyOn(session, "snapshot"),
    workspace = new Workspace(1, "/tmp"),
    publish = () => Reflect.get(server, "publish").call(server),
    output: unknown[] = [];
  server.runtime.workspaces.items.push(workspace);
  const panes = ["first", "second"].map(title => {
    const id = workspace.model.newTab(title),
      pane = new Pane(id, new Terminal(20, 4), "/tmp");
    server.runtime.panes.push(pane);
    return pane;
  });
  const ordered = () =>
    workspace.agent_order
      .slice()
      .filter(target => "pane" in target && server.runtime.pane(target.pane)!.agent().provider);
  try {
    publish();
    // Hook requests arrive in the reverse of tab order, before any daemon tick.
    for (const pane of panes.toReversed()) {
      pane.agent().provider = "claude";
      pane.agent().state = "working";
      server.runtime.changed();
      const before = server.runtime.revision;
      publish();
      expect(ordered()[0]).toEqual({ pane: pane.id });
      expect(server.runtime.revision).toBe(before + 1n);
      publish();
      expect(server.runtime.revision).toBe(before + 1n);
      expect(snapshot).not.toHaveBeenCalled();
    }
    expect(ordered()).toEqual(panes.map(pane => ({ pane: pane.id })));
    expect(panes.map(pane => workspace.model.tabForPane(pane.id))).toEqual([0, 1]);

    server.clients.push({ subscribed: true, queue: (value: unknown) => output.push(value) } as any);
    panes[0].agent().state = "idle";
    panes[0].agent().attention = "finished";
    server.runtime.changed();
    const before = server.runtime.revision;
    publish();
    expect(server.runtime.revision).toBe(before + 1n);
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(output).toHaveLength(1);
    publish();
    expect(server.runtime.revision).toBe(before + 1n);
    expect(snapshot).toHaveBeenCalledTimes(1);
  } finally {
    snapshot.mockRestore();
    dispose();
  }
});
test("publishing resolves relative launch accounts before the pane changes directory", () => {
  const { server, dispose } = fixture(),
    snapshot = spyOn(session, "snapshot"),
    workspace = new Workspace(1, "/a"),
    pane = new Pane(workspace.model.newTab("custom agent"), new Terminal(20, 4), "/a"),
    publish = () => Reflect.get(server, "publish").call(server);
  server.runtime.workspaces.items.push(workspace);
  server.runtime.panes.push(pane);
  pane.launch = new Launch(undefined, "CLAUDE_CONFIG_DIR=acct claude");
  try {
    publish();
    pane.cwd = "/b";
    expect(pane.account()).toBe("/a/acct");
    expect(new Launch(undefined, "CLAUDE_CONFIG_DIR=acct claude").account("claude", pane.cwd)).toBe("/b/acct");
    server.runtime.changed();
    publish();
    expect(pane.account()).toBe("/a/acct");
    expect(snapshot).not.toHaveBeenCalled();
  } finally {
    snapshot.mockRestore();
    dispose();
  }
});
test("idle collection uses elapsed time and still collects on the first timer tick", async () => {
  const { server, dispose } = fixture();
  let tick: () => void = () => {
    throw Error("CollectionTimerNotInstalled");
  };
  const monotonic = spyOn(performance, "now").mockReturnValue(0),
    wall = spyOn(Date, "now").mockReturnValue(10000),
    collect = spyOn(server as any, "collect").mockResolvedValue(undefined),
    interval = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      tick = callback;
      return 0;
    }) as typeof setInterval);
  try {
    server.dirty = false;
    Reflect.get(server, "startLoop").call(server);
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(1);

    monotonic.mockReturnValue(249);
    wall.mockReturnValue(5000);
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(1);
    monotonic.mockReturnValue(250);
    wall.mockReturnValue(1000);
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(2);

    monotonic.mockReturnValue(251);
    server.dirty = true;
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(3);

    // A pending bell doesn't wait for the idle cadence.
    server.dirty = false;
    monotonic.mockReturnValue(300);
    server.bell = true;
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(4);
    server.bell = false;
    // An attached viewer's launcher subscription waits unless it has news.
    const viewer = server.addClient(null, false);
    viewer.launch_preview = {
      cwd: "/",
      preview: new Preview(),
      checked: 0,
      history_asked: false,
      history_epoch: 0n,
      history_sent: 0n,
    };
    monotonic.mockReturnValue(350);
    tick();
    await Reflect.get(server, "jobs");
    expect(collect).toHaveBeenCalledTimes(4);
  } finally {
    interval.mockRestore();
    collect.mockRestore();
    wall.mockRestore();
    monotonic.mockRestore();
    dispose();
  }
});
test("a viewer's protocol version is checked before its request is decoded", async () => {
  const { server, dispose } = fixture(),
    messages: any[] = [];
  try {
    const cl = { protocol_version: null, queue: (value: any) => messages.push(value) } as any;
    const { version, viewer_version } = protocol;
    await server.request(cl, {
      op: "viewer.sync",
      protocol: version,
      viewer_protocol: viewer_version + 1,
      interests: "x",
    });
    expect(messages).toEqual([{ err: "UnsupportedViewerProtocol", viewer_protocol: viewer_version }]);
    await expect(
      server.request(cl, { op: "viewer.sync", protocol: version, viewer_protocol: viewer_version, interests: "x" }),
    ).rejects.toThrow("UnexpectedToken");
  } finally {
    dispose();
  }
});
test("one client's or pane's error must not end the daemon loop", async () => {
  const { server, dispose } = fixture(),
    report = spyOn(console, "error").mockImplementation(() => {}),
    ran: string[] = [];
  try {
    (server as any).enqueue(async () => {
      ran.push("failed");
      throw Error("DisconnectedClient");
    });
    (server as any).enqueue(async () => {
      ran.push("next client");
    });
    await (server as any).jobs;
    expect(ran).toEqual(["failed", "next client"]);
    expect(report).toHaveBeenCalledTimes(1);
  } finally {
    report.mockRestore();
    dispose();
  }
});
test("a cancelled branch read cannot release a later request when it finishes", async () => {
  const { server, dispose } = fixture(),
    client = server.addClient(null, false),
    reloader = server.addClient(null, false),
    first = Promise.withResolvers<Awaited<ReturnType<typeof worktreeAdd.branches>>>(),
    second = Promise.withResolvers<Awaited<ReturnType<typeof worktreeAdd.branches>>>(),
    branches = spyOn(worktreeAdd, "branches").mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise),
    replace = spyOn(handoff, "replace").mockRejectedValue(Error("ReloadCandidateFailed")),
    replies = spyOn(client, "queue").mockImplementation(() => {}),
    done = spyOn(client, "done").mockImplementation(() => {}),
    query = protocol.envelope("git.branches", { workspace: 1 });
  try {
    await server.request(client, query);
    expect(client.held).toBe(true);
    await expect(
      server.request(reloader, protocol.envelope("server.reload", { executable: "/missing-corgi" })),
    ).rejects.toThrow("ReloadCandidateFailed");
    expect(replies.mock.calls).toEqual([[{ err: "Reloading" }]]);
    expect(client.held).toBe(false);
    expect(done).toHaveBeenCalledTimes(1);

    await server.request(client, query);
    expect(client.held).toBe(true);
    first.resolve([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(client.held).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    expect(replies).toHaveBeenCalledTimes(1);

    second.resolve([]);
    await new Promise(resolve => setImmediate(resolve));
    expect(client.held).toBe(false);
    expect(done).toHaveBeenCalledTimes(2);
    expect(replies.mock.calls).toEqual([[{ err: "Reloading" }], [{ ok: true, branches: [] }]]);
  } finally {
    first.resolve([]);
    second.resolve([]);
    await new Promise(resolve => setImmediate(resolve));
    branches.mockRestore();
    replace.mockRestore();
    replies.mockRestore();
    done.mockRestore();
    dispose();
  }
});
test("a buffered data reply delivers the latest wake when it drains", async () => {
  const { server, dispose } = fixture(),
    socket = new client_socket.Recorder(),
    control = server.addClient(null, false),
    data = server.addClient(socket);
  control.viewer = true;
  control.viewer_id = 1;
  try {
    await server.request(data, protocol.envelope("viewer.watch", { viewer: 1 }));
    data.queue({ request_id: 1, ok: true, data: "x".repeat(3 * 1024 * 1024) });
    // The socket hasn't written it yet.
    socket.buffered = 3 * 1024 * 1024;
    for (let i = 0; i < 2; i++) {
      server.runtime.refreshed();
      server.dirty = true;
      Reflect.get(server, "publish").call(server);
    }
    expect(server.dirty).toBe(false);
    expect(socket.lines().map(reply => reply.type ?? reply.request_id ?? reply.ok)).toEqual([true, 1]);
    socket.buffered = 0;
    data.flushed();
    const replies = socket.lines();
    expect(replies.map(reply => reply.type ?? reply.request_id ?? reply.ok)).toEqual([true, 1, "viewer.wake"]);
    expect(replies[1].data.length).toBe(3 * 1024 * 1024);
    data.flushed();
    server.dirty = true;
    Reflect.get(server, "publish").call(server);
    expect(socket.lines()).toHaveLength(3);
  } finally {
    data.close();
    control.close();
    dispose();
  }
});
test("attention prioritizes input within a burst and releases the next completion", () => {
  const { server, dispose } = fixture();
  try {
    server.attention(true, "blocked");
    server.attention(true, "idle");
    (server as any).flushBell(2000);
    expect(server.bell_seq).toBe(1n);
    expect(server.last_bell_kind).toBe("needs_input");
    expect(server.bell_kind).toBe("none");
    const actor = server.runtime.conversations.get("codex", "session");
    actor.state.observation.completed = 1n;
    server.attention(true, "idle");
    (server as any).flushBell(3000);
    expect(server.bell_seq).toBe(1n);
    (server as any).flushBell(3501);
    expect(server.bell_seq).toBe(2n);
    expect(server.last_bell_kind).toBe("finished");
    server.attention(true, "idle");
    actor.state.observation.read = 1n;
    (server as any).flushBell(5500);
    expect(server.bell_seq).toBe(2n);
    expect(server.bell).toBe(false);
  } finally {
    dispose();
  }
});

test("input sent into a pane counts as work in it, as a focused viewer's does", () => {
  const { server, dispose } = fixture();
  try {
    const pane = new Pane(1, new Terminal(20, 4), "/tmp");
    server.runtime.panes.push(pane);
    expect(server.inputAt(1)).toBe(0);
    // As `corgi pane send` types a prompt, with no viewer about.
    const before = Date.now();
    pane.terminal.send("again\r");
    expect(server.inputAt(1)).toBeGreaterThanOrEqual(before);
    server.clients.push({ viewer: true, dead: false, view_focus: 1, input_at: before + 60_000 } as any);
    expect(server.inputAt(1)).toBe(before + 60_000);
  } finally {
    dispose();
  }
});
test("provisional pane completions ring until their receipts are read", () => {
  const { server, dispose } = fixture();
  try {
    const pane = new Pane(1, new Terminal(20, 4), "/tmp");
    server.runtime.panes.push(pane);
    pane.agent().observation.finish("completed", "screen");
    server.attention(true, "idle");
    (server as any).flushBell(2000);
    expect(server.bell_seq).toBe(1n);
    expect(server.last_bell_kind).toBe("finished");
    pane.releaseDetection();
    expect(pane.agent().observation.unread()).toBe(true);
    pane.agent().acknowledge();
    server.attention(true, "idle");
    (server as any).flushBell(4000);
    expect(server.bell_seq).toBe(1n);
    expect(server.bell).toBe(false);
  } finally {
    dispose();
  }
});

test("a handoff keeps a connected viewer in its link, with small and wide counters", async () => {
  for (const seq of [0n, 9007199254740993n]) {
    const source = fixture(),
      target = fixture();
    try {
      const original = source.server.addClient(null, false);
      spyOn(original, "queue").mockImplementation(() => {});
      await source.server.request(original, { op: "link.open", protocol: protocol.version });
      Object.assign(original, { viewer: true, viewer_id: 1, active_seq: 3, view_workspace: 2 });
      original.next_control = seq + 1n;
      original.last_control = seq;
      original.controls = [{ seq, kind: "focus", id: 1 }];
      source.server.bell_seq = seq;
      const captured = handoff.captureManifest(source.server),
        saved = json.parse(json.stringify(captured));
      expect(Object.keys(saved)).not.toContain("clients");
      expect(original.link?.detached_at).toBeNull();
      handoff.restoreMetadata(target.server, saved);
      expect(target.server.instance).toBe(source.server.instance);
      expect(target.server.bell_seq).toBe(seq);
      const resumed = target.server.addClient(null, false),
        replies: any[] = [];
      spyOn(resumed, "queue").mockImplementation(value => void replies.push(value));
      await target.server.request(resumed, { op: "link.resume", protocol: protocol.version, link: original.link!.id });
      expect(replies[0]).toMatchObject({ ok: true, viewer: true });
      expect([resumed.viewer_id, resumed.active_seq, resumed.view_workspace]).toEqual([1, 3, 2]);
      expect([resumed.next_control, resumed.last_control]).toEqual([seq + 1n, seq]);
      expect(resumed.controls).toEqual([{ seq, kind: "focus", id: 1 }]);
    } finally {
      source.dispose();
      target.dispose();
    }
  }
});
test("model requests use their workspace or cwd and keep legacy requests valid", async () => {
  const { server, dispose } = fixture(),
    messages: unknown[] = [],
    reader = spyOn(agentModels, "read").mockImplementation(async (_provider, _account, _quit, cwd) => [
      { id: cwd!, name: "Workspace model" },
    ]),
    cl = { protocol_version: null, queue: (value: unknown) => messages.push(value), done: () => {} } as any;
  server.runtime.workspaces.items.push(new Workspace(1, "/workspace"));
  try {
    for (const [context, cwd] of [
      [{ workspace: 1 }, "/workspace"],
      [{ workspace: 1, cwd: "/worktree" }, "/worktree"],
      [{ cwd: "/outside" }, "/outside"],
      [{}, process.cwd()],
    ] as const) {
      await server.request(cl, { op: "launcher.models", row: "pi", protocol: protocol.version, ...context });
      await Bun.sleep(0);
      expect(reader.mock.calls.at(-1)?.[3]).toBe(cwd);
      expect(messages.at(-1)).toEqual({ ok: true, models: [{ id: cwd, name: "Workspace model" }] });
    }
    await expect(
      server.request(cl, { op: "launcher.models", row: "pi", cwd: "relative", protocol: protocol.version }),
    ).rejects.toThrow("InvalidDirectory");
    expect(reader).toHaveBeenCalledTimes(4);
  } finally {
    reader.mockRestore();
    dispose();
  }
});

test("a model read doesn't hold its connection, and requests for the same list share it", async () => {
  const { server, dispose } = fixture(),
    pending = Promise.withResolvers<agentModels.Choice[]>(),
    reader = spyOn(agentModels, "read").mockReturnValue(pending.promise),
    socket = new client_socket.Recorder(),
    cl = server.addClient(socket, false);
  try {
    cl.pending.push(
      { op: "launcher.models", row: "codex", protocol: protocol.version, request_id: 17 },
      { op: "launcher.models", row: "codex", protocol: protocol.version, request_id: 18 },
      { op: "ping", protocol: protocol.version, request_id: 19 },
    );
    cl.resume();
    for (let i = 0; i < 3; i++) await (server as any).jobs;
    expect(socket.lines()).toEqual([{ ok: true, pid: process.pid, request_id: 19 }]);
    expect(reader).toHaveBeenCalledTimes(1);
    pending.resolve([{ id: "gpt", name: "GPT" }]);
    await Bun.sleep(0);
    expect(socket.lines().slice(1)).toEqual([
      { ok: true, models: [{ id: "gpt", name: "GPT" }], request_id: 17 },
      { ok: true, models: [{ id: "gpt", name: "GPT" }], request_id: 18 },
    ]);
  } finally {
    pending.resolve([]);
    reader.mockRestore();
    cl.close();
    dispose();
  }
});

test("pending model discovery releases the shared request queue", async () => {
  const { server, dispose } = fixture(),
    messages: unknown[] = [],
    pending = Promise.withResolvers<agentModels.Choice[]>(),
    reader = spyOn(agentModels, "read").mockReturnValue(pending.promise),
    cl = {
      protocol_version: null,
      queue: (v: unknown) => messages.push(v),
      done: () => {},
    } as any;
  try {
    (server as any).enqueue(() =>
      server.request(cl, { op: "launcher.models", row: "codex", protocol: protocol.version, request_id: 17 }),
    );
    let serviced = false;
    (server as any).enqueue(async () => {
      serviced = true;
    });
    await Promise.race([(server as any).jobs, Bun.sleep(100)]);
    expect(serviced).toBe(true);
    expect(messages).toEqual([]);
    pending.resolve([{ id: "test", name: "Test" }]);
    await (server as any).jobs;
    await pending.promise;
    await Bun.sleep(0);
    expect(messages).toEqual([{ ok: true, models: [{ id: "test", name: "Test" }], request_id: 17 }]);
  } finally {
    pending.resolve([]);
    await (server as any).jobs;
    reader.mockRestore();
    dispose();
  }
});

for (const failure of [false, true]) {
  test(`model discovery preserves pipelined reply order on ${failure ? "failure" : "success"}`, async () => {
    const { server, dispose } = fixture(),
      pending = Promise.withResolvers<agentModels.Choice[]>(),
      reader = spyOn(agentModels, "read").mockReturnValue(pending.promise),
      socket = new client_socket.Recorder(),
      cl = server.addClient(socket, false);
    try {
      cl.pending.push(
        { op: "launcher.models", row: "codex", protocol: protocol.version },
        { op: "ping", protocol: protocol.version },
      );
      cl.resume();
      await (server as any).jobs;
      expect(cl.pending).toHaveLength(1);
      expect(socket.sent).toHaveLength(0);
      let serviced = false;
      (server as any).enqueue(async () => {
        serviced = true;
      });
      await (server as any).jobs;
      expect(serviced).toBe(true);
      if (failure) pending.reject(Error("CatalogFailed"));
      else pending.resolve([]);
      await pending.promise.catch(() => {});
      await Bun.sleep(0);
      await (server as any).jobs;
      const replies = socket.lines();
      expect(replies[0]).toEqual(failure ? { err: "CatalogFailed" } : { ok: true, models: [] });
      expect(replies).toHaveLength(2);
      expect(replies[1].ok).toBe(true);
      expect(cl.pending).toHaveLength(0);
    } finally {
      pending.resolve([]);
      await (server as any).jobs;
      reader.mockRestore();
      cl.close();
      dispose();
    }
  });
}

for (const request_id of [undefined, 41])
  for (const failure of [false, true]) {
    test(`a handoff cancels a ${request_id ? "tagged" : "untagged"} model read and ignores its late ${failure ? "failure" : "success"}`, async () => {
      const { server, dispose } = fixture(),
        pending = Promise.withResolvers<agentModels.Choice[]>(),
        reader = spyOn(agentModels, "read").mockReturnValue(pending.promise),
        socket = new client_socket.Recorder(),
        cl = server.addClient(socket, false);
      try {
        cl.pending.push(
          {
            op: "launcher.models",
            row: "codex",
            protocol: protocol.version,
            ...(request_id === undefined ? {} : { request_id }),
          },
          { op: "ping", protocol: protocol.version },
        );
        cl.resume();
        await (server as any).jobs;
        server.pause();
        expect(reader.mock.calls[0][2].aborted).toBe(true);
        await Bun.sleep(0);
        const errors = () => socket.lines().filter(r => !r.ok);
        expect(errors()).toEqual([{ err: "Cancelled", request_id }]);
        if (failure) pending.reject(Error("LateFailure"));
        else pending.resolve([{ id: "late", name: "Late" }]);
        await pending.promise.catch(() => {});
        await Bun.sleep(0);
        expect(errors()).toEqual([{ err: "Cancelled", request_id }]);
        // A failed handoff resumes the client without an extra reply or a stuck busy flag.
        cl.resume();
        await (server as any).jobs;
        await Bun.sleep(0);
        await (server as any).jobs;
        const replies = socket.lines();
        expect(replies).toHaveLength(2);
        expect(replies.filter(r => r.ok)).toHaveLength(1);
      } finally {
        pending.resolve([]);
        reader.mockRestore();
        cl.close();
        dispose();
      }
    });
  }

test("startup waits are shared, cancellable, and removed when their reporter disconnects", async () => {
  const { server, dispose } = fixture(),
    messages: any[] = [],
    client = { dead: false, protocol_version: null, queue: (v: unknown) => messages.push(v) } as any,
    pane = new Pane(1, new Terminal(80, 24), "/tmp"),
    request = {
      id: "launch-1",
      pane: 1,
      provider: "opencode2" as const,
      phase: "service" as const,
      detail: "",
      started_at: Date.now(),
    };
  server.runtime.panes.push(pane);
  server.clients.push(client);
  const workspace = new Workspace(1, "/tmp");
  workspace.model.newTab("test");
  server.runtime.workspaces.items.push(workspace);
  try {
    await server.request(client, protocol.envelope("startup", request));
    expect(messages.at(-1)).toEqual({ ok: true, cancelled: false });
    expect(session.snapshot(server.runtime).startup_waits).toHaveLength(1);
    expect(session.viewerSnapshot(server.runtime).startup_waits).toHaveLength(1);
    await server.request(
      client,
      protocol.envelope("startup", { ...request, phase: "installing", detail: "mise downloading" }),
    );
    expect(server.runtime.startup_waits[0].phase).toBe("installing");
    await server.request(client, protocol.envelope("startup.kill", { id: "launch-1" }));
    await server.request(client, protocol.envelope("startup", request));
    expect(messages.at(-1)).toEqual({ ok: true, cancelled: true });
    expect(server.runtime.startup_waits[0].started_at).toBe(request.started_at);
    client.dead = true;
    Reflect.get(server, "collectStartups").call(server);
    expect(server.runtime.startup_waits).toEqual([]);
    await expect(server.request(client, protocol.envelope("startup.kill", { id: "launch-1" }))).rejects.toThrow(
      "NoProcess",
    );
  } finally {
    dispose();
  }
});

test("a numbered command sent again over a link gets its reply without running twice", async () => {
  const { server, dispose } = fixture();
  // The new workspace is saved; keep it out of the user's state.
  const state = mkdtempSync(join(tmpdir(), "corgi-link-state-")),
    env = process.env.CORGI_ENV_DIR;
  process.env.CORGI_ENV_DIR = state;
  try {
    const cl = server.addClient(null, false),
      queued = spyOn(cl, "queue");
    await server.request(cl, { op: "link.open", protocol: protocol.version });
    const link = cl.link!;
    const create = {
      op: "session.command",
      protocol: protocol.version,
      command: { "workspace.create": { name: "b", cwd: "/tmp" } },
    };
    const before = server.runtime.workspaces.items.length;
    await (server as any).once(cl, link, 1n, { ...create, request_id: 10 });
    await (server as any).once(cl, link, 1n, { ...create, request_id: 20 });
    const replies = queued.mock.calls.map(([value]) => value) as any[];
    expect(server.runtime.workspaces.items.length).toBe(before + 1);
    expect(replies[2]).toEqual({ ...replies[1], request_id: 20 });
    expect(replies[1].request_id).toBe(10);
    expect(replies[1].ok).toBe(true);
  } finally {
    await (server as any).workspaceWrites;
    if (env === undefined) delete process.env.CORGI_ENV_DIR;
    else process.env.CORGI_ENV_DIR = env;
    dispose();
    rmSync(state, { recursive: true, force: true });
  }
});

test("resuming a link brings its viewer back and takes it from a connection that still held it", async () => {
  const { server, dispose } = fixture();
  try {
    const old = server.addClient(null, false),
      next = server.addClient(null, false),
      replies: any[] = [];
    spyOn(old, "queue").mockImplementation(() => {});
    spyOn(next, "queue").mockImplementation(value => void replies.push(value));
    await server.request(old, { op: "link.open", protocol: protocol.version });
    Object.assign(old, { viewer: true, viewer_id: 5, active_seq: 2, next_control: 4n, last_control: 1n });
    old.controls = [{ seq: 3n, kind: "focus", id: 1 }];
    await server.request(next, { op: "link.resume", protocol: protocol.version, link: old.link!.id });
    expect(replies[0]).toEqual({ ok: true, link: next.link!.id, viewer: true });
    expect(old.dead).toBe(true);
    expect([next.viewer, next.viewer_id, next.next_control, next.last_control]).toEqual([true, 5, 4n, 1n]);
    expect(next.controls).toEqual([{ seq: 3n, kind: "focus", id: 1 }]);
    await expect(server.request(next, { op: "link.resume", protocol: protocol.version, link: "gone" })).rejects.toThrow(
      "NoLink",
    );
  } finally {
    dispose();
  }
});

test("a link no connection comes back for is dropped after its grace", async () => {
  const { server, dispose } = fixture();
  try {
    const cl = server.addClient(null, false);
    spyOn(cl, "queue").mockImplementation(() => {});
    await server.request(cl, { op: "link.open", protocol: protocol.version });
    const id = cl.link!.id;
    cl.close();
    expect(server.links.get(id)?.detached_at).not.toBeNull();
    const detached = server.links.get(id)!.detached_at!;
    (server as any).expireLinks(detached + 60_000);
    expect(server.links.has(id)).toBe(true);
    (server as any).expireLinks(detached + 11 * 60_000);
    expect(server.links.has(id)).toBe(false);
  } finally {
    dispose();
  }
});

test("deferred checkout requests cannot record a synthetic replay success", async () => {
  const { server, dispose } = fixture();
  const cl = server.addClient(null, false),
    queued = spyOn(cl, "queue");
  try {
    await server.request(cl, { op: "link.open", protocol: protocol.version });
    const request = {
      op: "worktree.add",
      protocol: protocol.version,
      workspace: 1,
      path: "/not-created",
      branch: "topic",
      base: "main",
    };
    expect(protocol.once("worktree.add")).toBe(false);
    await (server as any).once(cl, cl.link!, 1n, request);
    await (server as any).once(cl, cl.link!, 1n, request);
    expect(queued.mock.calls.slice(1).map(([value]) => value)).toEqual([
      { err: "UnnumberedOperation" },
      { err: "UnnumberedOperation" },
    ]);
  } finally {
    cl.close();
    dispose();
  }
});

test("a handoff carries links and its requester, never connections", () => {
  const { server, dispose } = fixture();
  const viewer = server.addClient(new client_socket.Recorder(), false),
    carried = new link.Link(),
    waiting = new link.Link();
  server.links.set(carried.id, carried);
  server.links.set(waiting.id, waiting);
  viewer.link = carried;
  Object.assign(viewer, { viewer: true, viewer_id: 7 });
  try {
    const saved = handoff.captureManifest(server, 12, 41);
    expect(saved).not.toHaveProperty("clients");
    expect(saved).not.toHaveProperty("listener");
    expect([saved.requester, saved.request_id]).toEqual([12, 41]);
    const [first, second] = saved.links;
    expect([first.id, first.viewer?.viewer_id, first.detached_at !== null]).toEqual([carried.id, 7, true]);
    expect([second.id, second.viewer, second.detached_at]).toEqual([waiting.id, null, null]);
    // The capture leaves the live link as it was, in case the candidate fails.
    expect([carried.detached_at, carried.viewer]).toEqual([null, null]);
  } finally {
    viewer.close();
    dispose();
  }
});
test("a format-6 rollback gets a listener and its requester as a client, without links", () => {
  const { server, dispose } = fixture();
  server.links.set("kept", new link.Link("kept"));
  try {
    const saved = handoff.captureManifest(server, 12, null, -1, true),
      before = json.stringify(saved);
    expect(saved.older_updater).toBe(true);
    const older = handoffRollback.downgrade(saved, 9);
    expect([older.version, older.listener, older.requester]).toEqual([6, 9, 12]);
    expect(older.clients.map(client => [client.fd, client.viewer])).toEqual([[12, false]]);
    expect(older).not.toHaveProperty("links");
    expect(older).not.toHaveProperty("instance");
    expect(older).not.toHaveProperty("older_updater");
    expect(json.stringify(saved)).toBe(before);
    expect(() => handoffRollback.downgrade({ ...saved, version: 8 }, 9)).toThrow("UnsupportedStateVersion");
    expect(() => handoffRollback.downgrade({ ...saved, runtime: { ...saved.runtime, version: 7 } }, 9)).toThrow(
      "UnsupportedStateVersion",
    );
    expect(handoffRollback.supported(Error("UnsupportedStateVersion"))).toBe(true);
    expect(handoffRollback.supported(Error("InvalidCheckpoint"))).toBe(false);
  } finally {
    dispose();
  }
});
test("a daemon that handed off never takes the socket back", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-handed-")),
    socket = join(directory, "s"),
    server = new Server(socket, "", "0".repeat(64));
  try {
    server.bind();
    server.handed_off = true;
    // An older updater's window ending after the handoff.
    Reflect.get(server, "serve").call(server);
    expect(existsSync(socket)).toBe(false);
  } finally {
    server.unbind();
    server.runtime.destroy();
    Reflect.get(server, "loop").close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("shutdown tells a viewer there's nothing to reconnect to, unless a reload handed over, and a request why", async () => {
  for (const handed_off of [false, true]) {
    const directory = mkdtempSync(join(tmpdir(), "corgi-shutdown-")),
      server = new Server(join(directory, "s"), "", "0".repeat(64)),
      closed: (number | undefined)[] = [],
      queued: object[] = [];
    const client = (http: boolean) =>
      ({
        http,
        dead: false,
        close: (code?: number) => closed.push(code),
        queue: (value: object) => queued.push(value),
      }) as never;
    try {
      server.handed_off = handed_off;
      server.clients.push(client(false), client(true));
      await server.shutdown();
      expect(closed).toEqual([handed_off ? wire_websocket.reloading : wire_websocket.shutting_down]);
      expect(queued).toEqual([{ err: "ServerShutdown" }]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
test("shutdown stops a model read still running, so its agent's CLI doesn't outlive the daemon", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-models-")),
    server = new Server(join(directory, "s"), "", "0".repeat(64)),
    reader = spyOn(agentModels, "read").mockImplementation(
      (_provider, _account, quit) =>
        new Promise(resolve => quit.abortSignal.addEventListener("abort", () => resolve([]))),
    ),
    cl = server.addClient(new client_socket.Recorder(), false);
  try {
    cl.pending.push({ op: "launcher.models", row: "codex", protocol: protocol.version, request_id: 17 });
    cl.resume();
    for (let i = 0; i < 3; i++) await (server as any).jobs;
    const quit = reader.mock.calls[0]![2];
    expect(quit.aborted).toBe(false);
    await server.shutdown();
    expect(quit.aborted).toBe(true);
  } finally {
    reader.mockRestore();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("shutdown stops a server a handoff bound that never took the socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "corgi-bound-")),
    server = new Server(join(directory, "s"), "", "0".repeat(64)),
    bound = join(directory, `.${process.pid}`);
  try {
    server.bind();
    expect(existsSync(bound)).toBe(true);
    await server.shutdown();
    expect(existsSync(bound)).toBe(false);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
