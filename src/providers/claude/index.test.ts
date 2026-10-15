import { test, expect } from "bun:test";
import { Claude } from "./index";
test("transcript lines decode their envelope and drop subagent lines", () => {
  const line = Claude.Line.decode({
    type: "assistant",
    sessionId: "s",
    timestamp: "t",
    message: { model: "m" },
  })!;
  expect(line.type).toBe("assistant");
  expect(line.sessionId).toBe("s");
  expect(line.timestamp).toBe("t");
  expect(line.message.model).toBe("m");
  expect(Claude.Line.decode({ type: "file-history-snapshot", isSidechain: false })?.type).toBeNull();
  expect(
    Claude.Line.decode({
      type: "assistant",
      sessionId: "s",
      isSidechain: true,
    }),
  ).toBeNull();
});
test("a subagent's lines belong to the subagent, in the file beside its session's", () => {
  const own = { type: "assistant", sessionId: "s" },
    child = {
      type: "assistant",
      sessionId: "s",
      isSidechain: true,
      agentId: "a1",
    };
  expect(Claude.Line.of(own, "s")).not.toBeNull();
  expect(Claude.Line.of(own, "a1")).toBeNull();
  expect(Claude.Line.of(child, "a1")).not.toBeNull();
  expect(Claude.Line.of(child, "s")).toBeNull();
  expect(Claude.subagentTranscript("/p/s.jsonl", "s", "a1")).toBe("/p/s/subagents/agent-a1.jsonl");
});
test("task notices name their task, and how it ended once it has", () => {
  for (const [text, id, status] of [
    [
      '<task-notification>\n<task-id>bepm4nu57</task-id>\n<tool-use-id>toolu_1</tool-use-id>\n<status>completed</status>\n<summary>Monitor "probe" stream ended</summary>\n<event>done</event>\n</task-notification>',
      "bepm4nu57",
      "completed",
    ],
    [
      '<task-notification>\n<task-id>b8eldxmdy</task-id>\n<status>killed</status>\n<summary>Task "probe" was stopped by the user</summary>\n</task-notification>',
      "b8eldxmdy",
      "killed",
    ],
    [
      '<task-notification>\n<task-id>bu7xsz0ou</task-id>\n<summary>Monitor event: "ci"</summary>\n<event><status>killed</status></event>\n</task-notification>',
      "bu7xsz0ou",
      null,
    ],
  ] as const) {
    const notice = Claude.TaskNotice.decode(text)!;
    expect(notice.id).toBe(id);
    expect(notice.status).toBe(status);
  }
  expect(Claude.TaskNotice.decode("check CI again")).toBeNull();
  expect(Claude.TaskNotice.decode("<task-notification><summary>no id</summary></task-notification>")).toBeNull();
});
test("plans read as Claude's tier refines its kind", () => {
  for (const [kind, tier, label] of [
    ["max", "default_claude_max_5x", "Max 5x"],
    ["claude_max", "default_claude_max_20x", "Max 20x"],
    ["pro", "default_claude_ai", "Pro"],
    ["claude_team", "default_raven", "Team"],
    ["", "default_claude_ai", ""],
  ])
    expect(Claude.plan(kind, tier).text()).toBe(label);
});
