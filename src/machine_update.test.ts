import * as test from "bun:test";
import * as update from "./machine_update";

test.test("helper progress is sanitized and malformed events are rejected", () => {
  test.expect(update.event({ type: "progress", message: "Uploading\x1b…" })).toEqual({
    type: "progress",
    message: "Uploading …",
  });
  test
    .expect(
      update.event({
        type: "progress",
        message: "Uploading",
        compact: "↑",
        metrics: "50% 64 KiB/s",
        detail: "Compressed\ndelta",
      }),
    )
    .toEqual({
      type: "progress",
      message: "Uploading",
      compact: "↑",
      metrics: "50% 64 KiB/s",
      detail: "Compressed delta",
    });
  test.expect(update.event({ type: "error", message: "Compiler failed\n" })).toEqual({
    type: "error",
    message: "Compiler failed ",
  });
  for (const value of [
    null,
    {},
    { type: "unknown" },
    { type: "progress", message: 3 },
    { type: "progress", message: "Uploading", metrics: 42 },
    { type: "progress", message: "x".repeat(5000) },
  ])
    test.expect(() => update.event(value)).toThrow("InvalidMachineUpdateEvent");
});
