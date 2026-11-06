import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import * as dockingGrip from "./docking_grip";
import * as render from "./render";
import * as palette from "./palette";
import { Model, Selection, View, Rect } from "./layout";

test("the grip outline leaves air above the content and joins the divider on both sides", () => {
  for (const cell of [
    { width: 11, height: 25 },
    { width: 9, height: 18 },
    { width: 20, height: 40 },
  ]) {
    const width = 4 * cell.width,
      pixels = dockingGrip.pixels(cell),
      alpha = (x: number, y: number) => pixels[(y * width + x) * 4 + 3];
    for (let x = 0; x < width; x++) {
      expect(alpha(x, 0)).toBe(0);
      expect(alpha(x, cell.height - 1)).toBe(0);
    }
    expect(alpha(0, Math.floor(cell.height / 2))).toBe(255);
    expect(alpha(0, Math.floor(cell.height / 2) - 1)).toBe(255);
    expect(alpha(width - 1, Math.floor(cell.height / 2))).toBe(255);
    expect(alpha(Math.floor(width / 2), Math.round(cell.height * 0.16))).toBe(255);
    expect(alpha(Math.floor(width / 2), Math.floor(cell.height / 2))).toBe(0);
    const sent = dockingGrip.draw([new Rect(2, 1, 4, 1), new Rect(62, 1, 4, 1)], cell);
    const data = [...sent.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m => m[1]).join("");
    expect([...inflateSync(Buffer.from(data, "base64"))]).toEqual([...pixels]);
    expect([...pixels.subarray(0, 3)]).toEqual(palette.outline);
  }
});

test("grip images disappear under overlays and when grips are hidden; text hosts need no images", () => {
  const model = new Model(),
    pane = model.newTab("Work"),
    selection = new Selection();
  model.split(pane, "horizontal");
  selection.reconcile(model);
  const view = new View(model, selection),
    options = render.ui({
      message: "",
      copy_mode: false,
      sidebar_open: false,
      supports_kitty_graphics: true,
      cell_pixels: { width: 11, height: 25 },
      pointer: { x: 30, y: 1 },
    }),
    frame = (patch: Partial<render.Ui> = {}) => render.frame(view, [], 120, 36, { ...options, ...patch });
  expect(frame()).toContain("a=p,i=730410,p=1");
  expect(frame()).not.toContain("a=p,i=730410,p=2");
  for (const patch of [
    { pointer: null },
    { pointer: { x: 30, y: 0 } },
    { pointer: { x: 30, y: 2 } },
    { copy_mode: true },
    { prompt_draw: () => [new Rect(0, 0, 120, 36)] },
  ]) {
    const hidden = frame(patch);
    expect(hidden).toContain(dockingGrip.hide);
    expect(hidden).not.toContain("a=p,i=730410");
  }
  const plain = frame({ supports_kitty_graphics: false });
  expect(plain).not.toContain("i=730410");
  expect(plain).toContain("\x1b[53;4m::\x1b[55;24m");
});

test("a shown grip stays until the pointer is more than a row from its border", () => {
  const model = new Model(),
    pane = model.newTab("Work"),
    selection = new Selection();
  model.split(pane, "horizontal");
  selection.reconcile(model);
  const view = new View(model, selection),
    options = render.ui({
      message: "",
      copy_mode: false,
      sidebar_open: false,
      supports_kitty_graphics: true,
      cell_pixels: { width: 11, height: 25 },
    }),
    shown = (y: number, grip_hover: number[]) =>
      render.frame(view, [], 120, 36, { ...options, pointer: { x: 30, y }, grip_hover }).includes("a=p,i=730410");
  expect(shown(2, [])).toBe(false);
  expect(shown(1, [])).toBe(true);
  expect(shown(2, [pane])).toBe(true);
  expect(shown(0, [pane])).toBe(true);
  expect(shown(3, [pane])).toBe(false);
});
