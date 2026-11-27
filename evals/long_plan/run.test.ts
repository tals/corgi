import { expect, test } from "bun:test";
import { validateResume } from "./run";

test("text-only replays resume with a null schema while rejecting prompt or configuration changes", () => {
  const current = {
    model: "claude:claude-haiku-5-5",
    schema: null,
    instructions: "Return BEGIN_PLAN and commands",
    transport: "ownership-deltas",
    manifest_hash: "same-evidence",
    cache_turns: 16,
  };
  expect(() => validateResume({ ...current }, current)).not.toThrow();
  for (const change of [{ schema: "{}" }, { instructions: "Another prompt" }, { cache_turns: 32 }])
    expect(() => validateResume(current, { ...current, ...change })).toThrow("ResumeConfigurationChanged");
  const { cache_turns, ...legacy } = current;
  expect(() => validateResume(legacy, current, { cache_turns })).not.toThrow();
  expect(() => validateResume({ ...legacy, cache_turns: null }, current, { cache_turns })).toThrow(
    "ResumeConfigurationChanged:cache_turns",
  );
});
