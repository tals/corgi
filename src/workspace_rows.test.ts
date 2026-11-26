import { test, expect } from "bun:test";
import { State } from "./workspace_rows";
import { workspaceEntry, type WorkspaceEntry } from "./sidebar";
import * as viewerRef from "./viewer_ref";
const ref = (id: number) => viewerRef.workspace(0, id);
const card = (id: number): WorkspaceEntry => workspaceEntry({ id: ref(id), name: `W${id}`, cwd: "/w", active: false });
const cards = (...ids: number[]) => ids.map(card);
/** One machine ordering by activity, whose auto-archived cards are `archived`. */
const machine = (archived: number[] = []) => ({
  group: () => 0,
  archived: (key: viewerRef.Workspace) => archived.includes(viewerRef.parts(key).id),
});
const ids = (rows: WorkspaceEntry[]) => rows.map(row => viewerRef.parts(row.id).id);
const fades = (rows: WorkspaceEntry[]) => rows.map(row => row.fade);
const d = State.duration_ms;

test("a card the daemon moves fades out where it was, then in where it lands; the others don't fade", () => {
  const rows = new State(),
    sources = machine();
  // The first list shows at once.
  expect(fades(rows.update(cards(1, 2, 3, 4), 0, sources))).toEqual([null, null, null, null]);
  expect(rows.fading(0)).toBe(false);
  // 2 goes stale: it moves below 4.
  let shown = rows.update(cards(1, 3, 4, 2), 100, sources);
  expect(ids(shown)).toEqual([1, 2, 3, 4]);
  expect(fades(shown)).toEqual([null, 0, null, null]);
  expect(rows.fading(100)).toBe(true);
  rows.step(100 + d / 2);
  shown = rows.update(cards(1, 3, 4, 2), 100 + d / 2, sources);
  expect(ids(shown)).toEqual([1, 2, 3, 4]);
  expect(fades(shown)).toEqual([null, 0.5, null, null]);
  // Faded out, the list switches and 2 fades in at its new place.
  rows.step(100 + d);
  shown = rows.update(cards(1, 3, 4, 2), 100 + d, sources);
  expect(ids(shown)).toEqual([1, 3, 4, 2]);
  expect(fades(shown)).toEqual([null, null, null, 1]);
  rows.step(100 + d * 1.5);
  expect(fades(rows.update(cards(1, 3, 4, 2), 100 + d * 1.5, sources))).toEqual([null, null, null, 0.5]);
  // Then it is done, and asks for no more frames.
  expect(rows.fading(100 + d * 2)).toBe(false);
  rows.step(100 + d * 2);
  expect(fades(rows.update(cards(1, 3, 4, 2), 100 + d * 2, sources))).toEqual([null, null, null, null]);
});

test("a late frame switches at once, and the card fades in from when it faded out", () => {
  const rows = new State(),
    sources = machine();
  rows.update(cards(1, 2), 0, sources);
  rows.update(cards(2, 1), 0, sources);
  // Nothing drew for a while: the order switches with the next frame.
  rows.step(d * 1.5);
  const shown = rows.update(cards(2, 1), d * 1.5, sources);
  expect(ids(shown)).toEqual([2, 1]);
  // Of two cards trading places, one moved: the other kept its order.
  expect(shown.filter(row => row.fade !== null).map(row => row.fade)).toEqual([0.5]);
});

test("an auto-archived card fades out in place, then the list closes the gap; other removals don't wait", () => {
  const rows = new State();
  rows.update(cards(1, 2, 3), 0, machine([2]));
  let shown = rows.update(cards(1, 3), 10, machine([2]));
  expect(ids(shown)).toEqual([1, 2, 3]);
  expect(fades(shown)).toEqual([null, 0, null]);
  expect(shown[1].name).toBe("W2");
  rows.step(10 + d - 1);
  expect(ids(rows.update(cards(1, 3), 10 + d - 1, machine([2])))).toEqual([1, 2, 3]);
  rows.step(10 + d);
  shown = rows.update(cards(1, 3), 10 + d, machine([2]));
  expect(ids(shown)).toEqual([1, 3]);
  expect(fades(shown)).toEqual([null, null]);
  expect(rows.fading(10 + d)).toBe(false);
  // Closed or archived by hand: gone at once.
  expect(ids(rows.update(cards(1), 500, machine()))).toEqual([1]);
});

test("a drop, a new card and a list rebuilt from nothing show at once", () => {
  const rows = new State(),
    sources = machine();
  rows.update(cards(1, 2, 3), 0, sources);
  rows.place();
  let shown = rows.update(cards(3, 1, 2), 10, sources);
  expect(ids(shown)).toEqual([3, 1, 2]);
  expect(fades(shown)).toEqual([null, null, null]);
  expect(rows.fading(10)).toBe(false);
  // The drop's mark lasts one update: the daemon's next move fades.
  expect(fades(rows.update(cards(1, 2, 3), 20, sources))).toEqual([0, null, null]);
  // A workspace created meanwhile shows the new order at once.
  shown = rows.update(cards(1, 2, 3, 4), 30, sources);
  expect(ids(shown)).toEqual([1, 2, 3, 4]);
  expect(fades(shown)).toEqual([null, null, null, null]);
  rows.discard();
  shown = rows.update(cards(4, 3, 2, 1), 40, sources);
  expect(ids(shown)).toEqual([4, 3, 2, 1]);
  expect(rows.fading(40)).toBe(false);
});

test("cards rearranged across machines, or on a machine without auto-order, don't fade", () => {
  const rows = new State(),
    // Cards 1 and 2 are one machine's, 10 and 11 another's.
    sources = { group: (key: viewerRef.Workspace) => (viewerRef.parts(key).id < 10 ? 0 : 1), archived: () => false };
  rows.update(cards(1, 10, 2, 11), 0, sources);
  // The viewer's interleaving changed, each machine's own order didn't.
  let shown = rows.update(cards(10, 1, 11, 2), 10, sources);
  expect(ids(shown)).toEqual([10, 1, 11, 2]);
  expect(fades(shown)).toEqual([null, null, null, null]);
  // Within one machine, its daemon's move fades.
  shown = rows.update(cards(10, 2, 11, 1), 20, sources);
  expect(ids(shown)).toEqual([10, 1, 11, 2]);
  expect(fades(shown).filter(fade => fade !== null)).toEqual([0]);
  const still = new State(),
    manual = { group: () => null, archived: () => false };
  still.update(cards(1, 2), 0, manual);
  expect(fades(still.update(cards(2, 1), 10, manual))).toEqual([null, null]);
});

test("a reorder mid-fade goes on from each card's current fade, without a jump", () => {
  const rows = new State(),
    sources = machine();
  rows.update(cards(1, 2, 3), 0, sources);
  // 1 starts to move below 3.
  rows.update(cards(2, 3, 1), 0, sources);
  rows.step(d / 2);
  expect(fades(rows.update(cards(2, 3, 1), d / 2, sources))).toEqual([0.5, null, null]);
  // The daemon puts 1 back: it fades in where it is, from halfway.
  let shown = rows.update(cards(1, 2, 3), d / 2, sources);
  expect(ids(shown)).toEqual([1, 2, 3]);
  expect(fades(shown)).toEqual([0.5, null, null]);
  rows.step(d * 0.75);
  expect(fades(rows.update(cards(1, 2, 3), d * 0.75, sources))).toEqual([0.25, null, null]);
  // Then moves again: out from a quarter, so it lands a quarter sooner.
  shown = rows.update(cards(2, 3, 1), d * 0.75, sources);
  expect(fades(shown)).toEqual([0.25, null, null]);
  rows.step(d * 1.5 - 1);
  expect(ids(rows.update(cards(2, 3, 1), d * 1.5 - 1, sources))).toEqual([1, 2, 3]);
  rows.step(d * 1.5);
  shown = rows.update(cards(2, 3, 1), d * 1.5, sources);
  expect(ids(shown)).toEqual([2, 3, 1]);
  expect(fades(shown)).toEqual([null, null, 1]);
});

test("a second move while one fades out joins it, and the list switches once both are out", () => {
  const rows = new State(),
    sources = machine();
  rows.update(cards(1, 2, 3, 4), 0, sources);
  rows.update(cards(2, 3, 4, 1), 0, sources);
  rows.step(d / 2);
  rows.update(cards(3, 2, 4, 1), d / 2, sources);
  rows.step(d);
  let shown = rows.update(cards(3, 2, 4, 1), d, sources);
  expect(ids(shown)).toEqual([1, 2, 3, 4]);
  expect(fades(shown)).toEqual([1, null, 0.5, null]);
  rows.step(d * 1.5);
  shown = rows.update(cards(3, 2, 4, 1), d * 1.5, sources);
  expect(ids(shown)).toEqual([3, 2, 4, 1]);
  expect(fades(shown)).toEqual([1, null, null, 1]);
  expect(rows.fading(d * 2.5)).toBe(false);
});

test("cards show the latest data while they wait in their old places", () => {
  const rows = new State(),
    sources = machine();
  rows.update(cards(1, 2), 0, sources);
  const live = cards(2, 1);
  live[0].unread = 3;
  const shown = rows.update(live, 10, sources);
  expect(ids(shown)).toEqual([1, 2]);
  expect(shown[1].unread).toBe(3);
});
