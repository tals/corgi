import { test, expect } from "bun:test";
import { titleItems, edit, restoredTitle, movedApprovals } from "./config";
test("title setup preserves custom items and is idempotent", () => {
  expect(titleItems({ terminal_title: ["activity", "project"] })).toEqual(["activity", "project", "thread-id"]);
  expect(titleItems({ terminal_title: ["thread-id", "project"] })).toBeNull();
});
test("title setup supplies defaults and rejects malformed values", () => {
  expect(titleItems(null)?.[1]).toBe("thread-id");
  expect(() => titleItems({ terminal_title: ["thread-id", 42] })).toThrow("InvalidTitleConfig");
});
test("title setup targets the base user layer with a version precondition", () => {
  const result = {
    layers: [
      { name: { type: "project" }, config: { tui: { terminal_title: ["thread-id"] } } },
      { name: { type: "user", file: "/config.toml", profile: "work" }, version: "profile", config: {} },
      {
        name: { type: "user", file: "/config.toml", profile: null },
        version: "original",
        config: { tui: { terminal_title: [] } },
      },
    ],
  };
  expect(edit(result, "/config.toml")).toEqual({
    keyPath: "tui.terminal_title",
    value: ["thread-id"],
    mergeStrategy: "replace",
    filePath: "/config.toml",
    expectedVersion: "original",
  });
  expect(() => edit(result, "/other.toml")).toThrow("MissingUserConfig");
  expect(() => edit(null, "/config.toml")).toThrow("MissingConfigLayers");
});
test("title removal restores the original, or drops only the thread ID", () => {
  const added = ["app-name", "thread-id", "activity", "project"];
  expect(restoredTitle(added, null)).toBeNull();
  expect(restoredTitle(added, {})).toBeNull();
  expect(restoredTitle(["activity", "thread-id"], { tui: { terminal_title: ["activity"] } })).toEqual(["activity"]);
  expect(
    restoredTitle(["thread-id", "project"], { tui: { terminal_title: ["thread-id", "project"] } }),
  ).toBeUndefined();
  expect(restoredTitle(["project", "thread-id", "spinner"], { tui: { terminal_title: ["project"] } })).toEqual([
    "project",
    "spinner",
  ]);
  expect(restoredTitle(["project"], null)).toBeUndefined();
  expect(restoredTitle(undefined, null)).toBeUndefined();
});
test("approval removal drops Corgi's and moves the rest to their new positions", () => {
  const file = "/home/.codex/hooks.json",
    state = {
      [`${file}:session_start:0:0`]: { trusted_hash: "corgi" },
      [`${file}:session_start:1:0`]: { trusted_hash: "herdr" },
      [`${file}:pre_tool_use:0:0`]: { trusted_hash: "corgi" },
      [`/other/hooks.json:session_start:0:0`]: { trusted_hash: "other" },
    },
    removal = {
      text: "",
      removed: [
        { event: "SessionStart", group: 0, handler: 0 },
        { event: "PreToolUse", group: 0, handler: 0 },
      ],
      moved: [
        [
          { event: "SessionStart", group: 1, handler: 0 },
          { event: "SessionStart", group: 0, handler: 0 },
        ],
      ] as [any, any][],
    };
  expect(movedApprovals(state, file, removal)).toEqual({
    state: {
      [`${file}:session_start:0:0`]: { trusted_hash: "herdr" },
      [`/other/hooks.json:session_start:0:0`]: { trusted_hash: "other" },
    },
    moved: 1,
  });
  expect(movedApprovals({ [`/other/hooks.json:stop:0:0`]: {} }, file, removal)).toBeNull();
});
