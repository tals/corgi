import { test, expect } from "bun:test";
import * as mirror from "./mirror";
import * as optimistic from "./optimistic";
import type { CommandInput } from "./protocol";

/** A daemon's snapshot: workspaces `ids`, the first holding headless agents
 * 1–3 in `order`, with a two-tab layout at `revision`. */
function snapshot(order: number[], ids = [1], revision = 5, tabs = [7, 8]) {
  return {
    workspaces: ids.map(id => ({
      id,
      model: {
        nodes: [{ pane: 1 }, { pane: 2 }],
        tabs: tabs.map((tab, root) => ({ id: tab, title: "", root })),
        revision,
      },
      agent_order: order.map(headless => ({ headless })),
    })),
    headless_sessions: [1, 2, 3].map(id => ({ id, workspace: 1, provider: "codex", session: `s${id}` })),
  };
}
function assume(runtime: mirror.Runtime, command: CommandInput) {
  return runtime.assume(optimistic.edit(command)!);
}
const agents = (runtime: mirror.Runtime) =>
  runtime.workspaces.items[0].agent_order.map(t => ("headless" in t ? t.headless : -t.pane));

test("a moved agent keeps its place through snapshots from before and after the daemon moves it", () => {
  const runtime = new mirror.Runtime();
  try {
    runtime.receive(null as any, snapshot([1, 2, 3]));
    const forget = assume(runtime, {
      "agent.move": { workspace: 1, target: { headless: 3 }, before: { headless: 1 } },
    });
    expect(agents(runtime)).toEqual([3, 1, 2]);
    runtime.receive(null as any, snapshot([1, 2, 3]));
    expect(agents(runtime)).toEqual([3, 1, 2]);
    runtime.receive(null as any, snapshot([3, 1, 2]));
    expect(agents(runtime)).toEqual([3, 1, 2]);
    // Answered: the daemon's order stands, whatever it is.
    forget();
    runtime.receive(null as any, snapshot([2, 3, 1]));
    expect(agents(runtime)).toEqual([2, 3, 1]);
  } finally {
    runtime.destroy();
  }
});
test("an edit that no longer applies drops itself", () => {
  const runtime = new mirror.Runtime();
  try {
    runtime.receive(null as any, snapshot([1, 2, 3]));
    assume(runtime, { "agent.place": { workspace: 2, target: { headless: 3 }, before: null } });
    assume(runtime, { "agent.move": { workspace: 1, target: { headless: 3 }, before: null } });
    expect(agents(runtime)).toEqual([1, 2, 3]);
    runtime.receive(null as any, { ...snapshot([3, 2, 1]), headless_sessions: [] });
    runtime.receive(null as any, snapshot([3, 2, 1]));
    expect(agents(runtime)).toEqual([3, 2, 1]);
  } finally {
    runtime.destroy();
  }
});
test("a moved workspace and a starred agent's place show before the daemon answers", () => {
  const runtime = new mirror.Runtime();
  try {
    runtime.receive(null as any, snapshot([1, 2, 3], [1, 2, 3]));
    assume(runtime, { "workspace.move": { target: 3, before: 1 } });
    assume(runtime, { "agent.pin": { workspace: 1, target: { headless: 2 }, before: null } });
    assume(runtime, { "agent.pin": { workspace: 1, target: { headless: 3 }, before: { headless: 2 } } });
    runtime.receive(null as any, snapshot([1, 2, 3], [1, 2, 3]));
    expect(runtime.workspaces.items.map(ws => ws.id)).toEqual([3, 1, 2]);
    expect(runtime.workspaces.items[1].pinned_agents).toEqual([{ headless: 3 }, { headless: 2 }]);
  } finally {
    runtime.destroy();
  }
});
test("starring an agent stars the others in its conversation, as the daemon does", () => {
  const runtime = new mirror.Runtime(),
    session = (id: number, conversation: string) => ({
      id,
      workspace: 1,
      provider: "codex",
      session: `s${id}`,
      agent: { provider: "codex", session: conversation },
    });
  try {
    runtime.receive(null as any, {
      ...snapshot([1, 2, 3]),
      headless_sessions: [session(1, "c1"), session(2, "c2"), session(3, "c1")],
    });
    assume(runtime, { "agent.pin": { workspace: 1, target: { headless: 1 }, before: null } });
    expect(runtime.workspaces.items[0].pinned_agents).toEqual([{ headless: 1 }, { headless: 3 }]);
    assume(runtime, { "agent.pin": { workspace: 1, target: { headless: 3 }, before: null, pinned: false } });
    expect(runtime.workspaces.items[0].pinned_agents).toEqual([]);
  } finally {
    runtime.destroy();
  }
});
test("a dock that opens a shell guesses an id no other workspace's pane has", () => {
  const runtime = new mirror.Runtime(),
    workspace = (id: number, pane: number, tab: number) => ({
      id,
      model: { nodes: [{ pane }], tabs: [{ id: tab, title: "", root: 0 }], revision: 5 },
    });
  try {
    // The daemon numbers panes and tabs across workspaces: 3 is the second's.
    runtime.receive(null as any, { workspaces: [workspace(1, 1, 2), workspace(2, 3, 4)] });
    assume(runtime, {
      "layout.dock": {
        workspace: 1,
        viewer: 1,
        expected: 5n,
        source: { tab: 2 },
        drop: { kind: "beside", pane: 1, direction: "right", whole: false },
        focus: 1,
        selected: 1,
        cols: 80,
        rows: 24,
      },
    });
    const [first, second] = runtime.workspaces.items;
    expect(first.model.paneCount(first.model.tabs[0].root)).toBe(2);
    expect(first.model.tabForPane(3)).toBeNull();
    expect(runtime.workspaces.owner(3)).toBe(second);
    // Its ids are guesses, so it doesn't pass for the daemon's next layout.
    expect(first.model.revision).toBe(5n);
  } finally {
    runtime.destroy();
  }
});
test("a dock shows on the layout it was planned on, and yields to any later one", () => {
  const runtime = new mirror.Runtime(),
    tabs = () => runtime.workspaces.items[0].model.tabs.slice(0, 2).map(t => t.id);
  try {
    runtime.receive(null as any, snapshot([], [1], 5));
    assume(runtime, {
      "layout.dock": {
        workspace: 1,
        viewer: 1,
        expected: 5n,
        source: { tab: 8 },
        drop: { kind: "tab", index: 0 },
        focus: 2,
        selected: 1,
        cols: 80,
        rows: 24,
      },
    });
    expect([tabs(), runtime.workspaces.items[0].model.revision]).toEqual([[8, 7], 6n]);
    runtime.receive(null as any, snapshot([], [1], 5));
    expect([tabs(), runtime.workspaces.items[0].model.revision]).toEqual([[8, 7], 6n]);
    // The daemon's own answer, here with the tab it made under another id.
    runtime.receive(null as any, snapshot([], [1], 6, [9, 7]));
    expect([tabs(), runtime.workspaces.items[0].model.revision]).toEqual([[9, 7], 6n]);
  } finally {
    runtime.destroy();
  }
});
