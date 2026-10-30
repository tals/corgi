import { test, expect } from "bun:test";
import { Drag } from "./agent_drag";
import { View, entry as sidebarEntry, type Entry, type Target } from "./sidebar";
const row = (target: Target, section: Entry["section"]): Entry =>
  sidebarEntry({ name: "", target, provider: "claude", state: "idle", attention: "none", section });
/** The first row a drop lands before `index` from. */
const yOf = (view: View, index: number) => {
  for (let y = 0; y < view.rows; y++) if (view.agentDrop(5, y)?.index === index) return y;
  throw Error(`no row drops at ${index}`);
};
test("a drop among the pinned rows pins there; a pinned row dropped elsewhere unpins", () => {
  const entries = [
      row({ section: "pinned" }, null),
      row({ pane: 1 }, "pinned"),
      row({ section: "idle" }, null),
      row({ pane: 2 }, "idle"),
      row({ pane: 3 }, "idle"),
      row({ headless: 1 }, "idle"),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  const drag = Drag.init(view, 4, 5, yOf(view, 4), 1, 1, "activity");
  drag.dragging = true;
  // Above the pinned agent: pinned before it.
  drag.update(view, 1, 5, yOf(view, 1));
  expect(drag.drop?.index).toBe(1);
  expect(drag.action).toBe("pin");
  expect(drag.before()).toBe(1);
  expect(drag.preview).toBe(1);
  // On the pinned header: pinned first.
  drag.update(view, 1, 5, yOf(view, 0));
  expect(drag.drop?.index).toBe(1);
  // Just past it: pinned last.
  drag.update(view, 1, 5, yOf(view, 2));
  expect(drag.action).toBe("pin");
  expect(drag.before()).toBeNull();
  // In its own section, it reorders the section.
  drag.update(view, 1, 5, yOf(view, 3));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBe(3);
  drag.update(view, 1, 5, yOf(view, 6));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBeNull();
  // Where it is already, nothing changes.
  drag.update(view, 1, 5, yOf(view, 5));
  expect(drag.drop).toBeNull();
  drag.update(view, 1, 80, yOf(view, 1));
  expect(drag.drop).toBeNull();
  const pinned = Drag.init(view, 1, 5, yOf(view, 1), 1, 1, "activity");
  pinned.dragging = true;
  // Where it is already, nothing changes.
  pinned.update(view, 1, 5, yOf(view, 2));
  expect(pinned.drop).toBeNull();
  pinned.update(view, 1, 5, yOf(view, 4));
  expect(pinned.drop?.index).toBe(4);
  expect(pinned.action).toBe("unpin");
  expect(pinned.preview).toBeNull();
  entries[3].exit = { frame_ms: 0, progress: 0.5 };
  expect(drag.valid(view, 1)).toBe(false);
});
test("with nothing pinned, a drop above the first section pins", () => {
  const entries = [row({ section: "working" }, null), row({ pane: 1 }, "working"), row({ pane: 2 }, "working")],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 2, 5, yOf(view, 2), 1, 1, "activity");
  drag.dragging = true;
  drag.update(view, 1, 5, yOf(view, 0));
  expect(drag.action).toBe("pin");
  expect(drag.before()).toBeNull();
  expect(drag.preview).toBe(0);
  drag.update(view, 1, 5, yOf(view, 1));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBe(1);
});

test("hand-sorted, a drop respects grouped boundaries, scrolling, and stale rows", () => {
  const entry: Entry = sidebarEntry({
      name: "",
      target: { pane: 1 },
      provider: "claude",
      state: "idle",
      attention: "none",
    }),
    entries = Array.from({ length: 6 }, () => ({ ...entry }));
  entries[0].target = { group: 1 };
  entries[2].target = { pane: 2 };
  entries[3].target = { group: 2 };
  entries[4].target = { pane: 3 };
  entries[5].target = { headless: 1 };
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
  const scrolled = View.init(100, 18, true, 2, entries.length).withEntries(entries);
  expect(scrolled.agentDrop(5, scrolled.middle() + 2)?.index).toBe(2);
  entries[2].exit = { frame_ms: 0, progress: 0.5 };
  expect(drag.valid(view, 1)).toBe(false);
});
test("by activity, an agent moves anywhere in its section, past worktree labels", () => {
  const entries = [
      row({ section: "idle" }, null),
      row({ pane: 1 }, "idle"),
      row({ section: "idle", workspace: 1, checkout: "/wt", run: 0 }, null),
      row({ pane: 2 }, "idle"),
      row({ pane: 3 }, "idle"),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 4, 5, yOf(view, 4), 1, 1, "activity");
  drag.dragging = true;
  // On the label, it lands above the agent under it.
  drag.update(view, 1, 5, yOf(view, 2));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBe(3);
  // Out of the worktree's rows, above the first agent.
  drag.update(view, 1, 5, yOf(view, 1));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBe(1);
});
test("in all, an agent drops only among its own workspace's rows, where its place is saved", () => {
  const entries = [
      row({ section: "pinned" }, null),
      row({ section: "pinned", workspace: 1, checkout: null, run: 0 }, null),
      row({ pane: 1 }, "pinned"),
      row({ section: "pinned", workspace: 2, checkout: null, run: 0 }, null),
      row({ pane: 2 }, "pinned"),
      row({ section: "idle" }, null),
      row({ section: "idle", workspace: 1, checkout: null, run: 0 }, null),
      row({ pane: 3 }, "idle"),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 7, 5, yOf(view, 7), 1, 1, "activity");
  drag.dragging = true;
  // Among workspace 1's pins: pinned there.
  drag.update(view, 1, 5, yOf(view, 2));
  expect(drag.action).toBe("pin");
  // Right after them, at the end of its own workspace's run: last of them.
  drag.update(view, 1, 5, yOf(view, 3));
  expect(drag.action).toBe("pin");
  expect(drag.before()).toBe(4);
  // Among workspace 2's pins, its place couldn't be saved: no drop.
  drag.update(view, 1, 5, yOf(view, 5));
  expect(drag.drop).toBeNull();
});
test("in all, an agent whose workspace has no pins pins where its workspace's run will show", () => {
  const entries = [
      row({ section: "pinned" }, null),
      row({ section: "pinned", workspace: 1, checkout: null, run: 0 }, null),
      row({ pane: 1 }, "pinned"),
      row({ section: "pinned", workspace: 3, checkout: null, run: 0 }, null),
      row({ pane: 3 }, "pinned"),
      row({ section: "idle" }, null),
      row({ section: "idle", workspace: 2, checkout: null, run: 0 }, null),
      row({ pane: 2 }, "idle"),
    ],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries);
  // Between workspaces 1 and 3, wherever it drops among the pins.
  const drag = Drag.init(view, 7, 5, yOf(view, 7), 2, 2, "activity", [1, 2, 3]);
  drag.dragging = true;
  for (const at of [0, 2, 4]) {
    drag.update(view, 2, 5, yOf(view, at));
    expect(drag.action).toBe("pin");
    expect(drag.preview).toBe(3);
  }
  // First of all, ahead of workspace 1's.
  const first = Drag.init(view, 7, 5, yOf(view, 7), 2, 2, "activity", [2, 1, 3]);
  first.dragging = true;
  first.update(view, 2, 5, yOf(view, 4));
  expect(first.action).toBe("pin");
  expect(first.preview).toBe(1);
  // Last of all, after workspace 3's.
  const last = Drag.init(view, 7, 5, yOf(view, 7), 2, 2, "activity", [1, 3, 2]);
  last.dragging = true;
  last.update(view, 2, 5, yOf(view, 2));
  expect(last.preview).toBe(5);
  expect(last.before()).toBeNull();
});
