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
test("dragging reorders stars and activity rows without changing their sections", () => {
  const entries = [
      row({ section: "starred" }, null),
      row({ pane: 1 }, "starred"),
      row({ pane: 2 }, "starred"),
      row({ section: "idle" }, null),
      row({ pane: 3 }, "idle"),
      row({ pane: 4 }, "idle"),
      row({ headless: 1 }, "idle"),
    ],
    view = View.init(100, 36, true, 0, entries.length).withEntries(entries),
    starred = Drag.init(view, 2, 5, yOf(view, 2), 1, 1, "activity"),
    idle = Drag.init(view, 5, 5, yOf(view, 5), 1, 1, "activity");
  starred.dragging = idle.dragging = true;
  starred.update(view, 1, 5, yOf(view, 0));
  expect(starred.action).toBe("starred");
  expect(starred.before()).toBe(1);
  starred.update(view, 1, 5, yOf(view, 5));
  expect(starred.drop).toBeNull();
  for (const at of [0, 1, 2]) {
    idle.update(view, 1, 5, yOf(view, at));
    expect(idle.drop).toBeNull();
  }
  idle.update(view, 1, 5, yOf(view, 3));
  expect(idle.action).toBe("place");
  expect(idle.before()).toBe(4);
  idle.update(view, 1, 5, yOf(view, 6));
  expect(idle.drop).toBeNull();
  idle.update(view, 1, 80, yOf(view, 4));
  expect(idle.drop).toBeNull();
  entries[4].exit = { frame_ms: 0, progress: 0.5 };
  expect(idle.valid(view, 1)).toBe(false);
});
test("with nothing starred, dropping on the first heading only reorders its section", () => {
  const entries = [row({ section: "working" }, null), row({ pane: 1 }, "working"), row({ pane: 2 }, "working")],
    view = View.init(100, 30, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 2, 5, yOf(view, 2), 1, 1, "activity");
  drag.dragging = true;
  drag.update(view, 1, 5, yOf(view, 0));
  expect(drag.action).toBe("place");
  expect(drag.before()).toBe(1);
  expect(drag.preview).toBe(1);
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
test("in all, starred rows reorder only among their own workspace's stars", () => {
  const entries = [
      row({ section: "starred" }, null),
      row({ section: "starred", workspace: 1, checkout: null, run: 0 }, null),
      row({ pane: 1 }, "starred"),
      row({ pane: 3 }, "starred"),
      row({ section: "starred", workspace: 2, checkout: null, run: 0 }, null),
      row({ pane: 2 }, "starred"),
      row({ section: "idle" }, null),
      row({ section: "idle", workspace: 2, checkout: null, run: 0 }, null),
      row({ pane: 4 }, "idle"),
    ],
    view = View.init(100, 44, true, 0, entries.length).withEntries(entries),
    drag = Drag.init(view, 3, 5, yOf(view, 3), 1, 1, "activity");
  drag.dragging = true;
  drag.update(view, 1, 5, yOf(view, 2));
  expect(drag.action).toBe("starred");
  expect(drag.before()).toBe(2);
  drag.update(view, 1, 5, yOf(view, 6));
  expect(drag.drop).toBeNull();
  const idle = Drag.init(view, 8, 5, yOf(view, 8), 2, 2, "activity");
  idle.dragging = true;
  idle.update(view, 2, 5, yOf(view, 5));
  expect(idle.drop).toBeNull();
});

function scrolling(offset = 5, rows = 30, count = 20) {
  const entries = Array.from({ length: count }, (_, pane) => row({ pane }, null)),
    view = View.init(100, rows, true, offset, count).withEntries(entries),
    drag = Drag.init(view, view.offset + 1, 5, view.middle() + 4, 1, 1);
  drag.dragging = true;
  return { view, drag, entries };
}

test("drag scrolling pauses at an edge, then advances one entry at a time without mouse movement", () => {
  const { view, drag, entries } = scrolling();
  drag.update(view, 1, 5, 29, 1000);
  // The bottom cell still accepts an immediate drop at the current viewport's end.
  expect(drag.drop?.index).toBe(view.offset + view.capacity);
  expect(drag.scroll(view, 1, 1399)).toBeNull();
  const offset = drag.scroll(view, 1, 1400);
  expect(offset).toBe(6);
  const moved = View.init(100, 30, true, offset!, entries.length).withEntries(entries);
  drag.scrolled(moved, 1, 1400);
  expect(drag.drop?.index).toBe(moved.offset + moved.capacity);
  expect(drag.scroll(moved, 1, 1579)).toBeNull();
  expect(drag.scroll(moved, 1, 1580)).toBe(7);
  // A delayed frame never catches up with a jump through several entries.
  expect(drag.scroll(moved, 1, 10_000)).toBe(7);
});

test("the viewport's first and last slots stay still until the pointer reaches an edge", () => {
  const { view, drag } = scrolling(5, 20);
  for (const y of [view.middle() + 2, 18]) {
    drag.update(view, 1, 5, y, 1000);
    expect(drag.drop).not.toBeNull();
    expect(drag.scroll(view, 1, 10_000)).toBeNull();
  }
  for (const [x, y] of [
    [5, view.middle() - 1], // The workspace list and its divider.
    [5, 0],
    [0, 19], // The left margin and right border.
    [view.width - 1, 19],
    [view.width + 1, 19],
  ]) {
    drag.update(view, 1, x, y, 1000);
    expect(drag.scroll(view, 1, 10_000)).toBeNull();
  }
  drag.update(view, 1, 5, view.middle() + 1, 1000);
  expect(drag.drop?.index).toBe(view.offset);
  expect(drag.scroll(view, 1, 1399)).toBeNull();
  expect(drag.scroll(view, 1, 1400)).toBe(view.offset - 1);
});

test("leaving an edge or changing direction restarts the drag scrolling pause", () => {
  const { view, drag } = scrolling();
  drag.update(view, 1, 5, 29, 1000);
  drag.update(view, 1, 5, 28, 1300);
  expect(drag.scroll(view, 1, 2000)).toBeNull();
  drag.update(view, 1, 5, 29, 2100);
  expect(drag.scroll(view, 1, 2499)).toBeNull();
  // Motion within the same edge does not postpone its tick.
  drag.update(view, 1, 6, 29, 2400);
  expect(drag.scroll(view, 1, 2500)).toBe(6);
  drag.update(view, 1, 5, view.middle(), 2600);
  expect(drag.scroll(view, 1, 2999)).toBeNull();
  expect(drag.scroll(view, 1, 3000)).toBe(4);
  drag.update(view, 1, 80, 29, 3100);
  expect(drag.drop).toBeNull();
  expect(drag.scroll(view, 1, 4000)).toBeNull();
});

test("drag scrolling stops at list limits and leaves fitting lists alone", () => {
  for (const offset of [0, 19]) {
    const { view, drag } = scrolling(offset),
      y = offset === 0 ? view.middle() : 29;
    drag.update(view, 1, 5, y, 1000);
    expect(drag.scroll(view, 1, 2000)).toBeNull();
  }
  const { view, drag } = scrolling(0, 30, 3);
  for (const y of [view.middle(), 29]) {
    drag.update(view, 1, 5, y, 1000);
    expect(drag.scroll(view, 1, 2000)).toBeNull();
  }
});

test("a click, cancellation, resize, or changed entries cannot keep drag scrolling alive", () => {
  for (const change of ["click", "cancel", "resize", "entries", "workspace"] as const) {
    const { view, drag, entries } = scrolling();
    if (change === "click") drag.dragging = false;
    drag.update(view, 1, 5, 29, 1000);
    let current = 1;
    switch (change) {
      case "cancel":
        drag.cancelled = true;
        break;
      case "resize":
        view.rows += 1;
        break;
      case "entries":
        entries[0].target = { pane: 100 };
        break;
      case "workspace":
        current = 2;
        break;
    }
    expect(drag.scroll(view, current, 2000)).toBeNull();
    expect(drag.drop).toBeNull();
  }
});
