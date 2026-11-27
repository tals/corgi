import { test, expect } from "bun:test";
import { Reader } from "./todos";
const call = (name: string, input: unknown, id = "call") => ({
  type: "assistant",
  sessionId: "a",
  timestamp: "2026-10-30T12:00:00Z",
  message: { content: [{ type: "tool_use", id, name, input }] },
});
const result = (content = "Updated", is_error = false, id = "call") => ({
  type: "user",
  sessionId: "a",
  timestamp: "2026-10-30T12:00:01Z",
  message: { content: [{ type: "tool_result", tool_use_id: id, content, is_error }] },
});
test("Claude TODO writes require successful results, retain empty clears and reject another session", () => {
  const reader = new Reader();
  expect(reader.record(call("TodoWrite", { todos: [{ content: "Verify", status: "in_progress" }] }), "a")).toBeNull();
  expect(reader.record(result(), "b")).toBeNull();
  expect(reader.record(result(), "a")?.items).toEqual([{ text: "Verify", status: "active", group: "" }]);
  reader.record(call("TodoWrite", { todos: [] }), "a");
  expect(reader.record(result("denied", true), "a")).toBeNull();
  reader.record(call("TodoWrite", { todos: [] }), "a");
  expect(reader.record(result(), "a")?.items).toEqual([]);
});
test("Claude per-task edits fold by task identity and missing history stays partial", () => {
  const reader = new Reader();
  reader.record(call("TaskCreate", { subject: "Ship fix" }), "a");
  expect(reader.record(result("Task #1 created successfully: Ship fix"), "a")?.items[0].status).toBe("pending");
  reader.record(call("TaskUpdate", { taskId: "1", status: "completed" }), "a");
  expect(reader.record(result(), "a")?.items[0].status).toBe("done");
  reader.record(call("TaskUpdate", { taskId: "missing", subject: "Verify fix", status: "in_progress" }), "a");
  expect(reader.record(result(), "a")?.partial).toBe(true);
  reader.record(call("TaskCreate", { subject: "Review" }), "a");
  expect(reader.record(result("Task #2 created successfully: Review"), "a")?.partial).toBe(true);
});
