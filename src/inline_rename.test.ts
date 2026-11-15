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

test("another row or line, a drag or the pointer leaving the line ends the double-click", () => {
  const cases: [(h: ClickHistory) => void, RenameTarget, number, boolean][] = [
    // A press elsewhere on the pressed line keeps the double-click.
    [() => {}, viewerRef.pane(0, 1), 4, true],
    [() => {}, viewerRef.pane(0, 2), 4, false],
    [() => {}, viewerRef.workspace(0, 1), 4, false],
    // Another line of the same row.
    [() => {}, viewerRef.pane(0, 1), 5, false],
    // A drag, or the pointer leaving the pressed line.
    [h => h.move(), viewerRef.pane(0, 1), 4, false],
  ];
  for (const [between, target, y, double] of cases) {
    const h = new ClickHistory();
    expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
    between(h);
    expect(h.press(target, 1001, y)).toBe(double);
  }
});

test("two presses in a row make a double-click; another press between them starts over", () => {
  const h = new ClickHistory();
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1001, 4)).toBe(true);
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1002, 4)).toBe(false);
  // A press routed elsewhere, such as the message line or a port link.
  h.pressed();
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1003, 4)).toBe(false);
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1004, 4)).toBe(true);
});

test("a press is pending until the window closes, the pointer leaves, or a second press", () => {
  const h = new ClickHistory();
  expect(h.pending(1000)).toBe(null);
  expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
  expect(h.pending(1000 + double_click_ms - 1)).toEqual(viewerRef.pane(0, 1));
  expect(h.pending(1000 + double_click_ms)).toBe(null);
  h.move();
  expect(h.pending(1001)).toBe(null);
  expect(h.press(viewerRef.pane(0, 1), 1001, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1002, 4)).toBe(true);
  expect(h.pending(1002)).toBe(null);
  // A press routed elsewhere leaves nothing a second one could complete.
  h.pressed();
  expect(h.press(viewerRef.pane(0, 1), 1003, 4)).toBe(false);
  h.pressed();
  expect(h.pending(1004)).toBe(null);
});

test("reset forgets the press", () => {
  const h = new ClickHistory();
  expect(h.press(viewerRef.pane(0, 1), 1000, 4)).toBe(false);
  h.move();
  h.pressed();
  h.reset();
  expect(h.target).toBe(null);
  expect(h.moved).toBe(false);
  expect(h.unclaimed).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1001, 4)).toBe(false);
  expect(h.press(viewerRef.pane(0, 1), 1002, 4)).toBe(true);
});

test("an open field holds the name wholly selected, with the caret at its end", () => {
  const r = InlineRename.open(viewerRef.pane(0, 7), "café", "claude");
  expect(r.target).toEqual(viewerRef.pane(0, 7));
  expect(r.fallback).toBe("claude");
  expect(r.message).toBe(null);
  expect(r.saving).toBe(false);
  expect(r.drawer).toBe(false);
  expect(r.field.raw()).toBe("café");
  expect(r.field.len).toBe(5);
  expect(r.field.cursor).toBe(5);
  expect(r.field.selected).toBe(true);
  // A multi-byte name is selected whole, by bytes.
  expect(r.field.selection()).toEqual([0, 5]);
  // Right keeps the name and puts the caret at its end.
  r.field.area.move("right");
  expect(r.field.selection()).toBe(null);
  expect(r.field.cursor).toBe(5);
  for (const byte of Buffer.from("é")) r.field.typeByte(byte);
  expect(r.field.raw()).toBe("caféé");
  // Typing in a fresh field replaces the name.
  const fresh = InlineRename.open(viewerRef.pane(0, 7), "review the diff", "claude");
  fresh.field.typeByte(c("x"));
  expect(fresh.field.raw()).toBe("x");
  expect(fresh.field.selected).toBe(false);
  const empty = InlineRename.open(viewerRef.workspace(0, 3), "", "corgi");
  expect(empty.field.cursor).toBe(0);
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

test("a press in the field drops the selection and puts the caret where it lands", () => {
  const open = InlineRename.open(viewerRef.workspace(0, 1), "Billing team", "");
  expect(open.field.selected).toBe(true);
  open.place(3, 14);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(3);
  open.field.key(c("X"));
  expect(open.field.raw()).toBe("BilXling team");
  // Past the text, in the field's spare columns, the caret goes to the end.
  open.place(13, 15);
  expect(open.field.cursor).toBe(open.field.len);
  // Wide characters take two columns each; a press on either half picks it.
  const wide = InlineRename.open(viewerRef.workspace(0, 2), "日本語版", "");
  wide.place(3, 10);
  expect(wide.field.cursor).toBe(3);
  wide.place(4, 10);
  expect(wide.field.cursor).toBe(6);
});

test("a double-click in the field selects the whole name again", () => {
  const open = InlineRename.open({ workspace: 1 }, "Billing team", "");
  open.press(3, 14, 1000);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(3);
  // The second press may land elsewhere on the line.
  open.press(8, 14, 1000 + double_click_ms - 1);
  expect(open.field.selected).toBe(true);
  // A third press right after keeps it selected, as a triple-click does.
  open.press(5, 14, 1000 + double_click_ms + 100);
  expect(open.field.selected).toBe(true);
  // A press after the window places the caret again.
  open.press(5, 14, 5000);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(5);
  open.press(6, 14, 5000 + double_click_ms);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(6);
});

test("typing between two presses ends the double-click", () => {
  const open = InlineRename.open({ workspace: 1 }, "Billing team", "");
  open.press(3, 14, 1000);
  open.field.key(c("X"));
  open.edited();
  open.press(5, 14, 1100);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(5);
});

test("an interrupted click sequence is no double-click", () => {
  const open = InlineRename.open({ workspace: 1 }, "Billing team", "");
  open.press(3, 14, 1000);
  open.interrupt();
  open.press(5, 14, 1100);
  expect(open.field.selected).toBe(false);
  expect(open.field.cursor).toBe(5);
});
