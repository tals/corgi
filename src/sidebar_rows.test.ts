import { test, expect } from "bun:test";
import { State } from "./sidebar_rows";
import { entry as sidebarEntry, type Entry } from "./sidebar";
import * as rowGlide from "./row_glide";
import type { Provider } from "./providers";
const entry = (pane: number, provider: Provider = "codex", state = "idle"): Entry =>
  sidebarEntry({ name: "", target: { pane }, provider, state, attention: "none" });
const paneOf = (e: Entry) => ("pane" in e.target ? e.target.pane : null);
const checkout = (path: string) => ({ workspace: 1, path, ghost: false });
const header = (path: string) =>
  sidebarEntry({ name: path, target: { worktree: path, workspace: 1 }, worktree: checkout(path) });
const under = (e: Entry, path: string): Entry => ({ ...e, worktree: checkout(path) });
test("end hook and disappearance share one frozen exit without changing adjacent rows", () => {
  const rows = new State(),
    out: Entry[] = [],
    live = [{ ...entry(1, "codex", "working"), name: "Dog" }, entry(2, "claude")];
  rows.update(1, live, out, 0);
  live[0].name = "Xog";
  live[0].state = "done";
  let shown = rows.update(1, live, out, 10);
  expect(shown[0].name).toBe("Dog");
  expect(shown[0].state).toBe("working");
  expect(shown[0].exit).not.toBeNull();
  shown = rows.update(1, live.slice(1), out, 130);
  expect(shown.length).toBe(2);
  expect(paneOf(shown[1])).toBe(2);
  expect(shown[0].exit?.progress).toBe(0.5);
  shown = rows.update(1, live.slice(1), out, 250);
  expect(shown.length).toBe(1);
  expect(paneOf(shown[0])).toBe(2);
  expect(rows.update(2, [], out, 260)).toHaveLength(0);
});
test("a reopened row fades in as long as a closing one fades out; other new rows just appear", () => {
  const rows = new State(),
    out: Entry[] = [],
    before = entry(1, "claude"),
    reopened = { ...entry(2, "claude"), reopened: true },
    launched = entry(3);
  rows.update(1, [before], out, 0);
  let shown = rows.update(1, [before, reopened, launched], out, 10);
  expect(shown[0].enter).toBeNull();
  expect(shown[1].enter).toBe(0);
  expect(shown[2].enter).toBeNull();
  reopened.reopened = false;
  shown = rows.update(1, [before, reopened, launched], out, 130);
  expect(shown[1].enter).toBe(0.5);
  shown = rows.update(1, [before, reopened, launched], out, 250);
  expect(shown[1].enter).toBeNull();
});
test("lost terminal binding holds the label until exit or a real replacement", () => {
  const rows = new State(),
    out: Entry[] = [],
    e = { ...entry(1), conversation: 42, name: "Stable name" };
  rows.update(1, [e], out, 0);
  e.conversation = 0;
  e.name = "";
  e.state = "initializing";
  let shown = rows.update(1, [e], out, 10);
  expect(shown[0].name).toBe("Stable name");
  shown = rows.update(1, [], out, 510);
  expect(shown[0].name).toBe("Stable name");
  expect(shown[0].exit).not.toBeNull();
  e.conversation = 43;
  e.name = "New session";
  shown = rows.update(1, [e], out, 520);
  expect(shown[0].exit ?? null).toBeNull();
  expect(shown[0].name).toBe("New session");
  e.conversation = 0;
  rows.update(1, [e], out, 530);
  shown = rows.update(1, [e], out, 1180);
  expect(shown[0].conversation).toBe(0);
});
test("pane removal fades once while ended natives stay visible and same-workspace reordering stays live", () => {
  const rows = new State(),
    out: Entry[] = [],
    pane = entry(1),
    native: Entry = { ...entry(1, "claude", "working"), target: { native: 1 } };
  rows.update(1, [pane, native], out, 0);
  let shown = rows.update(1, [native, pane], out, 10);
  expect(shown[0].target).toEqual({ native: 1 });
  native.state = "done";
  shown = rows.update(1, [native], out, 20);
  expect(shown).toHaveLength(2);
  expect(shown[0].exit ?? null).toBeNull();
  expect(shown[1].exit).not.toBeNull();
  shown = rows.update(1, [native], out, 260);
  expect(shown).toHaveLength(1);
  expect(shown[0].state).toBe("done");
});
test("an agent moving into a worktree keeps its row, and rows it passes come back from 60%", () => {
  const rows = new State(),
    out: Entry[] = [],
    [a, b, c] = [entry(1), entry(2), entry(3)];
  rows.update(1, [a, b, c], out, 0);
  const inside = [b, c, header("/wt"), under(a, "/wt")];
  let shown = rows.update(1, inside, out, 10);
  expect(shown.map(paneOf)).toEqual([2, 3, null, 1]);
  expect(shown[3].exit).toBeNull();
  expect(shown[3].moved).toEqual({ from: 0, ms: 0 });
  expect(shown[0].enter).toBe(State.shift_enter);
  expect(shown[1].enter).toBe(State.shift_enter);
  expect(shown[2].enter).toBe(0);
  shown = rows.update(1, inside, out, 110);
  expect(shown[3].moved).toEqual({ from: 0, ms: 100 });
  expect(shown[0].enter).toBeCloseTo(State.shift_enter + (1 - State.shift_enter) / 2);
  expect(rows.moving(110)).toBe(true);
  shown = rows.update(1, inside, out, 10 + rowGlide.total_ms);
  expect(shown[3].moved).toBeNull();
  expect(shown.map(e => e.enter)).toEqual([null, null, null, null]);
  expect(rows.moving(10 + rowGlide.total_ms)).toBe(false);
});
test("an agent leaving its worktree takes the emptied header with it at once", () => {
  const rows = new State(),
    out: Entry[] = [],
    [a, b] = [entry(1), entry(2)];
  rows.update(1, [b, header("/wt"), under(a, "/wt")], out, 0);
  const shown = rows.update(1, [a, b], out, 10);
  expect(shown.map(paneOf)).toEqual([1, 2]);
  expect(shown.map(e => e.exit)).toEqual([null, null]);
  expect(shown[0].moved).toEqual({ from: 3, ms: 0 });
  expect(shown[1].enter).toBe(State.shift_enter);
});
test("an agent listed under two checkouts keeps a row under each", () => {
  const rows = new State(),
    out: Entry[] = [],
    a = entry(1);
  const both = [header("/one"), under(a, "/one"), header("/two"), under(a, "/two")];
  rows.update(1, both, out, 0);
  let shown = rows.update(1, both, out, 10);
  expect(shown.map(e => e.worktree?.path)).toEqual(["/one", "/one", "/two", "/two"]);
  expect(shown.map(e => e.moved)).toEqual([null, null, null, null]);
  // Out of one of them, that row closes where it was and the other stays.
  shown = rows.update(1, [header("/two"), under(a, "/two")], out, 20);
  expect(shown.map(e => e.worktree?.path)).toEqual(["/one", "/one", "/two", "/two"]);
  expect(shown[1].exit).not.toBeNull();
  expect(shown[3].exit).toBeNull();
  expect(shown[3].moved).toBeNull();
});
