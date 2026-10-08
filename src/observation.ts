export type Source = "unknown" | "screen" | "hook" | "transcript" | "protocol";
export type Outcome = "completed" | "interrupted" | "failed";
const maxU64 = (1n << 64n) - 1n;
export class State {
  source: Source = "unknown";
  pending_stop = false;
  completed = 0n;
  read = 0n;
  outcome: Outcome = "completed";
  constructor(fields: Partial<State> = {}) {
    Object.assign(this, fields);
  }
  unread() {
    return this.completed > this.read;
  }
  finish(outcome: Outcome, source: Source) {
    this.pending_stop = false;
    this.source = source;
    this.outcome = outcome;
    if (this.completed < maxU64) this.completed++;
  }
  acknowledge(through: bigint | number) {
    const receipt = BigInt(through);
    const n = receipt < this.completed ? receipt : this.completed;
    if (n > this.read) this.read = n;
  }
}
