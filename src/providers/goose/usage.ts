//! Goose usage totals, read from its sessions database.
//!
//! Goose keeps no transcript, so its usage lives in SQLite: the sessions
//! table's accumulated columns are the session totals, the same numbers its
//! own UI reports. The read is deliberately small and total: one indexed
//! lookup, never a throw, so the observer tick can never break on it.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Tokens } from "../../usage/live";

/** Where goose's sessions database lives, mirroring its data dir. */
export function sessionsDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const root = env.GOOSE_PATH_ROOT;
  if (root && root.startsWith("/"))
    for (const candidate of [join(root, "sessions", "sessions.db"), join(root, "data", "sessions", "sessions.db")])
      if (existsSync(candidate)) return candidate;
  if (root && root.startsWith("/")) return join(root, "sessions", "sessions.db");
  const data =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.startsWith("/")
      ? env.XDG_DATA_HOME
      : env.HOME
        ? join(env.HOME, ".local", "share")
        : "";
  return data ? join(data, "goose", "sessions", "sessions.db") : "";
}

/** `session`'s accumulated usage, mapped the way pi reports its own. */
export function readUsage(dbPath: string, session: string): Tokens | null {
  if (!dbPath || !session) return null;
  let db: Database;
  try {
    db = new Database(dbPath, { readonly: true });
  } catch {
    return null;
  }
  try {
    const row = db
      .query(
        `SELECT accumulated_input_tokens, accumulated_output_tokens,
                accumulated_cache_read_tokens, accumulated_cache_write_tokens
         FROM sessions WHERE id = ?`,
      )
      .get(session) as {
      accumulated_input_tokens: number | null;
      accumulated_output_tokens: number | null;
      accumulated_cache_read_tokens: number | null;
      accumulated_cache_write_tokens: number | null;
    } | null;
    if (!row) return null;
    const input = BigInt(row.accumulated_input_tokens ?? 0),
      output = BigInt(row.accumulated_output_tokens ?? 0),
      read = BigInt(row.accumulated_cache_read_tokens ?? 0),
      write = BigInt(row.accumulated_cache_write_tokens ?? 0);
    return new Tokens({ input: input + read + write, cached_input: read, output });
  } catch {
    return null;
  } finally {
    db.close();
  }
}
