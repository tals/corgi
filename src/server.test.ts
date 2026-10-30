import { test, expect, spyOn } from "bun:test";
import { Server } from "./server";
import * as agentModels from "./agent_models";
import { Preview } from "./launch/preview";
import { Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { captureManifest, restoreClient, restoreMetadata } from "./persist/handoff";
import * as json from "./json";
import * as protocol from "./protocol";
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
      const captured = captureManifest(source.server, original),
        bytes = json.stringify(captured),
        saved = json.parse(bytes);
      restoreMetadata(target.server, saved);
      const restored = restoreClient(target.server, saved.clients[0]);
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
      expect(json.stringify(captureManifest(target.server, restored))).toBe(bytes);
    } finally {
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
      reply: (_op: string, v: unknown) => messages.push(v),
      done: () => {},
    } as any;
  try {
    (server as any).enqueue(() =>
      server.request(cl, { op: "launcher.models", row: "codex", protocol: protocol.version }),
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
    expect(messages).toEqual([{ models: [{ id: "test", name: "Test" }] }]);
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
