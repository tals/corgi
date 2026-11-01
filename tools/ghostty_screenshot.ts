/**
 * Captures a live Ghostty window on a private Xvfb display, including Kitty images.
 *
 *   bun tools/ghostty_screenshot.ts --sandbox review -o review.png
 *   bun tools/ghostty_screenshot.ts --do 'corgi action help' -o help.png
 *   bun tools/ghostty_screenshot.ts -- /bin/sh -c 'printf "hello\\n"; sleep 30'
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
 *
 * Needs Ghostty, Xvfb, xdotool and ffmpeg on PATH. GHOSTTY_BIN selects Ghostty.
 * Each run owns a disposable sandbox, display and terminal. No personal config
 * is loaded. Captures use the window's exact bounds, with no scaling or repainting.
 * --do receives DISPLAY and GHOSTTY_WINDOW for xdotool, and corgi on PATH.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { Sandbox, type World } from "./sandbox";

const ROOT = resolve(import.meta.dir, "..");

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
};

function positive(value: string, flag: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw Error(`${flag} needs a positive number`);
  return n;
}

function parse(argv: string[]): Options {
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
  return o;
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

export async function capture(options: Partial<Options> = {}, recipe: Recipe = {}): Promise<void> {
  const o = { ...defaults, ...options };
  // Ghostty runs from the sandbox, so a relative GHOSTTY_BIN is resolved here.
  const ghostty = process.env.GHOSTTY_BIN
    ? resolve(process.env.GHOSTTY_BIN)
    : (Bun.which("ghostty") ?? "/snap/bin/ghostty");
  if (!existsSync(ghostty)) throw Error("Ghostty is missing; set GHOSTTY_BIN or install Ghostty");
  for (const tool of ["Xvfb", "xdotool", "ffmpeg"])
    if (!Bun.which(tool)) throw Error(`no ${tool} on PATH; install xvfb, xdotool and ffmpeg`);
  if (!o.command && !existsSync(o.corgi)) throw Error(`no ${o.corgi}; run bun build.ts first`);
  const scratch = mkdtempSync(join(tmpdir(), "corgi-ghostty-"));
  let sandbox: Sandbox | null = null;
  let xvfb: Bun.Subprocess | undefined;
  let terminal: Bun.Subprocess | undefined;
  const log = join(scratch, "ghostty.log");
  const xlog = join(scratch, "xvfb.log");
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
      await recipe.prepare?.(sandbox);
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
    const run = (command: string[], extra: Record<string, string> = {}): string => {
      const result = spawnSync(command[0], command.slice(1), {
        env: { ...env, ...extra },
        cwd,
        encoding: "utf8",
        timeout: o.wait * 1000,
      });
      if (result.error) throw result.error;
      if (result.status !== 0) throw Error(`${command[0]}: ${result.stderr.trim() || `exit ${result.status}`}`);
      return result.stdout.trim();
    };
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
    run(["xdotool", "windowfocus", "--sync", window]);
    if (sandbox) await until(() => JSON.parse(sandbox!.run([o.corgi, "list", "--json"])).viewers?.length, o.wait);
    // Read actual window bounds; dark/black edge pixels must never be cropped away.
    const geometry = Object.fromEntries(
      run(["xdotool", "getwindowgeometry", "--shell", window])
        .split("\n")
        .map(line => line.split("=")),
    );
    const [w, h, x, y] = ["WIDTH", "HEIGHT", "X", "Y"].map(key => Number(geometry[key]));
    if (![w, h].every(n => Number.isFinite(n) && n > 0) || x + w > width || y + h > height)
      throw Error("Ghostty window does not fit on the capture display");
    const move = (col: number, row: number) => {
      run([
        "xdotool",
        "mousemove",
        "--sync",
        "--window",
        window,
        String(Math.floor(((col - 0.5) * w) / o.cols)),
        String(Math.floor(((row - 0.5) * h) / o.rows)),
      ]);
    };
    const settled = async (): Promise<Buffer> => {
      // Wait for layout, hover timers and the renderer before checking stable pixels.
      await Bun.sleep(700);
      const frame = join(scratch, "frame.png");
      let previous: Buffer | null = null,
        same = 0;
      await until(() => {
        alive();
        run([
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
        ]);
        const pixels = readFileSync(frame);
        same = previous?.equals(pixels) ? same + 1 : 0;
        previous = pixels;
        return same >= 2;
      }, o.wait);
      return previous!;
    };
    const driver: Driver = {
      sandbox,
      key: (...keys) => {
        run(["xdotool", "key", "--clearmodifiers", "--delay", "100", ...keys]);
      },
      move,
      click: (col, row) => {
        move(col, row);
        run(["xdotool", "click", "1"]);
      },
      async settle() {
        await settled();
      },
      async screenshot(path) {
        const pixels = await settled();
        mkdirSync(dirname(resolve(path)), { recursive: true });
        writeFileSync(path, pixels);
        console.log(resolve(path));
      },
    };
    const bin = join(scratch, "bin");
    mkdirSync(bin);
    symlinkSync(o.corgi, join(bin, "corgi"));
    // Mouse tracking and layout are ready only after the viewer's first frames.
    await driver.settle();
    for (const step of o.steps) run(["sh", "-c", step], { PATH: `${bin}:${env.PATH}`, GHOSTTY_WINDOW: window });
    if (recipe.drive) await recipe.drive(driver);
    else await driver.screenshot(o.out);
  } finally {
    terminal?.kill();
    await terminal?.exited;
    xvfb?.kill();
    await xvfb?.exited;
    sandbox?.shutdown();
    if (sandbox) rmSync(sandbox.dir, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    await capture(parse(process.argv.slice(2)));
  } catch (error) {
    console.error(`ghostty_screenshot: ${(error as Error).message}`);
    process.exitCode = 1;
  }
}
