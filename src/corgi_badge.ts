//! Viewer-owned Kitty badge; unsupported hosts fall back to emoji.
import { png_base64 } from "./assets/corgi_badge";
import { Rect } from "./layout";
import type { Cell } from "./fork_hero";
const png = Buffer.from(png_base64, "base64");
export const reply_prefix = "\x1b_G";
export const query = "\x1b_Ga=q,i=730031,t=d,f=24,s=1,v=1;AAAA\x1b\\";
export const remove = "\x1b_Ga=d,d=I,i=730031,q=2\x1b\\";
export const hide = "\x1b_Ga=d,d=i,i=730031,p=1,q=2\x1b\\";
export const emoji = "🐕";
export type Mode = "none" | "pending" | "emoji" | "image";
/** The image's cells, past the sidebar's box column and the lists' margin. */
const cells = new Rect(2, 0, 3, 2);
export function hit(mode: Mode, sidebar_width: number, x: number, y: number): boolean {
  if (!sidebar_width) return false;
  return mode === "emoji" ? x >= 2 && x < 4 && y === 0 : mode === "image" ? cells.contains(x, y) : false;
}
/** Whether `box` reaches the image's cells. The image draws over text, so it
 * hides beneath an overlay there. */
export function overlaps(box: Rect): boolean {
  return box.x < cells.x + cells.w && box.x + box.w > cells.x && box.y < cells.y + cells.h && box.y + box.h > cells.y;
}
export class State {
  status: "probing" | "supported" | "uploading" | "confirming" | "ready" | "unavailable" = "probing";
  supports_kitty_graphics = false;
  uploaded = false;
  retry_at = 0;
  attempts = 0;
  probe_deadline: number | null = null;
  private image: { side: number; png: Buffer | null } | null = null;
  loading: Promise<void> | null = null;
  constructor(private wake: () => void = () => {}) {}
  mode(): Mode {
    if (this.status === "ready" && this.image?.png) return "image";
    return this.status === "unavailable" ? "emoji" : "pending";
  }
  accept(sequence: string): boolean {
    if (!sequence.startsWith(reply_prefix) || !sequence.endsWith("\x1b\\")) return false;
    const rest = sequence.slice(reply_prefix.length, -2),
      separator = rest.indexOf(";");
    if (separator < 0) return false;
    let id: number | null = null,
      placement: number | null = null;
    for (const field of rest.slice(0, separator).split(",")) {
      const equals = field.indexOf("=");
      if (equals < 0) return false;
      const key = field.slice(0, equals),
        value = field.slice(equals + 1);
      if (key === "i" || key === "p") {
        if (!/^\d+$/.test(value) || Number(value) > 0xffffffff) return false;
        if (key === "i") {
          if (id !== null) return false;
          id = Number(value);
        } else {
          if (placement !== null) return false;
          placement = Number(value);
        }
      }
    }
    if (id !== 730031 || (placement !== null && placement !== 1)) return false;
    const message = rest.slice(separator + 1);
    if (message === "OK") {
      this.supports_kitty_graphics = true;
      if (this.status === "probing" || (this.status === "unavailable" && !this.uploaded)) this.status = "supported";
      else if (this.status === "uploading" || this.status === "confirming") this.status = "ready";
      // Only the visible placement restores retries. The confirmation probe
      // is hidden immediately, which some hosts treat as deleting its data.
      else if (this.status === "ready" && placement === 1) this.attempts = 0;
      if (this.status === "ready") this.retry_at = 0;
    } else if ((this.status === "ready" || this.status === "confirming") && message.startsWith("ENOENT")) {
      this.status = this.attempts < 3 ? "supported" : "unavailable";
      this.retry_at = 0;
    } else this.status = "unavailable";
    return true;
  }
  upload(now_ms: number, cell: Cell | null): string {
    const side = cell ? Math.min(cells.w * cell.width, cells.h * cell.height) : null;
    let out = "";
    if (side !== (this.image?.side ?? null)) {
      if (this.uploaded) out = hide;
      this.image = side === null ? null : { side, png: null };
      this.loading = null;
      if (this.supports_kitty_graphics) this.status = "supported";
      this.retry_at = this.attempts = 0;
    }
    this.probe_deadline ??= now_ms + 1500;
    if ((this.status === "probing" || !this.image) && now_ms >= this.probe_deadline) this.status = "unavailable";
    if (!this.image) return out;
    if (this.status === "supported" && !this.loading) {
      const image = this.image;
      this.loading = new Bun.Image(png)
        .resize(image.side, image.side)
        .png()
        .buffer()
        .then(bytes => {
          if (this.image !== image) return;
          image.png = bytes;
          this.wake();
        })
        .catch(() => {
          if (this.image !== image) return;
          this.status = "unavailable";
          this.wake();
        });
    }
    if (!this.image.png) return out;
    if (this.status === "uploading" && now_ms >= this.retry_at) {
      this.status = "confirming";
      this.retry_at = now_ms + 1500;
      return out + place() + hide;
    }
    if (this.status === "confirming" && now_ms >= this.retry_at)
      this.status = this.attempts < 3 ? "supported" : "unavailable";
    if (this.status !== "supported" || now_ms < this.retry_at) return out;
    const data = this.image.png.toString("base64");
    for (let offset = 0; offset < data.length; offset += 4096) {
      const end = Math.min(offset + 4096, data.length),
        more = Number(end < data.length);
      out +=
        (offset === 0
          ? `\x1b_Ga=t,t=d,f=100,s=${this.image.side},v=${this.image.side},i=730031,m=${more};`
          : `\x1b_Gm=${more};`) +
        data.slice(offset, end) +
        "\x1b\\";
    }
    this.status = "uploading";
    this.uploaded = true;
    this.retry_at = now_ms + 3000;
    this.attempts = Math.min(255, this.attempts + 1);
    return out;
  }
}
export function place(): string {
  return "\x1b7\x1b[1;3H\x1b_Ga=p,i=730031,p=1,z=1,C=1,q=0\x1b\\\x1b8";
}
