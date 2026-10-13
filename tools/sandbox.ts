/**
 * Sandboxes: `./go.ts --sandbox NAME` runs Corgi in a world of its own, for
 * trying a feature by hand. `tools/sandboxes/NAME.ts` seeds the world and
 * opens its tabs; this module keeps it apart from your own Corgi.
 *
 * Everything lives under /tmp/corgi-sandbox-$UID/NAME: its own HOME, Corgi
 * state and socket, Claude and Codex config dirs, and what the world seeds.
 * Your own Corgi, its daemon and your agents' settings are never touched. The
 * `claude` and `codex` there are fakes: they take `work`, `stop`, `block` and
 * `exit`, and pasted notes that start with path:line make them "address" each
 * note by writing a comment into the file, so they have edits to show.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What `tools/sandboxes/NAME.ts` exports as `world`. */
export interface World {
  /** Builds the world under `s.dir`: once, and again after --restart. */
  seed(s: Sandbox): void;
  /** Opens the workspaces and tabs on a runtime that has none. */
  arrange(s: Sandbox): void;
  /** What to try, printed before the viewer attaches; `table` lays out keys. */
  intro(s: Sandbox): string[];
}

/** Keys and what they do, one per line, the keys in a column. */
export function table(rows: [string, string][]): string[] {
  return rows.map(([key, what]) => `${key.padEnd(10)} ${what}`);
}

export function names(root: string): string[] {
  return readdirSync(join(root, "tools/sandboxes"))
    .filter(file => file.endsWith(".ts"))
    .map(file => file.slice(0, -3))
    .sort();
}

/** Opens sandbox `name`, seeding and starting it when needed; `fresh` throws the old one away first. */
export async function open(name: string, root: string, exe: string, fresh: boolean): Promise<Sandbox> {
  const file = join(root, "tools/sandboxes", `${name}.ts`);
  if (!existsSync(file)) throw Error(`no sandbox ${name}; there are: ${names(root).join(", ")}`);
  const s = new Sandbox(name, ((await import(file)) as { world: World }).world, root, exe);
  console.error(`corgi: sandbox ${name} (${s.dir})`);
  if (fresh) {
    s.shutdown();
    rmSync(s.dir, { recursive: true, force: true });
  }
  s.prepareHome();
  const seeded = join(s.dir, "seeded");
  if (!existsSync(seeded)) {
    console.error(`corgi: seeding ${s.dir}`);
    try {
      s.world.seed(s);
    } catch (error) {
      // A half-built world would stop the next seed; start that one clean.
      rmSync(s.dir, { recursive: true, force: true });
      throw error;
    }
    s.dated(null);
    writeFileSync(seeded, "");
  }
  if (!s.running()) {
    spawnSync(exe, ["start", "--update-routed"], { cwd: s.dir, env: s.env, stdio: "inherit" });
    // A runtime that was stopped comes back with its tabs; only an empty one is laid out.
    const workspaces: { model?: { tabs?: unknown[] } }[] = s.corgi(["workspace", "list"])?.workspaces ?? [];
    if (workspaces.every(w => (w.model?.tabs?.length ?? 0) === 0)) s.world.arrange(s);
  }
  return s;
}

export class Sandbox {
  readonly dir: string;
  readonly home: string;
  /** What Corgi, and everything it starts, runs with. */
  readonly env: Record<string, string>;
  /** Inside a Corgi pane the outer Corgi takes its own prefix, so the sandbox takes the other one. */
  readonly prefix: "ctrl_a" | "ctrl_b";
  private readonly outer_prefix: "ctrl_a" | "ctrl_b";
  private readonly nested = process.env.CORGI_PANE !== undefined;

  constructor(
    readonly name: string,
    readonly world: World,
    readonly root: string,
    readonly exe: string,
  ) {
    this.dir = join(`/tmp/corgi-sandbox-${process.getuid?.() ?? 0}`, name);
    this.home = join(this.dir, "home");
    this.outer_prefix = (() => {
      try {
        const state = process.env.XDG_STATE_HOME ?? join(process.env.HOME ?? "", ".local/state");
        const saved = JSON.parse(readFileSync(join(state, "corgi/viewer.json"), "utf8"));
        return saved.prefix === "ctrl_a" ? "ctrl_a" : "ctrl_b";
      } catch {
        return "ctrl_b";
      }
    })();
    this.prefix = this.nested && this.outer_prefix === "ctrl_b" ? "ctrl_a" : "ctrl_b";
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const key of [
      "CORGI_PANE",
      "CORGI_APP_EXE",
      "CORGI_ENV_BASE",
      "CODEX_THREAD_ID",
      "CLAUDE_CODE_SESSION_KIND",
      "TMUX",
      "ZDOTDIR",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_CACHE_HOME",
    ])
      delete env[key];
    this.env = Object.assign(env, {
      HOME: this.home,
      XDG_STATE_HOME: join(this.home, ".local/state"),
      CODEX_HOME: join(this.home, ".codex"),
      CLAUDE_CONFIG_DIR: join(this.home, ".claude"),
      // Corgi only uses a socket in a private directory.
      CORGI_SOCKET: join(this.dir, "run", "control.sock"),
      CORGI_ENV_DIR: join(this.dir, "env"),
      SHELL: existsSync("/bin/zsh") ? "/bin/zsh" : "/bin/sh",
      PATH: `${join(this.home, "bin")}:${process.env.PATH}`,
    });
  }

  /** The prefix as the help names it. */
  get prefixName(): string {
    return this.prefix === "ctrl_a" ? "Ctrl+A" : "Ctrl+B";
  }
  /** Printed before the viewer attaches. */
  intro(): string {
    const lines = [
      ...this.world.intro(this),
      ...table([
        [`${this.prefixName} q`, `detach; ./go.ts --sandbox ${this.name} comes back, and with --restart starts over`],
      ]),
    ];
    if (this.nested && this.prefix !== this.outer_prefix)
      lines.push(`You're inside Corgi, so this sandbox uses ${this.prefixName} as its prefix.`);
    return lines.map(line => `  ${line}`).join("\n") + "\n";
  }

  run(argv: string[], cwd = this.dir, input?: string, check = true): string {
    const out = spawnSync(argv[0], argv.slice(1), {
      cwd,
      env: this.env,
      input,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
    if (check && out.status !== 0) throw Error(`${argv.join(" ")} failed in ${cwd}:\n${out.stderr}`);
    return out.stdout;
  }
  git(cwd: string, ...args: string[]): string {
    return this.run(["git", ...args], cwd);
  }
  /** Runs the sandbox's Corgi CLI and returns its result. */
  corgi(args: string[], check = true): any {
    const out = this.run([this.exe, ...args], this.dir, undefined, check);
    try {
      return JSON.parse(out).result;
    } catch {
      return null;
    }
  }
  write(path: string, text: string | Buffer): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  /** Replaces exactly one occurrence, so a stale anchor fails loudly. */
  edit(path: string, find: string, replace: string): void {
    const text = readFileSync(path, "utf8");
    const count = text.split(find).length - 1;
    if (count !== 1) throw Error(`edit ${path}: anchor found ${count} times:\n${find}`);
    writeFileSync(path, text.replace(find, replace));
  }
  commit(cwd: string, message: string): void {
    this.git(cwd, "add", "-A");
    this.git(cwd, "commit", "-q", "-m", message);
  }
  /** Dates the next commits `minutes` ago, so ages read naturally; null dates them now. */
  dated(minutes: number | null): void {
    if (minutes === null) {
      delete this.env.GIT_AUTHOR_DATE;
      delete this.env.GIT_COMMITTER_DATE;
      return;
    }
    const date = new Date(Date.now() - minutes * 60_000).toISOString();
    this.env.GIT_AUTHOR_DATE = date;
    this.env.GIT_COMMITTER_DATE = date;
  }
  /** A file of this repository as it is at HEAD, for realistic sample code. */
  pristine(path: string): string {
    return this.run(["git", "show", `HEAD:${path}`], this.root);
  }

  running(): boolean {
    return spawnSync(this.exe, ["ping"], { env: this.env, stdio: "ignore" }).status === 0;
  }
  shutdown(): void {
    if (existsSync(this.env.CORGI_SOCKET) && this.running())
      spawnSync(this.exe, ["shutdown"], { env: this.env, stdio: "ignore" });
  }
  prepareHome(): void {
    mkdirSync(join(this.home, ".local/state/corgi"), { recursive: true });
    for (const d of [".codex", ".claude", "bin"]) mkdirSync(join(this.home, d), { recursive: true });
    mkdirSync(join(this.dir, "env"), { recursive: true });
    mkdirSync(join(this.dir, "run"), { recursive: true, mode: 0o700 });
    chmodSync(join(this.dir, "run"), 0o700);
    for (const name of ["claude", "codex"]) {
      writeFileSync(join(this.home, "bin", name), `#!${process.execPath}\n${agent}`);
      chmodSync(join(this.home, "bin", name), 0o700);
    }
    writeFileSync(
      join(this.home, ".gitconfig"),
      "[user]\n\tname = Sandbox\n\temail = sandbox@example.com\n[init]\n\tdefaultBranch = main\n",
    );
    writeFileSync(join(this.home, ".zshrc"), "PROMPT='%F{green}%1~%f %# '\nbindkey -e\n");
    // Keep what the sandbox's viewer saved, but set the prefix for where it runs this time.
    const prefs = join(this.home, ".local/state/corgi/viewer.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(readFileSync(prefs, "utf8"));
    } catch {}
    writeFileSync(prefs, JSON.stringify({ preset: "corgi", ...saved, onboarding_complete: true, prefix: this.prefix }));
  }
}

/** The fake agent: hook-driven like the integration tests' ordinary agent,
 * with bracketed paste so notes arrive as a paste. */
const agent = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const provider = basename(process.argv[1]);
const hooks = provider === 'codex' ? join(process.env.CODEX_HOME, 'hooks.json') : join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const session = 'sandbox-' + provider + '-' + process.pid;
const transcript = join(process.env.HOME, session + '.jsonl');
writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
let turn = 0;
function event(name) {
  if (!existsSync(hooks)) return;
  if (name === 'UserPromptSubmit') turn++;
  for (const group of JSON.parse(readFileSync(hooks, 'utf8')).hooks?.[name] || []) for (const hook of group.hooks)
    spawnSync('/bin/sh', ['-c', hook.command], { input: JSON.stringify({ hook_event_name: name, session_id: session, turn_id: String(turn), transcript_path: transcript, cwd: process.cwd() }), encoding: 'utf8' });
  if (name === 'Stop') appendFileSync(transcript, JSON.stringify(provider === 'codex'
    ? { type: 'event_msg', timestamp: new Date().toISOString(), payload: { type: 'task_complete', turn_id: String(turn) } }
    : { type: 'system', subtype: 'turn_duration', sessionId: session, timestamp: new Date().toISOString() }) + '\n');
}
const out = s => process.stdout.write(s);
const title = t => out('\x1b]2;' + t + '\x07');
let line = '', pasted = '', pasting = false, busy = false;
function prompt() { out('\r\x1b[2K› ' + (pasted ? '\x1b[33m[Pasted text #1 +' + pasted.split('\n').length + ' lines]\x1b[0m ' : '') + line); }
out('\x1b[2J\x1b[H\x1b[?2004h');
title('✳ Ready');
event('SessionStart');
out(provider + ' · a fake agent in a Corgi sandbox (' + process.cwd().split('/').pop() + ')\r\n');
out('  work, stop, block, exit · or paste notes on path:line and press Enter\r\n\r\n');
prompt();
// Each note block starts with path:line; the fake answers by commenting there.
function address(text) {
  const done = [];
  for (const block of text.split(/\n\n+/)) {
    const rows = block.split('\n'), m = /^(\S+?):(\d+)(?:-(\d+))?/.exec(rows[0]);
    if (!m) continue;
    const file = join(process.cwd(), m[1]);
    if (!existsSync(file)) continue;
    const end = Number(m[3] || m[2]), src = readFileSync(file, 'utf8').split('\n');
    const ext = m[1].split('.').pop();
    const mark = ['md', 'markdown'].includes(ext) ? '> ' : ['py', 'sh', 'toml', 'yaml', 'yml'].includes(ext) ? '# ' : '// ';
    const indent = (src[end - 1] || '').match(/^\s*/)[0];
    src.splice(end, 0, indent + mark + 'Review: ' + rows[rows.length - 1]);
    writeFileSync(file, src.join('\n'));
    done.push(m[1] + ':' + (end + 1));
  }
  return done;
}
function submit() {
  const text = pasted, command = line.trim();
  line = ''; pasted = '';
  out('\r\n');
  if (command === 'exit') { event('SessionEnd'); out('\x1b[?2004l'); process.exit(0); }
  if (command === 'block') { event('PermissionRequest'); title('Action Required'); out('Needs input: type stop to answer.\r\n'); return prompt(); }
  if (command === 'stop') { event('Stop'); title('✳ Ready'); return prompt(); }
  if (!text && !command) return prompt();
  event('UserPromptSubmit');
  title('⠋ Working');
  busy = true;
  out(text ? 'Working on ' + text.split(/\n\n+/).length + ' review note(s)…\r\n' : 'Working on: ' + command + '\r\n');
  if (command === 'work') { busy = false; return; }
  setTimeout(() => {
    const done = text ? address(text) : [];
    out(done.length ? 'Addressed ' + done.join(', ') + '\r\n' : 'Done.\r\n');
    event('Stop');
    title('✳ Ready');
    busy = false;
    prompt();
  }, 2000);
}
process.stdin.setRawMode(true);
process.stdin.on('data', data => {
  let s = data.toString('utf8');
  while (s.length) {
    if (pasting) {
      const end = s.indexOf('\x1b[201~');
      pasted += (end < 0 ? s : s.slice(0, end)).replace(/\r/g, '\n');
      if (end < 0) return;
      s = s.slice(end + 6);
      pasting = false;
      prompt();
      continue;
    }
    const start = s.indexOf('\x1b[200~');
    const typed = start < 0 ? s : s.slice(0, start);
    for (const ch of typed) {
      if (ch === '\r' || ch === '\n') { if (!busy) submit(); }
      else if (ch === '\x03') { event('SessionEnd'); process.exit(0); }
      else if (ch === '\x7f') { if (line) line = line.slice(0, -1); else pasted = ''; prompt(); }
      else if (ch >= ' ' && ch !== '\x1b') { line += ch; prompt(); }
    }
    if (start < 0) return;
    s = s.slice(start + 6);
    pasting = true;
  }
});
`;
