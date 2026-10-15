import { test, expect } from "bun:test";
import { hookEvents, installedCommand, mergedConfig, removedConfig } from "./integration";
test("hook removal takes out only Corgi's handlers and reports where the rest moved", () => {
  const theirs = { type: "command", command: "herdr-hook session" },
    original = JSON.stringify({ model: "opus", hooks: { SessionStart: [{ hooks: [theirs] }] } }),
    merged = mergedConfig("claude", original)!,
    removal = removedConfig("claude", merged)!;
  expect(JSON.parse(removal.text)).toEqual(JSON.parse(original));
  expect(removal.removed).toContainEqual({ event: "SessionStart", group: 1, handler: 0 });
  expect(removal.moved).toEqual([
    [
      { event: "SessionStart", group: 0, handler: 0 },
      { event: "SessionStart", group: 0, handler: 0 },
    ],
  ]);
  expect(removedConfig("claude", removal.text)).toBeNull();
});
test("hook removal renumbers handlers after Corgi's and drops what it empties", () => {
  const ours = { type: "command", command: installedCommand("codex") },
    theirs = { type: "command", command: "theirs" },
    removal = removedConfig(
      "codex",
      JSON.stringify({
        hooks: { Stop: [{ hooks: [ours] }, { matcher: "x", hooks: [ours, theirs] }], PreToolUse: [{ hooks: [ours] }] },
      }),
    )!;
  expect(JSON.parse(removal.text)).toEqual({ hooks: { Stop: [{ matcher: "x", hooks: [theirs] }] } });
  expect(removal.moved).toEqual([
    [
      { event: "Stop", group: 1, handler: 1 },
      { event: "Stop", group: 0, handler: 0 },
    ],
  ]);
  expect(removedConfig("codex", JSON.stringify({ hooks: { Stop: [{ hooks: [ours] }] } }))!.text).toBe("{}");
  expect(removedConfig("codex", "{}")).toBeNull();
  expect(() => removedConfig("codex", "[]")).toThrow("InvalidHookSettings");
});
test("hook status counts the events that run Corgi's handler", () => {
  const all = mergedConfig("claude", "{}")!,
    some = JSON.parse(all);
  delete some.hooks.Stop;
  expect(hookEvents("claude", all)).toEqual([10, 10]);
  expect(hookEvents("claude", JSON.stringify(some))).toEqual([9, 10]);
  expect(hookEvents("claude", "{}")).toEqual([0, 10]);
});
