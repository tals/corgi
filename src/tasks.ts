//! Work the viewer hands its daemon. The viewer never waits for a task, and
//! tasks don't wait for each other: their requests go out in the order the
//! user asked, and one slow task holds up no other. Every request a task
//! makes goes out; a task checks that the user is still where it started
//! before it changes what they see.
//!
//! Input never waits for a task. Keys go where the keyboard is now; a task
//! that opens a pane gives it the keyboard at once (see opening.ts).
import { call, type Transport } from "./mirror";
import type * as protocol from "./protocol";

export interface Lane {
  readonly transport: Transport;
  call<K extends protocol.Op>(op: K, ...args: protocol.Arguments<K>): Promise<protocol.Reply<K>>;
}
export class Tasks {
  private running = new Set<Promise<void>>();
  constructor(
    private readonly transport: () => Transport,
    private readonly failed: (error: unknown) => void,
    private readonly settled: () => void = () => {},
  ) {}
  /** Starts `task`; its failure is reported, never thrown at the caller. */
  start(task: (lane: Lane) => Promise<void>): void {
    void this.run(task);
  }
  /** Starts `task`, settling once it has, for the few callers that need to
   * know when it's done. */
  run(task: (lane: Lane) => Promise<void>): Promise<void> {
    const transport = this.transport();
    const lane: Lane = { transport, call: (op, ...args) => call(transport, op, ...args) };
    const done: Promise<void> = task(lane)
      .catch(error => this.failed(error))
      .finally(() => {
        this.running.delete(done);
        this.settled();
      });
    this.running.add(done);
    return done;
  }
  /** Settles once no task is running, including ones started meanwhile. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all(this.running);
  }
}
