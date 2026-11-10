import { expect, test } from "bun:test";
import { unreachable } from "./machine_viewer";

test("a machine is unreachable down, paused or failing to come back, not while behind or reloading", () => {
  const at = (status: string, failing = false) => unreachable({ status, failing } as Parameters<typeof unreachable>[0]);
  for (const status of ["offline", "paused", "attention", "incompatible"]) expect(at(status)).toBe(true);
  for (const status of ["online", "stalled", "connecting"]) expect(at(status)).toBe(false);
  expect(at("connecting", true)).toBe(true);
});
