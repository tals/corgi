import { parse } from "./json";
import { open, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Agent } from "./agents";
import type { Outcome } from "./observation";
import { Codex } from "./providers/codex";
import { Claude } from "./providers/claude";
import { str, field, timestampMs } from "./providers/common";
export const read_budget = 64 * 1024,
  initial_tail = 256 * 1024,
  record_limit = 64 * 1024;
export type Result = { actor: number; seq: number; outcome: Outcome };
export async function verifySession(
  file: FileHandle,
  provider: string,
  session: string,
) {
  if (provider === "claude") return;
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < 1024 * 1024) {
    const chunk = Buffer.alloc(Math.min(4096, 1024 * 1024 - size));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
    if (!bytesRead) throw Error("NoIdentity");
    const end = chunk.subarray(0, bytesRead).indexOf(10);
    chunks.push(chunk.subarray(0, end >= 0 ? end : bytesRead));
    size += bytesRead;
    if (end >= 0) {
      const rollout = Codex.Rollout.decode(
        parse(Buffer.concat(chunks).toString()),
      );
      if (
        rollout.type !== "session_meta" ||
        str(rollout.payload, "id") !== session
      )
        throw Error("WrongSession");
      return;
    }
  }
  throw Error("NoIdentity");
}
export function completion(agent: Agent, line: string): Outcome | null {
  let v: any;
  try {
    v = parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const stamp = timestampMs(str(v, "timestamp"));
  if (stamp === null || stamp < Math.trunc(agent.last_seq / 1000)) return null;
  if (agent.provider === "codex") {
    const rollout = Codex.Rollout.decode(v);
    if (
      rollout.type !== "event_msg" ||
      !agent.turn.len ||
      str(rollout.payload, "turn_id") !== agent.turnId()
    )
      return null;
    const kind = rollout.payloadType();
    if (kind === "turn_aborted") return "interrupted";
    if (kind === "task_complete" || kind === "turn_complete")
      return field(rollout.payload, "error") !== null ? "failed" : "completed";
    return null;
  }
  if (agent.provider === "claude") {
    const decoded = Claude.Line.decode(v);
    if (!decoded || decoded.sessionId !== agent.sessionId()) return null;
    if (decoded.type === "system" && decoded.subtype === "turn_duration")
      return "completed";
    const attachment = field(v, "attachment");
    if (
      decoded.type === "attachment" &&
      str(attachment, "type") === "hook_cancelled" &&
      str(attachment, "hookEvent") === "Stop" &&
      field(attachment, "timedOut") === false
    )
      return "interrupted";
  }
  return null;
}
export class Tail {
  actor = 0;
  seq = 0;
  inode = 0;
  device = 0;
  offset = 0;
  partial = Buffer.alloc(0);
  discard = false;
  finished = false;
  next_check = 0;
  attempts = 0;
  ingest(agent: Agent, bytes: Buffer | string): Outcome | null {
    const input = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    let found: Outcome | null = null,
      start = 0;
    while (start < input.length) {
      const at = input.indexOf(10, start),
        complete = at >= 0,
        end = complete ? at : input.length,
        segment = input.subarray(start, end);
      start = end + Number(complete);
      if (
        !this.discard &&
        this.partial.length + segment.length > record_limit
      ) {
        this.partial = Buffer.alloc(0);
        this.discard = true;
      }
      if (!this.discard) this.partial = Buffer.concat([this.partial, segment]);
      if (complete) {
        if (!this.discard)
          found = completion(agent, this.partial.toString()) ?? found;
        this.partial = Buffer.alloc(0);
        this.discard = false;
      }
    }
    return found;
  }
  close() {
    this.inode = 0;
    this.device = 0;
    this.offset = 0;
    this.partial = Buffer.alloc(0);
    this.discard = false;
    this.finished = false;
    this.next_check = 0;
    this.attempts = 0;
  }
  async poll(agent: Agent) {
    const file = await open(agent.transcriptPath(), "r");
    try {
      const stat = await file.stat(),
        named = await lstat(agent.transcriptPath());
      if (!named.isFile()) throw Error("Replaced");
      if (!this.inode) {
        if (!agent.provider) throw Error("NoProvider");
        await verifySession(file, agent.provider, agent.sessionId());
        this.offset = Math.max(0, stat.size - initial_tail);
        this.discard = this.offset > 0;
        this.partial = Buffer.alloc(0);
        this.inode = stat.ino;
        this.device = stat.dev;
      }
      if (
        stat.ino !== this.inode ||
        named.ino !== this.inode ||
        named.dev !== this.device ||
        stat.size < this.offset
      )
        throw Error("Replaced");
      if (stat.size === this.offset) return null;
      const bytes = Buffer.alloc(read_budget);
      const { bytesRead } = await file.read(
        bytes,
        0,
        bytes.length,
        this.offset,
      );
      this.offset += bytesRead;
      return this.ingest(agent, bytes.subarray(0, bytesRead));
    } finally {
      await file.close();
    }
  }
}
export class Worker {
  stopping = false;
  requests: Array<{ actor: number; agent: Agent }> = [];
  cursor = 0;
  results: Result[] = [];
  watchers = new Map<number, Tail>();
  timer: ReturnType<typeof setInterval> | null = null;
  running = false;
  static start() {
    const w = new Worker();
    w.timer = setInterval(() => void w.run(), 250);
    return w;
  }
  stop() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.watchers.clear();
  }
  reconcile(actors: Array<{ id: number; state: Agent }>) {
    this.requests = actors
      .filter(
        (a) =>
          a.state.observation.pending_stop &&
          a.state.transcript.len &&
          a.state.session.len,
      )
      .map((a) => ({ actor: a.id, agent: a.state.snapshot() }));
  }
  batch(limit = 64) {
    const count = Math.min(limit, this.requests.length);
    const out = Array.from(
      { length: count },
      (_, i) => this.requests[(this.cursor + i) % this.requests.length],
    );
    if (this.requests.length)
      this.cursor = (this.cursor + count) % this.requests.length;
    return out;
  }
  take() {
    const results = this.results;
    this.results = [];
    return results;
  }
  async run() {
    if (this.running || this.stopping) return;
    this.running = true;
    try {
      for (const req of this.batch()) {
        let t = this.watchers.get(req.actor);
        if (!t) {
          t = new Tail();
          this.watchers.set(req.actor, t);
        }
        if (t.seq !== req.agent.last_seq) {
          t.close();
          t.actor = req.actor;
          t.seq = req.agent.last_seq;
        }
        const now = Date.now();
        if (t.finished || now < t.next_check || this.results.length >= 64)
          continue;
        t.attempts = Math.min(0xffffffff, t.attempts + 1);
        t.next_check = now + (t.attempts < 20 ? 250 : 2000);
        try {
          const outcome = await t.poll(req.agent);
          if (outcome) {
            this.results.push({
              actor: req.actor,
              seq: req.agent.last_seq,
              outcome,
            });
            t.finished = true;
          }
        } catch {
          t.inode = 0;
        }
      }
    } finally {
      this.running = false;
    }
  }
}
