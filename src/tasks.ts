//! Work the viewer hands its daemon. The viewer never waits for a task, and
//! tasks don't wait for each other: their requests go out in the order the
//! user asked, and one slow task holds up no other. Every request a task
//! makes goes out; a task checks that the user is still where it started
//! before it changes what they see.
//!
//! A task that decides where the next keys go (a split focuses its pane, a
//! dialog closes) holds the input that follows it until it's done, so typing
//! lands where it would have without the wait. A hold lasts at most
//! `hold_ms`, after which a daemon counts as stalled.
import { call, type Transport } from "./mirror";
import type * as protocol from "./protocol";

export const hold_ms = 1000;
export interface Lane {
  readonly transport: Transport;
  call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>>;
}
export class Tasks {
  private running = new Set<Promise<void>>();
  /** When each running task that holds input started. */
  private holding = new Map<Promise<void>, number>();
  constructor(
    private readonly transport: () => Transport,
    private readonly failed: (error: unknown) => void,
    private readonly settled: () => void = () => {},
  ) {}
  /** Starts `task`; its failure is reported, never thrown at the caller. */
  start(task: (lane: Lane) => Promise<void>, holds = false): void {
    void this.run(task, holds);
  }
  /** Starts `task`, settling once it has, for the few callers that need to
   * know when it's done. */
  run(task: (lane: Lane) => Promise<void>, holds = false): Promise<void> {
    const transport = this.transport();
    const lane: Lane = { transport, call: (op, ...args) => call(transport, op, ...args) };
    const done: Promise<void> = task(lane)
      .catch(error => this.failed(error))
      .finally(() => {
        this.running.delete(done);
        this.holding.delete(done);
        this.settled();
      });
    this.running.add(done);
    if (holds) this.holding.set(done, Date.now());
    return done;
  }
  /** Whether input waits: a task that decides where it goes is running, and
   * hasn't run past `hold_ms`. */
  holds(now = Date.now()): boolean {
    for (const started of this.holding.values()) if (now - started < hold_ms) return true;
    return false;
  }
  /** Settles once no task is running, including ones started meanwhile. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running);
  }
}
