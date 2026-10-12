import { transport } from "./fixtures/transport";
import { expect, test } from "bun:test";
import { Controller } from "./controller";
import { worktreeSnapshot } from "./mirror";
import { State, between, columnsFor, displayPath, draw, geometry, listing } from "./worktree_tooltip";
import * as worktreeRemoval from "./worktree_removal";
import { View, workspaceEntry, worktreeAt, worktreeLabel, worktreeBadge, writeExit, spotlight_dim } from "./sidebar";
import { colors, fg, fgRgb } from "./palette";
import * as launcherResume from "./launcher_resume";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";
import { parseInventory } from "./trackers/worktrees";
import * as clock from "./clock";
import type { Brief, Snapshot } from "./worktrees";
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

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
test("rows show agents at work, the comparison, age, last edit and line counts", () => {
  const data = snapshot(2),
    now = Date.UTC(2026, 9, 11),
    [topic, quiet] = data.entries.slice(1);
  Object.assign(topic, {
    available: true,
    comparison: { ahead: 6n, behind: 12n },
    changes: { total: 3, staged: 0, modified: 2, untracked: 1, conflicted: 0, added: 142, removed: 38 },
    created: now - 3 * 86400000,
    edited: now - 12 * 60000,
  });
  Object.assign(quiet, {
    available: true,
    comparison: { ahead: 0n, behind: 5n },
    changes: { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, added: 0, removed: 0 },
  });
  const state = new State();
  state.agents = new Map([[topic.path, { agents: 2, working: 1 }]]);
  const w = new Writer(),
    terminal = new Terminal(140, 30);
  try {
    draw(w, geometry(140, 30, 28, 3, 2)!, "repo", "/repo", data, state, null, now);
    terminal.feed(w.buffered());
    const text = terminal.text();
    for (const header of ["AGENTS", "VS MAIN", "AGE", "EDITED", "UNCOMMITTED CHANGES"]) expect(text).toContain(header);
    const row = (label: string) => text.split("\n").find(l => l.includes(label));
    expect(row("topic-0")).toMatch(/1▶ 2 +↑6 ↓12 +3d +12m ago +3 files {2}\+142 −38/);
    expect(row("topic-1")).toMatch(/0 +↑0 ↓5 +— +— +Clean/);
    // Working agents as the sidebar marks them; lines added and removed as a diff colors them.
    expect(w.buffered()).toContain(`\x1b[1m${fgRgb(colors.accent)}1▶`);
    expect(w.buffered()).toContain(`${fgRgb(colors.accent)}+142`);
    expect(w.buffered()).toContain(`${fgRgb(colors.hot)}−38`);
  } finally {
    terminal.destroy();
  }
});
test("the overview counts each worktree's agents, and those working, as the sidebar does", () => {
  const data = snapshot(2);
  data.agents = [{ target: { native: 7 }, path: data.entries[2].path, source: "write", stale: false }];
  const row = (state: string) => {
    const view = new Controller({ request: (async () => ({})) as any });
    view.width = 140;
    view.height = 30;
    view.receiveSnapshot({
      workspaces: [
        {
          id: 1,
          name: "repo",
          cwd: "/repo",
          worktrees: data,
          model: { nodes: [{ pane: 1 }], tabs: [{ id: 1, root: 0 }], revision: 0 },
        },
      ],
      panes: [{ id: 1, workspace: 1, tab: 1, cols: 80, rows: 24, cwd: "/repo" }],
      native_sessions: [
        {
          id: 7,
          workspace: 1,
          provider: "codex",
          cwd: "/repo",
          state,
          agent: { provider: "codex", session: "s", cwd: "/repo", state },
        },
      ],
    });
    view.input_state.attached = true;
    view.worktree_card.workspace = 1;
    view.worktree_card.pinned = true;
    const terminal = new Terminal(140, 30);
    try {
      terminal.feed(view.frame());
      return terminal
        .text()
        .split("\n")
        .find(l => l.includes("topic-1"))!;
    } finally {
      terminal.destroy();
    }
  };
  expect(row("idle")).toMatch(/\.\/\.worktrees\/1 +1 +—/);
  expect(row("working")).toMatch(/\.\/\.worktrees\/1 +1▶ 1 +—/);
});
test("with briefs on, each worktree's second line holds its brief in the state it's in", () => {
  const data = snapshot(5),
    now = Date.UTC(2026, 9, 11),
    linked = data.entries.slice(1);
  for (const [i, e] of linked.entries())
    Object.assign(e, {
      available: true,
      comparison: { ahead: i === 4 ? 0n : 1n, behind: 0n },
      changes: { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, added: 0, removed: 0 },
    });
  const state = new State();
  state.briefs = new Map(
    [
      { path: linked[0].path, label: "Search queries", phase: "ready", current: true },
      { path: linked[1].path, label: "Fuzzy search", phase: "ready", current: false },
      { path: linked[2].path, label: null, phase: "writing", current: true },
      { path: linked[3].path, label: null, phase: "failed", current: true },
    ].map(b => [b.path, b as Brief]),
  );
  const w = new Writer(),
    terminal = new Terminal(140, 30),
    rect = geometry(140, 30, 28, 3, 5, 0, state.lines())!;
  expect(rect.h).toBe(8 + 5 * 2);
  try {
    draw(w, rect, "repo", "/repo", data, state, null, now);
    terminal.feed(w.buffered());
    const lines = terminal.text().split("\n");
    const under = (label: string) => lines[lines.findIndex(l => l.includes(label)) + 1];
    expect(under("topic-0")).toContain("Search queries");
    expect(under("topic-1")).toContain("Fuzzy search  · out of date");
    expect(under("topic-2")).toContain("...");
    expect(under("topic-3")).toContain("Brief failed");
    expect(under("topic-4")).toContain("Nothing beyond main");
    expect(lines.join("\n")).toContain("hold ⌫ remove · r refresh · Esc close");
    // The selected row's hit area covers both its lines.
    state.select(linked[0].path);
    expect(state.hit(data, rect, rect.x + 4, rect.y + 6)).toBe(linked[0].path);
    expect(state.hit(data, rect, rect.x + 4, rect.y + 7)).toBe(linked[1].path);
  } finally {
    terminal.destroy();
  }
});
test("r asks the daemon to brief the overview's worktrees again", async () => {
  const requests: any[] = [];
  const view = new Controller({
    request: (async (op: string, fields: any) => {
      requests.push({ op, ...Object(fields) });
      return { ok: true };
    }) as any,
  });
  view.receiveSnapshot({
    workspaces: [
      { id: 1, name: "repo", cwd: "/repo", worktrees: snapshot(2), model: { nodes: [], tabs: [], revision: 0 } },
    ],
    panes: [],
    native_sessions: [],
  });
  view.input_state.attached = true;
  view.worktree_card.workspace = 1;
  view.worktree_card.pinned = true;
  await view.input(Buffer.from("r"));
  expect(requests.filter(r => r.op === "worktree.brief")).toEqual([{ op: "worktree.brief", workspace: 1 }]);
});
test("a narrow card drops age, then the comparison, then the last edit", () => {
  const names = (width: number) => Object.keys(columnsFor(width).x).sort();
  expect(names(100)).toEqual(["age", "agents", "changes", "edited", "main"]);
  expect(names(88)).toEqual(["age", "agents", "changes", "edited", "main"]);
  expect(names(80)).toEqual(["agents", "changes", "edited", "main"]);
  expect(names(70)).toEqual(["agents", "changes", "edited"]);
  expect(names(60)).toEqual(["agents", "changes"]);
  for (const width of [100, 88, 80, 70, 60]) expect(columnsFor(width).room).toBeGreaterThanOrEqual(24);
});
test("paths read from the main checkout, a temporary directory or home", () => {
  expect(displayPath("/repo/.claude/worktrees/a", "/repo")).toBe("./.claude/worktrees/a");
  expect(displayPath("/dev/repo-topic", "/dev/repo")).toBe("../repo-topic");
  const tmp = tmpdir().replace(/\/+$/, "");
  expect(displayPath(join(realpathSync(tmp), "wt", "a"), "/repo")).toBe(`${tmp === "/tmp" ? "/tmp" : "$TMPDIR"}/wt/a`);
  expect(displayPath(join(realpathSync("/tmp"), "x", "a"), "/repo")).toBe("/tmp/x/a");
  expect(displayPath(join(homedir(), "src", "a"), "/repo")).toBe("~/src/a");
});
test("the table renders unknown values distinctly and retains selection by checkout path", () => {
  const data = snapshot(20),
    state = new State(),
    rect = geometry(100, 30, 28, 3, 20)!;
  data.entries[1].available = true;
  data.entries[1].comparison = { ahead: 0n, behind: 2n };
  data.entries[1].changes = { total: 0, staged: 0, modified: 0, untracked: 0, conflicted: 0, added: 0, removed: 0 };
  const w = new Writer();
  draw(w, rect, "repo", "/repo", data, state);
  const terminal = new Terminal(100, 30);
  try {
    terminal.feed(w.buffered());
    const text = terminal.text();
    for (const label of [
      "20 worktrees",
      "AGENTS",
      "EDITED",
      "UNCOMMITTED CHANGES",
      "Clean",
      "Missing",
      "./.worktrees/0",
    ])
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
    request: transport(async () => {
      throw Error("UnexpectedRequest");
    }).request,
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

/** A viewer with the overview open on two worktrees, and the daemon's requests. */
async function removing() {
  const requests: any[] = [];
  const view = new Controller({
    request: transport(async (op, fields) => {
      requests.push({ op, ...Object(fields) });
      return op === "worktree.remove" ? { ok: true, removal: 7 } : { ok: true };
    }).request,
  });
  const report = (worktrees: Snapshot, worktree_removal: unknown) =>
    view.receiveSnapshot({
      workspaces: [
        { id: 1, name: "repo", cwd: "/repo", worktrees, worktree_removal, model: { nodes: [], tabs: [], revision: 0 } },
      ],
      panes: [],
    });
  report(snapshot(2), null);
  await view.perform({ name: "worktrees", value: 1 });
  const screen = () => {
    const terminal = new Terminal(100, 30);
    try {
      terminal.feed(view.frame());
      return terminal.text();
    } finally {
      terminal.destroy();
    }
  };
  /** Holds ⌫ until the hold completes, as key repeat would. */
  const hold = async () => {
    await (view as any).key(127);
    clock.advance(300);
    for (let i = 0; i < 60 && view.worktree_card.removal.phase === "held"; i++) {
      await (view as any).key(127);
      if (i === 10) expect(screen()).toContain("Removing topic-0 · branch kept");
      clock.advance(50);
    }
  };
  return { view, requests, report, screen, hold };
}
test("holding ⌫ removes the selected worktree; the footer says what goes", async () => {
  const { view, requests, report, screen, hold } = await removing();
  try {
    expect(screen()).toContain("hold ⌫ remove");
    await hold();
    expect(requests.filter(r => r.op === "worktree.remove")).toEqual([
      { op: "worktree.remove", workspace: 1, path: "/repo/.worktrees/0" },
    ]);
    expect(view.worktree_card.removal.phase).toBe("removing");
    // A report from an earlier removal is not this one's.
    report(snapshot(2), { id: 6, path: "/repo/.worktrees/0", phase: "stopped", error: "" });
    await view.expireInput();
    expect(view.worktree_card.removal.phase).toBe("removing");
    const gone = snapshot(2);
    gone.entries.splice(1, 1);
    report(gone, { id: 7, path: "/repo/.worktrees/0", phase: "done", error: "" });
    await view.expireInput();
    expect(view.worktree_card.removal.phase).toBe("removed");
    expect(view.worktree_card.selected).toBe("/repo/.worktrees/1");
    // The key still down doesn't start on the next worktree.
    for (let i = 0; i < 20; i++) {
      await (view as any).key(127);
      clock.advance(50);
    }
    expect(view.worktree_card.removal.target?.path).toBe("/repo/.worktrees/0");
  } finally {
    clock.reset();
  }
});
test("a big worktree shows Git still deleting it once the ending has played, and Esc stops it", async () => {
  const { view, requests, report, screen, hold } = await removing();
  try {
    await hold();
    report(snapshot(2), { id: 7, path: "/repo/.worktrees/0", phase: "deleting", error: "" });
    // During the ending, the row comes apart; after it, Git is still at work.
    expect(screen()).not.toContain("Deleting...");
    clock.advance(3000);
    await view.expireInput();
    const text = screen();
    expect(text).toContain("Deleting...");
    expect(text).toContain("━━━━━━━━");
    expect(text).toContain("Removing topic-0 · Esc stop");
    // Esc stops the deletion rather than closing the overview.
    await (view as any).key(27);
    expect(requests.at(-1)).toEqual({ op: "worktree.stop", workspace: 1 });
    expect(view.worktreeDetail()).toBe(1);
    report(snapshot(2), { id: 7, path: "/repo/.worktrees/0", phase: "stopped", error: "" });
    await view.expireInput();
    expect(view.worktree_card.removal.phase).toBe("stopped");
    expect(screen()).toContain("Stopped removing topic-0 · some of its files may be gone");
    expect(screen()).toContain("topic-0");
    // Esc again closes it.
    await (view as any).key(27);
    expect(view.worktreeDetail()).toBeNull();
  } finally {
    clock.reset();
  }
});
test("after a removal the cursor stays on its line while the row below moves up to it", () => {
  const before = snapshot(3),
    after = { ...before, entries: before.entries.filter(e => e.path !== "/repo/.worktrees/1") },
    state = new State(),
    hold = state.removal,
    linked = before.entries.slice(1),
    t = worktreeRemoval.target(1, linked[1], 1, 0);
  state.selected = linked[1].path;
  let now = 0;
  hold.press(now, t, "dust");
  for (now = 250; !hold.press(now, t, "dust"); now += 50);
  const end = now + worktreeRemoval.finale_ms.dust;
  hold.settle(now + 100, null);
  state.select(linked[2].path);
  const frame = (at: number) => {
    const shown = listing(after, state, at),
      rect = geometry(100, 30, 28, 3, shown.entries.length, shown.closed)!,
      w = new Writer(),
      terminal = new Terminal(100, 30);
    try {
      draw(w, rect, "repo", "/repo", after, state, null, at);
      terminal.feed(w.buffered());
      return { lines: terminal.text().split("\n"), row: rect.y + 6, h: rect.h };
    } finally {
      terminal.destroy();
    }
  };
  // While the ending plays, no row has the cursor; the row before has its own.
  const playing = frame(end - 10);
  expect(playing.lines.some(l => l.includes("›"))).toBe(false);
  expect(playing.lines[playing.row - 1]).toContain("topic-0");
  // Then the one-line row closes, and topic-2 moves up to the cursor on its line.
  const closed = frame(end);
  expect(closed.lines[closed.row]).toContain("› topic-2");
  expect(closed.h).toBe(playing.h - 1);
});

function browsing() {
  const requests: any[] = [];
  const data = snapshot(2);
  data.agents = [{ target: { native: 7 }, path: data.entries[2].path, source: "write", stale: false }];
  // A shell in the only tab, and a daemon that opens resumed agents asleep in new tabs.
  const model = { nodes: [{ pane: 1 }] as any[], tabs: [{ id: 1, root: 0 }], revision: 0 },
    state = {
      workspaces: [{ id: 1, name: "repo", cwd: "/repo", worktrees: data, model }],
      panes: [{ id: 1, workspace: 1, tab: 1, cols: 80, rows: 24, cwd: "/repo" }] as any[],
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
    };
  const view = new Controller({
    request: transport(async (op, fields: any) => {
      requests.push({ op, ...Object(fields) });
      if (op === "session.snapshot") return state;
      const resume = fields?.command?.["agent.resume"];
      if (!resume?.asleep) throw Error("TestResume");
      const id = state.panes.length + 1,
        agent = { provider: resume.provider, session: resume.session, name: resume.name, cwd: resume.cwd };
      model.nodes.push({ pane: id });
      model.tabs.push({ id, root: model.nodes.length - 1 });
      model.revision += 1;
      state.panes.push({ id, workspace: 1, tab: id, cols: 80, rows: 24, cwd: resume.cwd, dormant: true, agent });
      return { result: { pane: id, workspace: 1 } };
    }).request,
  });
  view.receiveSnapshot(state);
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
    expect(entries.filter((e: any) => "asleep" in e.target)).toHaveLength(3);
    expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
    await view.input(Buffer.from("\x1b[27u"));
    expect(view.worktreeDetail()).toBeNull();
  }
  const { view } = browsing();
  await view.input(Buffer.from("\x1b"));
  await view.input(Buffer.from("[B"));
  expect(view.worktree_card.selected).toBe("/repo/.worktrees/1");
});
test("⌫ or Delete on a hovered overview starts removing rather than closing it", async () => {
  for (const key of ["\x7f", "\x08", "\x1b[3~"]) {
    const { view, requests } = browsing();
    await view.input(Buffer.from(key));
    expect(view.worktreeDetail()).toBe(1);
    expect(view.worktree_card.pinned).toBe(true);
    expect(view.worktree_card.removal.phase).toBe("held");
    expect(view.worktree_card.removal.target?.path).toBe("/repo/.worktrees/0");
    expect(requests).toHaveLength(0);
  }
});
test("Enter on a worktree with no agent opens the agent picker there", async () => {
  const view = new Controller({ request: transport(async () => ({})).request });
  view.receiveSnapshot({
    workspaces: [
      { id: 1, name: "repo", cwd: "/repo", worktrees: snapshot(2), model: { nodes: [], tabs: [], revision: 0 } },
    ],
    panes: [],
  });
  await view.perform({ name: "worktrees", value: 1 });
  const terminal = new Terminal(100, 30);
  try {
    terminal.feed(view.frame());
    expect(terminal.text()).toContain("Enter new agent");
  } finally {
    terminal.destroy();
  }
  await (view as any).key(13);
  expect(view.worktreeDetail()).toBeNull();
  expect(view.agent_launcher?.cwd).toBe("/repo/.worktrees/0");
});
test("a ghost previews a worktree's newest conversations as agents; Enter brings them back asleep", async () => {
  const { view, requests } = browsing(),
    terminal = new Terminal(100, 30),
    path = "/repo/.worktrees/0";
  try {
    let entries = (view as any).sidebarEntries();
    expect(entries[0].worktree.ghost).toBe(true);
    expect(entries[0].enter).toBe(0);
    view.worktree_agents.appeared_at -= 300;
    expect((view as any).sidebarEntries()[0].enter).toBeNull();
    expect(entries.filter((e: any) => "asleep" in e.target).map((e: any) => e.name)).toEqual([
      "Recent 0",
      "Recent 1",
      "Recent 2",
    ]);
    expect(entries.some((e: any) => e.name === "Search agent")).toBe(true);
    terminal.feed(view.frame());
    const text = terminal.text();
    expect(text).toContain("Recent 0");
    expect(text).not.toContain("Recent 3");
    expect(text).not.toContain("more");
    expect(text).toContain("Search agent");
    expect(text).toContain("╭┄┄┄");
    expect(text).toContain("Enter resume agents");
    expect(text).toContain("⌥ topic-0");
    await view.input(Buffer.from("\r"));
    expect(view.worktreeDetail()).toBeNull();
    expect(requests.filter(r => r.op === "session.command").map(r => r.command)).toEqual(
      [0, 1, 2].map(i => ({
        "agent.resume": {
          workspace: 1,
          cwd: path,
          provider: "claude",
          session: `session-${i}`,
          asleep: true,
          name: `Recent ${i}`,
        },
      })),
    );
    entries = (view as any).sidebarEntries();
    expect(entries.some((e: any) => e.worktree?.ghost || "asleep" in e.target)).toBe(false);
    const group = entries.findIndex((e: any) => e.target.worktree === path);
    expect(entries.slice(group + 1, group + 4).map((e: any) => [e.target, e.name])).toEqual([
      [{ pane: 2 }, "Recent 0"],
      [{ pane: 3 }, "Recent 1"],
      [{ pane: 4 }, "Recent 2"],
    ]);
    // They stay asleep: focus stays on the shell.
    expect(view.focused()?.id).toBe(1);
  } finally {
    terminal.destroy();
  }
});
test("clicking a ghost's agent brings its group back and wakes it; entering a live group focuses its agent", async () => {
  const { view, requests } = browsing();
  const entries = (view as any).sidebarEntries();
  await view.perform({ name: "worktree-agent", value: entries.findIndex((e: any) => e.target.asleep === "session-1") });
  expect(requests.filter(r => r.command?.["agent.resume"]?.asleep)).toHaveLength(3);
  expect(view.focused()?.id).toBe(3);
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
  expect(entries.some((e: any) => "asleep" in e.target)).toBe(false);
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
  await (view as any).enterWorktree({ workspace: 1, path });
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
      request: transport(async (op, fields: any) => {
        if (fields?.command?.["pane.close"]) closed.push(fields.command["pane.close"].target);
        return op === "session.snapshot" ? state : {};
      }).request,
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
test("the card closes once the pointer leaves it, its badge and the triangle between, pinned or not", async () => {
  const { view } = browsing(),
    side = view.sidebarView([]),
    badge = worktreeBadge(side, view.workspaceEntries(), 1)!,
    rect = (view as any).worktreeRect(),
    move = (x: number, y: number) => view.input(Buffer.from(`\x1b[<35;${x + 1};${y + 1}M`));
  expect(rect.x).toBe(side.width + 2);
  expect(between(rect, badge, badge.x, badge.y)).toBe(true);
  expect(between(rect, badge, badge.x, badge.y + 1)).toBe(false);
  expect(between(rect, badge, rect.x - 1, rect.y + rect.h / 2)).toBe(true);
  await view.perform({ name: "worktrees", value: 1 });
  expect(view.worktree_card.pinned).toBe(true);
  await move(badge.x + badge.w, badge.y + 1);
  await move(rect.x + 2, rect.y + 3);
  expect(view.worktreeDetail()).toBe(1);
  await move(5, side.middle() + 3);
  expect(view.worktreeDetail()).toBeNull();
  expect(view.worktree_card.pinned).toBe(false);
});
test("callout geometry keeps the agent pane and source badge uncovered", () => {
  const ws = workspaceEntry({ id: 1, name: "repo", cwd: "/repo", active: true, worktrees: snapshot(2) });
  const side = View.init(120, 38, true, 0, 0).withWorkspaces(1, 0),
    badge = worktreeBadge(side, [ws], 1)!,
    rect = geometry(120, 38, side.width, badge.y, 2)!;
  expect(rect.x).toBeGreaterThan(side.width);
  expect(rect.contains(badge.x, badge.y)).toBe(false);
  expect(rect.h).toBe(10);
});
