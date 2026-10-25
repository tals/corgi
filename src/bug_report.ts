//! What `corgi bugreport` and setup's Report a bug put in an issue: the
//! build, the daemon, the system, the terminal the viewer found, its colors,
//! the agents and what they're doing, and the settings that change how Corgi
//! looks and thinks. Paths and logs print locally but stay out of the issue,
//! and nothing leaves the machine until the user submits it.
import * as nodeOs from "node:os";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import * as build_id from "./build_id";
import * as config from "./build_config";
import * as discovery from "./discovery";
import * as errors from "./errors";
import * as km from "./keymap";
import * as palette from "./palette";
import * as preferences from "./preferences";
import * as rpc from "./rpc";
import * as settingsFile from "./settings";
import * as shellPicker from "./shell_picker";
import * as subprocess from "./subprocess";
import * as terminalPalette from "./terminal_palette";
import * as terminalProbe from "./terminal_probe";
import { shellStatus } from "./launch/command";
import { Provider, adapter } from "./providers";
import type { Rgb } from "./palette";
import type { Status } from "./corgi_setup";

export const issues_url = "https://github.com/tals/corgi/issues/new";
/** GitHub turns away longer prefilled links. */
const max_url = 8000;
/** How long anything the report asks may take; past it, the report says it timed out. */
export const timeout_ms = 5000;
const timeout_text = `${timeout_ms / 1000}s`;

export type Hooks = "installed" | "partial" | "missing";
export interface Agent {
  name: string;
  /** Its `--version` line; "" when it didn't answer, null when it timed out. */
  version: string | null;
  path: string;
  /** Installed, but older than Corgi takes. */
  old: boolean;
  /** Installed, but no install answered discovery's `--version`. */
  unanswered: boolean;
  hooks: Hooks | "timeout" | null;
}
/** What takes a moment to find out about the machine. */
export interface System {
  os: string;
  /** `sw_vers` timed out, so `os` names only the kernel. */
  os_timed_out: boolean;
  kernel: string;
  locale: string;
  /** `version` as `Agent`'s: null when `--version` timed out. */
  shell: { path: string; version: string | null };
  agents: Agent[];
}
/** A PTY's window size: its cells, and its pixels, which are 0 where it gave none. */
export interface Pty {
  cols: number;
  rows: number;
  width: number;
  height: number;
}
export interface Tmux {
  version: string;
  passthrough: string;
  clipboard: string;
  timed_out: boolean;
}
/** What a viewer found out about its terminal. */
export interface Terminal {
  /** Where the details came from: "asked directly", "this viewer", "from viewer 2". */
  source: string;
  /** As XTVERSION named it; "" when it didn't. */
  name: string;
  env: Record<string, string>;
  /** The cells Corgi laid out. */
  cols: number;
  rows: number;
  /** Whether the PTY and used sizes were measured at all; a viewer from
   * before they were reported sends neither. */
  measured: boolean;
  /** The PTY's window size, as it said it; null where it couldn't. */
  pty: Pty | null;
  /** The cell in pixels Corgi drew with; null where it had none, or outside a viewer. */
  used: { width: number; height: number } | null;
  graphics: boolean;
  /** How the sidebar's corgi badge drew: "image", "emoji" or "none". */
  badge: string;
  colors: terminalPalette.Colors | null;
  tmux: Tmux | null;
  ssh: boolean;
  answers: terminalProbe.Answers;
}
/** A running agent, for the counts. */
export interface Session {
  provider: string;
  state: string;
  attention: string;
  /** How long ago its last hook came; null before any. */
  hooked_ms: number | null;
  tool: boolean;
  paused: boolean;
  compacting: boolean;
}
export interface Daemon {
  pid: number;
  same_build: boolean;
  release: string;
  uptime_ms: number | null;
  staged: string;
  /** Whether it answers `bugreport` with its load, hooks and viewers'
   * terminals; an older daemon doesn't. */
  extended: boolean;
  layout: { workspaces: number; tabs: number; panes: number };
  sessions: Session[];
  /** Terminals of the viewers other than the reporting one. */
  others: Terminal[];
}
export interface Install {
  path: string;
  /** Null for an install `corgi update` doesn't manage. */
  auto_update: boolean | null;
}
export interface Report {
  corgi: string;
  install: Install;
  system: System;
  daemon: Daemon | null;
  /** What the daemon took but didn't answer in time: its hello, its
   * session list or the report request. */
  slow: { daemon: boolean; sessions: boolean; report: boolean };
  terminal: Terminal | null;
  overrides: string[];
  logs: { server: string; crashes: number };
  warnings: string[];
  /** Clever Corgi as the daemon last published it; null without one. */
  inference: Status | null;
}
/** What the user chose, read when the report is shown. */
export interface Settings {
  theme: string;
  keymap: string;
  clever_corgi: string;
}

/** Everything the report says. The daemon adds what it knows when it runs;
 * `terminal` is the reporting viewer's own, else the last-used viewer's. */
export async function collect(
  socket: string,
  terminal: Terminal | null,
  progress: (step: string) => void = () => {},
): Promise<Report> {
  // A stuck daemon gets its connection closed, which would otherwise keep
  // the CLI from exiting once the report is printed.
  const slow = { daemon: false, sessions: false, report: false },
    ask = async (op: "hello" | "session.list" | "bugreport"): Promise<any> => {
      let connection: rpc.Connection | null = null;
      try {
        connection = new rpc.Connection(socket);
        const reply = await within(connection.call(op), timeout_ms);
        if (reply === null)
          slow[({ hello: "daemon", "session.list": "sessions", bugreport: "report" } as const)[op]] = true;
        return reply;
      } catch {
        return null;
      } finally {
        connection?.close();
      }
    },
    exe = build_id.self();
  progress("Asking Corgi and checking agents");
  // Agents and the OS don't wait for the daemon; only the shell does, to know which.
  const agents = Promise.all(Provider.all.map(agent)),
    os = osName(),
    install = installOf(exe),
    [hello, listed, extra] = await Promise.all([ask("hello"), ask("session.list"), ask("bugreport")]),
    snapshot = listed?.result ?? null,
    viewers: Terminal[] = (extra?.viewers ?? []).flatMap((v: any) => {
      const t = wireTerminal(v?.terminal);
      return t ? [{ ...t, source: `from viewer ${Number(v.id) || "?"}` }] : [];
    }),
    own = terminal ?? viewers[0] ?? null,
    shell = snapshot ? shellPicker.status(snapshot.shell).path : shellStatus().path,
    [system, shell_version] = await Promise.all([
      Promise.all([os, agents]),
      shell ? versionLine(shell) : Promise.resolve(""),
    ]);
  return {
    corgi: build(),
    install: await install,
    system: {
      os: system[0].name,
      os_timed_out: system[0].timed_out,
      kernel: `${nodeOs.type()} ${nodeOs.release()} ${nodeOs.version()} ${nodeOs.machine()}`,
      locale: process.env.LC_ALL || process.env.LC_CTYPE || process.env.LANG || "",
      shell: { path: shell, version: shell_version },
      agents: system[1].filter(a => a !== null),
    },
    daemon: hello
      ? daemonOf(
          hello,
          snapshot,
          extra,
          exe,
          viewers.filter(v => v !== own),
        )
      : null,
    slow,
    terminal: own,
    overrides: overrides(process.env, settingsFile.read(settingsFile.path(socket))),
    logs: { server: join(dirname(socket), "server.log"), crashes: crashes() },
    warnings: warnings(tail(join(dirname(socket), "server.log"))),
    inference: snapshot ? (await import("./corgi_setup")).status(snapshot.inference) : null,
  };
}
function daemonOf(hello: any, snapshot: any, extra: any, exe: string, others: Terminal[]): Daemon {
  const hooks: Record<string, number> = extra?.hooks ?? {},
    panes: any[] = snapshot?.panes ?? [];
  let same = false;
  try {
    same = hello.build_id === build_id.of(exe);
  } catch {}
  return {
    pid: Number(hello.server_pid) || 0,
    same_build: same,
    release: String(hello.release_version ?? ""),
    uptime_ms: typeof extra?.uptime_ms === "number" ? extra.uptime_ms : null,
    staged: String(snapshot?.staged_version ?? ""),
    extended: extra !== null,
    layout: {
      workspaces: snapshot?.workspaces?.length ?? 0,
      tabs: (snapshot?.workspaces ?? []).reduce((n: number, w: any) => n + (w.model?.tabs?.length ?? 0), 0),
      panes: panes.length,
    },
    sessions: panes
      .filter(p => Provider.parse(p.agent?.provider) && !p.exited)
      .map(p => ({
        provider: adapter(Provider.parse(p.agent.provider)!).name,
        state: String(p.agent.state || "unknown"),
        attention: String(p.agent.attention || "none"),
        hooked_ms: hooks[String(p.agent.conversation)] ?? null,
        tool: p.agent.tool_active === true,
        paused: p.agent.paused === true,
        compacting: p.agent.compacting === true,
      })),
    others,
  };
}
/** A terminal as a viewer reported it to the daemon, or null for nothing usable. */
export function wireTerminal(value: unknown): Terminal | null {
  if (!value || typeof value !== "object") return null;
  const v = value as any,
    a = v.answers ?? {},
    rgb = (c: unknown): Rgb | null =>
      Array.isArray(c) && c.length === 3 && c.every(n => typeof n === "number") ? (c as Rgb) : null,
    strings = (o: unknown) =>
      Object.fromEntries(Object.entries(o && typeof o === "object" ? o : {}).filter(([, s]) => typeof s === "string"));
  const fg = rgb(v.colors?.foreground),
    bg = rgb(v.colors?.background);
  return {
    source: typeof v.source === "string" ? v.source : "",
    name: typeof v.name === "string" ? v.name : "",
    env: strings(v.env),
    cols: Number(v.cols) || 0,
    rows: Number(v.rows) || 0,
    measured: "pty" in v,
    pty:
      v.pty && typeof v.pty === "object"
        ? {
            cols: Number(v.pty.cols) || 0,
            rows: Number(v.pty.rows) || 0,
            width: Number(v.pty.width) || 0,
            height: Number(v.pty.height) || 0,
          }
        : null,
    used: v.used && Number(v.used.width) > 0 ? { width: Number(v.used.width), height: Number(v.used.height) } : null,
    graphics: v.graphics === true,
    badge: typeof v.badge === "string" ? v.badge : "none",
    colors:
      fg && bg
        ? { foreground: fg, background: bg, ansi: Array.from({ length: 16 }, (_, i) => rgb(v.colors.ansi?.[i])) }
        : null,
    tmux:
      v.tmux && typeof v.tmux.version === "string"
        ? { ...(strings(v.tmux) as unknown as Tmux), timed_out: v.tmux.timed_out === true }
        : null,
    ssh: v.ssh === true,
    answers: {
      answered: a.answered === true,
      da1: Array.isArray(a.da1) ? a.da1.filter((n: unknown) => typeof n === "number") : [],
      da2: typeof a.da2 === "string" ? a.da2 : "",
      modes: Object.fromEntries(
        Object.entries(a.modes && typeof a.modes === "object" ? a.modes : {}).filter(([, n]) => typeof n === "number"),
      ) as Record<string, number>,
      keyboard: typeof a.keyboard === "number" ? a.keyboard : null,
      window: a.window && Number(a.window.width) > 0 ? { width: a.window.width, height: a.window.height } : null,
      cell: a.cell && Number(a.cell.width) > 0 ? { width: Number(a.cell.width), height: Number(a.cell.height) } : null,
      font: typeof a.font === "string" ? a.font : "",
      undercurl: a.undercurl === true,
      widths: (Array.isArray(a.widths) ? a.widths : []).map((w: any) => ({
        kind: String(w?.kind ?? ""),
        text: String(w?.text ?? ""),
        expected: typeof w?.expected === "number" ? w.expected : null,
        got: typeof w?.got === "number" ? w.got : null,
      })),
      replies: (Array.isArray(a.replies) ? a.replies : []).filter((s: unknown) => typeof s === "string"),
    },
  };
}
/** Whether there's a terminal to ask: not in a Corgi pane, whose terminal
 * is Corgi's own, and with a terminal on both ends. */
export function canAsk(env: Record<string, string | undefined> = process.env): boolean {
  return env.CORGI_PANE === undefined && process.stdin.isTTY === true && process.stdout.isTTY === true;
}
/** Asks the terminal `corgi bugreport` runs in what the viewer asks its own,
 * drawing the width samples on the cursor's line. Null in a Corgi pane,
 * whose terminal is Corgi's own, and without a terminal to ask. */
export async function here(env: Record<string, string | undefined> = process.env): Promise<Terminal | null> {
  const stdin = process.stdin,
    stdout = process.stdout;
  if (!canAsk(env)) return null;
  const [{ Probe }, corgiBadge] = await Promise.all([import("./host_probe"), import("./corgi_badge")]),
    probe = new Probe(),
    listen = (bytes: Buffer) => void probe.feed(bytes);
  stdin.setRawMode(true);
  stdin.on("data", listen);
  stdin.resume();
  try {
    // Colors, XTVERSION and Kitty graphics first: their answers come before
    // the device attributes that end the probe's questions.
    stdout.write(probe.query() + "\x1b[>0q" + corgiBadge.query + probe.terminal.start(null, Date.now()));
    while (!probe.terminal.done) {
      await Bun.sleep(10);
      probe.expire(Date.now());
    }
  } finally {
    stdin.off("data", listen);
    stdin.setRawMode(false);
    stdin.pause();
  }
  const { foreground, background, palette } = probe.theme,
    rgb = (c: { r: number; g: number; b: number } | null): Rgb | null => (c ? [c.r, c.g, c.b] : null);
  return {
    source: "asked directly",
    name: probe.clipboard.terminal.text(),
    env: terminalEnv(env),
    cols: stdout.columns,
    rows: stdout.rows,
    measured: true,
    pty: await ptyHere(),
    used: null,
    graphics: probe.badge.supports_kitty_graphics,
    badge: "",
    colors:
      foreground && background
        ? { foreground: rgb(foreground)!, background: rgb(background)!, ansi: palette.map(rgb) }
        : null,
    tmux: await tmuxOf(env),
    ssh: ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"].some(k => !!env[k]),
    answers: probe.terminal.answers,
  };
}
/** The PTY's window size as it says it to the CLI; null where it can't. */
async function ptyHere(): Promise<Pty | null> {
  try {
    const { n, ptr } = await import("./native_ffi"),
      size = new Uint16Array(4);
    if (n.probe_winsize_pixels(0, ptr(size)) !== 0) return null;
    return { cols: size[0], rows: size[1], width: size[2], height: size[3] };
  } catch {
    return null;
  }
}
/** "200×55 cells, 3200×1870 px", or what's missing: each source on its own,
 * so a PTY that gives no pixels never reads like one that does. */
function ptyText(p: Pty | null): string {
  if (p === null) return "didn't say";
  return `${p.cols}×${p.rows} cells, ${p.width && p.height ? `${p.width}×${p.height} px` : "no pixel size"}`;
}
function queriedText(a: terminalProbe.Answers): string {
  const px = (s: { width: number; height: number } | null) => (s ? `${s.width}×${s.height} px` : "no answer");
  return `cell ${px(a.cell)}, window ${px(a.window)}`;
}
function usedText(t: Terminal): string {
  return t.used ? `${t.used.width}×${t.used.height} px per cell` : "no cell size";
}
/** The variables that say which terminal this is and what sits between. */
const terminal_env = [
  "TERM",
  "COLORTERM",
  "TERM_PROGRAM",
  "TERM_PROGRAM_VERSION",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMUX",
  "STY",
  "ZELLIJ",
  "SSH_CONNECTION",
  "SSH_TTY",
  "KITTY_WINDOW_ID",
  "WEZTERM_PANE",
  "VTE_VERSION",
  "WT_SESSION",
  "KONSOLE_VERSION",
];
export function terminalEnv(env: Record<string, string | undefined>): Record<string, string> {
  return Object.fromEntries(terminal_env.flatMap(k => (env[k] ? [[k, env[k]!]] : [])));
}
/** tmux's version and the options that decide whether images and copies get through. */
export async function tmuxOf(env: Record<string, string | undefined>): Promise<Tmux | null> {
  if (!env.TMUX) return null;
  let timed_out = false;
  const run = async (args: string[]) => {
    try {
      const out = await subprocess.run(["tmux", ...args], { timeout_ms, max_output: 4096 });
      return out.ok() ? firstLine(out.stdout.toString()) : "";
    } catch (error) {
      if (errors.is(error, "TimedOut")) timed_out = true;
      return "";
    }
  };
  const [version, passthrough, clipboard] = await Promise.all([
    run(["-V"]),
    run(["show-options", "-gqv", "allow-passthrough"]),
    run(["show-options", "-gqv", "set-clipboard"]),
  ]);
  return { version, passthrough, clipboard, timed_out };
}

/** "macOS 15.1 (24B83)" or os-release's name, "Ubuntu 24.04.1 LTS". */
async function osName(): Promise<{ name: string; timed_out: boolean }> {
  if (process.platform === "darwin") {
    let timed_out = false;
    try {
      const out = await subprocess.run(["sw_vers"], { timeout_ms, max_output: 4096 });
      const field = (name: string) => new RegExp(`^${name}:\\s*(.+)$`, "m").exec(out.stdout.toString())?.[1].trim();
      const name = field("ProductName"),
        version = field("ProductVersion"),
        build = field("BuildVersion");
      if (name && version) return { name: `${name} ${version}${build ? ` (${build})` : ""}`, timed_out };
    } catch (error) {
      timed_out = errors.is(error, "TimedOut");
    }
    return { name: `macOS (Darwin ${nodeOs.release()})`, timed_out };
  }
  return {
    name: osRelease(readText("/etc/os-release") ?? readText("/usr/lib/os-release") ?? "") ?? nodeOs.type(),
    timed_out: false,
  };
}
/** os-release's pretty name, with its build when it has one. */
export function osRelease(text: string): string | null {
  const fields = new Map<string, string>();
  for (const line of text.split("\n")) {
    const m = /^([A-Z_]+)=(.*)$/.exec(line.trim());
    if (m) fields.set(m[1], m[2].replace(/^(["'])(.*)\1$/, "$2"));
  }
  const name =
    fields.get("PRETTY_NAME") ?? ([fields.get("NAME"), fields.get("VERSION")].filter(Boolean).join(" ") || null);
  if (name === null) return null;
  const build = fields.get("BUILD_ID");
  return build && !name.includes(build) ? `${name} (${build})` : name;
}
function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}
/** The last `bytes` of a file, which may be a log too big to read whole;
 * "" when it can't be read. */
export function tail(path: string, bytes = 65536): string {
  let fd: number | null = null;
  try {
    fd = openSync(path, "r");
    const size = fstatSync(fd).size,
      buffer = Buffer.alloc(Math.min(size, bytes));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
/** The promise's value if it settles within `ms`, else null. */
async function within<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<null>(resolve => (timer = setTimeout(resolve, ms, null)));
  try {
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}
/** The first line `path --version` prints, "" when it doesn't answer, or
 * null when it took too long. */
async function versionLine(path: string): Promise<string | null> {
  try {
    const out = await subprocess.run([path, "--version"], { timeout_ms, max_output: 4096 });
    return out.ok() ? firstLine(out.stdout.toString()) : "";
  } catch (error) {
    return errors.is(error, "TimedOut") ? null : "";
  }
}
/** The first line with text, without the escapes and controls a program may
 * print, which would draw over setup; a runaway one is cut short. */
export function firstLine(output: string): string {
  const line =
    output
      .replace(/\x1b(\[[0-?]*[ -\/]*[@-~]|\][^\x07\x1b]*(\x07|\x1b\\)?|[@-Z\\-_])/g, "")
      .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "")
      .split("\n")
      .find(line => line.trim())
      ?.trim() ?? "";
  return line.length > 120 ? line.slice(0, 119) + "…" : line;
}
/** The install Corgi would launch for `provider`, or null when there is none. */
async function agent(provider: Provider): Promise<Agent | null> {
  const name = adapter(provider).name;
  let path: string;
  try {
    path = await discovery.resolve(provider);
  } catch (error) {
    if (errors.is(error, "ProviderTooOld"))
      return { name, version: discovery.outdated(provider) ?? "", path: "", old: true, unanswered: false, hooks: null };
    // Installs that never said which they were: slow, or failing.
    const silent = discovery.considered(provider).find(c => c.ok === null);
    return silent ? { name, version: "", path: silent.path, old: false, unanswered: true, hooks: null } : null;
  }
  if (!path.includes("/")) {
    const found = discovery.onPath(path);
    if (found === null) return null;
    path = found;
  }
  const [version, hooks] = await Promise.all([versionLine(path), hooksOf(provider)]);
  return { name, version, path, old: false, unanswered: false, hooks };
}
/** Whether the default account reports to Corgi, as `corgi integration status` says. */
async function hooksOf(provider: Provider): Promise<Hooks | "timeout" | null> {
  try {
    const steps = await within(adapter(provider).integration.status(""), timeout_ms);
    if (steps === null) return "timeout";
    const hooks = steps.find(step => step.item === "hooks");
    if (!hooks) return null;
    return hooks.outcome === "present" ? "installed" : hooks.outcome === "partial" ? "partial" : "missing";
  } catch {
    return null;
  }
}
async function installOf(exe: string): Promise<Install> {
  let auto_update: boolean | null = null;
  try {
    const updates = await import("./updates"),
      root = updates.managed(updates.release(exe), exe);
    if (root !== null) auto_update = !existsSync(join(root, "auto-off"));
  } catch {}
  return { path: exe, auto_update };
}
/** `CORGI_*` variables the user set, leaving out the ones panes and updates
 * set themselves, and what settings.json holds. */
export function overrides(env: Record<string, string | undefined>, saved: Record<string, unknown>): string[] {
  const own = new Set(["CORGI_PANE", "CORGI_BIN", "CORGI_APP_EXE", "CORGI_HANDOFF_RESERVED_FDS"]);
  if (env.CORGI_PANE !== undefined) own.add("CORGI_SOCKET");
  return [
    ...Object.keys(env)
      .filter(k => k.startsWith("CORGI_") && !own.has(k) && env[k] !== undefined)
      .sort()
      .map(k => `${k}=${tilde(env[k]!)}`),
    ...Object.entries(saved).map(
      ([k, v]) => `settings.json ${k}=${typeof v === "string" ? tilde(v) : JSON.stringify(v)}`,
    ),
  ];
}
/** Crash reports waiting to be sent. */
function crashes(): number {
  try {
    return readdirSync(join(dirname(preferences.path()), "crash", "outbox")).length;
  } catch {
    return 0;
  }
}
/** The last few distinct warnings and errors in server.log, newest last,
 * repeats counted. */
export function warnings(log: string, limit = 5): string[] {
  const counts = new Map<string, number>();
  for (const line of log.split("\n"))
    if (/^(warn|warning|error)(\([^)]*\))?:/.test(line)) {
      const text = firstLine(line),
        seen = counts.get(text) ?? 0;
      // Moved to the end, so the newest come last.
      counts.delete(text);
      counts.set(text, seen + 1);
    }
  return [...counts].slice(-limit).map(([text, n]) => (n > 1 ? `${text} (×${n})` : text));
}

/** The theme in use, and whether the user picked it or the terminal did;
 * `shown` is null where no terminal said which. */
export function theme(picked: palette.Theme | undefined, shown: palette.Theme | null): string {
  if (picked !== undefined) return palette.themes[picked].label;
  return shown === null ? "automatic" : `${palette.themes[shown].label} (automatic)`;
}
/** The theme the terminal's colors pick when the user didn't, as `palette.chosen` does. */
export function automatic(colors: terminalPalette.Colors | null): palette.Theme | null {
  return colors ? (terminalPalette.light(colors) ? "animal_style" : "corgi") : null;
}
export function keymap(prefs: preferences.Preferences): string {
  return `${km.name(prefs.preset)} (prefix ${km.prefixName(prefs.prefix)})`;
}
/** Which model answers Clever Corgi, and how it was chosen. */
export function cleverCorgi(s: Status): string {
  if (!s.uses.activity && !s.uses.worktrees) return "Off";
  const chosen = s.choice === "auto" ? "auto" : "chosen";
  if (s.provider === null || !s.model) return s.loading ? `finding a model (${chosen})` : `no model (${chosen})`;
  return `${adapter(s.provider).name} · ${s.model} (${chosen})`;
}

/** "0.1.0-dev (be82c7b), built 2026-09-25T18:30:12Z, linux-x64". */
export function build(): string {
  return [
    `${config.releaseVersion} (${config.releaseCommit})`,
    ...(config.builtAt ? [`built ${config.builtAt}`] : []),
    `${process.platform}-${process.arch}`,
  ].join(", ");
}
/** A path under the home folder as ~/…, which keeps the user's name out of the issue. */
export function tilde(path: string, home = process.env.HOME ?? ""): string {
  return home && (path === home || path.startsWith(home + "/")) ? "~" + path.slice(home.length) : path;
}
/** "3h 12m", "5m", "40s". */
export function span(ms: number): string {
  const s = Math.floor(ms / 1000),
    d = Math.floor(s / 86400),
    h = Math.floor(s / 3600) % 24,
    m = Math.floor(s / 60) % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  return m ? `${m}m` : `${s}s`;
}
export const hex = (c: Rgb) => "#" + c.map(n => n.toString(16).padStart(2, "0")).join("");
/** The ANSI colors' names, slot by slot. */
const slot_names = [
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "bright black",
  "bright red",
  "bright green",
  "bright yellow",
  "bright blue",
  "bright magenta",
  "bright cyan",
  "bright white",
];
/** Where each hue sits in OKLCH, for the slots that carry one. */
const hues: [string, number][] = [
  ["red", 25],
  ["orange", 60],
  ["yellow", 100],
  ["green", 145],
  ["cyan", 200],
  ["blue", 260],
  ["magenta", 330],
];
const slot_hues: Record<number, number> = { 1: 25, 2: 145, 3: 100, 4: 260, 5: 330, 6: 200 };
const around = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b));
const ratio = (n: number) => `${n.toFixed(1)}:1`;
const count = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
/** "red", "red or green", "red, yellow or green". */
const spoken = (names: string[]) =>
  names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;

/** What stands out about a terminal's colors: what readers would otherwise
 * work out from the hex values. Empty for an ordinary palette; contrast
 * counts only where it's hard to read, so low-contrast themes like
 * Solarized pass. */
export function colorNotes(c: terminalPalette.Colors): string[] {
  const notes: string[] = [],
    ansi = c.ansi,
    dark = !terminalPalette.light(c),
    same = [0, 1, 2, 3, 4, 5, 6, 7].filter(i => ansi[i] && ansi[i + 8] && hex(ansi[i]!) === hex(ansi[i + 8]!)).length;
  if (same >= 3) notes.push(`bright = normal (${same} of 8)`);
  const fg = terminalPalette.contrast(c.foreground, c.background);
  if (fg < 3) notes.push(`text ${ratio(fg)} on the background`);
  // The black or white that matches the background blends in by design, and
  // bright black is dim on purpose: it only counts when it all but vanishes.
  const blend = dark ? [0] : [7, 15],
    low = ansi
      .flatMap((color, i) =>
        color && !blend.includes(i) ? [{ i, contrast: terminalPalette.contrast(color, c.background) }] : [],
      )
      .filter(x => x.contrast < (x.i === 8 ? 1.5 : 2))
      .sort((a, b) => a.contrast - b.contrast);
  if (low.length)
    notes.push(
      `low contrast: ${low
        .slice(0, 3)
        .map(x => `${slot_names[x.i]} ${ratio(x.contrast)}`)
        .join(", ")}${low.length > 3 ? `, ${low.length - 3} more` : ""}`,
    );
  for (const [slot, center] of Object.entries(slot_hues)) {
    const color = ansi[Number(slot)];
    if (!color) continue;
    const h = terminalPalette.hue(color);
    if (h.gray || around(h.hue, center) <= 60) continue;
    const nearest = hues.reduce((best, next) => (around(h.hue, next[1]) < around(h.hue, best[1]) ? next : best));
    notes.push(`${slot_names[Number(slot)]} slot is ${nearest[0]}`);
  }
  const gray = [1, 2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14].filter(i => ansi[i] && terminalPalette.hue(ansi[i]!).gray);
  if (gray.length >= 9) notes.push(`mostly gray (${gray.length} of 12 colors)`);
  const supplied = terminalPalette.supplied(ansi),
    missing = (["hot", "warm", "accent"] as const)
      .filter(s => !supplied[s])
      .map(s => ({ hot: "red", warm: "yellow", accent: "green" })[s]);
  if (missing.length) notes.push(`no usable ${spoken(missing)} (Animal Style uses its own)`);
  return notes;
}
/** The samples the terminal drew at another width than Corgi lays them out at. */
export function widthMismatches(t: Terminal): terminalProbe.Width[] {
  return t.answers.widths.filter(w => w.expected !== null && w.got !== null && w.got !== w.expected);
}
/** Whether the terminal needs a closer look: the full report goes with the issue. */
export function flagged(t: Terminal | null): boolean {
  if (t === null) return false;
  return !t.answers.answered || t.colors === null || widthMismatches(t).length > 0 || colorNotes(t.colors).length > 0;
}
const supported = (n: number | undefined) => n === 1 || n === 2 || n === 3;

/** "35 running: Codex 21 (20 idle, 1 unknown), Claude 14 (13 idle, 1 working);
 * last hook 4s ago, 3 without hooks since start". */
export function sessionStats(d: Daemon): string {
  const by = new Map<string, Map<string, number>>();
  for (const x of d.sessions) {
    const states = by.get(x.provider) ?? new Map<string, number>();
    states.set(x.state, (states.get(x.state) ?? 0) + 1);
    by.set(x.provider, states);
  }
  const agents = [...by].map(([provider, states]) => {
      const total = [...states.values()].reduce((a, b) => a + b, 0),
        parts = [...states].sort((a, b) => b[1] - a[1]).map(([state, n]) => `${n} ${state}`);
      return `${provider} ${total} (${parts.join(", ")})`;
    }),
    out = `${d.sessions.length} running: ${agents.join(", ")}`;
  if (!d.extended) return out;
  const heard = d.sessions.flatMap(x => (x.hooked_ms === null ? [] : [x.hooked_ms])),
    silent = d.sessions.length - heard.length;
  if (!heard.length) return `${out}; no hooks since start`;
  return `${out}; last hook ${span(Math.min(...heard))} ago${silent ? `, ${silent} without hooks since start` : ""}`;
}
/** A row of the report; `local` rows print but stay out of the issue. */
export interface Row {
  label: string;
  value: string;
  depth: number;
  local: boolean;
}
export function rows(r: Report, s: Settings): Row[] {
  const out: Row[] = [],
    add = (label: string, value: string, depth = 0, local = false) => out.push({ label, value, depth, local }),
    d = r.daemon;
  add("Corgi", r.corgi);
  if (d)
    add(
      "Daemon",
      [
        d.same_build ? "same build" : `other build${d.release ? ` (${d.release})` : ""}`,
        `pid ${d.pid}`,
        ...(d.uptime_ms !== null ? [`up ${span(d.uptime_ms)}`] : []),
      ].join(", ") + (r.slow.report ? ` (the report request timed out after ${timeout_text})` : ""),
    );
  else add("Daemon", r.slow.daemon ? `not answering (no reply in ${timeout_text})` : "not running");
  add(
    "Install",
    [
      tilde(r.install.path),
      ...(r.install.auto_update !== null ? [`auto-update ${r.install.auto_update ? "on" : "off"}`] : []),
      ...(d?.staged ? [`update staged (${d.staged})`] : []),
    ].join(", "),
  );
  add("OS", r.system.os + (r.system.os_timed_out ? `, sw_vers timed out after ${timeout_text}` : ""));
  add("Kernel", r.system.kernel);
  add(
    "Shell",
    !r.system.shell.path
      ? "unknown"
      : r.system.shell.version === null
        ? `${tilde(r.system.shell.path)}, --version timed out after ${timeout_text}`
        : `${r.system.shell.version || "version unknown"} (${tilde(r.system.shell.path)})`,
  );
  const env = r.terminal?.env ?? {},
    locale = env.LC_ALL || env.LC_CTYPE || env.LANG || r.system.locale;
  if (locale) add("Locale", locale);
  if (r.terminal === null)
    add(
      "Terminal",
      r.slow.daemon || r.slow.report
        ? `unknown, the daemon didn't answer in ${timeout_text}`
        : d === null
          ? "unknown, Corgi isn't running"
          : d.extended
            ? "no viewer attached"
            : "unknown, the daemon is an older build",
    );
  else terminalRows(r.terminal, add);
  if (d?.others.length)
    add(
      "Other viewers",
      `${d.others.length} (${d.others.map(t => `${t.source}: ${t.name.split(" ")[0] || "unnamed"}, ${t.cols}×${t.rows}`).join("; ")})`,
    );
  if (r.system.agents.length) {
    add("Agents", "");
    for (const a of r.system.agents) add(a.name, agentText(a), 1);
  } else add("Agents", "none found");
  if (r.slow.sessions) add("Sessions", `timed out after ${timeout_text}`);
  else if (d?.sessions.length) add("Sessions", sessionStats(d));
  if (d && !r.slow.sessions)
    add(
      "Layout",
      [count(d.layout.workspaces, "workspace"), count(d.layout.tabs, "tab"), count(d.layout.panes, "pane")].join(", "),
    );
  add("Settings", `theme ${s.theme}, keymap ${s.keymap}, Clever Corgi ${s.clever_corgi}`);
  if (r.overrides.length) add("Overrides", r.overrides.join("; "));
  add("Logs", `${tilde(r.logs.server)}${r.logs.crashes ? `, ${count(r.logs.crashes, "crash report")} pending` : ""}`);
  const late = timeouts(r);
  if (late.length) add("Timed out", late.join(", "));
  if (r.warnings.length) {
    add("Recent warnings", "", 0, true);
    for (const w of r.warnings) add("", w, 1, true);
  }
  return out;
}
function agentText(a: Agent): string {
  if (a.old) return `${a.version || "version unknown"}, too old for Corgi`;
  if (a.unanswered) return `found (${tilde(a.path)}) but it didn't answer --version`;
  const version = a.version === null ? `--version timed out after ${timeout_text}` : a.version || "version unknown";
  return [
    `${version} (${tilde(a.path)})`,
    ...(a.hooks === "timeout" ? [`hooks check timed out after ${timeout_text}`] : a.hooks ? [`hooks ${a.hooks}`] : []),
  ].join(", ");
}
/** Everything the report waited on and gave up on, in one place. */
export function timeouts(r: Report): string[] {
  const t = r.terminal;
  return [
    ...(r.slow.daemon ? ["daemon"] : r.slow.sessions ? ["daemon session list"] : []),
    ...(r.slow.report && !r.slow.daemon ? ["daemon report request"] : []),
    ...(t && !t.answers.answered ? ["terminal"] : []),
    ...(t?.tmux?.timed_out ? ["tmux options"] : []),
    ...(r.system.os_timed_out ? ["sw_vers"] : []),
    ...(r.system.shell.version === null ? ["shell --version"] : []),
    ...r.system.agents.flatMap(a => [
      ...(a.version === null ? [`${a.name} --version`] : []),
      ...(a.hooks === "timeout" ? [`${a.name} hooks`] : []),
    ]),
  ];
}
function terminalRows(t: Terminal, add: (label: string, value: string, depth?: number) => void) {
  const a = t.answers,
    env = ["TERM", "COLORTERM", "TERM_PROGRAM"].flatMap(k => (t.env[k] ? [`${k}=${t.env[k]}`] : []));
  add("Terminal", t.source);
  add("Name", t.name || "didn't say", 1);
  if (env.length) add("Env", env.join(", "), 1);
  add("Size", `${t.cols}×${t.rows} cells`, 1);
  add("PTY", t.measured ? ptyText(t.pty) : "not reported by this viewer's build", 1);
  if (a.answered) add("Queried", queriedText(a), 1);
  if (t.source !== "asked directly")
    add("Corgi used", t.measured ? usedText(t) : "not reported by this viewer's build", 1);
  if (a.font) add("Font", a.font, 1);
  if (!a.answered) add("Replies", `none; it didn't answer Corgi's questions in ${timeout_text}`, 1);
  else {
    const off = widthMismatches(t),
      drawn = a.widths.filter(w => w.expected === null && w.got !== null),
      clusters = a.modes["2027"];
    add(
      "Widths",
      [
        off.length ? off.map(w => `${w.kind} is ${w.got} wide here, Corgi expects ${w.expected}`).join("; ") : "match",
        ...(drawn.length ? [drawn.map(w => `${w.kind} ${w.got}`).join(", ")] : []),
        ...(clusters !== undefined ? [`grapheme clusters ${clusters === 1 || clusters === 3 ? "on" : "off"}`] : []),
      ].join("; "),
      1,
    );
    add(
      "Keyboard",
      [
        a.keyboard === null ? "legacy" : a.keyboard ? `kitty protocol (flags ${a.keyboard})` : "kitty protocol (off)",
        ...(supported(a.modes["2004"]) ? ["bracketed paste"] : []),
      ].join(", "),
      1,
    );
    const output = [
      ...(supported(a.modes["2026"]) ? ["synchronized updates"] : []),
      ...(supported(a.modes["1006"]) ? ["SGR mouse"] : []),
      ...(supported(a.modes["1004"]) ? ["focus events"] : []),
      ...(supported(a.modes["2031"]) ? ["color scheme reports"] : []),
      ...(a.undercurl ? ["undercurl"] : []),
    ];
    if (output.length) add("Output", output.join(", "), 1);
  }
  add(
    "Images",
    [
      t.graphics ? "Kitty graphics" : "no Kitty graphics",
      ...(a.da1.includes(4) ? ["Sixel"] : []),
      ...(t.badge === "image" || t.badge === "emoji" ? [`badge drawn as ${t.badge}`] : []),
    ].join(", "),
    1,
  );
  const between = [
    ...(t.tmux
      ? [
          t.tmux.timed_out
            ? `${t.tmux.version || "tmux"} (options timed out after ${timeout_text})`
            : `${t.tmux.version || "tmux"} (allow-passthrough ${t.tmux.passthrough || "unset"}, set-clipboard ${t.tmux.clipboard || "unset"})`,
        ]
      : []),
    ...(t.env.STY ? ["screen"] : []),
    ...(t.env.ZELLIJ ? ["Zellij"] : []),
    ...(t.ssh ? ["SSH"] : []),
  ];
  if (between.length) add("Between", between.join(", "), 1);
  const c = t.colors;
  if (!c) return add("Colors", "not reported");
  add("Colors", `${terminalPalette.light(c) ? "light" : "dark"}, fg ${hex(c.foreground)}, bg ${hex(c.background)}`);
  const line = (from: number) =>
    c.ansi
      .slice(from, from + 8)
      .map(x => (x ? hex(x) : "?"))
      .join(" ");
  add("normal", line(0), 1);
  add("bright", line(8), 1);
  const notes = colorNotes(c);
  if (notes.length) add("notes", notes.join(", "), 1);
}
/** The report as a Markdown list, which reads the same in a terminal and an
 * issue; `issue` leaves out the local rows. */
export function text(r: Report, s: Settings, issue = false): string {
  const shown = rows(r, s).filter(row => !issue || !row.local);
  return (
    shown
      .map(
        row =>
          `${"  ".repeat(row.depth)}- ${row.label}${row.label && row.value ? ": " : row.label ? ":" : ""}${row.value}`,
      )
      .join("\n") + "\n"
  );
}
/** A new issue on GitHub with the report filled in under a place for what
 * happened; null when it's too long for GitHub, for the plain new-issue page. */
export function issueUrl(r: Report, s: Settings, attached = false): string | null {
  const body = [
      "### What happened?",
      "",
      "<!-- What you did, what you expected, and what Corgi did instead. -->",
      "",
      "### Environment",
      "",
      text(r, s, true),
      ...(attached ? ["<!-- Please attach full_bug_report.txt. -->", ""] : []),
    ].join("\n"),
    url = `${issues_url}?body=${encodeURIComponent(body)}`;
  return url.length <= max_url ? url : null;
}
/** Where the full report is written. */
export function fullPath(): string {
  return join(dirname(preferences.path()), "full_bug_report.txt");
}
/** What only the full report holds, gathered when it's written. */
export interface Extras {
  /** Each agent's installs as discovery found them, and the one it took. */
  discovery: { name: string; chosen: string; candidates: ReturnType<typeof discovery.considered> }[];
  path: string;
  /** `corgi integration status`, for every account. */
  hooks: string[];
  /** `corgi update status`. */
  updates: string[];
  settings: string;
  preferences: string;
  warnings: string[];
}
export async function extras(r: Report, socket: string): Promise<Extras> {
  const home = process.env.HOME ?? "",
    scrub = (text: string) => (home ? text.split(home).join("~") : text);
  let hooks: string[] = [],
    updates: string[] = [],
    prefs = "";
  try {
    hooks = (await within((await import("./integration")).status(), timeout_ms)) ?? [
      `(timed out after ${timeout_text})`,
    ];
  } catch {}
  try {
    const u = await import("./updates"),
      root = u.managed(u.release(r.install.path), r.install.path);
    updates = root === null ? ["not an install `corgi update` manages"] : u.state(root);
  } catch {}
  try {
    prefs = readText(preferences.path()) ?? "";
  } catch {}
  return {
    discovery: Provider.all.map(p => {
      const chosen = r.system.agents.find(a => a.name === adapter(p).name);
      return {
        name: adapter(p).name,
        chosen: chosen?.path ?? "",
        // Discovery asks only providers it checks; the report asked the one it took.
        candidates: discovery
          .considered(p)
          .map(c => (c.version === null && c.path === chosen?.path ? { ...c, version: chosen.version || null } : c)),
      };
    }),
    path: scrub(process.env.PATH ?? ""),
    hooks,
    updates,
    settings: scrub(readText(settingsFile.path(socket)) ?? ""),
    preferences: scrub(prefs),
    warnings: warnings(tail(r.logs.server, 1 << 20), 50),
  };
}
/** Everything the report knows, for a bug that needs a closer look: the
 * report itself, every viewer's terminal in full, each session's state,
 * how discovery chose each agent, hooks, updates, settings, and the latest
 * warnings and errors. */
export function full(r: Report, s: Settings, x: Extras, now = new Date()): string {
  const out = [`# Corgi bug report, ${r.corgi}, ${now.toISOString()}`, "", "## Report", "", text(r, s).trimEnd(), ""];
  out.push("## Terminal", ...(r.terminal ? terminalSection(r.terminal) : ["", "(none)"]), "");
  (r.daemon?.others ?? []).forEach((t, i) => out.push(`## Other viewer ${i + 1}`, ...terminalSection(t), ""));
  const d = r.daemon;
  if (d?.sessions.length) {
    out.push("## Sessions", "");
    for (const x of d.sessions)
      out.push(
        [
          x.provider.padEnd(8),
          x.state.padEnd(8),
          `attention ${x.attention}`,
          ...(d.extended ? [x.hooked_ms === null ? "no hooks since start" : `last hook ${span(x.hooked_ms)} ago`] : []),
          ...(x.tool ? ["tool running"] : []),
          ...(x.paused ? ["paused"] : []),
          ...(x.compacting ? ["compacting"] : []),
        ].join("  "),
      );
    out.push("");
  }
  out.push("## Agents", "");
  for (const a of x.discovery) {
    out.push(`${a.name}:`);
    if (!a.candidates.length) out.push("  none found");
    for (const c of a.candidates)
      out.push(
        `  ${tilde(c.path)}  ${c.version ?? "not asked"}${c.ok === false ? "  turned down" : ""}${c.path === a.chosen ? "  ← chosen" : ""}`,
      );
  }
  out.push(`PATH=${x.path}`, "");
  const block = (title: string, lines: string[], empty: string) =>
    out.push(`## ${title}`, "", ...(lines.length ? lines : [empty]), "");
  block("Hooks", x.hooks, "(unknown)");
  block("Updates", x.updates, "(unknown)");
  block("settings.json", x.settings.trim() ? x.settings.trimEnd().split("\n") : [], "(none)");
  block("viewer.json", x.preferences.trim() ? x.preferences.trimEnd().split("\n") : [], "(none)");
  block("Warnings and errors", x.warnings, "(none)");
  return out.join("\n");
}
/** A terminal in full: its environment, its replies as they came, each
 * width, its colors as it reported them and as Animal Style derives them,
 * and their contrast. */
function terminalSection(t: Terminal): string[] {
  const out = ["", "### Environment"];
  // That it's over SSH matters, not the addresses.
  for (const [k, v] of Object.entries(t.env))
    out.push(`${k}=${k === "SSH_CONNECTION" || k === "SSH_CLIENT" ? "(set)" : v}`);
  out.push("", "### Replies, as the terminal sent them");
  out.push(...(t.answers.replies.length ? t.answers.replies : ["(none)"]));
  out.push(
    `XTVERSION ${t.name || "(none)"}`,
    `font ${t.answers.font || "unknown"}`,
    "",
    // Each source on its own: a PTY without pixels mustn't read like one with.
    "### Sizes, by where they came from",
    `laid out  ${t.cols}×${t.rows} cells`,
    `pty       ${t.measured ? ptyText(t.pty) : "not reported by this viewer's build"}`,
    `queried   ${t.answers.answered ? queriedText(t.answers) : "no answers"}`,
    `used      ${t.source === "asked directly" ? "not a viewer" : t.measured ? usedText(t) : "not reported by this viewer's build"}`,
    "",
    // The characters go last: whatever shows this file draws them at its own widths.
    "### Widths (Corgi's, the terminal's, then the characters)",
  );
  for (const w of t.answers.widths)
    out.push(
      `${w.kind.padEnd(19)}${String(w.expected ?? "-").padEnd(3)}${String(w.got ?? "?").padEnd(3)}${JSON.stringify(w.text)}${w.expected !== null && w.got !== null && w.got !== w.expected ? "  ← differs" : ""}`,
    );
  const c = t.colors;
  out.push("", "### Colors, as reported");
  if (!c) out.push("(none)");
  else {
    out.push(`fg ${hex(c.foreground)}  bg ${hex(c.background)}  ${terminalPalette.light(c) ? "light" : "dark"}`);
    c.ansi.forEach((x, i) =>
      out.push(
        `${String(i).padStart(2)} ${slot_names[i].padEnd(14)} ${x ? hex(x) : "?"}${x ? `  ${ratio(terminalPalette.contrast(x, c.background))}` : ""}`,
      ),
    );
    const derived = terminalPalette.tokens(c).colors;
    out.push("", "### Colors, as Animal Style derives them");
    for (const [token, rgb] of Object.entries(derived))
      out.push(`${token.padEnd(9)} ${hex(rgb)}  ${ratio(terminalPalette.contrast(rgb, derived.bg))} on bg`);
    const notes = colorNotes(c);
    if (notes.length) out.push("", "### Notes", ...notes);
  }
  if (t.tmux)
    out.push(
      "",
      "### tmux",
      `${t.tmux.version}  allow-passthrough ${t.tmux.passthrough}  set-clipboard ${t.tmux.clipboard}`,
    );
  return out;
}
/** Writes the full report, asked for or when the terminal needs a closer
 * look; its path, or null. */
export async function writeFull(r: Report, s: Settings, socket: string, asked = false): Promise<string | null> {
  if (!asked && !flagged(r.terminal)) return null;
  try {
    const path = fullPath();
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, full(r, s, await extras(r, socket)), { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}

/** What `corgi bugreport` prints: the report, and the link that opens it as
 * an issue. Outside Corgi it asks the terminal it runs in; in a Corgi pane,
 * the daemon has the last-used viewer's. Without a daemon, the shell comes
 * from settings and the model is unknown. `asked` (--full) writes the full
 * report even for a terminal that looks fine. */
export async function command(socket: string, asked = false): Promise<string> {
  // A plain line on stderr per step, so piped output stays the report alone.
  const progress = (step: string) => process.stderr.write(`${step}...\n`);
  if (canAsk()) progress("Asking this terminal");
  const report = await collect(socket, await here(), progress),
    prefs = preferences.load(),
    settings: Settings = {
      theme: theme(prefs.theme, automatic(report.terminal?.colors ?? null)),
      keymap: keymap(prefs),
      clever_corgi: report.inference
        ? cleverCorgi(report.inference)
        : report.slow.daemon || report.slow.sessions
          ? `unknown (the daemon didn't answer in ${timeout_text})`
          : "unknown (Corgi isn't running)",
    };
  if (asked || flagged(report.terminal)) progress("Writing the full report");
  const attached = await writeFull(report, settings, socket, asked),
    tty = process.stdout.isTTY === true;
  return (
    "\n" +
    boxed(text(report, settings)) +
    "\n" +
    (attached ? attachLine(attached, tty) : "") +
    footer(issueUrl(report, settings, attached !== null), hyperlinks(process.env, tty))
  );
}
/** The report between rules that say what it's for. */
export function boxed(report: string): string {
  const title = " please attach to bug report ",
    side = "-".repeat(20);
  return `${side}${title}${side}\n${report}${"-".repeat(title.length + 2 * side.length)}\n`;
}
/** Where the full report went, in bold where a terminal shows it, so it
 * isn't missed above the link. */
export function attachLine(path: string, tty: boolean): string {
  const line = `Wrote ${tilde(path)}; please attach it to the issue.`;
  return (tty ? `\x1b[1m${line}\x1b[22m` : line) + "\n";
}
/** Under the report: the prefilled issue behind a short link where the
 * terminal takes links, else the bare new-issue page to paste it into. */
export function footer(url: string | null, links: boolean): string {
  if (!links || url === null) return `Paste this into a new issue: ${issues_url}\n`;
  return `Open an issue with this filled in: \x1b]8;;${url}\x1b\\\x1b[4m${issues_url.replace("https://", "")}\x1b[24m\x1b]8;;\x1b\\\n`;
}
/** Terminals known to take OSC 8 links; FORCE_HYPERLINK overrides, as in
 * other tools. Output that isn't a terminal never gets them. */
export function hyperlinks(env: Record<string, string | undefined>, tty: boolean): boolean {
  if (env.FORCE_HYPERLINK !== undefined) return env.FORCE_HYPERLINK !== "0";
  if (!tty || env.TERM === "dumb") return false;
  if (env.CORGI_PANE !== undefined || env.WT_SESSION || env.KONSOLE_VERSION) return true;
  if (Number(env.VTE_VERSION) >= 5000) return true;
  if (["ghostty", "iTerm.app", "WezTerm", "vscode"].includes(env.TERM_PROGRAM ?? "")) return true;
  return /^(xterm-kitty|xterm-ghostty|wezterm|foot|alacritty)/.test(env.TERM ?? "");
}
