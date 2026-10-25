import { test, expect } from "bun:test";
import { adapter } from "./index";
test("Goose owns its own binary and nothing else", () => {
  expect(adapter.owns("/home/u/.local/bin/goose")).toBe(true);
  expect(adapter.owns("/home/u/.local/bin/pi")).toBe(false);
  expect(adapter.owns("/home/u/.local/bin/gooseberry")).toBe(false);
});
test("Goose launches, resumes and forks through the session subcommand", () => {
  expect(adapter.launch.start({ permissions: "default", model: null, args: [] })).toEqual(["session"]);
  expect(adapter.launch.resume("20251025_1")).toEqual(["--resume", "--session-id", "20251025_1"]);
  expect(adapter.launch.fork({ session: "20251025_1", transcript: "", cwd: "/tmp" }, "name")).toMatchObject({
    args: ["--resume", "--fork", "--session-id", "20251025_1", "--name", "name"],
    named: true,
  });
  expect(adapter.launch.fork({ session: "20251025_1", transcript: "", cwd: "/tmp" }, null)).toMatchObject({
    args: ["--resume", "--fork", "--session-id", "20251025_1"],
    named: false,
  });
});
test("Goose hook events decode to corgi kinds", () => {
  const start = adapter.hook({ event: "SessionStart", session: "20251025_1", cwd: "/tmp/work" });
  expect(start?.kind).toBe("session_start");
  expect(start?.session).toBe("20251025_1");
  expect(start?.cwd).toBe("/tmp/work");
  const tool = adapter.hook({
    event: "PreToolUse",
    session: "20251025_1",
    cwd: "/tmp/work",
    tool: "text_editor",
    input: { file_path: "/tmp/work/a.txt" },
  });
  expect(tool?.kind).toBe("tool_start");
  expect(tool?.tool).toBe("text_editor");
  expect(adapter.hook({ event: "PostToolUse", session: "20251025_1" })?.kind).toBe("tool_finish");
  expect(adapter.hook({ event: "PostToolUseFailure", session: "20251025_1" })?.kind).toBe("tool_failure");
  expect(adapter.hook({ event: "Stop", session: "20251025_1" })?.kind).toBe("stop");
  expect(adapter.hook({ event: "SessionEnd", session: "20251025_1" })?.kind).toBe("session_end");
  expect(adapter.hook({ event: "Nope", session: "20251025_1" })).toBe(null);
});
test("Goose prompt hooks carry bounded initial evidence", () => {
  const prompt = adapter.hook({ event: "UserPromptSubmit", session: "s", message: "é".repeat(3000) })!;
  expect(prompt.kind).toBe("prompt");
  expect(Buffer.byteLength(prompt.initial_request)).toBe(2048);
  expect(prompt.initial_request).not.toContain("�");
});
