import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { processArgs } from "../../os";
import { Path } from "../../bounded_text";
import type { Runtime } from "../../runtime";
import type { Observer } from "../adapter";
import { Child, Name, Role, Snapshot, type Request } from "../snapshot";
import { Text } from "../common";
import { directory, validSession } from "./config";
import { database, workspace } from "./history";
import { requested, selected } from "./presence";
import { path } from "./transcript";

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
  private requests: (Request & { alreadyOpen: boolean })[] = [];
  private results: Snapshot[] = [];
  private last = new Map<number, string>();
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
        alreadyOpen: !p.attachment.actor && p.terminal.liveText().includes("Conversation already open"),
      }));
    for (const pane of this.last.keys()) if (!this.requests.some(r => r.pane === pane)) this.last.delete(pane);
  }
  async run() {
    if (this.running || this.stopping || !this.requests.length) return;
    this.running = true;
    const root = directory(this.account),
      file = database(root);
    let db: Database | null = null;
    try {
      const stamp = [file, file + "-wal"]
        .map(p => {
          const stat = statSync(p, { throwIfNoEntry: false });
          return [stat?.ino, stat?.size, stat?.mtimeMs].join(":");
        })
        .join("/");
      for (const request of this.requests) {
        const session =
          (await selected(request.pid, this.account)) ||
          (request.alreadyOpen && requested(processArgs(request.pid)?.argv ?? []));
        if (!session || this.stopping) continue;
        const key = [request.pid, request.generation, session, stamp].join("/");
        if (this.last.get(request.pane) === key && request.prefix.text() === session) continue;
        const out = new Snapshot(request, session, "unknown");
        out.lifecycle = false;
        out.transcript = new Path(path(root, session));
        if (statSync(file, { throwIfNoEntry: false })) {
          db ??= new Database(file, { readonly: true });
          metadata(db, root, out);
        }
        this.last.set(request.pane, key);
        this.results.push(out);
      }
    } catch {
      // The index may be locked or being created while agy changes conversations.
    } finally {
      db?.close();
      this.running = false;
    }
  }
  take() {
    return this.results.splice(0);
  }
  takeMissed() {
    return [];
  }
  stop() {
    this.stopping = true;
    clearInterval(this.timer);
  }
}
