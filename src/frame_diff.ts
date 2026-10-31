//! The host terminal's screen as the viewer last left it. The differ is
//! Corgi's own `frame_diff.zig` behind the native boundary: a frame that
//! changes cells is written as the spans that differ. Cursor-preserving Kitty
//! commands travel separately, so moving an image doesn't repaint the text.
import type { Pointer } from "bun:ffi";
import { n, ptr } from "./native_ffi";
import { Frame } from "./composition";
import * as telemetry from "./telemetry";

export class Differ {
  private previous: Frame | null = null;
  private sources = new BigUint64Array(0);
  private rects = new Uint16Array(0);
  private constructor(
    private handle: Pointer,
    readonly cols: number,
    readonly rows: number,
  ) {}
  static create(cols: number, rows: number): Differ {
    const handle = n.frame_diff_new(cols, rows) as Pointer | null;
    if (!handle) throw Error("OutOfMemory");
    return new Differ(handle, cols, rows);
  }
  destroy(): void {
    n.frame_diff_free(this.handle);
  }
  /** Replay placements after an image upload or deletion outside the frame. */
  invalidateImages(): void {
    n.frame_diff_invalidate_images(this.handle);
  }
  /** What to write so the host shows `frame`, which starts from a clear
   * screen. Empty when the host already shows it. */
  diff(frame: string | Uint8Array | Frame): Buffer {
    if (frame instanceof Frame) {
      const previous = this.previous;
      if (frame.reusable && frame.panes.length > 0) {
        const started = telemetry.begin();
        const reuse = previous !== null && frame.sharesChrome(previous);
        if (this.sources.length < frame.panes.length) {
          this.sources = new BigUint64Array(frame.panes.length);
          this.rects = new Uint16Array(frame.panes.length * 4);
        }
        for (let i = 0; i < frame.panes.length; i++) {
          const p = frame.panes[i];
          this.sources[i] = BigInt(p.terminal.handle);
          this.rects[i * 4] = p.x;
          this.rects[i * 4 + 1] = p.y;
          this.rects[i * 4 + 2] = p.w;
          this.rects[i * 4 + 3] = p.h;
        }
        // A rejection (-2) leaves the differ as it was or marks it stale
        // itself, so the fallback can still diff cells; a rejected reuse
        // retries with fresh chrome. Errors may leave it half-written.
        for (const retained of reuse ? [true, false] : [false]) {
          const chrome = retained ? null : Buffer.from(frame.chrome);
          const size = Number(
            n.frame_diff_compose(
              this.handle,
              chrome ? ptr(chrome) : null,
              chrome?.length ?? 0,
              ptr(this.sources),
              ptr(this.rects),
              frame.panes.length,
              frame.cursor?.x ?? 0,
              frame.cursor?.y ?? 0,
              frame.cursor !== null,
              retained ? 1 : 0,
            ),
          );
          if (size >= 0) {
            this.previous = frame;
            const out = this.take(size);
            telemetry.end(retained ? "viewer.retained" : "viewer.composite", started, chrome?.length ?? 0);
            return out;
          }
          if (size !== -2) {
            n.frame_diff_invalidate(this.handle);
            break;
          }
        }
      }
      return this.full(frame.text());
    }
    return this.full(frame);
  }
  private full(frame: string | Uint8Array): Buffer {
    this.previous = null;
    const started = telemetry.begin();
    const bytes = typeof frame === "string" ? Buffer.from(frame) : frame;
    if (bytes.length === 0) return Buffer.alloc(0);
    const size = Number(n.frame_diff_diff(this.handle, ptr(bytes), bytes.length));
    if (size < 0) throw Error("FrameDiffFailed");
    const out = this.take(size);
    telemetry.end("viewer.replay", started, bytes.length);
    return out;
  }
  private take(size: number): Buffer {
    const out = Buffer.alloc(size);
    if (size > 0 && Number(n.frame_diff_take(this.handle, ptr(out), size)) !== size) throw Error("FrameDiffFailed");
    return out;
  }
}
