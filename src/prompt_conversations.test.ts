import { expect, test } from "bun:test";
import { opens, refs } from "./prompt_conversations";

test("a block names each conversation once, by provider and session, past bullets and notes", () => {
  expect(opens("```conversations")).toBe(true);
  expect(opens("  ``` conversations  ")).toBe(true);
  expect(opens("```ts")).toBe(false);
  expect(
    refs([
      "claude 4f9e2a51",
      "- codex 019a3c2e  Fix the CI",
      "2. omp abc",
      "claude 4f9e2a51",
      "nobody 123",
      "claude",
      "",
    ]),
  ).toEqual([
    { provider: "claude", session: "4f9e2a51" },
    { provider: "codex", session: "019a3c2e" },
    { provider: "omp", session: "abc" },
  ]);
});
