import { test, expect, setSystemTime, spyOn } from "bun:test";
import { Server } from "./server";
import * as agentModels from "./agent_models";
import { Preview } from "./launch/preview";
import { Launch, Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import * as handoff from "./persist/handoff";
import * as json from "./json";
import * as protocol from "./protocol";
import * as session from "./session";
import * as worktreeAdd from "./worktree_add";
import { n } from "./native_bridge";
import * as native_ffi from "./native_ffi";
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
      { subscribed: true, queue: (value: unknown) => first.push(value) } as any,
      { subscribed: true, queue: (value: unknown) => second.push(value) } as any,
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
    nonblock = spyOn(n, "probe_nonblock").mockReturnValue(0),
    watch = spyOn(Reflect.get(server, "loop"), "watch").mockReturnValue({ arm() {}, close() {} }),
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
    const viewer = server.addClient(-1, false);
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
    watch.mockRestore();
    nonblock.mockRestore();
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
    client = server.addClient(-1, false),
    reloader = server.addClient(-1, false),
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
    [fd, reader] = native_ffi.pair(),
    control = server.addClient(-1, false),
    data = server.addClient(fd),
    scratch = Buffer.alloc(65536);
  control.viewer = true;
  control.viewer_id = 1;
  const received: string[] = [];
  const read = () => {
    for (;;) {
      const count = native_ffi.n.probe_read(reader, native_ffi.ptr(scratch), scratch.length);
      if (count <= 0) break;
      received.push(scratch.toString("utf8", 0, count));
    }
  };
  try {
    native_ffi.n.probe_nonblock(fd);
    native_ffi.n.probe_nonblock(reader);
    await server.request(data, protocol.envelope("viewer.watch", { viewer: 1 }));
    data.queue({ request_id: 1, ok: true, data: "x".repeat(3 * 1024 * 1024) });
    expect(data.output.length).toBeGreaterThan(0);
    for (let i = 0; i < 2; i++) {
      server.runtime.refreshed();
      server.dirty = true;
      Reflect.get(server, "publish").call(server);
    }
    expect(server.dirty).toBe(false);
    while (data.output.length > 0) {
      read();
      data.flush();
    }
    read();
    const replies = received.join("").trim().split("\n").map(json.parse);
    expect(replies.map(reply => reply.type ?? reply.request_id ?? reply.ok)).toEqual([true, 1, "viewer.wake"]);
    expect(replies[1].data.length).toBe(3 * 1024 * 1024);
    received.length = 0;
    data.flush();
    server.dirty = true;
    Reflect.get(server, "publish").call(server);
    read();
    expect(received).toEqual([]);
  } finally {
    data.close();
    control.close();
    native_ffi.n.probe_close(reader);
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

test("handoff restoration normalizes small and wide viewer counters before waking", () => {
  for (const seq of [0n, 9007199254740993n]) {
    const source = fixture(),
      target = fixture();
    try {
      // Both captures record saved_at in seconds, which must not tick over between them.
      setSystemTime(new Date(1_800_000_000_000));
      const original = source.server.addClient(-1, false);
      original.viewer = true;
      original.viewer_id = 1;
      original.next_control = seq + 1n;
      original.last_control = seq;
      original.snapshot_revision = seq;
      original.controls = [{ seq, kind: "focus", id: 1 }];
      original.interests = [
        { pane: 1, cols: 80, rows: 24, offset: 2, known: { identity: seq + 1n, revision: seq, offset: 2 } },
      ];
      original.launch_preview = {
        cwd: "/",
        preview: new Preview(),
        checked: 10,
        history_asked: true,
        history_epoch: seq + 1n,
        history_sent: seq,
      };
      source.server.bell_seq = seq;
      const captured = handoff.captureManifest(source.server, original),
        bytes = json.stringify(captured),
        saved = json.parse(bytes);
      handoff.restoreMetadata(target.server, saved);
      const restored = handoff.restoreClient(target.server, saved.clients[0]);
      expect(target.server.bell_seq).toBe(seq);
      expect(restored.next_control).toBe(seq + 1n);
      expect(restored.last_control).toBe(seq);
      expect(restored.snapshot_revision).toBe(seq);
      expect(restored.controls[0].seq).toBe(seq);
      expect(restored.interests[0].known).toEqual({ identity: seq + 1n, revision: seq, offset: 2 });
      expect(restored.launch_preview?.history_epoch).toBe(seq + 1n);
      expect(restored.launch_preview?.history_sent).toBe(seq);
      expect(Reflect.get(target.server, "wakeSeq").call(target.server, 1)).toBe(
        target.server.runtime.shown + seq + seq + 1n,
      );
      expect(json.stringify(handoff.captureManifest(target.server, restored))).toBe(bytes);
    } finally {
      setSystemTime();
      source.dispose();
      target.dispose();
    }
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
      cl = server.addClient(-1, false);
    try {
      cl.pending.push(
        { op: "launcher.models", row: "codex", protocol: protocol.version },
        { op: "ping", protocol: protocol.version },
      );
      // Exercise real client dispatch while retaining queued output without a socket.
      (cl as any).paused = false;
      const flush = spyOn(cl, "flush").mockImplementation(() => {});
      (cl as any).dispatch();
      await (server as any).jobs;
      expect(cl.pending).toHaveLength(1);
      expect(cl.output.length).toBe(0);
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
      const replies = cl.output
        .toString()
        .trim()
        .split("\n")
        .map(line => JSON.parse(line));
      expect(replies[0]).toEqual(failure ? { err: "CatalogFailed" } : { ok: true, models: [] });
      expect(replies).toHaveLength(2);
      expect(replies[1].ok).toBe(true);
      expect(cl.pending).toHaveLength(0);
      flush.mockRestore();
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
    test(`handoff saves a cancelled ${request_id ? "tagged" : "untagged"} model reply and ignores late ${failure ? "failure" : "success"}`, async () => {
      const source = fixture(),
        target = fixture(),
        pending = Promise.withResolvers<agentModels.Choice[]>(),
        reader = spyOn(agentModels, "read").mockReturnValue(pending.promise),
        cl = source.server.addClient(-1, false);
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
        (cl as any).paused = false;
        spyOn(cl, "flush").mockImplementation(() => {});
        (cl as any).dispatch();
        await (source.server as any).jobs;
        source.server.pause();
        expect(reader.mock.calls[0][2].aborted).toBe(true);
        const saved = handoff.captureManifest(source.server, cl),
          restored = handoff.restoreClient(target.server, saved.clients[0]);
        expect(restored.output.toString()).toBe(JSON.stringify({ err: "Cancelled", request_id }) + "\n");
        expect(restored.pending.map(r => r.op)).toEqual(["ping"]);
        if (failure) pending.reject(Error("LateFailure"));
        else pending.resolve([{ id: "late", name: "Late" }]);
        await pending.promise.catch(() => {});
        expect(cl.output.toString()).toBe(JSON.stringify({ err: "Cancelled", request_id }) + "\n");
        // A failed handoff resumes the old client without an extra reply or a stuck busy flag.
        (cl as any).paused = false;
        (cl as any).dispatch();
        await (source.server as any).jobs;
        const replies = cl.output
          .toString()
          .trim()
          .split("\n")
          .map(line => JSON.parse(line));
        expect(replies).toHaveLength(2);
        expect(replies[1].ok).toBe(true);
        restored.close();
      } finally {
        pending.resolve([]);
        reader.mockRestore();
        cl.close();
        source.dispose();
        target.dispose();
      }
    });
  }
