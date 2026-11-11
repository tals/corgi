import * as viewerRef from "./viewer_ref";
import { expect, test } from "bun:test";
import { State, initial } from "./sidebar_focus";
import { entry } from "./sidebar";

const agents = () => [
  entry({ target: viewerRef.pane(0, 1) }),
  entry({ target: viewerRef.pane(0, 2), focused: true }),
  entry({ target: viewerRef.pane(0, 9), exit: { frame_ms: 0, progress: 0.5 } }),
  entry({ target: viewerRef.pane(0, 3) }),
];

test("archived header is a keyboard stop before the expanded workspaces", () => {
  const s = new State({ workspace: viewerRef.workspace(1, 2) });
  s.move(
    [2].map(id => viewerRef.workspace(1, id)),
    [],
    true,
    1,
  );
  expect(s.cursor).toEqual({ archived: true });
  expect(s.section()).toBe("workspaces");
  s.move(
    [2, 3, 4].map(id => viewerRef.workspace(1, id)),
    [],
    true,
    1,
  );
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 3) });
  s.move(
    [2, 3, 4].map(id => viewerRef.workspace(1, id)),
    [],
    false,
    1,
  );
  expect(s.cursor).toEqual({ archived: true });
  s.move(
    [2].map(id => viewerRef.workspace(1, id)),
    [],
    true,
    1,
  );
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 2) });
  s.move(
    [2].map(id => viewerRef.workspace(1, id)),
    [],
    false,
    1,
  );
  expect(s.cursor).toEqual({ archived: true });
  const workspaces = [{ id: viewerRef.workspace(1, 2), active: true }];
  expect(s.markWorkspaces(workspaces)[0].active).toBe(false);
  s.reconcile(
    [2].map(id => viewerRef.workspace(1, id)),
    [],
  );
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 2) });
});

test("focus enters on the focused agent, else the first, else the current workspace", () => {
  expect(initial(viewerRef.workspace(1, 7), agents())).toEqual({ entry: viewerRef.pane(0, 2) });
  expect(initial(viewerRef.workspace(1, 7), [entry({ target: viewerRef.pane(0, 1) })])).toEqual({
    entry: viewerRef.pane(0, 1),
  });
  expect(initial(viewerRef.workspace(1, 7), [])).toEqual({ workspace: viewerRef.workspace(1, 7) });
});

test("plain arrows wrap within the cursor's list", () => {
  const list = agents();
  const s = new State({ entry: viewerRef.pane(0, 1) });
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    false,
  );
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 3) });
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 1) });
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  // A closing row is not a stop.
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 3) });
  s.cursor = { workspace: viewerRef.workspace(1, 5) };
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 4) });
});

test("prefixed arrows cross to the current workspace and back to the agent left", () => {
  const list = agents();
  const s = new State({ entry: viewerRef.pane(0, 3) });
  // Past either list, nothing moves, and focus may go on from the sidebar.
  expect(s.cross(viewerRef.workspace(1, 5), list, false)).toBe(false);
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 3) });
  expect(s.cross(viewerRef.workspace(1, 5), list, true)).toBe(true);
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 5) });
  expect(s.cross(viewerRef.workspace(1, 5), list, true)).toBe(false);
  expect(s.cursor).toEqual({ workspace: viewerRef.workspace(1, 5) });
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    false,
  );
  s.cross(viewerRef.workspace(1, 5), list, false);
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 3) });
  // When that row has gone, the focused agent's takes its place.
  s.cross(viewerRef.workspace(1, 5), list, true);
  s.cross(viewerRef.workspace(1, 5), list.slice(0, 2), false);
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 2) });
});

test("a closing row is skipped, and when the cursor's row goes the one in its place takes it", () => {
  const list = agents();
  list[1].exit = { frame_ms: 0, progress: 0.5 };
  const s = new State({ entry: viewerRef.pane(0, 1) });
  s.move(
    [4].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 3) });
  s.reconcile(
    [4].map(id => viewerRef.workspace(1, id)),
    [entry({ target: viewerRef.pane(0, 1) })],
  );
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 1) });
});

test("the cursor's row is the one drawn focused", () => {
  const s = new State({ entry: viewerRef.pane(0, 3) });
  expect(s.mark(agents()).map(e => e.focused)).toEqual([false, false, false, true]);
  const workspaces = [
    { id: viewerRef.workspace(1, 4), active: true },
    { id: viewerRef.workspace(1, 5), active: false },
  ];
  expect(s.markWorkspaces(workspaces)).toBe(workspaces);
  s.cursor = { workspace: viewerRef.workspace(1, 5) };
  expect(s.mark(agents()).some(e => e.focused)).toBe(false);
  expect(s.markWorkspaces(workspaces).map(ws => ws.active)).toEqual([false, true]);
});

test("a drawer keeps the cursor in its own list", () => {
  const list = agents();
  const s = new State({ workspace: viewerRef.workspace(1, 5) }, "agents");
  s.move(
    [4, 5].map(id => viewerRef.workspace(1, id)),
    list,
    true,
  );
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 2) });
  expect(s.cross(viewerRef.workspace(1, 5), list, true)).toBe(false);
  expect(s.cursor).toEqual({ entry: viewerRef.pane(0, 2) });
  const workspaces = new State({ workspace: viewerRef.workspace(1, 5) }, "workspaces");
  workspaces.cross(viewerRef.workspace(1, 5), list, false);
  expect(workspaces.cursor).toEqual({ workspace: viewerRef.workspace(1, 5) });
});
