import { expect, test } from "bun:test";
import { Runtime, Pane } from "./runtime";
import { Workspace } from "./workspace";
import { Terminal } from "./pane/terminal";
import * as session from "./session";
import * as docking from "./docking";

const ctx = { socket: "/tmp/corgi-test", executable: "/bin/corgi", theme: {} };
function fixture() {
  const r = new Runtime(),
    ws = new Workspace(1, "/tmp");
  r.workspaces.items = [ws];
  const a = ws.model.newTab("A"),
    b = ws.model.newTab("B");
  r.workspaces.next_pane_id = ws.model.next_id;
  for (const id of [a, b]) r.panes.push(new Pane(id, Terminal.create(80, 24), "/tmp"));
  const request = () => ({
    workspace: 1,
    viewer: 7,
    expected: ws.model.revision,
    source: { tab: ws.model.tabs[1].id },
    drop: { kind: "beside" as const, pane: a, direction: "right" as const, whole: false },
    focus: b,
    selected: a,
    cols: 120,
    rows: 35,
  });
  const history = (direction: "undo" | "redo", viewer = 7) =>
    session.execute(r, ctx, { "layout.history": { workspace: 1, viewer, expected: ws.model.revision, direction } });
  return { r, ws, a, b, request, history };
}
test("dock, undo and redo preserve live panes and enforce the viewer's revision", async () => {
  const { r, ws, a, b, request, history } = fixture();
  try {
    const before = docking.shape(ws.model),
      terminals = r.panes.map(p => p.terminal);
    const q = request();
    await session.execute(r, ctx, { "layout.dock": q });
    const after = docking.shape(ws.model);
    expect(ws.model.count).toBe(1);
    await expect(history("undo", 8)).rejects.toThrow("StaleLayout");
    await expect(session.execute(r, ctx, { "layout.dock": q })).rejects.toThrow("StaleLayout");
    expect((await history("undo")).pane).toBe(a);
    expect(docking.shape(ws.model)).toBe(before);
    expect((await history("redo")).pane).toBe(b);
    expect(docking.shape(ws.model)).toBe(after);
    expect(r.panes.map(p => p.terminal)).toEqual(terminals);
    session.arrange(r, { "pane.rename": { target: a, name: "Changed" } });
    await expect(history("undo")).rejects.toThrow("StaleLayout");
  } finally {
    r.destroy();
  }
});
test("a closed pane invalidates undo rather than resurrecting its process", async () => {
  const { r, a, b, request, history } = fixture();
  try {
    await session.execute(r, ctx, { "layout.dock": request() });
    r.close(b);
    await expect(history("undo")).rejects.toThrow("StaleLayout");
    expect(r.panes.map(p => p.id)).toEqual([a]);
  } finally {
    r.destroy();
  }
});
test("invalid destinations and undersized splits leave the model and IDs untouched", async () => {
  const { r, ws, request } = fixture();
  try {
    const before = docking.shape(ws.model),
      next = r.workspaces.next_pane_id;
    for (const q of [
      { ...request(), cols: 20, rows: 8 },
      { ...request(), drop: { kind: "beside" as const, pane: 999, direction: "left" as const, whole: false } },
    ]) {
      await expect(session.execute(r, ctx, { "layout.dock": q })).rejects.toThrow();
      expect(docking.shape(ws.model)).toBe(before);
      expect(r.workspaces.next_pane_id).toBe(next);
    }
  } finally {
    r.destroy();
  }
});
