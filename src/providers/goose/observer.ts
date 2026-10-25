//! Goose usage, read from its sessions database: the observer the daemon
//! starts with itself, for what goose's hooks and (absent) transcripts leave
//! out. Snapshots carry usage only: every other field is the actor's own
//! current value, captured in the same tick, so a usage snapshot can never
//! disturb hook-driven state. Actors with a permission prompt pending are
//! skipped until it resolves, and a session reports only when its totals
//! changed, so idle sessions cost the tick nothing.
import { Snapshot, Turn, type Request } from "../snapshot";
import { Text } from "../common";
import type { Observer } from "../adapter";
import type { Runtime } from "../../runtime";
import type { State } from "../../agents";
import type { Inventory } from "../../activity/background_tasks";
import { readUsage, sessionsDbPath } from "./usage";

type Tracked = {
  request: Request;
  state: State;
  tool: string;
  turn: string;
  subagents: { running: number; blocked: number; waiting: boolean };
  background_tasks: Inventory;
};

export class GooseObserver implements Observer {
  running = false;
  stopping = false;
  private tracked: Tracked[] = [];
  private emitted = new Map<string, string>();
  private dbPath = sessionsDbPath();
  /** TEMPORARY debug: one line per key, so the daemon log stays readable. */
  private logged = new Set<string>();

  constructor() {
    console.error(`[goose-observer] started, db ${this.dbPath}`);
  }

  private logOnce(key: string, line: string) {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    console.error(line);
  }

  reconcile(runtime: Runtime) {
    this.tracked = [];
    const seen = new Set<string>();
    for (const actor of runtime.conversations.items) {
      if (this.tracked.length >= 64) break;
      const a = actor.state;
      if (a.provider !== "goose") continue;
      if (!a.session.len) {
        this.logOnce(`nosession:${actor.id}`, `[goose-observer] actor ${actor.id} has no session yet`);
        continue;
      }
      if (a.permission_review !== null) {
        this.logOnce(
          `perm:${actor.id}`,
          `[goose-observer] actor ${actor.id} session ${a.sessionId()}: permission pending`,
        );
        continue;
      }
      const session = a.sessionId();
      seen.add(session);
      this.tracked.push({
        request: { pane: 0, pid: 0, prefix: new Text(session), actor: actor.id, generation: 0n, title_revision: 0n },
        state: a.state,
        tool: a.tool.text(),
        turn: a.turnId(),
        subagents: { ...a.subagents },
        background_tasks: actor.background_tasks,
      });
    }
    for (const session of this.emitted.keys()) if (!seen.has(session)) this.emitted.delete(session);
  }

  /** Usage is read synchronously in take(), in the same tick as reconcile. */
  async run() {}

  take(): Snapshot[] {
    if (this.stopping) return [];
    const out: Snapshot[] = [];
    for (const t of this.tracked) {
      const session = t.request.prefix.text(),
        usage = readUsage(this.dbPath, session);
      if (!usage) {
        this.logOnce(`norow:${session}`, `[goose-observer] no db row for session ${session} (db ${this.dbPath})`);
        continue;
      }
      const key = `${usage.input}/${usage.output}/${usage.cached_input}`;
      if (this.emitted.get(session) === key) continue;
      this.emitted.set(session, key);
      console.error(`[goose-observer] emit session ${session}: ${key}`);
      const snapshot = new Snapshot(t.request, session, t.state);
      snapshot.usage = { total: usage, last: null };
      snapshot.tool = t.tool;
      snapshot.turn = new Turn(t.turn);
      snapshot.subagents = { ...t.subagents };
      snapshot.background_tasks = t.background_tasks;
      snapshot.updated_at = snapshot.observed_at;
      out.push(snapshot);
    }
    return out;
  }

  takeMissed() {
    return [];
  }

  stop() {
    this.stopping = true;
    this.tracked = [];
  }
}
