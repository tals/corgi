import * as surface from "./pane/surface";
import * as json from "./json";
import * as text from "./text";
import type { View } from "./viewer_protocol";

/** Bound bytes already accepted by the socket, SSH and the network, too. */
export class Frames {
  private retained = new Map<number, surface.View>();
  private pending = new Map<bigint, number>();
  private sent = 0n;
  private bytes = 0;
  get available(): boolean {
    return this.pending.size < 3 && this.bytes < 16384;
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
    if (this.pending.size && this.bytes + bytes > 16384) return null;
    for (const frame of view.surfaces) this.retained.set(frame.surface.pane, frame);
    const frame = ++this.sent;
    this.pending.set(frame, bytes);
    this.bytes += bytes;
    return { frame, view: encoded };
  }
  acknowledge(frame: bigint): void {
    if (frame > this.sent) throw Error("InvalidAcknowledgement");
    for (const [sent, bytes] of this.pending) {
      if (sent > frame) break;
      this.pending.delete(sent);
      this.bytes -= bytes;
    }
  }
}
