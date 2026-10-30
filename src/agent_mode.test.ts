import { test, expect } from "bun:test";
import * as agent_mode from "./agent_mode";

test("agent mode needs a known agent writing to a pipe", () => {
  expect(agent_mode.enabled(null, { CLAUDECODE: "1" }, false)).toBe(true);
  expect(agent_mode.enabled(null, { CLAUDECODE: "1" }, true)).toBe(false);
  expect(agent_mode.enabled(null, {}, false)).toBe(false);
  expect(agent_mode.enabled(null, { CLAUDECODE: "" }, false)).toBe(false);
});
test("flags win over CORGI_AGENT_MODE, which wins over detection", () => {
  expect(agent_mode.enabled(false, { CLAUDECODE: "1", CORGI_AGENT_MODE: "1" }, false)).toBe(false);
  expect(agent_mode.enabled(true, {}, true)).toBe(true);
  expect(agent_mode.enabled(null, { CORGI_AGENT_MODE: "1" }, true)).toBe(true);
  expect(agent_mode.enabled(null, { CODEX_SANDBOX: "seatbelt", CORGI_AGENT_MODE: "0" }, false)).toBe(false);
});
test("the agent comes from its variable or, for AI_AGENT and AGENT, the value", () => {
  expect(agent_mode.agent({ CODEX_THREAD_ID: "t" })).toBe("codex");
  expect(agent_mode.agent({ AGENT: "amp" })).toBe("amp");
  expect(agent_mode.agent({ CLAUDECODE: "1", AGENT: "amp" })).toBe("claude-code");
  expect(agent_mode.agent({})).toBeNull();
});
test("agent flags are taken out before --, the last one winning", () => {
  expect(agent_mode.flags(["--agent", "list", "--no-agent"])).toEqual({ flag: false, args: ["list"] });
  expect(agent_mode.flags(["pane", "send", "3", "--", "--agent"])).toEqual({
    flag: null,
    args: ["pane", "send", "3", "--", "--agent"],
  });
});
