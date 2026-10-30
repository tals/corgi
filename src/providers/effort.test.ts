import { expect, test } from "bun:test";
import * as effort from "./effort";
import * as options from "../agent_options";
import { Launch } from "../runtime";

test("effort is validated at the saved-options boundary", () => {
  expect(options.read({ flags: "", env: [], model: "astra", effort: "high" })?.effort).toBe("high");
  expect(options.read({ flags: "", env: [], effort: "bogus" })).toBeNull();
});
test("explicit effort replaces CLI overrides and preserves literal prompt words", () => {
  expect(
    effort.apply(null, ["--config", "model_reasoning_effort=low", "-c", "other=true", "--", "--effort"], "high"),
  ).toEqual(["-c", "other=true", "-c", 'model_reasoning_effort="high"', "--", "--effort"]);
  expect(effort.apply("--effort", ["--effort=low", "--verbose"], "max")).toEqual(["--verbose", "--effort", "max"]);
  expect(effort.apply("--thinking", ["--thinking", "low"], "high")).toEqual(["--thinking", "high"]);
  expect(effort.apply("--effort", ["--effort", "low"])).toEqual(["--effort", "low"]);
  expect(Launch.in("codex", "", false, { flags: "", env: [], model: "astra", effort: "xhigh" }).agent?.args).toEqual([
    "-c",
    'model_reasoning_effort="xhigh"',
  ]);
});
