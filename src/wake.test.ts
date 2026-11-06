import { expect, test } from "bun:test";
import { Wake } from "./wake";

test("work arriving before or during sleep wakes the consumer without losing the next event", async () => {
  const wake = new Wake();
  wake.notify();
  wake.notify();
  await wake.wait(10_000);
  let completed = false;
  const first = wake.wait(10_000).then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);
  wake.notify();
  // This arrives after the sleeper resolves, before its continuation runs.
  wake.notify();
  await first;
  await wake.wait(10_000);
  completed = false;
  const next = wake.wait(10_000).then(() => (completed = true));
  await Promise.resolve();
  expect(completed).toBe(false);
  wake.notify();
  await next;
});

test("timed work still runs without any events", async () => {
  const wake = new Wake();
  await wake.wait(0);
  wake.notify();
  await wake.wait(10_000);
});
