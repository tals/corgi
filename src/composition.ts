import type { Terminal } from "./mirror";
import type { Rect } from "./layout";
import type { Writer } from "./text";
import type { Paint } from "./sidebar";

export interface Pane {
  terminal: Terminal;
  id: number;
  x: number;
  y: number;
  w: number;
  h: number;
  at: number;
  revision: number;
}

export type Cursor = { x: number; y: number } | null;
export function cursorBytes(cursor: Cursor): string {
  return cursor ? `\x1b[${cursor.y + 1};${cursor.x + 1}H\x1b[?25h` : "\x1b[?25l";
}

/** TypeScript owns the drawing order; pane cells stay in their native surface. */
export class Frame {
  private chrome_bytes: string | null = "";
  private chrome_text: (() => string) | null = null;
  private chrome_receipt: object = {};
  get chrome(): string {
    return (this.chrome_bytes ??= this.chrome_text!());
  }
  set chrome(bytes: string) {
    this.chrome_bytes = bytes;
    this.chrome_text = null;
    this.chrome_receipt = {};
    this.chromePatch = null;
  }
  panes: Pane[] = [];
  cursor: Cursor = null;
  /** Insertion after pane content, before the final pointer shape and sync close. */
  cursor_at: number | null = null;
  reusable = true;
  sidebar: {
    at: number;
    length: number;
    paint?: Paint | null;
    draw: (previous?: Paint | null) => string | Paint;
  } | null = null;
  chromePatch: { base: object; bytes: string } | null = null;
  private sidebar_base: { before: string; after: string; bytes: string | null; images: boolean } | null = null;

  pane(w: Writer, terminal: Terminal, id: number, rect: Rect): void {
    this.panes.push({
      terminal,
      id,
      x: rect.x,
      y: rect.y,
      w: rect.w,
      h: rect.h,
      at: w.s.length,
      revision: terminal.render_revision,
    });
  }
  cover(rect: Rect): void {
    if (
      this.panes.some(p => p.x < rect.x + rect.w && rect.x < p.x + p.w && p.y < rect.y + rect.h && rect.y < p.y + p.h)
    )
      this.reusable = false;
  }
  finish(chrome: string, prefix = "", suffix = ""): this {
    this.chrome = prefix + chrome + suffix;
    this.chromePatch = null;
    if (prefix) for (const pane of this.panes) pane.at += prefix.length;
    if (this.cursor_at !== null) this.cursor_at += prefix.length;
    if (this.sidebar) this.sidebar = { ...this.sidebar, at: this.sidebar.at + prefix.length };
    this.sidebar_base = this.sidebar
      ? {
          before: this.chrome.slice(0, this.sidebar.at),
          bytes: this.chrome.slice(this.sidebar.at, this.sidebar.at + this.sidebar.length),
          images: this.chrome.slice(this.sidebar.at, this.sidebar.at + this.sidebar.length).includes("\x1b_"),
          after: this.chrome.slice(this.sidebar.at + this.sidebar.length),
        }
      : null;
    return this;
  }
  /** Refresh borrowed surfaces without changing an earlier frame's revision snapshot. */
  refreshed(cursor = this.cursor): Frame {
    const frame = new Frame();
    frame.chrome_bytes = this.chrome_bytes;
    frame.chrome_text = this.chrome_text;
    frame.chrome_receipt = this.chrome_receipt;
    frame.cursor = cursor ? { ...cursor } : null;
    frame.cursor_at = this.cursor_at;
    frame.reusable = this.reusable;
    frame.panes = this.panes.map(pane => ({ ...pane, revision: pane.terminal.render_revision }));
    frame.sidebar = this.sidebar;
    frame.chromePatch = this.chromePatch;
    frame.sidebar_base = this.sidebar_base;
    return frame;
  }
  repaintSidebar(cursor = this.cursor): Frame | null {
    const sidebar = this.sidebar,
      base = this.sidebar_base;
    if (!sidebar || !base) return null;
    const paint = sidebar.draw(sidebar.paint),
      end = sidebar.at + sidebar.length,
      frame = this.refreshed(cursor);
    if (typeof paint !== "string" && paint === sidebar.paint) return frame;
    if (typeof paint === "string" && paint === base.bytes) return frame;
    const images = typeof paint === "string" && paint.includes("\x1b_");
    frame.chrome_bytes = null;
    frame.chrome_text = () => base.before + (typeof paint === "string" ? paint : paint.text()) + base.after;
    frame.chrome_receipt = {};
    frame.sidebar = { ...sidebar, length: paint.length, paint: typeof paint === "string" ? null : paint };
    frame.sidebar_base = { ...base, bytes: typeof paint === "string" ? paint : null, images };
    const delta = paint.length - sidebar.length;
    for (const pane of frame.panes) if (pane.at >= end) pane.at += delta;
    if (frame.cursor_at !== null && frame.cursor_at >= end) frame.cursor_at += delta;
    // A moving row's image, including its disappearance, needs the complete image batch.
    frame.chromePatch =
      base.images || images
        ? null
        : {
            base: this.chrome_receipt,
            bytes:
              (typeof paint !== "string" && sidebar.paint ? paint.patchFrom(sidebar.paint) : null) ??
              "\x1b[0m" + (typeof paint === "string" ? paint : paint.text()) + "\x1b[0m",
          };
    return frame;
  }
  /** The complete ANSI frame remains the reference and fallback. */
  text(): string {
    let result = "",
      from = 0;
    for (const p of this.panes) {
      result += this.chrome.slice(from, p.at) + p.terminal.rows(p.id, p.x, p.y, p.w, p.h, false, null);
      from = p.at;
    }
    if (this.cursor_at !== null)
      return (
        result + this.chrome.slice(from, this.cursor_at) + cursorBytes(this.cursor) + this.chrome.slice(this.cursor_at)
      );
    return result + this.chrome.slice(from);
  }
  sharesChrome(previous: Frame): boolean {
    return this.reusable && previous.reusable && this.matches(previous);
  }
  patchFrom(previous: Frame): string | null {
    return this.reusable &&
      previous.reusable &&
      this.chromePatch?.base === previous.chrome_receipt &&
      this.samePanes(previous)
      ? this.chromePatch.bytes
      : null;
  }
  matches(previous: Frame): boolean {
    const same =
      this.chrome_receipt === previous.chrome_receipt ||
      (this.chrome_bytes !== null && previous.chrome_bytes !== null && this.chrome_bytes === previous.chrome_bytes);
    return same && this.cursor_at === previous.cursor_at && this.samePanes(previous);
  }
  private samePanes(previous: Frame): boolean {
    return (
      this.panes.length === previous.panes.length &&
      this.panes.every((p, i) => {
        const q = previous.panes[i];
        return (
          p.terminal === q.terminal &&
          p.id === q.id &&
          p.x === q.x &&
          p.y === q.y &&
          p.w === q.w &&
          p.h === q.h &&
          p.at === q.at
        );
      })
    );
  }
}

export type Output = string | Frame;

export function same(left: Output, right: Output): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return (
    right.matches(left) &&
    right.cursor?.x === left.cursor?.x &&
    right.cursor?.y === left.cursor?.y &&
    right.panes.every((p, i) => p.revision === left.panes[i].revision)
  );
}
