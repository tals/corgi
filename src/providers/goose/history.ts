import { spawn } from "node:child_process";
import type { SessionHistory } from "../adapter";
import { field, str, timestampMs } from "../common";
import { source, type Entry, type Store } from "../../launch/history";

/** `goose session list --format json` timestamps are RFC 3339; corgi's
 * parser takes at most 3 fraction digits, so trim longer fractions first. */
function updatedAt(s: string): number {
  const direct = timestampMs(s);
  if (direct !== null) return Math.floor(direct / 1000);
  const trimmed = s.replace(/(\.\d{3})\d+Z$/, "$1Z");
  const retry = timestampMs(trimmed);
  return retry !== null ? Math.floor(retry / 1000) : 0;
}
function entry(v: unknown): Entry | null {
  const session = str(v, "id");
  if (!session) return null;
  return {
    provider: "goose",
    account: "",
    session,
    cwd: str(v, "working_dir"),
    title: str(v, "user_set_name") || str(v, "name"),
    first: str(v, "last_message_snippet"),
    last: str(v, "last_message_snippet"),
    branch: "",
    interrupted: false,
    updated_at: updatedAt(str(v, "updated_at")),
  };
}
/** Sessions from `goose session list --format json`: a bare array, or an
 * object holding one. Field names follow goose's Session struct. */
export function sessionsFromJson(text: string): Entry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const rows = Array.isArray(parsed) ? parsed : field(parsed, "sessions");
  if (!Array.isArray(rows)) return [];
  return rows.map(entry).filter((e): e is Entry => e !== null);
}
function runList(): Promise<{ sessions: Entry[]; complete: boolean }> {
  return new Promise(resolve => {
    const child = spawn("goose", ["session", "list", "--format", "json"], { timeout: 10000 });
    let text = "";
    child.stdout.on("data", chunk => {
      text += chunk;
    });
    child.on("error", () => resolve({ sessions: [], complete: false }));
    child.on("close", code => {
      if (code !== 0) return resolve({ sessions: [], complete: false });
      resolve({ sessions: sessionsFromJson(text), complete: true });
    });
  });
}
export function open(account = ""): SessionHistory {
  const list = async (stopping: () => boolean) => {
    if (stopping()) return { sessions: [], complete: false };
    const result = await runList();
    return { sessions: result.sessions.map(e => ({ ...e, account })), complete: result.complete };
  };
  return {
    roots: () => [],
    list,
    async changed(_paths: string[], store: Store, stopping: () => boolean) {
      const result = await list(stopping);
      if (result.complete) store.replace(result.sessions, [source("goose", account)]);
    },
    close() {},
  };
}
