import { expect, test } from "bun:test";
import { Runtime, Pane, Launch, Ghost } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import { Text } from "./providers";
import { Session } from "./headless";
import * as checkpoint from "./persist/checkpoint";
import * as protocol from "./protocol";
import * as cli from "./cli";
import * as json from "./json";
import * as archiveSummary from "./archive_summary";
import { snapshot } from "./session";

function world() {
  const runtime = new Runtime();
  runtime.workspaces.items = [new Workspace(1, "/tmp", "one"), new Workspace(2, "/tmp", "two")];
  runtime.workspaces.next_id = 3;
  const ws = runtime.workspaces.items[0];
  for (let i = 0; i < 2; i++) {
    const id = i === 0 ? ws.model.newTab("kept") : ws.model.split(1, "horizontal");
    const p = new Pane(id, Terminal.create(40, 10), "/tmp");
    p.terminal.exited = true;
    p.terminal.feed("retained output");
    p.label = "pane " + id;
    runtime.panes.push(p);
  }
  runtime.workspaces.next_pane_id = ws.model.next_id;
  return runtime;
}

test("hibernation keeps pane identity, labels, output and split layout without using undo history", () => {
  using r = world();
  const layout = json.stringify(r.workspaces.items[0].model);
  r.hibernate([1, 3, 1]);
  r.hibernate([1]);
  expect(r.panes.map(p => [p.id, p.dormant, p.terminal.pid, p.label])).toEqual([
    [1, true, -1, "pane 1"],
    [3, true, -1, "pane 3"],
  ]);
  expect(r.panes[0].terminal.history()).toContain("retained output");
  expect(json.stringify(r.workspaces.items[0].model)).toBe(layout);
  expect(r.closed).toHaveLength(0);
});

test("a missing member rejects a whole hibernation set", () => {
  using r = world();
  expect(() => r.hibernate([1, 999])).toThrow("NoPane");
  expect(r.panes.every(p => !p.dormant)).toBe(true);
});

test("busy panes hibernate without treating another live attachment as stopped", () => {
  using r = world();
  const actor = r.conversations.get("claude", "busy-session");
  Object.assign(actor.state, {
    state: "working",
    attention: "needs_input",
    tool_active: true,
    compacting: true,
    subagents: { running: 2, blocked: 1, waiting: true },
  });
  for (const p of r.panes) {
    p.terminal.exited = false;
    p.attachment.select(actor);
  }
  r.hibernate([1]);
  expect(actor.state.state).toBe("working");
  r.hibernate([3]);
  expect(r.panes.every(p => p.dormant)).toBe(true);
  expect(r.panes[0].restoring()).toBe("claude --resume busy-session");
  expect(actor.state.state).toBe("unknown");
  expect(actor.state.tool_active).toBe(false);
  expect(actor.state.subagents.running).toBe(0);
});

test("fresh agents keep their launch across recovery without resuming an older session", async () => {
  using r = world();
  const p = r.panes[0];
  p.agent().provider = "claude";
  p.agent().state = "initializing";
  p.launch = new Launch({ provider: "claude", model: "saved-model", env: [["CLAUDE_CONFIG_DIR", "/tmp/account"]] });
  p.resume_hint.provider = "claude";
  p.resume_hint.session = new Text("previous-session");
  r.hibernate([1]);
  expect(p.restoring()).toBe("claude --model saved-model");
  for (const live of [false, true]) {
    using restored = new Runtime();
    await checkpoint.restore(restored, checkpoint.capture(r, live), live, "", "", false);
    const recovered = restored.pane(1)!;
    expect(recovered.dormant).toBe(true);
    expect(recovered.restoring()).toBe("claude --model saved-model");
    expect(recovered.account()).toBe("/tmp/account");
    expect(recovered.resume_hint.args()).toBeNull();
  }
});

test("hibernation accepts claimed panes without inventing a local agent launch", () => {
  using r = world();
  const p = r.panes[0];
  p.agent().provider = "codex";
  p.agent().state = "blocked";
  p.detection.claim = { provider: "codex", owner: 1234, parent: 1 };
  r.hibernate([1]);
  expect(p.dormant).toBe(true);
  expect(p.restoring()).toBe("");
  expect(p.resume_hint.provider).toBeNull();
  expect(p.detection.claim).toBeNull();
});

test("hibernation during restore keeps the visible saved screen and resume hint", () => {
  using r = world();
  const p = r.panes[0],
    saved = Terminal.create(40, 10);
  saved.feed("visible saved screen");
  p.ghost = new Ghost(saved, 0n, null);
  p.resume_hint.provider = "codex";
  p.resume_hint.session = new Text("resuming-session");
  r.hibernate([1]);
  expect(p.dormant).toBe(true);
  expect(p.ghost).toBeNull();
  expect(p.terminal.history()).toContain("visible saved screen");
  expect(p.restoring()).toBe("codex resume resuming-session");
});

test("archive is idempotent, preserves panes, and unarchive does not start them", () => {
  using r = world();
  r.archiveWorkspace(1);
  r.archiveWorkspace(1);
  expect(r.workspaces.items[0].archived).toBe(true);
  expect(r.panes.every(p => p.dormant)).toBe(true);
  expect(() => r.archiveWorkspace(2)).toThrow("LastWorkspace");
  r.closeWorkspace(2, true);
  expect(r.workspaces.items.map(w => w.id)).toEqual([1]);
  r.unarchiveWorkspace(1);
  r.unarchiveWorkspace(1);
  expect(r.workspaces.items[0].archived).toBe(false);
  expect(r.panes.every(p => p.dormant)).toBe(true);
});

test("archive keeps the former agent states on the wire and through live and cold recovery", async () => {
  using r = world();
  const working = r.conversations.get("claude", "running");
  Object.assign(working.state, { state: "working" });
  const unread = r.conversations.get("codex", "unread");
  unread.state.state = "idle";
  unread.state.observation.finish("completed", "screen");
  r.panes[0].attachment.select(working);
  r.panes[1].attachment.select(unread);
  for (const p of r.panes) p.terminal.exited = false;
  r.archiveWorkspace(1);
  const summary = r.workspaces.items[0].archive_summary!;
  expect(summary).toMatchObject({ agents: 2, running: 1, unread: 1, idle: 0 });
  expect(working.state.state).toBe("unknown");
  expect(snapshot(r).workspaces[0].archive_summary).toEqual(summary);
  for (const live of [false, true]) {
    using restored = new Runtime();
    await checkpoint.restore(restored, checkpoint.capture(r, live), live, "", "");
    expect(restored.workspaces.items[0].archive_summary).toEqual(summary);
    expect(restored.panes.every(p => p.manual_resume && p.dormant)).toBe(true);
    restored.unarchiveWorkspace(1);
    expect(restored.panes.every(p => p.manual_resume && p.dormant)).toBe(true);
  }
});

test("archive program counts combine agents and other programs, largest first", () => {
  const agent = {
    target: { pane: 1 },
    name: "task",
    provider: "claude",
    activity: "",
    running: true,
    state: "working",
    attention: "none",
    paused: false,
    unread: false,
  } as const;
  const summary = archiveSummary.capture(
    [agent, agent, { ...agent, provider: "codex", running: false, state: "blocked", attention: "needs_input" }],
    [
      { name: "server", brand: "bun" },
      { name: "server", brand: "bun" },
      { name: "server", brand: "bun" },
    ],
  );
  expect(summary).toMatchObject({ agents: 3, running: 2, waiting: 1 });
  expect(summary.programs.map(p => [p.count, p.name, p.brand])).toEqual([
    [3, "server", "bun"],
    [2, "Claude", "claude"],
    [1, "Codex", "openai"],
  ]);
});

test("archiving converts headless agents into dormant panes with their session and output", () => {
  using r = world();
  const session = new Session(1, "claude", "/tmp", {
    ready: true,
    send() {},
    take: () => [],
    async wait() {},
    close() {},
    save: () => ({ state: null, handles: [] }),
  });
  session.workspace_id = 1;
  r.sessions.push(session);
  session.attachment.provisional.session = new Text("headless-session");
  session.attachment.provisional.name = new Text("Headless work");
  r.archiveWorkspace(1);
  expect(r.workspaces.items[0].archived).toBe(true);
  expect(r.sessions).toHaveLength(0);
  expect(r.panes).toHaveLength(3);
  expect(r.panes.every(p => p.dormant)).toBe(true);
  const recovered = r.panes[2];
  expect(recovered.resume_hint.session.text()).toBe("headless-session");
  expect(recovered.resumeLaunch()?.agent?.provider).toBe("claude");
  expect(recovered.terminal.history()).toContain("Headless work");
});

test("archiving headless subagents preserves only their other live attachments", () => {
  for (const exited of [true, false]) {
    using r = world();
    const actor = r.conversations.get("claude", "shared-child");
    Object.assign(actor.state, { state: "working" });
    const ws = r.workspaces.items[1];
    ws.model.next_id = r.workspaces.next_pane_id;
    const p = new Pane(ws.model.newTab("other attachment"), Terminal.create(40, 10), "/tmp");
    r.workspaces.next_pane_id = ws.model.next_id;
    p.terminal.exited = exited;
    p.attachment.select(actor);
    r.panes.push(p);
    const session = new Session(1, "claude", "/tmp", {
      ready: true,
      send() {},
      take: () => [],
      async wait() {},
      close() {},
      save: () => ({ state: null, handles: [] }),
    });
    session.workspace_id = 1;
    session.members.push(actor);
    r.sessions.push(session);
    r.archiveWorkspace(1);
    expect(actor.state.state).toBe(exited ? "unknown" : "working");
  }
});

test("shell and agent hibernation survive cold recovery and live handoff", async () => {
  using original = world();
  const actor = original.conversations.get("codex", "sleeping-session");
  actor.state.state = "idle";
  actor.state.name = new Text("kept agent");
  original.panes[1].attachment.select(actor);
  original.archiveWorkspace(1);
  for (const live of [false, true]) {
    using restored = new Runtime();
    await checkpoint.restore(restored, checkpoint.capture(original, live), live, "", "");
    expect(restored.workspaces.items[0].archived).toBe(true);
    expect(restored.panes.map(p => [p.id, p.dormant, p.terminal.pid])).toEqual([
      [1, true, -1],
      [3, true, -1],
    ]);
    expect(restored.panes[0].terminal.history()).toContain("retained output");
    expect(restored.panes[1].restoring()).toBe("codex resume sleeping-session");
  }
});

test("checkpoints before archiving default to active workspaces", async () => {
  using original = world();
  original.hibernate([1, 3]);
  const state = checkpoint.capture(original, false);
  for (const ws of state.workspaces) delete (ws as { archived?: boolean }).archived;
  using restored = new Runtime();
  await checkpoint.restore(restored, state, false, "", "");
  expect(restored.workspaces.items.every(w => !w.archived)).toBe(true);
});

test("CLI and RPC expose batch hibernation, wake and workspace archiving", async () => {
  expect((await cli.parse(["pane", "hibernate", "3", "4", "current"], 5)).command).toEqual({
    "pane.hibernate": { targets: [3, 4, 5] },
  });
  expect((await cli.parse(["pane", "wake", "current"], 3)).command).toEqual({ "pane.wake": { target: 3 } });
  for (const operation of ["archive", "unarchive"])
    expect((await cli.parse(["workspace", operation, "2"])).command).toEqual({
      ["workspace." + operation]: { target: 2 },
    });
  expect(protocol.decodeCommand({ "pane.hibernate": { targets: [1n, 3] } })).toEqual({
    "pane.hibernate": { targets: [1, 3] },
  });
  expect(() => protocol.decodeCommand({ "pane.hibernate": { targets: [-1] } })).toThrow("Overflow");
});
