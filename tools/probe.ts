/**
 * UI probe: drives a real `corgi` viewer in a PTY with isolated state and
 * renders what it wrote through Ghostty, so the Zig and Bun viewers can be
 * compared screen by screen.
 *
 *   bun tools/probe.ts run bun  script.probe     # snapshots from one binary
 *   bun tools/probe.ts compare  script.probe     # both, diffed per snapshot
 *   bun tools/probe.ts compare -e 'key ctrl+b c; snap'
 *
 * Script commands (one per line, or `;`-separated with -e):
 *   size 100x30              terminal size (before the first command that starts)
 *   seed <shell command>     run in the isolated env before the viewer starts
 *   key <k> [<k>...]         ctrl+b, alt+x, enter, esc, tab, space, up, down,
 *                            left, right, bs, pgup, pgdn, f1, or literal 'text'
 *   type <text>              literal text
 *   click <x> <y> [right]    SGR mouse press+release, 1-based
 *   move <x> <y>             mouse motion (hover)
 *   scroll <x> <y> up|down
 *   drag <x1> <y1> <x2> <y2> press, move with the button held, release
 *   dragtext <from> <to>     drag between the first matches of two texts
 *   paste <text>             bracketed paste; \n becomes a line break
 *   clicktext <text> [n]     click the n-th (1-based) screen match of text
 *   hovertext <text> [n]
 *   rclicktext <text> [n]
 *   resize <cols>x<rows>
 *   wait <ms>                real time
 *   settle                   until output is quiet for 200 ms (max 3 s)
 *   waittext <text>          until the screen shows text (max 5 s)
 *   snap [name]              record the screen
 *   style [name]             record the screen with colors (SGR per line)
 *   bytes <ms>               record bytes the viewer wrote during <ms> idle
 *   raw [name]               record the raw output since the last mark
 *   mark                     start a new raw window
 *
 * `claude` and `codex` on PATH are fake hook-driven agents: in their pane,
 * type work, block, stop or exit (each followed by enter).
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { Terminal } from "../src/pane/terminal";
import { write_ordinary_agent } from "../tests/provider_sim";

const ROOT = resolve(import.meta.dir, "..");
export const BINARIES: Record<string, string> = {
  zig: process.env.PROBE_ZIG ?? join(ROOT, "../corgi-zig/zig-out/bin/corgi"),
  bun: process.env.PROBE_BUN ?? join(ROOT, "dist/corgi"),
};

export interface Record_ {
  kind: "snap" | "style" | "bytes" | "raw";
  name: string;
  text: string;
}

const KEYS: Record<string, string> = {
  enter: "\r",
  esc: "\x1b[27u",
  escape: "\x1b[27u",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  space: " ",
  bs: "\x7f",
  backspace: "\x7f",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pgup: "\x1b[5~",
  pgdn: "\x1b[6~",
  delete: "\x1b[3~",
  f1: "\x1bOP",
};

export function encodeKey(spec: string): string {
  if (spec.startsWith("'") && spec.endsWith("'")) return spec.slice(1, -1);
  const lower = spec.toLowerCase();
  if (KEYS[lower]) return KEYS[lower];
  const ctrl = /^ctrl\+(.)$/.exec(lower);
  if (ctrl) {
    const c = ctrl[1];
    if (c === " ") return "\x00";
    return String.fromCharCode(c.charCodeAt(0) & 0x1f);
  }
  if (lower === "ctrl+space") return "\x00";
  const alt = /^alt\+(.+)$/.exec(spec);
  if (alt) return "\x1b" + encodeKey(alt[1]);
  if (spec.length === 1) return spec;
  throw new Error(`unknown key ${spec}`);
}

/** Splits a line into words, keeping "quoted strings" whole. */
function words(line: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'[^']*'|\S+/g;
  for (const m of line.matchAll(re)) out.push(m[1] !== undefined ? m[1].replace(/\\(.)/g, "$1") : m[0]);
  return out;
}

export function parseScript(source: string): string[][] {
  return source
    .split("\n")
    .filter((l) => !l.trim().startsWith("#"))
    .flatMap((l) => l.split(/;(?=(?:[^"]*"[^"]*")*[^"]*$)/))
    .map((l) => l.trim())
    .filter((l) => l)
    .map(words);
}

export class Session {
  terminal: Bun.Terminal;
  screen: Terminal;
  proc!: ReturnType<typeof Bun.spawn>;
  output = "";
  bytes = 0;
  lastData = Date.now();
  mark = 0;
  home: string;
  cwd: string;
  env: Record<string, string | undefined>;
  records: Record_[] = [];
  private decoder = new TextDecoder();
  constructor(
    readonly exe: string,
    readonly daemon: string = exe,
    public cols = 100,
    public rows = 30,
  ) {
    this.home = mkdtempSync(join(tmpdir(), "corgi-probe-"));
    this.env = {
      ...process.env,
      HOME: this.home,
      XDG_STATE_HOME: join(this.home, ".local/state"),
      CODEX_HOME: join(this.home, ".codex"),
      CLAUDE_CONFIG_DIR: join(this.home, ".claude"),
      CORGI_SOCKET: join(this.home, "control.sock"),
      CORGI_ENV_DIR: join(this.home, "env"),
      CORGI_BELL: "off",
      SHELL: "/bin/sh",
      PS1: "$ ",
      ENV: "",
      TERM: "xterm-256color",
      TERM_PROGRAM: "ghostty",
      // Fake providers first: `claude` and `codex` in a pane are the
      // integration tests' hook-driven agents (type work, block, stop, exit).
      PATH: `${join(this.home, "bin")}:${process.env.PATH}`,
    };
    for (const k of ["CODEX_THREAD_ID", "CLAUDE_CODE_SESSION_KIND", "CORGI_PANE", "CORGI_APP_EXE", "TMUX"]) delete this.env[k];
    mkdirSync(join(this.home, ".local/state/corgi"), { recursive: true });
    mkdirSync(join(this.home, "env"), { recursive: true });
    for (const dir of [".codex", ".claude"]) mkdirSync(join(this.home, dir), { recursive: true });
    for (const provider of ["claude", "codex"]) write_ordinary_agent(join(this.home, "bin", provider));
    this.cwd = join(this.home, "project");
    mkdirSync(this.cwd);
    writeFileSync(
      join(this.home, ".local/state/corgi/viewer.json"),
      JSON.stringify({ onboarding_complete: true, preset: "corgi", prefix: "ctrl_b" }),
    );
    this.screen = new Terminal(cols, rows);
    this.terminal = new Bun.Terminal({
      cols,
      rows,
      data: (_t, data) => {
        this.bytes += data.length;
        this.lastData = Date.now();
        this.output += this.decoder.decode(data, { stream: true });
        this.screen.feed(data);
      },
    });
  }
  async seed(command: string) {
    const p = Bun.spawn(["/bin/sh", "-c", command], { env: this.env, cwd: this.cwd, stdout: "inherit", stderr: "inherit" });
    await p.exited;
  }
  async start() {
    if (this.daemon !== this.exe) {
      const p = Bun.spawn([this.daemon, "start"], { env: this.env, cwd: this.cwd, stdout: "ignore", stderr: "inherit" });
      await p.exited;
    }
    this.proc = Bun.spawn([this.exe, "--no-update"], { env: this.env, cwd: this.cwd, terminal: this.terminal });
  }
  lastInput = 0;
  write(data: string) {
    this.lastInput = Date.now();
    this.terminal.write(data);
  }
  text(): string[] {
    return this.screen.text().replace(/\n$/, "").split("\n").map((l) => l.replace(/\s+$/, ""));
  }
  styled(): string[] {
    return this.screen.surface(0).surface.lines;
  }
  async settle(quiet = 200, max = 3000) {
    const until = Date.now() + max;
    await Bun.sleep(30);
    // The answer to the last input first, for up to a second, then quiet.
    const answered = Math.min(until, this.lastInput + 1000);
    while (Date.now() < answered && this.lastData <= this.lastInput) await Bun.sleep(10);
    while (Date.now() < until && Date.now() - this.lastData < quiet) await Bun.sleep(20);
  }
  find(text: string, nth = 1): [number, number] {
    let count = 0;
    const lines = this.text();
    for (let y = 0; y < lines.length; y++) {
      // Columns count cells: wide glyphs take two.
      const cells = [...lines[y]];
      let from = 0;
      for (;;) {
        const at = lines[y].indexOf(text, from);
        if (at < 0) break;
        if (++count === nth) {
          const before = [...lines[y].slice(0, at)];
          const x = before.reduce((w, ch) => w + (Bun.stringWidth(ch) || 1), 0);
          void cells;
          return [x + 1, y + 1];
        }
        from = at + 1;
      }
    }
    throw new Error(`no screen text ${JSON.stringify(text)} (#${nth})\n${lines.join("\n")}`);
  }
  mouse(button: number, x: number, y: number, release = true) {
    this.write(`\x1b[<${button};${x};${y}M` + (release ? `\x1b[<${button};${x};${y}m` : ""));
  }
  async exec(cmd: string[]) {
    const [op, ...args] = cmd;
    switch (op) {
      case "size":
        break;
      case "seed":
        await this.seed(args.join(" "));
        break;
      case "key":
        for (const k of args) {
          this.write(encodeKey(k));
          await Bun.sleep(40);
        }
        break;
      case "type":
        this.write(args.join(" "));
        break;
      case "click":
        this.mouse(args[2] === "right" ? 2 : 0, +args[0], +args[1]);
        break;
      case "move":
        this.write(`\x1b[<35;${+args[0]};${+args[1]}M`);
        break;
      case "drag":
      case "dragtext": {
        // Press at the start, move with the button held in steps, release.
        const [x1, y1, x2, y2] = op === "dragtext" ? [...this.find(args[0], 1), ...this.find(args[1], 1)] : args.slice(0, 4).map(Number);
        this.write(`\x1b[<0;${x1};${y1}M`);
        await Bun.sleep(30);
        const steps = Math.max(1, Math.abs(x2 - x1), Math.abs(y2 - y1));
        for (let i = 1; i <= steps; i++) {
          const x = Math.round(x1 + ((x2 - x1) * i) / steps);
          const y = Math.round(y1 + ((y2 - y1) * i) / steps);
          this.write(`\x1b[<32;${x};${y}M`);
          await Bun.sleep(10);
        }
        this.write(`\x1b[<0;${x2};${y2}m`);
        break;
      }
      case "paste":
        this.write(`\x1b[200~${args.join(" ").replaceAll("\\n", "\r")}\x1b[201~`);
        break;
      case "scroll":
        this.write(`\x1b[<${args[2] === "up" ? 64 : 65};${+args[0]};${+args[1]}M`);
        break;
      case "clicktext":
      case "hovertext":
      case "rclicktext": {
        const [x, y] = this.find(args[0], args[1] ? +args[1] : 1);
        if (op === "hovertext") this.write(`\x1b[<35;${x};${y}M`);
        else this.mouse(op === "rclicktext" ? 2 : 0, x, y);
        break;
      }
      case "resize": {
        const [c, r] = args[0].split("x").map(Number);
        this.cols = c;
        this.rows = r;
        this.lastInput = Date.now();
        this.terminal.resize(c, r);
        this.screen.resize(c, r);
        break;
      }
      case "wait":
        await Bun.sleep(+args[0]);
        break;
      case "settle":
        await this.settle();
        break;
      case "waittext": {
        const until = Date.now() + (args[1] ? +args[1] : 5000);
        while (!this.text().some((l) => l.includes(args[0]))) {
          if (Date.now() > until) throw new Error(`timed out waiting for ${args[0]}\n${this.text().join("\n")}`);
          await Bun.sleep(30);
        }
        break;
      }
      case "snap":
        await this.settle();
        this.records.push({ kind: "snap", name: args[0] ?? `#${this.records.length}`, text: this.text().join("\n") });
        break;
      case "style":
        await this.settle();
        this.records.push({ kind: "style", name: args[0] ?? `#${this.records.length}`, text: this.styled().join("\n") });
        break;
      case "bytes": {
        await this.settle();
        const start = this.bytes;
        const ms = +args[0] || 3000;
        await Bun.sleep(ms);
        const n = this.bytes - start;
        this.records.push({ kind: "bytes", name: `bytes/${ms}ms`, text: `${n} bytes (${Math.round((n * 1000) / ms)} B/s)` });
        break;
      }
      case "mark":
        this.mark = this.output.length;
        break;
      case "raw":
        await this.settle();
        this.records.push({ kind: "raw", name: args[0] ?? "raw", text: JSON.stringify(this.output.slice(this.mark)) });
        break;
      default:
        throw new Error(`unknown probe command ${op}`);
    }
  }
  async close() {
    try {
      this.write("\x02q");
      await Promise.race([this.proc?.exited, Bun.sleep(500)]);
    } catch {}
    try {
      this.proc?.kill("SIGKILL");
    } catch {}
    const shutdown = Bun.spawn([this.daemon, "shutdown"], { env: this.env, stdout: "ignore", stderr: "ignore" });
    await Promise.race([shutdown.exited, Bun.sleep(3000)]);
    try {
      shutdown.kill("SIGKILL");
    } catch {}
    this.screen.destroy();
    this.terminal.close();
    if (!process.env.PROBE_KEEP) rmSync(this.home, { recursive: true, force: true });
    else console.error(`kept ${this.home}`);
  }
}

export async function runScript(exe: string, source: string, daemon = exe): Promise<{ records: Record_[]; error?: string; log: string }> {
  const commands = parseScript(source);
  let cols = 100,
    rows = 30;
  for (const c of commands) if (c[0] === "size") [cols, rows] = c[1].split("x").map(Number);
  const s = new Session(exe, daemon, cols, rows);
  let error: string | undefined;
  let started = false;
  try {
    for (const c of commands) {
      if (!started && c[0] !== "size" && c[0] !== "seed") {
        await s.start();
        started = true;
        const until = Date.now() + 8000;
        while (s.bytes === 0 && Date.now() < until) await Bun.sleep(20);
        // Let the timing-driven parts settle the same way on both sides: the
        // badge falls back to the emoji once the graphics probe times out,
        // and CPU readings appear after the daemon's second sample.
        const ready = Date.now() + 5000;
        const screen = () => s.text().join("\n");
        while (Date.now() < ready && !(screen().includes("🐕") && screen().includes("CPU "))) await Bun.sleep(30);
        await s.settle(400, 5000);
      }
      await s.exec(c);
    }
    if (!started) await s.start();
  } catch (e) {
    error = String(e instanceof Error ? e.message : e);
    s.records.push({ kind: "snap", name: "at error", text: s.text().join("\n") });
  }
  const log = existsSync(join(s.home, "server.log")) ? readFileSync(join(s.home, "server.log"), "utf8") : "";
  await s.close();
  return { records: s.records, error, log };
}

/** Blanks cells that change with time rather than with input: the CPU
 * reading between samples, a sleeping corgi's Z, spinners. */
export function normalize(text: string): string {
  if (process.env.PROBE_EXACT) return text;
  return text
    // A workspace's resource row appears with the daemon's sampling ticks.
    .replace(/^(.)([^│\n]*(?:CPU|C |Memory|M )[^│\n]*›\s*)│/gm, (_m, lead, row) => lead + " ".repeat(Bun.stringWidth(row)) + "│")
    .replace(/[ᶻz](?= *[│ ])/g, " ")
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "⠿")
    .replace(/corgi-probe-[A-Za-z0-9]{6}/g, "corgi-probe-XXXXXX")
    // A working agent's corgi plays at random (wag, sniff, fetch).
    .replace(/⠿  [^│]*│/g, "⠿  (corgi) │")
    // Thinking dots advance with the clock.
    .replace(/now  ●  \.{1,3} /g, "now  ●  ... ")
    // The idle corgi's wag: tail and ears move with the clock.
    .replace(/[~^-][ᐯᐱ]•.•[ᐯᐱ]/g, "~ᐯ•.•ᐯ");
}
/** Snapshots match after normalizing; byte rates match within 25% (or
 * 200 B/s), since animations draw a little more or less at random. */
function matches(z: Record_, b: Record_): boolean {
  if (z.kind === "bytes" && b.kind === "bytes") {
    const rate = (r: Record_) => Number(/\((\d+) B\/s\)/.exec(r.text)?.[1] ?? NaN);
    const [x, y] = [rate(z), rate(b)];
    return Math.abs(x - y) <= Math.max(200, 0.25 * Math.max(x, y));
  }
  return normalize(z.text) === normalize(b.text);
}
function sideBySide(a: string, b: string, width: number): string {
  const al = a.split("\n"),
    bl = b.split("\n");
  const n = Math.max(al.length, bl.length);
  const out: string[] = [];
  const pad = (s: string) => {
    const w = Bun.stringWidth(s);
    return w >= width ? s : s + " ".repeat(width - w);
  };
  for (let i = 0; i < n; i++) {
    const l = al[i] ?? "",
      r = bl[i] ?? "";
    out.push(`${normalize(l) === normalize(r) ? " " : "!"}${String(i + 1).padStart(2)} ${pad(l)} ║ ${r}`);
  }
  return out.join("\n");
}

async function main() {
  const argv = process.argv.slice(2);
  const mode = argv.shift();
  let source: string;
  const pick = (flag: string) => {
    const i = argv.indexOf(flag);
    if (i < 0) return undefined;
    const v = argv[i + 1];
    argv.splice(i, 2);
    return v;
  };
  const inline = pick("-e");
  // A side is <viewer>[/<daemon>], e.g. zig, bun, zig/bun (Zig viewer on a Bun daemon).
  const side = (spec: string) => {
    const [viewer, daemon = viewer] = spec.split("/");
    return [BINARIES[viewer] ?? viewer, BINARIES[daemon] ?? daemon];
  };
  const left = pick("--left") ?? "zig";
  const right = pick("--right") ?? "bun";
  if (mode === "run") {
    const [exe, daemon] = side(argv.shift()!);
    source = inline ?? readFileSync(argv[0], "utf8");
    const result = await runScript(exe, source, daemon);
    for (const r of result.records) console.log(`── ${r.kind} ${r.name}\n${r.text}`);
    if (result.error) {
      console.log(`ERROR: ${result.error}`);
      process.exitCode = 1;
    }
    return;
  }
  if (mode === "compare") {
    source = inline ?? readFileSync(argv[0], "utf8");
    const [zig, bun] = await Promise.all([runScript(side(left)[0], source, side(left)[1]), runScript(side(right)[0], source, side(right)[1])]);
    let differ = 0;
    const n = Math.max(zig.records.length, bun.records.length);
    for (let i = 0; i < n; i++) {
      const z = zig.records[i],
        b = bun.records[i];
      const same = z && b && matches(z, b);
      if (!same) differ++;
      const width = Math.max(...(z?.text ?? "").split("\n").map((l) => Bun.stringWidth(l)), 10);
      console.log(`── ${z?.kind ?? b?.kind} ${z?.name ?? b?.name}: ${same ? "SAME" : "DIFFERENT"}  (left ${left}, right ${right})`);
      if (!same || process.env.PROBE_ALL) console.log(sideBySide(z?.text ?? "(none)", b?.text ?? "(none)", width));
    }
    if (zig.error) console.log(`${left} ERROR: ${zig.error}`);
    if (bun.error) console.log(`${right} ERROR: ${bun.error}`);
    console.log(`${differ ? `${differ} of ${n} differ` : `all ${n} match`}`);
    if (differ || zig.error || bun.error) process.exitCode = 1;
    return;
  }
  if (mode === "suite") {
    // Every scenario under tools/scenarios, compared; names filter.
    const dir = join(import.meta.dir, "scenarios");
    const { readdirSync } = await import("node:fs");
    const names = readdirSync(dir).filter((f) => f.endsWith(".probe")).map((f) => f.slice(0, -6)).filter((name) => argv.length === 0 || argv.includes(name));
    const compare = async (name: string) => {
      const source = readFileSync(join(dir, `${name}.probe`), "utf8");
      const failure = (e: unknown) => ({ records: [] as Record_[], error: String(e), log: "" });
      const [zig, bun] = await Promise.all([
        runScript(side(left)[0], source, side(left)[1]).catch(failure),
        runScript(side(right)[0], source, side(right)[1]).catch(failure),
      ]);
      const n = Math.max(zig.records.length, bun.records.length);
      const bad: string[] = [];
      for (let i = 0; i < n; i++) if (!zig.records[i] || !bun.records[i] || !matches(zig.records[i], bun.records[i])) bad.push(zig.records[i]?.name ?? bun.records[i]?.name ?? `#${i}`);
      const errors = `${zig.error ? `  ${left} error: ${zig.error.split("\n")[0]}` : ""}${bun.error ? `  ${right} error: ${bun.error.split("\n")[0]}` : ""}`;
      return { ok: bad.length === 0 && !zig.error && !bun.error, detail: `${bad.length ? `  differs: ${bad.join(", ")}` : ""}${errors}` };
    };
    // A few at a time: under heavy load the two viewers' timing drifts apart.
    const jobs = Number(process.env.PROBE_JOBS ?? 4);
    const results: { name: string; ok: boolean; detail: string }[] = [];
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(jobs, names.length) }, async () => {
        while (next < names.length) {
          const name = names[next++];
          results.push({ name, ...(await compare(name)) });
        }
      }),
    );
    results.sort((x, y) => names.indexOf(x.name) - names.indexOf(y.name));
    let failed = 0;
    for (const result of results) {
      let note = "";
      if (!result.ok) {
        // Alone, a timing difference goes away and a real one stays.
        const again = await compare(result.name);
        if (again.ok) note = `  (matched on a rerun alone; first run${result.detail})`;
        else result.detail = again.detail;
        result.ok = again.ok;
      }
      if (!result.ok) failed++;
      console.log(`${result.ok ? "PASS" : "FAIL"} ${result.name}${result.ok ? note : result.detail}`);
    }
    console.log(`${results.length - failed}/${results.length} scenarios match`);
    if (failed) process.exitCode = 1;
    return;
  }
  console.error("usage: probe.ts run <zig|bun|path> <script>|-e '...'\n       probe.ts compare <script>|-e '...'\n       probe.ts suite [names...]");
  process.exit(2);
}

if (import.meta.main) {
  await main();
  process.exit(process.exitCode ?? 0);
}
