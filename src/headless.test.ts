import { test, expect } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session, finishStarts, request } from "./headless";
import type { Server } from "./server";
import type { Client as Peer } from "./peer";
import { Snapshot } from "./providers/snapshot";
import { Text } from "./providers/common";
import { Registry } from "./conversations";
import { clone } from "./json";
import { Tokens } from "./usage/live";
import { Stdio } from "./providers/stdio";
import { Codex } from "./providers/codex/headless";
import type { Client, Event, Input, Saved } from "./providers/adapter";
/** A client that plays back the events a test gives it. */
class Fake implements Client {
  ready = true;
  closed = false;
  sent: Input[] = [];
  queued: Event[] = [];
  send(input: Input) {
    this.sent.push(input);
  }
  take() {
    return this.queued.splice(0);
  }
  async wait() {}
  close() {
    this.closed = true;
  }
  save(): Saved {
    return { state: null, handles: [] };
  }
}
function session(provider: "codex" | "claude" = "codex") {
  return new Session(1, provider, "/tmp", new Fake());
}
function start(s: Session, registry: Registry, thread: string, turn: string) {
  return s.apply(registry, { kind: "turn", session: thread, turn, phase: "started" });
}
function finish(s: Session, registry: Registry, thread: string, turn: string) {
  return s.apply(registry, { kind: "turn", session: thread, turn, phase: "ended", outcome: "completed" });
}
function shown(
  s: Session,
  registry: Registry,
  thread: string,
  parent: string | null = null,
  role: string | null = null,
) {
  s.apply(registry, { kind: "conversation", session: thread, parent, role, shown: !parent });
}
const approval = (session: string, id: string): Event => ({
  kind: "request",
  session,
  id,
  ask: { tool: true, name: "item/commandExecution/requestApproval", summary: "" },
});
test("headless conversations retain independent turns and receipts across selection", () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  start(s, registry, "a", "a1");
  shown(s, registry, "b");
  start(s, registry, "b", "b1");
  const first = registry.find("codex", "a")!,
    second = registry.find("codex", "b")!;
  expect(s.attachment.actor).toBe(second);
  expect(finish(s, registry, "a", "a1")).toBe(true);
  expect(s.attachment.actor).toBe(second);
  expect(second.state.state).toBe("working");
  expect(first.state.observation.completed).toBe(1n);
  expect(s.status()).toBe("working");
  expect(finish(s, registry, "a", "a1")).toBe(false);
  expect(s.observation().completed).toBe(1n);
  s.acknowledge();
  expect(first.state.observation.unread()).toBe(false);
});
test("headless approval replies target their original conversation and duplicates stay singular", () => {
  const registry = new Registry(),
    s = session();
  s.apply(registry, approval("a", "9"));
  s.apply(registry, approval("a", "9"));
  expect(s.approvals.length).toBe(1);
  shown(s, registry, "b");
  s.apply(registry, approval("b", "10"));
  s.send({ kind: "answer", request: "9", allow: true });
  expect((s.client as Fake).sent).toEqual([{ kind: "answer", request: "9", allow: true, message: undefined }]);
  expect(registry.find("codex", "a")!.state.state).toBe("working");
  expect(registry.find("codex", "b")!.state.state).toBe("blocked");
  expect(s.attention()).toBe("needs_input");
  expect(s.pendingRequests().map(r => [r.id, r.session])).toEqual([["10", "b"]]);
  expect(() => s.send({ kind: "prompt" })).toThrow("InvalidMessage");
  expect(() => s.send({ id: 9, result: {} })).toThrow("InvalidMessage");
});
test("requests on two sessions retain actor attention until both are resolved or disconnected", () => {
  const registry = new Registry(),
    first = session(),
    second = session();
  first.apply(registry, approval("a", "1"));
  second.apply(registry, approval("a", "2"));
  const actor = registry.find("codex", "a")!;
  expect(actor.pending_headless_requests).toBe(2);
  first.send({ kind: "answer", request: "1", allow: true });
  expect(actor.pending_headless_requests).toBe(1);
  expect(actor.state.attention).toBe("needs_input");
  second.markExited();
  expect(actor.pending_headless_requests).toBe(0);
  expect(actor.state.attention).toBe("none");
});
test("a live checkpoint keeps each request with its conversation", () => {
  const registry = new Registry(),
    s = session();
  s.apply(registry, approval("a", "9"));
  const restored = Session.restore(clone(s.capture(true)), registry, true);
  expect(restored.client).toBeInstanceOf(Codex);
  expect(restored.pendingRequests()).toEqual([{ id: "9", session: "a", ask: (approval("a", "9") as any).ask }]);
  expect(registry.find("codex", "a")!.pending_headless_requests).toBe(2);
});
test("headless duplicate sources share receipts and stale completions preserve the newer turn", () => {
  const registry = new Registry(),
    first = session(),
    second = session();
  start(first, registry, "a", "a1");
  start(second, registry, "a", "a1");
  expect(finish(first, registry, "a", "a1")).toBe(true);
  expect(finish(second, registry, "a", "a1")).toBe(false);
  start(first, registry, "a", "a2");
  expect(finish(second, registry, "a", "a1")).toBe(false);
  expect(registry.find("codex", "a")!.state.turnId()).toBe("a2");
  expect(registry.find("codex", "a")!.state.state).toBe("working");
});
test("turns without IDs deduplicate their end until the next activity", () => {
  const registry = new Registry(),
    s = session("claude");
  s.apply(registry, { kind: "turn", session: "a", turn: "", phase: "started" });
  const ended: Event = { kind: "turn", session: "a", turn: "", phase: "ended", outcome: "completed" };
  expect(s.apply(registry, ended)).toBe(true);
  expect(s.apply(registry, ended)).toBe(false);
  expect(s.observation().completed).toBe(1n);
});
test("headless children retain parent selection and own usage across duplicate sources", () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "parent");
  shown(s, registry, "child", "parent", "Explorer");
  const parent = registry.find("codex", "parent")!,
    child = registry.find("codex", "child")!;
  expect(s.attachment.actor).toBe(parent);
  expect(child.parent).toBe(parent.id);
  expect(child.role.text()).toBe("Explorer");
  start(s, registry, "child", "work");
  const usage: Event = {
    kind: "usage",
    session: "child",
    turn: "work",
    total: {
      total: new Tokens({ input: 1200n, cached_input: 850n, output: 120n }),
      last: new Tokens({ input: 100n, cached_input: 50n, output: 20n }),
    },
  };
  s.apply(registry, usage);
  s.apply(registry, usage);
  expect(child.headless_meter.meter.value.tokens.total()).toBe(120n);
  expect(child.headless_meter.meter.value.tokens.cached_input).toBe(50n);
  expect(child.headless_meter.meter.value.turns).toBe(1n);
  expect(parent.headless_meter.meter.value.turns).toBe(0n);
  expect(parent.headless_meter.meter.value.tokens.total()).toBe(0n);
  expect(finish(s, registry, "child", "work")).toBe(false);
  expect(child.state.observation.completed).toBe(1n);
});
test("tools follow their turn, and the journal stays bounded", () => {
  const registry = new Registry(),
    s = session();
  start(s, registry, "a", "t");
  s.apply(registry, { kind: "tool", session: "a", turn: "t", id: "x", done: false, wrote: [] });
  s.apply(registry, { kind: "tool", session: "a", turn: "t", id: "y", done: false, wrote: [] });
  expect(s.active_tools.length).toBe(2);
  expect(registry.find("codex", "a")!.state.tool_active).toBe(true);
  s.apply(registry, { kind: "tool", session: "a", turn: "t", id: "x", done: true, wrote: [] });
  expect(s.active_tools.map(t => t.id)).toEqual(["y"]);
  finish(s, registry, "a", "t");
  expect(s.active_tools).toEqual([]);
  expect(s.usage_pending.tools).toBe(2n);
  for (let i = 0; i < 140; i++) s.apply(registry, { kind: "message", session: "a", text: String(i) });
  expect(s.events.length).toBe(128);
  expect(s.next_seq).toBeGreaterThan(128n);
});
test("headless response counts are not lifecycle turns and tools deduplicate after completion", () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  start(s, registry, "a", "user-turn");
  const actor = registry.find("codex", "a")!;
  expect(actor.usageView(0).counts_known).toBe(true);
  expect(actor.usageView(0).turns).toBe(0n);
  for (const input of [10n, 10n, 20n])
    s.apply(registry, {
      kind: "usage",
      session: "a",
      turn: "user-turn",
      total: { total: new Tokens({ input }), last: new Tokens({ input: 10n }) },
    });
  for (const id of ["one", "two"])
    for (const done of [false, true, false, true])
      s.apply(registry, { kind: "tool", session: "a", turn: "user-turn", id, done, wrote: [] });
  expect(actor.usageView(0).turns).toBe(2n);
  expect(actor.usageView(0).tools).toBe(2n);
  const restored = Session.restore(clone(s.capture(true)), registry, true);
  restored.apply(registry, { kind: "tool", session: "a", turn: "user-turn", id: "one", done: false, wrote: [] });
  expect(actor.usageView(0).tools).toBe(2n);
  actor.live_usage.turns = 100n;
  actor.live_usage.tools = 100n;
  expect(actor.usageView(0).turns).toBe(2n);
  expect(actor.usageView(0).tools).toBe(2n);
});
test.each(["claude", "pi", "omp"] as const)("%s keeps transcript count ownership in headless mode", provider => {
  const registry = new Registry(),
    s = new Session(1, provider, "/tmp", new Fake());
  shown(s, registry, "a");
  start(s, registry, "a", "user-turn");
  const actor = registry.find(provider, "a")!;
  actor.live_usage.counts_known = true;
  actor.live_usage.turns = 2n;
  actor.live_usage.tools = 3n;
  s.apply(registry, {
    kind: "usage",
    session: "a",
    turn: "user-turn",
    part: { id: "response", tokens: new Tokens({ input: 10n }) },
  });
  s.apply(registry, { kind: "tool", session: "a", turn: "user-turn", id: "tool", done: false, wrote: [] });
  expect(actor.headless_usage).toBe(false);
  expect(actor.usageView(0).turns).toBe(2n);
  expect(actor.usageView(0).tools).toBe(3n);
});
test("a Codex client over a real process shakes hands, starts a thread and runs a turn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-headless-")),
    program = join(dir, "codex");
  writeFileSync(
    program,
    `#!${process.execPath}
const emit = v => console.log(JSON.stringify(v));
for await (const line of console) {
  const v = JSON.parse(line);
  if (v.method === "initialize") emit({ id: v.id, result: {} });
  else if (v.method === "thread/start") emit({ id: v.id, result: { thread: { id: "raw" } } });
  else if (v.method === "turn/start") {
    emit({ method: "turn/started", params: { threadId: "raw", turn: { id: "t1" } } });
    emit({ id: v.id, result: {} });
  }
}
`,
  );
  chmodSync(program, 0o755);
  const registry = new Registry(),
    s = new Session(1, "codex", "/tmp", Codex.start({ cwd: "/tmp", account: "", executable: program }, null));
  try {
    s.send({ kind: "prompt", text: "hi" });
    const deadline = Date.now() + 3000;
    while (registry.find("codex", "raw")?.state.state !== "working" && Date.now() < deadline) {
      s.poll(registry);
      await Bun.sleep(5);
    }
    expect(s.ready).toBe(true);
    expect(s.agent().sessionId()).toBe("raw");
    expect(s.agent().state).toBe("working");
    expect(s.events.map(e => e.event.kind)).toEqual(["conversation", "turn"]);
  } finally {
    s.destroy();
    rmSync(dir, { recursive: true, force: true });
  }
});
test("a process handed over is left alone until adopted", () => {
  const io = Stdio.restore({ state: { pid: process.pid }, handles: [] }, true);
  expect(io.owner).toBe("handoff");
  io.close();
  expect(io.pid).toBe(process.pid);
});
test("a client that ends is reaped once", () => {
  const registry = new Registry(),
    s = session();
  (s.client as Fake).queued.push({ kind: "ended" });
  s.poll(registry);
  expect(s.reap()).toBe(true);
  expect(s.exited).toBe(true);
  expect(s.reap()).toBe(false);
});
test("headless events snapshots and hooks share exactly one receipt regardless of arrival order", () => {
  const identity = "01901234-1234-1234-1234-123456789abc";
  for (const outcome of ["completed", "interrupted", "failed"] as const)
    for (const headlessFirst of [false, true]) {
      const registry = new Registry(),
        s = session();
      start(s, registry, identity, "t");
      const actor = s.attachment.actor!;
      const completion: Event = { kind: "turn", session: identity, turn: "t", phase: "ended", outcome };
      if (headlessFirst) expect(s.apply(registry, completion)).toBe(outcome === "completed");
      const snapshot = new Snapshot(
        {
          pane: 0,
          pid: 0,
          prefix: new Text(),
          actor: 0,
          generation: 0n,
          title_revision: 0n,
        },
        identity,
        "idle",
      );
      snapshot.turn = new Text("t");
      snapshot.outcome = outcome;
      snapshot.observed_at = Number(actor.state.last_seq) + 1;
      expect(actor.observeSnapshot(snapshot, false, 0)).toBe(!headlessFirst && outcome === "completed");
      expect(s.apply(registry, completion)).toBe(false);
      expect(
        actor.observeHook(
          { kind: "stop", session: identity, turn: "t" },
          actor.state.last_seq + 1n,
          false,
          actor.observed_at + 1,
        ),
      ).toBe(false);
      expect(actor.state.observation.pending_stop).toBe(false);
      expect(actor.state.observation.completed).toBe(1n);
      expect(actor.state.observation.outcome).toBe(outcome);
      expect(actor.state.state).toBe("idle");
      expect(s.active_threads.size).toBe(0);
    }
});

test("the public session identity stays with the root across selection and handoff", () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "child", "root");
  expect(s.session).toBe("");
  shown(s, registry, "root");
  shown(s, registry, "other");
  expect(s.session).toBe("root");
  const saved = clone(s.capture(false));
  expect(Session.restore(saved, registry, false).session).toBe("root");
  delete (saved as any).session;
  expect(Session.restore(saved, registry, false).session).toBe("other");
});

function pendingStart(s: Session) {
  const replies: unknown[] = [];
  let completed = 0;
  const peer = {
    headless_start: { id: s.id, deadline: 1000 },
    queue: (value: unknown) => replies.push(value),
    done: () => completed++,
  } as unknown as Peer;
  const server = {
    clients: [peer],
    runtime: { sessions: [s], changed() {} },
    dirty: false,
  } as unknown as Server;
  return { server, peer, replies, completed: () => completed };
}

test("start waits for provider identity, then replies once", () => {
  const s = session(),
    registry = new Registry(),
    p = pendingStart(s);
  finishStarts(p.server, 0);
  expect(p.replies).toEqual([]);
  expect(p.completed()).toBe(0);
  shown(s, registry, "provider-session");
  finishStarts(p.server, 1);
  finishStarts(p.server, 2);
  expect(p.replies).toEqual([{ ok: true, provider: "codex", session: "provider-session" }]);
  expect(p.completed()).toBe(1);
  expect(p.peer.headless_start).toBeNull();
});

test("start returns a known identity even if the provider already exited", () => {
  const s = session(),
    registry = new Registry(),
    p = pendingStart(s);
  shown(s, registry, "short-lived");
  s.markExited();
  finishStarts(p.server, 1001);
  expect(p.replies).toEqual([{ ok: true, provider: "codex", session: "short-lived" }]);
  expect(p.server.runtime.sessions).toEqual([s]);
  expect(p.completed()).toBe(1);
});

for (const failure of ["exit", "timeout"] as const)
  test(`start cleans up a provider on ${failure}`, () => {
    const s = session(),
      p = pendingStart(s);
    if (failure === "exit") s.markExited();
    finishStarts(p.server, failure === "exit" ? 0 : 1000);
    expect(p.replies).toEqual([{ err: failure === "exit" ? "HeadlessExited" : "HeadlessStartTimeout" }]);
    expect(p.server.runtime.sessions).toEqual([]);
    expect((s.client as Fake).closed).toBe(true);
    expect(p.completed()).toBe(1);
  });

test("headless commands route by both provider and session and cannot switch identity", async () => {
  const registry = new Registry(),
    codex = session(),
    claude = session("claude"),
    p = pendingStart(codex);
  shown(codex, registry, "same-id");
  shown(claude, registry, "same-id");
  p.server.runtime.sessions.push(claude);
  await request(p.server, p.peer, {
    op: "headless.send",
    payload: {
      provider: "claude",
      session: "same-id",
      input: { kind: "prompt", text: "hello" },
    },
  });
  expect((codex.client as Fake).sent).toEqual([]);
  expect((claude.client as Fake).sent).toEqual([{ kind: "prompt", text: "hello", session: "same-id" }]);
  await expect(
    request(p.server, p.peer, {
      op: "headless.send",
      payload: {
        provider: "claude",
        session: "same-id",
        input: { kind: "prompt", text: "hello", session: "another" },
      },
    }),
  ).rejects.toThrow("InvalidSession");
  await expect(
    request(p.server, p.peer, { op: "headless.stop", payload: { provider: "codex", session: "1" } }),
  ).rejects.toThrow("NoHeadlessSession");
  await request(p.server, p.peer, { op: "headless.stop", payload: { provider: "codex", session: "same-id" } });
  expect(p.server.runtime.sessions).toEqual([claude]);
});

test("a provider can retire a timed-out dialog without leaving its actor blocked", () => {
  const s = session(),
    registry = new Registry();
  start(s, registry, "t", "turn");
  s.apply(registry, {
    kind: "request",
    session: "t",
    id: "dialog",
    ask: { tool: false, name: "confirm", summary: "Continue?" },
  });
  expect(registry.get("codex", "t").state.state).toBe("blocked");
  s.apply(registry, { kind: "request_closed", session: "t", id: "wrong", running: true });
  expect(s.approvals).toHaveLength(1);
  s.apply(registry, { kind: "request_closed", session: "t", id: "dialog", running: true });
  expect(s.approvals).toHaveLength(0);
  expect(registry.get("codex", "t").pending_headless_requests).toBe(0);
  expect(registry.get("codex", "t").state.state).toBe("working");
});
