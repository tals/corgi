import type { Command, Faults } from "../src/remote_lab";

/** Start-to-start cadence; manual outages do not move the recurring schedule. */
export class Policy {
  readonly state: Faults = {
    latency_ms: 0,
    bandwidth_kib: 0,
    outage_until: 0,
    hang_seconds: 5,
    hang_every_seconds: 0,
    next_hang_at: 0,
    accepted: 0,
  };
  private manualUntil = 0;
  private repeatingUntil = 0;

  apply(command: Command, now = Date.now()): void {
    const s = this.state;
    if (command.latency_ms !== undefined) s.latency_ms = command.latency_ms;
    if (command.bandwidth_kib !== undefined) s.bandwidth_kib = command.bandwidth_kib;
    if (command.hang_seconds !== undefined) s.hang_seconds = command.hang_seconds;
    if (command.hang_every_seconds !== undefined) s.hang_every_seconds = command.hang_every_seconds;
    if (command.hang_seconds !== undefined || command.hang_every_seconds !== undefined) {
      this.repeatingUntil = 0;
      s.next_hang_at = s.hang_every_seconds && s.hang_seconds ? now + s.hang_every_seconds * 1000 : 0;
    }
    if (command.outage_seconds !== undefined)
      this.manualUntil = command.outage_seconds ? now + command.outage_seconds * 1000 : 0;
    this.tick(now);
  }

  tick(now = Date.now()): boolean {
    const s = this.state;
    if (s.next_hang_at && now >= s.next_hang_at) {
      const period = s.hang_every_seconds * 1000;
      const start = s.next_hang_at + Math.floor((now - s.next_hang_at) / period) * period;
      this.repeatingUntil = start + s.hang_seconds * 1000;
      s.next_hang_at = start + period;
    }
    const until = Math.max(this.manualUntil, this.repeatingUntil);
    s.outage_until = until > now ? until : 0;
    return s.outage_until > 0;
  }
}
