import { test, expect } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Session,
  corgiEnv,
  finishStarts,
  request,
  retire,
  startOptions,
  sweep,
  unread_ms,
  validImages,
} from "./headless";
import * as accounts from "./accounts";
import * as json from "./json";
import * as protocol from "./protocol";
import type { Runtime } from "./runtime";
import type { Server } from "./server";
import type { Client as Peer } from "./peer";
import { Snapshot } from "./providers/snapshot";
import { Text } from "./providers/common";
import { Registry } from "./conversations";
import { clone } from "./json";
import { Tokens } from "./usage/live";
import { Stdio } from "./providers/stdio";
import { Codex } from "./providers/codex/headless";
import { max_image_bytes, type Client, type Event, type Input, type Saved } from "./providers/adapter";
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
test("native activity follows its headless turn without changing approvals or reopening completion", () => {
  const registry = new Registry(),
    s = new Session(1, "omp", "/tmp", new Fake());
  shown(s, registry, "a");
  start(s, registry, "a", "turn");
  const actor = registry.find("omp", "a")!;
  const activity = (text: string, amend = false, turn = "turn") =>
    s.apply(registry, { kind: "activity", session: "a", turn, text, amend });
  activity("Creating protocol");
  activity("Creating protocol smoke", true);
  expect(actor.activity_timeline.points.map(p => p.label.text())).toEqual(["Creating protocol smoke"]);
  expect(actor.state.tool_active).toBe(false);
  s.apply(registry, approval("a", "approval"));
  activity("Waiting for write approval");
  expect(actor.state.state).toBe("blocked");
  expect(actor.state.attention).toBe("needs_input");
  expect(actor.pending_headless_requests).toBe(1);
  s.apply(registry, { kind: "request_closed", session: "a", id: "approval", running: true });
  finish(s, registry, "a", "turn");
  activity("Late result");
  expect(actor.state.state).toBe("idle");
  expect(actor.state.activity.text()).not.toBe("Late result");
  start(s, registry, "a", "next");
  activity("Old turn");
  expect(actor.state.activity.text()).toBe("");
  expect(actor.state.turnId()).toBe("next");
});

test("a session hurries the daemon only while it starts, works, or was just sent something", () => {
  const registry = new Registry(),
    client = new Fake(),
    s = new Session(1, "codex", "/tmp", client),
    later = 1e15;
  expect(s.urgent(later)).toBe(false);
  s.send({ kind: "prompt", text: "hi" });
  expect([s.urgent(s.sent_at + 1), s.urgent(s.sent_at + 10_000)]).toEqual([true, false]);
  shown(s, registry, "a");
  start(s, registry, "a", "a1");
  expect(s.urgent(later)).toBe(true);
  // Waiting on an answer, nothing comes until one is sent.
  s.apply(registry, approval("a", "r1"));
  expect(s.status()).toBe("blocked");
  expect(s.urgent(later)).toBe(false);
  // Another conversation working still needs it.
  shown(s, registry, "b");
  start(s, registry, "b", "b1");
  expect([s.status(), s.urgent(later)]).toEqual(["blocked", true]);
  finish(s, registry, "b", "b1");
  finish(s, registry, "a", "a1");
  expect(s.urgent(later)).toBe(false);
  client.ready = false;
  expect(s.urgent(later)).toBe(true);
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
test("a prompt's images are absolute paths of a type a model reads, and may stand without text", () => {
  expect(validImages([{ path: "/tmp/a.png", mime: "image/png" }])).toEqual([{ path: "/tmp/a.png", mime: "image/png" }]);
  for (const bad of [
    [{ path: "a.png", mime: "image/png" }],
    [{ path: "/tmp/a.tiff", mime: "image/tiff" }],
    "nope",
    Array(9).fill({ path: "/tmp/a.png", mime: "image/png" }),
  ])
    expect(() => validImages(bad)).toThrow("InvalidMessage");
  const dir = mkdtempSync(join(tmpdir(), "corgi-image-")),
    big = join(dir, "big.png");
  try {
    writeFileSync(big, Buffer.alloc(max_image_bytes + 1));
    expect(() => validImages([{ path: big, mime: "image/png" }])).toThrow("ImageTooLarge");
    // One that can't be read is for sending it to report, as before.
    const under = { path: join(big, "x.png"), mime: "image/png" };
    expect(validImages([under])).toEqual([under]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

test("a partial replaces the one before it, so streaming never evicts real events", () => {
  const registry = new Registry(),
    s = session();
  start(s, registry, "a", "t");
  const partial = (session: string, text: string): Event => ({ kind: "partial", session, text });
  s.apply(registry, partial("a", "H"));
  s.apply(registry, partial("a", "He"));
  s.apply(registry, partial("b", "x"));
  s.apply(registry, partial("a", "Hel"));
  s.apply(registry, partial("b", "xy"));
  expect(s.events.map(e => [e.seq, e.event])).toEqual([
    [1n, { kind: "turn", session: "a", turn: "t", phase: "started" }],
    [5n, partial("a", "Hel")],
    [6n, partial("b", "xy")],
  ]);
  s.apply(registry, { kind: "message", session: "b", text: "xyz" });
  s.apply(registry, partial("b", "n"));
  for (let i = 0; i < 300; i++) s.apply(registry, partial("b", "n".repeat(i)));
  // The message replaced the partial it streamed for good.
  expect(s.events.map(e => e.event)).toEqual([
    { kind: "turn", session: "a", turn: "t", phase: "started" },
    partial("a", "Hel"),
    { kind: "message", session: "b", text: "xyz" },
    partial("b", "n".repeat(299)),
  ]);
  expect(s.journal_bytes).toBe(s.events.reduce((n, e) => n + Buffer.byteLength(json.stringify(e.event)), 0));
  expect(s.next_seq).toBe(s.events.at(-1)!.seq + 1n);
});
test("a poll keeps only the newest of a run of partials", () => {
  const registry = new Registry(),
    s = session();
  (s.client as Fake).queued.push(
    { kind: "partial", session: "a", text: "1" },
    { kind: "partial", session: "a", text: "12" },
    { kind: "partial", session: "a", text: "123" },
    { kind: "message", session: "a", text: "123" },
  );
  s.poll(registry);
  expect(s.events.map(e => [e.seq, e.event])).toEqual([[2n, { kind: "message", session: "a", text: "123" }]]);
});
test("a tool's name and summary are kept as one short line, relative to the session's folder", () => {
  const registry = new Registry(),
    s = new Session(1, "claude", "/repo", new Fake());
  start(s, registry, "a", "t");
  const tool = (id: string, summary: string): Event => ({
    kind: "tool",
    session: "a",
    turn: "t",
    id,
    done: false,
    wrote: [],
    name: "Read",
    summary,
  });
  s.apply(registry, tool("x", "/repo/src/x.ts"));
  s.apply(registry, tool("y", "cat <<EOF\n" + "line\n".repeat(100)));
  s.apply(registry, tool("z", "é".repeat(300)));
  s.apply(registry, tool("w", "printf '\x1b[2J\x1b]52;c;aGk=\x07\x9b31m\x7f\tdone'"));
  s.apply(registry, { kind: "tool", session: "a", turn: "t", id: "x", done: true, wrote: [] });
  const summaries = s.events.flatMap(e => (e.event.kind === "tool" ? [e.event.summary] : []));
  expect(summaries.slice(0, 2)).toEqual(["src/x.ts", "cat <<EOF"]);
  expect(Buffer.byteLength(summaries[2]!)).toBe(200);
  expect(summaries[3]).toBe("printf ' [2J ]52;c;aGk=  31m  done'");
  expect(summaries[4]).toBeUndefined();
  expect(s.events.at(-1)!.event).not.toHaveProperty("name");
});
test("a start asks for a known effort and account, and leaves out what it doesn't set", () => {
  const start = (fields: object) =>
    startOptions(protocol.decode("headless.start", { provider: "claude", prompt: "hi", ...fields }));
  expect(start({})).toEqual({ account: "" });
  expect(start({ model: "opus", effort: "high", instructions: "Be brief.", persist: false })).toEqual({
    account: "",
    model: "opus",
    effort: "high",
    instructions: "Be brief.",
    persist: false,
  });
  expect(() => start({ effort: "turbo" })).toThrow("InvalidEffort");
  const saved = { ...process.env },
    home = realpathSync(mkdtempSync(join(tmpdir(), "corgi-headless-accounts-"))),
    work = join(home, ".claude-work");
  try {
    process.env.HOME = home;
    process.env.CORGI_ENV_BASE = join(home, "state");
    delete process.env.CLAUDE_CONFIG_DIR;
    mkdirSync(work);
    mkdirSync(join(home, "state", "corgi"), { recursive: true });
    writeFileSync(
      join(home, "state", "corgi", "accounts.json"),
      JSON.stringify({ accounts: [{ provider: "claude", dir: work, name: "work" }] }),
    );
    accounts.reset();
    expect(start({ account: work })).toEqual({ account: work });
    expect(start({ account: join(home, ".claude") })).toEqual({ account: "" });
    expect(() => start({ account: join(home, "elsewhere") })).toThrow("AccountNotFound");
    expect(() =>
      startOptions(protocol.decode("headless.start", { provider: "codex", prompt: "hi", account: work })),
    ).toThrow("AccountNotFound");
    expect(() =>
      startOptions(protocol.decode("headless.start", { provider: "opencode2", prompt: "hi", account: work })),
    ).toThrow("HeadlessAccountUnsupported");
  } finally {
    for (const key of ["HOME", "CORGI_ENV_BASE", "CLAUDE_CONFIG_DIR"])
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    accounts.reset();
    rmSync(home, { recursive: true, force: true });
  }
});
test("the Corgi prompt's own session stays marked across checkpoints and in the list", async () => {
  const registry = new Registry(),
    s = session();
  s.corgi = true;
  shown(s, registry, "a");
  for (const live of [true, false]) expect(Session.restore(clone(s.capture(live)), registry, live).corgi).toBe(true);
  const old = clone(s.capture(false)) as any;
  delete old.corgi;
  expect(Session.restore(old, registry, false).corgi).toBe(false);
  const p = pendingStart(s);
  await request(p.server, p.peer, { op: "headless.list", payload: {} });
  expect((p.replies[0] as any).sessions[0]).toMatchObject({ session: "a", provider: "codex", corgi: true });
});
test("a session reports what it started with across checkpoints, defaulting for old ones", async () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  Object.assign(s, { corgi: true, account: "/accounts/work", model: "gpt-6", effort: "xhigh", persist: false });
  const started = { account: "/accounts/work", model: "gpt-6", effort: "xhigh", persist: false };
  for (const live of [true, false])
    expect(Session.restore(clone(s.capture(live)), registry, live)).toMatchObject(started);
  const old = clone(s.capture(false)) as any;
  for (const key of ["account", "model", "effort", "persist"]) delete old[key];
  expect(Session.restore(old, registry, false)).toMatchObject({ account: "", model: "", effort: null, persist: true });
  const p = pendingStart(s);
  await request(p.server, p.peer, { op: "headless.list", payload: {} });
  expect((p.replies[0] as any).sessions[0]).toMatchObject(started);
});
test("a session that exits says so once in its journal", () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  (s.client as Fake).queued.push({ kind: "ended" });
  s.poll(registry);
  expect(s.events.some(e => e.event.kind === "ended")).toBe(false);
  expect(s.reap()).toBe(true);
  s.markExited();
  expect(s.events.filter(e => e.event.kind === "ended")).toEqual([{ seq: s.ended_seq!, event: { kind: "ended" } }]);
  expect(s.events.at(-1)!.event).toEqual({ kind: "ended" });
  const restored = Session.restore(clone(s.capture(true)), registry, true);
  expect(restored.ended_seq).toBe(s.ended_seq);
  expect(restored.exited_at).toBeGreaterThan(0);
});
test("the prompt's ended sessions go once their end is read, or a minute after", async () => {
  const registry = new Registry(),
    read = session(),
    unread = session(),
    ordinary = session(),
    running = session(),
    exited = Date.now();
  read.id = 1;
  unread.id = 2;
  ordinary.id = 3;
  running.id = 4;
  for (const [s, id] of [
    [read, "r"],
    [unread, "u"],
    [ordinary, "o"],
    [running, "n"],
  ] as const) {
    shown(s, registry, id);
    s.corgi = s !== ordinary;
    if (s !== running) s.markExited(exited);
  }
  const p = pendingStart(read);
  p.server.runtime.sessions.push(unread, ordinary, running);
  await request(p.server, p.peer, {
    op: "headless.events",
    payload: { provider: "codex", session: "r", after: 0n, pane: null },
  });
  expect((p.replies[0] as any).events.at(-1).event).toEqual({ kind: "ended" });
  expect(p.server.runtime.sessions).toEqual([unread, ordinary, running]);
  expect((read.client as Fake).closed).toBe(true);
  // A reader that fetched only what came before the end hasn't seen it.
  await request(p.server, p.peer, {
    op: "headless.events",
    payload: { provider: "codex", session: "u", after: unread.ended_seq!, pane: null },
  });
  expect(p.server.runtime.sessions).toEqual([unread, ordinary, running]);
  expect(sweep(p.server.runtime, exited + 59_999)).toBe(false);
  expect(sweep(p.server.runtime, exited + 60_000)).toBe(true);
  expect(p.server.runtime.sessions).toEqual([ordinary, running]);
});
test("a prompt session left unread while a viewer is attached stops, unless a pane holds it", () => {
  const left = session(),
    held = session(),
    ordinary = session(),
    runtime = { sessions: [left, held, ordinary], changed() {} } as unknown as Runtime;
  left.corgi = held.corgi = true;
  held.pane = 7;
  // Ticks every 30 s, with the viewers attached or not.
  let now = 1_000_000;
  const until = (end: number, attached: boolean) => {
    for (; now < end; now += 30_000) expect(retire(runtime, attached, now)).toBe(false);
  };
  // Nobody attached: what a viewer left waits for the next one.
  until(now + unread_ms * 3, false);
  // A viewer attaches and has the whole time to take it up.
  until(now + unread_ms - 30_000, true);
  // A gap this long means the machine slept, so the time starts over.
  now += 120_000;
  until(now + unread_ms, true);
  expect(retire(runtime, true, now)).toBe(true);
  expect(runtime.sessions).toEqual([held, ordinary]);
  expect((left.client as Fake).closed).toBe(true);
});
test("reading from a pane claims the session for it, across checkpoints and in the list", async () => {
  const registry = new Registry(),
    s = session();
  s.corgi = true;
  shown(s, registry, "a");
  const p = pendingStart(s);
  // The prompt card reads without a pane and claims nothing.
  await request(p.server, p.peer, {
    op: "headless.events",
    payload: { provider: "codex", session: "a", after: 0n, pane: null },
  });
  expect(s.pane).toBeNull();
  await request(p.server, p.peer, {
    op: "headless.events",
    payload: { provider: "codex", session: "a", after: 0n, pane: 7 },
  });
  expect(s.pane).toBe(7);
  await request(p.server, p.peer, { op: "headless.list", payload: {} });
  expect((p.replies.at(-1) as any).sessions[0]).toMatchObject({ session: "a", corgi: true, pane: 7 });
  for (const live of [true, false]) expect(Session.restore(clone(s.capture(live)), registry, live).pane).toBe(7);
  const old = clone(s.capture(false)) as any;
  delete old.pane;
  expect(Session.restore(old, registry, false).pane).toBeNull();
});

test("a prompt session reaches this Corgi through its socket and its own corgi, as no pane", () => {
  const env = corgiEnv("/tmp/corgi-test/control.sock", "/opt/corgi/bin/corgi");
  expect(env.CORGI_SOCKET).toBe("/tmp/corgi-test/control.sock");
  expect("CORGI_PANE" in env && env.CORGI_PANE === undefined).toBe(true);
  expect(env.PATH?.startsWith("/opt/corgi/bin:")).toBe(true);
});

test("a memory line corgi memory wrote reaches only its own prompt session's journal", async () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  s.corgi = true;
  const p = pendingStart(s),
    line = { file: "/memory/2026-10-30.md", line: "- Ships Fridays", edited: false };
  await request(p.server, p.peer, { op: "headless.memory", payload: { id: s.id, ...line } });
  expect(s.events.at(-1)?.event).toEqual({ kind: "memory", session: "a", ...line });
  for (const bad of [
    { ...line, file: "memory/x.md" },
    { ...line, line: "- one\n- two" },
  ])
    await expect(request(p.server, p.peer, { op: "headless.memory", payload: { id: s.id, ...bad } })).rejects.toThrow(
      "InvalidMessage",
    );
  s.corgi = false;
  await expect(request(p.server, p.peer, { op: "headless.memory", payload: { id: s.id, ...line } })).rejects.toThrow(
    "NoHeadlessSession",
  );
});

test("search progress reaches the prompt journal while its shell tool is still running", async () => {
  const registry = new Registry(),
    s = session();
  shown(s, registry, "a");
  s.corgi = true;
  start(s, registry, "a", "turn");
  s.apply(registry, {
    kind: "tool",
    session: "a",
    turn: "turn",
    id: "shell",
    done: false,
    wrote: [],
    name: "Bash",
    summary: "conversation grep",
  });
  const p = pendingStart(s);
  const state = {
    id: "search-1",
    revision: 1,
    phase: "searching",
    expression: "emoji|unicode",
    workspace: "/work",
    found: 0,
    scanned: 0,
    total: 100,
    limited: false,
    matches: [],
    error: "",
  };
  await request(p.server, p.peer, { op: "headless.search", payload: { id: s.id, search: state } });
  expect(s.active_tools.some(t => t.id === "shell")).toBe(true);
  await request(p.server, p.peer, {
    op: "headless.events",
    payload: { provider: "codex", session: "a", after: 0n, pane: null },
  });
  expect((p.replies.at(-1) as any).events.at(-1).event).toMatchObject({
    kind: "search",
    session: "a",
    search: { phase: "searching", expression: "emoji|unicode" },
  });
  await request(p.server, p.peer, {
    op: "headless.search",
    payload: { id: s.id, search: { ...state, revision: 2, phase: "done", scanned: 100, found: 4 } },
  });
  await request(p.server, p.peer, { op: "headless.search", payload: { id: s.id, search: state } });
  expect(s.events.filter(e => e.event.kind === "search")).toHaveLength(1);
  expect(s.events.at(-1)?.event).toMatchObject({ search: { phase: "done", found: 4 } });
  expect(s.active_tools.some(t => t.id === "shell")).toBe(true);
  expect(corgiEnv("/socket", "/bin/corgi", s.id).CORGI_HEADLESS_ID).toBe("1");
  s.corgi = false;
  await expect(
    request(p.server, p.peer, { op: "headless.search", payload: { id: s.id, search: state } }),
  ).rejects.toThrow("NoHeadlessSession");
});
