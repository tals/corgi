import { test, expect } from "bun:test";
import { parseLabel, Text } from "./summary";
import * as prompt from "./prompt";
import { Timeline, type TaskContext } from "./timeline";
const work = new Timeline().taskContext();
const decision = (action: string, label: unknown, task = { id: null, label: null }, completed: string[] = []) =>
  JSON.stringify({ action, label, task, completed });
test("strict labels and bounded evidence", () => {
  for (const label of [
    "Tracing focus changes",
    "Tracing tool activity code",
    "Inspecting logs and summary behavior",
    "Checking tool calls and background builds",
  ])
    expect(parseLabel(label)).not.toBeNull();
  for (const label of ["Running\ncommands", "This label has far too many words", "\x1b[2J bad"])
    expect(parseLabel(label)).toBeNull();
  expect(new Text("a".repeat(3000)).len).toBe(2048);
});
test("abstention is a valid decision distinct from invalid output", () => {
  expect(prompt.parse(decision("none", null), null, work).label).toBeNull();
  expect(prompt.parse(decision("new", "null"), null, work).label).toBeNull();
  expect(prompt.parse(decision("new", "Tracing focus changes"), null, work).label?.text()).toBe(
    "Tracing focus changes",
  );
  for (const output of [
    '{"label":5}',
    '{"label":"Tracing focus changes"}',
    '{"action":"skip","label":null}',
    '{"action":"new","label":null}',
    '{"action":"none","label":null,"reason":"none"}',
    "{}",
    "[]",
  ])
    expect(() => prompt.parse(output, null, work)).toThrow();
});
test("decisions are read against the current phase", () => {
  const parse = (action: string, label: string | null, phase: string | null) => {
    const decision = prompt.parse(
      JSON.stringify({ action, label, task: { id: null, label: null }, completed: [] }),
      phase,
      work,
    );
    return [decision.action, decision.label?.text() ?? null];
  };
  expect(parse("keep", null, "Running tests")).toEqual(["keep", "Running tests"]);
  expect(parse("keep", null, null)).toEqual(["none", null]);
  expect(parse("amend", "Running unit tests", null)).toEqual(["new", "Running unit tests"]);
  expect(parse("amend", "Running unit tests", "Running tests")).toEqual(["amend", "Running unit tests"]);
  expect(parse("new", "Running tests", "Running tests")).toEqual(["keep", "Running tests"]);
  expect(parse("none", null, "Running tests")).toEqual(["none", null]);
});
test("the conversation keeps the latest turn's phases", () => {
  const context = new prompt.Context(),
    label = (text: string) => new Text(text);
  expect(context.phase("a")).toBeNull();
  context.remember("a", "evidence", label("Reading source"));
  context.remember("a", "evidence", label("Reading source"), "keep");
  context.remember("a", "evidence", label("Running tests"));
  context.remember("a", "evidence", label("Running unit tests"), "amend");
  expect(context.phase("a")).toBe("Running unit tests");
  expect(context.earlier("a")).toEqual(["Reading source"]);
  for (const text of ["Fixing failures", "Reviewing diff", "Committing changes"])
    context.remember("a", "", label(text));
  expect(context.earlier("a")).toEqual(["Running unit tests", "Fixing failures", "Reviewing diff"]);
  expect(context.phase("b")).toBeNull();
  expect(context.earlier("b")).toEqual([]);
  context.remember("b", "evidence", label("Building project"), "keep");
  expect(context.phase("b")).toBe("Building project");
  expect(context.earlier("b")).toEqual([]);
});
test("history is sent only when supplied", () => {
  const input = { provider: "codex" as const, turn: "turn", phase: null, earlier: [], evidence: "build", work };
  expect(JSON.parse(prompt.content(input))).not.toHaveProperty("history");
  expect(JSON.parse(prompt.content({ ...input, history: [] })).history).toEqual([]);
});
test("task decisions require the complete strict schema and known authoritative references", () => {
  const context: TaskContext = {
    revision: 1,
    supplied: true,
    current_task: "plan",
    tasks: [
      { id: "plan", label: "Repair parser", phase: "", status: "in_progress", source: "agent", present: true },
      { id: "goal", label: "Repair logging", phase: "", status: null, source: "inferred", present: true },
    ],
  };
  const parse = (task: unknown, completed: unknown = [], action = "new") =>
    prompt.parse(
      JSON.stringify({ action, label: action === "none" ? null : "Reading parser", task, completed }),
      null,
      context,
    );
  expect(parse({ id: "plan", label: null }).task.id).toBe("plan");
  expect(parse({ id: null, label: null }).task.id).toBeNull();
  for (const task of [
    { id: "missing", label: null },
    { id: "goal", label: null },
    { id: "plan", label: "Renamed plan" },
    { id: null, label: "New goal" },
    { id: null },
    null,
  ])
    expect(() => parse(task)).toThrow("InvalidDecision");
  for (const completed of [["plan"], ["missing"], ["goal", "goal"], "goal"])
    expect(() => parse({ id: null, label: null }, completed)).toThrow("InvalidDecision");
  expect(parse({ id: null, label: null }, ["goal"], "none").completed).toEqual(["goal"]);
  context.supplied = false;
  expect(parse({ id: null, label: "Repair parser" }).task.label).toBe("Repair parser");
  expect(parse({ id: "goal", label: "Repair log rotation" }).task.id).toBe("goal");
  expect(() => parse({ id: null, label: "Repair parser" }, [], "none")).toThrow("InvalidDecision");
  expect(() => prompt.parse('{"action":"none","label":null}', null, context)).toThrow("InvalidDecision");
});
