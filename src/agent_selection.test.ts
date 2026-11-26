import { expect, test } from "bun:test";
import * as viewerRef from "./viewer_ref";
import { Selection } from "./agent_selection";
import { entry } from "./sidebar";

const rows = [1, 2, 3, 4, 5].map(pane => entry({ target: viewerRef.pane(1, pane) }));

test("independent marks survive a shrinking range, and Space toggles without moving", () => {
  const s = new Selection();
  s.toggle(viewerRef.pane(1, 5));
  s.point(viewerRef.pane(1, 1));
  s.extend(rows, viewerRef.pane(1, 4));
  expect(s.targets).toEqual([5, 1, 2, 3, 4].map(pane => viewerRef.pane(1, pane)));
  s.extend(rows, viewerRef.pane(1, 2));
  expect(s.targets).toEqual([5, 1, 2].map(pane => viewerRef.pane(1, pane)));
  s.toggle(viewerRef.pane(1, 2));
  expect(s.targets).toEqual([viewerRef.pane(1, 5), viewerRef.pane(1, 1)]);
  expect(s.anchor).toEqual(viewerRef.pane(1, 2));
});

test("visual ranges cancel to the earlier marks and commit with a new anchor", () => {
  const s = new Selection();
  s.toggle(viewerRef.pane(1, 5));
  s.start(rows, viewerRef.pane(1, 3));
  s.move(rows, viewerRef.pane(1, 3), false);
  expect(s.targets).toEqual([5, 2, 3].map(pane => viewerRef.pane(1, pane)));
  expect(s.escape()).toBe(true);
  expect(s.targets).toEqual([viewerRef.pane(1, 5)]);
  s.start(rows, viewerRef.pane(1, 1));
  s.move(rows, viewerRef.pane(1, 1), true);
  s.start(rows, viewerRef.pane(1, 2));
  expect(s.visual).toBe(false);
  expect(s.targets).toEqual([5, 1, 2].map(pane => viewerRef.pane(1, pane)));
  expect(s.escape()).toBe(true);
  expect(s.escape()).toBe(false);
});

test("ranges skip headings, ghosts and exiting agents, and clamp instead of wrapping", () => {
  const list = [
    entry({ target: { section: "working" } }),
    rows[0],
    entry({ target: viewerRef.pane(1, 6), exit: { frame_ms: 0, progress: 0 } }),
    entry({
      target: viewerRef.pane(1, 7),
      worktree: { workspace: viewerRef.workspace(1, 1), path: "/ghost", ghost: true },
    }),
    entry({ target: viewerRef.headless(1, 8) }),
  ];
  const s = new Selection();
  const first = s.move(list, { section: "working" }, true)!;
  expect(first).toEqual(viewerRef.pane(1, 1));
  expect(s.move(list, first, true)).toEqual(viewerRef.headless(1, 8));
  expect(s.move(list, viewerRef.headless(1, 8), true)).toEqual(viewerRef.headless(1, 8));
  expect(s.targets).toEqual([viewerRef.pane(1, 1), viewerRef.headless(1, 8)]);
});

test("selection holds ordering and grouping while refreshing statuses and removing departed agents", () => {
  const s = new Selection(),
    header = entry({ target: { section: "idle" } });
  s.toggle(viewerRef.pane(1, 1));
  s.ordered([header, ...rows]);
  const reordered = [
    rows[4],
    { ...rows[0], state: "working" as const },
    rows[1],
    rows[3],
    entry({ target: viewerRef.pane(1, 9) }),
  ];
  const held = s.ordered(reordered);
  expect(held.map(e => e.target)).toEqual([header.target, ...[1, 2, 4, 5].map(pane => viewerRef.pane(1, pane))]);
  expect(held[1].state).toBe("working");
  expect(held[0].group).toMatchObject({ agents: 4, working: 1 });
  s.clear();
  expect(s.ordered(reordered)).toBe(reordered);
});

test("a disappearing range anchor cannot select a replacement", () => {
  const s = new Selection();
  s.start(rows, viewerRef.pane(1, 1));
  s.extend(rows, viewerRef.pane(1, 3));
  expect(s.keep(t => t !== viewerRef.pane(1, 1))).toBe(1);
  expect(s.visual).toBe(false);
  expect(s.anchor).toBeNull();
  expect(s.targets).toEqual([viewerRef.pane(1, 2), viewerRef.pane(1, 3)]);
});
