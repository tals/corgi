import { test, expect } from "bun:test";
import { parse } from "./action";
test("wire names used by the CLI and the test suites parse", () => {
  expect(parse("split", "down")).toEqual({ name: "split", value: "down" });
  expect(parse("split")).toEqual({ name: "split", value: "right" });
  expect(parse("move-tab", "left")).toEqual({
    name: "move-tab",
    value: "left",
  });
  expect(parse("detach")).toEqual({ name: "detach" });
  expect(parse("copy", "copied").value).toBe("copied");
  expect(parse("move-tab")).toEqual({ name: "move-tab", value: "right" });
  expect(parse("join", "1")).toEqual({ name: "join", value: 1 });
  expect(parse("focus", "up")).toEqual({ name: "focus", value: "up" });
  expect(parse("undo-close")).toEqual({ name: "undo-close" });
  expect(parse("last-tab")).toEqual({ name: "last-tab" });
  expect(parse("last-workspace")).toEqual({ name: "last-workspace" });
  expect(parse("prompt")).toEqual({ name: "prompt" });
  expect(parse("goto-workspace", "2")).toEqual({
    name: "goto-workspace",
    value: 2,
  });
  expect(parse("rename", "Renamed").value).toBe("Renamed");
  for (const [name, value, error] of [
    ["close_tab", "", "UnknownAction"],
    ["focus", "north", "BadValue"],
    ["resize", "", "BadValue"],
    ["tab", "two", "BadValue"],
  ])
    expect(() => parse(name, value)).toThrow(error);
});
test("workspace arguments accept a local id and default to the current workspace", () => {
  for (const name of ["worktrees", "resources"] as const) {
    expect(parse(name)).toEqual({ name, value: 0 });
    expect(parse(name, "2")).toEqual({ name, value: 2 });
    for (const value of ["-1", "1.5", "NaN", "remote/1", "9007199254740992"])
      expect(() => parse(name, value)).toThrow("BadValue");
  }
});
