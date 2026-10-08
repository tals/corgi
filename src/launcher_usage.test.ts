// Mirrors the tests in launcher_usage.zig (the account-cache case covers
// what the viewer draws: cached and fresh readings render the same).
import { expect, test } from "bun:test";
import { Cell, Grid } from "./launcher_usage";
import { Terminal } from "./pane/terminal";
import { Writer, displayWidth } from "./text";

test("usage groups keep each limit in its slot and show its reset", () => {
  const cell = Cell.init([null, { minutes: 10080, used: 48, reset_at: 273700 }], 100);
  expect(cell.windows[0]).toBeNull();
  expect(cell.windows[1]!.label).toBe("7d");
  expect(cell.windows[1]!.reset).toBe("3d 4h");
  const zero = Cell.init(
    [
      { minutes: 300, used: 0, reset_at: 8200 },
      { minutes: 10080, used: 100, reset_at: 273700 },
    ],
    100,
  );
  expect(zero.windows[0]!.used).toBe(0);
  expect(zero.windows[0]!.reset).toBe("2h 15m");
  const other = Cell.init([{ minutes: 1440, used: 12, reset_at: null }, null], 100);
  expect(other.windows[0]!.label).toBe("1d");
  expect(other.windows[0]!.reset).toBe("unknown");
  expect(other.windows[1]).toBeNull();
});

test("cached readings have no extra indicator and statuses remain readable", () => {
  const fresh = Cell.init(
    [
      { minutes: 300, used: 12, reset_at: null },
      { minutes: 10080, used: 48, reset_at: null },
    ],
    1100,
  );
  const cached = Cell.init(
    [
      { minutes: 300, used: 12, reset_at: null },
      { minutes: 10080, used: 48, reset_at: null },
    ],
    1100,
  );
  const grid = new Grid();
  grid.add(fresh);
  expect(grid.holds(cached)).toBe(true);
  for (const width of [25, grid.minimumWidth(), grid.preferredWidth()]) {
    const a = new Writer();
    const b = new Writer();
    cached.write(a, grid, width, "\x1b[0m", false);
    fresh.write(b, grid, width, "\x1b[0m", false);
    expect(a.s).toBe(b.s);
    expect(a.s).not.toContain("cached");
  }
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
  ];
  const grid = new Grid();
  for (const cell of cells) grid.add(cell);
  // No bars, short bars and full bars.
  for (const width of [grid.minimumWidth(), grid.minimumWidth() + 8, grid.preferredWidth()]) {
    const host = new Terminal(80, 4);
    const w = new Writer();
    cells.forEach((cell, i) => {
      w.write(`\x1b[${i + 1};1H`);
      cell.write(w, grid, width, "\x1b[0m", false);
    });
    host.feed(w.s);
    const [weekly, both, short] = host.text().split("\n");
    host.destroy();
    expect(columnOf(both, "·", 0)).toBe(columnOf(short, "·", 0));
    expect(columnOf(both, "·", 1)).toBe(columnOf(weekly, "·", 0));
    expect(columnOf(both, "│", 0)).toBe(columnOf(weekly, "│", 0));
    expect(columnOf(both, "│", 0)).toBe(columnOf(short, "│", 0));
    expect(columnOf(both, "7d", 0)).toBe(columnOf(weekly, "7d", 0));
    for (const line of [weekly, both, short]) expect(displayWidth(line.trimEnd())).toBeLessThanOrEqual(width);
  }
});
