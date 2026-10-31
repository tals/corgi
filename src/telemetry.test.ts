import { expect, test } from "bun:test";
import { Recorder } from "./telemetry";

test("telemetry aggregates nested spans independently and bounds its timeline", () => {
  const recorder = new Recorder(2);
  recorder.record("native.encode", 10, 12, 100);
  recorder.record("native.encode", 14, 17, 200);
  recorder.record("surface.capture", 9, 20);
  const snapshot = recorder.snapshot();
  expect(snapshot.metrics.find(m => m.name === "native.encode")).toEqual({
    name: "native.encode",
    calls: 2,
    wall_ms: 5,
    max_ms: 3,
    bytes: 300,
  });
  expect(snapshot.traceEvents.map(e => [e.name, e.dur])).toEqual([
    ["native.encode", 3000],
    ["surface.capture", 11000],
  ]);
  expect(snapshot.dropped_events).toBe(1);
});

test("aggregate-only telemetry stores no timeline", () => {
  const recorder = new Recorder();
  recorder.record("viewer.compose", 1, 3);
  expect(recorder.snapshot().traceEvents).toEqual([]);
  expect(recorder.snapshot().metrics.find(m => m.name === "viewer.compose")?.wall_ms).toBe(2);
});
