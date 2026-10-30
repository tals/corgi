//! Splits an animated GIF into one still GIF per frame without decoding
//! pixels, so an image decoder can do the rest frame by frame.

export interface Frame {
  /** A one-frame GIF of just this frame's rectangle. */
  still: Uint8Array;
  /** Where the rectangle sits on the canvas, in pixels. */
  left: number;
  top: number;
  width: number;
  height: number;
  /** How long the frame shows, in milliseconds. */
  delay: number;
  /** What happens to the frame before the next one draws: 0 and 1 keep it,
   * 2 clears it to the background, 3 restores what was under it. */
  disposal: number;
}
export interface Animation {
  width: number;
  height: number;
  frames: Frame[];
}

const u16 = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const table = (flags: number) => (flags & 0x80 ? 3 << ((flags & 7) + 1) : 0);

/** The frames of `gif`; null for a GIF with fewer than two whole frames, or
 * not a GIF. */
export function animation(gif: Uint8Array): Animation | null {
  if (gif.length < 13 || String.fromCharCode(...gif.subarray(0, 6)) !== "GIF89a") return null;
  const width = u16(gif, 6),
    height = u16(gif, 8),
    head = gif.subarray(0, 13 + table(gif[10])),
    frames: Frame[] = [];
  let at = head.length,
    control: Uint8Array | null = null;
  // The offset past the data sub-blocks at `at`, or null when they run off the end.
  const blocks = (at: number): number | null => {
    while (at < gif.length && gif[at] !== 0) at += gif[at] + 1;
    return at < gif.length ? at + 1 : null;
  };
  while (at < gif.length) {
    if (gif[at] === 0x21) {
      const end = blocks(at + 2);
      if (end === null) break;
      if (gif[at + 1] === 0xf9 && gif[at + 2] === 4) control = gif.subarray(at, end);
      at = end;
    } else if (gif[at] === 0x2c) {
      const end = blocks(at + 10 + table(gif[at + 9]) + 1);
      if (end === null) break;
      const left = u16(gif, at + 1),
        top = u16(gif, at + 3),
        w = Math.min(u16(gif, at + 5), width - left),
        h = Math.min(u16(gif, at + 7), height - top);
      if (w > 0 && h > 0) {
        const still = new Uint8Array(head.length + (control?.length ?? 0) + (end - at) + 1);
        still.set(head);
        still.set([w & 0xff, w >> 8, h & 0xff, h >> 8], 6);
        if (control) still.set(control, head.length);
        const image = head.length + (control?.length ?? 0);
        still.set(gif.subarray(at, end), image);
        still.set([0, 0, 0, 0, w & 0xff, w >> 8, h & 0xff, h >> 8], image + 1);
        still[still.length - 1] = 0x3b;
        const centiseconds = control ? u16(control, 4) : 0;
        frames.push({
          still,
          left,
          top,
          width: w,
          height: h,
          // Browsers show very short delays at 100 ms, and GIFs are made to match.
          delay: centiseconds < 2 ? 100 : centiseconds * 10,
          disposal: control ? (control[3] >> 2) & 7 : 0,
        });
      }
      control = null;
      at = end;
    } else break;
  }
  return frames.length > 1 ? { width, height, frames } : null;
}
