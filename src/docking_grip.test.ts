import { expect, test } from "bun:test";
import * as dockingGrip from "./docking_grip";
import * as hostImages from "./host_images";
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
    const store = new hostImages.Store();
    dockingGrip.draw(store.frame(cell), [new Rect(2, 1, 4, 1), new Rect(62, 1, 4, 1)], cell);
    const sent = store.present().send;
    const data = [...sent.matchAll(/\x1b_G[^;]*;([^\x1b]*)\x1b\\/g)].map(m => m[1]).join("");
    expect([...Buffer.from(data, "base64")]).toEqual([...pixels]);
    expect([...pixels.subarray(0, 3)]).toEqual(palette.outline);
  }
});

const cell = { width: 11, height: 25 };
/** The grip image's id at `cell`. */
function gripId(): string {
  const frame = new hostImages.Frame(cell);
  dockingGrip.draw(frame, [new Rect(0, 0, 4, 1)], cell);
  return /i=(\d+)/.exec(frame.commands())![1];
}

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
      cell_pixels: cell,
      pointer: { x: 30, y: 1 },
    }),
    store = new hostImages.Store(),
    frame = (patch: Partial<render.Ui> = {}) => {
      const pictures = store.frame(cell),
        out = render.frame(view, [], 120, 36, { ...options, pictures, ...patch });
      return { out, pictures: pictures.commands() };
    },
    placed = `a=p,i=${gripId()}`;
  expect(frame().pictures).toContain(`${placed},p=1`);
  expect(frame().pictures).not.toContain(`${placed},p=2`);
  for (const patch of [
    { pointer: null },
    { pointer: { x: 30, y: 0 } },
    { pointer: { x: 30, y: 2 } },
    { copy_mode: true },
    { prompt_draw: () => [new Rect(0, 0, 120, 36)] },
  ]) {
    const hidden = frame(patch);
    expect(hidden.pictures).not.toContain(placed);
  }
  const plain = frame({ supports_kitty_graphics: false, pictures: null });
  expect(plain.pictures).toBe("");
  expect(plain.out).not.toContain("\x1b_G");
  expect(plain.out).toContain("\x1b[53;4m::\x1b[55;24m");
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
      cell_pixels: cell,
    }),
    shown = (y: number, grip_hover: number[]) => {
      const pictures = new hostImages.Frame(cell);
      render.frame(view, [], 120, 36, { ...options, pictures, pointer: { x: 30, y }, grip_hover });
      return pictures.commands().includes(`a=p,i=${gripId()}`);
    };
  expect(shown(2, [])).toBe(false);
  expect(shown(1, [])).toBe(true);
  expect(shown(2, [pane])).toBe(true);
  expect(shown(0, [pane])).toBe(true);
  expect(shown(3, [pane])).toBe(false);
});
