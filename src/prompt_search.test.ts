import { expect, test } from "bun:test";
import { parse, entry, type State } from "./prompt_search";

const state: State = {
  id: "search-a",
  revision: 1,
  phase: "searching",
  expression: "unicode|emoji",
  workspace: "/work",
  found: 1,
  scanned: 20,
  total: 40,
  limited: false,
  error: "",
  matches: [
    {
      provider: "codex",
      session: "found",
      account: "",
      cwd: "/work",
      title: "Unicode fix",
      excerpt: "PR https://github.com/example/project/pull/34",
      updated_at: 10000,
    },
  ],
};
test("search progress parses bounded provider rows and strips terminal controls", () => {
  const parsed = parse({ ...state, expression: "\u001b[2Jemoji\n" });
  expect(parsed?.expression).not.toContain("\u001b");
  expect(parsed?.expression).not.toContain("\n");
  expect(entry(parsed!.matches[0])).toMatchObject({ provider: "codex", session: "found", updated_at: 10 });
});
test("search progress rejects malformed counts, phases and provider rows", () => {
  for (const bad of [
    null,
    [],
    {},
    { ...state, phase: "loading" },
    { ...state, scanned: 41 },
    { ...state, found: -1 },
    { ...state, found: 0 },
    { ...state, matches: [null] },
    { ...state, matches: Array(6).fill(state.matches[0]) },
    { ...state, matches: [{ ...state.matches[0], provider: "madeup" }] },
  ])
    expect(parse(bad)).toBeNull();
});
