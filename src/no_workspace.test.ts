import { expect, test } from "bun:test";
import * as noWorkspace from "./no_workspace";
import { Rect } from "./layout";
import { Writer } from "./text";

test("the button stays centered, with the pictures of its steps only where they fit", () => {
  const roomy = noWorkspace.layout(new Rect(30, 1, 80, 31))!;
  expect(roomy.button.h).toBe(5);
  expect(roomy.button.x - 30).toBe(30 + 80 - roomy.button.x - roomy.button.w);
  const { dialog, sidebar } = roomy.steps!;
  expect(dialog.y).toBeGreaterThan(roomy.button.y + roomy.button.h);
  expect(dialog.x + dialog.w).toBeLessThan(sidebar.x);
  expect(sidebar.x + sidebar.w).toBeLessThanOrEqual(110);
  expect(dialog.y + dialog.h).toBeLessThanOrEqual(32);
  const narrow = noWorkspace.layout(new Rect(30, 1, 40, 31))!;
  expect([narrow.steps, narrow.button.h]).toEqual([null, 5]);
  expect(noWorkspace.layout(new Rect(30, 1, 40, 3))!.button.h).toBe(1);
  expect(noWorkspace.layout(new Rect(30, 1, 6, 31))).toBeNull();
});
test("a press anywhere on the button is on it", () => {
  const area = new Rect(30, 1, 80, 31),
    { button } = noWorkspace.layout(area)!;
  for (const [x, y] of [
    [button.x, button.y],
    [button.x + button.w - 1, button.y + button.h - 1],
  ])
    expect(noWorkspace.hit(area, x, y)).toBe(true);
  expect(noWorkspace.hit(area, button.x - 1, button.y)).toBe(false);
  expect(noWorkspace.hit(area, button.x, button.y + button.h)).toBe(false);
});
test("the pictures show the folder the dialog opens with, its end when it's long", () => {
  const w = new Writer(),
    folder = "~/a/very/long/path/that/does/not/fit/project/";
  noWorkspace.draw(w, new Rect(30, 1, 80, 31), { name: "project", folder, focused: true }, true);
  const text = w.buffered().replace(/\x1b\[[\d;:]*[A-Za-z]/g, "");
  expect(text).toContain("Create workspace");
  expect(text).toMatch(/…[\w/]*\/fit\/project\//);
  expect(text).not.toContain("~/a/very");
  expect(text.split("project").length).toBeGreaterThan(3);
});
