import { expect, test } from "bun:test";
import * as update from "./machine_update";

test("helper progress is sanitized and malformed events are rejected", () => {
  expect(update.event({ type: "progress", message: "Uploading\x1b…" })).toEqual({
    type: "progress",
    message: "Uploading …",
  });
  for (const value of [
    null,
    {},
    { type: "unknown" },
    { type: "progress", message: 3 },
    { type: "progress", message: "x".repeat(5000) },
  ])
    expect(() => update.event(value)).toThrow("InvalidMachineUpdateEvent");
});
