import { parse } from "./json";
import { open, lstat } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import type { Agent } from "./agents";
import type { Outcome } from "./observation";
import { adapter } from "./providers";
import { str, timestampMs } from "./providers/common";
export const read_budget = 64 * 1024,
  initial_tail = 256 * 1024,
  record_limit = 64 * 1024;
export type Result = { actor: number; seq: bigint; outcome: Outcome };
/** A transcript's first record, or null when its first MiB holds none. */
export async function head(file: FileHandle): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  while (size < 1024 * 1024) {
    const chunk = Buffer.alloc(Math.min(4096, 1024 * 1024 - size));
    const { bytesRead } = await file.read(chunk, 0, chunk.length, size);
    if (!bytesRead) return null;
    const end = chunk.subarray(0, bytesRead).indexOf(10);
    chunks.push(chunk.subarray(0, end >= 0 ? end : bytesRead));
    size += bytesRead;
    if (end >= 0)
      try {
        return parse(Buffer.concat(chunks).toString());
      } catch {
        return null;
      }
  }
  return null;
}
/** How long a transcript stays quiet after a record that settles a turn
 * before that turn counts as ended. */
export const settle_ms = 2000;
/** A record written no earlier than `agent`'s latest hook, from a provider that reads transcripts. */
function fresh(agent: Agent, line: string) {
  let v: any;
  try {
    v = parse(line);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object" || !agent.provider) return null;
  const stamp = timestampMs(str(v, "timestamp"));
  if (stamp === null || BigInt(stamp) < agent.last_seq / 1000n) return null;
  const transcript = adapter(agent.provider).transcript;
  return transcript ? { v, transcript } : null;
}
export function completion(agent: Agent, line: string): Outcome | null {
  const r = fresh(agent, line);
  return r ? r.transcript.completion(agent, r.v) : null;
}
export function settling(agent: Agent, line: string) {
  const r = fresh(agent, line);
  return r ? (r.transcript.settling?.(agent, r.v) ?? null) : null;
}
export class Tail {
  actor = 0;
  seq = 0n;
  inode = 0;
  device = 0;
  offset = 0;
  partial = Buffer.alloc(0);
  discard = false;
  finished = false;
  next_check = 0;
  attempts = 0;
  /** When the transcript last wrote a record that settles the turn, or 0. */
  settling_at = 0;
  ingest(agent: Agent, bytes: Buffer | string, now = Date.now()): Outcome | null {
    const input = typeof bytes === "string" ? Buffer.from(bytes) : bytes;
    let found: Outcome | null = null,
      start = 0;
    while (start < input.length) {
      const at = input.indexOf(10, start),
        complete = at >= 0,
        end = complete ? at : input.length,
        segment = input.subarray(start, end);
      start = end + Number(complete);
      if (!this.discard && this.partial.length + segment.length > record_limit) {
        this.partial = Buffer.alloc(0);
        this.discard = true;
        // A record too large to read may show the turn went on.
        this.settling_at = 0;
      }
      if (!this.discard) this.partial = Buffer.concat([this.partial, segment]);
      if (complete) {
        if (!this.discard) {
          const line = this.partial.toString();
          found = completion(agent, line) ?? found;
          const s = settling(agent, line);
          if (s) this.settling_at = s === "settles" ? now : 0;
        }
        this.partial = Buffer.alloc(0);
        this.discard = false;
      }
    }
    return found;
  }
  /** Ends the turn once a record that settles it has stood `settle_ms`. */
  settled(now: number): Outcome | null {
    // A record still being written may show the turn went on.
    if (this.partial.length || this.discard) return null;
    return this.settling_at && now - this.settling_at >= settle_ms ? "completed" : null;
  }
  close() {
    this.settling_at = 0;
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
        const verify = adapter(agent.provider).transcript?.verify;
        if (verify) verify(await head(file), agent.sessionId());
        this.offset = Math.max(0, stat.size - initial_tail);
        this.discard = this.offset > 0;
        this.partial = Buffer.alloc(0);
        this.inode = stat.ino;
        this.device = stat.dev;
      }
      if (stat.ino !== this.inode || named.ino !== this.inode || named.dev !== this.device || stat.size < this.offset)
        throw Error("Replaced");
      const now = Date.now();
      if (stat.size === this.offset) return this.settled(now);
      const bytes = Buffer.alloc(read_budget);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, this.offset);
      this.offset += bytesRead;
      return this.ingest(agent, bytes.subarray(0, bytesRead), now);
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
    const current = new Set(actors.map(actor => actor.id));
    for (const id of this.watchers.keys()) if (!current.has(id)) this.watchers.delete(id);
    this.requests = actors
      .filter(a => a.state.observation.pending_stop && a.state.transcript.len && a.state.session.len)
      .map(a => ({ actor: a.id, agent: a.state.snapshot() }));
  }
  batch(limit = 64) {
    const count = Math.min(limit, this.requests.length);
    const out = Array.from({ length: count }, (_, i) => this.requests[(this.cursor + i) % this.requests.length]);
    if (this.requests.length) this.cursor = (this.cursor + count) % this.requests.length;
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
        if (t.finished || now < t.next_check || this.results.length >= 64) continue;
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
