import { stringify } from "./json";
import { afterEach, expect, test } from "bun:test";
import { Server } from "./server";
import { Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Snapshot, Worker } from "./codex_observer";
import { Text } from "./providers/common";
import { Codex } from "./providers/codex";
import { codexActor, codexMissed, reattachFromTitle, retitled } from "./observer_service";

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
  afterEach(() => terminal.destroy());
  return { server, pane, terminal, registry: server.runtime.conversations };
}

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
  const actor = codexActor(server, snapshot)!;
  snapshot.request.generation = pane.attachment.generation;
  terminal.title = `codex | ${id} | Working`;
  expect(codexActor(server, snapshot)).toBe(actor);
  pane.attachment.select(registry.get("codex", "22222222-2222-4222-8222-222222222222"));
  pane.attachment.select(actor);
  expect(codexActor(server, snapshot)).toBeNull();
  snapshot.request.generation = pane.attachment.generation;
  terminal.title = id;
  terminal.title_revision = terminal.title_revision + 2n;
  expect(codexActor(server, snapshot)).toBeNull();
  snapshot.request.title_revision = terminal.title_revision;
  expect(codexActor(server, snapshot)).toBe(actor);
  snapshot.request.actor = actor.id;
  pane.attachment.detach();
  terminal.exited = true;
  expect(codexActor(server, snapshot)).toBe(actor);
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
    retitled(server.runtime, pane, Codex.titleSession(terminal.title));
  };
  const request = () => ({
    pane: 1,
    pid: 42,
    actor: 0,
    prefix: Codex.titleSession(terminal.title)!,
    generation: pane.attachment.generation,
    title_revision: terminal.title_revision,
  });
  const observe = (session: string, ephemeral: boolean) => {
    const snapshot = new Snapshot(request(), session, "idle");
    snapshot.ephemeral = ephemeral;
    return codexActor(server, snapshot);
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
  codexMissed(server, request());
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
  codexMissed(server, request());
  expect(pane.attachment.actor).toBeNull();
});
