import { test, expect } from "bun:test";
import { Codex } from "./codex";
test("rollout lines decode their envelope and payload kind", () => {
  const rollout = Codex.Rollout.decode({
    type: "event_msg",
    timestamp: "t",
    payload: { type: "token_count" },
  });
  expect(rollout.type).toBe("event_msg");
  expect(rollout.timestamp).toBe("t");
  expect(rollout.payloadType()).toBe("token_count");
  const other = Codex.Rollout.decode({ type: "compacted", payload: "summary" });
  expect(other.type).toBeNull();
  expect(other.payloadType()).toBeNull();
});
test("plans read as Codex's /status names them", () => {
  for (const [code, label] of [
    ["free", "Free"],
    ["plus", "Plus"],
    ["prolite", "Pro 100"],
    ["pro", "Pro 200"],
    ["promax", "Pro 500"],
    ["team", "Business"],
    ["business", "Enterprise"],
    ["enterprise", "Enterprise"],
    ["edu_plus", "Edu Plus"],
    ["unknown", "Unknown"],
    ["", ""],
  ])
    expect(Codex.plan(code).text()).toBe(label);
});
