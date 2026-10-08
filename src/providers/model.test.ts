import { test, expect } from "bun:test";
import { Model } from "./model";
const cases: Array<[string, string, string, bigint]> = [
  ["claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", 1000000n],
  ["claude-opus-5", "claude-opus-5", "Opus 5", 1000000n],
  ["claude-opus-4-8", "claude-opus-4-8", "Opus 4.8", 1000000n],
  ["claude-opus-4-7", "claude-opus-4-7", "Opus 4.7", 1000000n],
  ["claude-opus-4-6", "claude-opus-4-6", "Opus 4.6", 200000n],
  ["claude-opus-4-5-20251101", "claude-opus-4-5-20251101", "Opus 4.5", 200000n],
  ["claude-opus-4-1-20250805", "claude-opus-4-1-20250805", "Opus 4.1", 200000n],
  ["claude-opus-4-0", "claude-opus-4-0", "Opus 4", 200000n],
  ["claude-opus-4-20250514", "claude-opus-4-20250514", "Opus 4", 200000n],
  ["claude-sonnet-5-5", "claude-sonnet-5-5", "Sonnet 5.5", 1000000n],
  ["claude-sonnet-4-6[1m]", "claude-sonnet-4-6", "Sonnet 4.6 (1M context)", 1000000n],
  ["claude-opus-5-5[1m]", "claude-opus-5-5", "Opus 5.5", 1000000n],
  ["claude-haiku-5-5", "claude-haiku-5-5", "Haiku 5.5", 1000000n],
  ["claude-haiku-4-5-20251001", "claude-haiku-4-5-20251001", "Haiku 4.5", 200000n],
  ["claude-fable-5-1", "claude-fable-5-1", "Fable 5.1", 1000000n],
  ["claude-mythos-5", "claude-mythos-5", "Mythos 5", 1000000n],
  ["claude-3-5-sonnet", "claude-3-5-sonnet", "Sonnet 3.5", 200000n],
  ["claude-3-7-sonnet-20250219", "claude-3-7-sonnet-20250219", "Sonnet 3.7", 200000n],
  ["us.anthropic.claude-haiku-4-5-20251001-v1:0", "claude-haiku-4-5-20251001", "Haiku 4.5", 200000n],
  ["us.anthropic.claude-3-5-sonnet-20241022-v2:0", "claude-3-5-sonnet-20241022", "Sonnet 3.5", 200000n],
  ["anthropic.claude-opus-5-5", "claude-opus-5-5", "Opus 5.5", 1000000n],
  [
    "arn:aws:bedrock:us-east-1:123456789012:inference-profile/global.anthropic.claude-sonnet-5",
    "claude-sonnet-5",
    "Sonnet 5",
    1000000n,
  ],
  ["claude-opus-4-5@20251101", "claude-opus-4-5-20251101", "Opus 4.5", 200000n],
  ["claude-3-5-sonnet-v2@20241022", "claude-3-5-sonnet-20241022", "Sonnet 3.5", 200000n],
  [
    "projects/p/locations/us-east5/publishers/anthropic/models/claude-opus-4-1@20250805",
    "claude-opus-4-1-20250805",
    "Opus 4.1",
    200000n,
  ],
  ["gpt-6-astra", "gpt-6-astra", "GPT-6 Astra", 0n],
  ["gpt-6.1-sol", "gpt-6.1-sol", "GPT-6.1 Sol", 0n],
  ["gpt-5.5", "gpt-5.5", "GPT-5.5", 0n],
  ["gpt-5.3-codex-spark", "gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", 0n],
  ["codex-auto-review", "codex-auto-review", "Codex Auto Review", 0n],
  ["opus", "opus", "Opus", 0n],
  ["sonnet[1m]", "sonnet[1m]", "Sonnet (1M context)", 0n],
  ["opusplan", "opusplan", "Opus Plan Mode", 0n],
  ["google/gemma-4-26b-a4b-it", "google/gemma-4-26b-a4b-it", "", 0n],
  ["<synthetic>", "<synthetic>", "", 0n],
  ["gpt-oss-120b", "gpt-oss-120b", "", 0n],
  ["claude-opus-4-5-experimental", "claude-opus-4-5-experimental", "", 0n],
  ["best", "best", "", 0n],
  ["", "", "", 0n],
];
test("ids resolve to the names Claude Code and Codex show, across provider spellings", () => {
  for (const [reported, id, name, window] of cases) {
    const model = Model.resolve(reported);
    expect(model.id.text()).toBe(id);
    expect(model.name.text()).toBe(name);
    expect(model.window).toBe(window);
  }
});
