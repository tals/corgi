import * as surface from "./pane/surface";
import * as json from "./json";
import * as text from "./text";
import * as telemetry from "./telemetry";
import type { View } from "./viewer_protocol";

/** Bound bytes already accepted by the socket, SSH and the network, too. */
export class Frames {
  private retained = new Map<number, surface.View>();
  private pending = new Map<bigint, { bytes: number; at: number }>();
  private sent = 0n;
  private bytes = 0;
  private limit = 16384;
  private fastest = Infinity;
  constructor(private readonly now = () => performance.now()) {}
  get available(): boolean {
    return this.pending.size < 3 && this.bytes < this.limit;
  }
  offer(view: View): { frame: bigint; view: View } | null {
    if (!this.available) return null;
    const surfaces: surface.View[] = [],
      patches: surface.Patch[] = [];
    for (const frame of view.surfaces) {
      const before = this.retained.get(frame.surface.pane);
      const patch = before && surface.difference(before, frame);
      if (patch && json.stringify(patch).length < json.stringify(frame).length) patches.push(patch);
      else surfaces.push(frame);
    }
    const encoded = { ...view, surfaces, patches };
    // Include room for the stream envelope and RPC id. One oversized frame
    // may travel alone, so a full snapshot can always make progress.
    const bytes = text.byteLength(json.stringify(encoded)) + 128;
    if (this.pending.size && this.bytes + bytes > this.limit) return null;
    for (const frame of view.surfaces) this.retained.set(frame.surface.pane, frame);
    const frame = ++this.sent;
    this.pending.set(frame, { bytes, at: this.now() });
    this.bytes += bytes;
    return { frame, view: encoded };
  }
  acknowledge(frame: bigint): void {
    if (frame > this.sent) throw Error("InvalidAcknowledgement");
    const received = this.pending.get(frame);
    if (received) {
      const elapsed = this.now() - received.at;
      this.fastest = Math.min(this.fastest, elapsed);
      // Allow dense frames to fill the three slots on an uncongested link.
      // Added receipt delay means bytes are queuing; restore the small budget.
      const limit = elapsed <= this.fastest + 50 ? 32768 : 16384;
      if (limit !== this.limit) {
        this.limit = limit;
        telemetry.event("remote.stream.window", { bytes: limit, receipt_ms: elapsed, fastest_ms: this.fastest });
      }
    }
    for (const [sent, pending] of this.pending) {
      if (sent > frame) break;
      this.pending.delete(sent);
      this.bytes -= pending.bytes;
    }
  }
}
