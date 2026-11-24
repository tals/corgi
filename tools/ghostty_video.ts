/**
 * Grabs a capture's Ghostty window from its X display: screenshots once the
 * screen holds still, and lossless recordings encoded with the time between
 * scripts cut and the pointer drawn in where it went, in the shape it had.
 */
import type { FileSink } from "bun";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";

/** Frames a second in a video; the pointer moves at this rate. */
export const FPS = 60;
/** Frames a second grabbed from the window; the encoder repeats them to FPS. */
const GRAB_FPS = 30;

/** Where a capture's window is and how it records. */
export interface Screen {
  display: string;
  x: number;
  y: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** Seconds a grab or a recording's start may take. */
  wait: number;
  /** Seconds a video opens and closes on, and the most it keeps between scripts. */
  idle: number;
}

/** Where the pointer was moved (ms since the epoch; pixels in the window), and whether a button went down there. */
export interface PointerEvent {
  t: number;
  x: number;
  y: number;
  press: boolean;
}

/** When the cursor became the one with this name, as X reports it. */
export interface ShapeEvent {
  t: number;
  name: string | null;
}

/** A stretch of time, in ms since the epoch. */
export type Span = [from: number, to: number];

/** What a recording knows besides its frames. */
export interface Take {
  /** When record start returned and record stop began. */
  from: number;
  to: number;
  /** When scripts ran; the time between them is cut down to idle. */
  scripts: Span[];
  pointer: PointerEvent[];
  shapes: ShapeEvent[];
}

export type Video = "mp4" | "gif";

export function video(path: string): Video | null {
  switch (extname(path).toLowerCase()) {
    case ".mp4":
      return "mp4";
    case ".gif":
      return "gif";
    default:
      return null;
  }
}

/** Throws on timeouts rather than silently capturing an unready screen. */
export async function until<T>(read: () => T | Promise<T>, seconds = 20): Promise<NonNullable<T>> {
  const end = Date.now() + seconds * 1000;
  do {
    const value = await read();
    if (value) return value as NonNullable<T>;
    await Bun.sleep(100);
  } while (Date.now() < end);
  throw Error(`screen did not become ready within ${seconds}s`);
}

/** Frames made on demand, so a long take never holds them all at once. */
interface Frames {
  count: number;
  frame(i: number): Uint8Array;
}

/**
 * Runs ffmpeg without blocking, so a relay keeps passing output through
 * meanwhile; frames go to its stdin, made as they are written.
 */
async function ffmpeg(args: string[], frames: Frames | null = null): Promise<void> {
  const p = Bun.spawn(["ffmpeg", "-hide_banner", "-y", "-loglevel", "error", ...args], {
    stdin: frames ? "pipe" : "ignore",
    stdout: "ignore",
    stderr: "pipe",
  });
  const error = new Response(p.stderr).text();
  if (frames) {
    const sink = p.stdin as FileSink;
    try {
      for (let i = 0; i < frames.count; i++) {
        sink.write(frames.frame(i));
        if (i % 30 === 29) await sink.flush();
      }
      await sink.end();
    } catch {
      // ffmpeg stopped reading; its error says why.
    }
  }
  const code = await p.exited;
  if (code !== 0) throw Error(`ffmpeg: ${(await error).trim() || `exit ${code}`}`);
}

/**
 * ffmpeg's option for a filter graph read from a file: FFmpeg 7 added
 * -/filter_complex, and FFmpeg 9 dropped the older -filter_complex_script.
 */
const graphOption = (() => {
  let option: string | null = null;
  return () => {
    if (option) return option;
    const version = Bun.spawnSync(["ffmpeg", "-hide_banner", "-version"]).stdout.toString();
    const major = Number(/ffmpeg version n?(\d+)\./.exec(version)?.[1] ?? Infinity);
    return (option = major >= 7 ? "-/filter_complex" : "-filter_complex_script");
  };
})();

function input(screen: Screen): string[] {
  return [
    "-f",
    "x11grab",
    "-video_size",
    `${screen.width}x${screen.height}`,
    "-i",
    `:${screen.display}+${screen.x},${screen.y}`,
  ];
}

let grabs = 0;

/** The window's pixels as a PNG once three grabs in a row match; grabs go to their own file in dir. */
export async function settled(screen: Screen, dir: string, alive = () => {}): Promise<Buffer> {
  const frame = join(dir, `frame-${process.pid}-${++grabs}.png`);
  // Wait for layout, hover timers and the renderer before checking stable pixels.
  await Bun.sleep(700);
  let previous: Buffer | null = null,
    same = 0;
  await until(async () => {
    alive();
    await ffmpeg(["-nostdin", "-draw_mouse", "0", ...input(screen), "-frames:v", "1", frame]);
    const pixels = readFileSync(frame);
    same = previous?.equals(pixels) ? same + 1 : 0;
    previous = pixels;
    return same >= 2;
  }, screen.wait).finally(() => rmSync(frame, { force: true }));
  return previous!;
}

/** Starts a lossless recorder, its frames stamped with wall-clock times; returns once frames arrive. */
async function recorder(dir: string, screen: Screen, name: string, cursor: boolean): Promise<Bun.Subprocess> {
  const [log, progress] = [`${name}.log`, `${name}.progress`].map(file => join(dir, file));
  rmSync(progress, { force: true });
  // Not -nostdin: ffmpeg 7.1 ignores SIGINT with it, and stdin is /dev/null anyway.
  const p = Bun.spawn(
    [
      ...["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-use_wallclock_as_timestamps", "1"],
      ...["-draw_mouse", cursor ? "1" : "0", "-framerate", String(GRAB_FPS), ...input(screen)],
      ...["-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0", "-copyts"],
      ...["-progress", progress, "-stats_period", "0.1", join(dir, `${name}.mkv`)],
    ],
    { stdin: "ignore", stdout: "ignore", stderr: Bun.file(log) },
  );
  try {
    await until(() => {
      if (p.exitCode !== null) throw Error(`ffmpeg exited: ${readFileSync(log, "utf8")}`);
      return existsSync(progress) && /^frame=[1-9]/m.test(readFileSync(progress, "utf8"));
    }, screen.wait);
  } catch (error) {
    p.kill("SIGKILL");
    throw error;
  }
  return p;
}

/**
 * A recording of the window, without X's cursor so the pointer can be drawn
 * in. With xcursor, a second recording keeps X's own cursor, for comparing.
 */
export class Recording {
  private constructor(
    readonly dir: string,
    readonly screen: Screen,
    readonly out: string,
    private recorders: Bun.Subprocess[],
  ) {}

  static async start(dir: string, screen: Screen, out: string, xcursor = false): Promise<Recording> {
    const recorders = [await recorder(dir, screen, "recording", false)];
    try {
      if (xcursor) recorders.push(await recorder(dir, screen, "xcursor", true));
    } catch (error) {
      recorders[0].kill("SIGKILL");
      throw error;
    }
    return new Recording(dir, screen, out, recorders);
  }

  /** Stops recording and writes the video, and with xcursor its .xcursor twin; returns their paths. */
  async stop(take: Take): Promise<string[]> {
    for (const p of this.recorders) p.kill("SIGINT");
    for (const p of this.recorders) {
      const stopped = await Promise.race([p.exited.then(() => true), Bun.sleep(this.screen.wait * 1000)]);
      // A Matroska file reads back without its trailer.
      if (!stopped) p.kill("SIGKILL");
      await p.exited;
    }
    try {
      return await encode(this.dir, this.screen, this.out, take, this.recorders.length > 1);
    } finally {
      for (const name of ["recording", "xcursor"])
        for (const ext of ["mkv", "log", "progress"]) rmSync(join(this.dir, `${name}.${ext}`), { force: true });
    }
  }

  /** Ends the recording without writing it, when its session closes. */
  abandon(): void {
    for (const p of this.recorders) p.kill("SIGKILL");
  }
}

/**
 * The frames to keep from first to last: every one while a script ran, and
 * of each stretch between scripts at most hold, the last lead of them leading
 * into the next script.
 */
export function keep(first: number, last: number, scripts: [number, number][], hold: number, lead: number): number[] {
  const kept: number[] = [];
  let between: number[] = [];
  const close = (end: boolean) => {
    if (between.length <= hold) kept.push(...between);
    else if (end) kept.push(...between.slice(0, hold));
    else kept.push(...between.slice(0, hold - lead), ...between.slice(between.length - lead));
    between = [];
  };
  for (let f = first; f <= last; f++)
    if (scripts.some(([a, b]) => f >= a && f <= b)) {
      close(false);
      kept.push(f);
    } else between.push(f);
  close(true);
  return kept;
}

function ease(k: number): number {
  return k < 0.5 ? 4 * k ** 3 : 1 - (-2 * k + 2) ** 3 / 2;
}

/**
 * A hand's path between two points: eased in and out, over 0.35 to 0.8
 * seconds by distance, as [ms from the start, x, y] every 16 ms or so.
 */
export function glide(from: [number, number], to: [number, number]): [number, number, number][] {
  const ms = Math.min(800, 350 + Math.hypot(to[0] - from[0], to[1] - from[1]) / 2);
  const steps = Math.max(1, Math.round(ms / 16));
  return Array.from({ length: steps }, (_, i) => {
    const k = ease((i + 1) / steps);
    return [Math.round(((i + 1) * ms) / steps), from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
  });
}

/** The pointer shapes drawn. */
export type Shape = "arrow" | "hand" | "text" | "resize" | "move";

const shapeNames: Record<string, Shape> = {
  pointer: "hand",
  hand1: "hand",
  hand2: "hand",
  text: "text",
  xterm: "text",
  "ew-resize": "resize",
  "col-resize": "resize",
  sb_h_double_arrow: "resize",
  fleur: "move",
  move: "move",
  "all-scroll": "move",
};

/** The shape drawn for a cursor's name; default and names without a drawing get the arrow. */
export function shapeOf(name: string | null): Shape {
  return (name && shapeNames[name]) || "arrow";
}

/** The last entry at or before t, by binary search over entries sorted by t. */
function at<T extends { t: number }>(list: T[], t: number): number {
  let [lo, hi] = [0, list.length - 1];
  if (hi < 0 || list[0].t > t) return -1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (list[mid].t <= t) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Where the pointer was at t: partway between two steps of a glide, or null before it first moved. */
export function positionAt(events: PointerEvent[], t: number): [number, number] | null {
  const i = at(events, t);
  if (i < 0) return null;
  const [a, b] = [events[i], events[i + 1]];
  // Glide steps come every 16 ms or so; a longer gap is a pointer at rest.
  if (!b || b.t - a.t > 50 || b.t === a.t) return [a.x, a.y];
  const k = (t - a.t) / (b.t - a.t);
  return [a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k];
}

/** The pointer's shape at t. */
export function shapeAt(shapes: ShapeEvent[], t: number): Shape {
  const i = at(shapes, t);
  return shapeOf(i < 0 ? null : shapes[i].name);
}

type Point = [number, number];
/** A filled polygon, or a segment thickened to radius r. */
type Part = { polygon: Point[] } | { from: Point; to: Point; r: number };

function segmentDistance(x: number, y: number, [ax, ay]: Point, [bx, by]: Point): number {
  const [dx, dy] = [bx - ax, by - ay];
  const k = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (ax + k * dx), y - (ay + k * dy));
}

/** Distance from a part's edge, negative inside it. */
function signed(x: number, y: number, part: Part): number {
  if ("r" in part) return segmentDistance(x, y, part.from, part.to) - part.r;
  const points = part.polygon;
  let inside = false,
    edge = Infinity;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const [[xi, yi], [xj, yj]] = [points[i], points[j]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    edge = Math.min(edge, segmentDistance(x, y, points[i], points[j]));
  }
  return inside ? -edge : edge;
}

const arrowhead = (tip: Point, back: Point, half: number): Part => {
  const [dx, dy] = [back[0] - tip[0], back[1] - tip[1]];
  const length = Math.hypot(dx, dy);
  const [nx, ny] = [(-dy / length) * half, (dx / length) * half];
  return {
    polygon: [tip, [back[0] + nx, back[1] + ny], [back[0] - nx, back[1] - ny]],
  };
};

/** Each shape's body in units where the arrow is 17.6 tall, with the point it points with. */
const designs: Record<Shape, { parts: Part[]; hotspot: Point }> = {
  arrow: {
    parts: [
      {
        polygon: [
          [0, 0],
          [0, 15.5],
          [3.6, 12.1],
          [6.2, 17.6],
          [8.4, 16.6],
          [5.9, 11.2],
          [10.8, 11.2],
        ],
      },
    ],
    hotspot: [0, 0],
  },
  hand: {
    parts: [
      { from: [4.5, 1.9], to: [4.5, 10], r: 1.6 },
      { from: [7.5, 7.4], to: [7.5, 10.5], r: 1.35 },
      { from: [10.3, 8.1], to: [10.3, 11], r: 1.25 },
      { from: [12.8, 9.2], to: [12.8, 11.6], r: 1.1 },
      { from: [1, 10.4], to: [3.4, 13.6], r: 1.2 },
      {
        polygon: [
          [2.9, 9.4],
          [14, 10],
          [13.6, 14.4],
          [11.9, 17.4],
          [5.4, 17.4],
          [3, 14.6],
        ],
      },
    ],
    hotspot: [4.5, 0.3],
  },
  text: {
    parts: [
      { from: [3, 1.4], to: [3, 15.6], r: 0.9 },
      { from: [1, 1], to: [5, 1], r: 0.8 },
      { from: [1, 16], to: [5, 16], r: 0.8 },
    ],
    hotspot: [3, 8.5],
  },
  resize: {
    parts: [
      { from: [5, 8], to: [15, 8], r: 1.1 },
      arrowhead([0, 8], [5.5, 8], 4.2),
      arrowhead([20, 8], [14.5, 8], 4.2),
    ],
    hotspot: [10, 8],
  },
  move: {
    parts: [
      { from: [4.5, 10], to: [15.5, 10], r: 1.1 },
      { from: [10, 4.5], to: [10, 15.5], r: 1.1 },
      arrowhead([0, 10], [4.8, 10], 3.8),
      arrowhead([20, 10], [15.2, 10], 3.8),
      arrowhead([10, 0], [10, 4.8], 3.8),
      arrowhead([10, 20], [10, 15.2], 3.8),
    ],
    hotspot: [10, 10],
  },
};

/** Each design's extent in its units, for drawing only near it. */
const extents = Object.fromEntries(
  Object.entries(designs).map(([shape, { parts }]) => {
    const ends = parts.flatMap(part =>
      "r" in part
        ? [part.from, part.to].flatMap(([x, y]) => [
            [x - part.r, y - part.r],
            [x + part.r, y + part.r],
          ])
        : part.polygon,
    );
    return [shape, [0, 1].map(axis => [Math.min(...ends.map(p => p[axis])), Math.max(...ends.map(p => p[axis]))])];
  }),
) as Record<Shape, [number, number][]>;

const clamp = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Lays color over an RGBA pixel, straight alpha. */
function over(rgba: Uint8Array, o: number, value: number, alpha: number) {
  if (alpha <= 0) return;
  const below = rgba[o + 3] / 255;
  const a = alpha + below * (1 - alpha);
  const mix = (c: number) => (value * alpha + c * below * (1 - alpha)) / a;
  rgba[o] = mix(rgba[o]);
  rgba[o + 1] = mix(rgba[o + 1]);
  rgba[o + 2] = mix(rgba[o + 2]);
  rgba[o + 3] = a * 255;
}

/**
 * Draws a pointer into a square tile with its hotspot at (hx, hy), height
 * pixels tall: a black body in a white outline over a soft shadow, as X's
 * own cursors are. Edges are smoothed from the distance to the shape.
 */
export function drawPointer(rgba: Uint8Array, size: number, shape: Shape, hx: number, hy: number, height: number) {
  const { parts, hotspot } = designs[shape];
  const unit = height / 17.6,
    outline = Math.max(1, unit * 0.7),
    blur = unit * 1.6,
    drop = unit * 0.7;
  const [[left, right], [top, bottom]] = extents[shape];
  const pad = outline + blur + drop + 1;
  const x0 = Math.max(0, Math.floor(hx + (left - hotspot[0]) * unit - pad));
  const x1 = Math.min(size - 1, Math.ceil(hx + (right - hotspot[0]) * unit + pad));
  const y0 = Math.max(0, Math.floor(hy + (top - hotspot[1]) * unit - pad));
  const y1 = Math.min(size - 1, Math.ceil(hy + (bottom - hotspot[1]) * unit + pad));
  const distance = (px: number, py: number) => {
    const [ux, uy] = [(px - hx) / unit + hotspot[0], (py - hy) / unit + hotspot[1]];
    let d = Infinity;
    for (const part of parts) d = Math.min(d, signed(ux, uy, part));
    return d * unit;
  };
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const [cx, cy] = [x + 0.5, y + 0.5];
      const d = distance(cx, cy);
      const shadow = distance(cx, cy - drop) - outline;
      const o = (y * size + x) * 4;
      over(rgba, o, 0, 0.3 * clamp(1 - shadow / blur));
      over(rgba, o, 255, clamp(0.5 - (d - outline)));
      over(rgba, o, 0, clamp(0.5 - d));
    }
}

/** Draws a press's ring around (cx, cy): white with a soft dark edge, at radius and alpha. */
export function drawRing(
  rgba: Uint8Array,
  size: number,
  cx: number,
  cy: number,
  radius: number,
  width: number,
  alpha: number,
) {
  const reach = radius + width + 2;
  for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(size - 1, Math.ceil(cy + reach)); y++)
    for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(size - 1, Math.ceil(cx + reach)); x++) {
      const d = Math.abs(Math.hypot(x + 0.5 - cx, y + 0.5 - cy) - radius);
      const o = (y * size + x) * 4;
      over(rgba, o, 0, alpha * 0.35 * clamp(0.5 - (d - width / 2 - 1)));
      over(rgba, o, 255, alpha * clamp(0.5 - (d - width / 2)));
    }
}

/** The drawn pointer for a video: where each frame's square tile sits, and the tile, drawn on demand. */
export interface Pointer extends Frames {
  size: number;
  x: number[];
  y: number[];
}

/** What one frame of the pointer shows, for drawing its tile. */
interface Look {
  shape: Shape;
  /** The hotspot's place in the tile, its height, and its rings as [x, y, progress]. */
  hx: number;
  hy: number;
  height: number;
  rings: [number, number, number][];
}

/**
 * A value per frame as an ffmpeg expression of the frame's time t: a flat
 * sum over the runs where it holds, each from half a frame before its first
 * frame to half after its last. Commands sent with sendcmd reach an overlay
 * a few frames early, while it waits on its other input, and its n counts
 * from 1.
 */
export function perFrame(values: number[]): string {
  const terms: string[] = [];
  const edge = (frame: number) => ((frame - 0.5) / FPS).toFixed(5);
  for (let i = 0; i < values.length;) {
    let j = i;
    while (values[j + 1] === values[i]) j++;
    if (values[i]) terms.push(`between(t,${edge(i)},${edge(j + 1)})*${values[i]}`);
    i = j + 1;
  }
  return terms.join("+") || "0";
}

/**
 * The pointer for each frame shown at times (ms since the epoch), scale times
 * the window's pixels. It grows while it moves and settles at rest, dips on a
 * press, and each press leaves a ring that spreads and fades. Tiles are drawn
 * when asked for, and a tile that looks like the last one is reused.
 */
export function pointerTiles(take: Take, times: number[], scale: number, cellHeight: number): Pointer {
  const height = cellHeight * 1.3 * scale,
    grown = 1.35,
    reach = height * 0.6;
  const size = 2 * Math.ceil(height * grown + reach + 8);
  const pointer = [...take.pointer].sort((a, b) => a.t - b.t);
  const shapes = [...take.shapes].sort((a, b) => a.t - b.t);
  const presses = pointer.filter(e => e.press);
  const looks: (Look | null)[] = [];
  const [x, y]: [number[], number[]] = [[], []];
  let grow = 1,
    last: [number, number] | null = null;
  times.forEach((t, i) => {
    const at = positionAt(pointer, t);
    if (!at) {
      looks.push(null);
      x.push(-10000);
      y.push(-10000);
      return;
    }
    const [px, py] = [at[0] * scale, at[1] * scale];
    // Speed only between frames next to each other in time; a cut is not a move.
    const next = i > 0 && Math.abs(t - times[i - 1] - 1000 / FPS) < 2;
    const speed = next && last ? Math.hypot(px - last[0], py - last[1]) / height : 0;
    last = [px, py];
    grow += (1 + (grown - 1) * clamp(speed / 0.25) - grow) * 0.2;
    let zoom = grow;
    const [cx, cy] = [Math.round(px), Math.round(py)];
    const rings: [number, number, number][] = [];
    for (const press of presses) {
      const since = t - press.t;
      if (since < 0 || since > 450) continue;
      if (since < 200) zoom *= 1 - 0.15 * Math.sin((Math.PI * since) / 200);
      rings.push([press.x * scale - cx + size / 2, press.y * scale - cy + size / 2, since / 450]);
    }
    looks.push({
      shape: shapeAt(shapes, t),
      hx: px - cx + size / 2,
      hy: py - cy + size / 2,
      height: height * zoom,
      rings,
    });
    x.push(cx - size / 2);
    y.push(cy - size / 2);
  });
  const blank = new Uint8Array(size * size * 4);
  let previous: { key: string; tile: Uint8Array } | null = null;
  const frame = (i: number) => {
    const look = looks[i];
    if (!look) return blank;
    const key = JSON.stringify(look, (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
    if (previous?.key === key) return previous.tile;
    const tile = new Uint8Array(size * size * 4);
    for (const [rx, ry, k] of look.rings) {
      const spread = 1 - (1 - k) ** 3;
      drawRing(tile, size, rx, ry, reach * (0.35 + 0.65 * spread), Math.max(2, scale * 2.5), 0.9 * (1 - k) ** 1.5);
    }
    drawPointer(tile, size, look.shape, look.hx, look.hy, look.height);
    previous = { key, tile };
    return tile;
  };
  return { size, x, y, count: times.length, frame };
}

/** A recording's first frame, in seconds since the epoch. */
async function startTime(raw: string): Promise<number> {
  const p = Bun.spawn(["ffprobe", "-v", "error", "-show_entries", "format=start_time", "-of", "csv=p=0", raw], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [text, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const start = Number(text.trim());
  if (code !== 0 || !Number.isFinite(start)) throw Error(`ffprobe could not read ${raw}'s start`);
  return start;
}

/**
 * Encodes the take: from record start to record stop, with every script's
 * time and at most idle between scripts, held idle at each end, and the
 * pointer drawn over it. With xcursor, also X's own cursor, cut the same way.
 * Returns the videos written.
 */
async function encode(dir: string, screen: Screen, out: string, take: Take, xcursor: boolean): Promise<string[]> {
  const raw = join(dir, "recording.mkv");
  const hold = Math.max(1, Math.round(screen.idle * FPS));
  const lead = Math.min(FPS / 2, Math.floor(hold / 2));
  const start = await startTime(raw);
  const frameAt = (ms: number) => Math.max(0, Math.round((ms / 1000 - start) * FPS));
  const timeAt = (frame: number) => (start + frame / FPS) * 1000;
  const [first, last] = [frameAt(take.from), Math.max(frameAt(take.from), frameAt(take.to))];
  const kept = keep(
    first,
    last,
    take.scripts.map(([a, b]) => [frameAt(a), frameAt(b)]),
    hold,
    lead,
  );
  // After the trim, frames count from first; runs of the rest are dropped.
  const drop: [number, number][] = [];
  for (let i = 0, f = first; f <= last; f++) {
    if (kept[i] === f) {
      i++;
      continue;
    }
    const n = f - first;
    if (drop.at(-1)?.[1] === n - 1) drop.at(-1)![1] = n;
    else drop.push([n, n]);
  }
  const select = drop.map(([a, b]) => `between(n,${a},${b})`).join("+");
  const timeline = (skip = 0) =>
    `setpts=PTS-STARTPTS,fps=${FPS},trim=start_frame=${Math.max(0, first + skip)}:end_frame=${last + skip + 1}` +
    `,setpts=PTS-STARTPTS` +
    (select ? `,select='not(${select})'` : "") +
    `,setpts=N/${FPS}/TB,tpad=start=${hold}:start_mode=clone:stop=${hold}:stop_mode=clone,setpts=N/${FPS}/TB`;
  const times = [
    ...Array<number>(hold).fill(timeAt(first)),
    ...kept.map(timeAt),
    ...Array<number>(hold).fill(timeAt(last)),
  ];
  // Doubled pixels give each 2x2 chroma sample one color. Past H.264 level
  // 5.1's frame size, an MP4 keeps the window's size, padded to even.
  const doubled = video(out) === "mp4" && screen.width * screen.height * 4 <= 4096 * 2304;
  const scale = doubled ? 2 : 1;
  const size = doubled
    ? "scale=iw*2:ih*2:flags=neighbor"
    : video(out) === "mp4"
      ? "pad=ceil(iw/2)*2:ceil(ih/2)*2"
      : "null";
  const pointer = pointerTiles(take, times, scale, screen.height / screen.rows);
  const tiles = ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${pointer.size}x${pointer.size}`];
  const graph =
    `[0:v]${timeline()},${size}[screen];[screen][1:v]overlay=format=gbrp:eof_action=pass` +
    `:x='${perFrame(pointer.x)}':y='${perFrame(pointer.y)}'`;
  await write(["-i", raw, ...tiles, "-framerate", String(FPS), "-i", "pipe:0"], graph, out, dir, pointer);
  if (!xcursor) return [out];
  // The second recorder started a little later; line its frames up with the first's.
  const other = join(dir, "xcursor.mkv");
  const shift = Math.round(((await startTime(other)) - start) * FPS);
  const twin = out.replace(/(\.[^./]+)$/, ".xcursor$1");
  await write(["-i", other], `[0:v]${timeline(-shift)},${size}`, twin, dir, null);
  return [out, twin];
}

/**
 * Writes a video from a filter graph whose last chain is left open. The graph
 * goes through a file: a long take's pointer outgrows a command-line argument.
 */
async function write(inputs: string[], graph: string, out: string, dir: string, frames: Frames | null): Promise<void> {
  mkdirSync(dirname(out), { recursive: true });
  const file = join(dir, "graph.txt");
  const run = (filters: string, map: string[]) => {
    writeFileSync(file, filters);
    return ffmpeg([...inputs, graphOption(), file, ...map], frames);
  };
  try {
    switch (video(out)) {
      case "mp4":
        await run(`${graph},format=yuv420p[v]`, [
          ...["-map", "[v]", "-c:v", "libx264", "-preset", "slow", "-crf", "18"],
          ...["-movflags", "+faststart", "-an", out],
        ]);
        return;
      case "gif": {
        // No dithering: text keeps solid edges.
        const palette = join(dir, "palette.png");
        await run(`${graph},palettegen[p]`, ["-map", "[p]", palette]);
        inputs = [...inputs, "-i", palette];
        const index = inputs.filter(arg => arg === "-i").length - 1;
        await run(`${graph}[v];[v][${index}:v]paletteuse=dither=none:diff_mode=rectangle[o]`, ["-map", "[o]", out]);
        rmSync(palette, { force: true });
        return;
      }
      case null:
        throw Error(`${out} is not an .mp4 or .gif`);
    }
  } finally {
    rmSync(file, { force: true });
  }
}
