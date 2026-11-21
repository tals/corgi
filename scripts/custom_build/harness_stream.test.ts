import { expect, test } from "bun:test";
import { harnessArgs, streamParser } from "./harness_stream";

test("harness args add the stream output flag for the kind", () => {
  expect(harnessArgs(["claude-private", "-p"], "claude")).toEqual([
    "claude-private",
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
  ]);
  expect(harnessArgs(["claude", "-p", "--output-format", "json"], "claude")).toEqual([
    "claude",
    "-p",
    "--output-format",
    "json",
  ]);
  expect(harnessArgs(["codex", "exec", "-"], "codex")).toEqual(["codex", "exec", "--json", "-"]);
  expect(harnessArgs(["codex-wrap", "-"], "codex")).toEqual(["codex-wrap", "-", "--json"]);
  expect(harnessArgs(["codex", "exec", "--json", "-"], "codex")).toEqual(["codex", "exec", "--json", "-"]);
  expect(harnessArgs(["x", "-p"], undefined)).toEqual(["x", "-p"]);
});

test("claude stream gives text, tool activity and summed usage", () => {
  const parser = streamParser("claude");
  const assistant = JSON.stringify({
    type: "assistant",
    message: {
      content: [
        { type: "text", text: "Keeping both import blocks." },
        { type: "tool_use", name: "Edit", input: { file_path: "src/controller.ts" } },
      ],
    },
  });
  const result = JSON.stringify({
    type: "result",
    subtype: "success",
    usage: {
      input_tokens: 1200,
      cache_creation_input_tokens: 300,
      cache_read_input_tokens: 49500,
      output_tokens: 7400,
    },
  });
  const stream = `${assistant}\n${result}\n`;
  const cut = assistant.length / 2;
  const first = parser.feed(stream.slice(0, cut));
  expect(first).toEqual({ text: [], activity: null });
  const second = parser.feed(stream.slice(cut));
  expect(second.text).toContain("Keeping both import blocks.");
  expect(second.text).toContain("→ Edit src/controller.ts");
  expect(second.activity).toBe("Edit src/controller.ts");
  expect(parser.usage()).toEqual({ input: 51000, output: 7400 });
});

test("codex json gives text, commands and usage", () => {
  const parser = streamParser("codex");
  const turn = '{"type":"turn.completed","usage":{"input_tokens":800,"cached_input_tokens":200,"output_tokens":90}}';
  const parsed = parser.feed(
    [
      '{"type":"item.completed","item":{"type":"agent_message","text":"Resolved the conflict."}}',
      '{"type":"item.started","item":{"type":"command_execution","command":"git diff"}}',
      turn,
      "",
    ].join("\n"),
  );
  expect(parsed.text).toContain("Resolved the conflict.");
  expect(parsed.text).toContain("→ git diff");
  expect(parser.usage()).toEqual({ input: 800, output: 90 });
  parser.feed(`${turn}\n`);
  expect(parser.usage()).toEqual({ input: 1600, output: 180 });
});

test("non-JSON lines pass through as text", () => {
  const parser = streamParser("claude");
  expect(parser.feed("Using profile private\n{not json\n").text).toEqual(["Using profile private", "{not json"]);
  expect(parser.usage()).toBeNull();
});

test("codex shows an item once and file changes as edits", () => {
  const parser = streamParser("codex");
  const parsed = parser.feed(
    [
      '{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bun test"}}',
      '{"type":"item.completed","item":{"id":"item_1","type":"command_execution","command":"bun test"}}',
      '{"type":"item.completed","item":{"id":"item_2","type":"file_change","changes":[{"path":"src/a.ts","kind":"update"}]}}',
      '{"type":"thread.started","thread_id":"t"}',
      "",
    ].join("\n"),
  );
  expect(parsed).toEqual({ text: ["→ bun test", "→ edit src/a.ts"], activity: "edit src/a.ts" });
  expect(parser.usage()).toBeNull();
});
