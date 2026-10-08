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
  expect(prompt.parse('{"label":null}').label).toBeNull();
  expect(prompt.parse('{"label":"null"}').label).toBeNull();
  expect(prompt.parse('{"label":"Tracing focus changes"}').label?.text()).toBe("Tracing focus changes");
  for (const output of ['{"label":5}', "{}", '{"label":null,"reason":"none"}', "[]"])
    expect(() => prompt.parse(output)).toThrow();
});
test("history is sent only when supplied", () => {
  const input = { provider: "codex" as const, turn: "turn", evidence: "build" };
  expect(JSON.parse(prompt.content(input))).not.toHaveProperty("history");
  expect(JSON.parse(prompt.content({ ...input, history: [] })).history).toEqual([]);
});
