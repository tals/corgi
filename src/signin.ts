//! The guided sign-in: a frame around the agent's own first run in an
//! account's folder. The frame names the account, says what the agent's
//! screen leaves out and notices the login landing. A new account's folder
//! only moves in once its sign-in worked out; cancelling signs it out and
//! deletes it. The viewer shows it over its panes; `corgi account add` and
//! `corgi account login` show it in the terminal they run in.
import * as agentName from "./agent_name";
import * as accounts from "./accounts";
import * as build_id from "./build_id";
import * as corgiAnimation from "./corgi_animation";
import * as discovery from "./discovery";
import * as errors from "./errors";
import * as integration from "./integration";
import * as palette from "./palette";
import { Style } from "./palette";
import { Provider, adapter } from "./providers";
import type { Login, SigninStep } from "./providers/adapter";
import { Terminal, closeReadiness } from "./pane/terminal";
import { Differ } from "./frame_diff";
import { shellWords } from "./os";
import { displayWidth, ellipsis } from "./text";
import * as viewerNative from "./viewer_native";

let line = "",
  strong = "",
  muted = "",
  quiet = "",
  text = "",
  hot = "",
  accent = "",
  focused = "",
  plain = "";
palette.derived(() => {
  line = new Style({ fg: "line", bg: "bg" }).sgr();
  strong = new Style({ fg: "strong", bg: "bg", bold: true }).sgr();
  muted = new Style({ fg: "muted", bg: "bg" }).sgr();
  quiet = new Style({ fg: "faint", bg: "bg" }).sgr();
  text = new Style({ fg: "text", bg: "bg" }).sgr();
  hot = new Style({ fg: "hot", bg: "bg" }).sgr();
  accent = new Style({ fg: "accent", bg: "bg" }).sgr();
  focused = new Style({ fg: "strong", bg: "selected", bold: true }).sgr();
  plain = new Style({ bg: "bg" }).sgr();
});
const reset = "\x1b[0m";
/** How long the frame says the agent is starting before it shows whatever
 * the agent's screen does. */
const starting_ms = 2000;

/** The first link `text` shows, joined across the rows it wraps over:
 * a row `cols` wide goes on in the next. */
export function link(text: string, cols: number): string | null {
  const rows = text.split("\n");
  for (let i = 0; i < rows.length; i++) {
    const at = rows[i].indexOf("https://");
    if (at < 0) continue;
    let url = rows[i].slice(at).trimEnd();
    if (url.includes(" ")) return url.slice(0, url.indexOf(" "));
    for (let j = i; displayWidth(rows[j].trimEnd()) >= cols && j + 1 < rows.length; j++) {
      const next = rows[j + 1].trim();
      if (!next || next.includes(" ")) break;
      url += next;
    }
    return url;
  }
  return null;
}
/** The processes that run a program from inside `folders`, as Codex starts
 * its background server from its folder: they'd outlive it. */
function inside(folders: string[]): number[] {
  const listed = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString(),
    pids: number[] = [];
  for (const row of listed.split("\n")) {
    const m = /^\s*(\d+)\s+(\S.*)$/.exec(row);
    if (m && Number(m[1]) !== process.pid && folders.some(f => m[2].startsWith(f + "/"))) pids.push(Number(m[1]));
  }
  return pids;
}
const kill = (pids: number[], signal: NodeJS.Signals) => {
  for (const pid of pids)
    try {
      process.kill(pid, signal);
    } catch {}
};
/** Stops what runs from inside `folders`, waiting a moment for it to go. */
async function stopInside(folders: string[]) {
  const pids = inside(folders),
    until = Date.now() + 2000;
  kill(pids, "SIGTERM");
  while (pids.some(alive) && Date.now() < until) await Bun.sleep(50);
  kill(pids.filter(alive), "SIGKILL");
}
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

type Choice = { label: string; act: () => unknown };
/** A question in the frame: what happened, then the choices. Esc picks
 * `esc`, one that loses nothing: the first unless it says otherwise. */
type Dialog = {
  heading: string;
  lines: string[];
  choices: Choice[];
  focus: number;
  step: number;
  esc?: number;
  hint?: string;
};
type Stage =
  { kind: "agent"; offered: Provider[]; choice: number } | { kind: "signin" } | { kind: "dialog"; dialog: Dialog };
type Key =
  | { kind: "up" | "down" | "left" | "right" | "tab" | "backtab" | "enter" | "esc" | "backspace" | "cancel" }
  | { kind: "text"; text: string }
  | { kind: "click"; x: number; y: number };
/** The keys and clicks in `data`, as the frame's own screens read them. */
function keys(data: string): Key[] {
  const out: Key[] = [],
    named: [string, Key["kind"]][] = [
      ["\x1b[A", "up"],
      ["\x1bOA", "up"],
      ["\x1b[B", "down"],
      ["\x1bOB", "down"],
      ["\x1b[C", "right"],
      ["\x1bOC", "right"],
      ["\x1b[D", "left"],
      ["\x1bOD", "left"],
      ["\x1b[Z", "backtab"],
    ];
  for (let i = 0; i < data.length;) {
    const mouse = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])/.exec(data.slice(i));
    if (mouse) {
      if (mouse[4] === "M" && Number(mouse[1]) === 0)
        out.push({ kind: "click", x: Number(mouse[2]) - 1, y: Number(mouse[3]) - 1 });
      i += mouse[0].length;
      continue;
    }
    if (data.startsWith("\x1b[200~", i)) {
      const end = data.indexOf("\x1b[201~", i);
      out.push({ kind: "text", text: data.slice(i + 6, end < 0 ? data.length : end) });
      i = end < 0 ? data.length : end + 6;
      continue;
    }
    const seq = named.find(([s]) => data.startsWith(s, i));
    if (seq) {
      out.push({ kind: seq[1] } as Key);
      i += seq[0].length;
      continue;
    }
    const ch = data[i++];
    if (ch === "\x1b") {
      // Another escape sequence: skip it whole.
      const rest = /^\[[0-9;?]*[ -\/]*[@-~]/.exec(data.slice(i));
      if (rest) i += rest[0].length;
      else out.push({ kind: "esc" });
    } else if (ch === "\r" || ch === "\n") out.push({ kind: "enter" });
    else if (ch === "\t") out.push({ kind: "tab" });
    else if (ch === "\x7f" || ch === "\b") out.push({ kind: "backspace" });
    else if (ch === "\x03" || ch === "\x11") out.push({ kind: "cancel" });
    else if (ch >= " ") out.push({ kind: "text", text: ch });
  }
  return out;
}

/** Where a sign-in shows. */
export interface Host {
  /** Something in it changed, to draw again. */
  changed(): void;
  /** It's over: `start` opens the agent in its account; `message` confirms
   * what happened, including when the agent starts. */
  done(status: number, start: boolean, message: string): void;
}
/** What `draw` puts on the screen: the frame with each row at its place,
 * where the cursor goes, and who the pointer is for in the agent's area. */
export type Drawn = { frame: string; cursor: { x: number; y: number } | null; mouse: "frame" | "agent" | "select" };

/** One run of the guided sign-in, in a box its host gives it. */
export class Signin {
  stage: Stage = { kind: "signin" };
  provider: Provider | null = null;
  /** The account's name: one asked for up front, or once a new account is
   * signed in, the one its login suggests. */
  name: string | null = null;
  /** The account's folder, as the provider is told it. */
  dir = "";
  staged: accounts.Staged | null = null;
  agent = "";
  child: Terminal | null = null;
  step: SigninStep | null = null;
  who: Login | null = null;
  signed = false;
  checked = 0;
  compared = false;
  busy = false;
  /** What it's doing that takes a moment, shown in place of its questions. */
  working: string | null = null;
  /** When the agent started, and whether its screen shows something yet. */
  spawned = 0;
  up = true;
  over = false;
  /** The account it ended in, for the agent its host starts. */
  account = "";
  /** Where the agent runs, as it asks to trust that folder. */
  cwd = process.cwd();
  cols = 80;
  rows = 24;
  buttons: { x: number; to: number; y: number; act: () => unknown }[] = [];
  timers: Timer[] = [];
  /** The steps the top border lists, and whether `add` asked for the agent. */
  constructor(
    readonly adding: boolean,
    readonly asked_agent: boolean,
    readonly host: Host,
  ) {}
  get label() {
    return this.provider ? adapter(this.provider).label : "";
  }
  get signin() {
    const signin = adapter(this.provider!).accounts.signin;
    if (!signin) throw Error("AccountManagementUnsupported");
    return signin;
  }
  get check() {
    const check = this.signin.check;
    return typeof check === "function" ? check(this.dir) : check;
  }
  async signOut() {
    const logout = this.signin.logout;
    if (typeof logout === "function") logout(this.dir);
    else await this.account_command(logout, 15000);
  }
  steps() {
    return [...(this.asked_agent ? ["Agent"] : []), "Sign in", "Ready"];
  }
  current() {
    const s = this.stage,
      named = this.steps();
    if (s.kind === "agent") return 0;
    if (s.kind === "dialog") return s.dialog.step;
    return named.indexOf("Sign in");
  }
  /** The agent's screen inside the frame, from the box's corner. */
  body() {
    return { x: 1, y: 1, cols: Math.max(1, this.cols - 2), rows: Math.max(1, this.rows - 5) };
  }
  /** Whether what's typed goes to the agent: its screen is up and nothing covers it. */
  get typing() {
    return this.stage.kind === "signin" && this.child !== null && this.up;
  }
  env(): Record<string, string> {
    const env: Record<string, string | undefined> = {
      ...process.env,
      [adapter(this.provider!).accounts.env]: this.dir,
    };
    adapter(this.provider!).unnest?.(env);
    return env as Record<string, string>;
  }
  changed() {
    if (!this.over) this.host.changed();
  }

  /** Starts it in a box `cols` wide and `rows` high. */
  async open(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    this.timers.push(setInterval(() => this.tick(), 33));
    this.timers.push(setInterval(() => void this.poll(), 1000));
    if (this.stage.kind === "signin") await this.begin();
    this.changed();
  }
  resize(cols: number, rows: number) {
    this.cols = cols;
    this.rows = rows;
    const { cols: c, rows: r } = this.body();
    this.child?.resize(c, r);
    this.changed();
  }
  tick() {
    if (this.over) return;
    // Its spinner turns while it works.
    if (this.working) this.changed();
    if (!this.child) return;
    const changed = this.child.read();
    if (!this.up)
      // Until the agent shows something to answer, the frame spins.
      this.up = (changed && this.signin.started(this.child.text())) || Date.now() - this.spawned >= starting_ms;
    if (changed || !this.up) this.changed();
  }

  /** Makes a new account's folder and starts the agent there, or starts it
   * in an account that has one. */
  async begin() {
    try {
      this.agent = await discovery.resolve(this.provider!);
    } catch (error) {
      return this.ask({
        heading: unavailable(this.provider!, error),
        lines: [],
        choices: [
          { label: "Try again", act: () => void this.retry() },
          { label: "Close", act: () => this.close(1) },
        ],
        step: this.steps().indexOf("Sign in"),
        esc: 1,
      });
    }
    if (!this.agent.includes("/")) this.agent = Bun.which(this.agent) ?? this.agent;
    if (this.adding)
      try {
        this.staged = accounts.stage(this.provider!, this.name);
        this.dir = this.staged.dir;
      } catch (error) {
        return this.ask({
          heading: `Corgi couldn't make the account. ${problem(error)}`,
          lines: [],
          choices: [{ label: "Close", act: () => this.close(1) }],
          step: this.steps().indexOf("Sign in"),
        });
      }
    await this.start();
  }
  /** Looks for its agent again, as after installing or updating it. */
  retry() {
    this.stage = { kind: "signin" };
    this.changed();
    return this.begin();
  }
  async start() {
    // Closed before its agent came up, it starts none.
    if (this.over) return;
    const { cols, rows } = this.body(),
      t = new Terminal(cols, rows),
      args = this.adding ? this.signin.first : (this.signin.again ?? this.signin.first);
    try {
      // Its hooks stay quiet: the session to report is the one it starts after.
      await t.spawn(this.cwd, "", 0, build_id.self(), shellWords([this.agent, ...args]), false, [
        ["CORGI_PANE", ""],
        [adapter(this.provider!).accounts.env, this.dir],
      ]);
    } catch (error) {
      t.destroy();
      return this.stopped(`${this.label} didn't start: ${errors.name(error) ?? error}`);
    }
    if (this.over) return void t.destroy();
    t.on("exit", () => void this.exited(t));
    this.child = t;
    this.spawned = Date.now();
    this.up = false;
    this.stage = { kind: "signin" };
    this.changed();
  }
  async stopChild() {
    const t = this.child;
    this.child = null;
    if (!t) return;
    t.removeAllListeners("exit");
    const pid = t.pid,
      exited = t.child?.exited;
    t.stop();
    if (exited) await Promise.race([exited, Bun.sleep(2000)]);
    if (pid > 0 && t.child?.exitCode === null)
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    t.destroy();
  }
  /** Runs one of the agent's account commands in the account; its status. */
  account_command(args: string[], ms: number): Promise<number> {
    return run(this.agent, args, this.env(), ms);
  }

  /** Reads the agent's screen for its step, and its folder for a login. */
  async poll() {
    if (this.over || this.busy || !this.child) return;
    const before = this.step;
    this.step = this.signin.step(this.child.text());
    if (this.step !== before) this.changed();
    const who = accounts.identity(this.provider!, this.dir);
    if (who?.email !== this.who?.email) this.changed();
    this.who = who;
    if (!who) return;
    this.busy = true;
    try {
      if (this.adding && !this.compared) {
        this.compared = true;
        const other = accounts.signedInElsewhere(this.provider!, this.dir, who);
        if (other) return this.twice(who, other === "default" ? "default" : other.name);
      }
      // Its own check spawns the agent: now and then is enough.
      if (!this.signed && Date.now() - this.checked >= 3000) {
        this.checked = Date.now();
        this.signed = (await this.account_command(this.check, 10000)) === 0;
        if (this.signed) this.changed();
      }
      if (this.signed && this.signin.ready(this.dir) && this.stage.kind === "signin") await this.finish();
    } finally {
      this.busy = false;
    }
  }
  async exited(t: Terminal) {
    if (this.over || t !== this.child) return;
    this.child = null;
    t.destroy();
    this.who = accounts.identity(this.provider!, this.dir);
    if (this.who && (await this.account_command(this.check, 10000)) === 0 && this.signin.ready(this.dir))
      return this.finish();
    this.stopped(`${this.label} closed before you signed in.`);
  }
  /** The agent isn't running and nobody signed in: try again, or let go. */
  stopped(heading: string) {
    this.ask({
      heading,
      lines: [],
      choices: [
        { label: "Try again", act: () => this.start() },
        this.staged
          ? { label: "Delete and close", act: () => this.discard() }
          : { label: "Close", act: () => this.close(1) },
      ],
      step: this.steps().indexOf("Sign in"),
    });
  }
  twice(who: Login, other: string) {
    this.ask({
      heading: `${who.email} is signed in to ${this.label} · ${other} already.`,
      lines: ["Adding it again lists the same login twice."],
      choices: [
        { label: "Keep signing in", act: () => this.back() },
        { label: "Delete and close", act: () => this.discard() },
      ],
      step: this.steps().indexOf("Sign in"),
    });
  }
  /** Discards a new account, or stops signing in to one there was. */
  cancel() {
    if (this.staged) return this.discard();
    this.close(1);
  }
  back() {
    this.stage = this.child ? { kind: "signin" } : this.stage;
    this.changed();
  }
  ask(d: Omit<Dialog, "focus">) {
    this.stage = { kind: "dialog", dialog: { ...d, focus: 0 } };
    this.changed();
  }
  /** Says what it's doing while something takes a moment, in place of its
   * questions. */
  work(text: string | null) {
    this.working = text;
    this.changed();
  }
  /** The login worked out: the folder moves in and gets Corgi's hooks. */
  async finish() {
    this.busy = true;
    this.work(`Signed in. Setting up ${this.label}…`);
    await this.stopChild();
    if (this.staged) {
      await stopInside([this.staged.dir, this.staged.temp]);
      this.name = accounts.adopt(this.staged, this.name ?? accounts.suggest(this.provider!, this.who)).name;
      this.staged = null;
    }
    this.account = this.dir;
    await integration.prepare(this.provider!, this.dir);
    this.busy = false;
    this.work(null);
    if (this.adding) return this.close(0, true, `Account added: ${this.label} / ${this.name}.`);
    this.ask({
      heading: `Signed in as ${this.who?.email ?? accounts.identity(this.provider!, this.dir)?.email ?? "?"}.`,
      lines: [`The launcher lists it as ${this.label} · ${this.name}.`],
      choices: [
        { label: `Start ${this.label}`, act: () => this.close(0, true) },
        { label: "Close", act: () => this.close(0) },
      ],
      step: this.steps().indexOf("Ready"),
      esc: 1,
    });
  }
  /** Deletes a new account that didn't work out, its login first. */
  async discard() {
    if (this.working) return;
    this.busy = true;
    this.work("Signing out and deleting the new folder…");
    await this.stopChild();
    const s = this.staged;
    if (s) {
      if (accounts.identity(this.provider!, s.dir) || (await this.account_command(this.check, 10000)) === 0)
        await this.signOut();
      await stopInside([s.dir, s.temp]);
      accounts.unstage(s);
      this.staged = null;
    }
    this.close(1, false, `Cancelled: the new ${this.label} account wasn't added.`);
  }
  /** Its host went away mid-way: what it started stops, and a new account
   * goes, at once. */
  abandon() {
    if (this.over) return;
    this.over = true;
    for (const timer of this.timers) clearInterval(timer);
    try {
      if (this.child && this.child.pid > 0) process.kill(-this.child.pid, "SIGKILL");
    } catch {}
    const s = this.staged;
    if (s) {
      if (accounts.identity(this.provider!, s.dir)) {
        const logout = this.signin.logout;
        if (typeof logout === "function") logout(s.dir);
        else Bun.spawnSync([this.agent, ...logout], { env: this.env(), timeout: 5000 });
      }
      kill(inside([s.dir, s.temp]), "SIGKILL");
      accounts.unstage(s);
    }
  }
  close(status: number, start = false, message = "") {
    if (this.over) return;
    this.over = true;
    for (const timer of this.timers) clearInterval(timer);
    void this.stopChild();
    this.host.done(status, start, message);
  }

  /** Takes what was typed, as a terminal sends it. */
  async input(bytes: Uint8Array | string) {
    if (this.over) return;
    // Bytes as they came, one character each, so the agent gets them unchanged.
    const data = typeof bytes === "string" ? bytes : Buffer.from(bytes).toString("latin1");
    if (this.stage.kind === "signin" && this.child) {
      // Nothing answers a screen no one sees yet; the frame's cancel still works.
      if (this.up) return this.forward(data);
      if (/[\x03\x11]/.test(data)) this.cancel();
      return;
    }
    for (const key of keys(data)) await this.key(key);
  }
  /** Gives the agent what was typed, as bytes one per character, but the
   * frame's own cancel. */
  forward(data: string) {
    const child = this.child!,
      at = data.search(/[\x03\x11]/);
    let pass = at < 0 ? data : data.slice(0, at);
    pass = pass.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g, (_, b, x, y, m) => {
      const body = this.body(),
        col = Number(x) - body.x,
        row = Number(y) - body.y;
      if (!viewerNative.mouseEvents(child.handle) || col < 1 || row < 1 || col > body.cols || row > body.rows)
        return "";
      return `\x1b[<${b};${col};${row}${m}`;
    });
    if (!viewerNative.bracketedPaste(child.handle)) pass = pass.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
    if (pass) child.send(Buffer.from(pass, "latin1"));
    if (at >= 0) this.cancel();
  }
  /** Sends the agent bytes its host already encoded for it. */
  send(bytes: Uint8Array | string) {
    if (this.typing) this.child!.send(bytes);
  }
  /** A click at (`x`, `y`) in the box. */
  async click(x: number, y: number) {
    return this.key({ kind: "click", x, y });
  }
  /** Acts on a key or click. What it starts that takes a while, such as
   * signing out, runs on its own: the host keeps taking input meanwhile. */
  async key(key: Key) {
    const s = this.stage;
    if (this.working) return;
    if (key.kind === "click") {
      const hit = this.buttons.find(b => b.y === key.y && key.x >= b.x && key.x < b.to);
      return void hit?.act();
    }
    if (key.kind === "cancel") return this.cancel();
    switch (s.kind) {
      case "agent": {
        if (key.kind === "up" || key.kind === "backtab")
          s.choice = (s.choice + s.offered.length - 1) % s.offered.length;
        else if (key.kind === "down" || key.kind === "tab") s.choice = (s.choice + 1) % s.offered.length;
        else if (key.kind === "text" && /^[1-9]$/.test(key.text) && Number(key.text) <= s.offered.length)
          return this.pick(s.offered[Number(key.text) - 1]);
        else if (key.kind === "enter") return this.pick(s.offered[s.choice]);
        else if (key.kind === "esc") return this.close(0);
        break;
      }
      case "dialog": {
        const d = s.dialog;
        if (key.kind === "left" || key.kind === "backtab")
          d.focus = (d.focus + d.choices.length - 1) % d.choices.length;
        else if (key.kind === "right" || key.kind === "tab") d.focus = (d.focus + 1) % d.choices.length;
        else if (key.kind === "enter") return void d.choices[d.focus].act();
        else if (key.kind === "esc") return void d.choices[d.esc ?? 0].act();
        break;
      }
    }
    this.changed();
  }
  offer() {
    const supported = Provider.all.filter(p => adapter(p).accounts.signin !== null),
      offered = supported.filter(p => discovery.installed(p));
    this.stage = { kind: "agent", offered: offered.length ? offered : supported, choice: 0 };
    this.changed();
  }
  async pick(provider: Provider) {
    this.provider = provider;
    this.stage = { kind: "signin" };
    this.changed();
    await this.begin();
  }

  /** The box with its corner at (`ox`, `oy`) on the screen. */
  draw(ox: number, oy: number, hovered: bigint | null = null): Drawn {
    const W = this.cols,
      H = this.rows,
      at = (y: number, x: number) => `\x1b[${oy + y + 1};${ox + x + 1}H`;
    let frame = "";
    this.buttons = [];
    if (W < 30 || H < 10) {
      frame = at(0, 0) + text + ellipsis("Make this window bigger to sign in.", W) + reset;
      return { frame, cursor: null, mouse: "frame" };
    }
    // Top: what this is, then the steps.
    const title = this.adding
        ? ["Add account", this.provider ? this.label : "", this.name ?? ""].filter(Boolean).join(" · ")
        : `Sign in · ${this.label} · ${this.name}`,
      steps = this.steps(),
      current = this.current(),
      stepsWidth = displayWidth(steps.join(" › ")),
      shown = ellipsis(title, W - 9);
    frame += at(0, 0) + line + "╭──── " + strong + shown + line + " ";
    let room = W - 8 - displayWidth(shown);
    if (room >= stepsWidth + 4) {
      frame += "─".repeat(room - stepsWidth - 3) + " ";
      steps.forEach((step, i) => {
        if (i) frame += quiet + " › ";
        frame += (i === current ? strong : quiet) + step;
      });
      frame += " " + line + "─╮";
    } else frame += "─".repeat(Math.max(0, room)) + "╮";
    // Every cell inside is drawn, so nothing stays from a screen before.
    const blank = plain + " ".repeat(W - 2) + line;
    for (let y = 1; y < H - 4; y++) frame += at(y, 0) + line + "│" + blank + "│";
    frame += at(H - 4, 0) + line + "├" + "─".repeat(W - 2) + "┤";
    frame += at(H - 3, 0) + "│" + blank + "│";
    frame += at(H - 2, 0) + "│" + blank + "│";
    frame += at(H - 1, 0) + "╰" + "─".repeat(W - 2) + "╯" + reset;

    let cursor: Drawn["cursor"] = null,
      mouse: Drawn["mouse"] = "frame";
    const s = this.stage,
      inner = W - 4,
      write = (y: number, style: string, value: string, x = 2) =>
        (frame += at(y, x) + style + ellipsis(value, inner - (x - 2)) + reset);
    if (this.working) write(2, muted, `${corgiAnimation.spinner(false, Date.now())} ${this.working}`);
    else if (s.kind === "signin" && this.child && !this.up) {
      write(2, muted, `${corgiAnimation.spinner(false, Date.now())} Starting ${this.label}…`);
      write(H - 3, muted, `Its sign-in shows here once it's up; the first start can take a while.`);
      frame += at(H - 2, 2) + keycap("ctrl c") + quiet + " cancel" + reset;
    } else if (s.kind === "signin" && this.child) {
      const body = this.body(),
        handle = this.child.handle;
      viewerNative.updateRender(handle);
      frame += viewerNative.rows(handle, 0, ox + body.x, oy + body.y, body.cols, body.rows, false, hovered) + reset;
      const caret = viewerNative.cursor(handle);
      if (caret) cursor = { x: ox + body.x + caret.x, y: oy + body.y + caret.y };
      // The agent's screen stays selectable unless the agent asks for the mouse.
      mouse = viewerNative.mouseEvents(handle) ? "agent" : "select";
      write(H - 3, muted, this.hint());
      frame += at(H - 2, 2) + keycap("ctrl c") + quiet + " cancel" + reset;
      this.buttons.push({ x: 2, to: 2 + displayWidth(" ctrl c  cancel"), y: H - 2, act: () => this.cancel() });
      // An old login's email can outlast it: the agent's own check says.
      const signed = this.signed && this.who,
        status = signed ? `Signed in as ${signed.email}` : "Waiting for you to sign in",
        right = ellipsis(status, Math.max(0, inner - 14));
      frame += at(H - 2, W - 2 - displayWidth(right)) + (signed ? accent : quiet) + right + reset;
    } else if (s.kind === "agent") {
      write(2, strong, "Which agent is this account for?");
      s.offered.forEach((p, i) => {
        const chosen = i === s.choice;
        write(4 + i, chosen ? focused : text, `${chosen ? "❯" : " "} ${i + 1}  ${adapter(p).label} `);
        this.buttons.push({ x: 2, to: W - 2, y: 4 + i, act: () => this.pick(p) });
      });
      write(H - 3, muted, "Corgi makes the account a folder that shares your default one's setup.");
      frame += at(H - 2, 2) + keycap("↑↓") + quiet + " choose  " + keycap("enter") + quiet + " next  " + keycap("esc");
      frame += quiet + " close" + reset;
    } else if (s.kind === "dialog") {
      const d = s.dialog;
      write(2, strong, d.heading);
      d.lines.forEach((value, i) => write(3 + i, text, value));
      if (d.hint) write(H - 3, muted, d.hint);
      let x = 2;
      const y = 4 + d.lines.length;
      d.choices.forEach((c, i) => {
        const label = `[ ${c.label} ]`;
        frame += at(y, x) + (i === d.focus ? focused : muted) + label + reset;
        this.buttons.push({ x, to: x + displayWidth(label), y, act: c.act });
        x += displayWidth(label) + 2;
      });
      frame += at(H - 2, 2) + keycap("←→") + quiet + " choose  " + keycap("enter") + quiet + " select  ";
      frame += keycap("esc") + quiet + " " + d.choices[d.esc ?? 0].label.toLowerCase() + reset;
    } else write(2, quiet, "Starting…");
    return { frame, cursor, mouse };
  }
  /** What the frame says under the agent's screen: its step's hint, which
   * the agent's own screen leaves out. */
  hint() {
    if (this.signed) return `${this.label} is setting up. Finish its steps above.`;
    return (
      (this.step && this.signin.hints[this.step]) ||
      `Sign in below, in ${this.label}'s own screens, as the account you're ${this.adding ? "adding" : "signing in to"}.`
    );
  }
}
const keycap = (k: string) => `${palette.keycap} ${k} ${reset}`;
const problems: Record<string, string> = {
  AccountHasProfiles: "Delete this account’s cloned configurations first.",
  AccountManagementUnsupported: "Manage this agent's login in the agent itself.",
  InvalidAccountName: agentName.message + " The account name default is reserved.",
  InvalidAgentName: agentName.message,
  AccountExists: "There's an account by that name already.",
  AccountNotFound: "Corgi doesn't list this account any more.",
  InvalidAgentOptions: "Check the extra flags and environment variables.",
  AccountEnvironmentOverride: "The account's settings directory can't be overridden here.",
};
/** Why Corgi can't start `provider` to sign in, as a sentence. */
function unavailable(provider: Provider, error: unknown): string {
  const a = adapter(provider);
  switch (errors.name(error)) {
    case "ProviderTooOld":
      return `${a.label} ${discovery.outdated(provider) ?? ""} is too old: Corgi needs ${a.label} ${a.requires ?? "updated"}. Update it, then try again.`;
    case "ProviderNotFound":
      return `Corgi couldn't find ${a.label}. Install it, then try again.`;
    default:
      return `${a.label} didn't start: ${errors.name(error) ?? error}`;
  }
}
/** What went wrong making, naming or removing an account, as a sentence. */
export const problem = (error: unknown) => problems[errors.name(error) ?? ""] ?? String(error);

/** A sign-in that adds an account, which signs in straight away once it
 * knows the agent; it asks for one it isn't told. Its name is `name`, or
 * comes from the login. */
export function adding(provider: Provider | null, name: string | null, host: Host): Signin {
  if (provider && !adapter(provider).accounts.signin) throw Error("AccountManagementUnsupported");
  const installed = Provider.all.filter(p => adapter(p).accounts.signin !== null && discovery.installed(p)),
    chosen = provider ?? (installed.length === 1 ? installed[0] : null),
    s = new Signin(true, chosen === null, host);
  s.provider = chosen;
  s.name = name;
  if (chosen === null) s.offer();
  return s;
}
/** Signs `account` out with its agent's own command, and stops what runs
 * from its folder, before Corgi deletes the folder. */
export async function signOut(account: accounts.Known): Promise<void> {
  const a = adapter(account.provider),
    env: Record<string, string | undefined> = { ...process.env, [a.accounts.env]: account.dir };
  if (!a.accounts.signin) throw Error("AccountManagementUnsupported");
  a.unnest?.(env);
  let agent = await discovery.resolve(account.provider);
  if (!agent.includes("/")) agent = Bun.which(agent) ?? agent;
  const logout = a.accounts.signin.logout;
  if (typeof logout === "function") logout(account.dir);
  else await run(agent, logout, env as Record<string, string>, 15000);
  await stopInside([account.dir]);
}
/** Runs `agent` with `args` in `env`, killed after `ms`: its status. */
async function run(agent: string, args: string[], env: Record<string, string>, ms: number): Promise<number> {
  try {
    const child = Bun.spawn([agent, ...args], { env, stdin: "ignore", stdout: "ignore", stderr: "ignore" }),
      timer = setTimeout(() => child.kill("SIGKILL"), ms);
    const status = await child.exited;
    clearTimeout(timer);
    return status;
  } catch {
    return -1;
  }
}
/** A sign-in to an account there is. */
export function signingIn(account: accounts.Known, host: Host): Signin {
  if (!adapter(account.provider).accounts.signin) throw Error("AccountManagementUnsupported");
  const s = new Signin(false, false, host);
  s.provider = account.provider;
  s.name = account.name;
  s.dir = account.dir;
  return s;
}

/** Takes the terminal: its own screen, bracketed paste, no cursor. */
const enter = "\x1b[?1049h\x1b[?25l\x1b[?2004h\x1b[2J";
const mouse_off = "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l";
const mouse_modes: Record<Drawn["mouse"], string> = {
  frame: "\x1b[?1000h\x1b[?1006h",
  agent: "\x1b[?1002h\x1b[?1006h",
  select: mouse_off,
};
const leave = mouse_off + "\x1b[?2004l\x1b[0m\x1b[?25h\x1b[?1049l";
/** Runs `make`'s sign-in in this process's terminal, as `corgi account`
 * does outside Corgi: the whole screen is its box. Starting the agent at
 * the end hands it the terminal. */
async function inTerminal(make: (host: Host) => Signin): Promise<number> {
  let differ: Differ | null = null,
    dirty = true,
    s!: Signin;
  const size = () => ({ cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }),
    status = new Promise<number>(resolve => {
      s = make({
        changed: () => {
          dirty = true;
        },
        done: (code, start, message) => {
          clearInterval(paint);
          process.stdout.write(leave);
          process.stdin.setRawMode(false);
          process.stdin.pause();
          closeReadiness();
          if (message) process.stdout.write(message + "\n");
          // Corgi then finds the agent in its pane, in its account, as if typed.
          if (start) process.execve!(s.agent, [s.agent], s.env());
          resolve(code);
        },
      });
    }),
    paint = setInterval(() => {
      if (!dirty || s.over) return;
      dirty = false;
      const drawn = s.draw(0, 0),
        cursor = drawn.cursor ? `\x1b[${drawn.cursor.y + 1};${drawn.cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
      process.stdout.write(differ!.diff(drawn.frame) + mouse_modes[drawn.mouse] + cursor);
    }, 33);
  const { cols, rows } = size();
  differ = Differ.create(cols, rows);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", data => void s.input(data));
  process.stdout.on("resize", () => {
    const { cols, rows } = size();
    differ?.destroy();
    differ = Differ.create(cols, rows);
    process.stdout.write("\x1b[2J");
    s.resize(cols, rows);
  });
  for (const signal of ["SIGHUP", "SIGTERM"] as const)
    process.on(signal, () => {
      try {
        process.stdout.write(leave);
      } catch {}
      s.abandon();
      process.exit(1);
    });
  process.stdout.write(enter);
  await s.open(cols, rows);
  return status;
}
/** `corgi account add` in a terminal. */
export const add = (provider: Provider | null, name: string | null) => inTerminal(host => adding(provider, name, host));
/** `corgi account login` in a terminal. */
export const login = (account: accounts.Known) => inTerminal(host => signingIn(account, host));
