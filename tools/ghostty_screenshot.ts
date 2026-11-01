/**
 * Captures a live Ghostty window on a private Xvfb display, including Kitty images.
 *
 *   bun tools/ghostty_screenshot.ts --sandbox review -o review.png
 *   bun tools/ghostty_screenshot.ts --do 'corgi action help' -o help.png
 *   bun tools/ghostty_screenshot.ts -- /bin/sh -c 'printf "hello\\n"; sleep 30'
 *
 * A session keeps the sandbox running for an agent to drive and screenshot:
 *
 *   bun tools/ghostty_screenshot.ts serve --sandbox review   prints its paths; runs until stopped
 *   $SESSION/bin/corgi action help                            the sandbox's corgi, over its socket
 *   $SESSION/bin/screenshot -o help.png                       capture now
 *   bun tools/ghostty_screenshot.ts stop                       end it and clean up
 *
 * Options:
 *   --sandbox NAME   world from tools/sandboxes; default launcher
 *   --corgi PATH     compiled binary; default dist/corgi
 *   --size COLSxROWS terminal cells; default 120x36
 *   --font-size N    Ghostty font size in points; default 16
 *   --wait S         deadline for startup and each capture; default 20
 *   -o, --out PATH   default ghostty-screenshot.png
 *   --do SHELL       run against the sandbox after its viewer attaches; repeatable
 *   -- COMMAND ...   run a command instead of a sandbox; keep it alive to capture
 *   --session DIR    for shot and stop: the session; default $CORGI_CAPTURE_SESSION
 *                    or the only one running
 *
 * Needs Ghostty, Xvfb, xdotool and ffmpeg on PATH. GHOSTTY_BIN selects Ghostty.
 * Each run owns a disposable sandbox, display and terminal. No personal config
 * is loaded. Captures use the window's exact bounds, with no scaling or repainting.
 * --do steps and a session's env.sh get corgi on PATH, CORGI_SOCKET, and
 * DISPLAY and GHOSTTY_WINDOW for xdotool.
 */
import { spawnSync } from "node:child_process";
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
import { basename, dirname, join, resolve } from "node:path";
import { Sandbox, type World } from "./sandbox";

const ROOT = resolve(import.meta.dir, "..");
const PREFIX = "corgi-ghostty-";

type Mode = "capture" | "serve" | "shot" | "stop";

interface Options {
  sandbox: string;
  corgi: string;
  cols: number;
  rows: number;
  fontSize: number;
  wait: number;
  out: string;
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
}

interface Recipe {
  prepare?(sandbox: Sandbox): Promise<void>;
  drive?(driver: Driver): Promise<void>;
}

/** What `serve` leaves in session.json for `shot` and `stop`. */
interface SessionFile {
  pid: number;
  display: string;
  window: string;
  wait: number;
}

const defaults: Options = {
  sandbox: "launcher",
  corgi: join(ROOT, "dist/corgi"),
  cols: 120,
  rows: 36,
  fontSize: 16,
  wait: 20,
  out: "ghostty-screenshot.png",
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
  return [mode, o];
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
    terminal?.kill();
    await terminal?.exited;
    xvfb?.kill();
    await xvfb?.exited;
    sandbox?.shutdown();
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
        JSON.stringify({ onboarding_complete: true, preset: "corgi", prefix: "ctrl_b", corgi_intensity: 0 }),
      );
      sandbox.run([o.corgi, "start", "--update-routed"]);
      world.arrange(sandbox);
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
    // Mouse tracking and layout are ready only after the viewer's first frames.
    await driver.settle();
    for (const step of o.steps) run(["sh", "-c", step], { ...env, ...exports, CORGI_PANE: undefined }, cwd, o.wait);
    return { dir: scratch, sandbox, display, window, env: { ...env, ...exports }, driver, terminal, close };
  } catch (error) {
    await close();
    throw error;
  }
}

export async function capture(options: Partial<Options> = {}, recipe: Recipe = {}): Promise<void> {
  const session = await start({ ...defaults, ...options }, recipe.prepare);
  try {
    if (recipe.drive) await recipe.drive(session.driver);
    else await session.driver.screenshot(options.out ?? defaults.out);
  } finally {
    await session.close();
  }
}

/** Keeps a session up until SIGINT, SIGTERM or Ghostty exiting. */
async function serve(o: Options): Promise<void> {
  const session = await start(o);
  try {
    const file: SessionFile = { pid: process.pid, display: session.display, window: session.window, wait: o.wait };
    writeFileSync(join(session.dir, "session.json"), JSON.stringify(file));
    const bin = join(session.dir, "bin");
    console.log(
      [
        `session ${session.dir}`,
        ...(session.sandbox ? [`  drive:      ${bin}/corgi action help`] : []),
        `  screenshot: ${bin}/screenshot -o shot.png`,
        `  env:        . ${session.dir}/env.sh   (CORGI_SOCKET, DISPLAY, GHOSTTY_WINDOW, PATH)`,
        `  stop:       bun ${import.meta.path} stop --session ${session.dir}`,
      ].join("\n"),
    );
    const { promise: stopped, resolve: stop } = Promise.withResolvers<"signal">();
    for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(signal, () => stop("signal"));
    if ((await Promise.race([stopped, session.terminal.exited])) !== "signal") throw Error("Ghostty exited");
  } finally {
    await session.close();
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The session named by --session or $CORGI_CAPTURE_SESSION, else the only one running. */
function findSession(o: Options): [string, SessionFile] {
  const read = (dir: string): SessionFile | null => {
    try {
      const file = JSON.parse(readFileSync(join(dir, "session.json"), "utf8")) as SessionFile;
      return alive(file.pid) ? file : null;
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
    save(o.out, await settledFrame(file.display, file.window, frame, file.wait));
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
    }
  } catch (error) {
    console.error(`ghostty_screenshot: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
