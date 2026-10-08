import { closeSync, existsSync, lstatSync, openSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Provider } from "./providers";
import { hookOrigin } from "./detection";
import { flock } from "./native_bridge";
import { atomicWrite, quote } from "./os";
import * as discovery from "./discovery";
import * as rpc from "./rpc";
import * as codexConfig from "./codex_config";
import { Pool } from "./inference";
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
export async function install(provider: Provider): Promise<void> {
  const info = Provider.info(provider),
    directory = info.configDir();
  if (!existsSync(directory)) return;
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
      after = mergedConfig(provider, before);
    if (after === null) return;
    if (stat)
      try {
        writeFileSync(path + ".corgi-backup", before, { flag: "wx", mode: 0o600 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    if (stat ? readFileSync(path, "utf8") !== before : existsSync(path)) throw Error("HookSettingsChanged");
    atomicWrite(path, after + "\n", stat ? stat.mode & 0o777 : 0o600, false);
  } finally {
    flock(lock, false);
    closeSync(lock);
  }
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
export async function installCodexTitle(): Promise<void> {
  const directory = Provider.info("codex").configDir();
  if (!existsSync(directory)) return;
  const path = join(directory, "config.toml"),
    pool = new Pool({ config: { provider: "codex", timeout_ms: 3000 } });
  try {
    const connection = await pool.metadata(),
      deadline = Date.now() + 3000;
    const reply = await connection.rpc("config/read", { includeLayers: true }, undefined, deadline);
    const edit = codexConfig.edit(reply.result, path);
    if (!edit) return;
    codexConfig.backup(path);
    await connection.rpc("config/value/write", edit, undefined, deadline);
  } finally {
    pool.deinit();
  }
}
