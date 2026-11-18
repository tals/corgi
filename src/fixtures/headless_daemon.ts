import type { Daemon } from "../prompt_session";

/** A daemon that keeps one session's journal and records what it was asked. */
export class HeadlessDaemon implements Daemon {
  calls: { op: string; payload: any }[] = [];
  starts: any[] = [];
  journal: { seq: number; event: unknown }[] = [];
  pending: unknown[] = [];
  /** Sessions the next starts make, then `session`. */
  ids: string[] = [];
  /** The next reply to `start`, in place of a session from `ids`. */
  starting: Promise<{ provider: any; session: string }> | null = null;
  constructor(readonly session: string) {}
  async call(op: string, payload: any): Promise<any> {
    this.calls.push({ op, payload });
    if (op !== "headless.events") return { ok: true };
    return {
      ok: true,
      events: this.journal.filter(e => BigInt(e.seq) > BigInt(payload.after)),
      pending_requests: this.pending,
    };
  }
  start(payload: any): Promise<{ provider: any; session: string }> {
    this.starts.push(payload);
    return this.starting ?? Promise.resolve({ provider: payload.provider, session: this.ids.shift() ?? this.session });
  }
  add(...events: unknown[]): void {
    for (const event of events) this.journal.push({ seq: this.journal.length + 1, event });
  }
  /** The input each headless.send carried. */
  sent(): any[] {
    return this.calls.filter(c => c.op === "headless.send").map(c => c.payload.input);
  }
}
