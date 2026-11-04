import { expect, test } from "bun:test";
import { conversations as omp } from "../omp/search";
import { conversations as pi } from "./search";

const command = `FOO="a b" bun test src/example.test.ts`;
const searches = { pi, omp };
const decoded = (provider: "pi" | "omp", ...records: object[]) =>
  searches[provider].jsonl(records.map(r => JSON.stringify(r) + "\n").join(""), true);
const message = (message: object) => ({ type: "message", message });

test.each(["pi", "omp"] as const)("decodes %s message calls and results", provider => {
  const { tools } = decoded(
    provider,
    message({
      role: "assistant",
      timestamp: 123,
      content: [
        { type: "thinking", thinking: "private" },
        { type: "toolCall", name: "bash", arguments: { command } },
      ],
    }),
    message({
      role: "toolResult",
      content: [
        { type: "text", text: "ok" },
        { type: "image", data: "hidden" },
      ],
    }),
  );
  expect(tools![0]).toMatchObject({ role: "tool", text: `bash\ncommand: ${command}`, timestamp: 123, ref: "1" });
  expect(tools![1].text).toBe("ok");
});

test.each(["pi", "omp"] as const)(
  "%s records use structured result status and code, not numbers in their text",
  provider => {
    const { tools } = decoded(
      provider,
      message({
        role: "assistant",
        content: [{ type: "toolCall", id: "t", name: "bash", arguments: { command: "false" } }],
      }),
      message({
        role: "toolResult",
        toolCallId: "t",
        toolName: "bash",
        isError: true,
        details: { exitCode: 7 },
        content: [{ type: "text", text: "example exit_code: 0" }],
      }),
    );
    expect(tools![0].tool).toMatchObject({ status: "error", exit_code: 7 });
  },
);

test("omp's custom execution starts are calls with readable string arguments; Pi has none", () => {
  const start = {
    type: "custom",
    customType: "tool_execution_start",
    data: { toolName: "bash", args: JSON.stringify({ command }), startedAt: "2026-01-02T00:00:00Z" },
  };
  expect(decoded("omp", start).tools).toMatchObject([
    { role: "tool", text: `bash\ncommand: ${command}`, timestamp: Date.UTC(2026, 0, 2), ref: "1" },
  ]);
  expect(decoded("pi", start).tools).toEqual([]);
});
