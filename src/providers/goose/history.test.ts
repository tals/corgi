import { test, expect } from "bun:test";
import { sessionsFromJson } from "./history";
const row = {
  id: "20251025_1",
  working_dir: "/tmp/work",
  name: "auto title",
  user_set_name: "",
  updated_at: "2026-10-25T00:00:00Z",
  last_message_snippet: "hello",
};
test("Goose session lists parse as arrays or session objects", () => {
  const fromArray = sessionsFromJson(JSON.stringify([row]));
  expect(fromArray).toHaveLength(1);
  expect(fromArray[0].session).toBe("20251025_1");
  expect(fromArray[0].cwd).toBe("/tmp/work");
  expect(fromArray[0].title).toBe("auto title");
  expect(fromArray[0].last).toBe("hello");
  expect(fromArray[0].updated_at).toBe(Date.UTC(2026, 9, 25) / 1000);
  const fromObject = sessionsFromJson(JSON.stringify({ sessions: [row] }));
  expect(fromObject).toHaveLength(1);
});
test("Goose session lists prefer the user-set name and trim long fractions", () => {
  const named = sessionsFromJson(JSON.stringify([{ ...row, user_set_name: "my name" }]));
  expect(named[0].title).toBe("my name");
  const fraction = sessionsFromJson(JSON.stringify([{ ...row, updated_at: "2026-10-25T00:00:00.123456Z" }]));
  expect(fraction[0].updated_at).toBe(Date.UTC(2026, 9, 25) / 1000);
});
test("Goose session lists drop rows without ids and bad JSON", () => {
  expect(sessionsFromJson(JSON.stringify([{ ...row, id: "" }]))).toHaveLength(0);
  expect(sessionsFromJson("not json")).toHaveLength(0);
  expect(sessionsFromJson(JSON.stringify({}))).toHaveLength(0);
});
