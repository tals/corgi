import { test, expect, spyOn } from "bun:test";
import { Runtime, Pane, Launch, type Create } from "./runtime";
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
    this.panes.push(
      new Pane(id, Terminal.create(opts.cols, opts.rows), opts.cwd),
    );
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
    r.deinit();
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
    const id = await r.resumeAgent(
      opts,
      new Launch({ provider: "codex" }),
      hint,
      null,
    );
    expect(r.pane(id)).not.toBeNull();
    expect(r.pane(id)?.ghost).not.toBeNull();
    expect(warn).toHaveBeenCalled();
  } finally {
    get.mockRestore();
    warn.mockRestore();
    r.deinit();
  }
});
test("a fork survives conversation capacity and sidebar placement errors", async () => {
  const { r, ws, opts } = fixture(),
    source = await r.create(opts),
    actor = r.conversations.get(
      "claude",
      "12345678-1234-1234-1234-123456789abc",
    );
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
    r.deinit();
  }
});
test("fork names trim ASCII spaces while tabs remain invalid", async () => {
  const { r, opts } = fixture();
  try {
    await expect(r.forkAgent(opts, 99, " \tname ")).rejects.toThrow(
      "InvalidName",
    );
  } finally {
    r.deinit();
  }
});
