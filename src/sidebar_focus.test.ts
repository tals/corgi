import { expect, test } from "bun:test";
import { State, initial } from "./sidebar_focus";
import { entry } from "./sidebar";

const agents = () => [
  entry({ target: { pane: 1 } }),
  entry({ target: { pane: 2 }, focused: true }),
  entry({ target: { pane: 9 }, exit: { frame_ms: 0, progress: 0.5 } }),
  entry({ target: { pane: 3 } }),
];

test("focus enters on the focused agent, else the first, else the current workspace", () => {
  expect(initial(7, agents())).toEqual({ entry: { pane: 2 } });
  expect(initial(7, [entry({ target: { pane: 1 } })])).toEqual({ entry: { pane: 1 } });
  expect(initial(7, [])).toEqual({ workspace: 7 });
});

test("plain arrows wrap within the cursor's list", () => {
  const list = agents();
  const s = new State({ entry: { pane: 1 } });
  s.move([4, 5], list, false);
  expect(s.cursor).toEqual({ entry: { pane: 3 } });
  s.move([4, 5], list, true);
  expect(s.cursor).toEqual({ entry: { pane: 1 } });
  s.move([4, 5], list, true);
  s.move([4, 5], list, true);
  // A closing row is not a stop.
  expect(s.cursor).toEqual({ entry: { pane: 3 } });
  s.cursor = { workspace: 5 };
  s.move([4, 5], list, true);
  expect(s.cursor).toEqual({ workspace: 4 });
});

test("prefixed arrows cross to the current workspace and back to the agent left", () => {
  const list = agents();
  const s = new State({ entry: { pane: 3 } });
  s.cross(5, list, false);
  expect(s.cursor).toEqual({ entry: { pane: 3 } });
  s.cross(5, list, true);
  expect(s.cursor).toEqual({ workspace: 5 });
  s.cross(5, list, true);
  expect(s.cursor).toEqual({ workspace: 5 });
  s.move([4, 5], list, false);
  s.cross(5, list, false);
  expect(s.cursor).toEqual({ entry: { pane: 3 } });
  // When that row has gone, the focused agent's takes its place.
  s.cross(5, list, true);
  s.cross(5, list.slice(0, 2), false);
  expect(s.cursor).toEqual({ entry: { pane: 2 } });
});

test("a closing row is skipped, and when the cursor's row goes the one in its place takes it", () => {
  const list = agents();
  list[1].exit = { frame_ms: 0, progress: 0.5 };
  const s = new State({ entry: { pane: 1 } });
  s.move([4], list, true);
  expect(s.cursor).toEqual({ entry: { pane: 3 } });
  s.reconcile([4], [entry({ target: { pane: 1 } })]);
  expect(s.cursor).toEqual({ entry: { pane: 1 } });
});

test("the cursor's row is the one drawn focused", () => {
  const s = new State({ entry: { pane: 3 } });
  expect(s.mark(agents()).map(e => e.focused)).toEqual([false, false, false, true]);
  const workspaces = [
    { id: 4, active: true },
    { id: 5, active: false },
  ];
  expect(s.markWorkspaces(workspaces)).toBe(workspaces);
  s.cursor = { workspace: 5 };
  expect(s.mark(agents()).some(e => e.focused)).toBe(false);
  expect(s.markWorkspaces(workspaces).map(ws => ws.active)).toEqual([false, true]);
});

test("a drawer keeps the cursor in its own list", () => {
  const list = agents();
  const s = new State({ workspace: 5 }, "agents");
  s.move([4, 5], list, true);
  expect(s.cursor).toEqual({ entry: { pane: 2 } });
  s.cross(5, list, true);
  expect(s.cursor).toEqual({ entry: { pane: 2 } });
  const workspaces = new State({ workspace: 5 }, "workspaces");
  workspaces.cross(5, list, false);
  expect(workspaces.cursor).toEqual({ workspace: 5 });
});
