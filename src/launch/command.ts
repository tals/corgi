import { basename, resolve as pathResolve, join } from "node:path";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Provider } from "../providers";
import { Model } from "../providers/model";
import * as os from "../os";
import * as settings from "../settings";
export const capacity = 6,
  max_length = 2048;
export type Command = string;
export class Tokens {
  pos = 0;
  constructor(public source: string) {}
  next() {
    while (this.pos < this.source.length && /\s/.test(this.source[this.pos])) this.pos++;
    if (this.pos === this.source.length) return null;
    let quote = "",
      out = "";
    while (this.pos < this.source.length) {
      const ch = this.source[this.pos];
      if (!quote && /\s/.test(ch)) break;
      this.pos++;
      if (ch === quote) {
        quote = "";
        continue;
      }
      if (!quote && (ch === "'" || ch === '"')) {
        quote = ch;
        continue;
      }
      if (ch === "\\" && quote !== "'" && this.pos < this.source.length) out += this.source[this.pos++];
      else {
        if (!quote && ";|&<>()$`".includes(ch)) return null;
        out += ch;
      }
      if (Buffer.byteLength(out) >= max_length) return null;
    }
    return quote ? null : out;
  }
}
export const assignment = (w: string) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(w);
export function identify(source: string): Provider | null {
  const t = new Tokens(source);
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
  if (w === "command" || w === "exec") w = t.next();
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
  for (const p of Provider.all) {
    const pkg = Provider.info(p).package;
    if (w === pkg || w.startsWith(pkg + "@")) return p;
  }
  return Provider.named(basename(w));
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
    return this.name || (p ? `${Provider.info(p).name} command` : "Shell command");
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
async function definitionOf(name: string, cwd: string | null, deadline: number) {
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
    ({ stdout } = await promisify(execFile)(
      chosen,
      [flags(), `printf '\\036CORGI_BEGIN\\n'; ${query} 2>/dev/null; printf '\\036CORGI_END\\n'`],
      { cwd: cwd ?? undefined, timeout: left, maxBuffer: 16384 },
    ));
  } catch (e) {
    if ((e as any).killed) throw Error("ShorthandLookupTimeout");
    if ((e as any).code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") throw Error("ShorthandOutputTooLarge");
    throw e;
  }
  const begin = stdout.indexOf("\x1eCORGI_BEGIN\n"),
    end = stdout.indexOf("\x1eCORGI_END\n", begin + 13);
  if (begin < 0 || end < 0) throw Error("ShorthandLookupFailed");
  return stdout.slice(begin + 13, end).trim();
}
export async function resolve(source: string, cwd: string | null = null) {
  let current = source,
    expanded = false,
    previous = "",
    deadline = Date.now() + 2000;
  for (let i = 0; i < 8; i++) {
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
    const body = wrapperBody(await definitionOf(w, cwd, deadline));
    if (body === null) return expanded ? freeze() : current;
    current = current.slice(0, start) + body + current.slice(t.pos);
    if (Buffer.byteLength(current) > max_length) throw Error("InvalidCommand");
    expanded = true;
  }
  throw Error("RecursiveShorthand");
}
export function analyze(source: string, cwd: string) {
  const s = new Semantics();
  s.provider = identify(source);
  s.default_account = s.provider !== null;
  const facts = s.provider ? Provider.info(s.provider) : null,
    t = new Tokens(source);
  let before = true,
    nextModel = false,
    nextProfile = false,
    credential = false,
    settings = false,
    config = "",
    home = "";
  let w: string | null;
  while ((w = t.next()) !== null) {
    if (nextModel) {
      s.model = w;
      nextModel = false;
      continue;
    }
    if (nextProfile) {
      s.account = "Profile selected; identity unknown";
      nextProfile = false;
      continue;
    }
    if (before && assignment(w)) {
      const i = w.indexOf("="),
        key = w.slice(0, i),
        value = w.slice(i + 1);
      if (key === "HOME") {
        home = value;
        s.default_account = false;
      } else if (facts) {
        if (key === facts.config_env) {
          config = value;
          s.default_account = false;
        } else {
          const override = facts.envOverride(key, value);
          if (override) {
            s.default_account = false;
            if (override === "credential") {
              credential = true;
              s.account = "API key - identity unavailable";
            } else if (override === "oauth") {
              credential = true;
              s.account = "Explicit OAuth token - identity unknown";
            } else {
              settings = true;
              s.account = "External endpoint/provider - identity unknown";
            }
          } else if (key === facts.model_env) s.model = value;
        }
      }
      continue;
    }
    if (before && (w === "command" || w === "env")) continue;
    if (before && w.startsWith("-")) {
      settings = true;
      s.default_account = false;
    }
    before = false;
    if (w === "--model" || w === "-m") nextModel = true;
    if (w.startsWith("--model=")) s.model = w.slice(8);
    for (const p of Provider.all)
      if ((s.provider === null || s.provider === p) && w === Provider.info(p).yolo_flag) s.yolo = true;
    if (!facts) continue;
    const word = w;
    const profile = facts.profile_flags.some((f: string) => word === f || word.startsWith(f + "=")),
      setting = facts.settings_flags.some((f: string) => word === f || word.startsWith(f + "="));
    if (profile || setting) {
      settings = true;
      s.default_account = false;
    }
    if (facts.profile_flags.includes(w)) nextProfile = true;
    if ((profile && w.includes("=")) || setting) s.account = "Custom settings - identity unknown";
  }
  if (facts && !s.default_account && !credential && !settings) {
    s.account = "Custom profile - identity unknown";
    const root =
      config && !/[$~`]/.test(config)
        ? pathResolve(cwd, config)
        : home && !/[$~`]/.test(home)
          ? pathResolve(cwd, home, facts.account_home)
          : null;
    if (root)
      try {
        const file = join(root, facts.account_file);
        if (statSync(file).size <= 65536) {
          const d = JSON.parse(readFileSync(file, "utf8"));
          let email = "";
          if (s.provider === "claude") email = d.oauthAccount?.emailAddress ?? "";
          else if (d.OPENAI_API_KEY) s.account = "Profile API key - identity unavailable";
          else
            email =
              JSON.parse(Buffer.from(d.tokens?.id_token?.split(".")[1] ?? "", "base64url").toString()).email ?? "";
          if (email) s.account = `${email} (cached)`;
        }
      } catch {}
  }
  if (!s.default_account && !s.account) s.account = "Account cannot be determined";
  s.mode = s.yolo ? "Skips permission checks" : "Provider permission settings";
  s.nameModel();
  s.suggested_name = (facts?.label ?? "Custom agent") + (s.model ? " - " + s.modelLabel() : "");
  return s;
}
export class Resolution {
  semantics = new Semantics();
  pending = true;
  command = new Entry();
  error_message = "";
}
export class Worker {
  jobs: {
    id: bigint | number;
    source: string;
    cwd: string;
    result: Resolution;
  }[] = [];
  next = 0;
  stopping = false;
  static start() {
    return new Worker();
  }
  stop() {
    this.stopping = true;
  }
  request(id: bigint | number, source: string, cwd: string) {
    if (Buffer.byteLength(cwd) > 4096) throw Error("InvalidDirectory");
    const existing = this.jobs.find(j => j.id === id && j.source === source && j.cwd === cwd);
    if (existing) return existing.result;
    const entry = new Entry();
    entry.set(source);
    const job = { id, source, cwd, result: new Resolution() };
    this.jobs[this.next] = job;
    this.next = (this.next + 1) % 8;
    void resolve(entry.text(), cwd)
      .then(s => {
        if (this.stopping) return;
        job.result.command.set(s);
        job.result.semantics = analyze(s, cwd);
        job.result.pending = false;
      })
      .catch(e => {
        job.result.pending = false;
        job.result.error_message = e.message;
      });
    return job.result;
  }
}
