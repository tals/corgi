import { expect, test } from "bun:test";
import { ClickHistory, InlineRename, double_click_ms, sameRenameTarget, type RenameTarget } from "./inline_rename";
import { name_limit } from "./name_dialog";

const c = (s: string) => s.charCodeAt(0);

test("same target: kind and id", () => {
  expect(sameRenameTarget({ agent: 1 }, { agent: 1 })).toBe(true);
  expect(sameRenameTarget({ workspace: 1 }, { workspace: 1 })).toBe(true);
  expect(sameRenameTarget({ agent: 1 }, { agent: 2 })).toBe(false);
  expect(sameRenameTarget({ agent: 1 }, { workspace: 1 })).toBe(false);
  expect(sameRenameTarget({ workspace: 1 }, { agent: 1 })).toBe(false);
});

test("a second press on the same cell within the window is a double-click, and the next press starts over", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000 + double_click_ms, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000 + 2 * double_click_ms - 1, 3, 4)).toBe(true);
  expect(h.target).toBe(null);
  expect(h.press({ agent: 1 }, 2000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 2001, 3, 4)).toBe(true);
  // A press on another cell is the first of a new double-click there.
  expect(h.press({ agent: 1 }, 3000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 3001, 5, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 3002, 5, 4)).toBe(true);
});

test("another row, another cell, a drag or the pointer leaving the cell ends the double-click", () => {
  const cases: [(h: ClickHistory) => void, RenameTarget, number, number, boolean][] = [
    [() => {}, { agent: 1 }, 3, 4, true],
    [h => h.motion(3, 4), { agent: 1 }, 3, 4, true],
    [() => {}, { agent: 2 }, 3, 4, false],
    [() => {}, { workspace: 1 }, 3, 4, false],
    [() => {}, { agent: 1 }, 5, 4, false],
    [h => h.move(), { agent: 1 }, 3, 4, false],
    [h => h.motion(4, 4), { agent: 1 }, 3, 4, false],
    [h => h.motion(3, 5), { agent: 1 }, 3, 4, false],
  ];
  for (const [between, target, x, y, double] of cases) {
    const h = new ClickHistory();
    expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
    between(h);
    expect(h.press(target, 1001, x, y)).toBe(double);
  }
});

test("motion before a press and a reset leave nothing to double-click", () => {
  const h = new ClickHistory();
  h.motion(9, 9);
  expect(h.moved).toBe(false);
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.move();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1002, 3, 4)).toBe(true);
});

test("an open field keeps the name, with the caret after its last character and nothing selected", () => {
  const r = InlineRename.open({ agent: 7 }, "café", "claude");
  expect(r.target).toEqual({ agent: 7 });
  expect(r.fallback).toBe("claude");
  expect(r.message).toBe(null);
  expect(r.saving).toBe(false);
  expect(r.drawer).toBe(false);
  expect(r.field.raw()).toBe("café");
  expect(r.field.len).toBe(5);
  expect(r.field.cursor).toBe(5);
  expect(r.field.selection()).toBe(null);
  expect(r.field.selected).toBe(false);
  // Typing adds to the name rather than replacing it.
  for (const byte of Buffer.from("é")) r.field.typeByte(byte);
  expect(r.field.raw()).toBe("caféé");
  const empty = InlineRename.open({ workspace: 3 }, "", "corgi");
  expect(empty.field.cursor).toBe(0);
  expect(empty.field.selected).toBe(false);
  expect(empty.field.selection()).toBe(null);
  // A workspace's field keeps UTF-8, as an agent's does.
  for (const byte of Buffer.from("é")) empty.field.typeByte(byte);
  expect(empty.field.raw()).toBe("é");
});

test("an edit clears the message and the overflow", () => {
  const r = InlineRename.open({ agent: 7 }, "", "claude");
  for (let i = 0; i <= name_limit; i++) r.field.typeByte(c("a"));
  expect(r.field.len).toBe(name_limit);
  expect(r.field.overflow).toBe(true);
  r.message = "Could not save";
  r.edited();
  expect(r.message).toBeNull();
  expect(r.field.overflow).toBe(false);
  expect(r.field.len).toBe(name_limit);
});
