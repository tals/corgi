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
  const rows = agents.grouped(data, 1, [main, moved], [], new Set(), state);
  expect(rows[0]).toBe(main);
  expect(rows[1].target).toEqual({ workspace: 1, worktree: "/repo/.worktrees/two" });
  expect(rows[2].target).toEqual({ pane: 2 });
  expect(agents.grouped(null, 1, [main], [], new Set(), state)).toEqual([main]);
});
test("recent sessions match checkout boundaries, exclude open sessions and retain newest first", () => {
  const data = snapshot(),
    state = new agents.State(),
    selection = { workspace: 1, path: data.entries[1].path };
  const history = [
    ["old", "/repo/.worktrees/one/src", 1],
    ["other", "/repo/.worktrees/one-more", 8],
    ["main", "/repo", 9],
    ["open", selection.path, 10],
    ["new", selection.path, 5],
  ].map(([session, cwd, updated_at]) => historyEntry({ provider: "codex", session, cwd, updated_at }));
  const rows = agents.group(data, selection, [], history, new Set(["codex:open"]), state, true);
  expect(rows.filter(e => e.recent).map(e => e.recent!.session)).toEqual(["new", "old"]);
  expect(agents.grouped(data, 1, [], history, new Set(), state)).toHaveLength(0);
  state.introduced.set(agents.key(selection), selection);
  expect(agents.grouped(data, 1, [], history, new Set(), state).some(e => "worktree" in e.target)).toBe(true);
});
test("an agent associated with two checkouts keeps distinct rows during sidebar reconciliation", () => {
  const data = snapshot(),
    state = new agents.State(),
    live = sidebar.entry({ target: { pane: 1 }, provider: "codex" });
  data.agents = data.entries.slice(1).map(e => ({ target: { pane: 1 }, path: e.path, source: "write", stale: false }));
  const rows = agents.grouped(data, 1, [live], [], new Set(), state),
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
  let rows = agents.grouped(data, 1, [live], [], new Set(), state);
  expect(rows.map(e => e.target)).toEqual([{ workspace: 1, worktree: selection.path }, { pane: 1 }]);
  expect(rows[0].name).toBe("one");
  expect(rows[0].focused).toBe(false);
  state.folded.add(agents.key(selection));
  rows = agents.grouped(data, 1, [live], [], new Set(), state);
  expect(rows).toHaveLength(1);
  expect(rows[0].group).toMatchObject({ agents: 1, folded: true });
  expect(rows[0].focused).toBe(true);
  expect(agents.group(data, selection, [live], [], new Set(), state, true)).toHaveLength(2);
});
