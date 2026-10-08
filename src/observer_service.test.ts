import { stringify } from "./json";
import { expect, test } from "bun:test";
import { Registry, Attachment } from "./conversations";
import { Text } from "./providers/common";
import { codexActor, reattachFromTitle } from "./observer_service";

const id = "11111111-1111-4111-8111-111111111111";
function fixture() {
  const pane = {
    id: 1,
    terminal: { title: id, title_pid: 42, title_revision: 1n, exited: false },
    detection: { pid: 42, missing: false },
    attachment: new Attachment(),
  };
  const runtime = {
    conversations: new Registry(),
    pane: (value: number) => (value === pane.id ? pane : null),
    workspaces: { get: () => null, owner: () => null },
  };
  return { server: { runtime }, pane, registry: runtime.conversations };
}

test("Codex selection rejects delayed ABA observations while detached actors remain addressable", () => {
  const { server, pane, registry } = fixture();
  const snapshot = {
    request: {
      pane: 1,
      pid: 42,
      actor: 0,
      prefix: new Text(id),
      generation: pane.attachment.generation,
      title_revision: pane.terminal.title_revision,
    },
    session: id,
  };
  const actor = codexActor(server, snapshot)!;
  snapshot.request.generation = pane.attachment.generation;
  pane.terminal.title = `codex | ${id} | Working`;
  expect(codexActor(server, snapshot)).toBe(actor);
  pane.attachment.select(registry.get("codex", "22222222-2222-4222-8222-222222222222"));
  pane.attachment.select(actor);
  expect(codexActor(server, snapshot)).toBeNull();
  snapshot.request.generation = pane.attachment.generation;
  pane.terminal.title = id;
  pane.terminal.title_revision += 2n;
  expect(codexActor(server, snapshot)).toBeNull();
  snapshot.request.title_revision = pane.terminal.title_revision;
  expect(codexActor(server, snapshot)).toBe(actor);
  snapshot.request.actor = actor.id;
  pane.attachment.detach();
  pane.terminal.exited = true;
  expect(codexActor(server, snapshot)).toBe(actor);
});

test("local Codex reattachment requires current unambiguous identity and preserves observations", () => {
  const { server, pane, registry } = fixture();
  const actor = registry.get("codex", id);
  actor.state.setName("App server name");
  actor.state.state = "working";
  actor.state.metadata_protocol_at = 123;
  actor.state.observation.source = "protocol";
  actor.state.observation.completed = 2n;
  actor.state.observation.read = 1n;
  const before = stringify(actor.state);
  pane.terminal.title_pid = 41;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  pane.terminal.title_pid = 42;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBe(actor);
  expect(stringify(actor.state)).toBe(before);
  expect(pane.attachment.knows(actor.id)).toBe(true);
  const generation = pane.attachment.generation;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.generation).toBe(generation);
  pane.attachment.detach();
  registry.get("codex", "11111111-1111-4111-8111-111111111112");
  pane.terminal.title = "11111111-1111-4111-8111-11111...";
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  pane.terminal.title = "22222222-2222-4222-8222-222222222222";
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
  pane.terminal.title = id;
  pane.terminal.exited = true;
  reattachFromTitle(server, pane, "codex", 42);
  expect(pane.attachment.actor).toBeNull();
});
