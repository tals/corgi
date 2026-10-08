import { test, expect } from "bun:test";
import { table, lookup, chord, find, prefixedSequence } from "./bindings";
import type { Preset } from "./keymap";
test("no preset binds a key twice", () => {
  for (const preset of ["corgi", "tmux", "herdr", "cmux"] as Preset[]) {
    const seen = new Set();
    for (const b of table(preset)) {
      const key = JSON.stringify([b.key, b.mods, b.prefixed]);
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  }
});
test("presets preserve first shortcuts and held chords", () => {
  expect(find("corgi", { name: "new" })?.key).toBe(99);
  expect(lookup("corgi", true, 118)).toEqual({ name: "split", value: "right" });
  expect(lookup("tmux", true, 48)).toEqual({ name: "tab", value: 1 });
  expect(chord("cmux", false, { codepoint: 116, mods: { super: true } })).toEqual({ name: "new" });
  expect(prefixedSequence("tmux", "\x1b[1;5D")).toEqual({
    name: "resize",
    value: "left",
  });
});

test("each action shows its first binding", () => {
  const cases: [Preset, import("./action").Action, number, import("./keyboard").Mods, boolean][] = [
    ["corgi", { name: "new" }, 99, {}, true],
    ["corgi", { name: "split", value: "right" }, 118, {}, true],
    ["corgi", { name: "detach" }, 113, {}, true],
    ["tmux", { name: "split", value: "right" }, 37, {}, true],
    ["tmux", { name: "tab", value: 1 }, 48, {}, true],
    ["herdr", { name: "choose-workspace" }, 119, {}, true],
    ["cmux", { name: "new" }, 116, { super: true }, false],
    ["cmux", { name: "tab", value: 3 }, 51, { ctrl: true }, false],
    ["cmux", { name: "swap", value: "up" }, 75, {}, true],
  ];
  for (const [preset, action, key, mods, prefixed] of cases) {
    const binding = find(preset, action)!;
    expect(binding.key).toBe(key);
    for (const name of ["ctrl", "alt", "shift", "super"] as const) expect(!!binding.mods[name]).toBe(!!mods[name]);
    expect(binding.prefixed).toBe(prefixed);
  }
  expect(find("tmux", { name: "resize-mode" })).toBeNull();
});

test("keys are spelled the way the help screen shows them", async () => {
  const { format } = await import("./bindings");
  const cases: [number, import("./keyboard").Mods, string][] = [
    [99, {}, "c"],
    [84, {}, "T"],
    [9, {}, "Tab"],
    [20, {}, "Ctrl+T"],
    [116, { super: true }, "Cmd+T"],
    [93, { super: true, shift: true }, "Cmd+Shift+]"],
    [13, { super: true, shift: true }, "Cmd+Shift+Enter"],
    [9, { shift: true }, "Shift+Tab"],
    [57352, { ctrl: true }, "Ctrl+↑"],
    [57364, {}, "F1"],
  ];
  for (const [key, mods, text] of cases)
    expect(format({ key, mods, prefixed: true, action: { name: "new" } })).toBe(text);
});

test("every preset has keys for a new tab, help and detach after the prefix", async () => {
  const { first } = await import("./bindings");
  for (const preset of ["corgi", "tmux", "herdr", "cmux"] as Preset[])
    for (const name of ["new", "help", "detach"] as const) expect(first(preset, { name }, true)).not.toBeNull();
});

test("compact spellings for the onboarding cards", async () => {
  const { compact } = await import("./bindings");
  const cases: [number, import("./keyboard").Mods, string][] = [
    [118, {}, "v"],
    [34, {}, '"'],
    [100, { super: true }, "D"],
    [100, { super: true, shift: true }, "⇧D"],
    [93, { super: true, shift: true }, "⇧]"],
    [57352, { super: true, alt: true }, "↑"],
  ];
  for (const [key, mods, text] of cases)
    expect(compact({ key, mods, prefixed: true, action: { name: "new" } })).toBe(text);
});

test("the shortcut table lists each preset's keys", async () => {
  const { writeTable } = await import("./bindings");
  const text = writeTable(["corgi", "tmux", "cmux"]);
  expect(text.startsWith("| Action | Corgi | tmux | cmux |\n| --- | --- | --- | --- |\n")).toBe(true);
  for (const row of [
    "| New tab (agent picker) | `prefix c`, `Ctrl+T` | `prefix c` | `Cmd+T`, `prefix c` |\n",
    "| Split right | `prefix v`, `prefix %` | `prefix %` | `Cmd+D`, `prefix v`, `prefix %` |\n",
    "| Select tab | `prefix 1–9` | `prefix 0–9` | `Ctrl+1–9`, `prefix 1–9` |\n",
    "| Select workspace |  |  | `Cmd+1–9` |\n",
    "| Resize up |  | `prefix Ctrl+↑` | `Ctrl+Shift+K` |\n",
    "| Jump to attention | `prefix f`, `F1` | `prefix F` | `Cmd+Shift+U`, `prefix f` |\n",
  ])
    expect(text).toContain(row);
  expect(text).not.toContain("Relaunch");
});

test("keys that arrive as bytes", () => {
  expect(lookup("tmux", true, 57)).toEqual({ name: "tab", value: 10 });
  expect(lookup("herdr", true, 103)).toEqual({ name: "choose-workspace" });
  expect(lookup("corgi", true, 37)).toEqual({ name: "split", value: "right" });
  expect(lookup("corgi", false, 20)).toEqual({ name: "new" });
  expect(lookup("cmux", false, 20)).toBeNull();
  expect(lookup("tmux", true, 118)).toBeNull();
  expect(lookup("corgi", true, 0xf0)).toBeNull();
});

test("keys that arrive as sequences", () => {
  const cases: [Preset, boolean, number, import("./keyboard").Mods, import("./action").Action | null][] = [
    ["cmux", false, 116, { super: true }, { name: "new" }],
    ["cmux", true, 116, { super: true }, { name: "new" }],
    ["cmux", false, 84, { super: true }, { name: "new" }],
    ["cmux", false, 125, { super: true, shift: true }, { name: "next" }],
    ["cmux", false, 57345, { super: true, shift: true }, { name: "zoom" }],
    ["cmux", false, 52, { super: true }, { name: "goto-workspace", value: 4 }],
    ["tmux", true, 57350, {}, { name: "focus", value: "left" }],
    ["tmux", true, 57352, { ctrl: true }, { name: "resize", value: "up" }],
    ["tmux", false, 57350, {}, null],
    ["herdr", true, 57346, { shift: true }, { name: "prev-pane" }],
    ["corgi", false, 116, { ctrl: true }, null],
    ["corgi", true, 99, {}, null],
    ["corgi", false, 57364, {}, { name: "attention" }],
    ["corgi", true, 57364, {}, { name: "attention" }],
    ["corgi", false, 84, { ctrl: true, shift: true }, { name: "undo-close" }],
    ["corgi", false, 116, { super: true, shift: true }, { name: "undo-close" }],
    ["cmux", false, 84, { super: true, shift: true }, { name: "undo-close" }],
    ["tmux", false, 57364, {}, null],
  ];
  for (const [preset, prefixed, codepoint, mods, action] of cases)
    expect(chord(preset, prefixed, { codepoint, mods })).toEqual(action);
  expect(prefixedSequence("tmux", "\x1b[1;5D")).toEqual({
    name: "resize",
    value: "left",
  });
  expect(prefixedSequence("herdr", "\x1b[Z")).toEqual({ name: "prev-pane" });
  for (const [preset, seq] of [
    ["corgi", "\x1b[Z"],
    ["tmux", "\x1b[1;2D"],
    ["tmux", "\x1b[1;5E"],
  ] as const)
    expect(prefixedSequence(preset, seq)).toBeNull();
});
