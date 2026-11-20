import { expect, test } from "bun:test";
import * as update from "./machine_update";

test("helper progress is sanitized and malformed events are rejected", () => {
  expect(update.event({ type: "progress", message: "Uploading\x1b…" })).toEqual({
    type: "progress",
    message: "Uploading …",
  });
  expect(
    update.event({
      type: "progress",
      message: "Uploading",
      compact: "↑",
      metrics: "50% 64 KiB/s",
      detail: "Compressed\ndelta",
    }),
  ).toEqual({
    type: "progress",
    message: "Uploading",
    compact: "↑",
    metrics: "50% 64 KiB/s",
    detail: "Compressed delta",
  });
  for (const value of [
    null,
    {},
    { type: "unknown" },
    { type: "progress", message: 3 },
    { type: "progress", message: "Uploading", metrics: 42 },
    { type: "progress", message: "x".repeat(5000) },
  ])
    expect(() => update.event(value)).toThrow("InvalidMachineUpdateEvent");
});
