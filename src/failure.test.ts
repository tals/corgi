import { test, expect } from "bun:test";
import { Failure } from "./failure";
test("logs a failure once until it changes or recovers", () => {
  const f = new Failure();
  expect(f.changed(Error("FileNotFound"))).toBe(true);
  expect(f.changed(Error("FileNotFound"))).toBe(false);
  expect(f.changed(Error("AccessDenied"))).toBe(true);
  expect(f.changed(Error("AccessDenied"))).toBe(false);
  expect(f.clear()).toBe(true);
  expect(f.clear()).toBe(false);
  expect(f.changed(Error("AccessDenied"))).toBe(true);
});
