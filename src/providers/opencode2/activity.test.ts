import { expect, test } from "bun:test";
import { progress } from "./activity";
const evidence = (messages: Record<string, unknown>[]) => progress(messages).evidence;

const user = (text: string) => ({ id: "msg_user", type: "user", text });
const assistant = (...content: unknown[]) => ({ type: "assistant", content });
const text = (text: string) => ({ type: "text", text });
const tool = (id: string, name: string, input: unknown, status = "completed") => ({
  type: "tool",
  id,
  name,
  state: { status, input, content: [{ type: "text", text: "PRIVATE TOOL OUTPUT" }] },
});

test("tool-only messages retain commentary and supply running and recent work", () => {
  const messages = [
    user("Fix the activity feed"),
    assistant(text("Tracing how the observer reads activity")),
    assistant(tool("read", "read", { path: "src/providers/opencode2/observer.ts" })),
    assistant(tool("search", "grep", { pattern: "activity", path: "src" })),
    assistant(tool("tests", "shell", { command: "bun test src/providers/opencode2" }, "running")),
    assistant({ type: "reasoning", text: "PRIVATE REASONING" }),
  ];
  const out = evidence(messages).text();
  expect(out).toStartWith("Currently running tools (not yet completed):\nshell: bun test src/providers/opencode2\n");
  expect(out).toContain(
    "Recent completed tools (oldest to newest):\nread: src/providers/opencode2/observer.ts\ngrep: activity src\n",
  );
  expect(out).toContain("Latest agent update: Tracing how the observer reads activity");
  expect(out).toContain("User request: Fix the activity feed");
  expect(out).not.toContain("PRIVATE");
  expect(evidence(messages).text()).toBe(out);
});

test("a follow-up never borrows work or commentary from the preceding turn", () => {
  const out = evidence([
    user("Old task"),
    assistant(text("Old commentary"), tool("old", "shell", { command: "old command" })),
    user("continue"),
    assistant({ type: "reasoning", text: "PRIVATE" }),
  ]).text();
  expect(out).toBe("User request: continue");
  expect(evidence([assistant(text("Unbound commentary"))]).len).toBe(0);
});

test("edits describe files, partial arguments and tool output are excluded", () => {
  const out = evidence([
    user("Fix it"),
    assistant(
      tool("edit", "edit", { path: "src/one.ts", old_string: "PRIVATE", new_string: "PRIVATE" }),
      tool("patch", "patch", { patchText: "*** Begin Patch\n*** Update File: src/two.ts\n+PRIVATE\n*** End Patch" }),
      tool("failed", "shell", { command: "bun typecheck.ts" }, "error"),
      tool("stream", "shell", '{"command":"PARTIAL', "streaming"),
    ),
  ]).text();
  expect(out).toContain("edit: src/one.ts");
  expect(out).toContain("patch: src/two.ts");
  expect(out).toContain("shell: bun typecheck.ts");
  expect(out).not.toContain("Currently running");
  expect(out).not.toContain("PRIVATE");
  expect(out).not.toContain("PARTIAL");
});

test("large commentary cannot crowd out recent tool evidence and is bounded in bytes", () => {
  const out = evidence([
    user("界".repeat(3000)),
    assistant(text("界".repeat(3000))),
    ...Array.from({ length: 20 }, (_, i) => assistant(tool(String(i), "shell", { command: `command-${i}` }))),
  ]).text();
  expect(out).toStartWith("Recent completed tools");
  expect(out).toContain("shell: command-17\nshell: command-18\nshell: command-19\n");
  expect(out).not.toContain("command-16");
  expect(Buffer.byteLength(out)).toBeLessThanOrEqual(2048);
  expect(out).not.toContain("�");
});
