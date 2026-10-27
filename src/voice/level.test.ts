import { test, expect } from "bun:test";
import * as level from "./level";

test("the threshold scale round-trips RMS", () => {
  for (const pct of [0, 10, 44, 73, 100]) expect(level.rmsToPercent(level.percentToRms(pct))).toBeCloseTo(pct, 6);
  expect(level.percentToRms(level.default_threshold)).toBeCloseTo(0.015, 3);
  expect(level.percentToRms(0)).toBeCloseTo(0.001, 6);
  expect(level.percentToRms(100)).toBeCloseTo(0.5, 6);
});

test("levels and steps stay within 0..100", () => {
  expect(level.rmsToPercent(0)).toBe(0);
  expect(level.rmsToPercent(0.0001)).toBe(0);
  expect(level.rmsToPercent(1)).toBe(100);
  expect(level.step(44, 1)).toBe(46);
  expect(level.step(44, -1)).toBe(42);
  expect(level.step(99, 1)).toBe(100);
  expect(level.step(1, -1)).toBe(0);
});

test("rms reads a frame against full scale", () => {
  expect(level.rms(new Int16Array(320))).toBe(0);
  expect(level.rms(new Int16Array(320).fill(16384))).toBeCloseTo(0.5, 6);
  expect(level.rms(new Int16Array(0))).toBe(0);
});
