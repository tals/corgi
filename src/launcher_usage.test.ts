import { expect, test } from "bun:test";
import { Cell, Grid } from "./launcher_usage";
import { Terminal } from "./pane/terminal";
import { Writer, displayWidth } from "./text";

test("usage groups put the weekly limit first and show its reset", () => {
  const cell = Cell.init([null, { minutes: 10080, used: 48, reset_at: 273700 }], 100);
  expect(cell.windows[0]!.label).toBe("7d");
  expect(cell.windows[0]!.reset).toBe("3d 4h");
  expect(cell.windows[1]).toBeNull();
  const zero = Cell.init(
    [
      { minutes: 300, used: 0, reset_at: 8200 },
      { minutes: 10080, used: 100, reset_at: 273700 },
    ],
    100,
  );
  expect(zero.windows.map(w => w!.label)).toEqual(["7d", "5h"]);
  expect(zero.windows[1]!.used).toBe(0);
  expect(zero.windows[1]!.reset).toBe("2h 15m");
  const lone = Cell.init([{ minutes: 300, used: 5, reset_at: null }, null], 100);
  expect(lone.windows[0]).toBeNull();
  expect(lone.windows[1]!.label).toBe("5h");
  const other = Cell.init([{ minutes: 1440, used: 12, reset_at: null }, null], 100);
  expect(other.windows[0]!.label).toBe("1d");
  expect(other.windows[0]!.reset).toBe("unknown");
  expect(other.windows[1]).toBeNull();
});

test("status cells show their text instead of limits", () => {
  for (const text of ["Reading…", "Track usage", "Metered", "—"]) {
    const cell = Cell.status(text);
    expect(cell.limited()).toBe(false);
    expect(cell.fallback).toBe(text);
  }
});

test("text-only usage fits both limits without bars and clips within its cell", () => {
  const cell = Cell.init(
    [
      { minutes: 300, used: 0, reset_at: null },
      { minutes: 10080, used: 100, reset_at: null },
    ],
    100,
  );
  const grid = new Grid();
  grid.add(cell);
  let w = new Writer();
  cell.write(w, grid, grid.minimumWidth(), "\x1b[0m", false);
  expect(w.s).not.toContain("━");
  expect(w.s).toContain(" │ ");
  expect(w.s).toContain("100%");
  expect(w.s).not.toContain("(cached)");
  w = new Writer();
  cell.write(w, grid, 25, "\x1b[0m", false);
  expect(displayWidth(w.s)).toBeLessThanOrEqual(25);
  const weekly = Cell.init([{ minutes: 10080, used: 35, reset_at: null }, null], 100);
  grid.add(weekly);
  w = new Writer();
  weekly.write(w, grid, grid.minimumWidth() - 1, "\x1b[0m", false);
  expect(w.s).toContain("35%");
  expect(w.s).not.toContain("│");
});

/** The display column of the `nth` (from zero) `needle` in a rendered line. */
function columnOf(line: string, needle: string, nth: number): number {
  let start = 0;
  for (let i = 0; i < nth; i++) start = line.indexOf(needle, start) + needle.length;
  return displayWidth(line.slice(0, line.indexOf(needle, start)));
}

test("usage rows line up on one grid at every width", () => {
  const now = 100;
  const cells = [
    Cell.init([null, { minutes: 10080, used: 6, reset_at: now + 4 * 86400 + 18 * 3600 }], now),
    Cell.init(
      [
        { minutes: 300, used: 70, reset_at: now + 3 * 60 },
        { minutes: 10080, used: 84, reset_at: now + 10 * 3600 + 43 * 60 },
      ],
      now,
    ),
    Cell.init([{ minutes: 300, used: 100, reset_at: now + 2 * 3600 + 15 * 60 }, null], now),
    Cell.monthly(
      {
        used_minor: 590000,
        limit_minor: 1000000,
        currency: "USD",
        exponent: 2,
        period_start: 0,
        reset_at: now + 86400,
      },
      now,
    ),
  ];
  const grid = new Grid();
  for (const cell of cells) grid.add(cell);
  // No bars, short bars and full bars.
  for (const width of [grid.minimumWidth(), grid.minimumWidth() + 8, grid.preferredWidth()]) {
    const host = new Terminal(100, 5);
    const w = new Writer();
    cells.forEach((cell, i) => {
      w.write(`\x1b[${i + 1};1H`);
      cell.write(w, grid, width, "\x1b[0m", false);
    });
    host.feed(w.s);
    const [weekly, both, short, monthly] = host.text().split("\n");
    host.destroy();
    // Weekly limits and the month lead, resets in one column.
    expect(columnOf(both, "7d", 0)).toBe(columnOf(weekly, "7d", 0));
    expect(columnOf(monthly, "mo", 0)).toBe(columnOf(weekly, "7d", 0));
    expect(columnOf(both, "10h 43m", 0)).toBe(columnOf(weekly, "4d 18h", 0));
    expect(columnOf(monthly, "1d", 0)).toBe(columnOf(weekly, "4d 18h", 0));
    expect(monthly).toContain("59%");
    // 5h limits and the month's amount follow.
    expect(columnOf(both, "5h", 0)).toBe(columnOf(short, "5h", 0));
    expect(columnOf(monthly, "$5.9k / $10k", 0)).toBe(columnOf(both, "5h", 0));
    if (width === grid.preferredWidth()) {
      expect(monthly).toContain("━━━━──");
      expect(columnOf(monthly, "━", 0)).toBe(columnOf(both, "━", 0));
    }
    expect(both).toContain("│");
    for (const line of [weekly, short, monthly]) expect(line).not.toContain("│");
    for (const line of [weekly, both, short, monthly]) expect(displayWidth(line.trimEnd())).toBeLessThanOrEqual(width);
  }
});

test("monthly spend reads like a weekly limit, with its amount where 5h sits", () => {
  const quota = Cell.init(
    [
      { minutes: 300, used: 20, reset_at: 3700 },
      { minutes: 10080, used: 40, reset_at: 86500 },
    ],
    100,
  );
  const grid = new Grid();
  grid.add(quota);
  const width = grid.preferredWidth();
  const monthly = Cell.monthly(
    { used_minor: 59, limit_minor: 1000000, currency: "USD", exponent: 2, period_start: 0, reset_at: 86500 },
    100,
  );
  expect(monthly.windows[0]).toEqual({ label: "mo", used: 0.0059, figure: "<1%", reset: "1d" });
  expect(monthly.amount).toBe("$0.59 / $10k");
  grid.add(monthly);
  expect(grid.preferredWidth()).toBe(width);
  expect(grid.barWidth(width)).toBe(6);
});

test("monthly spend without a cap omits the bar and over-cap readings stay bounded", () => {
  const reading = {
    used_minor: 125000,
    limit_minor: null as number | null,
    currency: "USD",
    exponent: 2,
    period_start: 0,
    reset_at: 86400,
  };
  for (const limit of [null, 0, 100000]) {
    const cell = Cell.monthly({ ...reading, limit_minor: limit }, 100);
    const grid = new Grid();
    grid.add(cell);
    for (const width of [18, grid.minimumWidth(), grid.preferredWidth()]) {
      const w = new Writer();
      cell.write(w, grid, width, "\x1b[0m", false);
      expect(displayWidth(w.s.replace(/\x1b\[[0-9;]*m/g, ""))).toBeLessThanOrEqual(width);
      if (limit === null) expect(w.s).not.toContain("━");
      else if (width === grid.preferredWidth()) expect(w.s).toContain("━━━━━━");
    }
  }
});
