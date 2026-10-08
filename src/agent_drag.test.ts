import { test, expect } from "bun:test";
import { Drag } from "./agent_drag";
import { View, entry as sidebarEntry, type Entry } from "./sidebar";
test("agent drop respects grouped boundaries, scrolling, and stale rows", () => {
  const entry: Entry = sidebarEntry({ name: "", target: { pane: 1 }, provider: "claude", state: "idle", attention: "none" }),
    entries = Array.from({ length: 6 }, () => ({ ...entry }));
  entries[0].target = { group: 1 };
  entries[2].target = { pane: 2 };
  entries[3].target = { group: 2 };
  entries[4].target = { pane: 3 };
  entries[5].target = { native: 1 };
  const view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 1, 5, 17, 1, 1);
  drag.dragging = true;
  drag.update(view, 1, 5, 20);
  expect(drag.drop?.index).toBe(3);
  expect(drag.drop?.y).toBe(20);
  drag.update(view, 1, 5, 22);
  expect(drag.drop).toBeNull();
  drag.update(view, 1, 80, 20);
  expect(drag.drop).toBeNull();
  const scrolled = View.init(100, 18, true, 2, entries.length).withEntries(
    entries,
  );
  expect(scrolled.agentDrop(5, scrolled.middle() + 2)?.index).toBe(2);
  entries[2].exit = { frame_ms: 0, progress: 0.5 };
  expect(drag.valid(view, 1)).toBe(false);
});
