import { test, expect } from "bun:test";
import { outdated, series, tier } from "./model_series";

const e = (model: string, name: string, provider = "claude", account = "") => ({ provider, account, model, name });

test("a name reads as its series, brand, lineup and version", () => {
  expect(series(e("claude-opus-5-5", "Opus 5.5"))).toEqual({
    key: ":opus",
    brand: ":opus",
    lineup: ":claude",
    version: [5, 5],
    variant: false,
  });
  expect(series(e("gpt-6.1-sol", "GPT-6.1-Sol"))).toMatchObject({ key: ":gpt sol", lineup: ":gpt", version: [6, 1] });
  expect(series(e("openai/gpt-6-luna-fast", "GPT-6 Luna Fast"))).toMatchObject({
    key: "openai:gpt luna fast",
    lineup: "openai:gpt",
    variant: true,
  });
  expect(series(e("github-copilot/claude-haiku-4.5", "Claude Haiku 4.5 (latest)"))).toMatchObject({
    key: "github-copilot:claude haiku",
    lineup: "github-copilot:claude",
    version: [4, 5],
  });
  expect(series(e("opencode/big-pickle", "Big Pickle"))).toMatchObject({ lineup: null, version: null });
  expect(series(e("opencode/mimo-v2.6-flash-free", "MiMo-V2.6-Flash Free")).version).toEqual([2, 6]);
});
test("older versions of a series, and a brand's older majors, are outdated in their own catalog", () => {
  const list = [
    e("claude-opus-5-5", "Opus 5.5"),
    e("claude-haiku-5-5", "Haiku 5.5"),
    e("claude-haiku-4-5-20251001", "Haiku 4.5"),
    e("claude-opus-5", "Opus 5"),
    e("claude-opus-4-8", "Opus 4.8"),
    e("gpt-6.1-sol", "GPT-6.1-Sol", "codex"),
    e("gpt-6-sol", "GPT-6-Sol", "codex"),
    e("gpt-6-luna", "GPT-6-Luna", "codex"),
    e("gpt-5.6-terra", "GPT-5.6-Terra", "codex"),
    e("openai/gpt-5.5", "GPT-5.5", "opencode2"),
    e("openai/gpt-6-astra", "GPT-6 Astra", "opencode2"),
    e("opencode/big-pickle", "Big Pickle", "opencode2"),
    // Another account's catalog keeps its own newest.
    e("claude-opus-5", "Opus 5", "claude", "/work"),
  ];
  expect([...outdated(list)].map(m => `${m.provider} ${m.name}`)).toEqual([
    "claude Haiku 4.5",
    "claude Opus 5",
    "claude Opus 4.8",
    "codex GPT-6-Sol",
    "codex GPT-5.6-Terra",
    "opencode2 GPT-5.5",
  ]);
});

test("a model's tier comes from its name", () => {
  expect(tier(e("claude-sonnet-5-5", "Sonnet 5.5"))).toBe("strong");
  expect(tier(e("gpt-6.1-terra", "GPT-6.1 Terra"))).toBe("strong");
  expect(tier(e("claude-haiku-5-5", "Haiku 5.5"))).toBe("light");
  expect(tier(e("gpt-6-luna", "GPT-6-Luna"))).toBe("light");
  expect(tier(e("claude-opus-5-5", "Opus 5.5"))).toBe("heavy");
  expect(tier(e("gpt-6.1-sol", "GPT-6.1-Sol"))).toBe("heavy");
  expect(tier(e("opencode/big-pickle", "Big Pickle"))).toBeNull();
});
