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
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(true);
  expect(h.press({ agent: 1 }, 2000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 2000 + double_click_ms - 1, 3, 4)).toBe(true);
});

test("a press at the window's edge starts over", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1000 + double_click_ms, 3, 4)).toBe(false);
});

test("a press on another row is no double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 2 }, 1001, 3, 4)).toBe(false);
  h.reset();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ workspace: 1 }, 1001, 3, 4)).toBe(false);
});

test("a drag after the press ends the double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.move();
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(false);
});

test("the pointer leaving the pressed cell ends the double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.motion(4, 4);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(false);
  h.reset();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.motion(3, 5);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(false);
});

test("motion within the pressed cell keeps the double-click", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.motion(3, 4);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(true);
});

test("motion before any press is nothing", () => {
  const h = new ClickHistory();
  h.motion(9, 9);
  expect(h.moved).toBe(false);
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(true);
});

test("a third press right after a double-click starts a new sequence", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(true);
  expect(h.target).toBe(null);
  expect(h.press({ agent: 1 }, 1002, 3, 4)).toBe(false);
  expect(h.press({ agent: 1 }, 1003, 3, 4)).toBe(true);
});

test("reset forgets the press", () => {
  const h = new ClickHistory();
  expect(h.press({ agent: 1 }, 1000, 3, 4)).toBe(false);
  h.move();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.press({ agent: 1 }, 1001, 3, 4)).toBe(false);
});

test("an open field keeps the name, with the caret at its end and nothing selected", () => {
  const r = InlineRename.open({ agent: 7 }, "review the diff", "claude");
  expect(r.target).toEqual({ agent: 7 });
  expect(r.fallback).toBe("claude");
  expect(r.message).toBe(null);
  expect(r.saving).toBe(false);
  expect(r.drawer).toBe(false);
  expect(r.field.raw()).toBe("review the diff");
  expect(r.field.cursor).toBe(r.field.len);
  expect(r.field.selection()).toBe(null);
  expect(r.field.selected).toBe(false);
  // Typing adds to the name rather than replacing it.
  r.field.typeByte(c("!"));
  expect(r.field.raw()).toBe("review the diff!");
});

test("an open field on an empty name has nothing selected either", () => {
  const r = InlineRename.open({ workspace: 3 }, "", "corgi");
  expect(r.field.raw()).toBe("");
  expect(r.field.cursor).toBe(0);
  expect(r.field.selected).toBe(false);
  expect(r.field.selection()).toBe(null);
});

test("the caret stands after a multi-byte name's last character", () => {
  const r = InlineRename.open({ agent: 7 }, "café", "claude");
  expect(r.field.len).toBe(5);
  expect(r.field.cursor).toBe(5);
  r.field.typeByte(c("s"));
  expect(r.field.raw()).toBe("cafés");
});

test("a workspace field keeps ASCII only, an agent field keeps UTF-8", () => {
  const ws = InlineRename.open({ workspace: 3 }, "home", "corgi");
  for (const byte of Buffer.from("é")) ws.field.typeByte(byte);
  expect(ws.field.raw()).toBe("home");
  const agent = InlineRename.open({ agent: 7 }, "caf", "claude");
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
