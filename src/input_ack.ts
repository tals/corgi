import { randomUUID } from "node:crypto";
import type { InputReceipt } from "./pane/surface";

export const settle_ms = 50;

/** A late receipt gives the program time to echo; it does not prove processing. */
export class Acknowledgements {
  private readonly epoch = randomUUID();
  private sequence = 0n;
  private acknowledged = 0n;
  private pending: { sequence: bigint; at: number }[] = [];

  sent(now = performance.now()): InputReceipt {
    const sequence = ++this.sequence;
    // One receipt per millisecond bounds the history even during a paste.
    const at = Math.floor(now);
    if (this.pending.at(-1)?.at === at) this.pending[this.pending.length - 1].sequence = sequence;
    else this.pending.push({ sequence, at });
    if (this.pending.length > 256) this.pending.shift();
    return { epoch: this.epoch, sequence };
  }
  get receipt(): InputReceipt {
    return { epoch: this.epoch, sequence: this.sequence };
  }
  get ack(): InputReceipt {
    return { epoch: this.epoch, sequence: this.acknowledged };
  }
  get waiting(): boolean {
    return this.pending.length > 0;
  }
  advance(now = performance.now()): boolean {
    const before = this.acknowledged;
    while (this.pending.length && now - this.pending[0].at >= settle_ms)
      this.acknowledged = this.pending.shift()!.sequence;
    return before !== this.acknowledged;
  }
}
