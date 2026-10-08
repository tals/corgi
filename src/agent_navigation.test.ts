import { test, expect } from "bun:test";
import { relative, History, Picker } from "./agent_navigation";
import { entry, type Entry } from "./sidebar";
test("agent navigation wraps, excludes shells, and validates history against the current list", () => {
  const entries: Entry[] = [
    entry({
      name: "",
      target: { pane: 2 },
      provider: "codex",
      state: "idle",
      attention: "none",
    }),
    entry({
      name: "",
      target: { native: 2 },
      provider: "claude",
      state: "blocked",
      attention: "needs_input",
    }),
  ];
  expect(relative(entries, entries[0].target, false)).toEqual(entries[1].target);
  expect(relative(entries, entries[1].target, true)).toEqual(entries[0].target);
  expect(relative([], null, true)).toBeNull();
  const h = new History();
  h.observe(entries[0].target);
  h.observe(entries[1].target);
  expect(h.destination(entries, entries[1].target)).toEqual(entries[0].target);
  expect(h.destination(entries.slice(1), entries[1].target)).toBeNull();
});
test("picker preserves target identity across reordering and removes filtered or deleted selections", () => {
  const entries: Entry[] = [
    entry({
      name: "Alpha",
      target: { pane: 1 },
      provider: "codex",
      state: "idle",
      attention: "none",
    }),
    entry({
      name: "Beta",
      target: { native: 1 },
      provider: "claude",
      state: "blocked",
      attention: "needs_input",
    }),
  ];
  const p = new Picker(1);
  p.selected = entries[1].target;
  p.reconcile(entries, 1);
  expect(p.offset).toBe(1);
  entries.reverse();
  p.reconcile(entries, 1);
  expect(p.offset).toBe(0);
  p.query.key(65);
  p.query.key(76);
  const filtered = p.list(entries);
  p.reconcile(filtered, 1);
  expect(p.selected).toEqual(entries[1].target);
  p.reconcile([], 1);
  expect(p.selected).toBeNull();
});
