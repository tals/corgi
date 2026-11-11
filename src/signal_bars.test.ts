import { expect, test } from "bun:test";
import { Images, pixels } from "./signal_bars";
import { Rect } from "./layout";
import { Terminal } from "./pane/terminal";
import * as palette from "./palette";

test("signal pixels keep one-pixel gaps at every cell width and use palette colors", () => {
  for (const width of [8, 10, 16]) {
    const cell = { width, height: 20 },
      data = pixels(2, cell);
    const pixel = (x: number, y: number) => [...data.slice((y * width * 4 + x) * 4, (y * width * 4 + x) * 4 + 4)];
    for (let bar = 0; bar < 4; bar++) {
      for (let y = 0; y < cell.height; y++)
        expect(pixel((bar + 1) * width - 1, y)).toEqual([...palette.colors.surface, 0]);
      expect(pixel(bar * width, 19)).toEqual([...(bar < 2 ? palette.colors.warm : palette.colors.line), 255]);
      if (bar < 3) expect(pixel(bar * width, 19 - (bar + 1) * 5)).toEqual([...palette.colors.surface, 0]);
    }
  }
});

test("signal images are cached, placed repeatedly, and regenerated for a new cell size", () => {
  const images = new Images(),
    cell = { width: 10, height: 20 };
  expect(images.ready(4, cell)).toBe(false);
  expect(images.end()).toContain("a=t,t=d,f=32,s=40,v=20");
  expect(images.ready(4, cell)).toBe(true);
  expect(images.place(4, 10, 2, cell)).toContain("a=p,i=730404,p=1");
  expect(images.place(4, 10, 8, cell)).toContain("a=p,i=730404,p=2");
  expect(images.end()).toBe("");
  expect(images.begin()).toContain("a=d,d=i");
  expect(images.ready(4, { width: 12, height: 24 })).toBe(false);
  expect(images.end()).toContain("s=48,v=24");
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
    expect(draw([])).toEqual([[2, 3, 0, 32]]);
    expect(draw([new Rect(3, 2, 2, 4)])).toEqual([
      [2, 3, 0, 8],
      [5, 3, 24, 8],
    ]);
    expect(draw([new Rect(0, 0, 20, 10)])).toEqual([]);
    expect(draw([])).toEqual([[2, 3, 0, 32]]);
  } finally {
    host.destroy();
  }
});
