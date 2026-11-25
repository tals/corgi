import { describe, expect, test } from "bun:test";
import * as video from "./ghostty_video";

describe("keep", () => {
  test("keeps every frame a script ran and cuts the time between to hold, leading into the next", () => {
    const kept = video.keep(
      0,
      99,
      [
        [0, 9],
        [90, 99],
      ],
      10,
      3,
    );
    expect(kept).toEqual([...Array(10).keys(), ...[10, 11, 12, 13, 14, 15, 16], 87, 88, 89, ...range(90, 100)]);
  });

  test("keeps a short pause between scripts whole", () => {
    expect(
      video.keep(
        0,
        19,
        [
          [0, 9],
          [15, 19],
        ],
        10,
        3,
      ),
    ).toEqual(range(0, 20));
  });

  test("ends on hold frames after the last script", () => {
    expect(video.keep(0, 49, [[0, 4]], 10, 3)).toEqual(range(0, 15));
  });
});

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

test("a glide eases in and out over 0.35 to 0.8 seconds by distance", () => {
  const near = video.glide([0, 0], [10, 0]),
    far = video.glide([0, 0], [900, 0]);
  expect(near.at(-1)).toEqual([355, 10, 0]);
  expect(far.at(-1)).toEqual([800, 900, 0]);
  const steps = far.map(([, x], i) => x - (far[i - 1]?.[1] ?? 0));
  expect(steps[0]).toBeLessThan(steps[25]);
  expect(steps.at(-1)!).toBeLessThan(steps[25]);
});

test("cursor names map to the shapes drawn", () => {
  expect(["default", "pointer", "text", "ew-resize", "row-resize", "move", "wait", null].map(video.shapeOf)).toEqual([
    "arrow",
    "hand",
    "text",
    "ew",
    "ns",
    "move",
    "arrow",
    "arrow",
  ]);
});

describe("the pointer over time", () => {
  const moves: video.PointerEvent[] = [
    { t: 1000, x: 0, y: 0, action: "move" },
    { t: 1016, x: 16, y: 0, action: "move" },
    { t: 2000, x: 16, y: 0, action: "press" },
  ];

  test("is partway between two steps of a glide, and still between moves", () => {
    expect(video.positionAt(moves, 999)).toBeNull();
    expect(video.positionAt(moves, 1008)).toEqual([8, 0]);
    expect(video.positionAt(moves, 1500)).toEqual([16, 0]);
  });

  test("takes the shape X last reported", () => {
    const shapes = [
      { t: 1000, name: "default" },
      { t: 1500, name: "pointer" },
    ];
    expect([999, 1200, 1600].map(t => video.shapeAt(shapes, t))).toEqual(["arrow", "arrow", "hand"]);
  });
});

test("a pointer is a black body in a white outline", () => {
  const size = 64,
    rgba = new Uint8Array(size * size * 4);
  video.drawPointer(rgba, size, "arrow", 10, 10, 36);
  const pixel = (x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  // Inside the arrow, below and right of its tip: black.
  expect(pixel(13, 22)).toEqual([0, 0, 0, 255]);
  // Just left of its left edge: the white outline.
  const edge = pixel(9, 22);
  expect(edge[0]).toBeGreaterThan(200);
  expect(edge[3]).toBeGreaterThan(200);
  expect(pixel(60, 2)[3]).toBe(0);
});

describe("pointerTiles", () => {
  const frame = 1000 / video.FPS;
  const glideRight: video.PointerEvent[] = Array.from({ length: 30 }, (_, i) => ({
    t: 1000 + i * 16,
    x: 20 + i * 10,
    y: 20,
    action: "move",
  }));
  const take = (pointer: video.PointerEvent[]): video.Take => ({
    from: 0,
    to: 5000,
    scripts: [],
    pointer,
    shapes: [],
    keys: [],
    steps: [],
  });
  const times = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * frame);
  const opaque = (tile: Uint8Array) => tile.reduce((n, v, i) => n + (i % 4 === 3 && v > 128 ? 1 : 0), 0);

  test("shows nothing before the pointer first moves", () => {
    const pointer = video.pointerTiles(take(glideRight), times(900, 3), 1, 20);
    expect([0, 1, 2].every(i => opaque(pointer.frame(i)) === 0)).toBe(true);
  });

  test("grows while it moves and settles back at rest", () => {
    const pointer = video.pointerTiles(take(glideRight), times(1000, 90), 1, 20);
    const [moving, resting] = [opaque(pointer.frame(25)), opaque(pointer.frame(89))];
    expect(moving).toBeGreaterThan(resting * 1.3);
    expect(opaque(pointer.frame(0))).toBeLessThan(moving);
  });

  test("leaves a ring where a button went down, and places each tile over the pointer", () => {
    const pressed: video.PointerEvent[] = [{ t: 1000, x: 40, y: 40, action: "press" }];
    const { frame, x, y, size } = video.pointerTiles(take(pressed), times(1000, 40), 1, 20);
    expect(opaque(frame(10))).toBeGreaterThan(opaque(frame(39)));
    expect([x[0], y[0]]).toEqual([40 - size / 2, 40 - size / 2]);
  });
});

test("perFrame says each frame's value by its time, in a balanced tree", () => {
  const edge = (frame: number) => ((frame - 0.5) / video.FPS).toFixed(5);
  expect(video.perFrame([-5, -5, 7, 0, 0, 9])).toBe(
    `if(lt(t,${edge(3)}),if(lt(t,${edge(2)}),-5,7),if(lt(t,${edge(5)}),0,9))`,
  );
  expect(video.perFrame([0, 0])).toBe("0");
  expect(video.perFrame([])).toBe("0");
  // Each if() adds two levels; 1000 runs nest about 20 deep, where a flat sum would nest 1000.
  let [depth, deepest] = [0, 0];
  for (const c of video.perFrame(Array.from({ length: 1000 }, (_, i) => i))) {
    depth += c === "(" ? 1 : c === ")" ? -1 : 0;
    deepest = Math.max(deepest, depth);
  }
  expect(deepest).toBeLessThan(25);
});
