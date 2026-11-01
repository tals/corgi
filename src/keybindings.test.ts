import { expect, test } from "bun:test";
import * as custom from "./keybindings";
import * as bindings from "./bindings";
import * as keys from "./keys";
import type { Preset } from "./keymap";

test("every preset keeps its actions and repeat flags without overrides", () => {
  for (const preset of ["corgi", "tmux", "herdr", "cmux"] as Preset[]) {
    const compiled = custom.resolve(preset, {});
    for (const b of bindings.table(preset)) {
      expect(bindings.lookup(compiled, b.prefixed, b.key, b.mods)).toEqual(b.action);
      if (b.repeat) expect(bindings.repeat(compiled, { codepoint: b.key, mods: b.mods })).toEqual(b.action);
    }
  }
});
test("strings and arrays replace an action, empty arrays unbind it", () => {
  const config = custom.parse({ new: ["prefix+y", "ctrl+alt+n"], "close": [] });
  const table = custom.resolve("corgi", config);
  expect(bindings.lookup(table, true, 99)).toBeNull();
  expect(bindings.lookup(table, false, 20)).toBeNull();
  expect(bindings.lookup(table, true, 121)).toEqual({ name: "new" });
  expect(bindings.chord(table, false, keys.parseChord("ctrl+alt+n")!)).toEqual({ name: "new" });
  expect(bindings.lookup(table, true, 120)).toBeNull();
});
test("every preset can bind the last visited tab and workspace actions", () => {
  const config = custom.parse({ "last-tab": "alt+t", "last-workspace": "alt+w" });
  for (const preset of ["corgi", "tmux", "herdr", "cmux"] as const) {
    const table = custom.resolve(preset, config);
    expect(bindings.chord(table, false, keys.parseChord("alt+t")!)).toEqual({ name: "last-tab" });
    expect(bindings.chord(table, false, keys.parseChord("alt+w")!)).toEqual({ name: "last-workspace" });
  }
});
test("control bytes, CSI-u chords and uppercase letters match the same bindings", () => {
  const table = custom.resolve("corgi", custom.parse({ new: "ctrl+y", "focus:left": "prefix+shift+h" }));
  expect(bindings.lookup(table, false, 25)).toEqual({ name: "new" });
  expect(bindings.chord(table, false, keys.parseChord("ctrl+y")!)).toEqual({ name: "new" });
  expect(bindings.lookup(table, true, 72)).toEqual({ name: "focus", value: "left" });
});
test("indexed ranges and arbitrary logical key sets map in order", () => {
  const config = custom.parse({ tab: [{ keys: ["prefix+é", "prefix+ctrl+s", "prefix+left"] }, "alt+f1..f3"] });
  const table = custom.resolve("corgi", config);
  expect(bindings.lookup(table, true, "é".codePointAt(0)!)).toEqual({ name: "tab", value: 1 });
  expect(bindings.lookup(table, true, 19)).toEqual({ name: "tab", value: 2 });
  expect(bindings.lookup(table, false, 57366, { alt: true })).toEqual({ name: "tab", value: 3 });
  expect(bindings.lookup(table, true, 49)).toBeNull();
  const row = custom.entries("corgi", config).find(e => e.id === "tab")!;
  expect(row.shortcuts).toHaveLength(2);
  expect(custom.serialize(row.shortcuts[1], true)).toBe("alt+f1..f3");
});
test("malformed, duplicate and conflicting custom bindings fail as a whole", () => {
  for (const raw of [
    { new: 13 },
    { new: "prefix+bogus" },
    { new: "constructor" },
    { new: "ctrl+__proto__" },
    { new: "__proto__+a" },
    { tab: { keys: ["prefix+a", "a"] } },
    { tab: { keys: ["prefix+a", "prefix+a"] } },
    { tab: "prefix+9..1" },
    { unknown: "x" },
    { new: "prefix+1..9" },
  ])
    expect(() => custom.parse(raw)).toThrow();
  expect(() => custom.resolve("corgi", custom.parse({ new: "prefix+y", close: "prefix+y" }))).toThrow("same shortcut");
  expect(() => custom.resolve("corgi", custom.parse({ new: ["ctrl+y", "control+y"] }))).toThrow("Duplicate");
});
test("conflict moves are explicit and indexed sets cannot be partially stolen", () => {
  const newKey = custom.parseShortcut("prefix+n", false);
  expect(() => custom.change("corgi", {}, "new", 0, newKey)).toThrow("Used by");
  const moved = custom.change("corgi", {}, "new", 0, newKey, true);
  expect(moved.next).toEqual([]);
  expect(bindings.lookup(custom.resolve("corgi", moved), true, 110)).toEqual({ name: "new" });
  expect(() => custom.change("corgi", {}, "new", 0, custom.parseShortcut("prefix+1", false), true)).toThrow(
    "whole key set",
  );
  expect(() => custom.resolve("corgi", custom.parse({ new: "prefix+1" }))).toThrow("whole key set");
});
test("restoring an action removes only its override and preserves other customizations", () => {
  const config = custom.parse({ new: "prefix+y", close: [] });
  const restored = custom.restore("corgi", config, "new");
  expect(restored).toEqual({ close: [] });
  expect(bindings.lookup(custom.resolve("corgi", restored), false, 20)).toEqual({ name: "new" });
});

test("reserved keys and prototype action names are rejected", () => {
  expect(() => custom.parse({ new: "esc" })).toThrow("reserved");
  expect(() => custom.validatePrefix({ new: "ctrl+b" }, "ctrl_b")).toThrow("reserved");
  expect(() => custom.parse({ toString: "x" })).toThrow("Unknown");
  expect(() => custom.restore("corgi", { new: "prefix+x", close: [] }, "close")).toThrow("used by");
});

test("ranges show shared modifiers once with a visible range separator", () => {
  for (const [value, expected] of [
    ["prefix+1..9", "◇ [1..9]"],
    ["shift+1..9", "⇧+[1..9]"],
    ["ctrl+alt+shift+1..9", "Ctrl+Alt+⇧+[1..9]"],
    ["prefix+ctrl+alt+shift+1..9", "◇ Ctrl+Alt+⇧+[1..9]"],
    ["cmd+shift+f1..f9", "Cmd+⇧+[F1..F9]"],
    ["alt+f10..f12", "Alt+[F10..F12]"],
  ]) {
    const shortcut = custom.parseShortcut(value, true);
    expect(custom.display(shortcut)).toBe(expected);
    expect(custom.serialize(shortcut, true)).toBe(value);
  }
});

test("sparse key sets share modifiers without implying keys in between", () => {
  const sparse = custom.parseShortcut({ keys: ["ctrl+alt+shift+1", "ctrl+alt+shift+9"] }, true);
  expect(custom.display(sparse)).toBe("Ctrl+Alt+⇧+(1, 9)");
  expect(sparse.keys).toHaveLength(2);
  expect(custom.display(custom.parseShortcut({ keys: ["prefix+é", "prefix+&"] }, true))).toBe("◇ (é, &)");
  expect(custom.display(custom.parseShortcut({ keys: ["ctrl+1", "alt+9"] }, true))).toBe("Ctrl+1 Opt+9");
});
