import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane, Launch, type Create } from "./runtime";
import * as session from "./session";
import { Terminal } from "./pane/terminal";
import { Workspace } from "./workspace";
import { Theme } from "./theme";
import { ResumeHint } from "./resume_hint";
import { Text } from "./providers";
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
    for (const id of [a, b]) Object.assign(r.pane(id)!.agent(), { provider: "claude", state: "idle" });
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
    ws.sections.clear();
    expect(r.raiseEntered()).toBe(false);
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
    ws.sections.clear();
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
