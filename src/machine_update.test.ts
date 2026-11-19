import { expect, test } from "bun:test";
import * as update from "./machine_update";

test("control/data connections share preparation and reconnects reuse it", async () => {
  const gate = Promise.withResolvers<string>();
  let starts = 0,
    aborted = false,
    changes = 0;
  const preparation = new update.Preparation(
    async (signal, progress) => {
      starts++;
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      progress("Building for linux-arm64…");
      return gate.promise;
    },
    () => {
      changes++;
    },
  );
  const control = new AbortController(),
    data = new AbortController();
  const a = preparation.run(control.signal),
    b = preparation.run(data.signal);
  await Bun.sleep(0);
  expect(starts).toBe(1);
  expect(preparation.message).toBe("Building for linux-arm64…");
  expect(changes).toBeGreaterThan(0);
  data.abort(Error("Cancelled"));
  await expect(b).rejects.toThrow("Cancelled");
  expect(aborted).toBe(false);
  gate.resolve("installed");
  expect(await a).toBe("installed");
  expect(await preparation.run(new AbortController().signal)).toBe("installed");
  expect(starts).toBe(1);
  expect(preparation.message).toBe("");
});

test("pause cancels the last waiter, and retry waits for cleanup before starting again", async () => {
  const cleanup = Promise.withResolvers<void>();
  let starts = 0,
    stopped = false;
  const preparation = new update.Preparation(async signal => {
    if (++starts > 1) return "retried";
    await new Promise<void>(resolve =>
      signal.addEventListener(
        "abort",
        () => {
          stopped = true;
          resolve();
        },
        { once: true },
      ),
    );
    await cleanup.promise;
    signal.throwIfAborted();
    return "unreachable";
  });
  const first = new AbortController();
  const a = preparation.run(first.signal);
  await Bun.sleep(0);
  first.abort(Error("Paused"));
  await expect(a).rejects.toThrow("Paused");
  expect(stopped).toBe(true);
  const retry = preparation.run(new AbortController().signal);
  await Bun.sleep(0);
  expect(starts).toBe(1);
  cleanup.resolve();
  expect(await retry).toBe("retried");
  expect(starts).toBe(2);
});

test("failed preparation is retryable and malformed helper progress is rejected", async () => {
  let count = 0;
  const preparation = new update.Preparation(async () => {
    if (!count++) throw Error("Offline");
    return true;
  });
  await expect(preparation.run(new AbortController().signal)).rejects.toThrow("Offline");
  expect(await preparation.run(new AbortController().signal)).toBe(true);
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
