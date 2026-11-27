import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { Path } from "../../bounded_text";
import type { Runtime } from "../../runtime";
import type { Observer } from "../adapter";
import { Child, Name, Role, Snapshot, type Request } from "../snapshot";
import { Text } from "../common";
import { directory, validSession } from "./config";
import { database, workspace } from "./history";
import { selected } from "./presence";
import { path } from "./transcript";

const metadata_ms = 5000;

function indexStamp(file: string) {
  try {
    return [file, file + "-wal"]
      .map(path => {
        const stat = statSync(path, { throwIfNoEntry: false });
        return stat ? [stat.ino, stat.size, stat.mtimeMs].join(":") : "";
      })
      .join("/");
  } catch {
    return null;
  }
}

type Row = {
  conversation_id: string;
  title: string;
  agent_name: string;
  workspace_uris: string;
  status: string;
  killed: number;
  updated: number;
};
export function metadata(db: Database, root: string, out: Snapshot) {
  const columns =
    "conversation_id,title,agent_name,workspace_uris,status,killed,unixepoch(last_modified_time) AS updated";
  const parent = db
    .query<Row, [string]>("SELECT " + columns + " FROM conversation_summaries WHERE conversation_id=?")
    .get(out.session);
  if (!parent) return;
  out.name = new Name(parent.title || "");
  out.cwd = new Path(workspace(parent.workspace_uris));
  const rows = db
    .query<Row, [string]>(
      "SELECT " +
        columns +
        " FROM conversation_summaries WHERE parent_conversation_id=? ORDER BY last_modified_time DESC LIMIT 257",
    )
    .all(out.session);
  out.children_complete = rows.length <= 256;
  for (const row of rows.slice(0, 256)) {
    if (!validSession(row.conversation_id)) continue;
    const child = new Child();
    child.session = row.conversation_id;
    child.name = new Name(row.title || "");
    child.role = new Role(row.agent_name || "");
    child.transcript = new Path(path(root, child.session));
    child.updated_at = row.updated || 0;
    child.state =
      row.killed || row.status === "CASCADE_RUN_STATUS_IDLE"
        ? "idle"
        : ["CASCADE_RUN_STATUS_RUNNING", "CASCADE_RUN_STATUS_BUSY", "CASCADE_RUN_STATUS_CANCELING"].includes(row.status)
          ? "working"
          : "unknown";
    if (child.state === "working") out.subagents.running++;
    out.children.push(child);
  }
}
export class Worker implements Observer {
  running = false;
  stopping = false;
  private requests: Request[] = [];
  private results = new Map<number, Snapshot>();
  private missed = new Map<number, Request>();
  private last = new Map<
    number,
    { generation: bigint; pid: number; session: string; at: number; stamp: string | null }
  >();
  private timer = setInterval(() => void this.run(), 1000);
  constructor(private account: string) {}
  reconcile(runtime: Runtime) {
    this.requests = runtime.panes
      .filter(
        p =>
          !p.terminal.exited &&
          p.detection.pid > 0 &&
          !p.detection.missing &&
          !p.detection.claim &&
          p.agent().provider === "antigravity" &&
          p.account() === this.account,
      )
      .map(p => ({
        pane: p.id,
        pid: p.detection.pid,
        actor: 0,
        generation: p.attachment.generation,
        title_revision: 0n,
        prefix: new Text(p.attachment.actor?.state.sessionId() || ""),
        identity: "process",
      }));
    for (const pane of this.last.keys()) if (!this.requests.some(r => r.pane === pane)) this.last.delete(pane);
  }
  async run() {
    if (this.running || this.stopping || !this.requests.length) return;
    this.running = true;
    const root = directory(this.account),
      file = database(root),
      stamp = indexStamp(file);
    let db: Database | null = null;
    try {
      for (const request of this.requests) {
        const session = await selected(request.pid, this.account);
        if (this.stopping) return;
        const last = this.last.get(request.pane),
          now = Date.now();
        if (!session) {
          this.results.delete(request.pane);
          // Allow a transient inspection failure to recover before retiring a recently verified selection.
          if (
            session === undefined &&
            last?.pid === request.pid &&
            last.session === request.prefix.text() &&
            now >= last.at &&
            now - last.at < 2 * metadata_ms
          )
            continue;
          this.last.delete(request.pane);
          if (request.prefix.len) this.missed.set(request.pane, request);
          continue;
        }
        this.missed.delete(request.pane);
        // Re-read child status while the index is quiet, before its observation expires.
        if (
          last?.pid === request.pid &&
          last.generation === request.generation &&
          last.session === session &&
          last.stamp === stamp &&
          request.prefix.text() === session &&
          now >= last.at &&
          now - last.at < metadata_ms
        )
          continue;
        const out = new Snapshot(request, session, "unknown");
        out.lifecycle = false;
        out.transcript = new Path(path(root, session));
        try {
          db ??= new Database(file, { readonly: true });
          metadata(db, root, out);
        } catch {
          // The presence lock still identifies the session while agy creates or locks its index.
        }
        this.last.set(request.pane, { pid: request.pid, generation: request.generation, session, at: now, stamp });
        this.results.set(request.pane, out);
      }
    } finally {
      db?.close();
      this.running = false;
    }
  }
  take() {
    const results = [...this.results.values()];
    this.results.clear();
    return results;
  }
  takeMissed() {
    const missed = [...this.missed.values()];
    this.missed.clear();
    return missed;
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
