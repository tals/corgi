import { stringify } from "./json";
import { afterEach, expect, test } from "bun:test";
import { Server } from "./server";
import { Pane, Launch } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { Worker } from "./providers/codex/observer";
import { Snapshot } from "./providers/snapshot";
import { Text } from "./providers/common";
import * as codex from "./providers/codex";
import * as protocol from "./protocol";
import * as session from "./session";
import { Result as UsageResult, Worker as UsageWorker } from "./usage/worker";
import type { Client } from "./peer";
import {
  snapshotActor,
  missed,
  reattachFromTitle,
  retitled,
  claimPane,
  detectPane,
  hook,
  stop,
  start,
  tick,
} from "./observer_service";

const id = "11111111-1111-4111-8111-111111111111";
class ObserverTerminal extends Terminal {
  private observedTitle = id;
  private observedPid = 42;
  private observedRevision = 1n;
  override get title() {
    return this.observedTitle;
  }
  set title(value: string) {
    this.observedTitle = value;
  }
  override get title_pid() {
    return this.observedPid;
  }
  set title_pid(value: number) {
    this.observedPid = value;
  }
  override get title_revision() {
    return this.observedRevision;
  }
  set title_revision(value: bigint) {
    this.observedRevision = value;
  }
}
function fixture() {
  const server = new Server("/tmp/corgi-observer-test.sock", "corgi", "test");
  const terminal = new ObserverTerminal(60, 8);
  terminal.title = id;
  terminal.title_pid = 42;
  terminal.title_revision = 1n;
  const pane = new Pane(1, terminal, "/tmp");
  pane.detection.pid = 42;
  server.runtime.panes.push(pane);
  afterEach(() => {
    stop(server);
    terminal.destroy();
  });
  return { server, pane, terminal, registry: server.runtime.conversations };
}

test("a bridge claim runs the existing screen watcher without a local agent or conversation", () => {
  const { server, pane, terminal, registry } = fixture();
  pane.launch = new Launch({ provider: "codex" });
  pane.attachment.select(registry.get("codex", id));
  claimPane(server, { pane: 1, provider: "claude", owner: process.pid });
  terminal.feed("Working (esc to interrupt)");
  terminal.title = "⠋ Remote task";
  for (let i = 0; i < 3; i++) detectPane(server, pane, null);
  expect(pane.agent()).toMatchObject({ provider: "claude", state: "working", attention: "none" });
  expect(pane.detection.pid).toBe(0);
  expect(pane.attachment.actor).toBeNull();
  expect(pane.resumeLaunch()).toBeNull();
  expect(pane.account()).toBe("");
  terminal.feed("\x1b[2J\x1b[HEnter to confirm · Esc to cancel");
  for (let i = 0; i < 2; i++) detectPane(server, pane, null);
  expect(pane.agent()).toMatchObject({ state: "blocked", attention: "needs_input" });
  const generation = pane.attachment.generation;
  claimPane(server, { pane: 1, provider: "claude", owner: process.pid });
  expect(pane.attachment.generation).toBe(generation);
  hook(server, {
    pane: 1,
    provider: "claude",
    event: { hook_event_name: "SessionStart", session_id: "remote-session" },
    pid: 42,
    seq: 1n,
    background: false,
  });
  expect(pane.attachment.actor).toBeNull();
  expect(registry.find("claude", "remote-session")).toBeNull();
  claimPane(server, { pane: 1, provider: null, owner: process.pid });
  expect(pane.detection.claim).toBeNull();
  expect(pane.agent()).toMatchObject({ provider: null, state: "unknown", attention: "none" });
  expect(pane.agent().observation.completed).toBe(0n);
});

test("only a claim's live owner can replace or clear it, and owner loss returns to local detection", () => {
  const { server, pane, terminal } = fixture();
  claimPane(server, { pane: 1, provider: "codex", owner: process.pid });
  for (const provider of [null, "claude"] as const)
    expect(() => claimPane(server, { pane: 1, provider, owner: process.ppid })).toThrow("AgentClaimed");
  terminal.feed("› ");
  for (let i = 0; i < 3; i++) detectPane(server, pane, null);
  terminal.feed("\x1b[2J\x1b[H• Working (20s • esc to interrupt)\r\n› Ask Codex to do anything");
  for (let i = 0; i < 3; i++) detectPane(server, pane, null);
  expect(pane.agent().state).toBe("working");
  pane.detection.claim!.parent = -1;
  detectPane(server, pane, { provider: "claude", pid: 123 });
  expect(pane.detection.claim).toBeNull();
  expect(pane.detection.pid).toBe(123);
  expect(pane.agent().provider).toBe("claude");
  expect(pane.agent().observation.completed).toBe(0n);
  expect(pane.attachment.actor).toBeNull();
});

test("claimed screen completions retain their receipts through clear, replacement and owner loss", () => {
  const { server, pane, terminal } = fixture();
  const show = (text: string, title: string) => {
    terminal.feed("\x1b[2J\x1b[H" + text);
    terminal.title = title;
    for (let i = 0; i < 3; i++) detectPane(server, pane, null);
  };
  claimPane(server, { pane: 1, provider: "claude", owner: process.pid });
  show("Working (esc to interrupt)", "⠋ Remote task");
  show("", "✳ Ready");
  expect(pane.agent()).toMatchObject({ state: "idle", attention: "finished" });
  expect(pane.agent().observation).toMatchObject({ completed: 1n, read: 0n, source: "screen" });
  expect(server.bell_kind).toBe("finished");
  const generation = pane.attachment.generation;
  claimPane(server, { pane: 1, provider: null, owner: process.pid });
  expect(pane.attachment.generation).toBeGreaterThan(generation);
  expect(pane.agent()).toMatchObject({ provider: null, attention: "finished" });
  expect(pane.agent().observation.completed).toBe(1n);
  claimPane(server, { pane: 1, provider: "codex", owner: process.pid });
  expect(pane.agent().observation.unread()).toBe(true);
  show("Working (esc to interrupt)", "");
  expect(pane.detection.screen_worked).toBe(true);
  pane.detection.claim!.parent = -1;
  detectPane(server, pane, null);
  expect(pane.agent()).toMatchObject({ provider: null, attention: "finished" });
  expect(pane.agent().observation.completed).toBe(1n);
  expect(pane.detection.screen_worked).toBe(false);
});

test("autodetected local agents complete screen-only turns without a claim", () => {
  for (const provider of ["claude", "codex"] as const) {
    const { server, pane, terminal } = fixture();
    const job = { provider, pid: 42 };
    terminal.title = "⠋ Task";
    terminal.feed("Working (esc to interrupt)");
    for (let i = 0; i < 3; i++) detectPane(server, pane, job);
    expect(pane.agent().state).toBe("working");
    expect(pane.detection.claim).toBeNull();
    expect(pane.detection.screen_only).toBe(true);
    terminal.title = "✳ Ready";
    terminal.feed("\x1b[2J\x1b[H› ");
    for (let i = 0; i < 3; i++) detectPane(server, pane, job);
    expect(pane.agent()).toMatchObject({ state: "idle", attention: "finished" });
    expect(pane.agent().observation).toMatchObject({ completed: 1n, read: 0n, source: "screen" });
    expect(server.bell_kind).toBe("finished");
    detectPane(server, pane, null);
    detectPane(server, pane, null);
    expect(pane.agent().provider).toBeNull();
    expect(pane.agent().observation.completed).toBe(1n);
    expect(pane.agent().observation.unread()).toBe(true);
  }
});

test("identity without structured evidence keeps screen-only lifecycle on its actor", () => {
  const { server, pane, terminal, registry } = fixture();
  const actor = registry.get("codex", id),
    job = { provider: "codex" as const, pid: 42 };
  terminal.feed("Working (esc to interrupt)");
  for (let i = 0; i < 3; i++) detectPane(server, pane, job);
  expect(pane.attachment.actor).toBe(actor);
  expect(actor.state.state).toBe("working");
  terminal.feed("\x1b[2J\x1b[H› ");
  for (let i = 0; i < 3; i++) detectPane(server, pane, job);
  expect(actor.state).toMatchObject({ state: "idle", attention: "finished", last_seq: 0n });
  expect(actor.state.observation.completed).toBe(1n);
  expect(pane.attachment.provisional.observation.completed).toBe(0n);
  expect(server.bell_kind).toBe("finished");
});

test("expired structured evidence permits screen status but never switches to inferred completion", () => {
  const { server, pane, terminal, registry } = fixture();
  const actor = registry.get("codex", id),
    job = { provider: "codex" as const, pid: 42 };
  actor.state.last_seq = 100n;
  actor.state.observation.source = "protocol";
  const show = (text: string) => {
    terminal.feed("\x1b[2J\x1b[H" + text);
    for (let i = 0; i < 3; i++) detectPane(server, pane, job);
  };
  show("› ");
  expect(pane.detection.structured).toBe(true);
  show("Working (esc to interrupt)");
  expect(actor.state.state).toBe("working");
  show("› ");
  expect(actor.state.state).toBe("idle");
  expect(actor.state.observation.completed).toBe(0n);
  expect(pane.detection.screen_worked).toBe(false);
  expect(server.bell_kind).toBe("none");
});

test("claims reject missing panes, dead owners and ended terminals", () => {
  const { server, terminal } = fixture();
  expect(() => claimPane(server, { pane: 2, provider: "claude", owner: process.pid })).toThrow("NoPane");
  for (const owner of [0, 1, 2147483647])
    expect(() => claimPane(server, { pane: 1, provider: "claude", owner })).toThrow("InvalidOwner");
  terminal.exited = true;
  expect(() => claimPane(server, { pane: 1, provider: "claude", owner: process.pid })).toThrow("PaneExited");
});

test("Codex claims cannot reattach local conversation identity from a remote title", () => {
  const { server, pane, registry } = fixture();
  registry.get("codex", id);
  claimPane(server, { pane: 1, provider: "codex", owner: process.pid });
  reattachFromTitle(server, pane, "codex", 42);
  for (let i = 0; i < 3; i++) detectPane(server, pane, { provider: "codex", pid: 42 });
  expect(pane.attachment.actor).toBeNull();
  expect(pane.agent().sessionId()).toBe("");
});

test("Codex selection rejects delayed ABA observations while detached actors remain addressable", () => {
  const { server, pane, terminal, registry } = fixture();
  const snapshot = new Snapshot(
    {
      pane: 1,
      pid: 42,
      actor: 0,
      prefix: new Text(id),
      generation: pane.attachment.generation,
      title_revision: terminal.title_revision,
    },
    id,
    "working",
  );
  const actor = snapshotActor(server, "codex", snapshot)!;
  snapshot.request.generation = pane.attachment.generation;
  terminal.title = `codex | ${id} | Working`;
  expect(snapshotActor(server, "codex", snapshot)).toBe(actor);
  pane.attachment.select(registry.get("codex", "22222222-2222-4222-8222-222222222222"));
  pane.attachment.select(actor);
  expect(snapshotActor(server, "codex", snapshot)).toBeNull();
  snapshot.request.generation = pane.attachment.generation;
  terminal.title = id;
  terminal.title_revision = terminal.title_revision + 2n;
  expect(snapshotActor(server, "codex", snapshot)).toBeNull();
  snapshot.request.title_revision = terminal.title_revision;
  expect(snapshotActor(server, "codex", snapshot)).toBe(actor);
  snapshot.request.actor = actor.id;
  pane.attachment.detach();
  terminal.exited = true;
  expect(snapshotActor(server, "codex", snapshot)).toBe(actor);
});

test("local Codex reattachment requires current unambiguous identity and preserves observations", () => {
  const { server, pane, terminal, registry } = fixture();
  const actor = registry.get("codex", id);
  actor.state.setName("App server name");
  actor.state.state = "working";
  actor.state.metadata_protocol_at = 123;
  actor.state.observation.source = "protocol";
  actor.state.observation.completed = 2n;
  actor.state.observation.read = 1n;
  const before = stringify(actor.state);
  terminal.title_pid = 41;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  terminal.title_pid = 42;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBe(actor);
  expect(stringify(actor.state)).toBe(before);
  expect(pane.attachment.knows(actor.id)).toBe(true);
  const generation = pane.attachment.generation;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.generation).toBe(generation);
  pane.attachment.detach();
  registry.get("codex", "11111111-1111-4111-8111-111111111112");
  terminal.title = "11111111-1111-4111-8111-11111...";
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  terminal.title = "22222222-2222-4222-8222-222222222222";
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  terminal.title = id;
  terminal.exited = true;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
});

test("a Codex side conversation in the title leaves the pane on the conversation it forked", () => {
  const { server, pane, terminal, registry } = fixture();
  const fork = "33333333-3333-4333-8333-333333333333",
    next = "44444444-4444-4444-8444-444444444444",
    gone = "55555555-5555-4555-8555-555555555555";
  const main = registry.get("codex", id);
  const show = (session: string) => {
    terminal.title = `codex | ${session} | project`;
    terminal.title_revision++;
    retitled(server.runtime, pane, "codex", codex.titleSession(terminal.title));
  };
  const request = () => ({
    pane: 1,
    pid: 42,
    actor: 0,
    prefix: codex.titleSession(terminal.title)!,
    generation: pane.attachment.generation,
    title_revision: terminal.title_revision,
  });
  const observe = (session: string, ephemeral: boolean) => {
    const snapshot = new Snapshot(request(), session, "idle");
    snapshot.ephemeral = ephemeral;
    return snapshotActor(server, "codex", snapshot);
  };
  pane.attachment.select(main);
  show(id);
  show(fork);
  expect(pane.attachment.actor).toBe(main);
  expect(observe(fork, true)).toBeNull();
  expect(pane.attachment).toMatchObject({ actor: main, side: true });
  expect(registry.find("codex", fork)).toBeNull();
  const worker = new Worker();
  worker.reconcile(server.runtime);
  expect(worker.requests.map(r => [r.pane, r.actor, r.prefix.text()])).toEqual([[0, main.id, id]]);
  missed(server, "codex", request());
  expect(pane.attachment.actor).toBe(main);

  show(id);
  expect(pane.attachment).toMatchObject({ actor: main, side: false });
  // A new thread replaces the conversation once the observer reads it.
  show(next);
  expect(pane.attachment.actor).toBe(main);
  const started = observe(next, false)!;
  expect(started.state.sessionId()).toBe(next);
  expect(pane.attachment.actor).toBe(started);
  // A known conversation in the title takes over at once.
  show(id);
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBe(main);
  // So does no conversation, when the daemon doesn't have the thread.
  show(gone);
  expect(pane.attachment.actor).toBe(main);
  missed(server, "codex", request());
  expect(pane.attachment.actor).toBeNull();
});

test("transcript todo snapshots reach conversation.list and viewer snapshots through observation", async () => {
  const { server, pane, registry } = fixture(),
    actor = registry.get("omp", "todo-session");
  const workspace = new Workspace(1, "/tmp");
  workspace.model.newTab("");
  server.runtime.workspaces.items.push(workspace);
  pane.detection.pid = 0;
  pane.dormant = true;
  pane.attachment.select(actor);
  server.usage = new UsageWorker();
  const workers = start(server);
  const phases = [
    { name: "Implement", tasks: [{ content: "Transport", status: "blocked" as const, blocker: "Access" }] },
  ];
  let revision = 0;
  for (const value of [phases, null, []]) {
    const result = new UsageResult();
    result.actor = actor.id;
    result.todo_phases = value;
    workers.usage.results.push(result);
    workers.detected = 0;
    await tick(server);
    const expected = value === null ? phases : value;
    expect(actor.todo_phases).toEqual(expected);
    expect(session.viewerSnapshot(server.runtime).conversations[0].todo_phases).toEqual(expected);
    const work = actor.activity_timeline.taskContext();
    expect(work.supplied).toBe(expected.length > 0);
    expect(work.tasks.map(task => task.label)).toEqual(
      expected.flatMap(phase => phase.tasks.map(task => task.content)),
    );
    if (value === null) expect(work.revision).toBe(revision);
    else expect(work.revision).toBeGreaterThan(revision);
    revision = work.revision;
    const tasks = session.viewerSnapshot(server.runtime).conversations[0].timeline.tasks;
    expect(tasks.map((task: { label: string }) => task.label)).toEqual(work.tasks.map(task => task.label));
    if (tasks.length) expect(tasks[0]).toMatchObject({ source: "agent", status: "blocked", blocker: "Access" });
    const responses: unknown[] = [];
    // conversation.list uses only the negotiated protocol and queue on its client.
    const client = {
      protocol_version: protocol.version,
      queue: (value: unknown) => {
        responses.push(value);
      },
    } as unknown as Client;
    await server.request(client, protocol.envelope("conversation.list"));
    expect(responses).toMatchObject([{ conversations: [{ todo_phases: expected }] }]);
  }
});
