import * as viewerRef from "./viewer_ref";
import { test, expect } from "bun:test";
import { Drag } from "./workspace_drag";
import { View } from "./sidebar";
test("workspace drop follows row midpoints, scrolling, and stale lists", () => {
  const ids = [1, 2, 3, 4].map(id => viewerRef.workspace(1, id)),
    view = View.init(100, 30, true, 0, 0, 12).withWorkspaces(ids.length, 0),
    drag = Drag.init(view, ids, 0, 5, 2);
  drag.update(view, ids, 5, 9);
  expect(drag.drop).toBeNull();
  drag.dragging = true;
  drag.update(view, ids, 5, 9);
  expect(drag.drop?.index).toBe(2);
  expect(drag.preview).toBe(1);
  expect(drag.before()).toBe(ids[2]);
  drag.update(view, ids, 5, 10);
  expect(drag.drop?.index).toBe(3);
  drag.update(view, ids, 5, 3);
  expect(drag.drop).toBeNull();
  drag.update(view, ids, 80, 9);
  expect(drag.drop).toBeNull();
  const scrolled = view.withWorkspaces(ids.length, 1);
  drag.update(scrolled, ids, 5, 10);
  expect(drag.drop?.index).toBe(4);
  expect(drag.before()).toBe(ids[0]);
  expect(drag.valid(view, ids.slice(0, 3))).toBe(false);
});
test("a drop the predicate refuses shows nowhere", () => {
  const ids = [1, 2, 3, 4].map(id => viewerRef.workspace(1, id)),
    view = View.init(100, 30, true, 0, 0, 12).withWorkspaces(ids.length, 0),
    drag = Drag.init(view, ids, 0, 5, 2),
    asked: [viewerRef.Workspace, viewerRef.Workspace][] = [];
  // Rows 3 and 4 are stale: nothing lands past row 3.
  const allowed = (source: viewerRef.Workspace, before: viewerRef.Workspace) => {
    asked.push([source, before]);
    return before === ids[1] || before === ids[2];
  };
  drag.dragging = true;
  drag.update(view, ids, 5, 9, allowed);
  expect([drag.drop?.index, drag.preview]).toEqual([2, 1]);
  drag.update(view, ids, 5, 10, allowed);
  expect([drag.drop, drag.preview]).toEqual([null, null]);
  expect(drag.before()).toBeNull();
  const scrolled = view.withWorkspaces(ids.length, 1);
  drag.update(scrolled, ids, 5, 10, allowed);
  expect(drag.drop).toBeNull();
  expect(asked).toEqual([
    [ids[0], ids[2]],
    [ids[0], ids[3]],
    [ids[0], ids[0]],
  ]);
});
