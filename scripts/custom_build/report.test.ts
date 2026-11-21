import { expect, test } from "bun:test";
import { harnessLines, tokens } from "./report";

test("tokens show one decimal in thousands from 1000 on", () => {
  expect(tokens(0)).toBe("0");
  expect(tokens(999)).toBe("999");
  expect(tokens(1000)).toBe("1.0k");
  expect(tokens(51000)).toBe("51.0k");
  expect(tokens(7449)).toBe("7.4k");
});

test("harness lines total the known tokens and say how many calls are unknown", () => {
  expect(
    harnessLines([
      {
        call: 1,
        kind: "build",
        step: "test",
        attempt: 1,
        ok: false,
        reason: "it changed nothing",
        seconds: 3,
        usage: null,
      },
      { call: 2, kind: "build", step: "test", attempt: 2, ok: true, seconds: 5, usage: { input: 1500, output: 200 } },
    ]),
  ).toEqual([
    "- 2 calls, 1 accepted, tokens 1.5k in / 200 out (1 call unknown)",
    "- test fix try 1: rejected: it changed nothing, tokens unknown",
    "- test fix try 2: accepted, 1.5k in / 200 out",
  ]);
});
