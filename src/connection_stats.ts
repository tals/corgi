/** Viewer-local measurements; RPC latency includes daemon work, not just network RTT. */
export interface Sample {
  at: number;
  count: number;
  sum: number;
  squares: number;
  max: number;
  failed: number;
  received: number;
  sent: number;
}
export class Stats {
  readonly history: Sample[] = [];
  pending = 0;
  private mean = 0;
  private deviation = 0;
  private answers = 0;
  private lastStall = -Infinity;
  /** A conservative budget, learned from successful application round trips. */
  get stallMs(): number {
    return this.answers ? Math.min(30000, Math.max(4000, 1000 + 3 * this.mean + 4 * this.deviation)) : 4000;
  }
  get timeoutMs(): number {
    return Math.max(10000, this.stallMs * 3);
  }
  /** Input can wait for a sync and its surface read before pixels confirm it. */
  get predictionMs(): number {
    return Math.min(30000, Math.max(750, 250 + 3 * this.mean + 4 * this.deviation));
  }

  connections = 0;
  lastReceived: number | null = null;
  private bucket(now = performance.now()): Sample {
    const at = Math.floor(now / 1000);
    let sample = this.history.at(-1);
    if (!sample || sample.at !== at) {
      sample = { at, count: 0, sum: 0, squares: 0, max: 0, failed: 0, received: 0, sent: 0 };
      this.history.push(sample);
    }
    while (this.history.length && this.history[0].at < at - 119) this.history.shift();
    return sample;
  }
  traffic(direction: "received" | "sent", bytes: number, now = performance.now()): void {
    this.bucket(now)[direction] += bytes;
    if (direction === "received") this.lastReceived = now;
  }
  /** Replies already in flight at a stall include outage time, not ordinary latency. */
  stalled(now = performance.now()): void {
    this.lastStall = now;
  }
  answer(ms: number, failed: boolean, now = performance.now(), learn = true): void {
    const b = this.bucket(now);
    learn &&= now - ms > this.lastStall;
    if (failed) b.failed++;
    else {
      if (learn && !this.answers++) {
        this.mean = ms;
        this.deviation = ms / 2;
      } else if (learn) {
        this.deviation += (Math.abs(ms - this.mean) - this.deviation) / 4;
        this.mean += (ms - this.mean) / 8;
      }
      b.count++;
      b.sum += ms;
      b.squares += ms * ms;
      b.max = Math.max(b.max, ms);
    }
  }
  recent(now = performance.now()): Sample[] {
    this.bucket(now);
    return this.history;
  }
}
