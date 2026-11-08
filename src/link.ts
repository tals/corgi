//! A client's hold on the daemon that outlives its connection, as
//! EternalTerminal keeps a session across reconnects. A client that numbers
//! its requests gets each one run once: a request sent again after a
//! reconnect is answered from the reply it already had. A viewer's state
//! waits here while no connection carries it, for `grace_ms`.
import type { Control } from "./protocol";

export const grace_ms = 10 * 60_000;
/** Replies a link keeps for requests its client hasn't confirmed. */
export const reply_limit = 256;
/** Links kept while no connection carries them. */
export const detached_limit = 32;

/** What a viewer was, to be again on the connection that resumes it. */
export interface Viewer {
  viewer_id: number;
  active_seq: number;
  view_workspace: number;
  controls: Control[];
  next_control: bigint;
  last_control: bigint;
}
/** The viewer a connection carries, to carry on over the next one. */
export function viewerOf(client: Viewer): Viewer {
  return {
    viewer_id: client.viewer_id,
    active_seq: client.active_seq,
    view_workspace: client.view_workspace,
    controls: [...client.controls],
    next_control: client.next_control,
    last_control: client.last_control,
  };
}
export class Link {
  /** The highest numbered request run. */
  applied = 0n;
  readonly pending = new Map<bigint, Promise<object>>();
  private replies = new Map<bigint, unknown>();
  viewer: Viewer | null = null;
  /** When the connection carrying the link went; null while one does. */
  detached_at: number | null = null;
  constructor(readonly id: string = crypto.randomUUID()) {}
  /** What to do with request `seq`: run it, answer it again, or refuse it
   * because an earlier one never arrived. */
  admit(seq: bigint): { run: true } | { run: false; reply: unknown } {
    const last = [...this.pending.keys()].reduce((a, b) => (a > b ? a : b), this.applied);
    if (seq === last + 1n) return { run: true };
    if (seq > this.applied) return { run: false, reply: { err: "SequenceGap" } };
    return { run: false, reply: this.replies.get(seq) ?? { err: "ReplyExpired" } };
  }
  /** Keeps the reply request `seq` got, until its client confirms it. */
  record(seq: bigint, reply: unknown): void {
    if (seq > this.applied) this.applied = seq;
    this.replies.set(seq, reply);
    for (const old of this.replies.keys()) {
      if (this.replies.size <= reply_limit) break;
      this.replies.delete(old);
    }
  }
  /** The client has every reply through `seq`. */
  confirm(seq: bigint): void {
    for (const old of this.replies.keys()) if (old <= seq) this.replies.delete(old);
  }
  capture() {
    return {
      id: this.id,
      applied: this.applied,
      replies: [...this.replies],
      viewer: this.viewer,
      detached_at: this.detached_at,
    };
  }
  static restore(value: ReturnType<Link["capture"]>): Link {
    const link = new Link(value.id);
    link.applied = BigInt(value.applied);
    link.replies = new Map(value.replies.map(([seq, reply]) => [BigInt(seq), reply]));
    link.viewer = value.viewer && {
      ...value.viewer,
      next_control: BigInt(value.viewer.next_control),
      last_control: BigInt(value.viewer.last_control),
      controls: value.viewer.controls.map(c => ({ ...c, seq: BigInt(c.seq) })),
    };
    link.detached_at = value.detached_at;
    return link;
  }
}
