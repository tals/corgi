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
  expect(parse("goto-workspace", "2")).toEqual({
    name: "goto-workspace",
    value: 2,
  });
  expect(parse("rename", "Renamed").value).toBe("Renamed");
  expect(parse("wake")).toEqual({ name: "wake", value: "agent" });
  expect(parse("wake", "shell")).toEqual({ name: "wake", value: "shell" });
  for (const [name, value, error] of [
    ["close_tab", "", "UnknownAction"],
    ["focus", "north", "BadValue"],
    ["wake", "codex", "BadValue"],
    ["resize", "", "BadValue"],
    ["tab", "two", "BadValue"],
  ])
    expect(() => parse(name, value)).toThrow(error);
});
