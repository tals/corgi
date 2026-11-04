import { expect, test } from "bun:test";
import { render, type Options } from "./conversation_grep_output";
import { conversations as codex } from "./providers/codex/search";

const display: Options = {
  workspace: "/work",
  json: false,
  list: false,
  count: false,
  onlyMatching: false,
  maxLineChars: 240,
  maxOutputChars: 12000,
  fullLines: false,
};

test("Codex exit metadata follows the call ID to the matching command and survives normalization", () => {
  const normalized = codex.jsonl(
    [
      {
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "c",
          arguments: JSON.stringify({ cmd: "gh pr create --fill" }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "c",
          output: "Chunk ID: x\nWall time: 0.1 seconds\nProcess exited with code 1\nFinal output:\nnot logged in",
        },
      },
    ]
      .map(r => JSON.stringify(r) + "\n")
      .join(""),
    true,
  );
  expect(normalized.tools?.[0].tool).toMatchObject({
    kind: "call",
    name: "exec_command",
    call_id: "c",
    status: "error",
    exit_code: 1,
    call_ref: "1",
    result_ref: "2",
  });
  const tool = normalized.tools![0].tool!;
  const matches = [
    {
      source: { provider: "codex", session: "s", cwd: "/work", updated_at: 0 },
      hits: [
        {
          line: 1,
          seq: 2,
          text: "cmd: gh pr create --fill",
          context: false,
          role: "tool",
          timestamp: null,
          ref: "1",
          message_line: 2,
          submatches: [{ start: 5, end: 17 }],
          lane: "tools" as const,
          tool,
        },
      ],
    },
  ];
  expect(render(matches, display).text).toContain("T1.2:tool:[call exec_command exit=1] cmd: gh pr create --fill");
  const hit = JSON.parse(render(matches, { ...display, json: true }).text).hits[0];
  expect(hit.tool).toMatchObject({ exit_code: 1, status: "error", result_ref: "2" });
});
