import { expect, test } from "bun:test";
import { Stars } from "./agent_stars";

test("stars keep only session ids a checkpoint can restore", () => {
  const stars = new Stars();
  expect(stars.set("claude", "bad\x01id", true)).toBe(false);
  expect(stars.set("claude", "x".repeat(161), true)).toBe(false);
  expect(stars.set("claude", "good", true)).toBe(true);
  expect(Stars.restore(stars.slice()).slice()).toEqual([{ provider: "claude", session: "good" }]);
});
test("restoring drops unusable sessions and keeps the rest", () => {
  const stars = Stars.restore([
    { provider: "claude", session: "a�" },
    { provider: "claude", session: "" },
    { provider: "codex", session: "b" },
  ]);
  expect(stars.slice()).toEqual([{ provider: "codex", session: "b" }]);
  expect(() => Stars.restore([{ provider: "claude" }])).toThrow("InvalidAgentStars");
});
