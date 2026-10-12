import { test, expect } from "bun:test";
import { Hooks, planLabel, timestampMs } from "./common";
test("plan codes read as labels", () => {
  for (const [code, label] of [
    ["edu_plus", "Edu Plus"],
    ["Max 5x", "Max 5x"],
    ["API", "API"],
    ["", ""],
  ])
    expect(planLabel(code).text()).toBe(label);
});
test("RFC 3339 UTC timestamps become Unix milliseconds", () => {
  expect(timestampMs("1970-01-01T00:00:00.000Z")).toBe(0);
  expect(timestampMs("2026-09-24T10:00:00.123Z")).toBe(1790244000123);
  expect(timestampMs("2026-09-24T10:00:00+02:00")).toBeNull();
});
test("idle notifications do not mark a finished agent as needing input", () => {
  const hooks = new Hooks();
  expect(
    hooks.decode({
      hook_event_name: "Notification",
      session_id: "a",
      notification_type: "idle_prompt",
    }),
  ).toBeNull();
  expect(
    hooks.decode({
      hook_event_name: "Notification",
      session_id: "a",
      notification_type: "permission_prompt",
    })?.kind,
  ).toBe("notification");
});
test("hooks carry the session's current model", () => {
  expect(
    new Hooks().decode({
      hook_event_name: "UserPromptSubmit",
      session_id: "a",
      model: "gpt-6-astra",
    })?.model,
  ).toBe("gpt-6-astra");
});
test("only completed structured edits carry file-write evidence", () => {
  const hooks = new Hooks(),
    event = {
      hook_event_name: "PostToolUse",
      tool_name: "Edit",
      cwd: "/repo",
      tool_input: { file_path: ".worktrees/search/file" },
    };
  expect(hooks.decode(event)?.writes).toEqual(["/repo/.worktrees/search/file"]);
  for (const changed of [
    { hook_event_name: "PreToolUse" },
    { hook_event_name: "PostToolUseFailure" },
    { tool_name: "Read" },
    { tool_response: { is_error: true } },
    { cwd: "" },
  ])
    expect(hooks.decode({ ...event, ...changed })?.writes).toEqual([]);
});
test("Claude's worktree tools report where they moved the session", () => {
  const hooks = new Hooks(),
    enter = {
      hook_event_name: "PostToolUse",
      tool_name: "EnterWorktree",
      cwd: "/repo/.claude/worktrees/review",
      tool_input: { name: "review" },
      tool_response: { worktreePath: "/repo/.claude/worktrees/review", worktreeBranch: "worktree-review" },
    },
    exit = {
      hook_event_name: "PostToolUse",
      tool_name: "ExitWorktree",
      cwd: "/repo",
      tool_input: { action: "keep" },
      tool_response: { action: "keep", worktreePath: "/repo/.claude/worktrees/review", restoredCwd: "/repo" },
    };
  expect(hooks.decode(enter)?.location).toBe("/repo/.claude/worktrees/review");
  expect(hooks.decode(exit)?.location).toBe("/repo");
  for (const changed of [
    { hook_event_name: "PreToolUse" },
    { hook_event_name: "PostToolUseFailure" },
    { tool_name: "Bash" },
    { tool_response: { worktreePath: "review" } },
  ])
    expect(hooks.decode({ ...enter, ...changed })?.location).toBe("");
});
