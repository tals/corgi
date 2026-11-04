//! OpenCode's conversations as corgi grep reads them, from the database it
//! keeps them in. Newer OpenCode keeps assistant content in `session_part`
//! rows; older rows keep theirs inline.
import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { join } from "node:path";
import * as search from "../search";
import * as tools from "../search_tools";
import type { Found, Message, Search } from "../search";
import type { Tool, ToolRecord } from "../search_tools";
import { dataDir } from "./api";

type Row = { id: string; type: string; time_created: number; data: string };
/** Opened read-only while OpenCode has it open; once OpenCode has closed it and
 * dropped its WAL files, only a read-write connection can, as `api.login` finds. */
function open(file: string): Database {
  let failure: unknown;
  for (const options of [{ readonly: true }, { readwrite: true, create: false }]) {
    let db: Database | undefined;
    try {
      db = new Database(file, options);
      db.exec("PRAGMA busy_timeout = 2000");
      db.query("SELECT 1 FROM sqlite_master LIMIT 1").get();
      return db;
    } catch (error) {
      db?.close();
      failure = error;
    }
  }
  throw failure;
}
const has = (db: Database, table: string) =>
  db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== null;
const str = (v: unknown) => (typeof v === "string" ? v : "");
const exit = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
/** A conversation's database and session ID, from its source. */
function located(found: Found) {
  const at = found.source.lastIndexOf("#");
  return { file: found.source.slice(0, at), session: found.source.slice(at + 1) };
}
/** A call and its result, paired as the record holding both says, so a
 * provider reusing a call ID can't lend one call another's outcome. */
function paired(call: ToolRecord, result: ToolRecord | null): ToolRecord[] {
  call.tool.call_ref = call.ref;
  if (!result) return [call];
  Object.assign(result.tool, { call_ref: call.ref, result_ref: result.ref });
  Object.assign(call.tool, { status: result.tool.status, exit_code: result.tool.exit_code, result_ref: result.ref });
  return [call, result];
}
/** A tool part: its call, and its result once it has one. */
function toolPart(value: unknown, row: Row): ToolRecord[] {
  const part = tools.object(value);
  if (part.type !== "tool") return [];
  const state = tools.object(part.state),
    time = tools.object(part.time),
    metadata = tools.object(state.metadata),
    code = exit(metadata.exit);
  const running = state.status === "running" || metadata.status === "running";
  const call = tools.record(
    tools.call(part.name, state.input),
    time.created ?? row.time_created,
    row.id,
    tools.info("call", part.name, part.id, running ? { status: "running", exit_code: code } : undefined),
  );
  if (state.status !== "completed" && state.status !== "error") return paired(call, null);
  const status: Tool["status"] =
    state.status === "error" || (code !== null && code !== 0) ? "error" : running ? "running" : "success";
  const text = [tools.content(state.content), str(tools.object(state.error).message)].filter(Boolean).join("\n");
  return paired(
    call,
    tools.record(
      text,
      time.completed ?? row.time_created,
      row.id,
      tools.info("result", part.name, part.id, { status, exit_code: code }),
    ),
  );
}
/** A command the user ran with `!`, and its output once it ended. */
function shell(data: Record<string, any>, row: Row): ToolRecord[] {
  const code = exit(data.exit),
    time = tools.object(data.time),
    id = str(data.shellID) || row.id;
  const status: Tool["status"] =
    data.status === "running"
      ? "running"
      : data.status === "killed"
        ? "interrupted"
        : data.status === "timeout" || (code !== null && code !== 0)
          ? "error"
          : code === 0
            ? "success"
            : null;
  const call = tools.record(
    tools.call(tools.userShell, { command: data.command }),
    time.created ?? row.time_created,
    row.id,
    tools.info("call", tools.userShell, id, data.status === "running" ? { status, exit_code: null } : undefined),
  );
  if (data.status === "running") return paired(call, null);
  const output = str(tools.object(data.output).output);
  return paired(
    call,
    tools.record(
      output,
      time.completed ?? row.time_created,
      row.id,
      tools.info("result", tools.userShell, id, { status, exit_code: code }),
    ),
  );
}
export const conversations: Search = {
  version: 1,
  home: dataDir,
  async discover(folder, context) {
    const file = join(folder, "opencode.db");
    if (!fs.existsSync(file) || !context.claim(fs.realpathSync(file))) return [];
    // A store that won't open throws, and the index keeps what it had.
    const db = open(file);
    try {
      if (!has(db, "session_v2") || !has(db, "session_message")) {
        context.warn(`OpenCode database has no sessions this Corgi reads: ${file}`);
        return [];
      }
      // OpenCode touches a session's row as each step starts and ends, and
      // counting its messages and parts reads only their indexes.
      const parts = has(db, "session_part")
        ? "LEFT JOIN (SELECT session_id, COUNT(*) AS n FROM session_part GROUP BY session_id) p ON p.session_id = s.id"
        : "LEFT JOIN (SELECT NULL AS session_id, 0 AS n) p ON 0";
      const rows = db
        .query<{ id: string; directory: string; title: string | null; time_updated: number; stamp: string }, []>(
          `SELECT s.id, s.directory, s.title, s.time_updated,
             s.time_updated || ':' || COALESCE(m.n, 0) || ':' || COALESCE(m.seq, 0) || ':' || COALESCE(p.n, 0) AS stamp
           FROM session_v2 s
           LEFT JOIN (SELECT session_id, COUNT(*) AS n, MAX(seq) AS seq FROM session_message GROUP BY session_id) m
             ON m.session_id = s.id
           ${parts}
           WHERE s.parent_id IS NULL`,
        )
        .all();
      context.checking(rows.length);
      const found: Found[] = [];
      for (const r of rows) {
        await context.checked();
        const source = `${file}#${r.id}`;
        if (context.skipped(source, r.stamp)) {
          context.exclude(source, r.stamp);
          continue;
        }
        const known = context.known(source, r.stamp);
        if (known) found.push(known);
        else if (r.directory)
          found.push({
            session: r.id,
            cwd: r.directory,
            source,
            stamp: r.stamp,
            bytes: 0,
            updated_at: r.time_updated,
            title: r.title ?? "",
          });
      }
      return found;
    } finally {
      db.close();
    }
  },
  async read(found, withTools) {
    const { file, session } = located(found),
      db = open(file);
    try {
      const rows = db
        .query<Row, [string]>(
          "SELECT id, type, time_created, data FROM session_message WHERE session_id = ? ORDER BY seq",
        )
        .all(session);
      const parts = new Map<string, unknown[]>();
      let malformed = 0;
      if (has(db, "session_part"))
        for (const p of db
          .query<{ message_id: string; data: string }, [string]>(
            "SELECT message_id, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal",
          )
          .iterate(session))
          try {
            const list = parts.get(p.message_id) ?? [];
            list.push(JSON.parse(p.data));
            parts.set(p.message_id, list);
          } catch {
            malformed++;
          }
      const messages: Message[] = [],
        records: ToolRecord[] = [];
      for (const row of rows) {
        let data: Record<string, any>;
        try {
          data = tools.object(JSON.parse(row.data));
        } catch {
          malformed++;
          continue;
        }
        if (row.type === "user") {
          const text = typeof data.text === "string" ? data.text : tools.content(data.content);
          messages.push(...search.prose("user", text, row.time_created, row.id));
        } else if (row.type === "assistant") {
          const content = parts.get(row.id) ?? (Array.isArray(data.content) ? data.content : []);
          const text = content
            .map(tools.object)
            .filter(p => p.type === "text")
            .map(p => str(p.text))
            .filter(Boolean)
            .join("\n");
          messages.push(...search.prose("assistant", text, row.time_created, row.id));
          if (withTools) for (const part of content) records.push(...toolPart(part, row));
        } else if (row.type === "shell" && withTools) records.push(...shell(data, row));
      }
      const result = search.normalize(messages, malformed);
      result.title = search.title(found.title ?? "") || result.title;
      if (withTools) result.tools = search.normalize(records).messages;
      return result;
    } finally {
      db.close();
    }
  },
};
