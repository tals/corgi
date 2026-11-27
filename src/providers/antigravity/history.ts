import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionHistory } from "../adapter";
import { copied, source, type Entry } from "../../launch/history";
import { directory, validSession } from "./config";

export const database = (root: string) => join(root, "conversation_summaries.db");
export function workspace(uris: string) {
  try {
    return fileURLToPath(JSON.parse(uris)[0]);
  } catch {
    return "";
  }
}
export function entries(root: string, account: string, stopping: () => boolean): Entry[] {
  if (!existsSync(database(root))) return [];
  const db = new Database(database(root), { readonly: true });
  try {
    const rows = db.query<
      { conversation_id: string; title: string; preview: string; workspace_uris: string; updated: number },
      []
    >(
      "SELECT conversation_id, title, preview, workspace_uris, unixepoch(last_modified_time) AS updated FROM conversation_summaries WHERE parent_conversation_id = '' AND step_count > 0 ORDER BY last_modified_time DESC",
    );
    const sessions: Entry[] = [];
    for (const row of rows.iterate()) {
      if (stopping()) break;
      if (!validSession(row.conversation_id)) continue;
      const cwd = workspace(row.workspace_uris);
      if (!cwd) continue;
      sessions.push(
        copied({
          provider: "antigravity",
          account,
          session: row.conversation_id,
          cwd,
          title: row.title || "",
          first: "",
          last: row.preview || "",
          branch: "",
          updated_at: row.updated ?? 0,
          interrupted: false,
        }),
      );
    }
    return sessions;
  } finally {
    db.close();
  }
}
export function open(account: string): SessionHistory {
  const root = directory(account),
    db = database(root);
  const list = async (stopping: () => boolean) => {
    try {
      const sessions = entries(root, account, stopping);
      return { sessions, complete: !stopping() };
    } catch {
      return { sessions: [], complete: false };
    }
  };
  return {
    roots: () => [root],
    list,
    async changed(paths, store, stopping) {
      if (!paths.some(p => p === db || p === db + "-wal" || p === db + "-journal")) return;
      const { sessions, complete } = await list(stopping);
      store.replace(sessions, complete ? [source("antigravity", account)] : []);
    },
    close() {},
  };
}
