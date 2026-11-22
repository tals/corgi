import { expect, test } from "bun:test";
import { cells, pixels, place } from "./signal_bars";
import * as hostImages from "./host_images";
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

test("signal images are sent once, placed repeatedly, and sent again for a new cell size", () => {
  const store = new hostImages.Store(),
    cell = { width: 10, height: 20 },
    frame = store.frame(cell);
  place(frame, 4, 10, 2, cell);
  expect(frame.commands()).toMatch(/a=p,i=\d+,p=1,/);
  place(frame, 4, 10, 8, cell);
  expect(frame.commands()).toMatch(/a=p,i=\d+,p=2,/);
  expect(store.present().send).toContain("a=t,t=d,f=32,s=20,v=20");
  place(store.frame(cell), 4, 10, 2, cell);
  expect(store.present().send).toBe("");
  const bigger = { width: 12, height: 24 };
  place(store.frame(bigger), 4, 10, 2, bigger);
  expect(store.present()).toMatchObject({
    send: expect.stringContaining("s=24,v=24"),
    free: expect.stringContaining("a=d,d=I"),
  });
  expect(store.close()).toContain("a=d,d=I");
});

test("signal pixels clip around overlays and restore without uploading again", () => {
  const store = new hostImages.Store(),
    cell = { width: 8, height: 16 },
    host = Terminal.create(40, 15);
  try {
    let sent = 0;
    const draw = (covered: Rect[]) => {
      const frame = store.frame(cell);
      place(frame, 4, 2, 3, cell);
      for (const box of covered) frame.cover(box);
      const p = store.present();
      if (p.send) sent++;
      host.feed(p.send + p.draw + p.free);
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
    expect(sent).toBe(1);
  } finally {
    host.destroy();
  }
});
