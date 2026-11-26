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

describe("timeline", () => {
  // 10 fps held 0.3 s at each end, over frames kept at 1000, 1100 … 1400 ms.
  const screen: video.Screen = {
    socket: "",
    width: 80,
    height: 40,
    cols: 8,
    rows: 2,
    cell: [10, 20],
    padding: [0, 0],
    wait: 5,
    idle: 0.3,
    fps: 10,
  };
  const times = [1000, 1000, 1000, 1000, 1100, 1200, 1300, 1400, 1400, 1400, 1400];

  test("puts a moment on the kept frame showing it, between the holds", () => {
    const take: video.Take = {
      from: 1000,
      to: 1400,
      scripts: [[1000, 1400]],
      pointer: [],
      shapes: [],
      steps: [],
      opens: [],
      keys: [1000, 1250, 1400].map(t => ({ t, kind: "key", value: "esc" })),
    };
    const { events } = video.timeline(take, times, 10, screen, "demo.mp4");
    expect(events.map(e => e.t)).toEqual([0.3, 0.5, 0.7]);
  });

  test("starts with where the pointer rested as the take began", () => {
    const take: video.Take = {
      from: 1000,
      to: 1400,
      scripts: [[1000, 1400]],
      pointer: [
        { t: 900, x: 40, y: 20, action: "move" },
        { t: 1200, x: 50, y: 20, action: "move" },
      ],
      shapes: [],
      steps: [],
      opens: [],
      keys: [],
    };
    const { events } = video.timeline(take, times, 10, screen, "demo.mp4");
    expect(events).toEqual([
      { t: 0.3, type: "move", x: 40, y: 20 },
      { t: 0.5, type: "move", x: 50, y: 20 },
    ]);
  });
});

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

test("a speed command takes a speed of at least 1 and top or bottom, or reset", () => {
  expect([["4"], ["x2.5"], ["1"], ["016", "top"], ["8", "bottom"], ["reset"]].map(video.paceOf)).toEqual([
    { speed: 4, place: "bottom" },
    { speed: 2.5, place: "bottom" },
    { speed: 1, place: "bottom" },
    { speed: 16, place: "top" },
    { speed: 8, place: "bottom" },
    { speed: 1, place: "bottom" },
  ]);
  const wrong = [
    [],
    ["0.5"],
    ["0"],
    ["x"],
    ["4."],
    [".5"],
    ["1e3"],
    ["-2"],
    ["fast"],
    ["4", "left"],
    ["4", "top", "x"],
  ];
  expect([...wrong, ["reset", "top"]].map(video.paceOf)).toEqual(Array(wrong.length + 1).fill(null));
});

test("the pace at a time is the last speed command at or before it", () => {
  const paces: video.PaceEvent[] = [
    { t: 10, speed: 4, place: "top" },
    { t: 20, speed: 1, place: "bottom" },
  ];
  expect([5, 10, 15, 20, 30].map(t => video.paceAt(paces, t).speed)).toEqual([1, 4, 4, 1, 1]);
  expect(video.paceAt(paces, 12).place).toBe("top");
});

describe("picks", () => {
  test("shows every kept frame at speed 1", () => {
    expect(video.picks(Array(5).fill(1))).toEqual(range(0, 5));
  });

  test("shows every speed-th kept frame, and the last", () => {
    expect(video.picks(Array(10).fill(4))).toEqual([0, 4, 8, 9]);
    expect(video.picks(Array(9).fill(4))).toEqual([0, 4, 8]);
    expect(video.picks([4])).toEqual([0]);
  });

  test("steps 2 and 3 frames apart at speed 2.5", () => {
    expect(video.picks(Array(11).fill(2.5))).toEqual([0, 3, 5, 8, 10]);
    expect(video.picks(Array(1000).fill(2.5))).toHaveLength(400 + 1);
  });

  test("counts each run of a speed from its own first frame", () => {
    const speeds = [1, 1, 4, 4, 4, 4, 4, 1, 1, 2, 2, 2, 1];
    expect(video.picks(speeds)).toEqual([0, 1, 2, 6, 7, 8, 9, 11, 12]);
  });
});

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

test("the arrow is black in a white outline", () => {
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

test("the hand is white in a black outline", () => {
  const size = 64,
    rgba = new Uint8Array(size * size * 4);
  video.drawPointer(rgba, size, "hand", 20, 10, 36);
  const pixel = (x: number, y: number) => [...rgba.subarray((y * size + x) * 4, (y * size + x) * 4 + 4)];
  // Down the pointing finger: white.
  expect(pixel(20, 20)).toEqual([255, 255, 255, 255]);
  // Just left of the finger: the black outline.
  const edge = pixel(15, 20);
  expect(edge[0]).toBeLessThan(60);
  expect(edge[3]).toBeGreaterThan(200);
});

test("a video's frames keep the times they were grabbed at, sped up or not", () => {
  const paces: video.PaceEvent[] = [
    { t: 20, speed: 2, place: "top" },
    { t: 60, speed: 1, place: "bottom" },
  ];
  const times = range(0, 8).map(i => i * 10);
  const frames = video.shownFrames(times, paces, 2);
  expect(frames.map(frame => frame.t)).toEqual([0, 0, 0, 10, 20, 40, 60, 70, 70, 70]);
  expect(frames.map(frame => frame.speed)).toEqual([1, 1, 1, 1, 2, 2, 1, 1, 1, 1]);
  expect(frames[4].place).toBe("top");
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
    opens: [],
    steps: [],
    paces: [],
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

  // Frames four apart: a speed-up of 4, or cuts at real time.
  const strided = (from: number, count: number) => Array.from({ length: count }, (_, i) => from + i * 4 * frame);

  test("grows while it moves in a speed-up, whose frames are a stride apart", () => {
    const fast = video.pointerTiles(take(glideRight), strided(1000, 30), 1, 20, video.FPS, Array(30).fill(4));
    expect(opaque(fast.frame(6))).toBeGreaterThan(opaque(fast.frame(29)) * 1.3);
    const cut = video.pointerTiles(take(glideRight), strided(1000, 30), 1, 20);
    expect(opaque(cut.frame(6))).toBe(opaque(cut.frame(29)));
  });

  test("plays a press's ring at the video's pace", () => {
    const pressed: video.PointerEvent[] = [{ t: 1000, x: 40, y: 40, action: "press" }];
    const [fast, real] = [4, 1].map(speed =>
      video.pointerTiles(take(pressed), strided(1000, 40), 1, 20, video.FPS, Array(40).fill(speed)),
    );
    const rest = opaque(real.frame(39));
    expect(opaque(fast.frame(10))).toBeGreaterThan(rest);
    expect(opaque(real.frame(10))).toBe(rest);
  });
});

test("elapsed says wall-clock time as +m:ss, or +h:mm:ss from an hour", () => {
  expect([0, 999, 1000, 61_500, 600_000, 3_600_000, 3_723_000].map(video.elapsed)).toEqual([
    "+0:00",
    "+0:00",
    "+0:01",
    "+1:01",
    "+10:00",
    "+1:00:00",
    "+1:02:03",
  ]);
});

test("typeset gives every digit one width", () => {
  const width = (text: string) => video.typeset(text, 0, 0, 20, 3).width;
  expect(width("+1:11")).toBe(width("+0:00"));
  expect(width("×1")).toBe(width("×4"));
  expect(width("×4")).toBeLessThan(width("×2.5"));
});

describe("badgeTiles", () => {
  const frame = 1000 / video.FPS;
  const size: [number, number] = [1200, 800];
  /** Frames at real time but for those from..to, at speed. */
  const take = (count: number, from: number, to: number, speed: number, place: video.Place = "bottom") => {
    const speeds = range(0, count).map(i => (i >= from && i <= to ? speed : 1));
    let t = 0;
    const times = speeds.map(s => (t += s * frame));
    return video.badgeTiles(times, speeds, Array(count).fill(place), 28, size);
  };
  const alpha = (tile: Uint8Array) => tile.reduce((n, v, i) => n + (i % 4 === 3 ? v : 0), 0);
  /** The middle row of the pill's opaque body. */
  const middle = (tile: Uint8Array, width: number) => {
    const rows = range(0, tile.length / 4 / width).filter(y => tile[(y * width + Math.floor(width / 2)) * 4 + 3] > 200);
    return rows[Math.floor(rows.length / 2)];
  };

  test("shows nothing at real time", () => {
    const badge = take(200, 60, 140, 4);
    expect([0, 59, 140 + 30, 199].map(i => alpha(badge.frame(i)))).toEqual([0, 0, 0, 0]);
  });

  test("rises in from below over its intro and sinks away after a reset", () => {
    const badge = take(200, 60, 140, 4);
    const settled = alpha(badge.frame(120));
    expect(alpha(badge.frame(60))).toBeLessThan(settled / 4);
    expect(middle(badge.frame(64), badge.width)).toBeGreaterThan(middle(badge.frame(120), badge.width));
    expect(middle(badge.frame(100), badge.width)).toBe(middle(badge.frame(120), badge.width));
    expect(alpha(badge.frame(100)) / settled).toBeCloseTo(1, 2);
    expect(alpha(badge.frame(145))).toBeLessThan(settled);
    expect(middle(badge.frame(150), badge.width)).toBeGreaterThan(middle(badge.frame(120), badge.width));
  });

  test("comes down from above at the top", () => {
    const [low, high] = (["bottom", "top"] as const).map(place => take(200, 60, 140, 4, place));
    expect(middle(high.frame(64), high.width)).toBeLessThan(middle(high.frame(120), high.width));
    expect(high.y[100]).toBeLessThan(size[1] / 2);
    expect(low.y[100]).toBeGreaterThan(size[1] / 2);
    expect(low.x).toBe(Math.round((size[0] - low.width) / 2));
  });

  test("redraws only when its clock or motion changes", () => {
    const badge = take(400, 10, 390, 2);
    // At 2x, the clock ticks every 30 frames once the intro is over.
    expect(badge.frame(101)).toBe(badge.frame(100));
    expect(badge.frame(200)).not.toBe(badge.frame(100));
  });
});

test("stack pipes layers as one, each under the last", () => {
  const solid = (width: number, height: number, value: number): video.Layer => {
    const rgba = new Uint8Array(width * height * 4).fill(value);
    return { width, height, count: 2, frame: () => rgba };
  };
  const both = video.stack([solid(2, 2, 1), solid(3, 1, 2)]);
  expect([both.width, both.height, both.tops]).toEqual([3, 3, [0, 2]]);
  const rows = [...both.frame(0)].filter((_, i) => i % 4 === 0);
  expect(rows).toEqual([1, 1, 0, 1, 1, 0, 2, 2, 2]);
  expect(both.frame(1)).toBe(both.frame(0));
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
