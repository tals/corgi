import { expect, test } from "bun:test";
import { Stats } from "./connection_stats";
import { Menu } from "./connectivity_menu";
import { Endpoint } from "./machine_connection";
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
  const endpoint = new Endpoint(null, "/tmp/unused-connectivity.sock", new Probe(), new Host());
  const menu = new Menu([endpoint], "");
  menu.toggle(0);
  expect(menu.draw(80, 30)).toContain("Fault injection is available only for sandbox machines.");
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
