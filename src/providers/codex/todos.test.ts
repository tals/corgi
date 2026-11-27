import { test, expect } from "bun:test";
import { Reader } from "./todos";
const call = (plan: unknown) => ({
  type: "response_item",
  timestamp: "2026-10-30T12:00:00Z",
  payload: { type: "function_call", call_id: "a", name: "functions.update_plan", arguments: JSON.stringify({ plan }) },
});
const result = (output: string) => ({
  type: "response_item",
  timestamp: "2026-10-30T12:00:01Z",
  payload: { type: "function_call_output", call_id: "a", output },
});
test("Codex plan updates require confirmation and mark unreadable statuses partial", () => {
  const reader = new Reader();
  reader.record(
    call([
      { step: "Implement", status: "in_progress" },
      { step: "Verify", status: "new_status" },
    ]),
  );
  const list = reader.record(result("Plan updated"))!;
  expect(list.partial).toBe(true);
  expect(list.items).toEqual([{ text: "Implement", status: "active", group: "" }]);
  expect(list.at).toBe(Date.parse("2026-10-30T12:00:01Z") * 1000);
  reader.record(call([]));
  expect(reader.record(result("Permission denied"))).toBeNull();
  reader.record(call([]));
  expect(reader.record(result("Plan updated"))?.items).toEqual([]);
});
