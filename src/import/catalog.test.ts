import { test, expect } from "bun:test";
import { workspace, pane, recentFirst, copyWorkspaces } from "./catalog";
import { max_panes } from "../layout";
test("tmux groups sort by recent activity across sockets", () => {
  const groups = [
    workspace({ id: "$0", name: "old", socket: "a", activity: 10, tabs: [] }),
    workspace({ id: "$0", name: "new", socket: "b", activity: 30, tabs: [] }),
    workspace({
      id: "$1",
      name: "middle",
      socket: "a",
      activity: 20,
      tabs: [],
    }),
  ].sort(recentFirst);
  expect(groups.map(w => w.name)).toEqual(["new", "middle", "old"]);
});
test("copy text fits the RPC budget at full pane capacity without changing discovery", () => {
  const panes = Array.from({ length: max_panes }, () =>
      pane({
        id: "%0",
        name: "tig",
        screen: "\\".repeat(65536),
        history: "\\".repeat(65536),
        restart_command: "\\".repeat(2048),
      }),
    ),
    out = copyWorkspaces([
      workspace({
        id: "$0",
        name: "session",
        tabs: [{ id: "@0", name: "tab", panes, nodes: [] }],
      }),
    ]);
  expect(
    Buffer.byteLength(
      JSON.stringify({
        op: "onboarding.copy",
        source: "tmux",
        workspaces: out,
      }),
    ),
  ).toBeLessThan(1024 * 1024);
  expect(panes[0].screen.length).toBe(65536);
  expect(out[0].tabs[0].panes[0].screen.length).toBeLessThan(panes[0].screen.length);
});
