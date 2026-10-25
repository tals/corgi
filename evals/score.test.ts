import { describe, expect, test } from "bun:test";
import { grade, scorecard, validateCases, type Observation, type Result } from "./score";
import cases from "./cases.json";
import namingCases from "./naming_cases.json";

const output = (label: string | null, action = label === null ? "none" : "new"): Observation => ({
  id: "case",
  status: label === null ? "abstained" : "label",
  action,
  label,
  raw: JSON.stringify({
    action,
    label: action === "keep" ? null : label,
    task: { id: null, label: null },
    completed: [],
  }),
  task: { id: null, label: null },
  completed: [],
  input: {
    phase: action === "keep" ? label : null,
    work: { revision: 0, supplied: false, current_task: null, tasks: [] },
  },
  elapsed_ms: 1000,
});
describe("activity eval assertions", () => {
  test("fixtures have meaningful, bounded assertions", () => {
    expect(validateCases(cases)).toHaveLength(cases.length);
  });
  test("name cases use the production format and reject mismatched driver output", () => {
    expect(validateCases(namingCases)).toHaveLength(9);
    const step = { task: "name" as const, evidence: "Fix Pi OAuth", expect: "label" as const, all: ["Pi", "OAuth"] };
    const name = { ...output("Pi OAuth sign-in"), raw: '{"name":"Pi OAuth sign-in"}' };
    expect(grade(step, name)).toEqual([]);
    expect(grade(step, { ...name, raw: '{"name":null}' })).toEqual(["inconsistent name"]);
    expect(grade(step, { ...name, raw: '{"name":"One two three four five six seven eight"}' })).toEqual([
      "invalid name response",
    ]);
    expect(grade(step, output("Pi OAuth sign-in"))).toEqual(["invalid name response"]);
    expect(() => validateCases([{ id: "bad", category: "naming", steps: [{ ...step, task: "bogus" }] }])).toThrow();
  });
  test("the original failure fails even though it has three words", () => {
    expect(grade({ evidence: "make", expect: "abstain" }, output("Awaiting task details"))).toContain(
      "expected abstention",
    );
  });
  test("errors and malformed output cannot earn abstention credit", () => {
    for (const observation of [
      null,
      { ...output(null), status: "error", err: "Timeout" },
      { ...output(null), raw: "{}" },
      { ...output(null), raw: '{"label":null}' },
      { ...output(null), raw: '{"action":"skip","label":null}' },
      { ...output(null), raw: '{"label":null,"reason":"?"}' },
    ]) {
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
    expect(grade({ evidence: "tests", expect: "label", all: ["test"] }, output("Waiting for user input"))).toContain(
      "generic or unsupported input-status label",
    );
  });
  test("phase steps can require the decision, and keep is scored as the phase it kept", () => {
    const step = { evidence: "more tests", expect: "label" as const, all: ["test"], action: ["keep" as const] };
    expect(grade(step, output("Running tests", "keep"))).toEqual([]);
    expect(grade(step, output("Running sidebar tests", "new"))).toEqual(["expected keep, got new"]);
  });
  test("scorecard includes failures in denominators", () => {
    const base = {
      model: "fixture",
      provider: "codex",
      id: "case",
      scenario: "case",
      category: "abstention",
      repeat: 1,
      expected: { evidence: "make", expect: "abstain" },
      observation: output(null),
      failures: [],
    } as Result;
    expect(scorecard([base, { ...base, observation: null, failures: ["missing result"] }])).toContain(
      "| fixture | 1/2 | 1/2 |",
    );
  });
  test("task ownership and completion rubrics use context labels rather than generated IDs", () => {
    const task = { id: "goal", label: null };
    const observation: Observation = {
      ...output("Running tests"),
      task,
      completed: [],
      raw: JSON.stringify({ action: "new", label: "Running tests", task, completed: [] }),
      input: {
        phase: null,
        work: {
          revision: 1,
          supplied: false,
          current_task: "goal",
          tasks: [{ id: "goal", label: "Repair parser", phase: "", source: "inferred", status: null, present: true }],
        },
      },
    };
    const step = {
      evidence: "Parser tests",
      expect: "label" as const,
      all: ["test"],
      goal: { kind: "existing" as const, all: ["parser"] },
      completed: [],
    };
    expect(grade(step, observation)).toEqual([]);
    expect(grade({ ...step, goal: { kind: "new" } }, observation)).toContain("expected new goal, got existing");
    const completed = {
      ...observation,
      completed: ["goal"],
      raw: JSON.stringify({ action: "new", label: "Running tests", task, completed: ["goal"] }),
    };
    expect(grade(step, completed)).toContain("unexpected completed goals");
    expect(grade({ ...step, completed: ["parser"] }, completed)).toEqual([]);
    expect(grade(step, { ...observation, raw: '{"action":"new","label":"Running tests"}' })).toEqual([
      "invalid response schema",
    ]);
  });
});
