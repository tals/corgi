import { test, expect } from "bun:test";
import { commandKeys, macLabel, transform } from "./ghostty_integration";
import type { Keys } from "./ghostty_integration";
import * as custom from "./keybindings";
import { Preferences } from "./preferences";
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n";
test("Ghostty forwards custom prefixes without consuming them as host shortcuts", () => {
  for (const [prefix, host, encoded] of [
    ["cmd+t", "cmd+t", "\\x1b[116;9u"],
    ["ctrl+tab", "ctrl+tab", "\\x1b[9;5u"],
    ["cmd+1", "cmd+digit_1", "\\x1b[49;9u"],
  ])
    expect(transform("", { preset: "corgi", prefix })).toContain(`keybind = ${host}=text:${encoded}\n`);
  expect(transform("", { preset: "corgi", prefix: "f9" })).toContain("cmd+t=text:\\x1b[57372;1uc\n");
  expect(transform("", { preset: "corgi", prefix: "c" })).toContain("cmd+t=text:\\x14\n");
  expect(transform("", { preset: "tmux", prefix: "c" })).not.toContain("cmd+t=");
  expect(commandKeys("corgi", "corgi", "cmd+t").some(k => k.host === "cmd+t")).toBe(false);
  expect(commandKeys("tmux", "tmux", "c").some(k => k.host === "cmd+t")).toBe(false);
});
test.each(["corgi", "tmux", "herdr", "cmux"] as const)(
  "%s forwards the prefix independently of unbound actions",
  preset => {
    const bindings = custom.resolve(preset, { new: [], next: [], tab: [] });
    for (const [prefix, hosts, encoded] of [
      ["cmd+t", ["cmd+t"], "\\x1b[116;9u"],
      ["ctrl+tab", ["ctrl+tab"], "\\x1b[9;5u"],
      ["cmd+1", ["cmd+1", "cmd+digit_1"], "\\x1b[49;9u"],
      ["cmd+f9", ["cmd+f9"], "\\x1b[57372;9u"],
    ] as const) {
      const output = transform("", { preset, prefix, bindings });
      for (const host of hosts) {
        expect(output.split("\n").filter(line => line.startsWith(`keybind = ${host}=`))).toEqual([
          `keybind = ${host}=text:${encoded}`,
        ]);
        expect(commandKeys(preset, bindings, prefix).some(key => key.host === host)).toBe(false);
      }
    }
  },
);

test.each([
  ["cmd+plus", "cmd+shift+=", "cmd+shift+equal", "\\x1b[43;9u"],
  ["ctrl+plus", "ctrl+shift+=", "ctrl+shift+equal", "\\x1b[43;5u"],
  ["alt+plus", "alt+shift+=", "alt+shift+equal", "\\x1b[43;3u"],
  ["plus", "shift+=", "shift+equal", "+"],
])(
  "cmux gives prefix %s its Ghostty trigger when a binding uses another spelling",
  (prefix, binding, host, encoded) => {
    const bindings = custom.resolve("cmux", { new: binding }),
      output = transform("", { preset: "cmux", prefix, bindings });
    expect(output.split("\n").filter(line => line.startsWith(`keybind = ${host}=`))).toEqual([
      `keybind = ${host}=text:${encoded}`,
    ]);
    expect(commandKeys("cmux", bindings, prefix).some(key => key.host === host)).toBe(false);
  },
);

test("cmux forwards customized function, editing and Unicode keys", () => {
  for (const [chord, host, codepoint, modifiers] of [
    ["cmd+f1", "cmd+f1", 57364, 9],
    ["cmd+shift+f25", "cmd+shift+f25", 57388, 10],
    ["cmd+tab", "cmd+tab", 9, 9],
    ["cmd+space", "cmd+space", 32, 9],
    ["cmd+backspace", "cmd+backspace", 127, 9],
    ["cmd+insert", "cmd+insert", 57348, 9],
    ["cmd+delete", "cmd+delete", 57349, 9],
    ["cmd+home", "cmd+home", 57356, 9],
    ["cmd+end", "cmd+end", 57357, 9],
    ["cmd+pageup", "cmd+page_up", 57354, 9],
    ["cmd+pagedown", "cmd+page_down", 57355, 9],
    ["cmd+=", "cmd+equal", 61, 9],
    ["cmd+plus", "cmd+shift+equal", 43, 9],
    ["cmd+>", "cmd+shift+period", 62, 9],
    ["cmd+é", "cmd+é", 233, 9],
  ] as const) {
    const bindings = custom.resolve("cmux", { new: chord });
    expect(commandKeys("cmux", bindings)).toContainEqual({ host, action: { name: "new" } });
    expect(transform("", { preset: "cmux", prefix: "ctrl+b", bindings })).toContain(
      `keybind = ${host}=text:\\x1b[${codepoint};${modifiers}u\n`,
    );
  }
});
test("integration preserves custom bindings, covers physical digits, and is reversible", () => {
  const original = "# My settings\nkeybind = cmd+1=goto_tab:1\nfont-size = 14\n",
    keys: Keys = { preset: "corgi", prefix: "ctrl+b" },
    enabled = transform(original, keys);
  expect(enabled.startsWith(original)).toBe(true);
  for (let i = 1; i < 10; i++) expect(enabled).toContain(`keybind = cmd+digit_${i}=text:\\x1b[98;5u${i}\n`);
  expect(transform(enabled, keys)).toBe(enabled);
  expect(transform(enabled, null)).toBe(original);
  expect(() => transform(begin, null)).toThrow("InvalidIntegrationBlock");
});
test("re-rendering a block replaces the old prefix and keeps other settings", () => {
  const original = "font-size = 14\n",
    old = transform(original, { preset: "corgi", prefix: "ctrl+b" }),
    updated = transform(old, { preset: "corgi", prefix: "ctrl+a" });
  expect(updated.startsWith(original)).toBe(true);
  expect(updated).not.toContain("\\x1b[98;5u");
  expect(updated).toContain("keybind = cmd+t=text:\\x1b[97;5uc\n");
  expect(updated.split(begin).length - 1).toBe(1);
});
test("the block types the chosen prefix and each preset's keys", () => {
  const cases: { keys: Keys; lines: string[]; absent?: string[] }[] = [
    {
      keys: { preset: "corgi", prefix: "ctrl+a" },
      lines: ["cmd+t=text:\\x1b[97;5uc", "cmd+3=text:\\x1b[97;5u3", "cmd+shift+t=text:\\x1b[97;5uu"],
      absent: ["\\x1b[98;5u"],
    },
    {
      keys: { preset: "tmux", prefix: "ctrl+b" },
      lines: ["cmd+1=text:\\x1b[98;5u0", "cmd+w=text:\\x1b[98;5u&", "cmd+digit_9=text:\\x1b[98;5u8"],
    },
    {
      keys: { preset: "herdr", prefix: "ctrl+b" },
      lines: ["cmd+t=text:\\x1b[98;5uc", "cmd+w=text:\\x1b[98;5uX"],
    },
    {
      keys: { preset: "tmux", prefix: "ctrl+a" },
      lines: ["cmd+w=text:\\x1b[97;5u&", "ctrl+tab=text:\\x1b[97;5un"],
      absent: ["\\x1b[98;5u"],
    },
    {
      keys: { preset: "cmux", prefix: "ctrl+a" },
      lines: [
        "cmd+t=text:\\x1b[116;9u",
        "cmd+shift+right_bracket=text:\\x1b[93;10u",
        "cmd+alt+left=text:\\x1b[57350;11u",
        "ctrl+shift+h=text:\\x1b[104;6u",
        "ctrl+3=text:\\x1b[51;5u",
        "cmd+comma=text:\\x1b[44;9u",
        "cmd+shift+enter=text:\\x1b[13;10u",
        "cmd+shift+t=text:\\x1b[116;10u",
      ],
      absent: ["\\x1b[97;5u", "\\x1b[98;5u"],
    },
  ];
  for (const c of cases) {
    const block = transform("", c.keys);
    for (const line of c.lines) expect(block).toContain("keybind = " + line + "\n");
    for (const absent of c.absent ?? []) expect(block).not.toContain(absent);
  }
});

test("Command keys list what they bind, as a Mac menu writes them", () => {
  const corgi = commandKeys("corgi").map(key => macLabel(key.host));
  expect(corgi.slice(0, 5)).toEqual(["⌘T", "⌘W", "⌘⇧T", "⌃Tab", "⌃⇧Tab"]);
  expect(macLabel("cmd+digit_1")).toBe("⌘1");
  expect(macLabel("cmd+shift+left_bracket")).toBe("⌘⇧[");
  for (const [key, label] of [
    ["space", "Space"],
    ["quote", "'"],
    ["minus", "-"],
    ["period", "."],
    ["slash", "/"],
    ["semicolon", ";"],
    ["equal", "="],
    ["backslash", "\\"],
    ["backquote", "`"],
    ["backspace", "⌫"],
    ["insert", "Insert"],
    ["delete", "⌦"],
    ["page_up", "⇞"],
    ["page_down", "⇟"],
    ["home", "↖"],
    ["end", "↘"],
  ])
    expect(macLabel("cmd+" + key)).toBe("⌘" + label);
  const plus = commandKeys("cmux", custom.resolve("cmux", { new: "cmd+plus" })).find(b => b.action.name === "new")!;
  expect(macLabel(plus.host)).toBe("⌘⇧=");
});

test.each([
  ["cmd+plus", "cmd+shift+="],
  ["cmd+:", "cmd+shift+;"],
  ["cmd+>", "cmd+shift+."],
])("cmux rejects Ghostty trigger collisions between %s and %s", (first, second) => {
  const configs: custom.Config[] = [{ new: first, next: second }, { new: [first, second] }];
  for (const keys of configs) {
    const bindings = custom.resolve("cmux", keys);
    expect(() => transform("font-size = 14\n", { preset: "cmux", prefix: "ctrl+b", bindings })).toThrow("in Ghostty");
    const prefs = Object.assign(new Preferences(), { preset: "cmux", keys });
    expect(() => prefs.bindings()).toThrow("in Ghostty");
  }
  const bindings = custom.resolve("cmux", { new: first, next: "prefix+" + second });
  expect(() => transform("", { preset: "cmux", prefix: "ctrl+b", bindings })).not.toThrow();
});

test("custom bindings update host aliases and unbound actions remove them", async () => {
  const custom = await import("./keybindings");
  const bindings = custom.resolve("corgi", {
    new: "prefix+ctrl+y",
    "close-tab": [],
    tab: { keys: ["prefix+é", "prefix+f12"] },
  });
  const block = transform("", { preset: "corgi", prefix: "ctrl+b", bindings });
  expect(block).toContain("cmd+t=text:\\x1b[98;5u\\x1b[121;5u");
  expect(block).not.toContain("cmd+w=");
  expect(block).toContain("cmd+1=text:\\x1b[98;5u\\x1b[233;1u");
  expect(block).toContain("cmd+2=text:\\x1b[98;5u\\x1b[57375;1u");
  expect(block).not.toContain("cmd+3=");
});

test("agent selection never installs global Ghostty Space, letter or Shift-arrow bindings", () => {
  const bindings = custom.resolve("cmux", { "agent-select-toggle": "cmd+t" });
  const config = transform("", { preset: "cmux", prefix: "ctrl+b", bindings });
  expect(commandKeys("cmux", bindings).some(k => k.action.name.startsWith("agent-select-"))).toBe(false);
  for (const key of ["space", "v", "a", "m", "shift+up", "shift+down"])
    expect(config).not.toContain(`keybind = ${key}=`);
});
