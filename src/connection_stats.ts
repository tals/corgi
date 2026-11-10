export type Quality = 0 | 1 | 2 | 3 | 4;

/** Fixed bands keep response history comparable as old spikes leave the window. */
export const latencyBands = [
  { max: 100, label: "≤100 ms" },
  { max: 500, label: "100–500 ms" },
  { max: 2000, label: "0.5–2 s" },
  { max: 10000, label: "2–10 s" },
  { max: Infinity, label: ">10 s" },
] as const;

/** Viewer-local measurements; RPC latency includes daemon work, not just network RTT. */
export interface Sample {
  at: number;
  count: number;
  sum: number;
  squares: number;
  max: number;
  latency: number[];
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
  private disruptions: number[] = [];
  private progressQuality: Quality = 4;
  private shown: Quality | null = null;
  private candidate: Quality | null = null;
  private candidateSince = 0;
  /** Application responsiveness and reliability, never wireless signal strength. */
  get quality(): Quality | null {
    return this.qualityAt(performance.now());
  }
  qualityAt(now: number): Quality | null {
    if (!this.answers) return null;
    const latency = this.mean + 2 * this.deviation;
    const response: Quality = latency <= 100 ? 4 : latency <= 300 ? 3 : latency <= 1000 ? 2 : 1;
    this.disruptions = this.disruptions.filter(at => now - at < 30000);
    const reliability: Quality = this.disruptions.length >= 3 ? 1 : this.disruptions.length ? 2 : 4;
    const next = Math.min(response, reliability, this.progressQuality) as Quality;
    if (this.shown === null) return (this.shown = next);
    if (next !== this.candidate) {
      this.candidate = next;
      this.candidateSince = now;
    }
    // Outages lower the rating immediately; ordinary variation must persist.
    // Recovery needs ten seconds of consistent evidence, not one fast reply.
    if (
      (next < this.shown && reliability < this.shown) ||
      now - this.candidateSince >= (next < this.shown ? 3000 : 10000)
    )
      this.shown = next;
    return this.shown;
  }
  /** Frame/heartbeat freshness and the oldest outstanding input acknowledgment. */
  progress(age: number, budget: number): void {
    this.progressQuality = age >= budget * 0.75 ? 1 : age >= Math.max(1000, budget * 0.5) ? 2 : 4;
  }
  private interrupted(now: number): void {
    this.disruptions = this.disruptions.filter(at => now - at < 30000);
    // One broken connection can reject many requests in the same instant.
    if (now - (this.disruptions.at(-1) ?? -Infinity) >= 1000) this.disruptions.push(now);
  }
  /** A conservative budget, learned from successful application round trips. */
  get stallMs(): number {
    return this.answers ? Math.min(30000, Math.max(4000, 1000 + 3 * this.mean + 4 * this.deviation)) : 4000;
  }
  get timeoutMs(): number {
    return Math.max(10000, this.stallMs * 3);
  }

  connections = 0;
  lastReceived: number | null = null;
  private bucket(now = performance.now()): Sample {
    const at = Math.floor(now / 1000);
    let sample = this.history.at(-1);
    if (!sample || sample.at !== at) {
      sample = {
        at,
        count: 0,
        sum: 0,
        squares: 0,
        max: 0,
        latency: latencyBands.map(() => 0),
        failed: 0,
        received: 0,
        sent: 0,
      };
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
    this.interrupted(now);
  }
  answer(ms: number, failed: boolean, now = performance.now(), learn = true): void {
    const b = this.bucket(now);
    learn &&= now - ms > this.lastStall;
    if (failed) {
      b.failed++;
      this.interrupted(now);
    } else {
      if (learn && !this.answers++) {
        this.mean = ms;
        this.deviation = ms / 2;
      } else if (learn) {
        this.deviation += (Math.abs(ms - this.mean) - this.deviation) / 4;
        this.mean += (ms - this.mean) / 8;
      }
      b.latency[latencyBands.findIndex(band => ms <= band.max)]++;
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
