import { expect, test } from "bun:test";
import * as style from "./instant_style";
import * as palette from "./palette";
import type { Surface } from "./pane/surface";

test("the changed part of a draft is what its common prefix and suffix leave", () => {
  expect(style.changed("hello", "hello world")).toEqual({ start: 5, end: 11 });
  expect(style.changed("helo", "hello")).toEqual({ start: 3, end: 4 });
  expect(style.changed("hello", "hllo")).toEqual({ start: 1, end: 1 });
  expect(style.changed("aaa", "aaaa")).toEqual({ start: 3, end: 4 });
  expect(style.changed("same", "same")).toEqual({ start: 4, end: 4 });
});

test("shading covers only the named columns and keeps the row's background", () => {
  const bg = "\x1b[44m";
  const surface: Surface = {
    pane: 1,
    cols: 10,
    rows: 1,
    lines: [bg + "ab cd" + "\x1b[0m"],
    cursor: null,
    cursor_style: "default",
  };
  const [line] = style.dim(surface, [{ y: 0, start: 1, end: 4 }]).lines;
  expect(Bun.stripANSI(line)).toBe("ab cd");
  expect(line).toStartWith(bg + "a" + palette.fg("muted") + "b");
  // A space shows nothing to shade.
  expect(line).toContain("\x1b[0m" + bg + " " + palette.fg("muted") + "c");
  expect(line).toContain("c\x1b[0m" + bg + "d");
});
