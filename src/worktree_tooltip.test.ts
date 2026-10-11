import { expect, test } from "bun:test";
import { Controller } from "./controller";
import { worktreeSnapshot } from "./mirror";
import { State, draw, geometry } from "./worktree_tooltip";
import { View, workspaceEntry, worktreeAt, worktreeLabel, worktreeBadge, writeExit, spotlight_dim } from "./sidebar";
import { fg } from "./palette";
import * as launcherResume from "./launcher_resume";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import { parseInventory } from "./trackers/worktrees";
import type { Snapshot } from "./worktrees";

function snapshot(count = 4): Snapshot {
  return {
    common_dir: "/repo/.git",
    base: { name: "main", ref: "refs/heads/main", head: "base" },
    stale: false,
    agents: [],
    entries: parseInventory(
      `worktree /repo\0branch refs/heads/main\0\0` +
        Array.from(
          { length: count },
          (_, i) => `worktree /repo/.worktrees/${i}\0branch refs/heads/topic-${i}\0\0`,
        ).join(""),
    ),
  };
}
test("the count includes empty linked worktrees and has its own hit area", () => {
  const worktrees = snapshot(),
    ws = workspaceEntry({ id: 1, name: "repo", cwd: "/repo", active: true, worktrees });
  const view = View.init(120, 40, true, 0, 0).withWorkspaces(1, 0);
  expect(worktreeLabel(ws)).toBe("4 worktrees");
  expect(worktreeAt(view, [ws], 20, 3)).toBe(ws);
  expect(worktreeAt(view, [ws], 20, 2)).toBeNull();
  expect(worktreeAt(view, [ws], 2, 3)).toBeNull();
  expect(worktreeLabel({ ...ws, worktrees: snapshot(0) })).toBe("");
});
test("the count and table hide dead worktrees but retain locked and temporarily unavailable checkouts", () => {
  const data = snapshot(6);
  data.entries[1].prunable = "";
  data.entries[2].prunable = "gitdir file points to non-existent location";
  data.entries[3].prunable = "unavailable";
  data.entries[3].locked = "";
  data.entries[5].prunable = "stale metadata";
  data.entries[5].available = true;
  data.entries[6].available = true;
  const ws = workspaceEntry({ id: 1, name: "repo", cwd: "/repo", active: true, worktrees: data });
  expect(worktreeLabel(ws)).toBe("4 worktrees");
  const state = new State(),
    w = new Writer(),
    terminal = new Terminal(100, 30);
  state.selected = data.entries[1].path;
  try {
    draw(w, geometry(100, 30, 28, 3, 4)!, "repo", "/repo", data, state);
    terminal.feed(w.buffered());
    const text = terminal.text();
    expect(text).toContain("4 worktrees");
    expect(text).not.toContain("topic-0");
    expect(text).not.toContain("topic-1");
    for (const label of ["topic-2", "topic-3", "topic-4", "topic-5"]) expect(text).toContain(label);
    expect(data.entries).toHaveLength(7);
  } finally {
    terminal.destroy();
  }
});
test("the table renders unknown values distinctly and retains selection by checkout path", () => {
  const data = snapshot(20),
    state = new State(),
    rect = geometry(100, 30, 28, 3, 20)!;
  data.entries[1].available = true;
  data.entries[1].comparison = { ahead: 0n, behind: 2n };
  data.entries[1].changes = { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0 };
  const w = new Writer();
  draw(w, rect, "repo", "/repo", data, state);
  const terminal = new Terminal(100, 30);
  try {
    terminal.feed(w.buffered());
    const text = terminal.text();
    for (const label of ["20 worktrees", "AGENTS", "AHEAD", "BEHIND", "FILES", "Clean", "Missing", "./.worktrees/0"])
      expect(text).toContain(label);
    expect(text).not.toContain("merged");
    expect(text).not.toContain("Summary");
    expect(text).not.toContain("staged");
    expect(text).not.toContain("/repo/.worktrees/");
    state.move(data, 15);
    expect(state.hit(data, rect, rect.x + 4, rect.y + 5)).toBe(
      data.entries[state.offset(data.entries.slice(1), rect) + 1].path,
    );
    const selected = state.selected;
    data.entries.splice(2, 1);
    expect(data.entries.slice(1)[state.index(data.entries.slice(1))].path).toBe(selected!);
  } finally {
    terminal.destroy();
  }
  expect(geometry(50, 30, 28, 3, 4)).toBeNull();
  expect(geometry(100, 11, 28, 3, 4)).toBeNull();
});
test("wire decoding defaults older snapshots and retains wide comparison counts", () => {
  expect(worktreeSnapshot(undefined)).toBeNull();
  const value = {
    ...snapshot(1),
    entries: [{ ...snapshot(1).entries[1], comparison: { ahead: "9007199254740993", behind: 0 } }],
  };
  expect(worktreeSnapshot(value)?.entries[0].comparison?.ahead).toBe(9007199254740993n);
});
test("pinned worktrees own keys and paste; Escape closes the table without reaching the pane", async () => {
  const view = new Controller({
    request: async () => {
      throw Error("UnexpectedRequest");
    },
  });
  view.receiveSnapshot({
    workspaces: [
      { id: 1, name: "repo", cwd: "/repo", worktrees: snapshot(), model: { nodes: [], tabs: [], revision: 0 } },
    ],
    panes: [],
  });
  await view.perform({ name: "worktrees", value: 1 });
  expect(view.worktreeDetail()).toBe(1);
  expect((view as any).pasteTarget()).toBe("discard");
  await (view as any).key(106);
  expect(view.worktree_card.selected).toBe("/repo/.worktrees/1");
  await (view as any).key(27);
  expect(view.worktreeDetail()).toBeNull();
});

function browsing() {
  const requests: unknown[] = [];
  const view = new Controller({
    request: async (op, fields) => {
      requests.push({ op, ...fields });
      throw Error("TestResume");
    },
  });
  const data = snapshot(2);
  data.agents = [{ target: { native: 7 }, path: data.entries[2].path, source: "write", stale: false }];
  view.receiveSnapshot({
    workspaces: [{ id: 1, name: "repo", cwd: "/repo", worktrees: data, model: { nodes: [], tabs: [], revision: 0 } }],
    panes: [],
    native_sessions: [
      {
        id: 7,
        workspace: 1,
        provider: "codex",
        cwd: "/repo",
        state: "idle",
        agent: { provider: "codex", name: "Search agent", session: "running", cwd: "/repo" },
      },
    ],
  });
  view.launch_previews.history = {
    pending: false,
    entries: Array.from({ length: 5 }, (_, i) =>
      launcherResume.historyEntry({
        provider: "claude",
        session: `session-${i}`,
        title: `Recent ${i}`,
        cwd: data.entries[1].path,
        updated_at: 1000 - i,
      }),
    ),
  };
  view.input_state.attached = true;
  view.worktree_card.workspace = 1;
  view.link_tooltip.shown = true;
  view.link_tooltip.suppressed = false;
  view.link_tooltip.target = { worktree: 1 };
  view.pointer = { x: 20, y: 3 };
  return { view, requests };
}
test("hovered worktrees own legacy, application and Kitty arrows before hover cancellation", async () => {
  for (const down of ["\x1b[B", "\x1bOB", "\x1b[57353u", "j"]) {
    const { view, requests } = browsing();
    await view.input(Buffer.from(down));
    expect(view.worktreeDetail()).toBe(1);
    expect(view.worktree_card.pinned).toBe(true);
    expect(view.worktree_card.selected).toBe("/repo/.worktrees/1");
    expect(view.agentEntries().some(e => e.name === "Search agent")).toBe(true);
    expect((view as any).sidebarEntries().some((e: any) => e.worktree?.ghost)).toBe(false);
    expect(requests).toHaveLength(0);
    await view.input(Buffer.from("\x1b[A"));
    const entries = (view as any).sidebarEntries();
    expect(entries.filter((e: any) => e.recent)).toHaveLength(3);
    expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
    await view.input(Buffer.from("\x1b[27u"));
    expect(view.worktreeDetail()).toBeNull();
  }
  const { view } = browsing();
  await view.input(Buffer.from("\x1b"));
  await view.input(Buffer.from("[B"));
  expect(view.worktree_card.selected).toBe("/repo/.worktrees/1");
});
test("a ghost augments the sidebar, expands recent agents and Enter keeps it in place", async () => {
  const { view } = browsing(),
    terminal = new Terminal(100, 30);
  try {
    let entries = (view as any).sidebarEntries();
    expect(entries[0].worktree.ghost).toBe(true);
    expect(entries[0].enter).toBe(0);
    view.worktree_agents.appeared_at -= 300;
    expect((view as any).sidebarEntries()[0].enter).toBeNull();
    expect(entries.filter((e: any) => e.recent)).toHaveLength(3);
    expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
    terminal.feed(view.frame());
    let text = terminal.text();
    expect(text).toContain("Recent 0");
    expect(text).not.toContain("Recent 3");
    expect(text).toContain("… more (2)");
    expect(text).toContain("Search agent");
    expect(text).toContain("╶─────├");
    expect(text).toContain("╭┄┄┄");
    expect(text).toContain("⌥ topic-0");
    expect(text).not.toContain("Summary");
    await view.perform({ name: "worktree-more", value: entries.findIndex((e: any) => "more" in e.target) });
    entries = (view as any).sidebarEntries();
    expect(entries.filter((e: any) => e.recent)).toHaveLength(5);
    await view.input(Buffer.from("\r"));
    expect(view.worktreeDetail()).toBeNull();
    entries = (view as any).sidebarEntries();
    expect(entries.some((e: any) => e.worktree?.ghost)).toBe(false);
    expect(entries.filter((e: any) => e.recent)).toHaveLength(5);
    expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
  } finally {
    terminal.destroy();
  }
});
test("recent rows resume their session; entering a live group focuses its agent", async () => {
  const { view, requests } = browsing();
  const entries = (view as any).sidebarEntries();
  await view.perform({ name: "worktree-agent", value: entries.findIndex((e: any) => e.recent) });
  expect(requests).toMatchObject([
    {
      op: "session.command",
      command: {
        "agent.resume": {
          workspace: 1,
          provider: "claude",
          session: "session-0",
          cwd: "/repo/.worktrees/0",
        },
      },
    },
  ]);
  const { view: live } = browsing();
  await live.input(Buffer.from("\x1b[B\r"));
  expect(live.native_notice).toBe(7);
  expect(live.worktreeDetail()).toBeNull();
  expect(live.agentEntries().filter(e => e.name === "Search agent")).toHaveLength(1);
});
test("Escape removes an uncommitted ghost without changing normal agents", async () => {
  const { view } = browsing();
  expect((view as any).sidebarEntries().some((e: any) => e.worktree?.ghost)).toBe(true);
  await view.input(Buffer.from("\x1b[27u"));
  const entries = (view as any).sidebarEntries();
  expect(entries.some((e: any) => e.worktree?.ghost)).toBe(false);
  expect(entries.some((e: any) => e.recent)).toBe(false);
  expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
});
test("browsing an offscreen group scrolls the existing sidebar without a duplicate", async () => {
  const { view } = browsing(),
    original = view.runtime.snapshot;
  view.receiveSnapshot({
    ...original,
    native_sessions: [
      ...Array.from({ length: 15 }, (_, i) => ({
        id: i + 20,
        workspace: 1,
        provider: "claude",
        cwd: "/repo",
        state: "idle",
        agent: { provider: "claude", name: `Root ${i}`, session: `root-${i}` },
      })),
      ...original.native_sessions,
    ],
  });
  await view.input(Buffer.from("\x1b[B"));
  const entries = (view as any).sidebarEntries();
  const index = entries.findIndex((e: any) => e.target.worktree === "/repo/.worktrees/1");
  const side = view.sidebarView(entries);
  expect(side.offset).toBeGreaterThan(0);
  expect(index).toBeGreaterThanOrEqual(side.offset);
  expect(index).toBeLessThan(side.offset + side.capacity);
  expect(entries.filter((e: any) => e.name === "Search agent")).toHaveLength(1);
  expect(entries.filter((e: any) => e.name.startsWith("Root "))).toHaveLength(15);
  expect(entries.some((e: any) => e.worktree?.ghost)).toBe(false);
});
test("a worktree header folds its group on click and entering the worktree unfolds it", async () => {
  const { view } = browsing(),
    path = "/repo/.worktrees/1";
  await view.input(Buffer.from("\x1b[27u"));
  const rows = () => (view as any).sidebarEntries();
  const header = rows().findIndex((e: any) => e.target.worktree === path);
  expect(rows()[header]).toMatchObject({ name: "topic-1", focused: false });
  await view.perform({ name: "worktree-agent", value: header });
  expect(rows()[header].group.folded).toBe(true);
  expect(rows().some((e: any) => e.name === "Search agent")).toBe(false);
  (view as any).enterWorktree({ workspace: 1, path });
  expect(rows()[header].group.folded).toBe(false);
  expect(rows()[header].focused).toBe(false);
  expect(rows().some((e: any) => e.name === "Search agent")).toBe(true);
});
/** Two claude panes in the first worktree and one in the primary checkout,
 * with a daemon that records closed panes. */
function paneWorktrees() {
  const data = snapshot(2);
  data.agents = [1, 2].map(pane => ({ target: { pane }, path: data.entries[1].path, source: "write", stale: false }));
  const pane = (id: number, name: string) => ({
    id,
    workspace: 1,
    tab: id,
    cols: 80,
    rows: 24,
    agent: { provider: "claude", name, state: "idle", attention: "none", observation: { completed: 0, read: 0 } },
  });
  const state = {
    workspaces: [
      {
        id: 1,
        name: "repo",
        cwd: "/repo",
        worktrees: data,
        model: {
          nodes: [1, 2, 3].map(pane => ({ pane })),
          tabs: [1, 2, 3].map((id, root) => ({ id, root })),
          revision: 0,
        },
      },
    ],
    panes: [pane(1, "one"), pane(2, "two"), pane(3, "main")],
    conversations: [],
    native_sessions: [],
  };
  const closed: number[] = [],
    view = new Controller({
      request: async (op, fields: any) => {
        if (fields?.command?.["pane.close"]) closed.push(fields.command["pane.close"].target);
        return op === "session.snapshot" ? state : {};
      },
    });
  view.receiveSnapshot(state);
  view.input_state.attached = true;
  const rows = (): any[] => (view as any).sidebarEntries();
  /** The screen row where the entry `matches` picks starts, 1-based as mouse reports count. */
  const row = (matches: (e: any) => boolean) => {
    const entries = rows(),
      side = view.sidebarView(entries),
      index = entries.findIndex(matches);
    const y = Array.from({ length: side.rows }, (_, y) => y).find(y => {
      const hit = side.hit(5, y);
      return hit.tag === "entry" && hit.entry === index;
    })!;
    return y + 1;
  };
  const heading = (e: any) => e.target.worktree === data.entries[1].path;
  return { view, data, closed, rows, row, heading };
}
test("a worktree heading's right-click menu closes only the agents listed under it", async () => {
  const { view, closed, row, heading } = paneWorktrees();
  await view.input(Buffer.from(`\x1b[<2;6;${row(heading)}M`));
  expect(view.tab_menu!.entries().map(e => e.label)).toEqual(["Fold", "Close all agents for topic-0"]);
  await view.input(Buffer.from("x"));
  expect(view.tab_menu).toBeNull();
  expect(closed).toEqual([1, 2]);
});
test("browsing a folded worktree in the overview dims the rest and peeks it open in place", async () => {
  const { view, data, rows, row, heading } = paneWorktrees(),
    path = data.entries[1].path,
    dim = new Writer();
  writeExit(dim, fg("text"), spotlight_dim);
  const faded = "\x1b[22m" + dim.buffered() + "main";
  // Hovering the heading in the sidebar lights nothing.
  await view.input(Buffer.from(`\x1b[<35;6;${row(heading)}M`));
  expect(view.frame()).not.toContain(faded);
  (view as any).toggleWorktree({ workspace: 1, path });
  const header = rows().findIndex(heading);
  await view.perform({ name: "worktrees", value: 1 });
  await view.perform({ name: "worktree-select", value: path });
  const peek = rows();
  expect(peek.findIndex(heading)).toBe(header);
  expect(peek[header].worktree.ghost).toBe(true);
  expect(peek.filter(e => e.worktree?.ghost && "pane" in e.target).map(e => e.name)).toEqual(["one", "two"]);
  expect(view.frame()).toContain(faded);
  await view.input(Buffer.from("\x1b[27u"));
  expect(rows()[header]).toMatchObject({ worktree: { ghost: false }, group: { folded: true } });
  expect(view.frame()).not.toContain(faded);
});
test("callout geometry keeps the agent pane and source badge uncovered", () => {
  const ws = workspaceEntry({ id: 1, name: "repo", cwd: "/repo", active: true, worktrees: snapshot(2) });
  const side = View.init(120, 38, true, 0, 0).withWorkspaces(1, 0),
    badge = worktreeBadge(side, [ws], 1)!,
    rect = geometry(120, 38, side.width, badge.y, 2)!;
  expect(rect.x).toBeGreaterThan(side.width);
  expect(rect.contains(badge.x, badge.y)).toBe(false);
  expect(rect.h).toBe(12);
});
