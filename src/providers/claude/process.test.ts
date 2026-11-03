import { test, expect } from "bun:test";
import { claudeProcess, unnest } from "./process";
test("a retitled Claude process is still Claude", () => {
  const info = { exe: "/usr/bin/node", argv: ["claude bg-spare"] };
  expect(claudeProcess(info)).toBe(true);
  info.argv[0] = "node";
  expect(claudeProcess(info)).toBe(false);
  info.exe = "/opt/claude/bin/claude";
  expect(claudeProcess(info)).toBe(true);
});
test("unnesting clears a parent session's markers and keeps the user's settings", () => {
  const env: Record<string, string | undefined> = {
    CLAUDECODE: "1",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "fa991c77-c824-4504-b005-c15e94fa202c",
    CLAUDE_CODE_SESSION_KIND: "bg",
    CLAUDE_CODE_SESSION_ATTENDED: "1",
    CLAUDE_CODE_MESSAGING_SOCKET: "/tmp/cc-socks/1.sock",
    CLAUDE_CODE_MESSAGING_TOKEN: "token",
    CLAUDE_CODE_EXECPATH: "/opt/claude",
    CLAUDE_PID: "53013",
    CLAUDE_EFFORT: "xhigh",
    AI_AGENT: "claude-code_2-1-316_agent",
    CLAUDE_CONFIG_DIR: "/home/me/.claude",
    CLAUDE_CODE_USE_VERTEX: "1",
  };
  unnest(env);
  expect(env).toEqual({ CLAUDE_CONFIG_DIR: "/home/me/.claude", CLAUDE_CODE_USE_VERTEX: "1" });
});
