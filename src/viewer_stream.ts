import * as surface from "./pane/surface";
import * as json from "./json";
import * as text from "./text";
import * as telemetry from "./telemetry";
import type { View } from "./viewer_protocol";

interface Pending {
  raw: number;
  bytes: number;
  at: number;
  probe: boolean;
  first: boolean;
}
/** Bound accepted work across the codec, socket and network; coalesce before admission. */
export class Frames {
  private retained = new Map<number, surface.View>();
  private pending = new Map<bigint, Pending>();
  private sent = 0n;
  private bytes = 0;
  private raw = 0;
  private baseline = 0;
  private slots = 3;
  private ratio = 1;
  private average = 8192;
  private congested = false;
  private adjust = 0;
  private probeAt = -Infinity;
  private draining = false;
  private probing = false;
  private last: View | null = null;
  private reported = 0;
  private rate = 0;
  private rates: { at: number; bytes: number }[] = [];
  private acknowledged = 0;
  private busy = false;
  constructor(private readonly now = () => performance.now()) {}
  private get target(): number {
    return Math.max(3, Math.min(64, Math.ceil(this.baseline / 16) + 2));
  }
  private get limit(): number {
    const flight = this.rate ? this.rate * (this.baseline + 50) + this.average * 2 : Infinity;
    return Math.min(512 * 1024, Math.max(4096, Math.min(flight, Math.max(32768, this.average * this.slots))));
  }
  get available(): boolean {
    if (this.probing || (this.draining && this.pending.size)) return false;
    return this.pending.size < this.slots && this.bytes < this.limit && this.raw < 2 * 1024 * 1024;
  }
  offer(view: View): { frame: bigint; view: View; probe: boolean } | null {
    if (!this.available) return null;
    const probe = this.draining && this.last !== null;
    const surfaces: surface.View[] = [],
      patches: surface.Patch[] = [];
    if (!probe)
      for (const frame of view.surfaces) {
        const before = this.retained.get(frame.surface.pane);
        const patch = before && surface.difference(before, frame);
        if (patch && json.stringify(patch).length < json.stringify(frame).length) patches.push(patch);
        else surfaces.push(frame);
      }
    const encoded = probe
      ? { ...this.last!, session: null, resources: null, surfaces: [], patches: [], controls: [] }
      : { ...view, surfaces, patches };
    const raw = text.byteLength(json.stringify(encoded)) + 128;
    const bytes = Math.max(64, raw * this.ratio);
    // A single oversized snapshot must still make progress.
    if (this.pending.size && (this.bytes + bytes > this.limit || this.raw + raw > 2 * 1024 * 1024)) return null;
    if (probe) {
      this.draining = false;
      this.probing = true;
      this.probeAt = this.now();
    } else {
      for (const frame of view.surfaces) this.retained.set(frame.surface.pane, frame);
      this.last = view;
    }
    const frame = ++this.sent;
    this.pending.set(frame, { raw, bytes, at: this.now(), probe, first: this.pending.size === 0 });
    this.bytes += bytes;
    this.raw += raw;
    return { frame, view: encoded, probe };
  }
  /** Forgets the screens of panes not in `panes`; one that comes back is sent whole. */
  keep(panes: ReadonlySet<number>): void {
    for (const pane of this.retained.keys()) if (!panes.has(pane)) this.retained.delete(pane);
  }
  /** Reconcile admission estimates with bytes emitted by the negotiated codec. */
  encoded(frame: bigint, bytes: number): void {
    const pending = this.pending.get(frame);
    if (!pending) return;
    this.bytes += bytes - pending.bytes;
    pending.bytes = bytes;
    if (!pending.probe) {
      this.ratio = this.ratio * 0.75 + (bytes / pending.raw) * 0.25;
      this.average = this.average * 0.75 + bytes * 0.25;
    }
  }
  acknowledge(frame: bigint): void {
    if (frame > this.sent) throw Error("InvalidAcknowledgement");
    const received = this.pending.get(frame);
    if (!received) return;
    const now = this.now(),
      elapsed = now - received.at;
    let delivered = 0;
    for (const [sent, pending] of this.pending) {
      if (sent > frame) break;
      this.pending.delete(sent);
      this.bytes -= pending.bytes;
      delivered += pending.bytes;
      this.raw -= pending.raw;
    }
    if (!received.probe && this.busy && now - this.acknowledged >= 5) {
      const sample = delivered / (now - this.acknowledged);
      this.rates = this.rates.filter(sample => now - sample.at <= 2000);
      this.rates.push({ at: now, bytes: sample });
      // Application-limited gaps must not shrink the window that caused them.
      this.rate = Math.max(...this.rates.map(sample => sample.bytes));
    }
    this.acknowledged = now;
    this.busy = this.pending.size > 0;
    const previous = this.slots;
    if (received.probe) {
      this.probing = false;
      // This small frame was sent only after all previous frames were decoded.
      const changedPath = elapsed > this.baseline + 50;
      this.baseline = Math.max(1, elapsed);
      this.slots = changedPath && this.rate ? this.target : Math.min(this.target, this.slots + 1);
      this.congested = false;
    } else if (!this.baseline) {
      this.baseline = Math.max(1, elapsed);
      this.slots = Math.min(8, this.target);
    } else {
      this.baseline = Math.min(this.baseline, Math.max(1, elapsed));
      const serialization = this.rate ? received.bytes / this.rate : 0;
      this.congested = elapsed > this.baseline + serialization + Math.max(50, this.baseline / 4);
      if (now >= this.adjust) {
        this.slots = this.congested ? Math.max(1, Math.floor(this.slots / 2)) : Math.min(this.target, this.slots + 1);
        this.adjust = now + Math.max(100, this.baseline);
      }
      // Older frames can explain queue delay. Probe an empty-flight sample, or
      // a delivery estimate too low to distinguish serialization from a new RTT.
      if (
        elapsed > this.baseline + Math.max(50, this.baseline / 4) &&
        now - this.probeAt >= 3000 &&
        (serialization > this.baseline || (received.first && this.congested))
      )
        this.draining = true;
    }
    if (previous !== this.slots || now - this.reported >= 1000 || received.probe) {
      this.reported = now;
      telemetry.event("remote.stream.window", {
        frames: this.slots,
        pending: this.pending.size,
        wire_bytes: this.bytes,
        raw_bytes: this.raw,
        budget: this.limit,
        receipt_ms: elapsed,
        baseline_ms: this.baseline,
        bytes_per_second: this.rate * 1000,
        congested: Number(this.congested),
        probe: Number(received.probe),
      });
    }
  }
}
