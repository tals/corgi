import { expect, test } from "bun:test";
import { Images, cells, pixels } from "./signal_bars";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import * as palette from "./palette";

test("signal pixels fit four even bars into two cells and use palette colors", () => {
  for (const width of [8, 9, 10, 16, 18]) {
    const cell = { width, height: 20 },
      span = width * cells,
      data = pixels(2, cell);
    const pixel = (x: number, y: number) => [...data.slice((y * span + x) * 4, (y * span + x) * 4 + 4)];
    const blank = (y: number) => Array.from({ length: span }, (_, x) => pixel(x, y)[3]).every(a => a === 0);
    // The same padding above and below.
    const pad = Array.from({ length: 20 }, (_, y) => y).findIndex(y => !blank(y));
    expect(pad).toBeGreaterThan(0);
    for (let y = 0; y < pad; y++) expect(blank(19 - y)).toBe(true);
    expect(blank(19 - pad)).toBe(false);
    // The lowest row crosses every bar.
    const runs: { start: number; end: number; color: number[] }[] = [];
    for (let x = 0; x < span; x++) {
      const [r, g, b, a] = pixel(x, 19 - pad);
      if (!a) continue;
      const last = runs.at(-1);
      if (last?.end === x) last.end++;
      else runs.push({ start: x, end: x + 1, color: [r, g, b] });
    }
    expect(runs.map(run => run.color)).toEqual([
      [...palette.colors.warm],
      [...palette.colors.warm],
      [...palette.colors.line],
      [...palette.colors.line],
    ]);
    const bar = runs[0].end - runs[0].start;
    for (const run of runs) expect(run.end - run.start).toBe(bar);
    expect(bar).toBeGreaterThan(runs[1].start - runs[0].end);
    // Centered, what's left over split between the sides.
    expect(Math.abs(runs[0].start - (span - runs[3].end))).toBeLessThanOrEqual(1);
    // Each is taller than the last, the last reaching the top padding.
    const heights = runs.map(run => Array.from({ length: 20 }, (_, y) => pixel(run.start, y)[3]).filter(a => a).length);
    for (let i = 1; i < 4; i++) expect(heights[i]).toBeGreaterThan(heights[i - 1]);
    expect(heights[3]).toBe(20 - 2 * pad);
  }
});

test("signal images are cached, placed repeatedly, and regenerated for a new cell size", () => {
  const images = new Images(),
    cell = { width: 10, height: 20 };
  expect(images.ready(4, cell)).toBe(false);
  expect(images.end()).toContain("a=t,t=d,f=32,s=20,v=20");
  expect(images.ready(4, cell)).toBe(true);
  expect(images.place(4, 10, 2, cell)).toContain("a=p,i=730404,p=1");
  expect(images.place(4, 10, 8, cell)).toContain("a=p,i=730404,p=2");
  expect(images.end()).toBe("");
  expect(images.begin()).toContain("a=d,d=i");
  expect(images.ready(4, { width: 12, height: 24 })).toBe(false);
  expect(images.end()).toContain("s=24,v=24");
  expect(images.clear()).toContain("a=d,d=I");
});

test("signal pixels clip around overlays and restore without uploading again", () => {
  const images = new Images(),
    cell = { width: 8, height: 16 },
    host = Terminal.create(40, 15);
  try {
    images.ready(4, cell);
    host.feed(images.end());
    const draw = (covered: Rect[]) => {
      host.feed(images.begin() + images.place(4, 2, 3, cell, covered));
      expect(images.end()).toBe("");
      return host
        .surface(1)
        .surface.images!.map(p => [p.x, p.y, p.source_x, p.source_width])
        .sort((a, b) => a[0] - b[0]);
    };
    expect(draw([])).toEqual([[2, 3, 0, 16]]);
    expect(draw([new Rect(3, 2, 2, 4)])).toEqual([[2, 3, 0, 8]]);
    expect(draw([new Rect(0, 2, 3, 4)])).toEqual([[3, 3, 8, 8]]);
    expect(draw([new Rect(0, 0, 20, 10)])).toEqual([]);
    expect(draw([])).toEqual([[2, 3, 0, 16]]);
  } finally {
    host.destroy();
  }
});
