import { test, expect } from "bun:test";
import { Drag } from "./workspace_drag";
import { View } from "./sidebar";
test("workspace drop follows row midpoints, scrolling, and stale lists", () => {
  const ids = [1, 2, 3, 4],
    view = View.init(100, 30, true, 0, 0).withWorkspaces(ids.length, 0),
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
