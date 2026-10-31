import { test, expect } from "bun:test";
import { commandKeys, macLabel, transform } from "./ghostty_integration";
import type { Keys } from "./ghostty_integration";
import * as custom from "./keybindings";
import { Preferences } from "./preferences";
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n";
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
    expect(transform("", { preset: "cmux", prefix: "ctrl_b", bindings })).toContain(
      `keybind = ${host}=text:\\x1b[${codepoint};${modifiers}u\n`,
    );
  }
});
test("integration preserves custom bindings, covers physical digits, and is reversible", () => {
  const original = "# My settings\nkeybind = cmd+1=goto_tab:1\nfont-size = 14\n",
    keys: Keys = { preset: "corgi", prefix: "ctrl_b" },
    enabled = transform(original, keys);
  expect(enabled.startsWith(original)).toBe(true);
  for (let i = 1; i < 10; i++) expect(enabled).toContain(`keybind = cmd+digit_${i}=text:\\x02${i}\n`);
  expect(transform(enabled, keys)).toBe(enabled);
  expect(transform(enabled, null)).toBe(original);
  expect(() => transform(begin, null)).toThrow("InvalidIntegrationBlock");
});
test("re-rendering a block replaces the old prefix and keeps other settings", () => {
  const original = "font-size = 14\n",
    old = transform(original, { preset: "corgi", prefix: "ctrl_b" }),
    updated = transform(old, { preset: "corgi", prefix: "ctrl_a" });
  expect(updated.startsWith(original)).toBe(true);
  expect(updated).not.toContain("\\x02");
  expect(updated).toContain("keybind = cmd+t=text:\\x01c\n");
  expect(updated.split(begin).length - 1).toBe(1);
});
test("the block types the chosen prefix and each preset's keys", () => {
  const cases: { keys: Keys; lines: string[]; absent?: string[] }[] = [
    {
      keys: { preset: "corgi", prefix: "ctrl_a" },
      lines: ["cmd+t=text:\\x01c", "cmd+3=text:\\x013", "cmd+shift+t=text:\\x01u"],
      absent: ["\\x02"],
    },
    {
      keys: { preset: "tmux", prefix: "ctrl_b" },
      lines: ["cmd+1=text:\\x020", "cmd+w=text:\\x02&", "cmd+digit_9=text:\\x028"],
    },
    {
      keys: { preset: "herdr", prefix: "ctrl_b" },
      lines: ["cmd+t=text:\\x02c", "cmd+w=text:\\x02X"],
    },
    {
      keys: { preset: "tmux", prefix: "ctrl_a" },
      lines: ["cmd+w=text:\\x01&", "ctrl+tab=text:\\x01n"],
      absent: ["\\x02"],
    },
    {
      keys: { preset: "cmux", prefix: "ctrl_a" },
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
      absent: ["\\x01", "\\x02"],
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
    expect(() => transform("font-size = 14\n", { preset: "cmux", prefix: "ctrl_b", bindings })).toThrow("in Ghostty");
    const prefs = Object.assign(new Preferences(), { preset: "cmux", keys });
    expect(() => prefs.bindings()).toThrow("in Ghostty");
  }
  const bindings = custom.resolve("cmux", { new: first, next: "prefix+" + second });
  expect(() => transform("", { preset: "cmux", prefix: "ctrl_b", bindings })).not.toThrow();
});

test("custom bindings update host aliases and unbound actions remove them", async () => {
  const custom = await import("./keybindings");
  const bindings = custom.resolve("corgi", {
    new: "prefix+ctrl+y",
    "close-tab": [],
    tab: { keys: ["prefix+é", "prefix+f12"] },
  });
  const block = transform("", { preset: "corgi", prefix: "ctrl_b", bindings });
  expect(block).toContain("cmd+t=text:\\x02\\x1b[121;5u");
  expect(block).not.toContain("cmd+w=");
  expect(block).toContain("cmd+1=text:\\x02\\x1b[233;1u");
  expect(block).toContain("cmd+2=text:\\x02\\x1b[57375;1u");
  expect(block).not.toContain("cmd+3=");
});
