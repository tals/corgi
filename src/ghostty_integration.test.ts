import { test, expect } from "bun:test";
import { transform } from "./ghostty_integration";
import type { Keys } from "./ghostty_integration";
const begin = "# BEGIN CORGI GHOSTTY INTEGRATION\n";
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
