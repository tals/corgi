import { expect, test } from "bun:test";
import { ClickHistory, InlineRename, double_click_ms, sameRenameTarget } from "./inline_rename";
import { name_limit } from "./name_dialog";

const c = (s: string) => s.charCodeAt(0);

test("same target: kind and id", () => {
  expect(sameRenameTarget({ agent: 1 }, { agent: 1 })).toBe(true);
  expect(sameRenameTarget({ workspace: 1 }, { workspace: 1 })).toBe(true);
  expect(sameRenameTarget({ agent: 1 }, { agent: 2 })).toBe(false);
  expect(sameRenameTarget({ agent: 1 }, { workspace: 1 })).toBe(false);
  expect(sameRenameTarget({ workspace: 1 }, { agent: 1 })).toBe(false);
});

test("a second press on the same row within the window is a double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(true);
  expect(h.press({ agent: 1 }, 2000, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 2000 + double_click_ms - 1, 4)).toBe(true);
});

test("a press at the window's edge starts over", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000 + double_click_ms, 4)).toBe(false);
});

test("a press on another row is no double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ agent: 2 }, 1001, 4)).toBe(false);
  h.reset();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ workspace: 1 }, 1001, 4)).toBe(false);
});

test("a drag after the press ends the double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  h.move();
  expect(h.press({ agent: 1 }, 1001, 4)).toBe(false);
});

test("a press on another line of the same row is no double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 5)).toBe(false);
});

test("two presses in a row make a double-click; another press between them starts over", () => {
  const h = new ClickHistory();
  h.pressed();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  h.pressed();
  expect(h.press({ agent: 1 }, 1001, 4)).toBe(true);
  h.pressed();
  expect(h.press({ agent: 1 }, 1002, 4)).toBe(false);
  // A press routed elsewhere, such as the message line or a port link.
  h.pressed();
  h.pressed();
  expect(h.press({ agent: 1 }, 1003, 4)).toBe(false);
  h.pressed();
  expect(h.press({ agent: 1 }, 1004, 4)).toBe(true);
});

test("a press is pending until the window closes, the pointer leaves, or a second press", () => {
  const h = new ClickHistory();
  expect(h.pending(1000)).toBe(null);
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.pending(1000 + double_click_ms - 1)).toEqual({ agent: 1 });
  expect(h.pending(1000 + double_click_ms)).toBe(null);
  h.move();
  expect(h.pending(1001)).toBe(null);
  expect(h.press({ agent: 1 }, 1001, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1002, 4)).toBe(true);
  expect(h.pending(1002)).toBe(null);
  // A press routed elsewhere leaves nothing a second one could complete.
  h.pressed();
  expect(h.press({ agent: 1 }, 1003, 4)).toBe(false);
  h.pressed();
  expect(h.pending(1004)).toBe(null);
});

test("a third press right after a double-click starts a new sequence", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 4)).toBe(true);
  expect(h.target).toBe(null);
  expect(h.press({ agent: 1 }, 1002, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1003, 4)).toBe(true);
});

test("reset forgets the press", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 4)).toBe(false);
  h.move();
  h.pressed();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.unclaimed).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 4)).toBe(false);
});

test("an open field holds the name wholly selected, with the caret at its end", () => {
  const r = InlineRename.open({ agent: 7 }, "review the diff", "claude");
  expect(r.target).toEqual({ agent: 7 });
  expect(r.fallback).toBe("claude");
  expect(r.message).toBe(null);
  expect(r.saving).toBe(false);
  expect(r.drawer).toBe(false);
  expect(r.field.raw()).toBe("review the diff");
  expect(r.field.cursor).toBe(r.field.len);
  expect(r.field.selected).toBe(true);
  expect(r.field.selection()).toEqual([0, r.field.len]);
});

test("typing in a fresh field replaces the name", () => {
  const r = InlineRename.open({ agent: 7 }, "review the diff", "claude");
  r.field.typeByte(c("x"));
  expect(r.field.raw()).toBe("x");
  expect(r.field.selected).toBe(false);
});

test("Right keeps the name and puts the caret at its end", () => {
  const r = InlineRename.open({ agent: 7 }, "review the diff", "claude");
  r.field.area.move("right");
  expect(r.field.selection()).toBe(null);
  expect(r.field.cursor).toBe(r.field.len);
  r.field.typeByte(c("!"));
  expect(r.field.raw()).toBe("review the diff!");
});

test("an open field on an empty name takes typing at the start", () => {
  const r = InlineRename.open({ workspace: 3 }, "", "corgi");
  expect(r.field.raw()).toBe("");
  expect(r.field.cursor).toBe(0);
  expect(r.field.selection()).toBe(null);
  r.field.typeByte(c("w"));
  expect(r.field.raw()).toBe("w");
});

test("a multi-byte name is selected whole, by bytes", () => {
  const r = InlineRename.open({ agent: 7 }, "café", "claude");
  expect(r.field.len).toBe(5);
  expect(r.field.cursor).toBe(5);
  expect(r.field.selection()).toEqual([0, 5]);
  r.field.area.move("right");
  r.field.typeByte(c("s"));
  expect(r.field.raw()).toBe("cafés");
});

test("a workspace field keeps UTF-8, as an agent field does", () => {
  const ws = InlineRename.open({ workspace: 3 }, "home", "corgi");
  ws.field.area.move("right");
  for (const byte of Buffer.from("é")) ws.field.typeByte(byte);
  expect(ws.field.raw()).toBe("homeé");
  const agent = InlineRename.open({ agent: 7 }, "caf", "claude");
  agent.field.area.move("right");
  for (const byte of Buffer.from("é")) agent.field.typeByte(byte);
  expect(agent.field.raw()).toBe("café");
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
