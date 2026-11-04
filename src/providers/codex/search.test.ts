import { expect, test } from "bun:test";
import { conversations } from "./search";

const command = `FOO="a b" bun test src/example.test.ts`;
const decoded = (...records: object[]) =>
  conversations.jsonl(records.map(r => JSON.stringify(r) + "\n").join(""), true);
const item = (payload: object, timestamp?: string) => ({ type: "response_item", timestamp, payload });

test("decodes Codex calls and outputs without JSON-escaped commands", () => {
  const { tools } = decoded(
    item({ type: "function_call", name: "shell", arguments: JSON.stringify({ command }) }, "2026-01-01T00:00:00Z"),
    item({ type: "custom_tool_call", name: "patch", input: "patch text" }),
    item({ type: "function_call_output", output: "done" }),
    item({ type: "custom_tool_call_output", output: "custom done" }),
  );
  expect(tools![0]).toMatchObject({
    role: "tool",
    text: `shell\ncommand: ${command}`,
    timestamp: Date.UTC(2026, 0, 1),
    ref: "1",
  });
  expect(tools!.slice(1).map(t => t.text)).toEqual(["patch\npatch text", "done", "custom done"]);
});

test("injected context is not the user's text", () => {
  const user = (text: string) => item({ type: "message", role: "user", content: [{ type: "input_text", text }] });
  const { messages } = decoded(
    user("# AGENTS.md instructions for /work\nrules"),
    user("<environment_context>cwd</environment_context>"),
    user("<turn_aborted>"),
    user("Fix the tab labels"),
  );
  expect(messages.map(m => m.text)).toEqual(["Fix the tab labels"]);
});

test("text containing an exit code is not a result status; running Codex commands are not success", () => {
  const result = (name: string, output: string) =>
    decoded(
      item({ type: "function_call", call_id: "c", name, arguments: "{}" }),
      item({ type: "function_call_output", call_id: "c", output }),
    ).tools![1].tool;
  expect(result("exec_command", "documentation: Process exited with code 0")).toMatchObject({
    status: null,
    exit_code: null,
  });
  expect(
    result("exec_command", "Chunk ID: x\nWall time: 0.1 seconds\nProcess running with session ID 123\nFinal output:\n"),
  ).toMatchObject({ status: "running", exit_code: null });
  expect(result("exec_command", JSON.stringify({ output: "ok", metadata: { exit_code: 0 } }))).toMatchObject({
    status: "success",
    exit_code: 0,
  });
  // Only shell tools report an outcome in their output.
  expect(result("read_file", '{"exit_code":0}')).toMatchObject({ status: null, exit_code: null });
});

test("a command the user ran themselves is a user-shell call with its exit code", () => {
  const text =
    "<user_shell_command>\n<command>\ngit push\n</command>\n<result>\nExit code: 1\nDuration: 1.7 seconds\nOutput:\nrejected\n\n</result>\n</user_shell_command>";
  const { messages, tools } = decoded(item({ type: "message", role: "user", content: [{ type: "input_text", text }] }));
  expect(messages).toEqual([]);
  expect(tools!.map(t => [t.text, t.tool!.kind, t.tool!.status, t.tool!.exit_code])).toEqual([
    ["user-shell\ncommand: git push", "call", "error", 1],
    ["rejected", "result", "error", 1],
  ]);
});
