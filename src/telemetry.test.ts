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

test("trace metadata is bounded and cannot leak into later events", () => {
  const recorder = new Recorder(2);
  recorder.record("remote.stream.window", 10, 10, 0, { pane: 7, pending: 3, height: 2 });
  recorder.record("remote.stream.window", 20, 20, 0, { pane: 7, pending: 1, height: 3 });
  recorder.record("viewer.compose", 30, 32);
  expect(recorder.snapshot().traceEvents.map(e => e.args)).toEqual([{ pane: 7, pending: 1, height: 3 }, undefined]);
});

test("trace filtering retains recovery events without changing aggregate timings", () => {
  const recorder = new Recorder(2, name => name.startsWith("remote."));
  recorder.record("remote.stream.window", 1, 1, 0, { machine: "atlas", window: 2 });
  for (let i = 0; i < 100; i++) recorder.record("viewer.compose", i, i + 2);
  recorder.record("remote.stream.window", 10, 30, 0, { machine: "atlas", window: 1 });
  const snapshot = recorder.snapshot();
  expect(snapshot.traceEvents.map(event => event.name)).toEqual(["remote.stream.window", "remote.stream.window"]);
  expect(snapshot.dropped_events).toBe(0);
  expect(snapshot.metrics.find(metric => metric.name === "viewer.compose")).toMatchObject({ calls: 100, wall_ms: 200 });
});
