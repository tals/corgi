import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { State, cells as cells_count, update } from "./limits";
import { Info, Text, Window } from "./account";
import type { Reading } from "./spend";
test("a new reset starts a new spark while drift within a slot does not", () => {
  const state = new State(),
    week = new Window({ minutes: 10080, used: 30, reset_at: 10080 * 60 });
  state.record([null, week], 60);
  const drift = new Window({
    ...week,
    reset_at: week.reset_at! + 90,
    used: 31,
  });
  const same = state.record([null, drift], 2 * 86400);
  expect(same[1][0]).toBe(30);
  expect(same[1][4]).toBe(31);
  const next = new Window({
    ...week,
    reset_at: week.reset_at! + 10080 * 60,
    used: 2,
  });
  const fresh = state.record([null, next], week.reset_at! + 60);
  expect(fresh[1][0]).toBe(2);
  expect(fresh[1][4]).toBeNull();
});
test("windows follow their length across provider slots and unknown resets have no spark", () => {
  const state = new State(),
    week = new Window({ minutes: 10080, used: 84, reset_at: 10080 * 60 });
  state.record([week, null], 60);
  expect(state.record([null, week], 120)[1][0]).toBe(84);
  expect(state.record([new Window({ minutes: 300, used: 5 }), null], 60)[0][0]).toBeNull();
});
const day = 86400,
  noon = (d: number) => d * day + day / 2,
  reading = (start: number, used: number): Reading => ({
    used_minor: used,
    limit_minor: 1000000,
    currency: "USD",
    exponent: 2,
    period_start: start * day,
    reset_at: (start + 31) * day,
  });
test("spend cells hold the month's spend at each pair's last reading, and leave the rest unknown", () => {
  const state = new State();
  state.recordSpend(reading(100, 300), noon(103));
  state.recordSpend(reading(100, 450), noon(104));
  state.recordSpend(reading(100, 500), noon(104) + 3600);
  state.recordSpend(reading(100, 560), noon(105));
  state.recordSpend(reading(100, 800), noon(107));
  state.recordSpend(reading(100, 870), noon(108));
  const cells = state.spendCells(reading(100, 870), noon(108));
  expect(cells).toHaveLength(cells_count);
  // The current pair is days 108 and 109, which hasn't come.
  expect(cells[13]).toEqual({ minor: 870, earlier: false });
  // Day 106 went unread; day 107 still ends its pair.
  expect(cells[12]).toEqual({ minor: 800, earlier: false });
  // Day 105's reading ends its pair, whatever day 104 read.
  expect(cells[11]).toEqual({ minor: 560, earlier: false });
  expect(cells[10]).toEqual({ minor: 300, earlier: false });
  // Pairs before the first reading are unknown.
  expect(cells[9]).toEqual({ minor: null, earlier: false });
  expect(cells[8]).toEqual({ minor: null, earlier: true });
});
test("last month's cells are marked and keep its running spend", () => {
  const state = new State();
  state.recordSpend(reading(70, 1000), noon(97));
  state.recordSpend(reading(70, 1100), noon(98));
  state.recordSpend(reading(70, 1150), noon(99));
  state.recordSpend(reading(100, 40), noon(100));
  state.recordSpend(reading(100, 70), noon(101));
  const cells = state.spendCells(reading(100, 70), noon(101));
  expect(cells[13]).toEqual({ minor: 70, earlier: false });
  expect(cells[12]).toEqual({ minor: 1150, earlier: true });
  expect(cells[11]).toEqual({ minor: 1000, earlier: true });
  // Each day keeps one reading, for about a month.
  for (let d = 102; d < 140; d++) state.recordSpend(reading(100, 70 + d), noon(d));
  expect(state.spend.length).toBeLessThanOrEqual(32);
  expect(state.spend.at(-1)).toEqual([139, 100 * day, 209]);
});
test("histories move from an email's file to the login's, eleven cells to fourteen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "corgi-limits-")),
    prior = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = dir;
  try {
    const folder = join(dir, "corgi", "limit-history"),
      file = (key: string) => join(folder, `claude-${createHash("sha256").update(key).digest("hex")}.json`);
    mkdirSync(folder, { recursive: true });
    const week = { minutes: 10080, reset_at: 10080 * 60, spark: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
    writeFileSync(file("me@work.dev"), JSON.stringify({ tracks: [week, { minutes: 0, reset_at: 0, spark: [] }] }));
    const info = new Info();
    info.account = new Text("me@work.dev");
    info.usage_fetched_at = 60;
    info.limits = { windows: [null, new Window({ minutes: 10080, used: 12, reset_at: 10080 * 60 })] };
    const { sparks } = await update("claude", "login:user/org", info);
    expect(sparks[1]).toEqual([12, 1, 2, 3, null, 4, 5, 6, 7, null, 8, 9, 10, 11]);
    expect(existsSync(file("login:user/org"))).toBe(true);
  } finally {
    if (prior === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = prior;
    rmSync(dir, { recursive: true, force: true });
  }
});
