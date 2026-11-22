//! A prompt card's chat moving into a pane on another computer: the viewer
//! sends its handoff to that computer's daemon in parts, each small enough to
//! share the data connection with the panes' screens, and the daemon writes
//! it there whole for the pane to read.
import { randomBytes } from "node:crypto";

/** The most of a handoff's text one request carries. */
export const part_chars = 256 << 10;
/** The longest handoff a daemon takes. */
export const max_chars = 64 << 20;

/** What a request sends: a part of upload `upload`, and whether it's the last. */
export interface Part {
  upload: string;
  part: string;
  last: boolean;
}
/** Sends `text` to a daemon in parts, one request at a time; resolves with
 * the reply to the last. */
export async function send(call: (part: Part) => Promise<unknown>, text: string): Promise<unknown> {
  const upload = randomBytes(8).toString("hex");
  for (let at = 0; ; at += part_chars) {
    const last = at + part_chars >= text.length,
      reply = await call({ upload, part: text.slice(at, at + part_chars), last });
    if (last) return reply;
  }
}
/** The handoffs a daemon is being sent, each its connection's. */
export class Uploads {
  private pending = new Map<string, { owner: object; text: string }>();
  get size(): number {
    return this.pending.size;
  }
  /** Adds `p` to its upload: the whole text once it's the last part, else
   * null. Throws for another connection's upload, or one past `max_chars`. */
  add(owner: object, p: Part): string | null {
    let entry = this.pending.get(p.upload);
    if (!entry) this.pending.set(p.upload, (entry = { owner, text: "" }));
    else if (entry.owner !== owner) throw Error("UnknownUpload");
    entry.text += p.part;
    if (entry.text.length > max_chars) {
      this.pending.delete(p.upload);
      throw Error("TooLarge");
    }
    if (!p.last) return null;
    this.pending.delete(p.upload);
    return entry.text;
  }
  /** Forgets the uploads of `owner`, whose connection closed. */
  drop(owner: object): void {
    for (const [id, entry] of this.pending) if (entry.owner === owner) this.pending.delete(id);
  }
}
