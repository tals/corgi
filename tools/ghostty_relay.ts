/**
 * Runs inside a capture's Ghostty, in front of its command: gives the command
 * a PTY of its own, passes everything through both ways and keeps a copy of
 * the screen. On the session's socket it serves HTTP for driving it: keys
 * reach the command as terminal bytes, and the mouse moves through X with
 * XTEST, so Ghostty sees it as it would a hand's:
 *
 *   ghostty -e bun tools/ghostty_relay.ts SESSION -- corgi dev
 *
 *   POST /drive  {"script": "action help; shot help.png", "cwd": "/abs"}
 *                200 {"output": [...]}, or 422 {"output": [...], "error": "..."}
 *   GET /screen  {"lines": [...]}
 *
 * A script is ui_driver commands, plus action, corgi, shot and record (see
 * ghostty_screenshot.ts). Scripts run one at a time, in the order they arrive.
 */
import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Terminal } from "../src/pane/terminal";
import * as terminal_info from "../src/terminal_info";
import * as video from "./ghostty_video";
import { Driver, parseScript } from "./ui_driver";
import * as x11 from "./x11";

class Relay extends Driver {
  screen: Terminal;
  pty: Bun.Terminal;
  pointer: video.PointerEvent[] = [];
  /** The cursor's names over time; kept while recording. */
  shapes: video.ShapeEvent[] = [];
  private watching: Timer | null = null;
  recording: video.Recording | null = null;
  /** When the recording began, once record start returned. */
  private recordingFrom = 0;
  /** When scripts ran, and when the running one began; a video keeps their time. */
  private scripts: video.Span[] = [];
  private running = 0;
  /** Where the pointer is on the display, once a script has moved it. */
  private at: [number, number] | null = null;
  private screenFile: video.Screen | null = null;
  private display: x11.Display | null = null;
  /** What the running script wrote, and where its paths start from. */
  output: string[] = [];
  cwd = "/";
  constructor(
    readonly dir: string,
    cols: number,
    rows: number,
  ) {
    super();
    this.screen = new Terminal(cols, rows);
    this.pty = new Bun.Terminal({
      cols,
      rows,
      data: (_terminal, data) => {
        this.lastData = Date.now();
        process.stdout.write(data);
        this.screen.feed(data);
      },
    });
  }
  protected send(data: string) {
    this.pty.write(data);
  }
  resize(cols: number, rows: number) {
    this.pty.resize(cols, rows);
    this.screen.resize(cols, rows);
  }
  /** Where the window is, which the capture writes once it has found it. */
  private where(): video.Screen {
    return (this.screenFile ??= JSON.parse(readFileSync(join(this.dir, "session.json"), "utf8")) as video.Screen);
  }
  private x(): x11.Display {
    return (this.display ??= new x11.Display(this.where().display));
  }
  private log(press: boolean) {
    const s = this.where();
    this.pointer.push({ t: Date.now(), x: this.at![0] - s.x, y: this.at![1] - s.y, press });
  }
  /** Moves the pointer to a cell's middle as a hand would, so Ghostty sees each step on the way. */
  private async glide(col: number, row: number) {
    const s = this.where();
    const to: [number, number] = [s.x + ((col - 0.5) * s.width) / s.cols, s.y + ((row - 0.5) * s.height) / s.rows];
    const path: [number, number, number][] = this.at ? video.glide(this.at, to) : [[0, ...to]];
    const begin = Date.now();
    for (const [ms, x, y] of path) {
      await Bun.sleep(Math.max(0, begin + ms - Date.now()));
      this.x().move(x, y);
      this.lastInput = Date.now();
      this.at = [x, y];
      this.log(false);
    }
  }
  private press(button: number, down: boolean) {
    this.x().button(button, down);
    this.lastInput = Date.now();
    // The wheel's buttons don't show a press.
    if (down && button <= 3) this.log(true);
  }
  private async tap(button: number) {
    this.press(button, true);
    await Bun.sleep(30);
    this.press(button, false);
  }
  /** ui_driver's mouse commands, played with the real pointer. */
  private async play(op: string, args: string[]) {
    const nth = args[1] ? +args[1] : 1;
    switch (op) {
      case "move":
        return this.glide(+args[0], +args[1]);
      case "click":
        await this.glide(+args[0], +args[1]);
        return this.tap(args[2] === "right" ? 3 : 1);
      case "scroll":
        await this.glide(+args[0], +args[1]);
        return this.tap(args[2] === "up" ? 4 : 5);
      case "hovertext":
        return this.glide(...this.find(args[0], nth));
      case "clicktext":
      case "rclicktext":
        await this.glide(...this.find(args[0], nth));
        return this.tap(op === "rclicktext" ? 3 : 1);
      case "holdclicktext": {
        const ms = Number(args[1]);
        if (!Number.isFinite(ms) || ms <= 0)
          throw new Error("holdclicktext expects text and a positive duration in ms");
        await this.glide(...this.find(args[0]));
        this.press(1, true);
        await Bun.sleep(ms);
        return this.press(1, false);
      }
      case "drag":
      case "dragtext": {
        const [x1, y1, x2, y2] =
          op === "dragtext" ? [...this.find(args[0]), ...this.find(args[1])] : args.slice(0, 4).map(Number);
        await this.glide(x1, y1);
        this.press(1, true);
        await this.glide(x2, y2);
        return this.press(1, false);
      }
    }
  }
  /** Notes the cursor's name whenever it changes, as Ghostty shows it, while recording. */
  private watch(on: boolean) {
    if (this.watching) clearInterval(this.watching);
    this.watching = null;
    if (!on) return;
    const sample = () => {
      const name = this.x().cursor();
      if (this.shapes.at(-1)?.name !== name) this.shapes.push({ t: Date.now(), name });
    };
    sample();
    this.watching = setInterval(sample, 1000 / video.FPS);
  }
  /** Runs the sandbox's corgi; its output goes into the script's unless quiet. */
  private async corgi(args: string[], quiet = false) {
    const binary = process.env.CORGI_CAPTURE_CORGI;
    if (!binary) throw Error("action and corgi need a sandbox");
    const p = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
    const [out, error, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) throw Error(`corgi ${args.join(" ")}: ${error.trim() || `exit ${code}`}`);
    if (!quiet && out.trim()) this.output.push(out.trim());
  }
  async exec(cmd: string[]): Promise<void> {
    const [op, ...args] = cmd;
    switch (op) {
      case "action":
        return this.corgi(["action", ...args], true);
      case "corgi":
        return this.corgi(args);
      case "shot": {
        const path = resolve(this.cwd, args[0] ?? "ghostty-screenshot.png");
        const pixels = await video.settled(this.where(), join(this.dir, "frame.png"));
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, pixels);
        this.output.push(path);
        return;
      }
      case "move":
      case "click":
      case "scroll":
      case "hovertext":
      case "clicktext":
      case "rclicktext":
      case "holdclicktext":
      case "drag":
      case "dragtext":
        return this.play(op, args);
      case "record":
        if (args[0] === "start") {
          if (this.recording) throw Error("already recording; record stop first");
          const out = resolve(this.cwd, args[1] ?? "ghostty-recording.mp4");
          if (!video.video(out)) throw Error("record start needs an .mp4 or .gif path");
          if (args[2] !== undefined && args[2] !== "xcursor") throw Error(`record start takes xcursor, not ${args[2]}`);
          this.shapes = [];
          this.watch(true);
          try {
            this.recording = await video.Recording.start(this.dir, this.where(), out, args[2] === "xcursor");
            this.recordingFrom = Date.now();
          } catch (error) {
            this.watch(false);
            throw error;
          }
        } else if (args[0] === "stop") {
          if (!this.recording) throw Error("not recording; record start first");
          const [recording, from, to] = [this.recording, this.recordingFrom, Date.now()];
          this.recording = null;
          this.watch(false);
          const scripts = [...this.scripts.filter(([, end]) => end >= from), [this.running, to] as video.Span];
          this.output.push(
            ...(await recording.stop({ from, to, scripts, pointer: this.pointer, shapes: this.shapes })),
          );
        } else throw Error("record needs start or stop");
        return;
      default:
        return super.exec(cmd);
    }
  }
  async drive(script: string, cwd: string): Promise<{ output: string[]; error?: string }> {
    [this.output, this.cwd, this.running] = [[], cwd, Date.now()];
    try {
      for (const command of parseScript(script)) await this.exec(command);
      return { output: this.output };
    } catch (error) {
      return { output: this.output, error: (error as Error).message };
    } finally {
      this.scripts.push([this.running, Date.now()]);
    }
  }
}

/** Ghostty's grid, read afresh: Bun's process.stdout.columns stays at its first value. */
function size(): [number, number] {
  const pty = terminal_info.pty();
  return [pty?.cols || 80, pty?.rows || 24];
}

const [dir, separator, ...command] = process.argv.slice(2);
if (!dir || separator !== "--" || !command.length) {
  console.error("usage: ghostty_relay.ts SESSION -- COMMAND ...");
  process.exit(2);
}
// stdout and stderr are the window, so problems go to a log.
const log = (message: string) => appendFileSync(join(dir, "relay.log"), `${new Date().toISOString()} ${message}\n`);
const relay = new Relay(dir, ...size());
const child = Bun.spawn(command, { terminal: relay.pty });
process.stdin.setRawMode(true);
process.stdin.on("data", (data: Buffer) => relay.pty.write(data));
process.on("SIGWINCH", () => {
  relay.resize(...size());
  // Bun's PTY isn't the command's controlling terminal, so the kernel won't tell it.
  child.kill("SIGWINCH");
});

let queue: Promise<unknown> = Promise.resolve();
const socket = join(dir, "session.sock");
rmSync(socket, { force: true });
const server = Bun.serve({
  unix: socket,
  async fetch(request, server) {
    // A script can wait, record and encode for longer than any idle limit.
    server.timeout(request, 0);
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/screen") return Response.json({ lines: relay.text() });
    if (request.method !== "POST" || path !== "/drive") return Response.json({ error: "not found" }, { status: 404 });
    const body = (await request.json().catch(() => null)) as { script?: unknown; cwd?: unknown } | null;
    if (typeof body?.script !== "string") return Response.json({ error: "drive needs a script" }, { status: 400 });
    const cwd = typeof body.cwd === "string" ? body.cwd : "/";
    const run = queue.then(() => relay.drive(body.script as string, cwd));
    queue = run.catch(() => {});
    const result = await run;
    if (result.error) log(`drive ${JSON.stringify(body.script)}: ${result.error}`);
    return Response.json(result, { status: result.error ? 422 : 200 });
  },
});

function quit(code: number): never {
  relay.recording?.abandon();
  server.stop(true);
  rmSync(socket, { force: true });
  try {
    child.kill("SIGHUP");
  } catch {}
  process.exit(code);
}
for (const signal of ["SIGHUP", "SIGTERM", "SIGINT"] as const) process.on(signal, () => quit(1));
child.exited.then(code => quit(code ?? 1));
