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
