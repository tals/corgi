import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane, Launch, type Create } from "./runtime";
import * as session from "./session";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import { Theme } from "./theme";
import { ResumeHint } from "./resume_hint";
import { Text } from "./providers";
import { parseInventory } from "./trackers/worktrees";
class LocalRuntime extends Runtime {
  override async create(opts: Create) {
    const ws = this.getWorkspace(opts.workspace);
    ws.model.next_id = this.workspaces.next_pane_id;
    const id = ws.model.newTab("");
    ws.model.revision = BigInt.asUintN(64, ws.model.revision + 1n);
    this.workspaces.next_pane_id = ws.model.next_id;
    this.panes.push(new Pane(id, Terminal.create(opts.cols, opts.rows), opts.cwd));
    this.changed();
    return id;
  }
}
/** As a checkpoint or handoff brings the workspace back. */
function restore(ws: Workspace) {
  ws.sections.clear();
  ws.restoreActivity(ws.activity_order);
}
function fixture() {
  const r = new LocalRuntime(),
    ws = new Workspace(1, "/tmp");
  r.workspaces.items = [ws];
  const opts: Create = {
    workspace: 1,
    cwd: "/tmp",
    cols: 20,
    rows: 4,
    theme: new Theme(),
    socket: "/tmp/unused-review.sock",
    executable: process.execPath,
  };
  return { r, ws, opts };
}
test("resuming elsewhere leaves the star in its workspace until the conversation returns", async () => {
  const { r, ws, opts } = fixture(),
    elsewhere = new Workspace(2, "/tmp"),
    id = "12345678-1234-1234-1234-123456789abc";
  r.workspaces.items.push(elsewhere);
  try {
    const first = await r.create(opts);
    r.pane(first)!.attachment.select(r.conversations.get("claude", id));
    r.starAgent(ws, { pane: first }, true);
    r.raiseEntered();
    r.close(first);
    const other = await r.reopenClosed(r.closedConversation("claude", id)!, { ...opts, workspace: elsewhere.id });
    r.raiseEntered();
    expect(elsewhere.pinned_agents.has({ pane: other })).toBe(false);
    expect(elsewhere.starred_sessions.slice()).toEqual([]);
    expect(ws.starred_sessions.has("claude", id)).toBe(true);
    r.close(other);
    const back = await r.reopenClosed(r.closedConversation("claude", id)!, opts);
    r.raiseEntered();
    expect(ws.pinned_agents.has({ pane: back })).toBe(true);
  } finally {
    r.destroy();
  }
});
test("all wrapping runtime revisions retain u64 bounds", () => {
  const r = new Runtime(),
    max = 0xffffffffffffffffn;
  try {
    r.revision = max;
    r.shown = max;
    r.durable = max;
    r.refreshed();
    expect([r.revision, r.shown, r.durable]).toEqual([0n, 0n, max]);
    r.revision = max;
    r.durable = max;
    r.wrote();
    expect([r.revision, r.durable, r.shown]).toEqual([0n, 0n, 0n]);
    r.revision = max;
    r.shown = max;
    r.durable = max;
    r.changed();
    expect([r.revision, r.durable, r.shown]).toEqual([0n, 0n, 0n]);
  } finally {
    r.destroy();
  }
});
test("a resumed pane survives conversation capacity errors", async () => {
  const { r, opts } = fixture(),
    hint = new ResumeHint();
  hint.provider = "codex";
  hint.session = new Text("12345678-1234-1234-1234-123456789abc");
  const get = spyOn(r.conversations, "get").mockImplementation(() => {
      throw Error("TooManyConversations");
    }),
    warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const id = await r.resumeAgent(opts, new Launch({ provider: "codex" }), hint, null);
    expect(r.pane(id)).not.toBeNull();
    expect(r.pane(id)?.ghost).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  } finally {
    get.mockRestore();
    warn.mockRestore();
    r.destroy();
  }
});
test("an agent resumed asleep waits in its own tab, named and idle, with nothing running", async () => {
  const { opts } = fixture(),
    r = new Runtime(),
    ws = new Workspace(1, "/tmp"),
    hint = new ResumeHint();
  r.workspaces.items = [ws];
  hint.provider = "claude";
  hint.session = new Text("12345678-1234-1234-1234-123456789abc");
  hint.name = new Text("Stored name");
  try {
    const id = await r.resumeAgent({ ...opts, asleep: true }, new Launch({ provider: "claude" }), hint, null),
      p = r.pane(id)!;
    expect([p.dormant, p.terminal.exited, p.terminal.pid <= 0, p.ghost]).toEqual([true, true, true, null]);
    expect(ws.model.tabForPane(id)).toBe(0);
    expect([p.agent().name.text(), p.agent().state]).toEqual(["Stored name", "idle"]);
    expect(p.restoring()).toContain("--resume");
  } finally {
    r.destroy();
  }
});
test("a runtime holds any number of panes", async () => {
  const { opts } = fixture(),
    r = new Runtime(),
    ws = new Workspace(1, "/tmp");
  r.workspaces.items = [ws];
  try {
    for (let i = 0; i < 80; i++) await r.create({ ...opts, asleep: true });
    expect([r.panes.length, ws.model.count]).toEqual([80, 80]);
  } finally {
    r.destroy();
  }
});
test("a fork survives conversation capacity and sidebar placement errors", async () => {
  const { r, ws, opts } = fixture(),
    source = await r.create(opts),
    actor = r.conversations.get("claude", "12345678-1234-1234-1234-123456789abc");
  r.pane(source)!.attachment.select(actor);
  actor.state.provider = "claude";
  actor.state.session = new Text("12345678-1234-1234-1234-123456789abc");
  ws.agent_order.items = [{ pane: source }];
  const get = spyOn(r.conversations, "get").mockImplementation(() => {
      throw Error("TooManyConversations");
    }),
    move = spyOn(ws.agent_order, "moveAfter").mockImplementation(() => {
      throw Error("TooManyAgents");
    }),
    warn = spyOn(console, "warn").mockImplementation(() => {});
  try {
    const id = await r.forkAgent(opts, source, null);
    expect(r.pane(id)).not.toBeNull();
    expect(r.pane(id)?.ghost?.fork).toContain("--fork-session");
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    get.mockRestore();
    move.mockRestore();
    warn.mockRestore();
    r.destroy();
  }
});
test("fork names trim ASCII spaces while tabs remain invalid", async () => {
  const { r, opts } = fixture();
  try {
    await expect(r.forkAgent(opts, 99, " \tname ")).rejects.toThrow("InvalidName");
  } finally {
    r.destroy();
  }
});
test("an agent that enters another activity section, or is new, goes first in its order", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts),
      shell = await r.create(opts);
    for (const id of [a, b]) {
      Object.assign(r.pane(id)!.agent(), { provider: "claude", state: "idle" });
      r.pane(id)!.agent().observation.completed = 1n;
    }
    const agents = () => ws.activity_order.slice().filter(t => "pane" in t && t.pane !== shell);
    expect(r.raiseEntered()).toBe(true);
    expect(ws.activity_order.has({ pane: shell })).toBe(true);
    const [first, second] = agents();
    // Nothing moved on: nothing changes, even after the user reorders.
    ws.activity_order.move(r.agentTargets(ws), second, first);
    expect(r.raiseEntered()).toBe(false);
    expect(agents()).toEqual([second, first]);
    Object.assign(r.pane((first as { pane: number }).pane)!.agent(), { state: "working" });
    expect(r.raiseEntered()).toBe(true);
    expect(agents()).toEqual([first, second]);
    // After a restore, agents already placed keep their place.
    restore(ws);
    expect(r.raiseEntered()).toBe(false);
  } finally {
    r.destroy();
  }
});
test("a new agent waits on top of working until its first turn", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts);
    for (const id of [a, b]) {
      Object.assign(r.pane(id)!.agent(), { provider: "claude", state: "working" });
      r.pane(id)!.agent().observation.completed = 1n;
    }
    r.raiseEntered();
    const c = await r.create(opts),
      agent = r.pane(c)!.agent(),
      order = () => ws.activity_order.slice().filter(t => "pane" in t && [a, b, c].includes(t.pane));
    // Listed once its provider shows, it goes first, held in working through startup and idle.
    agent.provider = "claude";
    for (const state of ["unknown", "initializing", "idle"] as const) {
      agent.state = state;
      r.raiseEntered();
      expect(order()[0]).toEqual({ pane: c });
      expect(r.startingAgents(ws)).toEqual([{ pane: c }]);
    }
    // Others that start work go above it; its first turn lets it go where it is.
    Object.assign(r.pane(a)!.agent(), { state: "idle" });
    r.raiseEntered();
    Object.assign(r.pane(a)!.agent(), { state: "working" });
    r.raiseEntered();
    agent.state = "working";
    expect(r.raiseEntered()).toBe(false);
    expect(order()[0]).toEqual({ pane: a });
    expect(r.startingAgents(ws)).toEqual([]);
    // Finished, it goes on as any other agent.
    Object.assign(agent, { state: "idle", attention: "finished" });
    expect(r.raiseEntered()).toBe(true);
    expect(r.startingAgents(ws)).toEqual([]);
  } finally {
    r.destroy();
  }
});
test("a completed turn ends the wait even when its working state went unseen", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      agent = r.pane(a)!.agent();
    Object.assign(agent, { provider: "claude", state: "initializing" });
    r.raiseEntered();
    expect(r.startingAgents(ws)).toEqual([{ pane: a }]);
    agent.state = "idle";
    agent.observation.completed = 1n;
    expect(r.raiseEntered()).toBe(true);
    expect(r.startingAgents(ws)).toEqual([]);
    expect(ws.sections.get(`pane:${a}`)).toBe("idle");
  } finally {
    r.destroy();
  }
});
test("after a restore, only agents still starting up wait in working", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts);
    for (const id of [a, b]) Object.assign(r.pane(id)!.agent(), { provider: "claude", state: "idle" });
    r.raiseEntered();
    restore(ws);
    ws.starting.clear();
    r.pane(b)!.agent().state = "initializing";
    r.raiseEntered();
    expect(r.startingAgents(ws)).toEqual([{ pane: b }]);
  } finally {
    r.destroy();
  }
});
test("a snapshot shows an agent's new section with its place at the top of it", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts);
    for (const id of [a, b]) Object.assign(r.pane(id)!.agent(), { provider: "claude", state: "idle" });
    r.raiseEntered();
    const order = () => ws.activity_order.slice().filter(t => "pane" in t && (t.pane === a || t.pane === b));
    const last = order().at(-1) as { pane: number };
    // Restored at work, it keeps its place at the bottom of the order.
    Object.assign(r.pane(last.pane)!.agent(), { state: "working" });
    restore(ws);
    r.raiseEntered();
    expect(order().at(-1)).toEqual(last);
    // Interrupted, it moves on between the daemon's ticks; the next snapshot has it first.
    Object.assign(r.pane(last.pane)!.agent(), { state: "idle", attention: "finished" });
    const shown = session
      .snapshot(r)
      .workspaces[0].activity_order.filter((t: any) => "pane" in t && (t.pane === a || t.pane === b));
    expect(shown[0]).toEqual(last);
  } finally {
    r.destroy();
  }
});
test("new agents lead manual order without moving tabs or following activity changes", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts);
    for (const id of [a, b]) r.pane(id)!.agent().provider = "claude";
    expect(r.raiseEntered()).toBe(true);
    expect(ws.agent_order.slice()).toEqual([{ pane: b }, { pane: a }]);
    ws.agent_order.move(r.agentTargets(ws), { pane: a }, { pane: b });
    const c = await r.create(opts);
    r.pane(c)!.agent().provider = "claude";
    const snapshot = session.snapshot(r);
    expect(snapshot.workspaces[0].agent_order).toEqual([{ pane: c }, { pane: a }, { pane: b }]);
    expect([a, b, c].map(id => ws.model.tabForPane(id))).toEqual([0, 1, 2]);
    r.pane(b)!.agent().state = "working";
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([{ pane: c }, { pane: a }, { pane: b }]);
    restore(ws);
    expect(r.raiseEntered()).toBe(false);
    expect(ws.agent_order.slice()).toEqual([{ pane: c }, { pane: a }, { pane: b }]);
  } finally {
    r.destroy();
  }
});
test("an existing shell goes first when it becomes an agent", async () => {
  const { r, ws, opts } = fixture();
  try {
    const shell = await r.create(opts),
      agent = await r.create(opts);
    r.pane(agent)!.agent().provider = "claude";
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([{ pane: shell }, { pane: agent }]);
    ws.agent_order.move(r.agentTargets(ws), { pane: shell }, null);
    r.pane(shell)!.agent().provider = "codex";
    expect(r.raiseEntered()).toBe(true);
    expect(ws.agent_order.slice()).toEqual([{ pane: shell }, { pane: agent }]);
  } finally {
    r.destroy();
  }
});
test("new agents lead the first matching worktree group, keeping that group in place", async () => {
  const { r, ws, opts } = fixture();
  ws.worktrees = {
    common_dir: "/repo/.git",
    base: null,
    agents: [],
    stale: false,
    entries: parseInventory(
      "worktree /repo\0branch refs/heads/main\0\0worktree /repo/one\0branch refs/heads/one\0\0worktree /repo/two\0branch refs/heads/two\0\0",
    ),
  };
  const add = async (cwd: string) => {
    const pane = await r.create({ ...opts, cwd });
    r.pane(pane)!.agent().provider = "claude";
    return { pane };
  };
  try {
    const main = await add("/repo"),
      one = await add("/repo/one"),
      middle = await add("/repo"),
      later = await add("/repo/one");
    ws.agent_order.items = [main, one, middle, later];
    r.raiseEntered();
    // The first matching run wins, including agents associated by writes.
    r.pane(one.pane)!.cwd = "/repo";
    ws.worktrees.agents = [{ target: one, path: "/repo/one", source: "write", stale: false }];
    const added = await add("/repo/one/src");
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([main, added, one, middle, later]);
    // A new worktree goes first; several arrivals in one snapshot stay together.
    const two = await add("/repo/two"),
      newer = await add("/repo/two/src");
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([newer, two, main, added, one, middle, later]);
    // The main checkout does not pull new agents below linked worktrees.
    const direct = await add("/repo");
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([direct, newer, two, main, added, one, middle, later]);
  } finally {
    r.destroy();
  }
});
test("a fork keeps its explicit place below its source in manual order", async () => {
  const { r, ws, opts } = fixture();
  try {
    const source = await r.create(opts),
      other = await r.create(opts),
      actor = r.conversations.get("claude", "12345678-1234-1234-1234-123456789abc");
    r.pane(source)!.attachment.select(actor);
    r.pane(other)!.agent().provider = "codex";
    r.raiseEntered();
    const fork = await r.forkAgent(opts, source, null);
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([{ pane: other }, { pane: source }, { pane: fork }]);
  } finally {
    r.destroy();
  }
});
test("an agent that briefly loses its provider keeps its manual place", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts),
      b = await r.create(opts);
    for (const id of [a, b]) r.pane(id)!.agent().provider = "claude";
    r.raiseEntered();
    ws.agent_order.move(r.agentTargets(ws), { pane: b }, null);
    expect(ws.agent_order.slice()).toEqual([{ pane: a }, { pane: b }]);
    r.pane(b)!.agent().provider = null;
    r.raiseEntered();
    r.pane(b)!.agent().provider = "claude";
    r.raiseEntered();
    expect(ws.agent_order.slice()).toEqual([{ pane: a }, { pane: b }]);
  } finally {
    r.destroy();
  }
});
test("unstarring an agent that is gone does nothing", async () => {
  const { r, ws, opts } = fixture();
  try {
    const a = await r.create(opts);
    r.pane(a)!.agent().provider = "claude";
    expect(() => r.starAgent(ws, { pane: a + 100 }, false)).not.toThrow();
    expect(() => r.starAgent(ws, { pane: a + 100 }, true)).toThrow("NoAgent");
  } finally {
    r.destroy();
  }
});
