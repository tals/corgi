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
 * Run headless for the Corgi prompt, `claude` answers from the world's
 * `prompt-replies.json`.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** What `tools/sandboxes/NAME.ts` exports as `world`. */
export interface World {
  /** Sets this world's environment on every launch, including a seeded world's. */
  configure?(s: Sandbox): void;
  /** Builds the world under `s.dir`: once, and again after --restart. */
  seed(s: Sandbox): void;
  /** Opens the workspaces and tabs on a runtime that has none. */
  arrange(s: Sandbox): void | Promise<void>;
  /** Stops owned services before the runtime and its world are removed. */
  shutdown?(s: Sandbox): void | Promise<void>;
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
    await s.shutdown();
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
    if (workspaces.every(w => (w.model?.tabs?.length ?? 0) === 0)) await s.world.arrange(s);
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
      SHELL: existsSync("/bin/zsh") ? "/bin/zsh" : existsSync("/bin/bash") ? "/bin/bash" : "/bin/sh",
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
    const out = this.run([this.exe, ...args, "--json"], this.dir, undefined, check);
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
  async shutdown(): Promise<void> {
    await this.world.shutdown?.(this);
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
      writeFileSync(
        join(this.home, "bin", name),
        `#!${process.execPath}\nimport { Editor, Parser } from ${JSON.stringify(join(this.root, "tools/sandbox_input.ts"))};\n${agent}`,
      );
      chmodSync(join(this.home, "bin", name), 0o700);
    }
    writeFileSync(
      join(this.home, ".gitconfig"),
      "[user]\n\tname = Sandbox\n\temail = sandbox@example.com\n[init]\n\tdefaultBranch = main\n",
    );
    writeFileSync(join(this.home, ".zshrc"), "PROMPT='%F{green}%1~%f %# '\nbindkey -e\n");
    writeFileSync(join(this.home, ".bashrc"), "PS1='\\W $ '\n");
    writeFileSync(join(this.home, ".sudo_as_admin_successful"), "");
    // Keep what the sandbox's viewer saved, but set the prefix for where it runs this time.
    const prefs = join(this.home, ".local/state/corgi/viewer.json");
    let saved: Record<string, unknown> = {};
    try {
      saved = JSON.parse(readFileSync(prefs, "utf8"));
    } catch {}
    writeFileSync(prefs, JSON.stringify({ preset: "corgi", ...saved, onboarding_complete: true, prefix: this.prefix }));
    this.world.configure?.(this);
  }
}

/** The fake agent: hook-driven like the integration tests' ordinary agent,
 * with bracketed paste so notes arrive as a paste. Its first run in a folder
 * no one signed in to signs in, as the real ones' do: Claude's takes the code
 * typed at its prompt as the login, Codex's a one-time code. Claude's answers
 * its account and usage. */
const agent = String.raw`
import { existsSync, readFileSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { spawnSync } from 'node:child_process';
const provider = basename(process.argv[1]);
const settings = provider === 'codex' ? process.env.CODEX_HOME : process.env.CLAUDE_CONFIG_DIR;
const words = process.argv.slice(2).join(' ');
const loginFile = join(settings, provider === 'codex' ? 'auth.json' : '.claude.json');
const email = () => {
  try {
    const saved = JSON.parse(readFileSync(loginFile, 'utf8'));
    if (provider !== 'codex') return saved.oauthAccount?.emailAddress ?? null;
    return JSON.parse(Buffer.from(saved.tokens.id_token.split('.')[1], 'base64url').toString()).email ?? null;
  } catch { return null; }
};
function signIn(who) {
  const address = (who || basename(settings)).replace(/[^A-Za-z0-9._-]/g, '') + '@example.com';
  writeFileSync(loginFile, JSON.stringify(provider === 'codex'
    ? { tokens: { id_token: 'x.' + Buffer.from(JSON.stringify({ email: address, sub: address })).toString('base64url') + '.x' } }
    : { oauthAccount: { emailAddress: address, accountUuid: address }, hasCompletedOnboarding: true }));
}
if (words === 'auth status' || words === 'login status') process.exit(email() ? 0 : 1);
if (words === 'auth logout' || words === 'logout') { rmSync(loginFile, { force: true }); process.exit(0); }
if (provider === 'claude' && words === 'auth status --json') {
  const who = email();
  console.log(JSON.stringify(who ? { loggedIn: true, authMethod: 'claude.ai', email: who, subscriptionType: 'max' } : { loggedIn: false, authMethod: 'none' }));
  process.exit(0);
}
// The Corgi prompt's headless Claude answers from $HOME/prompt-replies.json:
// the first reply whose "when" matches the message, step by step. A "run"
// step runs its command for real, so its output and a corgi grep's live
// progress are genuine; a "say" step streams Markdown.
if (provider === 'claude' && process.argv.includes('--include-partial-messages')) {
  const session = (await import('node:crypto')).randomUUID();
  const send = v => process.stdout.write(JSON.stringify({ session_id: session, ...v }) + '\n');
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  let replies = [], n = 0;
  try { replies = JSON.parse(readFileSync(join(process.env.HOME, 'prompt-replies.json'), 'utf8')); } catch {}
  const usage = { input_tokens: 2400, output_tokens: 180, cache_read_input_tokens: 18000 };
  async function say(text) {
    send({ type: 'stream_event', event: { type: 'content_block_start' } });
    for (let i = 0; i < text.length; i += 20) {
      send({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: text.slice(i, i + 20) } } });
      await pause(12);
    }
    send({ type: 'assistant', message: { id: 'msg-' + ++n, content: [{ type: 'text', text }], usage } });
  }
  async function run(command) {
    const id = 'tool-' + ++n;
    send({ type: 'assistant', message: { id: 'msg-' + n, content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }], usage } });
    const child = Bun.spawn(['/bin/sh', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
    const output = (await new Response(child.stdout).text()) + (await new Response(child.stderr).text());
    send({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: output.slice(0, 8000) }] } });
  }
  send({ type: 'system', subtype: 'init', permissionMode: 'bypassPermissions' });
  for await (const line of (await import('node:readline')).createInterface({ input: process.stdin })) {
    let v;
    try { v = JSON.parse(line); } catch { continue; }
    if (v.type === 'control_request') {
      send({ type: 'control_response', response: { subtype: 'success', request_id: v.request_id, response: {} } });
      continue;
    }
    if (v.type !== 'user') continue;
    const content = v.message?.content;
    const text = typeof content === 'string' ? content : (content ?? []).filter(b => b.type === 'text').map(b => b.text).join('\n');
    const reply = replies.find(r => new RegExp(r.when, 'i').test(text));
    send({ type: 'stream_event', event: { type: 'message_start' } });
    const steps = reply?.steps ?? [{ say: "I'm this sandbox's stand-in for Claude, so I only know a few questions:\n\n" + replies.map(r => '- ' + r.example).join('\n') }];
    for (const step of steps) {
      await pause(step.pause ?? 400);
      if (step.run) await run(step.run);
      else await say(step.say);
    }
    send({ type: 'result', subtype: 'success', is_error: false, result: '', usage });
  }
  process.exit(0);
}
if (provider === 'claude' && process.argv.includes('--input-format')) {
  // Usage differs by account, so each launcher row reads its own. Resets
  // fall off the hour, as real ones do, for countdowns as wide as "13h 43m".
  const used = [...(email() ?? '')].reduce((n, c) => (n * 31 + c.charCodeAt(0)) % 97, 7);
  const soon = s => new Date(Date.now() + s * 1000).toISOString();
  for await (const line of (await import('node:readline')).createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.type !== 'control_request') continue;
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    const body = request.request.subtype === 'get_usage'
      ? { subscription_type: 'max', rate_limits_available: true, rate_limits: { five_hour: { utilization: used, resets_at: soon(4 * 3600 + 3 * 60) }, seven_day: { utilization: Math.min(99, used + 20), resets_at: soon(13 * 3600 + 43 * 60) } } }
      : request.request.subtype === 'initialize'
        ? { models: [
            { value: 'default', displayName: 'Default (recommended)', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: efforts },
            { value: 'opus', displayName: 'Opus 5.5', resolvedModel: 'claude-opus-5-5', supportedEffortLevels: efforts },
            { value: 'sonnet', displayName: 'Sonnet 5.5', resolvedModel: 'claude-sonnet-5-5', supportedEffortLevels: efforts.slice(0, 3) },
            { value: 'haiku', displayName: 'Haiku 5.5', resolvedModel: 'claude-haiku-5-5', supportedEffortLevels: [] },
          ] }
        : {};
    console.log(JSON.stringify({ type: 'control_response', response: { request_id: request.request_id, subtype: 'success', response: body } }));
  }
  process.exit(0);
}
const hooks = provider === 'codex' ? join(process.env.CODEX_HOME, 'hooks.json') : join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const resume = process.argv.indexOf(provider === 'claude' ? '--resume' : 'resume');
const session = resume >= 0 && process.argv[resume + 1] ? process.argv[resume + 1] : 'sandbox-' + provider + '-' + process.pid;
const transcript = join(process.env.HOME, session + '.jsonl');
if (!existsSync(transcript)) writeFileSync(transcript, JSON.stringify({ type: 'session_meta', payload: { id: session } }) + '\n');
const option = flag => {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : '';
};
const task = option('--sandbox-name');
const initial = option('--sandbox-state');
const interval = Number(option('--sandbox-interval')) || 0;
let progress = null;
if (task && provider === 'claude')
  appendFileSync(transcript, JSON.stringify({ type: 'custom-title', sessionId: session, customTitle: task }) + '\n');
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
const input = new Editor(), parser = new Parser();
let history = '', ready = false, initializing = false;
const raw = s => process.stdout.write(s);
const out = s => {
  if (!ready) return raw(s);
  history = (history + s.replace(/\x1b\[2K/g, '').replace(/\r/g, '')).slice(-65536);
  prompt();
};
const title = t => raw('\x1b]2;' + t + '\x07');
let line = '', pasted = '', busy = false;
function prompt() {
  if (!ready || initializing) return;
  const cols = process.stdout.columns || 80, rows = process.stdout.rows || 24;
  const layout = input.layout(Math.max(8, cols - (provider === 'claude' ? 4 : 3)), provider);
  const height = Math.min(layout.lines.length, Math.max(1, rows - 5));
  const skip = Math.max(0, layout.y - height + 1);
  const transcriptRows = history.trimEnd().split('\n');
  const top = provider === 'claude' ? rows - height - 2 : Math.min(transcriptRows.length + 2, rows - height - 3);
  const screen = Array.from({length: rows}, () => '');
  const visible = transcriptRows.slice(-Math.max(0, top - 2));
  for (let y = 0; y < visible.length; y++) screen[y] = visible[y];
  if (provider === 'claude') {
    screen[top - 1] = '─'.repeat(cols);
    screen[top + height] = '─'.repeat(cols);
  }
  for (let y = 0; y < height; y++) screen[top + y] = (y === 0 ? (provider === 'claude' ? '❯\u00a0' : '› ') : '  ') + layout.lines[skip + y];
  screen[top + height + 1] = (pasted ? '[Pasted text #1 +' + pasted.split('\n').length + ' lines] · ' : '') + 'shortcuts: Shift+Enter newline · Enter send';
  let output = '\x1b[?2026h\x1b[?25l\x1b[H';
  for (let y = 0; y < rows; y++) {
    let row = '';
    for (const character of screen[y]) { if (Bun.stringWidth(row + character) > cols) break; row += character; }
    output += '\x1b[' + (y+1) + ';1H\x1b[2K' + row;
  }
  output += '\x1b[' + (top + layout.y - skip + 1) + ';' + (layout.x + 3) + 'H\x1b[?25h\x1b[?2026l';
  raw(output);
}
function begin() {
  raw('\x1b[2J\x1b[H\x1b[?2004h');
  ready = true;
  initializing = true;
  title('✳ Ready');
  event('SessionStart');
  out(provider + ' · a fake agent in a Corgi sandbox (' + process.cwd().split('/').pop() + ')\r\n');
  out('  work, stop, block, exit · or paste notes on path:line and press Enter\r\n\r\n');
  if (initial) {
    event('UserPromptSubmit');
    out('› ' + task + '\r\n\r\n');
    for (let i = 0; i < (interval ? 3 : 24); i++)
      out('  ' + (i + 1) + '. ' + ['Inspecting the existing implementation', 'Following the affected call sites', 'Checking the behavior against tests'][i % 3] + '\r\n');
    if (initial === 'working') {
      title('⠋ Working');
      out('\r\nWorking on: ' + task + '\r\n');
      if (interval) {
        let step = 0;
        progress = setInterval(() => {
          out('\r\x1b[2K  ' + ++step + '. ' + ['Inspecting a worker', 'Checking a test case', 'Verifying recovery'][step % 3] + '\r\n');
          prompt();
        }, Math.max(1, interval) * 1000);
      }
    } else {
      event('Stop');
      out('\r\nFinished: ' + task + '\r\nReady for review.\r\n');
    }
  }
  initializing = false;
  prompt();
}
// Its first run in a folder no one signed in to: how, then a link.
let signing = email() ? null : 'method';
function signinScreen() {
  out('\x1b[2J\x1b[H');
  if (provider === 'codex' && signing === 'method')
    out("  Welcome to Codex, OpenAI's command-line coding agent\r\n\r\n> 1. Sign in with ChatGPT\r\n  2. Sign in with Device Code\r\n     Sign in from another device with a one-time code\r\n\r\n  Press enter to continue\r\n");
  else if (provider === 'codex')
    out('  Finish signing in via your browser\r\n\r\n  1. Open this link in your browser and sign in\r\n  https://auth.openai.com/codex/device\r\n\r\n  2. Enter this one-time code after you are signed in\r\n  SAND-B0X42\r\n\r\n  (This sandbox signs in when you press Enter.)\r\n');
  else if (signing === 'method')
    out(' Select login method:\r\n\r\n ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise\r\n   2. Anthropic Console account · API usage billing\r\n');
  else
    out(" Browser didn't open? Use the url below to sign in (c to copy)\r\n\r\nhttps://claude.com/cai/oauth/authorize?code=true&sandbox=1\r\n\r\n (In this sandbox any word is a code: it signs in as word@example.com.)\r\n Paste code here if prompted > " + line);
}
function signinKeys(data) {
  const result = input.key(data);
  line = input.text;
  if (result === 'submit') {
    if (signing === 'method') { signing = 'code'; input.clear(); line = ''; }
    else { signIn(line.trim()); signing = null; input.clear(); line = ''; return begin(); }
  } else if (result === 'exit') process.exit(0);
  signinScreen();
  if (line.length > input.caret) raw('\x1b[' + (line.length - input.caret) + 'D');
}
if (signing) signinScreen();
else begin();
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
  const text = pasted, command = input.text.trim();
  history += '› ' + input.text + '\n';
  input.clear(); line = ''; pasted = '';
  out('\r\n');
  if (command === 'exit') { event('SessionEnd'); raw('\x1b[?2004l'); process.exit(0); }
  if (command === 'block') { event('PermissionRequest'); title('Action Required'); out('Needs input: type stop to answer.\r\n'); return prompt(); }
  if (command === 'stop') { clearInterval(progress); event('Stop'); title('✳ Ready'); return prompt(); }
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
  for (const packet of parser.read(data)) {
    if (packet.kind === 'paste') {
      if (signing) { input.insert(packet.data); line = input.text; signinScreen(); }
      else { pasted += packet.data.replace(/\r/g, '\n'); prompt(); }
      continue;
    }
    if (signing) { signinKeys(packet.data); continue; }
    const result = input.key(packet.data);
    if (result === 'exit') { event('SessionEnd'); raw('\x1b[?2004l'); process.exit(0); }
    if (result === 'submit') { if (!busy) submit(); }
    else prompt();
  }
});
process.on('SIGWINCH', () => signing ? signinScreen() : prompt());
`;
