import { expect, test } from "bun:test";
import { List } from "./checklist";

test("provider text loses controls and escapes and keeps UTF-8 within its bounds", () => {
  const list = List.of([
    { text: "\u001b[32mShip\u001b[0m\n safely", status: "pending", group: "\u001b[31mBuild\u001b[0m\nnow" },
    { text: "\u0000", status: "done" },
    { text: "\u001b]0;hidden\u0007Keep​going\t safely", status: "active" },
    { text: "\u{10437}".repeat(200), status: "blocked", group: "界".repeat(100) },
  ]);
  expect(list.items).toEqual([
    { text: "Ship safely", status: "pending", group: "Build now" },
    { text: "Keep going safely", status: "active", group: "" },
    { text: "\u{10437}".repeat(128), status: "blocked", group: "界".repeat(53) },
  ]);
  expect(list.partial).toBe(false);
});

test("lists keep at most 64 items and say when they dropped some", () => {
  const items = (n: number) => Array.from({ length: n }, () => ({ text: "Task", status: "pending" as const }));
  expect(List.of(items(64)).partial).toBe(false);
  const huge = List.of([{ text: "", status: "pending" }, ...items(100)]);
  expect(huge.items).toHaveLength(64);
  expect(huge.partial).toBe(true);
  expect(List.of([], true).partial).toBe(true);
});

test("a list without its own time takes the time it arrived", () => {
  expect(List.of([], false, 0).stamped(5).at).toBe(5);
  const timed = List.of([], false, 3);
  expect(timed.stamped(5)).toBe(timed);
});
