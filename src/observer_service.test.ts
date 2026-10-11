import { stringify } from "./json";
import { afterEach, expect, test } from "bun:test";
import { Server } from "./server";
import { Pane } from "./runtime";
import { Terminal } from "./pane/terminal";
import { Snapshot } from "./codex_observer";
import { Text } from "./providers/common";
import { codexActor, reattachFromTitle } from "./observer_service";

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
