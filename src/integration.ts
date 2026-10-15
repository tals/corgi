import {
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Provider } from "./providers";
import { hookOrigin } from "./detection";
import { flock } from "./native_bridge";
import { atomicWrite, quote } from "./os";
import * as discovery from "./discovery";
import * as rpc from "./rpc";
import * as codexConfig from "./codex_config";
import { Pool } from "./inference";
/** What a step of `corgi integration` found or did. */
export type Outcome = "added" | "present" | "removed" | "absent" | "no_config";
export function installedCommand(provider: Provider): string {
  return (
    'if [ -n "${CORGI_PANE:-}" ] && [ -n "${CORGI_SOCKET:-}" ] && [ -x "${CORGI_BIN:-}" ]; then "$CORGI_BIN" hook ' +
    provider +
    "; fi"
  );
}
function configCommand(provider: Provider, command: string) {
  return {
    hooks: Object.fromEntries(
      Provider.backend(provider)
        .hookEvents()
        .map(event => [event, [{ hooks: [{ type: "command", command, timeout: 2 }] }]]),
    ),
  };
}
export function config(provider: Provider, executable: string): string {
  return JSON.stringify(configCommand(provider, `${quote(executable)} hook ${provider}`), null, 2);
}
export function mergedConfig(provider: Provider, existing: string): string | null {
  const root = JSON.parse(existing),
    bad = () => {
      throw Error("InvalidHookSettings");
    };
  if (!root || typeof root !== "object" || Array.isArray(root)) bad();
  root.hooks ??= {};
  if (!root.hooks || typeof root.hooks !== "object" || Array.isArray(root.hooks)) bad();
  const command = installedCommand(provider);
  let changed = false;
  for (const [event, template] of Object.entries(configCommand(provider, command).hooks)) {
    const groups = (root.hooks[event] ??= []);
    if (!Array.isArray(groups)) bad();
    let found = false;
    for (const group of groups) {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) bad();
      for (const handler of group.hooks) if (handler?.command === command) found = true;
    }
    if (!found) {
      groups.push(template[0]);
      changed = true;
    }
  }
  return changed ? JSON.stringify(root, null, 2) : null;
}
export type Position = { event: string; group: number; handler: number };
/** Hook settings without Corgi's handlers: the new text, the handlers
 * removed, and where each other handler moved from and to. */
export type Removal = { text: string; removed: Position[]; moved: [Position, Position][] };
export function removedConfig(provider: Provider, existing: string): Removal | null {
  const root = JSON.parse(existing);
  if (!root || typeof root !== "object" || Array.isArray(root)) throw Error("InvalidHookSettings");
  const hooks = root.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return null;
  const command = installedCommand(provider),
    removed: Position[] = [],
    moved: [Position, Position][] = [];
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept: any[] = [];
    groups.forEach((group, g) => {
      if (!group || typeof group !== "object" || !Array.isArray(group.hooks)) return void kept.push(group);
      const handlers: any[] = [];
      group.hooks.forEach((handler: any, h: number) => {
        const from = { event, group: g, handler: h };
        if (handler?.command === command) removed.push(from);
        else moved.push([from, { event, group: kept.length, handler: handlers.push(handler) - 1 }]);
      });
      if (handlers.length) kept.push(handlers.length === group.hooks.length ? group : { ...group, hooks: handlers });
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  if (!removed.length) return null;
  if (!Object.keys(hooks).length) delete root.hooks;
  return { text: JSON.stringify(root, null, 2), removed, moved };
}
/** Edits a provider's hook settings under Corgi's lock. `change` returns the
 * new text, or null to leave the file as it is. */
function editHooks(provider: Provider, change: (text: string) => string | null, backup: boolean) {
  const info = Provider.info(provider),
    directory = info.configDir();
  if (!existsSync(directory)) return "no_config";
  const lock = openSync(join(directory, ".corgi-hooks.lock"), "a", 0o600);
  try {
    if (!flock(lock)) throw Error("HookSettingsBusy");
    const path = join(directory, info.hooks_file);
    let stat = null;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stat && !stat.isFile()) throw Error("HookSettingsNotRegular");
    if (stat && stat.size > 1024 * 1024) throw Error("FileTooBig");
    const before = stat ? readFileSync(path, "utf8") : "{}",
      after = change(before);
    if (after === null) return "unchanged";
    if (stat && backup)
      try {
        writeFileSync(path + ".corgi-backup", before, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    if (stat ? readFileSync(path, "utf8") !== before : existsSync(path)) throw Error("HookSettingsChanged");
    atomicWrite(path, after + "\n", stat ? stat.mode & 0o777 : 0o600, false);
    return "changed";
  } finally {
    flock(lock, false);
    closeSync(lock);
  }
}
export async function install(provider: Provider): Promise<Outcome> {
  const edit = editHooks(provider, text => mergedConfig(provider, text), true);
  return edit === "changed" ? "added" : edit === "unchanged" ? "present" : "no_config";
}
function uninstallHooks(provider: Provider): { outcome: Outcome; removal: Removal | null } {
  let removal: Removal | null = null;
  const edit = editHooks(provider, text => (removal = removedConfig(provider, text))?.text ?? null, false);
  return { outcome: edit === "changed" ? "removed" : edit === "unchanged" ? "absent" : "no_config", removal };
}
export async function hook(provider: Provider, path: string): Promise<void> {
  const id = Number(process.env.CORGI_PANE);
  if (!Number.isInteger(id) || id < 0 || id > 0xffffffff) return;
  const parts: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const b = Buffer.from(chunk);
    size += b.length;
    if (size > 1024 * 1024) return;
    parts.push(b);
  }
  let event: any;
  try {
    event = JSON.parse(Buffer.concat(parts).toString());
  } catch {
    return;
  }
  if (provider === "codex" && process.env.CODEX_THREAD_ID && process.env.CODEX_THREAD_ID !== event.session_id) return;
  const origin = provider === "claude" ? hookOrigin() : { pid: 0, background: false };
  try {
    await rpc.request(path, "hook", {
      provider,
      event,
      pane: id,
      seq: Date.now() * 1000,
      background: provider === "claude" && (process.env.CLAUDE_CODE_SESSION_KIND === "bg" || origin.background),
      pid: origin.pid,
    });
  } catch {}
}
export async function launch(provider: Provider, args: string[], _executable: string): Promise<never> {
  if (process.env.CORGI_PANE === undefined) throw Error("LaunchInsideCorgi");
  // Like execvp: a bare name (Claude, or an override) is looked up on PATH.
  const binary = await discovery.resolve(provider),
    path = binary.includes("/") ? binary : discovery.onPath(binary);
  if (path === null) throw Error("ProviderNotFound");
  process.execve!(path, [binary, ...args], process.env as Record<string, string>);
  throw Error("ExecFailed");
}
export async function installCodexTitle(): Promise<Outcome> {
  const directory = Provider.info("codex").configDir();
  if (!existsSync(directory)) return "no_config";
  const path = join(directory, "config.toml"),
    pool = new Pool({ config: { provider: "codex", timeout_ms: 3000 } });
  try {
    const connection = await pool.metadata(),
      deadline = Date.now() + 3000;
    const reply = await connection.rpc("config/read", { includeLayers: true }, undefined, deadline);
    const edit = codexConfig.edit(reply.result, path);
    if (!edit) return "present";
    codexConfig.backup(path);
    await connection.rpc("config/value/write", edit, undefined, deadline);
    return "added";
  } finally {
    pool.close();
  }
}
type Item = "hooks" | "approvals" | "title" | "backup" | "startup";
/** How many of Corgi's hooks Codex loads, and how many of those it trusts. */
type Trust = { trusted: number; total: number } | { error: string };
type Line = { provider: Provider; item: Item; path: string; moved?: number; events?: number[]; trust?: Trust } & (
  { outcome: Outcome | "partial" | "off" } | { outcome: "failed"; error: string }
);
const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));
/** How many of the events Corgi hooks have its handler, and how many there are. */
export function hookEvents(provider: Provider, text: string): [number, number] {
  const hooks = JSON.parse(text)?.hooks,
    command = installedCommand(provider),
    events = Provider.backend(provider).hookEvents(),
    ours = (groups: unknown) =>
      Array.isArray(groups) &&
      groups.some(group => Array.isArray(group?.hooks) && group.hooks.some((h: any) => h?.command === command));
  return [events.filter(event => ours(hooks?.[event])).length, events.length];
}
async function* jsonLines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of stream) {
    buffer += decoder.decode(chunk, { stream: true });
    for (let end; (end = buffer.indexOf("\n")) >= 0;) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      try {
        yield JSON.parse(line);
      } catch {}
    }
  }
}
/** Asks a short-lived Codex app server about Corgi's hooks in `files`. The
 * inference one can't say: it runs with hooks turned off. */
async function codexTrust(files: string[]): Promise<Trust> {
  const command = installedCommand("codex");
  let child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "ignore">> | null = null,
    timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const spawned = (child = Bun.spawn([await discovery.resolve("codex"), "app-server", "--listen", "stdio://"], {
        cwd: homedir(),
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
      })),
      messages = jsonLines(spawned.stdout),
      call = async (id: number, method: string, params: unknown) => {
        spawned.stdin.write(JSON.stringify({ id, method, params }) + "\n");
        await spawned.stdin.flush();
        for (;;) {
          const { value, done } = await messages.next();
          if (done) throw Error("CodexExited");
          if (value?.id !== id) continue;
          if (value.error) throw Error(String(value.error.message ?? "CodexError"));
          return value.result;
        }
      },
      ask = async () => {
        await call(1, "initialize", { clientInfo: { name: "corgi", version: "1" }, capabilities: {} });
        spawned.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
        return await call(2, "hooks/list", { cwds: [homedir()] });
      },
      result = await Promise.race([
        ask(),
        new Promise<never>((_, reject) => (timer = setTimeout(() => reject(Error("Timeout")), 5000))),
      ]);
    const hooks = (result?.data ?? [])
      .flatMap((entry: any) => entry?.hooks ?? [])
      .filter((h: any) => h?.handlerType === "command" && h.command === command && files.includes(h.sourcePath));
    return {
      trusted: hooks.filter((h: any) => h.enabled && ["trusted", "managed"].includes(h.trustStatus)).length,
      total: hooks.length,
    };
  } catch (error) {
    return { error: failure(error) };
  } finally {
    clearTimeout(timer);
    child?.kill();
  }
}
/** Codex's approvals for the hooks Corgi removed, and the thread ID in its
 * title, edited through its config API. */
async function uninstallCodexConfig(removal: Removal | null): Promise<Line[]> {
  const directory = Provider.info("codex").configDir(),
    path = join(directory, "config.toml");
  if (!existsSync(path)) return [];
  let original = null;
  try {
    original = Bun.TOML.parse(readFileSync(path + ".corgi-backup", "utf8"));
  } catch {}
  const pool = new Pool({ config: { provider: "codex", timeout_ms: 3000 } });
  try {
    const connection = await pool.metadata(),
      deadline = Date.now() + 3000;
    const reply = await connection.rpc("config/read", { includeLayers: true }, undefined, deadline);
    const layer = codexConfig.userLayer(reply.result, path),
      state = layer.config?.hooks?.state,
      lines: Line[] = [],
      edits = [];
    if (removal && state && typeof state === "object") {
      const hooks = join(directory, "hooks.json"),
        files = [hooks, ...(existsSync(hooks) ? [realpathSync(hooks)] : [])],
        file = files.find(f => Object.keys(state).some(key => key.startsWith(f + ":"))),
        approvals = file ? codexConfig.movedApprovals(state, file, removal) : null;
      if (approvals) {
        const value = Object.keys(approvals.state).length ? approvals.state : null;
        edits.push({ keyPath: "hooks.state", value, mergeStrategy: "replace" });
        lines.push({ provider: "codex", item: "approvals", outcome: "removed", path, moved: approvals.moved });
      }
    }
    const title = codexConfig.restoredTitle(layer.config?.tui?.terminal_title, original);
    if (title !== undefined) edits.push({ keyPath: "tui.terminal_title", value: title, mergeStrategy: "replace" });
    lines.push({ provider: "codex", item: "title", outcome: title === undefined ? "absent" : "removed", path });
    if (edits.length)
      await connection.rpc(
        "config/batchWrite",
        { edits, filePath: path, expectedVersion: layer.version },
        undefined,
        deadline,
      );
    return lines;
  } catch (error) {
    const items: Item[] = removal ? ["approvals", "title"] : ["title"];
    return items.map((item): Line => ({ provider: "codex", item, outcome: "failed", error: failure(error), path }));
  } finally {
    pool.close();
  }
}
function remove(path: string): boolean {
  try {
    unlinkSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
/** Config directories the user uninstalled Corgi from, which startup leaves
 * alone. It sits under the base state directory, so temporary and named
 * environments, which share the providers' configs, see it too. */
function removalsPath() {
  const e = process.env;
  return join(e.CORGI_ENV_BASE ?? e.XDG_STATE_HOME ?? join(homedir(), ".local", "state"), "corgi", "integrations.json");
}
function removals(): string[] {
  try {
    const value = JSON.parse(readFileSync(removalsPath(), "utf8")).uninstalled;
    return Array.isArray(value) ? value.filter(v => typeof v === "string") : [];
  } catch {
    return [];
  }
}
export function uninstalled(provider: Provider): boolean {
  return removals().includes(Provider.info(provider).configDir());
}
function remember(provider: Provider, gone: boolean) {
  const directory = Provider.info(provider).configDir(),
    saved = removals();
  if (saved.includes(directory) === gone) return;
  const next = saved.filter(d => d !== directory),
    text = JSON.stringify({ uninstalled: gone ? [...next, directory] : next }, null, 2) + "\n";
  atomicWrite(removalsPath(), text, 0o600, false);
}
async function installProvider(provider: Provider): Promise<Line[]> {
  remember(provider, false);
  const info = Provider.info(provider),
    directory = info.configDir(),
    path = join(directory, info.hooks_file);
  let outcome: Outcome;
  try {
    outcome = await install(provider);
  } catch (error) {
    return [{ provider, item: "hooks", outcome: "failed", error: failure(error), path }];
  }
  if (outcome === "no_config") return [{ provider, item: "hooks", outcome, path: directory }];
  const lines: Line[] = [{ provider, item: "hooks", outcome, path }];
  if (provider === "codex") {
    const config = join(directory, "config.toml");
    try {
      lines.push({ provider, item: "title", outcome: await installCodexTitle(), path: config });
    } catch (error) {
      lines.push({ provider, item: "title", outcome: "failed", error: failure(error), path: config });
    }
  }
  return lines;
}
async function uninstallProvider(provider: Provider): Promise<Line[]> {
  remember(provider, true);
  const info = Provider.info(provider),
    directory = info.configDir(),
    path = join(directory, info.hooks_file);
  let hooks;
  try {
    hooks = uninstallHooks(provider);
  } catch (error) {
    return [{ provider, item: "hooks", outcome: "failed", error: failure(error), path }];
  }
  if (hooks.outcome === "no_config") return [{ provider, item: "hooks", outcome: "no_config", path: directory }];
  const lines: Line[] = [{ provider, item: "hooks", outcome: hooks.outcome, path }],
    backups = [path + ".corgi-backup"];
  if (provider === "codex") {
    const config = await uninstallCodexConfig(hooks.removal);
    lines.push(...config);
    // A failed edit keeps the backup that tells a retry what to restore.
    if (!config.some(line => line.outcome === "failed")) backups.push(join(directory, "config.toml.corgi-backup"));
  }
  for (const backup of backups)
    try {
      if (remove(backup)) lines.push({ provider, item: "backup", outcome: "removed", path: backup });
    } catch (error) {
      lines.push({ provider, item: "backup", outcome: "failed", error: failure(error), path: backup });
    }
  try {
    remove(join(directory, ".corgi-hooks.lock"));
  } catch {}
  return lines;
}
async function statusProvider(provider: Provider): Promise<Line[]> {
  const info = Provider.info(provider),
    directory = info.configDir(),
    path = join(directory, info.hooks_file),
    startup: Line[] = uninstalled(provider) ? [{ provider, item: "startup", outcome: "off", path: directory }] : [];
  if (!existsSync(directory)) return [{ provider, item: "hooks", outcome: "no_config", path: directory }, ...startup];
  let hooks: Line;
  try {
    const events = hookEvents(provider, existsSync(path) ? readFileSync(path, "utf8") : "{}"),
      outcome = events[0] === events[1] ? "present" : events[0] ? "partial" : "absent";
    hooks = { provider, item: "hooks", outcome, path, events };
    if (provider === "codex" && events[0])
      hooks.trust = await codexTrust([path, ...(existsSync(path) ? [realpathSync(path)] : [])]);
  } catch (error) {
    hooks = { provider, item: "hooks", outcome: "failed", error: failure(error), path };
  }
  const lines = [hooks];
  if (provider === "codex") {
    const config = join(directory, "config.toml");
    try {
      const title = existsSync(config)
        ? (Bun.TOML.parse(readFileSync(config, "utf8")) as any).tui?.terminal_title
        : null;
      const shown = Array.isArray(title) && title.includes("thread-id");
      lines.push({ provider, item: "title", outcome: shown ? "present" : "absent", path: config });
    } catch (error) {
      lines.push({ provider, item: "title", outcome: "failed", error: failure(error), path: config });
    }
  }
  return [...lines, ...startup];
}
function trusted(trust: Trust | undefined): string {
  if (!trust) return "";
  if ("error" in trust) return `; couldn't ask Codex if it trusts them: ${trust.error}`;
  if (!trust.total) return "; Codex doesn't load them";
  if (trust.trusted === trust.total) return ", trusted";
  if (!trust.trusted) return "; not trusted yet, approve them in Codex's /hooks";
  return `; Codex trusts ${trust.trusted} of ${trust.total}, approve the rest in /hooks`;
}
function describe(line: Line, home: string, op: Op): string {
  const at = home && line.path.startsWith(home + "/") ? "~" + line.path.slice(home.length) : line.path,
    what = line.item === "title" ? "thread ID " : "";
  switch (line.outcome) {
    case "added":
      return (
        `${what}added to ${at}` + (line.provider === "codex" && line.item === "hooks" ? "; trust them in /hooks" : "")
      );
    case "present":
      return op === "status" ? `${what}in ${at}${trusted(line.trust)}` : `${what}already in ${at}`;
    case "partial":
      return `${line.events?.[0]} of ${line.events?.[1]} events in ${at}; \`corgi integration install\` adds the rest`;
    case "removed":
      if (line.item === "backup") return `deleted ${at}`;
      return (
        `${what}removed from ${at}` + (line.moved ? `; renumbered ${line.moved} of yours so they stay trusted` : "")
      );
    case "absent":
      return op === "status" && !what ? `not in ${at}` : `${what ? "no " + what : "none "}in ${at}`;
    case "off":
      return "off, so Corgi won't add them when it starts";
    case "no_config":
      return `${op === "status" ? "" : "skipped, "}no ${at}`;
    case "failed":
      return `failed in ${at}: ${line.error}`;
  }
}
function mark(line: Line, op: Op): string {
  const trust = line.trust,
    untrusted = trust !== undefined && !("error" in trust) && trust.trusted < trust.total;
  if (line.outcome === "failed" || line.outcome === "partial" || untrusted) return "✗";
  return line.outcome === (op === "status" ? "present" : "added") || line.outcome === "removed" ? "✓" : "·";
}
type Op = "status" | "install" | "uninstall";
export const help = `Usage: corgi integration COMMAND [claude|codex]

  status      show what Corgi has added to each agent's settings
  install     add Corgi's hooks, and the thread ID to Codex's title
  uninstall   remove everything Corgi added; startup won't add it back

Without an agent, a command covers Claude Code and Codex.
`;
/** `corgi integration status|install|uninstall [PROVIDER]`: one line per
 * thing Corgi adds. False when any step failed. */
export async function command(op: Op, only: Provider | null): Promise<boolean> {
  const lines: Line[] = [],
    step = { status: statusProvider, install: installProvider, uninstall: uninstallProvider }[op];
  for (const provider of only ? [only] : Provider.all) lines.push(...(await step(provider)));
  const label = (p: Provider) => Provider.info(p).label,
    labels = Math.max(...lines.map(l => label(l.provider).length)),
    items = Math.max(...lines.map(l => l.item.length)),
    home = process.env.HOME ?? "";
  for (const line of lines)
    process.stdout.write(
      `${mark(line, op)} ${label(line.provider).padEnd(labels)}  ${line.item.padEnd(items)}  ${describe(line, home, op)}\n`,
    );
  if (op === "uninstall")
    process.stdout.write("Corgi won't add them back when it starts; `corgi integration install` does.\n");
  else if (op === "install" && lines.some(l => l.item === "hooks" && l.outcome === "added"))
    process.stdout.write("Agents started from now on report to Corgi; restart running ones.\n");
  return !lines.some(l => l.outcome === "failed");
}
