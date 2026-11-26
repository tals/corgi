/**
 * Runs inside a capture's ghostty-host, in front of its command: gives the
 * command a PTY of its own, passes everything through both ways and keeps a
 * copy of the screen. On the session's socket it serves HTTP for driving it:
 * keys reach the command as terminal bytes, and the mouse goes into Ghostty
 * as its own input, a step at a time, as a hand would move it:
 *
 *   ghostty-host -- bun tools/ghostty_relay.ts SESSION -- corgi dev
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
import * as terminal from "../src/pane/terminal";
import * as terminal_info from "../src/terminal_info";
import * as ghostty_host from "./ghostty_host";
import * as video from "./ghostty_video";
import * as ui_driver from "./ui_driver";

const buttons: Record<1 | 2 | 3, ghostty_host.Button> = { 1: "left", 2: "middle", 3: "right" };

class Relay extends ui_driver.Driver {
  screen: terminal.Terminal;
  pty: Bun.Terminal;
  pointer: video.PointerEvent[] = [];
  /** The pointer's shapes, keys and steps over time; kept while recording. */
  shapes: video.ShapeEvent[] = [];
  keys: video.KeyEvent[] = [];
  opens: video.OpenEvent[] = [];
  steps: video.Step[] = [];
  recording: video.Recording | null = null;
  /** When the recording began, once record start returned. */
  private recordingFrom = 0;
  /** When scripts ran, and when the running one began; a video keeps their time. */
  private scripts: video.Span[] = [];
  private running = 0;
  /** Where the pointer is in the frame, once a script has moved it. */
  private at: [number, number] | null = null;
  /** Where and when a button last went down. */
  private pressed: { t: number; at: [number, number] } | null = null;
  /** Ends watching the pointer's shape, while recording. */
  private unwatch: (() => Promise<void>) | null = null;
  /** The cell the running text command found. */
  private found: [number, number] | undefined;
  private screenFile: video.Screen | null = null;
  private hostClient: ghostty_host.Host | null = null;
  /** What the running script wrote, and where its paths start from. */
  output: string[] = [];
  cwd = "/";
  constructor(
    readonly dir: string,
    cols: number,
    rows: number,
  ) {
    super();
    this.screen = new terminal.Terminal(cols, rows);
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
  /** The terminal's geometry and socket, which the capture writes once the host is up. */
  private where(): video.Screen {
    return (this.screenFile ??= JSON.parse(readFileSync(join(this.dir, "session.json"), "utf8")) as video.Screen);
  }
  private host(): ghostty_host.Host {
    return (this.hostClient ??= new ghostty_host.Host(this.where().socket));
  }
  private log(t: number, event: Omit<video.PointerEvent, "t" | "x" | "y">) {
    this.pointer.push({ t, x: this.at![0], y: this.at![1], ...event });
  }
  /** Moves the pointer to a cell's middle as a hand would, so Ghostty sees each step on the way. */
  private async glide(col: number, row: number) {
    const to = video.cellCenter(this.where(), col, row);
    const path: [number, number, number][] = this.at ? video.glide(this.at, to) : [[0, ...to]];
    const begin = Date.now();
    for (const [ms, x, y] of path) {
      await Bun.sleep(Math.max(0, begin + ms - Date.now()));
      await this.place(x, y);
    }
  }
  /** Puts the pointer at (x, y) in the frame in one step. */
  private async place(x: number, y: number) {
    await this.host().mouse({ action: "move", x, y });
    this.lastInput = Date.now();
    this.at = [x, y];
    this.log(this.lastInput, { action: "move" });
  }
  private async press(button: 1 | 2 | 3, down: boolean) {
    const action = down ? "press" : "release";
    await this.host().mouse({ action, button: buttons[button] });
    this.lastInput = Date.now();
    if (down) this.pressed = { t: this.lastInput, at: this.at! };
    this.log(this.lastInput, { action, button: buttons[button] });
  }
  private async tap(button: 1 | 3) {
    await this.press(button, true);
    await Bun.sleep(30);
    await this.press(button, false);
  }
  private async wheel(up: boolean) {
    const dy = up ? 1 : -1;
    await this.host().mouse({ action: "scroll", dy });
    this.lastInput = Date.now();
    this.log(this.lastInput, { action: "scroll", dy });
  }
  /** Finds text on screen, noting its cell for the step's timeline entry. */
  private target(text: string, nth = 1): [number, number] {
    return (this.found = this.find(text, nth));
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
        return this.wheel(args[2] === "up");
      case "hovertext":
        return this.glide(...this.target(args[0], nth));
      case "clicktext":
      case "rclicktext":
        await this.glide(...this.target(args[0], nth));
        return this.tap(op === "rclicktext" ? 3 : 1);
      case "holdclicktext": {
        const ms = Number(args[1]);
        if (!Number.isFinite(ms) || ms <= 0)
          throw new Error("holdclicktext expects text and a positive duration in ms");
        await this.glide(...this.target(args[0]));
        await this.press(1, true);
        await Bun.sleep(ms);
        return this.press(1, false);
      }
      case "drag":
      case "dragtext": {
        const [x1, y1, x2, y2] =
          op === "dragtext" ? [...this.target(args[0]), ...this.find(args[1])] : args.slice(0, 4).map(Number);
        await this.glide(x1, y1);
        await this.press(1, true);
        await this.glide(x2, y2);
        return this.press(1, false);
      }
    }
  }
  /** Notes each pointer shape Ghostty asks for, with when it asked, until stopped. */
  private watch() {
    const host = this.host();
    let on = true;
    const done = (async () => {
      // As of when it was asked: a change after that comes with a later time.
      const asked = Date.now();
      const now = await host.shapes(0, 0);
      this.shapes.push({ t: asked, name: now.shape });
      let seq = now.seq;
      while (on) {
        const reply = await host.shapes(seq, 200);
        for (const change of reply.changes) if (change.seq > seq) this.shapes.push({ t: change.t, name: change.shape });
        seq = Math.max(seq, reply.seq);
      }
      // A host gone mid-recording ends the watch; the recording reports it.
    })().catch(() => {});
    return async () => {
      on = false;
      await done;
    };
  }
  /** Runs the sandbox's corgi; its output goes into the script's unless quiet. */
  private async corgi(args: string[], quiet = false) {
    const binary = process.env.CORGI_CAPTURE_CORGI;
    if (!binary) throw Error("action and corgi need a sandbox");
    const wait = this.where().wait;
    const p = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe", timeout: wait * 1000 });
    const [out, error, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (p.signalCode === "SIGTERM") throw Error(`corgi ${args.join(" ")} took more than ${wait}s`);
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
        const pixels = await video.settled(this.where());
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, pixels);
        this.output.push(path);
        return;
      }
      case "key":
        for (const key of args) {
          if (this.recording) this.keys.push({ t: Date.now(), kind: "key", value: key });
          await super.exec(["key", key]);
        }
        return;
      case "type":
      case "paste":
        if (this.recording) this.keys.push({ t: Date.now(), kind: op, value: args.join(" ") });
        return super.exec(cmd);
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
        return this.record(args);
      default:
        return super.exec(cmd);
    }
  }
  /** record start PATH [FPS], or record stop. */
  private async record(args: string[]) {
    if (args[0] === "start") {
      if (this.recording) throw Error("already recording; record stop first");
      const out = resolve(this.cwd, args[1] ?? "ghostty-recording.mp4");
      if (!video.video(out)) throw Error("record start needs an .mp4 or .gif path");
      const fps = args[2] === undefined ? this.where().fps : Number(args[2]);
      if (!Number.isInteger(fps) || fps < 1 || fps > 120)
        throw Error(`record start takes frames a second, not ${args[2]}`);
      // A pointer that hasn't moved is drawn resting in the middle, as a
      // desktop's does, so the video shows it from the first frame and its
      // first glide. Ghostty sees it only once it moves, so it hovers nothing.
      if (!this.at) {
        this.at = [Math.round(this.where().width / 2), Math.round(this.where().height / 2)];
        this.log(Date.now(), { action: "move" });
      }
      // Where the pointer rests as the recording begins is all it needs from before.
      [this.pointer, this.shapes, this.keys, this.opens, this.steps] = [this.pointer.slice(-1), [], [], [], []];
      this.unwatch = this.watch();
      try {
        this.recording = await video.Recording.start(this.dir, this.where(), out, fps);
        this.recordingFrom = Date.now();
      } catch (error) {
        await this.unwatch();
        throw error;
      }
    } else if (args[0] === "stop") {
      if (!this.recording) throw Error("not recording; record start first");
      const [recording, from, to] = [this.recording, this.recordingFrom, Date.now()];
      this.recording = null;
      await this.unwatch?.();
      const scripts = [...this.scripts.filter(([, end]) => end >= from), [this.running, to] as video.Span];
      const take = {
        from,
        to,
        scripts,
        pointer: this.pointer,
        shapes: this.shapes,
        keys: this.keys,
        opens: this.opens,
        steps: this.steps,
      };
      this.output.push(...(await recording.stop(take)));
    } else throw Error("record needs start or stop");
  }
  /** Shows that the capture opened a link or file, which it didn't, and notes it while recording. */
  async opened(target: string) {
    if (!target) return;
    const now = Date.now();
    if (this.recording) this.opens.push({ t: now, target });
    // Pointing at the click that opened it, if one just did; a program's own open goes to the corner.
    const at = this.pressed && now - this.pressed.t < 2000 ? this.pressed.at : null;
    const web = /^https?:\/\//i.test(target);
    const strong = target.replace(/^(https?|file):\/\//i, "").replace(/(.)\/$/, "$1");
    const toast: ghostty_host.Toast = web
      ? { icon: "chrome", text: "Opened in Chrome:", strong, at }
      : { text: `${OPEN_ICON} Opened`, strong, at };
    await this.host()
      .toast(toast)
      .catch(error => log(`toast: ${(error as Error).message}`));
  }
  async drive(script: string, cwd: string): Promise<{ output: string[]; error?: string }> {
    [this.output, this.cwd, this.running] = [[], cwd, Date.now()];
    try {
      for (const command of ui_driver.parseScript(script)) {
        const t = Date.now();
        this.found = undefined;
        await this.exec(command);
        if (this.recording && command[0] !== "record")
          this.steps.push({ t, end: Date.now(), command, cell: this.found });
      }
      return { output: this.output };
    } catch (error) {
      return { output: this.output, error: (error as Error).message };
    } finally {
      this.scripts.push([this.running, Date.now()]);
    }
  }
}

/** Material Design's open-in-new, from the Nerd Font symbols Ghostty carries. */
const OPEN_ICON = "\u{f03cc}";

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
    // From the capture's stand-in open and xdg-open, at once, even while a script runs.
    if (request.method === "POST" && path === "/opened") {
      await relay.opened((await request.text()).trim());
      return Response.json({});
    }
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
