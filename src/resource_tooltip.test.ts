import { test, expect } from "bun:test";
import { geometry, aimed, State, draw } from "./resource_tooltip";
import { Rect } from "./layout";
import { Writer } from "./text";
import { Process, Work, Snapshot } from "./trackers/resources";
test("resource card stays within terminal bounds", () => {
  for (const cols of [68, 88, 120, 200])
    for (const rows of [24, 30, 40]) {
      const r = geometry(cols, rows, 28, rows - 1)!;
      expect(r.x + r.w).toBeLessThan(cols);
      expect(r.y + r.h).toBeLessThan(rows);
    }
});
test("aim triangle spans from the row exit to the card's left edge", () => {
  const card = new Rect(28, 4, 82, 24),
    exit = { x: 4, y: 4 };
  for (const [x, y] of [
    [8, 7],
    [14, 10],
    [20, 13],
    [27, 26],
  ])
    expect(aimed(card, exit, x, y)).toBe(true);
  expect(aimed(card, exit, 4, 5)).toBe(true);
  for (const [x, y] of [
    [4, 6],
    [3, 5],
    [20, 3],
    [27, 28],
    [28, 10],
  ])
    expect(aimed(card, exit, x, y)).toBe(false);
  const lifted = new Rect(28, 10, 82, 24);
  expect(aimed(lifted, { x: 4, y: 30 }, 16, 24)).toBe(true);
  expect(aimed(lifted, { x: 4, y: 30 }, 16, 36)).toBe(false);
  expect(aimed(new Rect(2, 4, 82, 24), exit, 3, 5)).toBe(false);
});
test("process rows freeze by identity while their numbers can refresh", () => {
  const state = new State(),
    processes = [
      { pid: 1, start: 10n, name: "first", cpu: 90 },
      { pid: 2, start: 20n, name: "second", cpu: 10 },
    ],
    work = { id: 1, known: true, processes };
  state.update(work, true);
  processes[0].cpu = 0;
  processes[1].cpu = 100;
  state.update(work, true);
  expect(state.order[0].pid).toBe(1);
  state.update(work, false);
  expect(state.order[0].pid).toBe(2);
});
