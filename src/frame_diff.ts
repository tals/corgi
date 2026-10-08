//! The host terminal's screen as the viewer last left it. The differ is
//! Corgi's own `frame_diff.zig` behind the native boundary: a frame that
//! changes only cells is written as the spans that differ.
import type { Pointer } from "bun:ffi";
import { n, ptr } from "./native_ffi";

export class Differ {
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
  /** What to write so the host shows `frame`, which starts from a clear
   * screen. Empty when the host already shows it. */
  diff(frame: string | Uint8Array): Buffer {
    const bytes = typeof frame === "string" ? Buffer.from(frame) : frame;
    if (bytes.length === 0) return Buffer.alloc(0);
    const size = Number(n.frame_diff_diff(this.handle, ptr(bytes), bytes.length));
    if (size < 0) throw Error("FrameDiffFailed");
    const out = Buffer.alloc(size);
    if (size > 0 && Number(n.frame_diff_take(this.handle, ptr(out), size)) !== size) throw Error("FrameDiffFailed");
    return out;
  }
}
