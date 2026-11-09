//! A pane an action is opening. It takes the keyboard as the action starts:
//! what's typed before the daemon makes the pane waits here, and reaches the
//! pane once it exists. Moving focus elsewhere takes the keyboard back; what
//! was typed for the pane still goes to it.

/** What's typed for a pane still opening, at most. */
export const limit = 1024 * 1024;
/** Keys as typed, or a paste's text, which goes bracketed if the pane asks. */
export type Chunk = { keys: number[] } | { paste: number[] };

export class Opening {
  private chunks: Chunk[] = [];
  private size = 0;
  /** Asked to close before it opened: it closes as it arrives. */
  closing = false;
  /** `id` stands for the pane until the daemon names it; it's negative, so
   * it never names one of the daemon's. */
  constructor(readonly id: number) {}
  /** Keys typed for it; false when they don't fit, and they're dropped. */
  type(keys: ArrayLike<number>): boolean {
    if (!this.fits(keys.length)) return false;
    const last = this.chunks.at(-1);
    if (last && "keys" in last) append(last.keys, keys);
    else this.chunks.push({ keys: Array.from(keys) });
    return true;
  }
  /** Starts a paste; what `paste` adds until the next one goes with it. */
  pasteStart(): void {
    this.chunks.push({ paste: [] });
  }
  /** Pasted text; false when it doesn't fit, and it's dropped. */
  paste(bytes: ArrayLike<number>): boolean {
    if (!this.fits(bytes.length)) return false;
    const last = this.chunks.at(-1);
    if (last && "paste" in last) append(last.paste, bytes);
    else this.chunks.push({ paste: Array.from(bytes) });
    return true;
  }
  /** What was typed, in order, leaving nothing. */
  take(): Chunk[] {
    const chunks = this.chunks;
    this.chunks = [];
    this.size = 0;
    return chunks;
  }
  private fits(bytes: number): boolean {
    if (this.size + bytes > limit) return false;
    this.size += bytes;
    return true;
  }
}
/** A paste's bytes can outnumber the arguments a spread may pass. */
function append(to: number[], bytes: ArrayLike<number>): void {
  for (let i = 0; i < bytes.length; i++) to.push(bytes[i]);
}
