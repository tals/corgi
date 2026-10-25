import { test, expect } from "bun:test";
import { sequence, reading, validate, cadence, validateCadence } from "./viewer_progress";

test("stream progress ignores status rows and follows the latest visible fixture sequence", () => {
  expect(
    sequence("Working (esc to interrupt)\nWorking (esc to interrupt) 41 ...\nWorking (esc to interrupt) 42 ..."),
  ).toBe(42);
  expect(sequence("Working (20s • esc to interrupt)\n› ")).toBeNull();
  expect(sequence("Working (esc to interrupt) 999999999999999999999")).toBeNull();
});
test("stream receipts reject frozen, throttled or lagging presentation", () => {
  const current = reading(100, 500, 503, 20);
  expect(current).toMatchObject({ visible_delta: 400, visible_lines_per_second: 20, source_minus_visible: 3 });
  expect(() => validate(current)).not.toThrow();
  for (const progress of [
    reading(100, 100, 500, 20),
    reading(100, 120, 120, 20),
    reading(100, 500, 511, 20),
    reading(null, 500, 500, 20),
    reading(100, 500, null, 20),
    reading(100, 500, 499, 20),
  ])
    expect(() => validate(progress)).toThrow();
});

test("cadence traces distinguish steady presentation from equal-throughput batching", () => {
  const trace = (sequence: (ms: number) => number) =>
    Array.from({ length: 121 }, (_, i) => ({ at_ms: i * 25, sequence: sequence(i * 25) }));
  const steady = cadence(trace(ms => Math.floor(ms / 50)));
  expect(steady).toMatchObject({ seconds: 3, visible_changes_per_second: 20, max_observed_gap_ms: 50 });
  expect(() => validateCadence(steady)).not.toThrow();
  // Equal endpoint throughput can conceal half-second batches.
  expect(() => validate(reading(0, 60, 60, 3))).not.toThrow();
  const batched = cadence(trace(ms => Math.floor(ms / 500) * 10));
  expect(batched).toMatchObject({ visible_changes_per_second: 2, max_observed_gap_ms: 500 });
  expect(() => validateCadence(batched)).toThrow();
  const paused = cadence(trace(ms => (ms >= 1000 && ms < 1300 ? 20 : Math.floor(ms / 50))));
  expect(paused.visible_changes_per_second).toBeGreaterThan(12);
  expect(paused.max_observed_gap_ms).toBe(300);
  expect(() => validateCadence(paused)).toThrow();
  const stalledTail = cadence(trace(ms => Math.floor(Math.min(ms, 2700) / 50)));
  expect(stalledTail.max_observed_gap_ms).toBe(300);
  expect(() => validateCadence(stalledTail)).toThrow();
});
