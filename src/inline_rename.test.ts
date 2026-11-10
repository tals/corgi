import * as viewerRef from "./viewer_ref";
import { expect, test } from "bun:test";
import { ClickHistory, InlineRename, double_click_ms, type RenameTarget } from "./inline_rename";
import { name_limit } from "./name_dialog";

const c = (s: string) => s.charCodeAt(0);

test("a second press on the same name line within the window is a double-click, and the next press starts over", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000 + double_click_ms, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000 + 2 * double_click_ms - 1, 4)).toBe(true);
  expect(h.target).toBe(null);
  expect(h.press(viewerRef.pane(0, 1), 2000, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 2001, 4)).toBe(true);
});

test("another row, a drag or the pointer leaving the line ends the double-click", () => {
  const cases: [(h: ClickHistory) => void, RenameTarget, number, boolean][] = [
    [() => {}, viewerRef.pane(0, 1), 4, true],
    // Motion along the pressed line, or a press elsewhere on it, keeps the double-click.
    [
      h => {
        h.motion(4);
        h.motion(4);
      },
      viewerRef.pane(0, 1),
      4,
      true,
    ],
    [() => {}, viewerRef.pane(0, 2), 4, false],
    [() => {}, viewerRef.workspace(0, 1), 4, false],
    [h => h.move(), viewerRef.pane(0, 1), 4, false],
    [h => h.motion(5), viewerRef.pane(0, 1), 4, false],
  ];
  for (const [between, target, y, double] of cases) {
    const h = new ClickHistory();
    expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
    between(h);
    expect(h.press(target, 1001, y)).toBe(double);
  }
});

test("motion before a press and a reset leave nothing to double-click", () => {
  const h = new ClickHistory();
  h.motion(9);
  expect(h.moved).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
  h.move();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1002, 4)).toBe(true);
});

test("an open field keeps the name, with the caret after its last character and nothing selected", () => {
  const r = InlineRename.open(viewerRef.pane(0, 7), "café", "claude");
  expect(r.target).toEqual(viewerRef.pane(0, 7));
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
  const empty = InlineRename.open(viewerRef.workspace(0, 3), "", "corgi");
  expect(empty.field.cursor).toBe(0);
  expect(empty.field.selected).toBe(false);
  expect(empty.field.selection()).toBe(null);
  // A workspace's field keeps UTF-8, as an agent's does.
  for (const byte of Buffer.from("é")) empty.field.typeByte(byte);
  expect(empty.field.raw()).toBe("é");
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
  expect(clicks.press(viewerRef.pane(1, 7), 1000, 4)).toBe(false);
  expect(clicks.press(viewerRef.pane(2, 7), 1100, 4)).toBe(false);
  expect(clicks.press(viewerRef.pane(2, 7), 1200, 4)).toBe(true);
});
