import { test, expect } from "bun:test";
import * as f from "./fork_hero";
test("the hero is text: node glyphs where the host draws them, dots elsewhere", () => {
  const native = f.draw(0, 0, true),
    fallback = f.draw(0, 0, false);
  expect(native.split("").length - 1).toBe(2);
  expect(native).not.toContain("\x1b_G");
  expect(fallback.split("●").length - 1).toBe(2);
  expect(fallback).not.toContain("");
});
