/**
 * Captures a live Ghostty window on a private Xvfb display, including Kitty images.
 *
 *   bun tools/ghostty_screenshot.ts --sandbox review -o review.png
 *   bun tools/ghostty_screenshot.ts --do 'corgi action help' -o help.png
 *   bun tools/ghostty_screenshot.ts --do 'corgi action help' --do 'xdotool key Down' -o help.mp4
 *   bun tools/ghostty_screenshot.ts -- /bin/sh -c 'printf "hello\\n"; sleep 30'
 *
 * An .mp4 or .gif output records a video of the --do steps.
 *
 * A session keeps the sandbox running for an agent to drive, screenshot and record:
 *
 *   bun tools/ghostty_screenshot.ts serve --sandbox review   prints its paths; runs until stopped
 *   $SESSION/bin/corgi action help                            the sandbox's corgi, over its socket
 *   $SESSION/bin/screenshot -o help.png                       capture now
 *   $SESSION/bin/record start -o demo.mp4                     start a video; takes --idle
 *   $SESSION/bin/record stop                                  write it
 *   bun tools/ghostty_screenshot.ts stop                       end it and clean up
 *
 * Options:
 *   --sandbox NAME   world from tools/sandboxes; default launcher
 *   --corgi PATH     compiled binary; default dist/corgi
 *   --size COLSxROWS terminal cells; default 120x36
 *   --font-size N    Ghostty font size in points; default 16
 *   --wait S         deadline for startup and each capture; default 20
 *   -o, --out PATH   .png, or .mp4 or .gif for a video; default ghostty-screenshot.png,
 *                    or ghostty-recording.mp4 for record start
 *   --idle S         longest a still screen lasts in a video; default 2
 *   --do SHELL       run against the sandbox after its viewer attaches; repeatable
 *   -- COMMAND ...   run a command instead of a sandbox; keep it alive to capture
 *   --session DIR    for shot, record and stop: the session; default $CORGI_CAPTURE_SESSION
 *                    or the only one running
 *
 * Needs Ghostty, Xvfb, xdotool and ffmpeg on PATH. GHOSTTY_BIN selects Ghostty.
 * Each run owns a disposable sandbox, display and terminal. No personal config
 * is loaded. Screenshots use the window's exact bounds, with no scaling or repainting.
 * --do steps and a session's env.sh get corgi on PATH, CORGI_SOCKET, and
 * DISPLAY and GHOSTTY_WINDOW for xdotool.
 *
 * Videos show the pointer. They open and close on a still screen held for
 * --idle seconds and cut longer pauses to that, so the time an agent spends
 * between steps stays out. Changes under 8 cells, like a meter ticking or the
 * corgi blinking, don't end a pause. MP4s are H.264 with each pixel doubled,
 * so 4:2:0 chroma can't smear colored text; GIFs keep the window's size.
 */
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import type { Sandbox, World } from "./sandbox";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "corgi-ghostty-";
const FPS = 30;

type Mode = "capture" | "serve" | "shot" | "stop" | "record start" | "record stop";

type Video = "mp4" | "gif";

interface Options {
  sandbox: string;
  corgi: string;
  cols: number;
  rows: number;
  fontSize: number;
  wait: number;
  out: string | null;
  idle: number;
  command: string[] | null;
  steps: string[];
  session: string | null;
}

export interface Driver {
  sandbox: Sandbox | null;
  /** X key names, e.g. ctrl+b, Escape, Down, Return. */
  key(...keys: string[]): void;
  /** Mouse positions are 1-based terminal cells. */
  move(col: number, row: number): void;
  click(col: number, row: number): void;
  settle(): Promise<void>;
  screenshot(path: string): Promise<void>;
  /** Starts a video of the window; .mp4 or .gif. */
  record(path: string): Promise<Recording>;
}

export interface Recording {
  /** Writes the video and prints its path. */
  stop(): Promise<void>;
}

interface Recipe {
  prepare?(sandbox: Sandbox): Promise<void>;
  drive?(driver: Driver): Promise<void>;
}

/** What `serve` leaves in session.json for `shot` and `stop`. */
interface SessionFile {
  pid: number;
  /** The process's start time, so a reused PID is not taken for the session. */
  started: string;
  display: string;
  window: string;
  cols: number;
  rows: number;
  wait: number;
}

/** What a recording captures and how long it may wait. */
type Screen = Omit<SessionFile, "pid" | "started">;

/** What `record start` leaves in recording.json for `record stop`. */
interface RecordingFile {
  pid: number;
  started: string;
  out: string;
  idle: number;
  width: number;
  height: number;
  cols: number;
  rows: number;
}

/** What recording.lock holds: the record command using the session's recording files. */
type Owner = Pick<RecordingFile, "pid" | "started">;

const defaults: Options = {
  sandbox: "launcher",
  corgi: join(ROOT, "dist/corgi"),
  cols: 120,
  rows: 36,
  fontSize: 16,
  wait: 20,
  out: null,
  idle: 2,
  command: null,
  steps: [],
  session: null,
};

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error(`${flag} needs a positive number`);
  return n;
}

function parse(argv: string[]): [Mode, Options] {
  let mode: Mode = "capture";
  if (argv[0] === "serve" || argv[0] === "shot" || argv[0] === "stop") [mode, argv] = [argv[0], argv.slice(1)];
  else if (argv[0] === "record") {
    if (argv[1] !== "start" && argv[1] !== "stop") throw Error("record needs start or stop");
    [mode, argv] = [`record ${argv[1]}`, argv.slice(2)];
  }
  const o = { ...defaults, steps: [] as string[] };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = () => {
      if (argv[i + 1] === undefined) throw Error(`${arg} needs a value`);
      return argv[++i];
    };
    switch (arg) {
      case "--sandbox":
        o.sandbox = value();
        break;
      case "--corgi":
        o.corgi = resolve(value());
        break;
      case "--size": {
        const match = /^(\d+)x(\d+)$/.exec(value());
        if (!match) throw Error("--size needs COLSxROWS");
        o.cols = positive(match[1], arg);
        o.rows = positive(match[2], arg);
        break;
      }
      case "--font-size":
        o.fontSize = positive(value(), arg);
        break;
      case "--wait":
        o.wait = positive(value(), arg);
        break;
      case "--idle":
        o.idle = positive(value(), arg);
        break;
      case "-o":
      case "--out":
        o.out = resolve(value());
        break;
      case "--do":
        o.steps.push(value());
        break;
      case "--session":
        o.session = resolve(value());
        break;
      case "--":
        o.command = argv.slice(i + 1);
        if (!o.command.length) throw Error("-- needs a command");
        i = argv.length;
        break;
      case "-h":
      case "--help":
        console.log(readFileSync(import.meta.path, "utf8").split("*/")[0]);
        process.exit(0);
      default:
        throw Error(`unknown argument ${arg}`);
    }
  }
  if (o.command && o.steps.length) throw Error("--do needs a sandbox");
  if (o.out && video(o.out) && mode === "capture" && !o.steps.length) throw Error("a video records --do steps");
  if (o.out && !video(o.out) && mode === "record start") throw Error("record start needs an .mp4 or .gif path");
  return [mode, o];
}

/** Set by the CLI's signal handlers; waits then throw, so startup cleans up what it started. */
let interrupted: NodeJS.Signals | null = null;
const signalled = Promise.withResolvers<"signal">();

/** Throws on timeouts rather than silently capturing an unready screen. */
export async function until<T>(read: () => T | Promise<T>, seconds = 20): Promise<NonNullable<T>> {
  const end = Date.now() + seconds * 1000;
  do {
    if (interrupted) throw Error(`interrupted by ${interrupted}`);
    const value = await read();
    if (value) return value as NonNullable<T>;
    await Bun.sleep(100);
  } while (Date.now() < end);
  throw Error(`screen did not become ready within ${seconds}s`);
}

function run(command: string[], env: Record<string, string | undefined>, cwd: string, wait: number): string {
  const result = spawnSync(command[0], command.slice(1), { env, cwd, encoding: "utf8", timeout: wait * 1000 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(`${command[0]}: ${result.stderr.trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

/** The window's bounds on its display. */
function geometry(display: string, window: string, wait: number) {
  const env = { ...process.env, DISPLAY: `:${display}` };
  const shell = run(["xdotool", "getwindowgeometry", "--shell", window], env, ROOT, wait);
  const fields = Object.fromEntries(shell.split("\n").map(line => line.split("=")));
  const [w, h, x, y] = ["WIDTH", "HEIGHT", "X", "Y"].map(key => Number(fields[key]));
  if (![w, h].every(n => Number.isFinite(n) && n > 0)) throw Error("Ghostty window has no size");
  return { w, h, x, y };
}

/** The window's pixels once three grabs in a row match. */
async function settledFrame(display: string, window: string, frame: string, wait: number, alive = () => {}) {
  // Wait for layout, hover timers and the renderer before checking stable pixels.
  await Bun.sleep(700);
  // Read actual window bounds; dark/black edge pixels must never be cropped away.
  const { w, h, x, y } = geometry(display, window, wait);
  let previous: Buffer | null = null,
    same = 0;
  await until(() => {
    alive();
    run(
      [
        "ffmpeg",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "x11grab",
        "-draw_mouse",
        "0",
        "-video_size",
        `${w}x${h}`,
        "-i",
        `:${display}+${x},${y}`,
        "-frames:v",
        "1",
        frame,
      ],
      process.env,
      ROOT,
      wait,
    );
    const pixels = readFileSync(frame);
    same = previous?.equals(pixels) ? same + 1 : 0;
    previous = pixels;
    return same >= 2;
  }, wait);
  return previous!;
}

function save(path: string, pixels: Buffer): void {
  mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(path, pixels);
  console.log(resolve(path));
}

function video(path: string): Video | null {
  switch (extname(path).toLowerCase()) {
    case ".mp4":
      return "mp4";
    case ".gif":
      return "gif";
    default:
      return null;
  }
}

function ffmpeg(...args: string[]): void {
  const result = Bun.spawnSync(["ffmpeg", "-hide_banner", "-nostdin", "-y", ...args], { stderr: "pipe" });
  if (!result.success) throw Error(`ffmpeg: ${result.stderr.toString().trim() || `exit ${result.exitCode}`}`);
}

function readJSON<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readRecording(dir: string): RecordingFile | null {
  return readJSON<RecordingFile>(join(dir, "recording.json"));
}

/**
 * Runs fn holding the session's recording lock, so a record command never
 * overwrites or removes files another is still using, such as the take a
 * record stop is encoding. A lock left by a process that died is taken over.
 */
export async function recordingLock<T>(dir: string, fn: () => Promise<T>): Promise<T> {
  const lock = join(dir, "recording.lock");
  const mine = `${lock}.${process.pid}`;
  const owner: Owner = { pid: process.pid, started: startTime(process.pid)! };
  writeFileSync(mine, JSON.stringify(owner));
  try {
    // A hard link appears whole, and only where no lock exists.
    for (;;) {
      try {
        linkSync(mine, lock);
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
      const holder = readJSON<Owner>(lock);
      if (holder && running(holder.pid, holder.started)) throw Error("another record start or stop is still running");
      rmSync(lock, { force: true });
    }
  } finally {
    rmSync(mine, { force: true });
  }
  try {
    return await fn();
  } finally {
    rmSync(lock, { force: true });
  }
}

/** Starts recording a session's window losslessly; returns once frames arrive. */
async function startRecording(dir: string, screen: Screen, out: string, idle: number): Promise<void> {
  await recordingLock(dir, async () => {
    const current = readRecording(dir);
    if (current && running(current.pid, current.started)) throw Error("already recording; run record stop first");
    const { w, h, x, y } = geometry(screen.display, screen.window, screen.wait);
    const [raw, log, progress] = ["recording.mkv", "recording.log", "recording.progress"].map(name => join(dir, name));
    rmSync(progress, { force: true });
    const errors = openSync(log, "w");
    // Not -nostdin: ffmpeg 7.1 ignores SIGINT with it, and stdin is /dev/null anyway.
    // Detached, so a recording started by `record start` outlives that command.
    const recorder = spawn(
      "ffmpeg",
      [
        ...["-hide_banner", "-loglevel", "error", "-y"],
        ...["-f", "x11grab", "-draw_mouse", "1", "-framerate", String(FPS), "-video_size", `${w}x${h}`],
        ...["-i", `:${screen.display}+${x},${y}`],
        ...["-c:v", "libx264rgb", "-preset", "ultrafast", "-qp", "0"],
        ...["-progress", progress, "-stats_period", "0.1", raw],
      ],
      { detached: true, stdio: ["ignore", "ignore", errors] },
    );
    closeSync(errors);
    recorder.on("error", () => {});
    recorder.unref();
    const pid = recorder.pid;
    const started = pid && startTime(pid);
    if (!pid || !started) throw Error(`ffmpeg did not start: ${readFileSync(log, "utf8")}`);
    const file: RecordingFile = { pid, started, out, idle, width: w, height: h, cols: screen.cols, rows: screen.rows };
    writeFileSync(join(dir, "recording.json"), JSON.stringify(file));
    await until(() => {
      if (!running(pid, started)) throw Error(`ffmpeg exited: ${readFileSync(log, "utf8")}`);
      return existsSync(progress) && /^frame=[1-9]/m.test(readFileSync(progress, "utf8"));
    }, screen.wait);
  });
}

/** Stops a session's recording and writes its video. */
async function stopRecording(dir: string, wait: number): Promise<void> {
  await recordingLock(dir, async () => {
    const file = readRecording(dir);
    if (!file) throw Error("not recording; run record start first");
    if (running(file.pid, file.started)) {
      process.kill(file.pid, "SIGINT");
      try {
        await until(() => !running(file.pid, file.started), wait);
      } catch (error) {
        if (interrupted) throw error;
        // A Matroska file reads back without its trailer.
        process.kill(file.pid, "SIGKILL");
      }
    }
    await encode(join(dir, "recording.mkv"), file);
    for (const name of ["recording.json", "recording.mkv", "recording.log", "recording.progress", "palette.png"])
      rmSync(join(dir, name), { force: true });
    console.log(file.out);
  });
}

/** Ends a recording without writing it, when its session closes. */
function abandonRecording(dir: string): void {
  const file = readRecording(dir);
  if (file && running(file.pid, file.started)) process.kill(file.pid, "SIGKILL");
}

/** Each frame scaled to one RGB pixel per terminal cell. */
async function* cellFrames(raw: string, filters: string, cols: number, rows: number): AsyncGenerator<Uint8Array> {
  const decoder = Bun.spawn(
    [
      ...["ffmpeg", "-hide_banner", "-nostdin", "-loglevel", "error", "-i", raw],
      ...["-vf", `${filters},scale=${cols}:${rows}:flags=area,format=rgb24`, "-f", "rawvideo", "-"],
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const size = cols * rows * 3;
  let frame = new Uint8Array(size);
  let filled = 0;
  for await (const chunk of decoder.stdout)
    for (let offset = 0; offset < chunk.length;) {
      const take = Math.min(size - filled, chunk.length - offset);
      frame.set(chunk.subarray(offset, offset + take), filled);
      [filled, offset] = [filled + take, offset + take];
      if (filled < size) break;
      yield frame;
      [frame, filled] = [new Uint8Array(size), 0];
    }
  if ((await decoder.exited) !== 0) throw Error(`ffmpeg: ${(await new Response(decoder.stderr).text()).trim()}`);
}

/** How many RGB cells differ between two frames. */
function differing(a: Uint8Array, b: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 3) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) count++;
  return count;
}

/**
 * The frames where the screen changes: the first, and each where 8 or more
 * cells differ from the change before. Fewer, like a resource meter ticking
 * or the corgi blinking, don't count, though typing adds up. When the last
 * frame differs at all, it is shown for hold frames at the end.
 */
export async function changes(frames: AsyncIterable<Uint8Array> | Iterable<Uint8Array>, hold: number) {
  const found: number[] = [];
  let reference: Uint8Array | null = null;
  let last: Uint8Array | null = null;
  let count = 0;
  for await (const frame of frames) {
    if (!reference || differing(reference, frame) >= 8) {
      reference = frame;
      found.push(count);
    }
    last = frame;
    count++;
  }
  // The end pads hold copies of the last frame; start the final screen there.
  if (last && reference && differing(reference, last)) found.push(Math.max(count - hold, found.at(-1)! + 1));
  return found;
}

/**
 * Frame spans to drop, [from, to) with to null for the end, so no still
 * screen lasts more than hold frames. A pause keeps its last lead frames,
 * where the first keystrokes of a change can show.
 */
export function stills(changes: number[], hold: number, lead: number): [number, number | null][] {
  return changes.flatMap((frame, i): [number, number | null][] => {
    const next = changes[i + 1] ?? null;
    if (next === null) return [[frame + hold, null]];
    return next - frame > hold ? [[frame + hold - lead, next - lead]] : [];
  });
}

/** Encodes a lossless recording, holding its first and last screens and cutting long stills. */
async function encode(raw: string, file: RecordingFile): Promise<void> {
  // Constant frames from 0 let frame numbers stand for times in both passes.
  const base =
    `setpts=PTS-STARTPTS,fps=${FPS},` +
    `tpad=start_mode=clone:start_duration=${file.idle}:stop_mode=clone:stop_duration=${file.idle}`;
  const hold = Math.round(file.idle * FPS);
  const lead = Math.min(FPS / 2, Math.floor(hold / 2));
  const spans = stills(await changes(cellFrames(raw, base, file.cols, file.rows), hold), hold, lead);
  const drop = spans.map(([from, to]) => (to === null ? `gte(n,${from})` : `between(n,${from},${to - 1})`));
  const cut = `${base},select='not(${drop.join("+")})',setpts=N/${FPS}/TB,fps=${FPS}`;
  mkdirSync(dirname(file.out), { recursive: true });
  switch (video(file.out)) {
    case "mp4": {
      // Doubled pixels give each 2x2 chroma sample one color. Past H.264
      // level 5.1's frame size, keep the window's size, padded to even.
      const size =
        file.width * file.height * 4 <= 4096 * 2304
          ? "scale=iw*2:ih*2:flags=neighbor"
          : "pad=ceil(iw/2)*2:ceil(ih/2)*2";
      ffmpeg(
        ...["-loglevel", "error", "-i", raw, "-vf", `${cut},${size},format=yuv420p`],
        ...["-c:v", "libx264", "-preset", "slow", "-crf", "18", "-movflags", "+faststart", "-an", file.out],
      );
      break;
    }
    case "gif": {
      // No dithering: text keeps solid edges.
      const palette = join(dirname(raw), "palette.png");
      ffmpeg("-loglevel", "error", "-i", raw, "-vf", `${cut},palettegen`, palette);
      ffmpeg(
        ...["-loglevel", "error", "-i", raw, "-i", palette],
        ...["-lavfi", `[0:v]${cut}[v];[v][1:v]paletteuse=dither=none:diff_mode=rectangle`, file.out],
      );
      break;
    }
    case null:
      throw Error(`${file.out} is not an .mp4 or .gif`);
  }
}

/** Single-quotes a value for sh. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

interface Session {
  dir: string;
  sandbox: Sandbox | null;
  display: string;
  window: string;
  /** What --do steps and the session's env.sh run with. */
  env: Record<string, string | undefined>;
  driver: Driver;
  terminal: Bun.Subprocess;
  /** Runs --do steps in order. */
  steps(steps: string[]): void;
  close(): Promise<void>;
}

/** Starts a display, the sandbox and Ghostty, and waits for the viewer's first frames. */
async function start(o: Options, prepare?: Recipe["prepare"]): Promise<Session> {
  // Ghostty runs from the sandbox, so a relative GHOSTTY_BIN is resolved here.
  const ghostty = process.env.GHOSTTY_BIN
    ? resolve(process.env.GHOSTTY_BIN)
    : (Bun.which("ghostty") ?? "/snap/bin/ghostty");
  if (!existsSync(ghostty)) throw Error("Ghostty is missing; set GHOSTTY_BIN or install Ghostty");
  for (const tool of ["Xvfb", "xdotool", "ffmpeg"])
    if (!Bun.which(tool)) throw Error(`no ${tool} on PATH; install xvfb, xdotool and ffmpeg`);
  if (!o.command && !existsSync(o.corgi)) throw Error(`no ${o.corgi}; run bun build.ts first`);
  const scratch = mkdtempSync(join(tmpdir(), PREFIX));
  let sandbox: Sandbox | null = null;
  let xvfb: Bun.Subprocess | undefined;
  let terminal: Bun.Subprocess | undefined;
  const log = join(scratch, "ghostty.log");
  const xlog = join(scratch, "xvfb.log");
  const close = async () => {
    abandonRecording(scratch);
    terminal?.kill();
    await terminal?.exited;
    xvfb?.kill();
    await xvfb?.exited;
    await sandbox?.shutdown();
    if (sandbox) rmSync(sandbox.dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  };
  try {
    // Let Xvfb choose and reserve a free display, including concurrent captures.
    const displayFile = join(scratch, "display");
    const width = Math.ceil(o.cols * o.fontSize * 2);
    const height = Math.ceil(o.rows * o.fontSize * 3);
    xvfb = Bun.spawn(
      ["Xvfb", "-displayfd", "1", "-screen", "0", `${width}x${height}x24`, "-dpi", "96", "-nolisten", "tcp"],
      { stdio: ["ignore", Bun.file(displayFile), Bun.file(xlog)] },
    );
    const display = await until(() => {
      if (xvfb!.exitCode !== null) throw Error(`Xvfb exited: ${readFileSync(xlog, "utf8")}`);
      return readFileSync(displayFile, "utf8").trim();
    }, o.wait);
    if (!o.command) {
      const { Sandbox } = await import("./sandbox");
      if (!/^[a-z0-9_-]+$/.test(o.sandbox)) throw Error("invalid sandbox name");
      const { world } = (await import(join(ROOT, "tools/sandboxes", `${o.sandbox}.ts`))) as { world: World };
      // A unique sandbox name also isolates its socket from any interactive sandbox.
      const nested = process.env.CORGI_PANE;
      delete process.env.CORGI_PANE;
      try {
        sandbox = new Sandbox(basename(scratch), world, ROOT, o.corgi);
      } finally {
        if (nested !== undefined) process.env.CORGI_PANE = nested;
      }
      // The daemon and its panes open windows on the capture display, never the caller's desktop.
      sandbox.env.DISPLAY = `:${display}`;
      delete sandbox.env.WAYLAND_DISPLAY;
      sandbox.prepareHome();
      world.seed(sandbox);
      sandbox.dated(null);
      writeFileSync(
        join(sandbox.home, ".local/state/corgi/viewer.json"),
        JSON.stringify({ onboarding_complete: true }),
      );
      sandbox.settings({ preset: "corgi", prefix: "ctrl+b", corgi_intensity: 0 });
      sandbox.run([o.corgi, "start", "--update-routed"]);
      await world.arrange(sandbox);
      await prepare?.(sandbox);
    }
    mkdirSync(join(scratch, "runtime"), { mode: 0o700 });
    const env: Record<string, string | undefined> = {
      ...(sandbox?.env ?? process.env),
      WAYLAND_DISPLAY: undefined,
      DISPLAY: `:${display}`,
      GDK_BACKEND: "x11",
      XDG_RUNTIME_DIR: join(scratch, "runtime"),
      LIBGL_ALWAYS_SOFTWARE: "1",
    };
    const cwd = sandbox?.dir ?? ROOT;
    terminal = Bun.spawn(
      [
        ghostty,
        "--config-default-files=false",
        "--gtk-single-instance=false",
        "--window-decoration=none",
        "--window-padding-x=0",
        "--window-padding-y=0",
        "--cursor-style-blink=false",
        "--shell-integration=none",
        `--font-size=${o.fontSize}`,
        `--window-width=${o.cols}`,
        `--window-height=${o.rows}`,
        "-e",
        ...(o.command ?? [o.corgi, "dev"]),
      ],
      { env, cwd, stdio: ["ignore", Bun.file(log), Bun.file(log)] },
    );
    const alive = () => {
      if (terminal!.exitCode !== null) throw Error(`Ghostty exited: ${readFileSync(log, "utf8")}`);
      const diagnostics = readFileSync(log, "utf8");
      if (diagnostics.includes("surface failed to initialize")) throw Error(`Ghostty could not draw: ${diagnostics}`);
    };
    const window = await until(() => {
      alive();
      const found = spawnSync("xdotool", ["search", "--onlyvisible", "--class", "ghostty"], { env, encoding: "utf8" });
      return found.stdout.trim().split("\n").find(Boolean);
    }, o.wait);
    run(["xdotool", "windowfocus", "--sync", window], env, cwd, o.wait);
    if (sandbox) await until(() => JSON.parse(sandbox!.run([o.corgi, "list", "--json"])).viewers?.length, o.wait);
    const { w, h, x, y } = geometry(display, window, o.wait);
    if (x + w > width || y + h > height) throw Error("Ghostty window does not fit on the capture display");
    const move = (col: number, row: number) => {
      run(
        [
          "xdotool",
          "mousemove",
          "--sync",
          "--window",
          window,
          String(Math.floor(((col - 0.5) * w) / o.cols)),
          String(Math.floor(((row - 0.5) * h) / o.rows)),
        ],
        env,
        cwd,
        o.wait,
      );
    };
    const frame = join(scratch, "frame.png");
    const driver: Driver = {
      sandbox,
      key: (...keys) => {
        run(["xdotool", "key", "--clearmodifiers", "--delay", "100", ...keys], env, cwd, o.wait);
      },
      move,
      click: (col, row) => {
        move(col, row);
        run(["xdotool", "click", "1"], env, cwd, o.wait);
      },
      async settle() {
        await settledFrame(display, window, frame, o.wait, alive);
      },
      async screenshot(path) {
        save(path, await settledFrame(display, window, frame, o.wait, alive));
      },
      async record(path) {
        alive();
        await startRecording(
          scratch,
          { display, window, cols: o.cols, rows: o.rows, wait: o.wait },
          resolve(path),
          o.idle,
        );
        return { stop: () => stopRecording(scratch, o.wait) };
      },
    };
    // An agent drives the sandbox with these, from any shell.
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const exports: Record<string, string> = {
      CORGI_CAPTURE_SESSION: scratch,
      DISPLAY: `:${display}`,
      GHOSTTY_WINDOW: window,
    };
    if (sandbox)
      for (const key of ["HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CORGI_SOCKET", "CORGI_ENV_DIR"])
        exports[key] = sandbox.env[key];
    exports.PATH = `${bin}:${env.PATH}`;
    writeFileSync(
      join(scratch, "env.sh"),
      "unset CORGI_PANE WAYLAND_DISPLAY\n" +
        Object.entries(exports)
          .map(([key, value]) => `export ${key}=${quote(value)}\n`)
          .join(""),
    );
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n. ${quote(join(scratch, "env.sh"))}\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    if (sandbox) script("corgi", `exec ${quote(o.corgi)} "$@"`);
    script("screenshot", `exec ${quote(process.execPath)} ${quote(import.meta.path)} shot "$@"`);
    script("record", `exec ${quote(process.execPath)} ${quote(import.meta.path)} record "$@"`);
    // Mouse tracking and layout are ready only after the viewer's first frames.
    await driver.settle();
    const steps = (steps: string[]) => {
      for (const step of steps) run(["sh", "-c", step], { ...env, ...exports, CORGI_PANE: undefined }, cwd, o.wait);
    };
    return { dir: scratch, sandbox, display, window, env: { ...env, ...exports }, driver, terminal, steps, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function capture(options: Partial<Options> = {}, recipe: Recipe = {}): Promise<void> {
  const o = { ...defaults, ...options };
  const out = o.out ?? "ghostty-screenshot.png";
  const session = await start(o, recipe.prepare);
  try {
    if (!recipe.drive && video(out)) {
      const recording = await session.driver.record(out);
      session.steps(o.steps);
      // The viewer draws a step's last change after the step returns.
      await Bun.sleep(1000);
      await recording.stop();
    } else {
      session.steps(o.steps);
      if (recipe.drive) await recipe.drive(session.driver);
      else await session.driver.screenshot(out);
    }
  } finally {
    await session.close();
  }
}

/** Keeps a session up until SIGINT, SIGTERM or Ghostty exiting. */
async function serve(o: Options): Promise<void> {
  const session = await start(o);
  try {
    session.steps(o.steps);
    if (interrupted) return;
    const file: SessionFile = {
      pid: process.pid,
      started: startTime(process.pid)!,
      display: session.display,
      window: session.window,
      cols: o.cols,
      rows: o.rows,
      wait: o.wait,
    };
    writeFileSync(join(session.dir, "session.json"), JSON.stringify(file));
    const bin = join(session.dir, "bin");
    console.log(
      [
        `session ${session.dir}`,
        ...(session.sandbox ? [`  drive:      ${bin}/corgi action help`] : []),
        `  screenshot: ${bin}/screenshot -o shot.png`,
        `  record:     ${bin}/record start -o demo.mp4, then ${bin}/record stop`,
        `  env:        . ${session.dir}/env.sh   (CORGI_SOCKET, DISPLAY, GHOSTTY_WINDOW, PATH)`,
        `  stop:       bun ${import.meta.path} stop --session ${session.dir}`,
      ].join("\n"),
    );
    if ((await Promise.race([signalled.promise, session.terminal.exited])) !== "signal") throw Error("Ghostty exited");
  } finally {
    await session.close();
  }
}

/** A process's fields from /proc after its command name, starting with its state. */
function procStat(pid: number): string[] | null {
  try {
    // The command name in parentheses may hold spaces; the fields after it don't.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  } catch {
    return null;
  }
}

/** A process's start time, or null when there is no such process. */
function startTime(pid: number): string | null {
  return procStat(pid)?.[19] ?? null;
}

/** Whether the process that started at started is still running and not a zombie. */
function running(pid: number, started: string): boolean {
  const fields = procStat(pid);
  return !!fields && fields[0] !== "Z" && fields[19] === started;
}

/** The session named by --session or $CORGI_CAPTURE_SESSION, else the only one running. */
function findSession(o: Options): [string, SessionFile] {
  const read = (dir: string): SessionFile | null => {
    try {
      const file = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionFile;
      return file.started && startTime(file.pid) === file.started ? file : null;
    } catch {
      return null;
    }
  };
  const named = o.session ?? process.env.CORGI_CAPTURE_SESSION;
  if (named) {
    const file = read(named);
    if (!file) throw Error(`no session running in ${named}`);
    return [named, file];
  }
  const running = readdirSync(tmpdir())
    .filter(name => name.startsWith(PREFIX))
    .map(name => join(tmpdir(), name))
    .flatMap(dir => {
      const file = read(dir);
      return file ? [[dir, file] as [string, SessionFile]] : [];
    });
  if (running.length === 1) return running[0];
  if (!running.length) throw Error("no session running; start one with serve");
  throw Error(`several sessions running; pass --session:\n${running.map(([dir]) => `  ${dir}`).join("\n")}`);
}

async function shot(o: Options): Promise<void> {
  const [dir, file] = findSession(o);
  // Each shot grabs into its own file, so concurrent shots don't share one.
  const frame = join(dir, `frame-${process.pid}.png`);
  try {
    save(o.out ?? "ghostty-screenshot.png", await settledFrame(file.display, file.window, frame, file.wait));
  } finally {
    rmSync(frame, { force: true });
  }
}

async function stop(o: Options): Promise<void> {
  const [dir, file] = findSession(o);
  process.kill(file.pid, "SIGTERM");
  await until(() => !existsSync(dir), file.wait);
}

if (import.meta.main) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      interrupted = signal;
      signalled.resolve("signal");
    });
  try {
    const [mode, o] = parse(process.argv.slice(2));
    switch (mode) {
      case "capture":
        await capture(o);
        break;
      case "serve":
        await serve(o);
        break;
      case "shot":
        await shot(o);
        break;
      case "stop":
        await stop(o);
        break;
      case "record start": {
        const [dir, file] = findSession(o);
        const out = o.out ?? resolve("ghostty-recording.mp4");
        await startRecording(dir, file, out, o.idle);
        break;
      }
      case "record stop": {
        const [dir, file] = findSession(o);
        await stopRecording(dir, file.wait);
        break;
      }
    }
  } catch (error) {
    console.error(`ghostty_screenshot: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
