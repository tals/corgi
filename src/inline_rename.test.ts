import * as viewerRef from "./viewer_ref";
import { expect, test } from "bun:test";
import { ClickHistory, InlineRename, double_click_ms } from "./inline_rename";
import { name_limit } from "./name_dialog";

const c = (s: string) => s.charCodeAt(0);

test("a second press on the same row within the window is a double-click", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(true);
  expect(h.press(viewerRef.pane(0, 1), 2000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 2000 + double_click_ms - 1, 3, 4)).toBe(true);
});

test("a press at the window's edge starts over", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000 + double_click_ms, 3, 4)).toBe(false);
});

test("a press on another row is no double-click", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 2), 1001, 3, 4)).toBe(false);
  h.reset();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.workspace(0, 1), 1001, 3, 4)).toBe(false);
});

test("a drag after the press ends the double-click", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  h.move();
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(false);
});

test("the pointer leaving the pressed cell ends the double-click", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  h.motion(4, 4);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(false);
  h.reset();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  h.motion(3, 5);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(false);
});

test("a second press on another cell of the same row starts over", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 5, 4)).toBe(false);
  // It counts as the first press of a new double-click there.
  expect(h.press(viewerRef.pane(0, 1), 1002, 5, 4)).toBe(true);
});

test("motion within the pressed cell keeps the double-click", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  h.motion(3, 4);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(true);
});

test("motion before any press is nothing", () => {
  const h = new ClickHistory();
  h.motion(9, 9);
  expect(h.moved).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(true);
});

test("a third press right after a double-click starts a new sequence", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(true);
  expect(h.target).toBe(null);
  expect(h.press(viewerRef.pane(0, 1), 1002, 3, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1003, 3, 4)).toBe(true);
});

test("reset forgets the press", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 3, 4)).toBe(false);
  h.move();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 3, 4)).toBe(false);
});

test("an open field keeps the name, with the caret at its end and nothing selected", () => {
  const r = InlineRename.open(viewerRef.pane(0, 7), "review the diff", "claude");
  expect(r.target).toEqual(viewerRef.pane(0, 7));
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
  const r = InlineRename.open(viewerRef.workspace(0, 3), "", "corgi");
  expect(r.field.raw()).toBe("");
  expect(r.field.cursor).toBe(0);
  expect(r.field.selected).toBe(false);
  expect(r.field.selection()).toBe(null);
});

test("the caret stands after a multi-byte name's last character", () => {
  const r = InlineRename.open(viewerRef.pane(0, 7), "café", "claude");
  expect(r.field.len).toBe(5);
  expect(r.field.cursor).toBe(5);
  r.field.typeByte(c("s"));
  expect(r.field.raw()).toBe("cafés");
});

test("a workspace field keeps UTF-8, as an agent field does", () => {
  const ws = InlineRename.open(viewerRef.workspace(0, 3), "home", "corgi");
  for (const byte of Buffer.from("é")) ws.field.typeByte(byte);
  expect(ws.field.raw()).toBe("homeé");
  const agent = InlineRename.open(viewerRef.pane(0, 7), "caf", "claude");
  for (const byte of Buffer.from("é")) agent.field.typeByte(byte);
  expect(agent.field.raw()).toBe("café");
});

test("an edit clears the message and the overflow", () => {
  const r = InlineRename.open(viewerRef.pane(0, 7), "", "claude");
  for (let i = 0; i <= name_limit; i++) r.field.typeByte(c("a"));
  expect(r.field.len).toBe(name_limit);
  expect(r.field.overflow).toBe(true);
  r.message = "Could not save";
  r.edited();
  expect(r.message).toBeNull();
  expect(r.field.overflow).toBe(false);
  expect(r.field.len).toBe(name_limit);
});

test("equal pane numbers on different machines are different double-click targets", () => {
  const clicks = new ClickHistory();
  expect(clicks.press(viewerRef.pane(1, 7), 1000, 3, 4)).toBe(false);
  expect(clicks.press(viewerRef.pane(2, 7), 1100, 3, 4)).toBe(false);
  expect(clicks.press(viewerRef.pane(2, 7), 1200, 3, 4)).toBe(true);
});
