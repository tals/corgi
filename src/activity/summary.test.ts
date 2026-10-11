import { test, expect } from "bun:test";
import { codex, parseLabel, Text } from "./summary";
import * as prompt from "./prompt";
test("bounded commentary evidence and strict labels", () => {
  const evidence = codex({
    items: [
      { type: "userMessage", content: [{ type: "text", text: "Fix tabs" }] },
      { type: "agentMessage", text: "Tracing focus changes" },
    ],
  });
  expect(evidence.text().startsWith("Latest agent update: Tracing focus changes")).toBe(true);
  expect(evidence.text()).toContain("User request: Fix tabs");
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
  expect(prompt.parse('{"action":"none","label":null}', null).label).toBeNull();
  expect(prompt.parse('{"action":"new","label":"null"}', null).label).toBeNull();
  expect(prompt.parse('{"action":"new","label":"Tracing focus changes"}', null).label?.text()).toBe(
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
    expect(() => prompt.parse(output, null)).toThrow();
});
test("decisions are read against the current phase", () => {
  const parse = (action: string, label: string | null, phase: string | null) => {
    const decision = prompt.parse(JSON.stringify({ action, label }), phase);
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
  const input = { provider: "codex" as const, turn: "turn", phase: null, earlier: [], evidence: "build" };
  expect(JSON.parse(prompt.content(input))).not.toHaveProperty("history");
  expect(JSON.parse(prompt.content({ ...input, history: [] })).history).toEqual([]);
});
