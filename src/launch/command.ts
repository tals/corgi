import { basename } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { Provider, adapter } from "../providers";
import { Model } from "../providers/model";
import type { CommandLine, Inspection } from "../providers/adapter";
import * as os from "../os";
import * as settings from "../settings";
import * as subprocess from "../subprocess";
import * as errors from "../errors";
import { Tokens, max_length } from "./tokens";
export { Tokens, max_length } from "./tokens";
export const capacity = 6;
export type Command = string;
export const assignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
function executable(t: Tokens) {
  let w = t.next();
  while (w !== null && assignment(w)) w = t.next();
  if (w === null) return null;
  if (basename(w) === "env") {
    w = t.next();
    while (w !== null) {
      if (w === "-u" || w === "--unset") {
        if (t.next() === null) return null;
      } else if (!assignment(w) && !["-i", "--ignore-environment", "--"].includes(w)) break;
      w = t.next();
    }
  }
  return w === "command" || w === "exec" ? t.next() : w;
}
/** A literal relative executable belongs to the directory where the user launched it. */
export function anchorExecutable(source: string, cwd: string): string {
  const t = new Tokens(source),
    name = executable(t);
  if (!name?.includes("/") || /^[/$~`]/.test(name)) return source;
  return source.slice(0, t.start) + os.shellQuote(cwd.replace(/\/$/, "") + "/") + source.slice(t.start);
}
export function identify(source: string): Provider | null {
  const t = new Tokens(source);
  let w = executable(t);
  if (w === null) return null;
  const base = basename(w);
  if (base === "bunx") {
    w = t.next();
    if (w === "--bun") w = t.next();
  } else if (base === "bun") {
    if (t.next() !== "x") return null;
    w = t.next();
  }
  if (w === null) return null;
  // A package bunx runs may name its version: @openai/codex@1.2.
  return Provider.owning(w.replace(/(.)@[^/]*$/, "$1"));
}
export class Semantics {
  provider: Provider | null = null;
  suggested_name = "";
  model = "";
  model_name = "";
  account = "";
  mode = "";
  yolo = false;
  default_account = false;
  modelLabel() {
    return this.model_name || this.model;
  }
  nameModel() {
    this.model_name = Model.resolve(this.model).name.text();
  }
}
export class Entry {
  command = "";
  original = "";
  hidden = false;
  name = "";
  semantics = new Semantics();
  text() {
    return this.command;
  }
  inputText() {
    return this.original || this.command;
  }
  setOriginal(s: string) {
    if (Buffer.byteLength(s) > max_length) throw Error("InvalidCommand");
    this.original = s;
  }
  set(s: string) {
    const v = s.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, "");
    if (v.includes("\0") || Buffer.byteLength(v) > max_length) throw Error("InvalidCommand");
    this.command = v;
  }
  label() {
    const p = identify(this.command);
    return this.name || (p ? `${adapter(p).name} command` : "Shell command");
  }
}
/** Where the shell new panes run comes from. */
export type ShellSource = "setting" | "env" | "account" | "fallback";
/** The shell new panes run, as the daemon publishes it. */
export interface ShellStatus {
  /** settings.json's shell as written; empty without one. */
  setting: string;
  path: string;
  source: ShellSource;
  /** What panes run without the setting. */
  default: string;
  default_source: Exclude<ShellSource, "setting">;
}
/** A shell setting as an executable: an absolute path, or a name on PATH. */
export function locate(value: string): string | null {
  return value.startsWith("/") ? (os.isExecutable(value) ? value : null) : os.findExecutable(value);
}
/** SHELL from the user's session, else the account's login shell, which
 * covers app/launchd starts. */
function fallback(): { path: string; source: ShellStatus["default_source"] } {
  const s = process.env.SHELL;
  if (s?.startsWith("/")) return { path: s, source: "env" };
  const account = os.loginShell();
  return account ? { path: account, source: "account" } : { path: "/bin/sh", source: "fallback" };
}
/** The shell from settings.json, else the fallback. */
export function shell() {
  const setting = settings.shell();
  return (setting !== null ? locate(setting) : null) ?? fallback().path;
}
/** The shell's arguments for a pane. Like Ghostty, only macOS starts login
 * shells, since users there keep their setup in ~/.bash_profile; elsewhere
 * bash's login files often skip ~/.bashrc. */
export function shellArgs(command: string | null, interactive: boolean, platform = process.platform): string[] {
  const login = platform === "darwin" ? "l" : "";
  if (command === null) return login ? ["-l"] : [];
  return [`-${login}${interactive ? "i" : ""}c`, command];
}
export function shellStatus(): ShellStatus {
  const setting = settings.shell() ?? "",
    chosen = setting ? locate(setting) : null,
    other = fallback();
  return {
    setting,
    path: chosen ?? other.path,
    source: chosen ? "setting" : other.source,
    default: other.path,
    default_source: other.source,
  };
}
/** Shells that /etc/shells lists and that are installed, by name, leaving
 * out multiplexers, restricted shells and the ones that refuse logins. */
export function installedShells(file = "/etc/shells"): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const seen = new Set<string>(),
    out: string[] = [];
  for (const line of text.split("\n")) {
    const path = line.trim();
    if (!path.startsWith("/") || not_shells.has(basename(path)) || !os.isExecutable(path)) continue;
    let real = path;
    try {
      real = realpathSync(path);
    } catch {}
    if (seen.has(real)) continue;
    seen.add(real);
    out.push(path);
  }
  return out.sort((a, b) => basename(a).localeCompare(basename(b)) || a.localeCompare(b));
}
const not_shells = new Set(["tmux", "screen", "byobu", "nologin", "false", "git-shell", "rbash"]);
export function flags() {
  return "-ic";
}
export function wrapperBody(d: string): string | null {
  if (!d) return null;
  if (d.includes("=") && !d.includes("\n") && !d.startsWith("function ")) {
    const v = new Tokens(d.slice(d.indexOf("=") + 1)).next();
    if (v === null) throw Error("UnsupportedShorthand");
    return v;
  }
  let header = false,
    body: string | null = null;
  for (const raw of d.split("\n")) {
    const l = raw.trim();
    if (!l || l.startsWith("#")) continue;
    if (!header) {
      if (!l.startsWith("function ") && !l.includes("()")) throw Error("UnsupportedShorthand");
      header = true;
      continue;
    }
    if (["end", "{", "}"].includes(l)) continue;
    if (body !== null) throw Error("ComplexShellFunction");
    body = l;
  }
  if (body === null) throw Error("ComplexShellFunction");
  let r = body.replace(/[ \t;]+$/, "");
  const suffix = r.endsWith("$argv") ? "$argv" : r.endsWith('"$@"') ? '"$@"' : null;
  if (!suffix) throw Error("ComplexShellFunction");
  r = r.slice(0, -suffix.length).trimEnd();
  if (/[;\n|&<>()$`]/.test(r)) throw Error("ComplexShellFunction");
  return r;
}
async function definitionOf(name: string, cwd: string | null, deadline: number, quit?: subprocess.Quit) {
  const chosen = shell(),
    base = basename(chosen),
    query =
      base === "fish"
        ? `builtin functions -- '${name}'`
        : base === "bash"
          ? `builtin alias -- '${name}' 2>/dev/null || builtin declare -f -- '${name}'`
          : base === "zsh"
            ? `builtin alias -- '${name}' 2>/dev/null || builtin functions -- '${name}'`
            : null;
  if (query === null) return "";
  const left = deadline - Date.now();
  if (left <= 0) throw Error("ShorthandLookupTimeout");
  let stdout: string;
  try {
    const output = await subprocess.run(
      [chosen, flags(), `printf '\\036CORGI_BEGIN\\n'; ${query} 2>/dev/null; printf '\\036CORGI_END\\n'`],
      { cwd: cwd ?? undefined, timeout_ms: left, max_output: 16384, quit },
    );
    if (!output.ok()) throw Error("ShorthandLookupFailed");
    stdout = output.stdout.toString();
  } catch (e) {
    if (errors.is(e, "TimedOut")) throw Error("ShorthandLookupTimeout");
    if (errors.is(e, "OutputTooLarge")) throw Error("ShorthandOutputTooLarge");
    throw e;
  }
  const begin = stdout.indexOf("\x1eCORGI_BEGIN\n"),
    end = stdout.indexOf("\x1eCORGI_END\n", begin + 13);
  if (begin < 0 || end < 0) throw Error("ShorthandLookupFailed");
  return stdout.slice(begin + 13, end).trim();
}
export async function resolve(source: string, cwd: string | null = null, quit?: subprocess.Quit) {
  let current = source,
    expanded = false,
    previous = "",
    deadline = Date.now() + 2000;
  for (let i = 0; i < 8; i++) {
    if (quit?.aborted) throw Error("Cancelled");
    const t = new Tokens(current);
    let start = 0,
      w = t.next();
    if (w === null) return current;
    while (assignment(w)) {
      start = t.pos;
      while (/\s/.test(current[start] ?? "") && start < current.length) start++;
      w = t.next();
      if (w === null) return current;
    }
    const freeze = () => current.slice(0, start) + "command " + current.slice(start);
    if (w === "command" || w.includes("/")) return expanded && w !== "command" ? freeze() : current;
    if (!/^[A-Za-z0-9_-]+$/.test(w)) throw Error("UnsupportedShorthand");
    if (expanded && w === previous) return freeze();
    previous = w;
    const body = wrapperBody(await definitionOf(w, cwd, deadline, quit));
    if (body === null) return expanded ? freeze() : current;
    current = current.slice(0, start) + body + current.slice(t.pos);
    if (Buffer.byteLength(current) > max_length) throw Error("InvalidCommand");
    expanded = true;
  }
  throw Error("RecursiveShorthand");
}
/** `source` split into the variables it sets and its words from the program on. */
export function commandLine(source: string, cwd: string): CommandLine {
  const t = new Tokens(source),
    line: CommandLine = { env: [], args: [], flagged: false, cwd };
  let w: string | null;
  while ((w = t.next()) !== null) {
    if (line.args.length) line.args.push(w);
    else if (assignment(w)) line.env.push([w.slice(0, w.indexOf("=")), w.slice(w.indexOf("=") + 1)]);
    else if (w !== "command" && w !== "env") {
      line.flagged = w.startsWith("-");
      line.args.push(w);
    }
  }
  return line;
}
export async function analyze(source: string, cwd: string) {
  const s = new Semantics();
  s.provider = identify(source);
  const line = commandLine(source, cwd),
    seen = s.provider ? await adapter(s.provider).inspect(line) : await guess(line);
  s.model = seen.model;
  s.account = seen.account;
  s.default_account = seen.default_account;
  s.yolo = seen.permissions === "bypass";
  if (!s.default_account && !s.account) s.account = "Account cannot be determined";
  s.mode = s.yolo ? "Skips permission checks" : "Provider permission settings";
  s.nameModel();
  s.suggested_name =
    (s.provider ? adapter(s.provider).label : "Custom agent") + (s.model ? " - " + s.modelLabel() : "");
  return s;
}
/** What a command Corgi can't place says: its model, and whether any
 * provider would read it as skipping permission checks. */
async function guess(line: CommandLine): Promise<Inspection> {
  let model = "",
    next = false;
  for (const w of line.args) {
    if (next) {
      model = w;
      next = false;
      continue;
    }
    if (w === "--model" || w === "-m") next = true;
    if (w.startsWith("--model=")) model = w.slice(8);
  }
  const seen = await Promise.all(Provider.all.map(p => adapter(p).inspect({ ...line, env: [] }))),
    bypass = seen.some(s => s.permissions === "bypass");
  return { permissions: bypass ? "bypass" : "default", model, account: "", default_account: false };
}
export class Resolution {
  semantics = new Semantics();
  pending = true;
  command = new Entry();
  error_message = "";
}
export class Worker {
  private quit = subprocess.Quit.init();
  private pending = new Set<Promise<void>>();
  jobs: {
    id: bigint;
    source: string;
    cwd: string;
    result: Resolution;
  }[] = [];
  next = 0;
  stopping = false;
  static start() {
    return new Worker();
  }
  async stop() {
    this.stopping = true;
    this.quit.signal();
    await Promise.all(this.pending);
  }
  request(id: bigint, source: string, cwd: string) {
    if (this.stopping) throw Error("Cancelled");
    if (Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
    const existing = this.jobs.find(j => j.id === id && j.source === source && j.cwd === cwd);
    if (existing) return existing.result;
    const entry = new Entry();
    entry.set(source);
    const job = { id, source, cwd, result: new Resolution() };
    this.jobs[this.next] = job;
    this.next = (this.next + 1) % 8;
    const pending = resolve(entry.text(), cwd, this.quit)
      .then(async s => {
        if (this.stopping) return;
        job.result.command.set(s);
        job.result.semantics = await analyze(s, cwd);
        job.result.pending = false;
      })
      .catch(e => {
        job.result.pending = false;
        job.result.error_message = e.message;
      })
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
    return job.result;
  }
}
