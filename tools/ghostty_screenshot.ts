/**
 * Captures a live Ghostty window on a private Xvfb display, including Kitty images.
 *
 *   bun tools/ghostty_screenshot.ts --sandbox review -o review.png
 *   bun tools/ghostty_screenshot.ts --do 'action help' -o help.png
 *   bun tools/ghostty_screenshot.ts --do 'action help; wait 1000; key down down' -o help.mp4
 *   bun tools/ghostty_screenshot.ts -- /bin/sh -c 'printf "hello\\n"; sleep 30'
 *
 * A session keeps the sandbox running for an agent to drive, a script at a time:
 *
 *   bun tools/ghostty_screenshot.ts serve --sandbox review   prints its folder; runs until stopped
 *   bun tools/ghostty_screenshot.ts drive 'action review; clicktext Files; shot review.png'
 *   bun tools/ghostty_screenshot.ts drive 'record start demo.mp4; key esc; wait 1000; record stop'
 *   bun tools/ghostty_screenshot.ts stop
 *
 * A script is tools/ui_driver.ts's commands, separated by ; (key ctrl+b c,
 * type, click, move, scroll, drag, paste, clicktext, hovertext, waittext,
 * settle, wait), plus:
 *   action NAME …            corgi action NAME in the sandbox
 *   corgi ARG …              the sandbox's corgi CLI
 *   shot PATH                a screenshot once the screen holds still
 *   record start PATH        a video, .mp4 or .gif, of everything until
 *   record stop              which writes it; record start PATH xcursor also
 *                            writes PATH's .xcursor twin with X's own cursor
 * Code drives with capture(options, { drive }) or attach(), and driver.drive(script).
 *
 * Options:
 *   --sandbox NAME   world from tools/sandboxes; default launcher
 *   --corgi PATH     compiled binary; default dist/corgi
 *   --size COLSxROWS terminal cells; default 120x36
 *   --font-size N    Ghostty font size in points; default 16
 *   --wait S         deadline for startup and each capture; default 20
 *   -o, --out PATH   .png, or .mp4 or .gif for a video of the --do script; default ghostty-screenshot.png
 *   --idle S         a video's hold at each end, and the most kept between scripts; default 1
 *   --do SCRIPT      run after the viewer attaches; repeatable
 *   -- COMMAND ...   run a command instead of a sandbox; keep it alive to capture
 *   --session DIR    for drive and stop: the session; default $CORGI_CAPTURE_SESSION
 *                    or the only one running
 *
 * Needs Ghostty, Xvfb, ffmpeg and the X libraries libXtst and libXfixes. GHOSTTY_BIN
 * selects Ghostty. Each run owns a disposable sandbox, display and terminal. No
 * personal config is loaded. Screenshots use the window's exact bounds, with no
 * scaling or repainting. Ghostty runs tools/ghostty_relay.ts in front of the
 * viewer, and scripts reach it over HTTP on $SESSION/session.sock: keys arrive
 * as terminal bytes, and the mouse moves through X like a hand, so Ghostty
 * sees every step and reports it to the viewer itself.
 *
 * Videos keep the time each script runs, cut the time between scripts down
 * to --idle seconds, and hold the first and last screens that long. The
 * pointer is drawn where it went, in the shape X showed (arrow, hand, I-beam,
 * resize or move): it grows while it moves, and a press leaves a fading ring.
 * MP4s are H.264 at 60 frames a second with the screen's pixels doubled, so
 * 4:2:0 chroma can't smear colored text; GIFs keep the window's size.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import type { Sandbox, World } from "./sandbox";
import * as video from "./ghostty_video";
import * as x11 from "./x11";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "corgi-ghostty-";

type Mode = "capture" | "serve" | "drive" | "stop";

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
  /** drive's script, from its arguments. */
  script: string[];
}

export interface Driver {
  /** The sandbox, when this process started it. */
  sandbox: Sandbox | null;
  /** Runs a script; returns what it wrote, such as screenshot paths. */
  drive(script: string): Promise<string[]>;
}

interface Recipe {
  prepare?(sandbox: Sandbox): Promise<void>;
  drive?(driver: Driver): Promise<void>;
}

/** What a session leaves in session.json: its window for the relay, its process for stop. */
interface SessionFile extends video.Screen {
  pid: number;
  /** The process's start time, so a reused PID is not taken for the session. */
  started: string;
}

const defaults: Options = {
  sandbox: "launcher",
  corgi: join(ROOT, "dist/corgi"),
  cols: 120,
  rows: 36,
  fontSize: 16,
  wait: 20,
  out: null,
  idle: 1,
  command: null,
  steps: [],
  session: null,
  script: [],
};

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error(`${flag} needs a positive number`);
  return n;
}

function parse(argv: string[]): [Mode, Options] {
  let mode: Mode = "capture";
  if (argv[0] === "serve" || argv[0] === "drive" || argv[0] === "stop") [mode, argv] = [argv[0], argv.slice(1)];
  const o = { ...defaults, steps: [] as string[], script: [] as string[] };
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
        if (mode !== "drive" || arg.startsWith("-")) throw Error(`unknown argument ${arg}`);
        o.script.push(arg);
    }
  }
  if (mode === "drive" && !o.script.length) throw Error("drive needs a script, such as 'action help; shot help.png'");
  if (o.out && video.video(o.out) && mode === "capture" && !o.steps.length) throw Error("a video records --do steps");
  return [mode, o];
}

/**
 * Set by the CLI's signal handlers: waits throw, and a script the process is
 * waiting on is let go, so it cleans up what it started.
 */
let interrupted: NodeJS.Signals | null = null;
const signalled = Promise.withResolvers<"signal">();
const released = new AbortController();

function until<T>(read: () => T | Promise<T>, seconds = 20): Promise<NonNullable<T>> {
  return video.until(() => {
    if (interrupted) throw Error(`interrupted by ${interrupted}`);
    return read();
  }, seconds);
}

/** Single-quotes a value for sh. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Double-quotes a value for a script. */
function word(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

/** A script's error, with what it wrote before failing. */
export class DriveError extends Error {
  constructor(
    message: string,
    readonly output: string[],
  ) {
    super(message);
  }
}

/** Runs a script in a session's relay. */
export async function drive(dir: string, script: string): Promise<string[]> {
  const response = await fetch("http://relay/drive", {
    method: "POST",
    unix: join(dir, "session.sock"),
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ script, cwd: process.cwd() }),
    // Scripts can wait, record and encode for minutes.
    timeout: false,
    signal: released.signal,
  }).catch(error => {
    throw interrupted ? Error(`interrupted by ${interrupted}`) : error;
  });
  const reply = (await response.json()) as { output?: string[]; error?: string };
  if (!response.ok) throw new DriveError(reply.error ?? `the relay answered ${response.status}`, reply.output ?? []);
  return reply.output ?? [];
}

/** A driver for a running session: session's, $CORGI_CAPTURE_SESSION's, or the only one. */
export function attach(session: string | null = null): Driver {
  const [dir] = findSession(session);
  return { sandbox: null, drive: script => drive(dir, script) };
}

interface Session {
  dir: string;
  sandbox: Sandbox | null;
  driver: Driver;
  terminal: Bun.Subprocess;
  close(): Promise<void>;
}

/** Starts a display, the sandbox and Ghostty with the relay, and waits for the viewer's first frames. */
async function start(o: Options, prepare?: Recipe["prepare"]): Promise<Session> {
  // Ghostty runs from the sandbox, so a relative GHOSTTY_BIN is resolved here.
  const ghostty = process.env.GHOSTTY_BIN
    ? resolve(process.env.GHOSTTY_BIN)
    : (Bun.which("ghostty") ?? "/snap/bin/ghostty");
  if (!existsSync(ghostty)) throw Error("Ghostty is missing; set GHOSTTY_BIN or install Ghostty");
  for (const tool of ["Xvfb", "ffmpeg", "ffprobe"])
    if (!Bun.which(tool)) throw Error(`no ${tool} on PATH; install xvfb and ffmpeg`);
  if (!o.command && !existsSync(o.corgi)) throw Error(`no ${o.corgi}; run bun build.ts first`);
  const scratch = mkdtempSync(join(tmpdir(), PREFIX));
  let sandbox: Sandbox | null = null;
  let xvfb: Bun.Subprocess | undefined;
  let terminal: Bun.Subprocess | undefined;
  const log = join(scratch, "ghostty.log");
  const xlog = join(scratch, "xvfb.log");
  // Closing Ghostty hangs up on the relay, which ends a recording and its command.
  const close = async () => {
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
      CORGI_PANE: undefined,
      DISPLAY: `:${display}`,
      GDK_BACKEND: "x11",
      XDG_RUNTIME_DIR: join(scratch, "runtime"),
      LIBGL_ALWAYS_SOFTWARE: "1",
      // For the relay: its session, and the corgi that action and corgi run.
      CORGI_CAPTURE_SESSION: scratch,
      CORGI_CAPTURE_CORGI: sandbox ? o.corgi : undefined,
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
        ...[process.execPath, join(ROOT, "tools/ghostty_relay.ts"), scratch, "--"],
        ...(o.command ?? [o.corgi, "dev"]),
      ],
      { env, cwd, stdio: ["ignore", Bun.file(log), Bun.file(log)] },
    );
    const alive = () => {
      if (terminal!.exitCode !== null) throw Error(`Ghostty exited: ${readFileSync(log, "utf8")}`);
      const diagnostics = readFileSync(log, "utf8");
      if (diagnostics.includes("surface failed to initialize")) throw Error(`Ghostty could not draw: ${diagnostics}`);
    };
    const x = new x11.Display(display);
    let window: x11.Window;
    try {
      const shown = await until(() => {
        alive();
        return x.topWindow();
      }, o.wait);
      x.focus(shown.id);
      if (sandbox) await until(() => JSON.parse(sandbox!.run([o.corgi, "list", "--json"])).viewers?.length, o.wait);
      // Its bounds once the viewer has attached; dark edge pixels must never be cropped away.
      window = x.topWindow() ?? shown;
    } finally {
      x.close();
    }
    if (window.x + window.width > width || window.y + window.height > height)
      throw Error("Ghostty window does not fit on the capture display");
    const file: SessionFile = {
      pid: process.pid,
      started: startTime(process.pid)!,
      display,
      x: window.x,
      y: window.y,
      width: window.width,
      height: window.height,
      cols: o.cols,
      rows: o.rows,
      wait: o.wait,
      idle: o.idle,
    };
    writeFileSync(join(scratch, "session.json"), JSON.stringify(file));
    await until(() => {
      alive();
      return existsSync(join(scratch, "session.sock"));
    }, o.wait);
    // For an agent's shell: the sandbox's corgi, and this session's drive.
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    const exports: Record<string, string> = { CORGI_CAPTURE_SESSION: scratch };
    if (sandbox)
      for (const key of ["HOME", "XDG_STATE_HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "CORGI_SOCKET", "CORGI_ENV_DIR"])
        exports[key] = sandbox.env[key];
    exports.PATH = `${bin}:${process.env.PATH}`;
    writeFileSync(
      join(scratch, "env.sh"),
      "unset CORGI_PANE\n" +
        Object.entries(exports)
          .map(([key, value]) => `export ${key}=${quote(value)}\n`)
          .join(""),
    );
    const script = (name: string, body: string) => {
      writeFileSync(join(bin, name), `#!/bin/sh\n. ${quote(join(scratch, "env.sh"))}\n${body}\n`);
      chmodSync(join(bin, name), 0o755);
    };
    if (sandbox) script("corgi", `exec ${quote(o.corgi)} "$@"`);
    script(
      "drive",
      `exec ${quote(process.execPath)} ${quote(import.meta.path)} drive --session ${quote(scratch)} "$@"`,
    );
    // Mouse tracking and layout are ready only after the viewer's first frames.
    await video.settled(file, join(scratch, "frame.png"), alive);
    const driver: Driver = { sandbox, drive: script => drive(scratch, script) };
    return { dir: scratch, sandbox, driver, terminal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function capture(options: Partial<Options> = {}, recipe: Recipe = {}): Promise<void> {
  const o = { ...defaults, ...options };
  const session = await start(o, recipe.prepare);
  try {
    if (recipe.drive) return await recipe.drive(session.driver);
    const out = o.out ?? "ghostty-screenshot.png";
    const steps = o.steps.join("; ");
    // The viewer draws a step's last change after the step returns.
    const script = video.video(out)
      ? `record start ${word(out)}; ${steps}; wait 1000; record stop`
      : `${steps}; shot ${word(out)}`;
    for (const line of await session.driver.drive(script)) console.log(line);
  } finally {
    await session.close();
  }
}

/** Keeps a session up until SIGINT, SIGTERM or Ghostty exiting. */
async function serve(o: Options): Promise<void> {
  const session = await start(o);
  try {
    if (o.steps.length) for (const line of await session.driver.drive(o.steps.join("; "))) console.log(line);
    if (interrupted) return;
    const bin = join(session.dir, "bin");
    console.log(
      [
        `session ${session.dir}`,
        `  drive:  ${bin}/drive 'action help; shot help.png'`,
        `  record: ${bin}/drive 'record start demo.mp4; key esc; wait 1000; record stop'`,
        ...(session.sandbox ? [`  corgi:  ${bin}/corgi list   (. ${session.dir}/env.sh for the sandbox's)`] : []),
        `  stop:   bun ${import.meta.path} stop --session ${session.dir}`,
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

/** The session named, or $CORGI_CAPTURE_SESSION's, else the only one running. */
function findSession(named: string | null): [string, SessionFile] {
  const read = (dir: string): SessionFile | null => {
    try {
      const file = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionFile;
      return file.started && startTime(file.pid) === file.started ? file : null;
    } catch {
      return null;
    }
  };
  named ??= process.env.CORGI_CAPTURE_SESSION ?? null;
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

async function stop(o: Options): Promise<void> {
  const [dir, file] = findSession(o.session);
  process.kill(file.pid, "SIGTERM");
  await until(() => !existsSync(dir), file.wait);
}

if (import.meta.main) {
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.on(signal, () => {
      interrupted = signal;
      signalled.resolve("signal");
      released.abort();
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
      case "drive": {
        const [dir] = findSession(o.session);
        for (const line of await drive(dir, o.script.join("; "))) console.log(line);
        break;
      }
      case "stop":
        await stop(o);
        break;
    }
  } catch (error) {
    if (error instanceof DriveError) for (const line of error.output) console.log(line);
    console.error(`ghostty_screenshot: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
