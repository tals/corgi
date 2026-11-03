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
test("a press on the button or its sketches creates, and one on the example's name plays", () => {
  const area = new Rect(30, 1, 80, 31),
    { button, steps } = noWorkspace.layout(area)!,
    { dialog, sidebar, names } = steps!;
  for (const [x, y] of [
    [button.x, button.y],
    [button.x + button.w - 1, button.y + button.h - 1],
    [dialog.x, dialog.y - 1],
    [dialog.x + dialog.w, dialog.y + 5],
    [sidebar.x + sidebar.w - 1, sidebar.y + sidebar.h - 1],
    [names[0].x + names[0].w, names[0].y],
  ])
    expect(noWorkspace.hit(area, x, y)).toBe("create");
  for (const name of names) {
    expect(noWorkspace.hit(area, name.x, name.y)).toBe("moonlander");
    expect(noWorkspace.hit(area, name.x + name.w - 1, name.y)).toBe("moonlander");
  }
  expect(names.map(name => [dialog.contains(name.x, name.y), sidebar.contains(name.x, name.y)])).toEqual([
    [true, false],
    [false, true],
  ]);
  expect(noWorkspace.hit(area, button.x - 1, button.y)).toBeNull();
  expect(noWorkspace.hit(area, button.x, button.y + button.h)).toBeNull();
  expect(noWorkspace.hit(area, sidebar.x + sidebar.w, sidebar.y)).toBeNull();
});
test("the sketches write the example's name where a press on it lands", () => {
  const area = new Rect(30, 1, 80, 31),
    w = new Writer();
  noWorkspace.draw(w, area, true);
  const cells = screen(w.buffered(), 110, 32);
  expect(cells.join("\n")).toContain("Create workspace");
  expect(cells.join("\n")).toContain("~/moonlander/");
  for (const name of noWorkspace.layout(area)!.steps!.names)
    expect(cells[name.y].slice(name.x, name.x + name.w)).toBe("moonlander");
});
/** The text `bytes` writes with cursor moves on a `cols` × `rows` screen of single-width cells. */
function screen(bytes: string, cols: number, rows: number): string[] {
  const cells = Array.from({ length: rows }, () => Array<string>(cols).fill(" "));
  let x = 0,
    y = 0;
  for (const part of bytes.split(/(\x1b\[[\d;:]*[A-Za-z])/)) {
    const move = /^\x1b\[(\d+);(\d+)H$/.exec(part);
    if (move) [y, x] = [Number(move[1]) - 1, Number(move[2]) - 1];
    else if (!part.startsWith("\x1b"))
      for (const ch of part) {
        if (y < rows && x < cols) cells[y][x] = ch;
        x++;
      }
  }
  return cells.map(row => row.join(""));
}
