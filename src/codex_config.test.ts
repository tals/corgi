import { test, expect } from "bun:test";
import { titleItems, edit } from "./codex_config";
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
