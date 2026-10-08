import { describe, expect, test } from "bun:test";
import { grade, scorecard, validateCases, type Observation, type Result } from "./score";
import cases from "./cases.json";

const output = (label: string | null): Observation => ({ id: "case", status: label === null ? "abstained" : "label", label, raw: JSON.stringify({ label }), elapsed_ms: 1000 });
describe("activity eval assertions", () => {
  test("fixtures have meaningful, bounded assertions", () => { expect(validateCases(cases)).toHaveLength(17); });
  test("the original failure fails even though it has three words", () => {
    expect(grade({ evidence: "make", expect: "abstain" }, output("Awaiting task details"))).toContain("expected abstention");
  });
  test("errors and malformed output cannot earn abstention credit", () => {
    for (const observation of [null, { ...output(null), status: "error", err: "Timeout" }, { ...output(null), raw: "{}" }, { ...output(null), raw: "{\"label\":null,\"reason\":\"?\"}" }]) {
      expect(grade({ evidence: "make", expect: "abstain" }, observation).length).toBeGreaterThan(0);
    }
  });
  test("positive controls prevent a model from passing by always abstaining", () => {
    const step = { evidence: "running tests", expect: "label" as const, all: ["test"] };
    expect(grade(step, output(null))).toEqual(["unnecessary abstention"]);
    expect(grade(step, output("Running tests"))).toEqual([]);
    expect(grade(step, output("Fixing cursor visibility"))).toContain("missing topic: test");
  });
  test("known background waits are useful; invented input waits are not", () => {
    expect(grade({ evidence: "build", expect: "label", all: ["build"] }, output("Waiting for build"))).toEqual([]);
    expect(grade({ evidence: "tests", expect: "label", all: ["test"] }, output("Waiting for user input"))).toContain("generic or unsupported input-status label");
  });
  test("scorecard includes failures in denominators", () => {
    const base = { model: "fixture", provider: "codex", id: "case", scenario: "case", category: "abstention", repeat: 1, expected: { evidence: "make", expect: "abstain" }, observation: output(null), failures: [] } as Result;
    expect(scorecard([base, { ...base, observation: null, failures: ["missing result"] }])).toContain("| fixture | 1/2 | 1/2 |");
  });
});
