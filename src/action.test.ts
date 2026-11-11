import * as viewerRef from "./viewer_ref";
import { test, expect } from "bun:test";
import { bind, parse, same, type Action } from "./action";
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
test("actions with workspace references survive JSON and compare by target", () => {
  const action: Action = { name: "worktrees", value: viewerRef.workspace(2, 3) };
  const copy: Action = JSON.parse(JSON.stringify(action));
  expect(same(action, copy)).toBe(true);
  expect(same(action, { name: "worktrees", value: viewerRef.workspace(1, 3) })).toBe(false);
  expect(same(action, { name: "worktrees", value: viewerRef.workspace(2, 4) })).toBe(false);
  expect(same(action, { name: "resources", value: viewerRef.workspace(2, 3) })).toBe(false);
  expect(same(action, { name: "worktrees", value: 3 })).toBe(false);
  expect(same(parse("split", "down"), { name: "split", value: "down" })).toBe(true);
  expect(same(parse("split", "down"), { name: "split", value: "right" })).toBe(false);
});

test("input templates bind workspace targets before dispatch", () => {
  const local = viewerRef.workspace(1, 3),
    remote = viewerRef.workspace(2, 3);
  const template = parse("resources");
  const action = bind(template, remote);
  expect(action).toEqual({ name: "resources", value: remote });
  expect(bind(template, local).value).toBe(local);
  expect(action.value).toBe(remote);
  expect(bind(parse("worktrees", "9"), remote).value).toBe(viewerRef.workspace(2, 9));
  expect(bind(parse("split", "down"), remote)).toEqual({ name: "split", value: "down" });
});

// Executable actions cannot carry unresolved or wrong-kind workspace targets.
function concreteTargets() {
  // @ts-expect-error A workspace action requires a target.
  const absent: Action = { name: "worktrees" };
  // @ts-expect-error Daemon-local numbers belong only to input templates.
  const local: Action = { name: "resources", value: 3 };
  // @ts-expect-error A pane identity is not a workspace identity.
  const pane: Action = { name: "worktrees", value: viewerRef.pane(1, 3) };
  return [absent, local, pane];
}
