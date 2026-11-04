import { expect, test } from "bun:test";
import { Selection } from "./agent_selection";
import { entry } from "./sidebar";

const rows = [1, 2, 3, 4, 5].map(pane => entry({ target: { pane } }));

test("independent marks survive a shrinking range, and Space toggles without moving", () => {
  const s = new Selection();
  s.toggle({ pane: 5 });
  s.point({ pane: 1 });
  s.extend(rows, { pane: 4 });
  expect(s.targets).toEqual([5, 1, 2, 3, 4].map(pane => ({ pane })));
  s.extend(rows, { pane: 2 });
  expect(s.targets).toEqual([5, 1, 2].map(pane => ({ pane })));
  s.toggle({ pane: 2 });
  expect(s.targets).toEqual([{ pane: 5 }, { pane: 1 }]);
  expect(s.anchor).toEqual({ pane: 2 });
});

test("visual ranges cancel to the earlier marks and commit with a new anchor", () => {
  const s = new Selection();
  s.toggle({ pane: 5 });
  s.start(rows, { pane: 3 });
  s.move(rows, { pane: 3 }, false);
  expect(s.targets).toEqual([5, 2, 3].map(pane => ({ pane })));
  expect(s.escape()).toBe(true);
  expect(s.targets).toEqual([{ pane: 5 }]);
  s.start(rows, { pane: 1 });
  s.move(rows, { pane: 1 }, true);
  s.start(rows, { pane: 2 });
  expect(s.visual).toBe(false);
  expect(s.targets).toEqual([5, 1, 2].map(pane => ({ pane })));
  expect(s.escape()).toBe(true);
  expect(s.escape()).toBe(false);
});

test("ranges skip headings, ghosts and exiting agents, and clamp instead of wrapping", () => {
  const list = [
    entry({ target: { section: "working" } }),
    rows[0],
    entry({ target: { pane: 6 }, exit: { frame_ms: 0, progress: 0 } }),
    entry({ target: { pane: 7 }, worktree: { workspace: 1, path: "/ghost", ghost: true } }),
    entry({ target: { headless: 8 } }),
  ];
  const s = new Selection();
  const first = s.move(list, { section: "working" }, true)!;
  expect(first).toEqual({ pane: 1 });
  expect(s.move(list, first, true)).toEqual({ headless: 8 });
  expect(s.move(list, { headless: 8 }, true)).toEqual({ headless: 8 });
  expect(s.targets).toEqual([{ pane: 1 }, { headless: 8 }]);
});

test("selection holds ordering and grouping while refreshing statuses and removing departed agents", () => {
  const s = new Selection(),
    header = entry({ target: { section: "idle" } });
  s.toggle({ pane: 1 });
  s.ordered([header, ...rows]);
  const reordered = [
    rows[4],
    { ...rows[0], state: "working" as const },
    rows[1],
    rows[3],
    entry({ target: { pane: 9 } }),
  ];
  const held = s.ordered(reordered);
  expect(held.map(e => e.target)).toEqual([header.target, ...[1, 2, 4, 5].map(pane => ({ pane }))]);
  expect(held[1].state).toBe("working");
  expect(held[0].group).toMatchObject({ agents: 4, working: 1 });
  s.clear();
  expect(s.ordered(reordered)).toBe(reordered);
});

test("a disappearing range anchor cannot select a replacement", () => {
  const s = new Selection();
  s.start(rows, { pane: 1 });
  s.extend(rows, { pane: 3 });
  expect(s.keep(t => !("pane" in t) || t.pane !== 1)).toBe(1);
  expect(s.visual).toBe(false);
  expect(s.anchor).toBeNull();
  expect(s.targets).toEqual([{ pane: 2 }, { pane: 3 }]);
});
