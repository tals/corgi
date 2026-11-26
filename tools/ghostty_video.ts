/**
 * Records a capture's ghostty-host: screenshots once the screen holds still,
 * and videos encoded with the time between scripts cut and the pointer drawn
 * in where it went, in the shape Ghostty gave it, beside a timeline of the
 * pointer, the keys and the script's steps.
 */
import type { FileSink } from "bun";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import * as ghostty_host from "./ghostty_host";

/** Frames a second in a video unless asked otherwise. */
export const FPS = 60;

/** The capture's terminal and how it records. */
export interface Screen {
  /** ghostty-host's socket. */
  socket: string;
  /** The frame, in pixels. */
  width: number;
  height: number;
  cols: number;
  rows: number;
  /** A cell's size, and the padding left of and above the grid, in pixels. */
  cell: [number, number];
  padding: [number, number];
  /** Seconds a screenshot or a recording's start may take. */
  wait: number;
  /** Seconds a video opens and closes on, and the most it keeps between scripts. */
  idle: number;
  /** A video's frames a second unless record start names it. */
  fps: number;
}

/** A cell's middle (columns and rows from 1), in pixels. */
export function cellCenter(screen: Screen, col: number, row: number): [number, number] {
  return [screen.padding[0] + (col - 0.5) * screen.cell[0], screen.padding[1] + (row - 0.5) * screen.cell[1]];
}

/** What the mouse did (ms since the epoch; pixels in the frame). */
export interface PointerEvent {
  t: number;
  x: number;
  y: number;
  action: ghostty_host.MouseAction["action"];
  button?: ghostty_host.Button;
  /** Wheel notches, up when positive. */
  dy?: number;
}

/** When the pointer became the one with this CSS cursor name, as Ghostty asked for it. */
export interface ShapeEvent {
  t: number;
  name: string | null;
}

/** Keys pressed, text typed or pasted, as the script gave them. */
export interface KeyEvent {
  t: number;
  kind: "key" | "type" | "paste";
  value: string;
}

/** A link or file the capture was asked to open, which its stand-in opener noted instead. */
export interface OpenEvent {
  t: number;
  target: string;
}

/** A script command and when it ran; text commands also say the cell they found. */
export interface Step {
  t: number;
  end: number;
  command: string[];
  cell?: [number, number];
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
  keys: KeyEvent[];
  opens: OpenEvent[];
  steps: Step[];
  /** Speed commands; the kept time plays at each one's speed from then on. */
  paces: PaceEvent[];
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

/** Where a speed-up's badge sits: centered at the video's bottom or top. */
export type Place = "bottom" | "top";

/** How fast the video plays, 1 at real time, and where its badge sits. */
export interface Pace {
  speed: number;
  place: Place;
}

/** A pace from t on, ms since the epoch. */
export interface PaceEvent extends Pace {
  t: number;
}

const realTime: Pace = { speed: 1, place: "bottom" };

/** The fastest a speed command plays. */
export const MAX_SPEED = 1000;

/** A speed command's arguments: a speed from 1 to MAX_SPEED (4, x4 or 2.5) and top or bottom, or reset. */
export function paceOf(args: string[]): Pace | null {
  const [rate, place = "bottom", ...rest] = args;
  if (rate === "reset") return args.length === 1 ? realTime : null;
  if (rest.length || (place !== "bottom" && place !== "top")) return null;
  const match = /^x?(\d+(?:\.\d+)?)$/.exec(rate ?? "");
  const speed = match ? Number(match[1]) : 0;
  return speed >= 1 && speed <= MAX_SPEED ? { speed, place } : null;
}

/** The pace at t: the last change at or before it. */
export function paceAt(events: PaceEvent[], t: number): Pace {
  let pace = realTime;
  for (const event of events) if (event.t <= t) pace = event;
  return pace;
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

/** RGBA pictures laid over a video, one per frame. */
export interface Layer extends Frames {
  width: number;
  height: number;
}

/**
 * Layers as one stream, each frame's pictures stacked top to bottom from the
 * left, so one pipe keeps them in step; tops says where each one starts.
 */
export function stack(layers: Layer[]): Layer & { tops: number[] } {
  const width = Math.max(...layers.map(layer => layer.width));
  const tops = layers.map((_, i) => layers.slice(0, i).reduce((sum, layer) => sum + layer.height, 0));
  const height = tops.at(-1)! + layers.at(-1)!.height;
  let previous: { parts: Uint8Array[]; frame: Uint8Array } | null = null;
  const frame = (i: number) => {
    const parts = layers.map(layer => layer.frame(i));
    if (previous?.parts.every((part, k) => part === parts[k])) return previous.frame;
    const rgba = new Uint8Array(width * height * 4);
    layers.forEach((layer, k) => {
      const row = layer.width * 4;
      for (let y = 0; y < layer.height; y++)
        rgba.set(parts[k].subarray(y * row, (y + 1) * row), (tops[k] + y) * width * 4);
    });
    previous = { parts, frame: rgba };
    return rgba;
  };
  return { width, height, tops, count: layers[0].count, frame };
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

/** The screen as a PNG once nothing has been drawn for a while. */
export async function settled(screen: Screen, alive = () => {}): Promise<Uint8Array> {
  const host = new ghostty_host.Host(screen.socket);
  // Let layout and hover timers start before waiting for the screen to hold still.
  await Bun.sleep(300);
  await until(async () => {
    alive();
    return host.settle(700, 1000);
  }, screen.wait);
  return host.png();
}

/** Reads the first line a process prints, within seconds, then drains the rest so it never blocks on a full pipe. */
export async function firstLine(p: { stdout: ReadableStream<Uint8Array> }, seconds: number): Promise<string> {
  const reader = p.stdout.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let timer: Timer | undefined;
  const deadline = new Promise<null>(resolve => (timer = setTimeout(() => resolve(null), seconds * 1000)));
  try {
    while (!text.includes("\n")) {
      const chunk = await Promise.race([reader.read(), deadline]);
      if (!chunk) throw Error(`nothing within ${seconds}s`);
      if (chunk.done) break;
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  void (async () => {
    while (!(await reader.read()).done);
  })().catch(() => {});
  return text.split("\n")[0];
}

/** A recording of the screen at fps, made by ghostty_record.ts; the pointer is drawn in on stop. */
export class Recording {
  private constructor(
    readonly dir: string,
    readonly screen: Screen,
    readonly out: string,
    readonly fps: number,
    /** When its first frame was. */
    readonly start: number,
    private recorder: Bun.Subprocess,
  ) {}

  static async start(dir: string, screen: Screen, out: string, fps: number): Promise<Recording> {
    const log = join(dir, "recording.log");
    const p = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "ghostty_record.ts"),
        screen.socket,
        String(fps),
        join(dir, "recording.mkv"),
      ],
      { stdin: "ignore", stdout: "pipe", stderr: Bun.file(log) },
    );
    try {
      const line = await firstLine(p, screen.wait);
      const start = (JSON.parse(line || "{}") as { start?: number }).start;
      if (typeof start !== "number") throw Error(`the recorder failed: ${readFileSync(log, "utf8")}`);
      return new Recording(dir, screen, out, fps, start, p);
    } catch (error) {
      await end(p);
      throw error;
    }
  }

  /** Stops recording and writes the video and its timeline; returns their paths. */
  async stop(take: Take): Promise<string[]> {
    const log = join(this.dir, "recording.log");
    this.recorder.kill("SIGINT");
    try {
      const stopped = await Promise.race([this.recorder.exited.then(() => true), Bun.sleep(this.screen.wait * 1000)]);
      // A Matroska file reads back without its trailer.
      if (!stopped) await end(this.recorder);
      const code = await this.recorder.exited;
      if (stopped && code !== 0) throw Error(`the recorder failed: ${readFileSync(log, "utf8")}`);
      const times = await encode(this.dir, this.screen, this.out, take, this.start, this.fps);
      const file = timelinePath(this.out);
      writeFileSync(file, `${JSON.stringify(timeline(take, times, this.fps, this.screen, this.out))}\n`);
      return [this.out, file];
    } finally {
      for (const ext of ["mkv", "log"]) rmSync(join(this.dir, `recording.${ext}`), { force: true });
    }
  }

  /** Ends the recording without writing it, when its session closes. */
  abandon(): void {
    // The recorder ends its ffmpeg too.
    this.recorder.kill("SIGTERM");
  }
}

/** Ends a recorder and its ffmpeg, killing it if it doesn't go. */
async function end(p: Bun.Subprocess) {
  p.kill("SIGTERM");
  if (!(await Promise.race([p.exited.then(() => true), Bun.sleep(2000)]))) p.kill("SIGKILL");
  await p.exited;
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

/** Runs of equal values as [first, last, value], first and last inclusive. */
function runsOf<T>(values: T[]): [number, number, T][] {
  const runs: [number, number, T][] = [];
  values.forEach((value, i) => {
    const run = runs.at(-1);
    if (run && run[2] === value) run[1] = i;
    else runs.push([i, i, value]);
  });
  return runs;
}

/**
 * Which kept frames a video shows when each plays at its speed: in a run at
 * speed s from a, the n-th whenever floor((n - a) / s) steps; and the last,
 * so it closes on the last screen. pick() says the same to ffmpeg's select
 * in the same arithmetic.
 */
export function picks(speeds: number[]): number[] {
  const shown: number[] = [];
  for (const [a, b, s] of runsOf(speeds))
    for (let n = a; n <= b; n++)
      if (Math.floor((n - a) / s) > Math.floor((n - a - 1) / s) || n === speeds.length - 1) shown.push(n);
  return shown;
}

function pick(speeds: number[]): string | null {
  const fast = runsOf(speeds).filter(([, , s]) => s > 1);
  if (!fast.length) return null;
  const within = fast.map(([a, b]) => `between(n,${a},${b})`).join("+");
  const steps = fast.map(([a, b, s]) => `between(n,${a},${b})*gt(floor((n-${a})/${s}),floor((n-${a}-1)/${s}))`);
  return `max(max(1-(${within}),eq(n,${speeds.length - 1})),${steps.join("+")})`;
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
export type Shape = "arrow" | "hand" | "text" | "ew" | "ns" | "move";

/** Ghostty's CSS cursor names with a drawing of their own. */
const shapeNames: Record<string, Shape> = {
  pointer: "hand",
  text: "text",
  "vertical-text": "text",
  "ew-resize": "ew",
  "col-resize": "ew",
  "e-resize": "ew",
  "w-resize": "ew",
  "ns-resize": "ns",
  "row-resize": "ns",
  "n-resize": "ns",
  "s-resize": "ns",
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
  ew: {
    parts: [
      { from: [5, 8], to: [15, 8], r: 1.1 },
      arrowhead([0, 8], [5.5, 8], 4.2),
      arrowhead([20, 8], [14.5, 8], 4.2),
    ],
    hotspot: [10, 8],
  },
  ns: {
    parts: [
      { from: [8, 5], to: [8, 15], r: 1.1 },
      arrowhead([8, 0], [8, 5.5], 4.2),
      arrowhead([8, 20], [8, 14.5], 4.2),
    ],
    hotspot: [8, 10],
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

/** Parts' extent as [[left, right], [top, bottom]], for drawing only near them. */
function bounds(parts: Part[]): [number, number][] {
  const ends = parts.flatMap(part =>
    "r" in part
      ? [part.from, part.to].flatMap(([x, y]) => [
          [x - part.r, y - part.r],
          [x + part.r, y + part.r],
        ])
      : part.polygon,
  );
  return [0, 1].map(axis => [Math.min(...ends.map(p => p[axis])), Math.max(...ends.map(p => p[axis]))]);
}

/** Each design's extent in its units. */
const extents = Object.fromEntries(
  Object.entries(designs).map(([shape, { parts }]) => [shape, bounds(parts)]),
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

/** Shapes drawn white in a black outline, as desktops draw the hand over a link. */
const light: ReadonlySet<Shape> = new Set(["hand"]);

/**
 * Draws a pointer into a square tile with its hotspot at (hx, hy), height
 * pixels tall, over a soft shadow: a black body in a white outline, or a
 * light shape's white in black. Edges are smoothed from the distance to the
 * shape.
 */
export function drawPointer(rgba: Uint8Array, size: number, shape: Shape, hx: number, hy: number, height: number) {
  const { parts, hotspot } = designs[shape];
  const [edge, body] = light.has(shape) ? [0, 255] : [255, 0];
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
      over(rgba, o, edge, clamp(0.5 - (d - outline)));
      over(rgba, o, body, clamp(0.5 - d));
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
 * A value per frame as an ffmpeg expression of the frame's time t: a
 * balanced tree of if(lt(t,edge),…) over the runs where it holds, each run
 * starting half a frame before its first frame. FFmpeg 9 refuses a flat
 * sum of runs as nested too deep; a tree nests log(runs) deep. Not sendcmd:
 * its commands reach an overlay a few frames early, and its n counts from 1.
 */
export function perFrame(values: number[], fps = FPS): string {
  const runs: [number, number][] = [];
  values.forEach((value, frame) => {
    if (runs.at(-1)?.[1] !== value) runs.push([frame, value]);
  });
  if (!runs.length) return "0";
  const edge = (frame: number) => ((frame - 0.5) / fps).toFixed(5);
  const tree = (lo: number, hi: number): string => {
    if (lo === hi) return String(runs[lo][1]);
    const mid = (lo + hi + 1) >> 1;
    return `if(lt(t,${edge(runs[mid][0])}),${tree(lo, mid - 1)},${tree(mid, hi)})`;
  };
  return tree(0, runs.length - 1);
}

/**
 * The pointer for each frame shown at times (ms since the epoch), scale times
 * the window's pixels, each frame played at its speed in speeds (1 if
 * missing). It grows while it moves and settles at rest, dips on a press,
 * and each press leaves a ring that spreads and fades at the video's pace.
 * Tiles are drawn when asked for, and a tile that looks like the last one
 * is reused.
 */
export function pointerTiles(
  take: Take,
  times: number[],
  scale: number,
  cellHeight: number,
  fps = FPS,
  speeds: number[] = [],
): Pointer {
  const height = cellHeight * 1.3 * scale,
    grown = 1.35,
    reach = height * 0.6;
  const size = 2 * Math.ceil(height * grown + reach + 8);
  const pointer = [...take.pointer].sort((a, b) => a.t - b.t);
  const shapes = [...take.shapes].sort((a, b) => a.t - b.t);
  // The wheel's buttons don't show a press.
  const presses = pointer.filter(e => e.action === "press");
  // A frame's speed as it follows the one before: the faster of the two, so
  // the gap on leaving a speed-up counts at its pace.
  const pace = (i: number) => Math.max(speeds[i] ?? 1, speeds[i - 1] ?? 1);
  // Time as the video plays it: the wall time between frames over that pace.
  const clock: number[] = [];
  times.forEach((t, i) => clock.push(i ? clock[i - 1] + (t - times[i - 1]) / pace(i) : t));
  const clockAt = (t: number) => {
    const j = times.findIndex(time => time >= t);
    if (j === -1) return clock.at(-1)! + (t - times.at(-1)!);
    return j ? clock[j - 1] + (t - times[j - 1]) / pace(j) : clock[0] - (times[0] - t);
  };
  const pressed = presses.map(press => clockAt(press.t));
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
    // Motion only between frames next to each other in time, a speed-up's
    // stride apart at most; a cut is not a move.
    const next = i > 0 && t > times[i - 1] && t - times[i - 1] < (Math.ceil(pace(i)) * 1000) / fps + 2;
    const motion = next && last ? Math.hypot(px - last[0], py - last[1]) / height : 0;
    last = [px, py];
    grow += (1 + (grown - 1) * clamp(motion / 0.25) - grow) * 0.2;
    let zoom = grow;
    const [cx, cy] = [Math.round(px), Math.round(py)];
    const rings: [number, number, number][] = [];
    for (const [k, press] of presses.entries()) {
      const since = clock[i] - pressed[k];
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

/** Points along an ellipse around (cx, cy), between two angles in degrees clockwise from 3 o'clock. */
function arc(cx: number, cy: number, rx: number, ry: number, from: number, to: number): Point[] {
  const steps = Math.ceil(Math.abs(to - from) / 12);
  return Array.from({ length: steps + 1 }, (_, i) => {
    const a = ((from + ((to - from) * i) / steps) * Math.PI) / 180;
    return [cx + rx * Math.cos(a), cy + ry * Math.sin(a)];
  });
}

const six: Point[][] = [arc(3, 7, 3, 3, 0, 360), arc(5, 7, 5, 7, 180, 262)];

/** The badge's figures as lines through points, in units where a figure is 10 tall. */
const figures: Record<string, { width: number; lines: Point[][] }> = {
  "0": { width: 6, lines: [arc(3, 5, 3, 5, 0, 360)] },
  "1": {
    width: 2.6,
    lines: [
      [
        [0, 2.2],
        [2.6, 0],
        [2.6, 10],
      ],
    ],
  },
  "2": {
    width: 6,
    lines: [[...arc(3, 3, 3, 3, 195, 400), [0, 10], [6, 10]]],
  },
  "3": {
    width: 6,
    lines: [
      [...arc(2.95, 2.5, 2.75, 2.5, 205, 450), [2.2, 5]],
      [[2.2, 5], ...arc(3, 7.5, 3, 2.5, 270, 515)],
    ],
  },
  "4": {
    width: 6,
    lines: [
      [
        [4.5, 10],
        [4.5, 0],
        [0, 7],
        [6, 7],
      ],
    ],
  },
  "5": {
    width: 6,
    lines: [[[5.6, 0], [0.9, 0], [0.5, 4.7], ...arc(3, 6.75, 3, 3.25, 232, 512)]],
  },
  "6": { width: 6, lines: six },
  "7": {
    width: 6,
    lines: [
      [
        [0, 0],
        [6, 0],
        [1.8, 10],
      ],
    ],
  },
  "8": { width: 6, lines: [arc(3, 2.45, 2.65, 2.45, 0, 360), arc(3, 7.45, 3, 2.55, 0, 360)] },
  "9": { width: 6, lines: six.map(line => line.map(([x, y]): Point => [6 - x, 10 - y])) },
  ".": { width: 0, lines: [[[0, 10]]] },
  ":": { width: 0, lines: [[[0, 2.8]], [[0, 7.2]]] },
  "+": {
    width: 5,
    lines: [
      [
        [0, 5],
        [5, 5],
      ],
      [
        [2.5, 2.5],
        [2.5, 7.5],
      ],
    ],
  },
  "×": {
    width: 5,
    lines: [
      [
        [0, 2.6],
        [5, 7.6],
      ],
      [
        [5, 2.6],
        [0, 7.6],
      ],
    ],
  },
};

/**
 * Text in the badge's figures, cap pixels tall in strokes stroke wide, from
 * (x, top): its parts and width. Digits are tabular, so a count keeps its width.
 */
export function typeset(
  text: string,
  x: number,
  top: number,
  cap: number,
  stroke: number,
): { parts: Part[]; width: number } {
  const [unit, r, gap] = [(cap - stroke) / 10, stroke / 2, cap * 0.16];
  const parts: Part[] = [];
  let at = x;
  for (const char of text) {
    const figure = figures[char];
    if (!figure) throw Error(`the badge has no figure for ${char}`);
    const width = /\d/.test(char) ? figures["0"].width : figure.width;
    const indent = (width - figure.width) / 2;
    for (const line of figure.lines) {
      const points = line.map(([fx, fy]): Point => [at + r + (indent + fx) * unit, top + r + fy * unit]);
      if (points.length === 1) parts.push({ from: points[0], to: points[0], r });
      for (let i = 1; i < points.length; i++) parts.push({ from: points[i - 1], to: points[i], r });
    }
    at += width * unit + stroke + gap;
  }
  return { parts, width: at - gap - x };
}

/** Paints parts over an RGBA picture width pixels wide in one gray at alpha, smoothed at their edges, and only inside clip. */
function paint(rgba: Uint8Array, width: number, parts: Part[], value: number, alpha: number, clip?: Part) {
  const height = rgba.length / 4 / width;
  const [[left, right], [top, bottom]] = bounds(parts);
  for (let y = Math.max(0, Math.floor(top) - 1); y <= Math.min(height - 1, Math.ceil(bottom)); y++)
    for (let x = Math.max(0, Math.floor(left) - 1); x <= Math.min(width - 1, Math.ceil(right)); x++) {
      let d = Infinity;
      for (const part of parts) d = Math.min(d, signed(x + 0.5, y + 0.5, part));
      const inside = clip ? clamp(0.5 - signed(x + 0.5, y + 0.5, clip)) : 1;
      over(rgba, (y * width + x) * 4, value, alpha * inside * clamp(0.5 - d));
    }
}

/** Wall-clock time as +m:ss, or +h:mm:ss from an hour on. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const [h, m] = [Math.floor(s / 3600), Math.floor(s / 60) % 60];
  const two = (n: number) => String(n).padStart(2, "0");
  return h ? `+${h}:${two(m)}:${two(s % 60)}` : `+${m}:${two(s % 60)}`;
}

/** A speed-up's badge: a picture per frame, laid over the video at (x, y[i]). */
export interface Badge extends Layer {
  x: number;
  y: number[];
}

/** Eases out past 1 and back, by about a tenth. */
function backOut(k: number): number {
  const [c1, c3] = [1.5, 2.5];
  return 1 + c3 * (k - 1) ** 3 + c1 * (k - 1) ** 2;
}

/** What a frame's badge shows: its run's card, texts, how far it sits from rest, and how opaque. */
interface BadgeLook {
  card: number;
  label: string;
  clock: string;
  shift: number;
  fade: number;
  swap?: Swap;
}

/** Texts a badge swaps out as its own swap in, laid out for card, and how far the swap has come, from 0 to 1. */
interface Swap {
  card: number;
  label: string;
  clock: string;
  step: number;
  /** A new speed-up: every text swaps, even one that reads the same. */
  all: boolean;
}

/**
 * A speed-up's badge for each frame shown at times, each played at its
 * speed in speeds, in a video size pixels across whose cells are cell pixels
 * tall: a dark pill centered at the bottom or top, as places say, with
 * ×speed and the wall-clock time since the speed-up began. It rises in as a
 * run of sped-up frames starts and sinks away after it ends; a speed-up that
 * starts while it sinks swaps its texts in instead, as does a new speed.
 * Pictures are drawn when asked for, and a frame that looks like the last
 * reuses its one.
 */
export function badgeTiles(
  times: number[],
  speeds: number[],
  places: Place[],
  cell: number,
  [videoWidth, videoHeight]: [number, number],
  fps = FPS,
): Badge {
  // Frames it takes to rise in, and to sink away.
  const [intro, outro] = [Math.round(0.45 * fps), Math.round(0.3 * fps)];
  const tall = Math.round(cell * 2.4),
    cap = tall * 0.44,
    bold = cap * 0.15,
    thin = cap * 0.12,
    pad = tall * 0.38,
    gap = tall * 0.26,
    margin = Math.round(cell),
    travel = tall * 0.7,
    blur = tall * 0.22,
    drop = tall * 0.08;
  const label = (speed: number) => `×${speed}`;
  const measure = (text: string, stroke: number) => typeset(text, 0, 0, cap, stroke).width;
  // A card per edge it sits at in each sped-up run; its clock counts from the run's start.
  const cards = runsOf(speeds.map(speed => speed > 1))
    .filter(([, , fast]) => fast)
    .flatMap(([from, to]) =>
      runsOf(places.slice(from, to + 1)).map(([a, b, place]) => {
        [a, b] = [from + a, from + b];
        const slot = Math.max(...speeds.slice(a, b + 1).map(speed => measure(label(speed), bold)));
        const clock = measure(elapsed(times[b] - times[from]), thin);
        return { a, b, from, place, slot, clock, across: 2 * pad + slot + 2 * gap + clock };
      }),
    );
  const width = Math.ceil(Math.max(0, ...cards.map(card => card.across)) + 2 * blur + 4);
  const height = 2 * Math.ceil(tall / 2 + travel + blur + drop + 2);
  const rest = { top: margin + tall / 2, bottom: videoHeight - margin - tall / 2 };
  const looks: (BadgeLook | null)[] = times.map(() => null);
  const y = times.map(() => Math.round(rest.bottom - height / 2));
  // Frames a swap of the badge's texts takes.
  const swapping = Math.round(0.3 * fps);
  // The card last drawn, whose badge may still be sinking away.
  let last: { k: number; b: number } | null = null;
  for (const [k, card] of cards.entries()) {
    const away = card.place === "bottom" ? travel : -travel;
    const at = Math.round(rest[card.place] - height / 2);
    const texts = (i: number) => ({ label: label(speeds[i]), clock: elapsed(times[i] - times[card.from]) });
    // Begun while the last sinks away: at the other edge it rises in once
    // that has gone. At the same edge the badge stays up: within one
    // speed-up it carries on, and a new one swaps its texts in over the gap.
    const prior = last && cards[last.k];
    const follows = last !== null && card.a < last.b + outro;
    const here = follows && prior?.place === card.place;
    const begin = follows && !here ? last!.b + outro : card.a;
    if (begin > card.b) continue;
    let swap = (_i: number): Swap | undefined => undefined;
    if (last !== null && here) {
      const [end, was] = [last.b, looks[last.b]!];
      const carries = prior?.from === card.from;
      const span = Math.max(swapping, card.a - end);
      if (!carries)
        swap = i => (i - end < span ? { ...was, card: was.card, step: (i - end) / span, all: true } : undefined);
      for (let i = end + 1; i < card.a; i++) {
        looks[i] = { card: k, ...texts(carries ? i : card.a), shift: 0, fade: 1, swap: swap(i) };
        y[i] = at;
      }
    }
    // Where the speed last changed within the card, to swap the label.
    let changed = card.a;
    for (let i = begin; i <= Math.min(times.length - 1, card.b + outro - 1); i++) {
      const inside = i <= card.b;
      const step = inside ? (here ? 1 : clamp((i - begin + 1) / intro)) : (i - card.b) / outro;
      const now = texts(Math.min(i, card.b));
      if (inside && i > card.a && speeds[i] !== speeds[i - 1]) changed = i;
      const relabel =
        inside && changed > card.a && i - changed < swapping
          ? { ...now, card: k, label: label(speeds[changed - 1]), step: (i - changed + 1) / swapping, all: false }
          : undefined;
      looks[i] = {
        card: k,
        ...now,
        shift: away * (inside ? 1 - backOut(step) : step ** 2),
        fade: inside ? 1 - (1 - clamp(step / 0.7)) ** 3 : 1 - step ** 1.5,
        swap: (inside ? swap(i) : undefined) ?? relabel,
      };
      y[i] = at;
    }
    last = { k, b: card.b };
  }
  const blank = new Uint8Array(width * height * 4);
  const draw = (look: BadgeLook) => {
    const rgba = new Uint8Array(width * height * 4);
    const { swap } = look;
    // A swap eases the pill from the old texts' size to the new ones'.
    const e = swap ? ease(swap.step) : 1;
    const [now, was] = [cards[look.card], cards[swap?.card ?? look.card]];
    const [across, slot] = [was.across + (now.across - was.across) * e, was.slot + (now.slot - was.slot) * e];
    const [cx, cy, r] = [width / 2, height / 2 + look.shift, tall / 2];
    const [left, right] = [cx - across / 2, cx + across / 2];
    const pill = (dy: number): Part => ({ from: [left + r, cy + dy], to: [right - r, cy + dy], r });
    const shadow = pill(drop);
    for (let py = Math.max(0, Math.floor(cy + drop - r - blur)); py < Math.min(height, cy + drop + r + blur); py++)
      for (let px = Math.max(0, Math.floor(left - blur)); px < Math.min(width, right + blur); px++) {
        const d = signed(px + 0.5, py + 0.5, shadow);
        over(rgba, (py * width + px) * 4, 0, 0.45 * look.fade * clamp(0.5 - d / (2 * blur)) ** 2);
      }
    const body = pill(0),
      line = Math.max(1, tall * 0.012);
    for (let py = Math.max(0, Math.floor(cy - r - 1)); py < Math.min(height, cy + r + 1); py++)
      for (let px = Math.max(0, Math.floor(left - 1)); px < Math.min(width, right + 1); px++) {
        const d = signed(px + 0.5, py + 0.5, body);
        const cover = clamp(0.5 - d);
        if (!cover) continue;
        const o = (py * width + px) * 4;
        // A little lighter at the top, and a hairline inside the edge.
        over(rgba, o, 38 - 26 * clamp((py + 0.5 - (cy - r)) / tall), 0.9 * look.fade * cover);
        over(rgba, o, 255, 0.16 * look.fade * (cover - clamp(0.5 - (d + line))));
      }
    const [top, rise] = [cy - cap / 2, tall * 0.7];
    // A text that swaps rolls up out of the pill as the new one rolls in from below.
    const roll = (old: string | null, text: string, stroke: number, alpha: number, x: (width: number) => number) => {
      const put = (value: string, dy: number, a: number) => {
        const parts = typeset(value, x(typeset(value, 0, 0, cap, stroke).width), top + dy, cap, stroke).parts;
        paint(rgba, width, parts, 255, a * look.fade, body);
      };
      if (old === null) return put(text, 0, alpha);
      put(old, -rise * e, alpha * (1 - e));
      put(text, rise * (1 - e), alpha * e);
    };
    const swaps = (old: string | undefined, text: string) =>
      swap && old !== undefined && (swap.all || old !== text) ? old : null;
    roll(swaps(swap?.label, look.label), look.label, bold, 1, w => left + pad + (slot - w) / 2);
    const divider = left + pad + slot + gap;
    const rule = Math.max(0.5, tall * 0.012);
    paint(
      rgba,
      width,
      [{ from: [divider, cy - tall * 0.22], to: [divider, cy + tall * 0.22], r: rule }],
      255,
      0.3 * look.fade,
    );
    roll(swaps(swap?.clock, look.clock), look.clock, thin, 0.85, w => right - pad - w);
    return rgba;
  };
  let previous: { key: string; tile: Uint8Array } | null = null;
  const frame = (i: number) => {
    const look = looks[i];
    if (!look) return blank;
    const key = JSON.stringify(look, (_, v) => (typeof v === "number" ? Math.round(v * 100) / 100 : v));
    if (previous?.key !== key) previous = { key, tile: draw(look) };
    return previous.tile;
  };
  return { width, height, x: Math.round((videoWidth - width) / 2), y, count: times.length, frame };
}

/** How many frames a video holds still at each end. */
function holdFrames(screen: Screen, fps: number): number {
  return Math.max(1, Math.round(screen.idle * fps));
}

/**
 * What each frame of a video shows: of kept frames grabbed at times, those
 * picks() shows at the paces then, held hold frames at real time at each end.
 */
export function shownFrames(times: number[], paces: PaceEvent[], hold: number): PaceEvent[] {
  const held = (t: number) => Array.from({ length: hold }, (): PaceEvent => ({ t, ...realTime }));
  const shown = picks(times.map(t => paceAt(paces, t).speed)).map(n => ({ ...paceAt(paces, times[n]), t: times[n] }));
  return [...held(times[0]), ...shown, ...held(times.at(-1)!)];
}

/**
 * Encodes the take: from record start to record stop, with every script's
 * time and at most idle between scripts, held idle at each end, and the
 * pointer drawn over it. Kept time plays at the speed commands' speeds, with
 * a badge while it's sped up; the holds stay at real time. Returns when each
 * of the video's frames was, in ms since the epoch.
 */
async function encode(
  dir: string,
  screen: Screen,
  out: string,
  take: Take,
  start: number,
  fps: number,
): Promise<number[]> {
  const raw = join(dir, "recording.mkv");
  const hold = holdFrames(screen, fps);
  const lead = Math.min(Math.floor(fps / 2), Math.floor(hold / 2));
  const frameAt = (ms: number) => Math.max(0, Math.round(((ms - start) / 1000) * fps));
  const timeAt = (frame: number) => start + (frame * 1000) / fps;
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
  const grabbed = kept.map(timeAt);
  const fast = pick(grabbed.map(t => paceAt(take.paces, t).speed));
  const cut =
    `setpts=PTS-STARTPTS,trim=start_frame=${first}:end_frame=${last + 1},setpts=PTS-STARTPTS` +
    (select ? `,select='not(${select})'` : "") +
    (fast ? `,select='${fast}'` : "") +
    `,setpts=N/${fps}/TB,tpad=start=${hold}:start_mode=clone:stop=${hold}:stop_mode=clone,setpts=N/${fps}/TB`;
  const frames = shownFrames(grabbed, take.paces, hold);
  const times = frames.map(frame => frame.t);
  const speeds = frames.map(frame => frame.speed);
  // Doubled pixels give each 2x2 chroma sample one color. Past H.264 level
  // 5.1's frame size, an MP4 keeps the screen's size, padded to even.
  const doubled = video(out) === "mp4" && screen.width * screen.height * 4 <= 4096 * 2304;
  const scale = doubled ? 2 : 1;
  const even = (n: number) => (video(out) === "mp4" ? 2 * Math.ceil(n / 2) : n);
  const size = doubled
    ? "scale=iw*2:ih*2:flags=neighbor"
    : video(out) === "mp4"
      ? "pad=ceil(iw/2)*2:ceil(ih/2)*2"
      : "null";
  const pointer = pointerTiles(take, times, scale, screen.cell[1], fps, speeds);
  const tile: Layer = { ...pointer, width: pointer.size, height: pointer.size };
  const badge = fast
    ? badgeTiles(
        times,
        speeds,
        frames.map(frame => frame.place),
        screen.cell[1] * scale,
        [even(screen.width * scale), even(screen.height * scale)],
        fps,
      )
    : null;
  // The badge rides under the pointer's tile in the one pipe, and is drawn under the pointer.
  const both = badge && stack([tile, badge]);
  const piped: Layer = both ?? tile;
  const place = `overlay=format=gbrp:eof_action=pass:x='${perFrame(pointer.x, fps)}':y='${perFrame(pointer.y, fps)}'`;
  const graph =
    badge && both
      ? `[1:v]split[a][b];[a]crop=${tile.width}:${tile.height}:0:0[pointer];` +
        `[b]crop=${badge.width}:${badge.height}:0:${both.tops[1]}[badge];` +
        `[0:v]${cut},${size}[screen];` +
        `[screen][badge]overlay=format=gbrp:eof_action=pass:x=${badge.x}:y='${perFrame(badge.y, fps)}'[badged];[badged][pointer]${place}`
      : `[0:v]${cut},${size}[screen];[screen][1:v]${place}`;
  const tiles = ["-f", "rawvideo", "-pixel_format", "rgba", "-video_size", `${piped.width}x${piped.height}`];
  await write(["-i", raw, ...tiles, "-framerate", String(fps), "-i", "pipe:0"], graph, out, dir, piped);
  return times;
}

/** Where a video's timeline goes: demo.mp4's is demo.timeline.json. */
export function timelinePath(out: string): string {
  return out.replace(/(\.[^./]+)?$/, ".timeline.json");
}

/** A timeline entry, at t seconds into the video (its frame t * fps). */
export type Moment =
  | { t: number; type: "move"; x: number; y: number }
  | { t: number; type: "press" | "release"; button: string; x: number; y: number }
  | { t: number; type: "scroll"; dy: number; x: number; y: number }
  | { t: number; type: "shape"; shape: string }
  | { t: number; type: "key" | "type" | "paste" | "open"; value: string }
  | { t: number; end: number; type: "step"; command: string; cell?: [number, number] };

/**
 * What happened in a video and when: the pointer's moves, buttons and
 * wheel in the screen's pixels, the shapes Ghostty gave it, the keys, and
 * each script command. A moment in time the video cut lands on the frame
 * shown in its place.
 */
export function timeline(take: Take, times: number[], fps: number, screen: Screen, out: string) {
  // The closing hold repeats the last frame kept; a moment there lands on that frame, before the hold.
  const lastKept = times.length - 1 - holdFrames(screen, fps);
  const frame = (ms: number) => {
    let [lo, hi] = [0, times.length - 1];
    // Before the first frame kept, as the take began: that frame, after the opening hold.
    ms = Math.max(ms, times[0]);
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= ms) lo = mid;
      else hi = mid - 1;
    }
    return Math.min(lo, lastKept);
  };
  const at = (ms: number) => Math.round((frame(ms) / fps) * 1000) / 1000;
  const px = (v: number) => Math.round(v * 10) / 10;
  const inside = (ms: number) => ms >= take.from && ms <= take.to;
  // Where the pointer rested as the take began, as a move there.
  const rest = take.pointer.findLast(e => e.t < take.from);
  const pointer: PointerEvent[] = [
    ...(rest ? [{ t: take.from, x: rest.x, y: rest.y, action: "move" as const }] : []),
    ...take.pointer.filter(e => inside(e.t)),
  ];
  const moments: Moment[] = [
    ...pointer.map((e): Moment => {
      const [t, x, y] = [at(e.t), px(e.x), px(e.y)];
      switch (e.action) {
        case "move":
          return { t, type: "move", x, y };
        case "scroll":
          return { t, type: "scroll", dy: e.dy ?? 0, x, y };
        default:
          return { t, type: e.action, button: e.button ?? "left", x, y };
      }
    }),
    ...take.shapes
      .filter(e => e.t <= take.to)
      .map((e): Moment => ({ t: at(Math.max(e.t, take.from)), type: "shape", shape: e.name ?? "default" })),
    ...take.keys.filter(e => inside(e.t)).map((e): Moment => ({ t: at(e.t), type: e.kind, value: e.value })),
    ...take.opens.filter(e => inside(e.t)).map((e): Moment => ({ t: at(e.t), type: "open", value: e.target })),
    ...take.steps
      .filter(e => inside(e.t))
      .map((e): Moment => ({ t: at(e.t), end: at(e.end), type: "step", command: e.command.join(" "), cell: e.cell })),
  ];
  moments.sort((a, b) => a.t - b.t);
  return {
    video: out,
    fps,
    duration: Math.round((times.length / fps) * 1000) / 1000,
    screen: {
      width: screen.width,
      height: screen.height,
      cols: screen.cols,
      rows: screen.rows,
      cell: screen.cell,
      padding: screen.padding,
    },
    events: moments,
  };
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
