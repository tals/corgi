import { expect, test } from "bun:test";
import * as agents from "./worktree_agents";
import * as sidebar from "./sidebar";
import { State as SidebarRows } from "./sidebar_rows";
import { parseInventory } from "./trackers/worktrees";
import { historyEntry } from "./launcher_resume";
import type { Snapshot } from "./worktrees";

function snapshot(): Snapshot {
  return {
    common_dir: "/repo/.git",
    base: null,
    agents: [],
    stale: false,
    entries: parseInventory(
      "worktree /repo\0branch refs/heads/main\0\0worktree /repo/.worktrees/one\0branch refs/heads/one\0\0worktree /repo/.worktrees/two\0branch refs/heads/two\0\0",
    ),
  };
}
test("primary agents stay direct; confirmed writes take precedence over cwd and reads", () => {
  const data = snapshot(),
    state = new agents.State(),
    main = sidebar.entry({ target: { pane: 1 }, cwd: "/repo", provider: "codex" }),
    moved = sidebar.entry({ target: { pane: 2 }, cwd: "/repo/.worktrees/one", provider: "claude" });
  data.agents = [
    { target: moved.target as { pane: number }, path: data.entries[2].path, source: "write", stale: false },
  ];
  const rows = agents.grouped(data, 1, [main, moved], state);
  expect(rows[0]).toBe(main);
  expect(rows[1].target).toEqual({ workspace: 1, worktree: "/repo/.worktrees/two" });
  expect(rows[2].target).toEqual({ pane: 2 });
  expect(agents.grouped(null, 1, [main], state)).toEqual([main]);
});
test("a new agent starts where the list puts the one beside it, its own folder when that's inside", () => {
  const data = snapshot(),
    one = data.entries[1].path,
    two = data.entries[2].path;
  // Started on main, writing in one: one's root.
  data.agents = [{ target: { pane: 1 }, path: one, source: "write", stale: false }];
  expect(agents.folder(data, { pane: 1 }, "/repo/src")).toBe(one);
  // Its own folder when that's in the worktree the list puts it under.
  expect(agents.folder(data, { pane: 1 }, `${one}/src`)).toBe(`${one}/src`);
  // A worktree comes before main, as the list shows it under the worktree.
  data.agents = [
    { target: { pane: 1 }, path: "/repo", source: "write", stale: false },
    { target: { pane: 1 }, path: two, source: "write", stale: false },
  ];
  expect(agents.folder(data, { pane: 1 }, "/repo")).toBe(two);
  // A direct row on main, though its folder is a worktree's.
  data.agents = [{ target: { pane: 1 }, path: "/repo", source: "write", stale: false }];
  expect(agents.folder(data, { pane: 1 }, `${one}/src`)).toBe("/repo");
  // With no association, its folder, in a repository or not.
  expect(agents.folder(data, { pane: 2 }, `${two}/docs`)).toBe(`${two}/docs`);
  expect(agents.folder(data, { pane: 2 }, "/tmp")).toBe("/tmp");
  expect(agents.folder(null, { pane: 2 }, "/repo/src")).toBe("/repo/src");
});
test("each worktree counts its agents by state, as its header does, ended ones as quiet", () => {
  const data = snapshot(),
    working = sidebar.entry({ target: { pane: 1 }, cwd: "/repo/.worktrees/one", provider: "claude", state: "working" }),
    idle = sidebar.entry({ target: { pane: 2 }, cwd: "/repo/.worktrees/one/src", provider: "codex", state: "idle" }),
    asking = sidebar.entry({
      target: { pane: 4 },
      cwd: "/repo/.worktrees/one",
      provider: "claude",
      state: "working",
      attention: "needs_input",
    }),
    done = sidebar.entry({ target: { pane: 3 }, cwd: "/repo/.worktrees/two", provider: "codex", state: "done" });
  const counts = agents.counts(data, [working, idle, asking, done]);
  expect(counts.get("/repo/.worktrees/one")).toEqual({ agents: 3, working: 1, attention: 1 });
  expect(counts.get("/repo/.worktrees/two")).toEqual({ agents: 1, working: 0, attention: 0 });
  const rows = agents.grouped(data, 1, [working, idle, asking, done], new agents.State());
  expect(rows.find(e => "worktree" in e.target)!.group).toMatchObject(counts.get("/repo/.worktrees/one")!);
  // An agent whose session ended stays under its checkout until its pane goes.
  expect(rows.at(-1)).toMatchObject({ target: { pane: 3 }, worktree: { path: "/repo/.worktrees/two" } });
});
test("a ghost with no agents shows the newest conversations no pane has open, as agents", () => {
  const data = snapshot(),
    state = new agents.State(),
    selection = { workspace: 1, path: data.entries[1].path };
  const history = [
    ["old", "/repo/.worktrees/one/src", 1],
    ["other", "/repo/.worktrees/one-more", 8],
    ["main", "/repo", 9],
    ["open", selection.path, 10],
    ["new", selection.path, 5],
    ["older", selection.path, 0],
    ["oldest", selection.path, -1],
  ].map(([session, cwd, updated_at]) => historyEntry({ provider: "codex", session, cwd, updated_at, title: session }));
  const asleep = agents.conversations(data, selection.path, history, new Set(["codex:open"]));
  expect(asleep.map(e => e.session)).toEqual(["new", "old", "older"]);
  const rows = agents.group(data, selection, [], asleep, state, true);
  expect(rows[0].group.agents).toBe(3);
  expect(rows.slice(1).map(e => [e.target, e.name, e.state])).toEqual([
    [{ asleep: "new", provider: "codex" }, "new", "idle"],
    [{ asleep: "old", provider: "codex" }, "old", "idle"],
    [{ asleep: "older", provider: "codex" }, "older", "idle"],
  ]);
  // In the list, a group lasts only while it has agents.
  expect(agents.grouped(data, 1, [], state)).toHaveLength(0);
  // With no conversations either, there is no group to show, not even a header.
  expect(agents.group(data, selection, [], [], state, true)).toEqual([]);
});
test("an agent associated with two checkouts keeps distinct rows during sidebar reconciliation", () => {
  const data = snapshot(),
    state = new agents.State(),
    live = sidebar.entry({ target: { pane: 1 }, provider: "codex" });
  data.agents = data.entries.slice(1).map(e => ({ target: { pane: 1 }, path: e.path, source: "write", stale: false }));
  const rows = agents.grouped(data, 1, [live], state),
    animated = new SidebarRows();
  const paths = animated
    .update(1, rows, [], 0)
    .filter(e => sidebar.isAgent(e.target))
    .map(e => e.worktree!.path);
  expect(paths).toEqual(data.entries.slice(1).map(e => e.path));
});
test("a folded group keeps only its header, which stands in for a focused agent; a ghost never folds", () => {
  const data = snapshot(),
    state = new agents.State(),
    selection = { workspace: 1, path: data.entries[1].path },
    live = sidebar.entry({ target: { pane: 1 }, cwd: selection.path, provider: "codex", focused: true });
  data.entries[1].branch = "refs/heads/worktree-one";
  let rows = agents.grouped(data, 1, [live], state);
  expect(rows.map(e => e.target)).toEqual([{ workspace: 1, worktree: selection.path }, { pane: 1 }]);
  expect(rows[0].name).toBe("one");
  expect(rows[0].focused).toBe(false);
  state.folded.add(agents.key(selection));
  rows = agents.grouped(data, 1, [live], state);
  expect(rows).toHaveLength(1);
  expect(rows[0].group).toMatchObject({ agents: 1, folded: true });
  expect(rows[0].focused).toBe(true);
  expect(agents.group(data, selection, [live], [], state, true)).toHaveLength(2);
});
