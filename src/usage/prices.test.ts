import { test, expect } from "bun:test";
import { lookup, equivalent } from "./prices";
test("model ids match their base model and family aliases", () => {
  for (const [model, cost] of [
    ["claude-opus-5-5[1m]", 4000n],
    ["claude-opus-5", 5000n],
    ["claude-haiku-4-5-20251001", 1000n],
    ["claude-haiku-5-5", 100n],
    ["haiku", 100n],
    ["claude-opus-4-7", 5000n],
    ["claude-opus-4-20250514", 15000n],
  ] as const)
    expect(lookup(model)?.input).toBe(cost);
  expect(lookup("gpt-6-luna")?.label).toBe("luna");
  expect(lookup("opus")?.label).toBe("opus");
  for (const model of ["claude-opus-55", "codex-auto-review", ""])
    expect(lookup(model)).toBeNull();
});
test("equivalent tokens rescale input and output separately", () => {
  const opus = lookup("claude-opus-5")!,
    haiku = lookup("claude-haiku-4-5")!;
  expect(equivalent(haiku, opus, 5000n, 1000n)).toBe(1200n);
  expect(equivalent(opus, opus, 5000n, 1000n)).toBe(6000n);
});
