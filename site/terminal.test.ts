import { expect, test } from "bun:test";
import * as terminal from "./terminal";
import * as cells from "./cells";

test("recording preserves CJK columns and combining marks across styled runs", () => {
  const screen = new terminal.Screen(12, 1);
  screen.feed("A日\x1b[31m");
  screen.feed("本e\u0301!");
  expect(screen.grid[0].map(cell => cell[0]).slice(0, 8)).toEqual(["A", "日", "", "本", "", "é", "!", " "]);
  const decoded = cells.decode([
    ["A日", 1],
    ["本é!", 2],
  ]);
  expect(decoded.map(cell => cell[0])).toEqual(["A", "日", "", "本", "", "é", "!"]);
  expect(cells.find(decoded, "本é")).toBe(3);
});

test("overwriting either half of a wide glyph clears the whole glyph", () => {
  const screen = new terminal.Screen(6, 1);
  screen.feed("日本\x1b[1;2Hx");
  expect(screen.grid[0].map(cell => cell[0])).toEqual([" ", "x", "本", "", " ", " "]);
  screen.feed("\x1b[1;3Hy");
  expect(screen.grid[0].map(cell => cell[0])).toEqual([" ", "x", "y", " ", " ", " "]);
});

test("a wide glyph cannot spill past the recording edge", () => {
  expect(terminal.row("abc日", 4).map(cell => cell[0])).toEqual(["a", "b", "c", " "]);
});

test("live edits and clipped panels preserve terminal column positions", () => {
  const row = cells.decode([["日本  ", 7]]);
  cells.put(row, 1, "x");
  expect(row.map(cell => cell[0])).toEqual([" ", "x", "本", "", " ", " "]);
  cells.put(row, 2, "y");
  expect(row.map(cell => cell[0])).toEqual([" ", "x", "y", " ", " ", " "]);
  cells.put(row, 5, "日");
  expect(row.at(-1)?.[0]).toBe(" ");
  cells.put(row, -1, "日a");
  expect(row.slice(0, 2).map(cell => cell[0])).toEqual([" ", "a"]);
  const wide = cells.decode([["日本", 7]]);
  expect(cells.visible(wide, 0, 1)).toEqual([" ", 7]);
  expect(cells.visible(wide.slice(1), 0)).toEqual([" ", 7]);
});
