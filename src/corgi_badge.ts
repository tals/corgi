//! Viewer-owned Kitty badge; unsupported hosts fall back to emoji.
import { png_base64 } from "./assets/corgi_badge";
import { Rect } from "./layout";
const png = Buffer.from(png_base64, "base64");
const pixel_width = png.readUInt32BE(16),
  pixel_height = png.readUInt32BE(20);
export const reply_prefix = "\x1b_G";
export const query = "\x1b_Ga=q,i=730031,t=d,f=24,s=1,v=1;AAAA\x1b\\";
export const remove = "\x1b_Ga=d,d=I,i=730031,q=2\x1b\\";
export const hide = "\x1b_Ga=d,d=i,i=730031,p=1,q=2\x1b\\";
export const emoji = "🐕";
export type Mode = "none" | "emoji" | "image";
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
  mode(): Mode {
    return this.status === "ready" ? "image" : this.status === "unavailable" ? "emoji" : "none";
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
      if (this.status === "ready") {
        this.attempts = 0;
        this.retry_at = 0;
      }
    } else if ((this.status === "ready" || this.status === "confirming") && message.startsWith("ENOENT")) {
      this.status = this.attempts < 3 ? "supported" : "unavailable";
      this.retry_at = 0;
    } else this.status = "unavailable";
    return true;
  }
  upload(now_ms: number): string {
    if (this.status === "probing") {
      this.probe_deadline ??= now_ms + 1500;
      if (now_ms >= this.probe_deadline) this.status = "unavailable";
    }
    if (this.status === "uploading" && now_ms >= this.retry_at) {
      this.status = "confirming";
      this.retry_at = now_ms + 1500;
      return placementCommand(0) + hide;
    }
    if (this.status === "confirming" && now_ms >= this.retry_at)
      this.status = this.attempts < 3 ? "supported" : "unavailable";
    if (this.status !== "supported" || now_ms < this.retry_at) return "";
    const data = png.toString("base64");
    let out = "";
    for (let offset = 0; offset < data.length; offset += 4096) {
      const end = Math.min(offset + 4096, data.length),
        more = Number(end < data.length);
      out +=
        (offset === 0
          ? `\x1b_Ga=t,t=d,f=100,s=${pixel_width},v=${pixel_height},i=730031,m=${more};`
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
function placementCommand(quiet: number): string {
  return `\x1b7\x1b[1;3H\x1b_Ga=p,i=730031,p=1,c=3,z=1,C=1,q=${quiet}\x1b\\\x1b8`;
}
export function place(): string {
  return placementCommand(1);
}
