import { expect, test } from "bun:test";
import { Stats } from "./connection_stats";
import { Menu } from "./connectivity_menu";
import { Endpoint, localEndpoint } from "./machine_connection";
import { Host } from "./host";
import { Probe } from "./terminal_info";

test("connectivity history expires by time and never invents replies for a silent interval", () => {
  const stats = new Stats();
  stats.answer(20, false, 1000);
  stats.answer(40, false, 1000);
  stats.answer(10000, true, 2000);
  stats.traffic("received", 4096, 2000);
  expect(stats.recent(2000)[0]).toMatchObject({ count: 2, sum: 60, squares: 2000, max: 40 });
  expect(stats.recent(2000)[1]).toMatchObject({ count: 0, failed: 1, received: 4096 });
  expect(stats.lastReceived).toBe(2000);
  expect(stats.recent(123000)).toHaveLength(1);
  expect(stats.recent(123000)[0].count).toBe(0);
});

test("connectivity popover fits short terminals and does not offer production faults", () => {
  const endpoint = localEndpoint("/tmp/unused-connectivity.sock", new Probe(), new Host());
  const menu = new Menu([endpoint], "");
  menu.toggle(0);
  expect(menu.draw(100, 38)).not.toContain("network policy");
  for (const width of [1, 10, 40]) expect(() => menu.draw(width, 8)).not.toThrow();
  menu.key("\x1b", 27);
  expect(menu.open).toBe(false);
});

test("high latency expands health budgets without treating failures as successful latency samples", () => {
  const stats = new Stats();
  expect(stats.stallMs).toBe(4000);
  stats.answer(20000, false, 0, false);
  expect(stats.stallMs).toBe(4000);
  for (let i = 0; i < 30; i++) stats.answer(2000 + (i % 2) * 500, false, i * 1000);
  expect(stats.stallMs).toBeGreaterThan(6000);
  const budget = stats.stallMs;
  stats.answer(90000, true, 31000);
  expect(stats.stallMs).toBe(budget);
  expect(stats.timeoutMs).toBeGreaterThan(stats.stallMs);
  for (let i = 0; i < 100; i++) stats.answer(20, false, 32000 + i * 1000);
  expect(stats.stallMs).toBe(4000);
});

test("replies delayed by a detected outage do not make the next outage slower to detect", () => {
  const stats = new Stats();
  for (let i = 0; i < 20; i++) stats.answer(160, false, 1000 + i * 200);
  const before = stats.stallMs;
  stats.stalled(9000);
  stats.answer(4500, false, 9500);
  expect(stats.stallMs).toBe(before);
  expect(stats.recent(9500).at(-1)?.max).toBe(4500);
  stats.answer(2000, false, 12000);
  expect(stats.stallMs).toBeGreaterThan(before);
});

test("reception bars reflect sustained response time and jitter", () => {
  expect(new Stats().quality).toBeNull();
  for (const [latency, bars] of [
    [50, 4],
    [200, 3],
    [700, 2],
    [2000, 1],
  ] as const) {
    const stats = new Stats();
    for (let i = 0; i < 30; i++) stats.answer(latency, false);
    expect(stats.quality).toBe(bars);
  }
  const variable = new Stats();
  for (let i = 0; i < 30; i++) variable.answer(i % 2 ? 500 : 20, false);
  expect(variable.quality).toBeLessThan(3);
});

test("fast replies cannot hide recent outages and one outage is not counted per pending request", () => {
  const stats = new Stats();
  for (let i = 0; i < 30; i++) stats.answer(20, false, 1000);
  expect(stats.qualityAt(1000)).toBe(4);
  stats.stalled(2000);
  for (let i = 0; i < 20; i++) stats.answer(1000, true, 2000);
  expect(stats.qualityAt(2000)).toBe(2);
  stats.answer(20, false, 2500);
  expect(stats.qualityAt(2500)).toBe(2);
  expect(stats.qualityAt(32000)).toBe(2);
  stats.answer(20, false, 41999);
  expect(stats.qualityAt(41999)).toBe(2);
  stats.answer(20, false, 42000);
  expect(stats.qualityAt(42000)).toBe(4);
  for (const now of [43000, 45000, 47000]) stats.answer(20, true, now);
  expect(stats.qualityAt(47000)).toBe(1);
});

test("reception notices delivery falling behind even while ordinary replies stay fast", () => {
  const stats = new Stats();
  for (let i = 0; i < 30; i++) stats.answer(20, false, 1000);
  expect(stats.qualityAt(1000)).toBe(4);
  stats.progress(2200, 4000);
  expect(stats.qualityAt(2000)).toBe(4);
  expect(stats.qualityAt(4999)).toBe(4);
  expect(stats.qualityAt(5000)).toBe(2);
  stats.progress(100, 4000);
  expect(stats.qualityAt(6000)).toBe(2);
  expect(stats.qualityAt(16000)).toBe(4);
});

test("latency heatmap preserves mixed response times and keeps failures separate", () => {
  const stats = new Stats();
  for (const ms of [20, 100, 101, 500, 501, 2000, 2001, 10000, 10001, 30000]) stats.answer(ms, false, 1000);
  stats.answer(60000, true, 1000);
  expect(stats.recent(1000)[0].latency).toEqual([2, 2, 2, 2, 2]);
  expect(stats.recent(1000)[0].failed).toBe(1);
  expect(stats.recent(1000)[0].count).toBe(10);
});

test("prediction budgets cover slow input and surface round trips and stay bounded", () => {
  const stats = new Stats();
  expect(stats.predictionMs).toBe(750);
  for (let i = 0; i < 30; i++) stats.answer(2000, false);
  expect(stats.predictionMs).toBeGreaterThan(6000);
  const budget = stats.predictionMs;
  stats.answer(90000, true);
  expect(stats.predictionMs).toBe(budget);
  for (let i = 0; i < 30; i++) stats.answer(60000, false);
  expect(stats.predictionMs).toBe(30000);
});
