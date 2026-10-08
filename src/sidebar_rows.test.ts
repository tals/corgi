import { test, expect } from "bun:test";
import { State } from "./sidebar_rows";
import { entry as sidebarEntry, type Entry } from "./sidebar";
import type { Provider } from "./providers";
const entry = (pane: number, provider: Provider = "codex", state = "idle"): Entry =>
  sidebarEntry({ name: "", target: { pane }, provider, state, attention: "none" });
const paneOf = (e: Entry) => ("pane" in e.target ? e.target.pane : null);
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
