import { expect, test } from "bun:test";
import * as palette from "./palette";
import { Grid } from "./cell_grid";
import { Writer } from "./text";
import { Terminal } from "./pane/terminal";

function shown(g: Grid): string {
  const w = new Writer(),
    terminal = new Terminal(g.w, g.h);
  try {
    g.write(w, 0, 0, "\x1b[0m");
    terminal.feed(w.buffered());
    return terminal.text();
  } finally {
    terminal.destroy();
  }
}
test("text fills cells, wide glyphs take two, and the edge cuts", () => {
  const g = new Grid(8, 2, palette.colors.text);
  g.text(0, 0, "a界b", palette.colors.text);
  expect(g.rows[0].slice(0, 4).map(c => c.ch)).toEqual(["a", "界", "", "b"]);
  g.text(6, 1, "界界", palette.colors.text);
  expect(g.rows[1].slice(6).map(c => c.ch)).toEqual(["界", ""]);
  expect(g.blank(5, 1)).toBe(true);
  expect(g.blank(6, 1)).toBe(false);
  expect(shown(g)).toContain("a界b");
});
test("half of a wide glyph drawn over shows as a space", () => {
  const g = new Grid(6, 1, palette.colors.text);
  g.text(0, 0, "界界x", palette.colors.text);
  g.put(1, 0, "·", palette.colors.faint);
  g.put(2, 0, "-", palette.colors.faint);
  expect(shown(g).split("\n")[0].trimEnd()).toBe(" ·- x");
});
test("a fill sits under what is drawn, and the background returns after it", () => {
  const g = new Grid(6, 1, palette.colors.text);
  g.fill(1, 0, 3, palette.colors.selected);
  g.text(0, 0, "abcde", palette.colors.text, true);
  const w = new Writer();
  g.write(w, 0, 0, "\x1b[0m");
  expect(w.buffered()).toContain(`a${palette.bgRgb(palette.colors.selected)}bcd\x1b[0m\x1b[22m\x1b[1m`);
});
