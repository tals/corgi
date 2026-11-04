//! The reasoning effort a launch asks for. Codex runs any `-c` override on a
//! server of its own, out of reach of Corgi's RPC and Codex's agent list, so
//! where the launcher's effort is the only one and nothing else keeps Codex
//! off the shared server, the override comes off and Corgi sets the effort
//! there once the thread runs.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as effort from "../effort";
import * as config from "./config";
import { field, str, Text } from "../common";
import * as socket from "./socket";
import * as observer from "./observer";
import * as errors from "../../errors";
import type { Settled } from "../adapter";
/** Options seen to keep Codex 0.166 on the shared server, and whether each
 * takes a value. */
const shared: Record<string, boolean> = {
  "--model": true,
  "-m": true,
  "--sandbox": true,
  "-s": true,
  "--ask-for-approval": true,
  "-a": true,
  "--cd": true,
  "-C": true,
  "--dangerously-bypass-approvals-and-sandbox": false,
  "--yolo": false,
};
/** Subcommands that stay there, each followed by the thread it opens. */
const subcommands = ["resume", "fork"];
/** The effort a `-c` value sets; null for any other override. */
function override(value: string): effort.Effort | null {
  const set = /^model_reasoning_effort\s*=\s*(.*)$/s.exec(value);
  return set ? effort.parse(set[1].trim().replace(/^(["'])(.*)\1$/s, "$2")) : null;
}
/** `args` without their effort override, and that effort; null when they
 * have none, or when something else in them keeps Codex off the shared
 * server, where the override then stays. */
export function deferred(args: string[]): { args: string[]; effort: effort.Effort } | null {
  const kept: string[] = [];
  let found: effort.Effort | null = null,
    subcommand = false;
  for (let i = 0; i < args.length; i++) {
    const word = args[i],
      [flag, inline] = word.startsWith("--") ? word.split(/=(.*)/s) : [word, undefined];
    if (flag === "-c" || flag === "--config" || /^-c./s.test(word)) {
      const value = /^-c./s.test(word) ? word.slice(2) : (inline ?? args[++i]),
        chosen = value === undefined ? null : override(value);
      if (!chosen || found) return null;
      found = chosen;
    } else if (flag in shared) {
      kept.push(word);
      if (shared[flag] && inline === undefined) {
        if (i + 1 >= args.length) return null;
        kept.push(args[++i]);
      }
    } else if (!subcommand && subcommands.includes(word) && /^[^-]/.test(args[i + 1] ?? "")) {
      subcommand = true;
      kept.push(word, args[++i]);
    } else return null;
  }
  return found ? { args: kept, effort: found } : null;
}
/** Whether Corgi can set the effort of the threads Codex with settings in
 * `home` opens: Codex starts the shared server when none runs, unless its
 * config turns `daemon_auto_start` off, and Corgi learns which thread a pane
 * shows from the thread ID its integration puts in Codex's title. Nothing
 * else ties a thread on that server to a pane, and Corgi's observer and
 * retries skip a pane whose title doesn't name its thread too. */
export function reachable(home: string) {
  const path = join(home, "config.toml");
  if (!existsSync(path)) return false;
  let settings: any;
  try {
    settings = Bun.TOML.parse(readFileSync(path, "utf8"));
  } catch {
    // Unread, it may turn the shared server off or leave the title out. Codex
    // refuses a config.toml that doesn't parse, so the flag rarely matters.
    return false;
  }
  return settings?.features?.daemon_auto_start !== false && titled(settings);
}
/** The oldest Codex seen to start and join the shared server; older ones run
 * a server of their own whatever their options, so the flag costs nothing. */
const shared_since = [0, 162, 1];
/** Whether Codex as `--version` says, null when Corgi hasn't asked it,
 * joins the shared server. */
export function joins(version: string | null) {
  const found = /^codex-cli (\d+)\.(\d+)\.(\d+)/.exec(version ?? "");
  if (!found) return true;
  for (let i = 0; i < shared_since.length; i++) {
    const ahead = Number(found[i + 1]) - shared_since[i];
    if (ahead) return ahead > 0;
  }
  return true;
}
function titled(settings: any) {
  try {
    return config.titleItems(settings?.tui) === null;
  } catch {
    return false;
  }
}
/** Sets `chosen` on the thread `named` names, in full or as the prefix its
 * title shows, through the server listening at `path`, unless `last`, the
 * thread it set before, no longer has it, as after a `/model` there: Codex
 * starts a thread with the effort its TUI shows, which then is someone's own.
 * The thread it set, "changed", or null while that server doesn't run it,
 * as before Codex has loaded it. */
export async function settle(
  path: string,
  named: string,
  chosen: effort.Effort,
  last: string | null = null,
): Promise<Settled> {
  let client: socket.Client;
  try {
    client = await socket.Client.open(path);
  } catch (error) {
    if (errors.is(error, "ConnectFailed") || errors.is(error, "Timeout")) return null;
    throw error;
  }
  try {
    let session: string | null = named;
    if (named.length !== 36) {
      const ids: string[] = [];
      await observer.pages(client, "thread/loaded/list", { limit: 100 }, id => void ids.push(id), "TooManyThreads");
      session = observer.unique(ids, new Text(named));
    }
    if (!session) return null;
    const status = str(field(await thread(client, session), "status"), "type");
    if (!status || status === "notLoaded") return null;
    if (last && last !== session && str(await thread(client, last).catch(gone), "reasoningEffort") !== chosen)
      return "changed";
    await client.call("thread/settings/update", { threadId: session, effort: chosen });
    return { session };
  } catch (error) {
    switch (errors.name(error)) {
      case "RpcError":
      case "Timeout":
      case "Disconnected":
      case "BadResponse":
      case "TooManyThreads":
        return null;
    }
    throw error;
  } finally {
    client.close();
  }
}
async function thread(client: socket.Client, session: string) {
  return field(field(await client.call("thread/read", { threadId: session, includeTurns: false }), "result"), "thread");
}
/** A thread the server can't read any more, whose effort no one can tell. */
function gone(error: unknown) {
  if (errors.is(error, "RpcError")) return null;
  throw error;
}
